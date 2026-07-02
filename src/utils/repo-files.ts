import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_SKIPPED_REPO_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

export const GENERATED_REPORT_DIRECTORY_PATTERN = /(?:^|\/)(?:reports?|evaluation-reports?|generated-reports?|coverage|html-report|test-results?)(?:\/|$)/i;

export function findCandidateFiles(
  repoPath: string,
  startPath: string,
  includeFile: (candidatePath: string) => boolean,
  skippedDirs: ReadonlySet<string> = DEFAULT_SKIPPED_REPO_DIRS
): string[] {
  if (!fs.existsSync(startPath)) {
    return [];
  }

  const repoRealPath = realPath(repoPath);
  if (!repoRealPath) {
    return [];
  }

  const candidates: string[] = [];
  const walk = (current: string): void => {
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) {
      return;
    }
    if (stats.isFile()) {
      if (includeFile(current)) {
        candidates.push(current);
      }
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }
    for (const entry of fs.readdirSync(current)) {
      if (skippedDirs.has(entry)) {
        continue;
      }
      walk(path.join(current, entry));
    }
  };

  walk(startPath);
  return candidates.filter(candidate => isWithinRealPath(repoRealPath, candidate));
}

export function isWithinRepo(repoPath: string, candidatePath: string): boolean {
  const repoRealPath = realPath(repoPath);
  return repoRealPath ? isWithinRealPath(repoRealPath, candidatePath) : false;
}

export function isDirectory(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

export function readJsonFile(filePath: string, warnings?: string[]): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    warnings?.push(`Unable to parse ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function readTextFile(filePath: string, warnings?: string[]): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    warnings?.push(`Unable to read ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function readBoundedFileBytes(filePath: string, maxBytes: number): Buffer {
  if (maxBytes <= 0) {
    return Buffer.alloc(0);
  }

  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function decodeBoundedUtf8(buffer: Buffer, truncated: boolean): string {
  const text = buffer.toString('utf-8');
  return truncated ? text.replace(/\uFFFD$/, '') : text;
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 1024);
  for (let index = 0; index < sampleLength; index++) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

export function relativePosixPath(repoPath: string, candidatePath: string): string {
  return path.relative(repoPath, candidatePath).split(path.sep).join('/');
}

export function walkDirectories(
  startPath: string,
  visit: (directory: string) => boolean,
  skippedDirs: ReadonlySet<string> = DEFAULT_SKIPPED_REPO_DIRS
): void {
  if (!fs.existsSync(startPath)) {
    return;
  }

  const walk = (current: string): void => {
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return;
    }

    if (!visit(current)) {
      return;
    }

    for (const entry of fs.readdirSync(current)) {
      if (skippedDirs.has(entry)) {
        continue;
      }
      walk(path.join(current, entry));
    }
  };

  walk(startPath);
}

function isWithinRealPath(repoRealPath: string, candidatePath: string): boolean {
  try {
    const candidateRealPath = fs.realpathSync(candidatePath);
    return candidateRealPath.startsWith(`${repoRealPath}${path.sep}`) || candidateRealPath === repoRealPath;
  } catch {
    return false;
  }
}

export function realPath(candidatePath: string): string | undefined {
  try {
    return fs.realpathSync(candidatePath);
  } catch {
    return undefined;
  }
}
