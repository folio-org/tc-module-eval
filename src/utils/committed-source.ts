import { ChildProcessByStdio, spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import { redactSensitiveText } from './redaction';

export interface CommittedSourceLimits {
  maxTreeBytes: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  include(path: string): boolean;
}

export interface CommittedSourceFile {
  path: string;
  oid: string;
  size: number;
  content: string;
}

export interface CommittedSourceDiagnostic {
  code: 'git-error' | 'tree-limit' | 'entry-limit' | 'file-limit' | 'file-size' | 'total-size' | 'binary' | 'unsafe-entry';
  message: string;
  material: boolean;
  path?: string;
}

export interface CommittedSourceSnapshot {
  revision: string;
  files: CommittedSourceFile[];
  diagnostics: CommittedSourceDiagnostic[];
  complete: boolean;
}

const DEFAULT_LIMITS: CommittedSourceLimits = {
  maxTreeBytes: 2 * 1024 * 1024,
  maxEntries: 10_000,
  maxFiles: 1_000,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  include: () => true
};

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  size: number;
  path: string;
}

interface ProcessOutput {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  exceeded: boolean;
}

export async function readCommittedSource(
  repoPath: string,
  options: Partial<CommittedSourceLimits> = {}
): Promise<CommittedSourceSnapshot> {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const diagnostics: CommittedSourceDiagnostic[] = [];
  const revisionResult = await runGit(repoPath, ['rev-parse', 'HEAD'], 256);
  if (revisionResult.exitCode !== 0 || revisionResult.exceeded) {
    return failedSnapshot(gitError(revisionResult, 'Unable to resolve the committed revision'));
  }
  const revision = revisionResult.stdout.toString('utf8').trim();
  const treeResult = await runGit(repoPath, ['ls-tree', '-rlz', 'HEAD'], limits.maxTreeBytes);
  if (treeResult.exitCode !== 0) {
    return failedSnapshot(gitError(treeResult, 'Unable to inspect the committed source tree'), revision);
  }
  if (treeResult.exceeded) {
    diagnostics.push({
      code: 'tree-limit',
      message: `Committed tree output exceeded ${limits.maxTreeBytes} bytes`,
      material: true
    });
  }

  const parsed = parseTree(treeResult.stdout, limits.maxEntries, diagnostics)
    .filter(entry => limits.include(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const candidates = parsed.slice(0, limits.maxFiles);
  if (parsed.length > limits.maxFiles) {
    diagnostics.push({
      code: 'file-limit',
      message: `Committed source candidate count exceeded ${limits.maxFiles} files`,
      material: true
    });
  }

  const files: CommittedSourceFile[] = [];
  let totalBytes = 0;
  const blobs = openBlobReader(repoPath);
  try {
    for (const entry of candidates) {
      if (entry.mode !== '100644' && entry.mode !== '100755') {
        diagnostics.push({
          code: 'unsafe-entry',
          message: 'Skipped a non-regular committed tree entry',
          material: true,
          path: entry.path
        });
        continue;
      }
      if (entry.type !== 'blob' || !isSafeRelativePath(entry.path)) {
        diagnostics.push({
          code: 'unsafe-entry',
          message: 'Skipped an unsafe committed tree entry',
          material: true,
          path: safePath(entry.path)
        });
        continue;
      }
      // A large binary is an omission, not an oversized source file. Probe only a
      // bounded prefix; terminate cat-file instead of draining an oversized blob.
      if (entry.size > limits.maxFileBytes || totalBytes + entry.size > limits.maxTotalBytes) {
        const prefix = entry.size > limits.maxFileBytes
          ? await runGit(repoPath, ['cat-file', 'blob', entry.oid], 8192, true)
          : await blobs.read(entry.oid, 8192);
        if (prefix.exitCode !== 0 && !prefix.exceeded) {
          diagnostics.push(gitError(prefix, 'Unable to inspect committed content'));
          continue;
        }
        if (prefix.stdout.includes(0)) {
          diagnostics.push({ code: 'binary', message: 'Skipped binary committed content', material: true, path: entry.path });
          continue;
        }
      }
      if (entry.size > limits.maxFileBytes) {
        diagnostics.push({
          code: 'file-size',
          message: `Committed file exceeds the ${limits.maxFileBytes}-byte per-file limit`,
          material: true,
          path: entry.path
        });
        continue;
      }
      if (totalBytes + entry.size > limits.maxTotalBytes) {
        diagnostics.push({
          code: 'total-size',
          message: `Committed source exceeds the ${limits.maxTotalBytes}-byte total limit`,
          material: true,
          path: entry.path
        });
        continue;
      }

      const blob = await blobs.read(entry.oid, limits.maxFileBytes);
      if (blob.exitCode !== 0 || blob.exceeded) {
        diagnostics.push({
          code: blob.exceeded ? 'file-size' : 'git-error',
          message: redactSensitiveText(blob.exceeded
            ? `Committed file exceeds the ${limits.maxFileBytes}-byte read limit`
            : `Unable to read committed file: ${boundedStderr(blob.stderr)}`),
          material: true,
          path: entry.path
        });
        continue;
      }
      if (blob.stdout.includes(0)) {
        diagnostics.push({
          code: 'binary',
          message: 'Skipped binary committed content',
          material: true,
          path: entry.path
        });
        continue;
      }

      files.push({ path: entry.path, oid: entry.oid, size: entry.size, content: blob.stdout.toString('utf8') });
      totalBytes += entry.size;
    }
  } finally {
    blobs.close();
  }

  return {
    revision,
    files,
    diagnostics,
    complete: !treeResult.exceeded && !diagnostics.some(diagnostic => diagnostic.material)
  };
}

function parseTree(
  output: Buffer,
  maxEntries: number,
  diagnostics: CommittedSourceDiagnostic[]
): TreeEntry[] {
  const records = output.toString('utf8').split('\0').filter(Boolean);
  if (records.length > maxEntries) {
    diagnostics.push({
      code: 'entry-limit',
      message: `Committed tree contains more than ${maxEntries} entries`,
      material: true
    });
  }
  return records.slice(0, maxEntries).flatMap(record => {
    const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) {
      diagnostics.push({ code: 'unsafe-entry', message: 'Skipped malformed committed tree metadata', material: true });
      return [];
    }
    return [{
      mode: match[1],
      type: match[2],
      oid: match[3],
      size: match[4] === '-' ? 0 : Number(match[4]),
      path: match[5]
    }];
  });
}

function runGit(repoPath: string, args: string[], maxBytes: number, stopAfterLimit = false): Promise<ProcessOutput> {
  return new Promise(resolve => {
    const child = spawn('git', ['-C', repoPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;

    child.stdout.on('data', (chunk: Buffer) => {
      const nextBytes = stdoutBytes + chunk.length;
      if (stdoutBytes < maxBytes) {
        const retained = chunk.subarray(0, Math.max(0, maxBytes - stdoutBytes));
        stdout.push(retained);
        stdoutBytes += retained.length;
      }
      if (nextBytes > maxBytes) {
        exceeded = true;
        if (stopAfterLimit) child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < 4096) {
        const retained = chunk.subarray(0, 4096 - stderrBytes);
        stderr.push(retained);
        stderrBytes += retained.length;
      }
    });
    child.on('error', error => {
      stderr.push(Buffer.from(error.message));
    });
    child.on('close', exitCode => resolve({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode,
      exceeded
    }));
  });
}

interface BlobReader {
  /** Read one blob, keeping at most maxBytes; `exceeded` reports a larger blob, as runGit does. */
  read(oid: string, maxBytes: number): Promise<ProcessOutput>;
  close(): void;
}

interface BlobRequest {
  maxBytes: number;
  resolve(output: ProcessOutput): void;
  size?: number;
  received: number;
  retained: Buffer[];
}

/**
 * Serve a snapshot's blob reads from one `git cat-file --batch` process instead of one process per file.
 * Each response is `<oid> <type> <size>\n<content>\n`, or `<oid> missing\n`. The process starts on the first
 * read and close() ends it; a process that exits early fails its pending reads.
 */
function openBlobReader(repoPath: string): BlobReader {
  let child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
  const requests: BlobRequest[] = [];
  let header = Buffer.alloc(0);

  const settle = (output: ProcessOutput) => requests.shift()!.resolve(output);
  const onData = (chunk: Buffer) => {
    let data = chunk;
    while (data.length && requests.length) {
      const request = requests[0];
      if (request.size === undefined) {
        const newline = data.indexOf(10);
        if (newline < 0) {
          header = Buffer.concat([header, data]);
          return;
        }
        const line = Buffer.concat([header, data.subarray(0, newline)]).toString('utf8');
        header = Buffer.alloc(0);
        data = data.subarray(newline + 1);
        const match = /^\S+ \S+ (\d+)$/.exec(line);
        if (!match) {
          settle({ stdout: Buffer.alloc(0), stderr: Buffer.from(line), exitCode: 128, exceeded: false });
          continue;
        }
        request.size = Number(match[1]);
      }
      // The body is the content plus a trailing newline; keep only the first maxBytes of content.
      const body = data.subarray(0, request.size + 1 - request.received);
      data = data.subarray(body.length);
      const keep = Math.min(request.size, request.maxBytes) - request.received;
      if (keep > 0) request.retained.push(body.subarray(0, keep));
      request.received += body.length;
      if (request.received === request.size + 1) {
        settle({
          stdout: Buffer.concat(request.retained),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          exceeded: request.size > request.maxBytes
        });
      }
    }
  };

  const start = () => {
    const git = spawn('git', ['-C', repoPath, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    git.stdout.on('data', onData);
    git.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < 4096) {
        const retained = chunk.subarray(0, 4096 - stderrBytes);
        stderr.push(retained);
        stderrBytes += retained.length;
      }
    });
    // Writing after an early exit fails with EPIPE; the close handler reports the exit instead.
    git.stdin.on('error', () => undefined);
    git.on('error', error => {
      stderr.push(Buffer.from(error.message));
    });
    git.on('close', exitCode => {
      // An exit while reads are outstanding is a failure even when git reports success. git exits on a blob
      // it cannot read, so only that read fails: the next read starts a new process, as per-file reads did.
      const failure = { stdout: Buffer.alloc(0), stderr: Buffer.concat(stderr), exitCode: exitCode || 128, exceeded: false };
      while (requests.length) settle(failure);
      header = Buffer.alloc(0);
      if (child === git) child = undefined;
    });
    return git;
  };

  return {
    read(oid, maxBytes) {
      const git = child ??= start();
      return new Promise(resolve => {
        requests.push({ maxBytes, resolve, received: 0, retained: [] });
        git.stdin.write(`${oid}\n`);
      });
    },
    close() {
      child?.stdin.end();
      child?.kill();
      child = undefined;
    }
  };
}

function gitError(result: ProcessOutput, prefix: string): CommittedSourceDiagnostic {
  return {
    code: 'git-error',
    message: redactSensitiveText(`${prefix}: ${boundedStderr(result.stderr)}`),
    material: true
  };
}

function failedSnapshot(diagnostic: CommittedSourceDiagnostic, revision = ''): CommittedSourceSnapshot {
  return { revision, files: [], diagnostics: [diagnostic], complete: false };
}

function boundedStderr(stderr: Buffer): string {
  return stderr.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 512) || 'Git command failed';
}

function isSafeRelativePath(candidate: string): boolean {
  return Boolean(candidate)
    && !candidate.startsWith('/')
    && !candidate.includes('\\')
    && !candidate.split('/').includes('..')
    && !candidate.includes('\0');
}

function safePath(candidate: string): string | undefined {
  return isSafeRelativePath(candidate) ? candidate : undefined;
}
