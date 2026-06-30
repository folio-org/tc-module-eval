import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CommandExecutionResult,
  CommandRunner,
  S006ScanWarning
} from '../types';
import { LocalCommandRunner } from './command-runner';
import { relativePosixPath } from './repo-files';
import { buildS006Warning } from './s006-scanner';

const DEFAULT_GITLEAKS_TIMEOUT_MS = 120000;
const MAX_GITLEAKS_OUTPUT_BYTES = 64 * 1024;

export interface S006GitleaksFinding {
  RuleID?: string;
  Description?: string;
  StartLine?: number;
  EndLine?: number;
  Match?: string;
  Secret?: string;
  File?: string;
  Entropy?: number;
  Fingerprint?: string;
}

export interface S006GitleaksScanResult {
  findings: S006GitleaksFinding[];
  warnings: S006ScanWarning[];
  command?: CommandExecutionResult;
}

export interface S006GitleaksScanOptions {
  commandRunner?: CommandRunner;
  timeoutMs?: number;
}

export async function runS006GitleaksScan(
  repoPath: string,
  options: S006GitleaksScanOptions = {}
): Promise<S006GitleaksScanResult> {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 's006-gitleaks-'));
  const reportPath = path.join(reportDir, 'report.json');
  const command = process.env.GITLEAKS_PATH || 'gitleaks';
  const commandRunner = options.commandRunner ?? new LocalCommandRunner(false);

  try {
    const result = await commandRunner.run({
      command,
      cwd: repoPath,
      timeoutMs: options.timeoutMs ?? DEFAULT_GITLEAKS_TIMEOUT_MS,
      maxOutputBytes: MAX_GITLEAKS_OUTPUT_BYTES,
      args: [
        'dir',
        repoPath,
        '--report-format',
        'json',
        '--report-path',
        reportPath,
        '--redact=100',
        '--no-banner',
        '--no-color',
        '--exit-code',
        '1'
      ]
    });

    if (result.status === 'success' || (result.status === 'failed' && result.exitCode === 1)) {
      return {
        findings: readGitleaksReport(reportPath, repoPath),
        warnings: [],
        command: result
      };
    }

    return {
      findings: [],
      warnings: [buildUnavailableWarning(result)],
      command: result
    };
  } catch (error) {
    return {
      findings: [],
      warnings: [buildS006Warning(
        'scanner-unavailable',
        `Gitleaks scanner could not run: ${error instanceof Error ? error.message : String(error)}`,
        true
      )]
    };
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}

function readGitleaksReport(reportPath: string, repoPath: string): S006GitleaksFinding[] {
  if (!fs.existsSync(reportPath)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Gitleaks JSON report could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Gitleaks JSON report did not contain an array of findings');
  }

  return parsed
    .filter(isGitleaksFinding)
    .map(finding => normalizeGitleaksFindingPath(finding, repoPath));
}

function isGitleaksFinding(value: unknown): value is S006GitleaksFinding {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const finding = value as S006GitleaksFinding;
  return typeof finding.File === 'string' || typeof finding.RuleID === 'string' || typeof finding.Fingerprint === 'string';
}

function normalizeGitleaksFindingPath(finding: S006GitleaksFinding, repoPath: string): S006GitleaksFinding {
  const normalizedPath = normalizeGitleaksReportPath(finding.File, repoPath);
  if (!normalizedPath) {
    return finding;
  }

  return {
    ...finding,
    File: normalizedPath,
    Fingerprint: normalizeGitleaksFingerprint(finding.Fingerprint, finding.File, normalizedPath)
  };
}

function normalizeGitleaksReportPath(filePath: string | undefined, repoPath: string): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  if (!normalized) {
    return undefined;
  }

  if (!path.isAbsolute(filePath)) {
    return normalized;
  }

  const repoRoot = path.resolve(repoPath);
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePosixPath(repoRoot, absolutePath);
  }

  return normalized;
}

function normalizeGitleaksFingerprint(
  fingerprint: string | undefined,
  originalPath: string | undefined,
  normalizedPath: string
): string | undefined {
  if (!fingerprint || !originalPath) {
    return fingerprint;
  }

  return fingerprint.replace(originalPath.replace(/\\/g, '/'), normalizedPath);
}

function buildUnavailableWarning(result: CommandExecutionResult): S006ScanWarning {
  const detail = result.errorMessage || result.stderr || result.stdout || `command status ${result.status}`;
  return buildS006Warning(
    'scanner-unavailable',
    `Gitleaks scanner was unavailable or failed (${result.status}${result.exitCode === undefined ? '' : `, exit ${result.exitCode}`}): ${detail}`,
    true
  );
}
