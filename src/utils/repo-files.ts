import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_SKIPPED_REPO_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

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

function realPath(candidatePath: string): string | undefined {
  try {
    return fs.realpathSync(candidatePath);
  } catch {
    return undefined;
  }
}
