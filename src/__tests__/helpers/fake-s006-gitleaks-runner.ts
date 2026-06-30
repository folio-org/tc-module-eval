import * as fs from 'fs';
import * as path from 'path';

import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner
} from '../../types';
import {
  buildS006RedactedDetectorMatch,
  createS006FingerprintRun,
  S006_DETECTOR_REGISTRY
} from '../../utils/s006-sensitive-information';
import { findCandidateFiles, relativePosixPath } from '../../utils/repo-files';

const GITLEAKS_DETECTOR_IDS = new Set([
  'provider-api-key',
  'private-key-block',
  'bearer-or-jwt-token',
  'password-secret-assignment',
  'credential-url'
]);

export class FakeS006GitleaksRunner implements CommandRunner {
  public readonly requests: CommandExecutionRequest[] = [];

  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify(request);
  }

  async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    this.requests.push(request);
    const findings = this.scan(request.cwd);
    const reportPath = this.reportPath(request);
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(findings, null, 2));
    }

    return this.result(request, findings.length ? 'failed' : 'success', findings.length ? 1 : 0);
  }

  private scan(repoPath: string): unknown[] {
    const findings: unknown[] = [];
    const detectorRun = createS006FingerprintRun(Buffer.alloc(32, 1));

    for (const relativePath of this.listFiles(repoPath)) {
      const absolutePath = path.join(repoPath, relativePath);
      const text = fs.readFileSync(absolutePath, 'utf-8');
      const occupiedRanges: Array<{ start: number; end: number }> = [];
      for (const detector of S006_DETECTOR_REGISTRY) {
        if (!GITLEAKS_DETECTOR_IDS.has(detector.id)) {
          continue;
        }
        const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          if (!match[0]) {
            continue;
          }
          const start = match.index;
          const end = start + match[0].length;
          if (occupiedRanges.some(range => start < range.end && range.start < end)) {
            continue;
          }
          const redacted = buildS006RedactedDetectorMatch(detector, match[0], detectorRun, this.lineForOffset(text, match.index));
          if (
            redacted.valueClassification === 'placeholder' ||
            isEnvironmentReferenceOnly(match[0]) ||
            isBlankAssignment(match[0]) ||
            isNonSecretTestConstant(match[0])
          ) {
            continue;
          }
          occupiedRanges.push({ start, end });
          findings.push({
            RuleID: detector.id,
            Description: detector.label,
            File: relativePath,
            StartLine: redacted.redactedExcerpt.startLine,
            EndLine: redacted.redactedExcerpt.endLine,
            Match: redacted.redactedExcerpt.text,
            Secret: 'REDACTED',
            Entropy: redacted.valueClassification === 'synthetic' ? 2 : 4,
            Fingerprint: `${relativePath}:${detector.id}:${redacted.redactedExcerpt.startLine}:${redacted.valueFingerprint.value}`
          });
        }
      }
    }

    return findings;
  }

  private listFiles(repoPath: string): string[] {
    return findCandidateFiles(
      repoPath,
      repoPath,
      () => true,
      new Set(['.git', 'node_modules', 'target'])
    )
      .map(filePath => relativePosixPath(repoPath, filePath))
      .sort();
  }

  private lineForOffset(text: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < offset && index < text.length; index++) {
      if (text[index] === '\n' || (text[index] === '\r' && text[index + 1] !== '\n')) {
        line += 1;
      }
    }
    return line;
  }

  private reportPath(request: CommandExecutionRequest): string | undefined {
    const args = request.args ?? [];
    const index = args.indexOf('--report-path');
    return index >= 0 ? args[index + 1] : undefined;
  }

  private result(
    request: CommandExecutionRequest,
    status: CommandExecutionResult['status'],
    exitCode: number
  ): CommandExecutionResult {
    return {
      identity: this.normalize(request),
      command: request.command,
      args: request.args ?? [],
      cwd: request.cwd,
      commandExecutionEnvironment: 'local',
      localCommandsAllowed: true,
      status,
      exitCode,
      signal: null,
      durationMs: 1,
      stdout: '',
      stderr: '',
      sanitized: true
    };
  }
}

function isEnvironmentReferenceOnly(rawMatch: string): boolean {
  const value = rawMatch.replace(/^[^:=]+[:=]\s*/, '').replace(/^["']|["']$/g, '').trim();
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?}$/.test(value) ||
    /^\$\{\{\s*(?:secrets|env|vars|github|inputs)\.[^}]+\}\}$/i.test(value) ||
    /^inherit$/i.test(value);
}

function isBlankAssignment(rawMatch: string): boolean {
  return /^[^:=]+[:=]\s*(?:\r?\n|\r|$)/.test(rawMatch);
}

function isNonSecretTestConstant(rawMatch: string): boolean {
  const value = rawMatch.replace(/^[^:=]+[:=]\s*/, '').replace(/^["']|["']$/g, '').trim();
  return /^(?:test|fake|mock|dummy)(?:[-_](?:password|secret|token|jwt|bearer))?$/i.test(value);
}
