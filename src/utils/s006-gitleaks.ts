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
export const MAX_GITLEAKS_REPORT_BYTES = 32 * 1024 * 1024;
// The repository must not configure its own scan: a committed .gitleaks.toml would replace the
// default rules (or allowlist every path), and gitleaks:allow comments would hide findings.
const GITLEAKS_DEFAULT_CONFIG = '[extend]\nuseDefault = true\n';

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
  const configPath = path.join(reportDir, 'gitleaks.toml');
  const command = process.env.GITLEAKS_PATH || 'gitleaks';
  const commandRunner = options.commandRunner ?? new LocalCommandRunner(false);

  try {
    fs.writeFileSync(configPath, GITLEAKS_DEFAULT_CONFIG, { flag: 'wx' });
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
        '--config',
        configPath,
        '--ignore-gitleaks-allow',
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
        `Gitleaks could not be used: ${oneLine(error instanceof Error ? error.message : String(error))}. Check that Gitleaks is installed or set GITLEAKS_PATH, then run the evaluation again.`,
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

  if (fs.statSync(reportPath).size > MAX_GITLEAKS_REPORT_BYTES) {
    throw new Error(`the report is larger than ${MAX_GITLEAKS_REPORT_BYTES / (1024 * 1024)} MB`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  } catch (error) {
    throw new Error(`the report could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('the report did not contain a list of findings');
  }

  // Gitleaks scans files concurrently, so its report order varies between runs; sort it so the same
  // findings are kept when the finding limit is reached.
  return parsed
    .filter(isGitleaksFinding)
    .map(finding => normalizeGitleaksFindingPath(finding, repoPath))
    .sort((left, right) =>
      compareText(left.File, right.File) ||
      (left.StartLine ?? 0) - (right.StartLine ?? 0) ||
      compareText(left.RuleID, right.RuleID) ||
      compareText(left.Fingerprint, right.Fingerprint) ||
      compareText(left.Secret, right.Secret)
    );
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
  const detail = oneLine(result.errorMessage || result.stderr || result.stdout || `command status ${result.status}`);
  return buildS006Warning(
    'scanner-unavailable',
    `Gitleaks did not run (${result.status}${result.exitCode === undefined ? '' : `, exit ${result.exitCode}`}): ${detail}. Install Gitleaks or set GITLEAKS_PATH, then run the evaluation again.`,
    true
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}

function compareText(left: string | undefined, right: string | undefined): number {
  const a = left ?? '';
  const b = right ?? '';
  return a < b ? -1 : a > b ? 1 : 0;
}
