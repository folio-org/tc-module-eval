import * as fs from 'fs';
import * as path from 'path';

import {
  S006ScanCoverage,
  S006ScanWarning,
  S006SkippedFile
} from '../types';
import { decodeBoundedUtf8, isBinaryBuffer, isWithinRepo, readBoundedFileBytes, realPath, relativePosixPath } from './repo-files';
import { MAX_S006_EXCERPT_BYTES } from './s006-detectors';

export const MAX_S006_SCAN_TRAVERSAL_ENTRIES = 5000;
export const MAX_S006_SCAN_CANDIDATE_FILES = 300;
export const MAX_S006_SCAN_BYTES_PER_FILE = 96 * 1024;
export const MAX_S006_SCAN_TOTAL_BYTES = 2 * 1024 * 1024;

const MAX_S006_RETAINED_SKIPPED_FILES = 250;
const S006_SKIPPED_DIRECTORY_REASONS: ReadonlyMap<string, S006SkippedFile['reason']> = new Map([
  ['.git', 'generated-artifact'],
  ['.hg', 'generated-artifact'],
  ['.svn', 'generated-artifact'],
  ['node_modules', 'dependency-directory'],
  ['bower_components', 'dependency-directory'],
  ['vendor', 'dependency-directory'],
  ['dist', 'generated-artifact'],
  ['build', 'generated-artifact'],
  ['target', 'generated-artifact'],
  ['out', 'generated-artifact'],
  ['.next', 'generated-artifact'],
  ['.turbo', 'generated-artifact'],
  ['.cache', 'generated-artifact'],
  ['.gradle', 'generated-artifact'],
  ['coverage', 'generated-artifact'],
  ['.nyc_output', 'generated-artifact'],
  ['reports', 'generated-artifact'],
  ['report', 'generated-artifact'],
  ['evaluation-reports', 'generated-artifact'],
  ['generated-reports', 'generated-artifact'],
  ['html-report', 'generated-artifact'],
  ['test-results', 'generated-artifact'],
  ['generated', 'generated-artifact'],
  ['gen', 'generated-artifact']
]);
const S006_SUPPORTED_TEXT_FILE_PATTERN =
  /\.(?:bash|cjs|cfg|conf|crt|env|gradle|groovy|ini|java|js|json|jsx|key|kt|kts|md|mjs|pem|properties|py|rb|sh|sql|tf|tfvars|toml|ts|tsx|txt|xml|yaml|yml|zsh)$/i;
const S006_SUPPORTED_SPECIAL_FILE_PATTERN =
  /(?:^|\/)(?:\.env(?:[.\w-]*)?|Dockerfile(?:\.[\w-]+)?|docker-compose(?:\.[\w-]+)?\.ya?ml|compose(?:\.[\w-]+)?\.ya?ml|Jenkinsfile|Makefile|\.gitlab-ci\.ya?ml|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i;
const S006_HIGH_SIGNAL_PATH_PATTERN =
  /(?:^|\/)(?:\.env(?:[.\w-]*)?|\.github\/|\.gitlab\/|\.circleci\/|ci\/|buildkite\/|deploy(?:ment)?\/|helm\/|k8s\/|kubernetes\/|okapi\/|conf\/|config(?:uration)?\/|src\/main\/resources\/|src\/main\/config\/|terraform\/)|(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|docker-compose(?:\.[\w-]+)?\.ya?ml|compose(?:\.[\w-]+)?\.ya?ml|Jenkinsfile|Makefile|\.gitlab-ci\.ya?ml|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$|\.(?:pem|key|crt|tf|tfvars)$/i;
const S006_MATERIAL_TRUNCATED_PATH_PATTERN =
  /(?:^|\/)(?:\.env(?:[.\w-]*)?|\.github\/|\.gitlab\/|\.circleci\/|ci\/|buildkite\/|deploy(?:ment)?\/|helm\/|k8s\/|kubernetes\/|okapi\/|conf\/|config(?:uration)?\/|src\/main\/resources\/|src\/main\/config\/|terraform\/)|(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|docker-compose(?:\.[\w-]+)?\.ya?ml|compose(?:\.[\w-]+)?\.ya?ml|Jenkinsfile|\.gitlab-ci\.ya?ml|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$|\.(?:ya?ml|properties|pem|key|crt|tf|tfvars)$/i;
const S006_GENERATED_REPORT_PATH_PATTERN =
  /(?:^|\/)(?:reports?|evaluation-reports?|generated-reports?|coverage|html-report|test-results?)(?:\/|$)/i;

export interface S006ScannedCandidateTextFile {
  path: string;
  text: string;
  bytesRead: number;
  truncated: boolean;
  materialToCoverage: boolean;
}

export interface S006RepositoryCandidateScanResult {
  files: S006ScannedCandidateTextFile[];
  coverage: S006ScanCoverage;
  warnings: S006ScanWarning[];
}

export interface S006RepositoryCandidateScanOptions {
  traversalEntryLimit?: number;
}

export function scanS006RepositoryCandidates(
  repoPath: string,
  options: S006RepositoryCandidateScanOptions = {}
): S006RepositoryCandidateScanResult {
  const repoRoot = realPath(repoPath);
  if (!repoRoot) {
    const warning = buildS006Warning(
      'traversal-limit',
      'Unable to resolve repository path while scanning S006 candidate files.',
      true
    );
    const coverage = buildS006Coverage(0, 0, 0, [], [warning], true, false);
    return { files: [], coverage, warnings: [warning] };
  }

  const discovery = collectBoundedS006EvidenceCandidates(repoRoot, options);
  const warnings = [...discovery.warnings];
  const skippedFiles = [...discovery.skippedFiles];
  const candidateFiles = discovery.files.slice(0, MAX_S006_SCAN_CANDIDATE_FILES);
  const files: S006ScannedCandidateTextFile[] = [];
  let scannedBytes = 0;
  let stoppedByByteLimit = false;

  if (discovery.files.length > MAX_S006_SCAN_CANDIDATE_FILES) {
    warnings.push(buildS006Warning(
      'candidate-limit',
      `S006 candidate discovery retained first ${MAX_S006_SCAN_CANDIDATE_FILES} supported files; additional candidates were not scanned.`,
      discovery.truncatedBeforePriorityComplete
    ));
  }

  for (let index = 0; index < candidateFiles.length; index++) {
    const candidatePath = candidateFiles[index];
    const relativePath = relativePosixPath(repoRoot, candidatePath);
    if (!isWithinRepo(repoRoot, candidatePath)) {
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'outside-repository',
        materialToCoverage: true
      });
      continue;
    }

    if (scannedBytes >= MAX_S006_SCAN_TOTAL_BYTES) {
      stoppedByByteLimit = true;
      const material = candidateFiles.slice(index).some(laterCandidate =>
        isS006HighSignalPath(relativePosixPath(repoRoot, laterCandidate))
      );
      warnings.push(buildS006Warning(
        'byte-limit',
        `S006 candidate reading stopped at the ${MAX_S006_SCAN_TOTAL_BYTES}-byte total scan cap.`,
        material
      ));
      break;
    }

    const readResult = readBoundedS006CandidateText(
      candidatePath,
      relativePath,
      MAX_S006_SCAN_TOTAL_BYTES - scannedBytes
    );

    if (readResult.status === 'binary') {
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'binary',
        materialToCoverage: false
      });
      continue;
    }

    if (readResult.status === 'read-error') {
      const materialToCoverage = isS006MaterialCoveragePath(relativePath);
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'read-error',
        message: readResult.message,
        materialToCoverage
      });
      warnings.push(buildS006Warning(
        'unreadable-file',
        `Unable to read S006 candidate file ${relativePath}.`,
        materialToCoverage,
        relativePath
      ));
      continue;
    }

    if (readResult.status === 'empty') {
      files.push({
        path: relativePath,
        text: '',
        bytesRead: 0,
        truncated: false,
        materialToCoverage: false
      });
      continue;
    }

    scannedBytes += readResult.bytesRead;
    files.push({
      path: relativePath,
      text: readResult.text,
      bytesRead: readResult.bytesRead,
      truncated: readResult.truncated,
      materialToCoverage: readResult.materialToCoverage
    });

    if (readResult.truncated) {
      warnings.push(buildS006Warning(
        'file-truncated',
        `S006 candidate scanning truncated ${relativePath} to ${readResult.bytesRead} bytes.`,
        readResult.materialToCoverage,
        relativePath
      ));
    }

    if (readResult.totalCapReached) {
      stoppedByByteLimit = true;
      const material = candidateFiles.slice(index + 1).some(laterCandidate =>
        isS006HighSignalPath(relativePosixPath(repoRoot, laterCandidate))
      ) || readResult.materialToCoverage;
      warnings.push(buildS006Warning(
        'byte-limit',
        `S006 candidate reading stopped at the ${MAX_S006_SCAN_TOTAL_BYTES}-byte total scan cap.`,
        material
      ));
      break;
    }
  }

  const materiallyWeakened = warnings.some(warning => warning.materialToCoverage) ||
    skippedFiles.some(skippedFile => skippedFile.materialToCoverage);
  const complete = !discovery.truncated &&
    discovery.files.length <= MAX_S006_SCAN_CANDIDATE_FILES &&
    !stoppedByByteLimit &&
    !materiallyWeakened;

  const coverage = buildS006Coverage(
    files.length,
    scannedBytes,
    discovery.files.length,
    skippedFiles,
    warnings,
    materiallyWeakened,
    complete
  );

  return {
    files,
    coverage,
    warnings
  };
}

export function buildS006Warning(
  kind: S006ScanWarning['kind'],
  message: string,
  materialToCoverage: boolean,
  warningPath?: string
): S006ScanWarning {
  return {
    kind,
    message: boundedS006Message(message),
    path: warningPath,
    materialToCoverage
  };
}

function collectBoundedS006EvidenceCandidates(repoPath: string, options: S006RepositoryCandidateScanOptions = {}): {
  files: string[];
  truncated: boolean;
  truncatedBeforePriorityComplete: boolean;
  skippedFiles: S006SkippedFile[];
  warnings: S006ScanWarning[];
} {
  const files: string[] = [];
  const skippedFiles: S006SkippedFile[] = [];
  const warnings: S006ScanWarning[] = [];
  let truncated = false;
  let visitedEntries = 0;
  const traversalEntryLimit = options.traversalEntryLimit ?? MAX_S006_SCAN_TRAVERSAL_ENTRIES;

  const walk = (currentPath: string): void => {
    if (visitedEntries >= traversalEntryLimit) {
      truncated = true;
      return;
    }
    visitedEntries += 1;

    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch {
      const relativePath = relativePosixPath(repoPath, currentPath);
      const materialToCoverage = isS006MaterialCoveragePath(relativePath);
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'read-error',
        message: 'Unable to inspect path while discovering S006 candidate files.',
        materialToCoverage
      });
      return;
    }

    const relativePath = relativePosixPath(repoPath, currentPath);
    if (stats.isSymbolicLink()) {
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'unsupported-file',
        message: 'Symbolic links are not followed during S006 candidate scanning.',
        materialToCoverage: false
      });
      return;
    }

    if (stats.isFile()) {
      const candidateDecision = classifyS006CandidatePath(relativePath);
      if (candidateDecision.eligible) {
        files.push(currentPath);
        return;
      }
      if (candidateDecision.materialUnsupported) {
        pushS006SkippedFile(skippedFiles, {
          path: relativePath,
          reason: 'unsupported-file',
          message: 'Unsupported high-signal S006 candidate path.',
          materialToCoverage: true
        });
        warnings.push(buildS006Warning(
          'unsupported-high-signal-file',
          `Unsupported high-signal S006 candidate file ${relativePath} was not scanned.`,
          true,
          relativePath
        ));
      }
      return;
    }

    if (!stats.isDirectory()) {
      return;
    }

    const directoryName = path.basename(currentPath);
    const skippedReason = S006_SKIPPED_DIRECTORY_REASONS.get(directoryName);
    if (skippedReason && currentPath !== repoPath) {
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: skippedReason,
        materialToCoverage: isS006HighSignalPath(relativePath)
      });
      return;
    }

    let entries: string[];
    let unreadDirectoryEntries = false;
    try {
      const remainingEntryBudget = Math.max(0, traversalEntryLimit - visitedEntries);
      const directory = fs.opendirSync(currentPath);
      entries = [];
      try {
        while (entries.length < remainingEntryBudget) {
          const entry = directory.readSync();
          if (!entry) {
            break;
          }
          entries.push(entry.name);
        }
        unreadDirectoryEntries = directory.readSync() !== null;
      } finally {
        directory.closeSync();
      }
      entries.sort((left, right) => left.localeCompare(right));
    } catch {
      const materialToCoverage = isS006MaterialCoveragePath(relativePath);
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'read-error',
        message: 'Unable to read directory while discovering S006 candidate files.',
        materialToCoverage
      });
      if (materialToCoverage) {
        warnings.push(buildS006Warning(
          'unreadable-file',
          `Unable to read high-signal S006 candidate directory ${relativePath}.`,
          true,
          relativePath
        ));
      }
      return;
    }

    for (const entry of entries) {
      walk(path.join(currentPath, entry));
      if (truncated) {
        return;
      }
    }
    if (unreadDirectoryEntries) {
      truncated = true;
    }
  };

  walk(repoPath);
  if (truncated) {
    warnings.push(buildS006Warning(
      'traversal-limit',
      `S006 candidate discovery reached the ${traversalEntryLimit}-entry traversal cap; additional paths were not inspected.`,
      true
    ));
  }

  const prioritizedFiles = prioritizeS006Candidates(repoPath, files);
  const truncatedBeforePriorityComplete = prioritizedFiles
    .slice(MAX_S006_SCAN_CANDIDATE_FILES)
    .some(filePath => isS006HighSignalPath(relativePosixPath(repoPath, filePath)));

  return {
    files: prioritizedFiles,
    truncated,
    truncatedBeforePriorityComplete,
    skippedFiles,
    warnings
  };
}

function classifyS006CandidatePath(relativePath: string): { eligible: boolean; materialUnsupported: boolean } {
  const normalized = relativePath.replace(/\\/g, '/');
  if (S006_GENERATED_REPORT_PATH_PATTERN.test(normalized)) {
    return { eligible: false, materialUnsupported: false };
  }
  if (S006_SUPPORTED_SPECIAL_FILE_PATTERN.test(normalized) || S006_SUPPORTED_TEXT_FILE_PATTERN.test(normalized)) {
    return { eligible: true, materialUnsupported: false };
  }

  return {
    eligible: false,
    materialUnsupported: isS006HighSignalPath(normalized)
  };
}

function prioritizeS006Candidates(repoPath: string, files: string[]): string[] {
  return files
    .map(filePath => {
      const relativePath = relativePosixPath(repoPath, filePath);
      return {
        filePath,
        relativePath,
        priority: s006CandidatePriority(relativePath)
      };
    })
    .sort((left, right) => left.priority - right.priority || left.relativePath.localeCompare(right.relativePath))
    .map(candidate => candidate.filePath);
}

function s006CandidatePriority(relativePath: string): number {
  const normalized = relativePath.replace(/\\/g, '/');
  if (/(?:^|\/)\.env(?:[.\w-]*)?$/i.test(normalized)) {
    return 0;
  }
  if (/(?:^|\/)(?:\.github\/|\.gitlab\/|\.circleci\/|ci\/|buildkite\/|Jenkinsfile|\.gitlab-ci\.ya?ml)/i.test(normalized)) {
    return 1;
  }
  if (/(?:^|\/)(?:deploy(?:ment)?\/|helm\/|k8s\/|kubernetes\/|okapi\/|conf\/|config(?:uration)?\/|src\/main\/resources\/|src\/main\/config\/)/i.test(normalized)) {
    return 2;
  }
  if (/(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|docker-compose(?:\.[\w-]+)?\.ya?ml|compose(?:\.[\w-]+)?\.ya?ml)$/i.test(normalized)) {
    return 2;
  }
  if (/(?:^|\/)(?:src\/|lib\/|app\/)/i.test(normalized)) {
    return 3;
  }
  if (/(?:^|\/)(?:docs?|documentation|README(?:\.[^.]+)?$)/i.test(normalized)) {
    return 4;
  }
  return 5;
}

function readBoundedS006CandidateText(
  filePath: string,
  relativePath: string,
  remainingTotalBytes: number
): { status: 'text'; text: string; bytesRead: number; truncated: boolean; totalCapReached: boolean; materialToCoverage: boolean } |
  { status: 'empty' } |
  { status: 'binary' } |
  { status: 'read-error'; message: string } {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size === 0 || remainingTotalBytes <= 0) {
      return { status: 'empty' };
    }

    const bytesToRead = Math.min(stats.size, MAX_S006_SCAN_BYTES_PER_FILE, remainingTotalBytes);
    const slice = readBoundedFileBytes(filePath, bytesToRead);
    if (isBinaryBuffer(slice)) {
      return { status: 'binary' };
    }

    const truncated = stats.size > bytesToRead;
    const text = decodeBoundedUtf8(slice, truncated);
    const possiblePrivateKeyBlockTruncated = truncated && hasOpenS006PrivateKeyBlock(text);
    const materialToCoverage = truncated && (isS006MaterialCoveragePath(relativePath) || possiblePrivateKeyBlockTruncated);
    return {
      status: 'text',
      text,
      bytesRead: slice.length,
      truncated,
      totalCapReached: stats.size > remainingTotalBytes,
      materialToCoverage
    };
  } catch (error) {
    return {
      status: 'read-error',
      message: 'Unable to read S006 candidate file.'
    };
  }
}

function isS006HighSignalPath(relativePath: string): boolean {
  return S006_HIGH_SIGNAL_PATH_PATTERN.test(relativePath.replace(/\\/g, '/'));
}

function isS006MaterialCoveragePath(relativePath: string): boolean {
  return S006_MATERIAL_TRUNCATED_PATH_PATTERN.test(relativePath.replace(/\\/g, '/'));
}

function pushS006SkippedFile(skippedFiles: S006SkippedFile[], skippedFile: S006SkippedFile): void {
  if (skippedFiles.length >= MAX_S006_RETAINED_SKIPPED_FILES) {
    return;
  }
  skippedFiles.push(skippedFile);
}

function buildS006Coverage(
  scannedFiles: number,
  scannedBytes: number,
  candidateFiles: number,
  skippedFiles: S006SkippedFile[],
  warnings: S006ScanWarning[],
  materiallyWeakened: boolean,
  complete: boolean
): S006ScanCoverage {
  return {
    scannedFiles,
    scannedBytes,
    candidateFiles,
    skippedFiles,
    warnings,
    materiallyWeakened,
    complete
  };
}

function hasOpenS006PrivateKeyBlock(text: string): boolean {
  const beginMatches = [...text.matchAll(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g)];
  if (!beginMatches.length) {
    return false;
  }
  const lastBegin = beginMatches[beginMatches.length - 1];
  const start = lastBegin.index ?? 0;
  return !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text.slice(start));
}

function boundedS006Message(input: string): string {
  return input.length > MAX_S006_EXCERPT_BYTES ? `${input.slice(0, MAX_S006_EXCERPT_BYTES)}...` : input;
}
