import { spawn } from 'child_process';
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
    // bounded prefix and terminate cat-file instead of draining the entire blob.
    if (entry.size > limits.maxFileBytes || totalBytes + entry.size > limits.maxTotalBytes) {
      const prefix = await runGit(repoPath, ['cat-file', 'blob', entry.oid], 8192, true);
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

    const blob = await runGit(repoPath, ['cat-file', 'blob', entry.oid], limits.maxFileBytes);
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
