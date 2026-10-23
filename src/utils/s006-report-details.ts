import {
  S006DetectorId,
  S006FindingCategory,
  S006FindingConfidence,
  S006FindingContext,
  S006FindingSeverity,
  S006ReportDetails,
  S006ReportFinding,
  S006SensitiveInformationAnalysisResult,
  S006SensitiveInformationFinding,
  S006SkippedFile,
  S006ScanWarning
} from '../types';
import {
  rankS006Confidence,
  rankS006Severity,
  strongestS006ReportFindings
} from './s006-ranking';

const MAX_CRITERION_FINDINGS = 16;
const MAX_CRITERION_SKIPPED_FILES = 40;
const MAX_CRITERION_WARNINGS = 40;

export const S006_CATEGORY_LABELS: Record<S006FindingCategory, { one: string; many: string }> = {
  provider_api_key: { one: 'API key', many: 'API keys' },
  private_key: { one: 'private key', many: 'private keys' },
  bearer_or_jwt_token: { one: 'access token', many: 'access tokens' },
  password_or_secret_assignment: { one: 'password or secret value', many: 'passwords or secret values' },
  credential_url: { one: 'URL with a user name and password', many: 'URLs with a user name and password' },
  private_url: { one: 'local or private network address', many: 'local or private network addresses' },
  environment_file: { one: '.env file', many: '.env files' },
  tenant_or_host_endpoint: { one: 'server host name', many: 'server host names' },
  local_absolute_path: { one: "path on a developer's machine", many: "paths on a developer's machine" }
};

export const S006_CONTEXT_LABELS_PLAIN: Record<S006FindingContext, string> = {
  production_source_or_configuration: 'production code or configuration',
  ci_or_deployment_configuration: 'CI or deployment files',
  documentation: 'documentation',
  test_fixture: 'tests',
  sample_or_example: 'examples or templates',
  local_docker_defaults: 'local Docker setup',
  helper_script: 'helper scripts',
  generated_content: 'generated files',
  unknown: 'other files'
};

export const S006_DETECTOR_TAGS: Record<S006DetectorId, string> = {
  'provider-api-key': 'api-key',
  'private-key-block': 'private-key',
  'bearer-or-jwt-token': 'token',
  'password-secret-assignment': 'secret',
  'credential-url': 'login-url',
  'private-url': 'private-url',
  'environment-file': 'env-file',
  'tenant-host-endpoint': 'host',
  'local-absolute-path': 'local-path'
};

export const S006_SKIPPED_REASON_LABELS: Record<S006SkippedFile['reason'], string> = {
  'outside-repository': 'Links that point outside the repository',
  'dependency-directory': 'Dependency folders',
  'generated-artifact': 'Version control, build output, and report folders',
  binary: 'Binary files',
  'unsupported-file': 'Files the built-in scan does not read or follow',
  'read-error': 'Files or folders that could not be read',
  'file-too-large': 'Files too large to read',
  'scan-limit': 'Files past the scan limit'
};

export function buildS006CriterionDetails(
  analysis: S006SensitiveInformationAnalysisResult
): S006ReportDetails {
  const projectedFindings = strongestS006ReportFindings(analysis.findings, MAX_CRITERION_FINDINGS)
    .map(projectS006ReportFinding);
  return {
    criterionId: 'S006',
    findingCount: analysis.findings.length,
    retainedFindingCount: Math.min(analysis.findings.length, MAX_CRITERION_FINDINGS),
    findings: projectedFindings,
    findingSummary: buildFindingSummary(analysis.findings),
    scanner: analysis.scanner,
    coverage: {
      scannedFiles: analysis.coverage.scannedFiles,
      scannedBytes: analysis.coverage.scannedBytes,
      candidateFiles: analysis.coverage.candidateFiles,
      skippedFiles: analysis.coverage.skippedFiles
        .slice(0, MAX_CRITERION_SKIPPED_FILES),
      warnings: analysis.coverage.warnings
        .slice(0, MAX_CRITERION_WARNINGS),
      materiallyWeakened: analysis.coverage.materiallyWeakened,
      complete: analysis.coverage.complete
    },
    coverageSummary: {
      skippedFileCount: analysis.coverage.skippedFiles.length,
      materialSkippedFileCount: analysis.coverage.skippedFiles.filter(skippedFile => skippedFile.materialToCoverage).length,
      warningCount: analysis.coverage.warnings.length,
      materialWarningCount: analysis.coverage.warnings.filter(warning => warning.materialToCoverage).length,
      skippedFileReasonCounts: countSkippedReasons(analysis.coverage.skippedFiles),
      scanLimitWarnings: analysis.coverage.warnings
        .filter(isS006ScanLimitWarning)
        .slice(0, MAX_CRITERION_WARNINGS)
    },
    classification: {
      ...analysis.classification,
      findingReferences: analysis.classification.findingReferences.slice(0, MAX_CRITERION_FINDINGS)
    },
    warnings: analysis.warnings.slice(0, MAX_CRITERION_WARNINGS),
    agentReviewUnavailableReason: analysis.agentReviewUnavailableReason
  };
}

/** The sole projection from internal detector evidence into shareable report data. */
export function projectS006ReportFinding(finding: S006SensitiveInformationFinding): S006ReportFinding {
  const disposition = finding.statusImpact === 'deterministic_fail'
    ? 'deterministic_failure'
    : 'scanner_or_pattern_candidate';
  return {
    path: finding.path,
    line: finding.line,
    endLine: finding.endLine,
    detectorId: finding.detectorId,
    category: finding.category,
    context: finding.context,
    confidence: finding.confidence,
    severity: finding.severity,
    disposition,
    detectedBy: [...finding.detectedBy],
    excerpt: {
      ...finding.excerpt,
      text: reportSafeExcerpt(finding)
    },
    rationale: disposition === 'deterministic_failure'
      ? `Fails S006: ${S006_CATEGORY_LABELS[finding.category].one} that looks real, in ${S006_CONTEXT_LABELS_PLAIN[finding.context]}.`
      : `A reviewer must decide whether this ${S006_CATEGORY_LABELS[finding.category].one} in ${S006_CONTEXT_LABELS_PLAIN[finding.context]} is real.`
  };
}

function reportSafeExcerpt(finding: S006SensitiveInformationFinding): string {
  const name = s006AssignedName(finding);
  return name ? `${name}=[REDACTED]` : `[REDACTED_${finding.category.toUpperCase()}]`;
}

/** The variable or key a secret is assigned to, so reports can name it without showing the value. */
export function s006AssignedName(finding: S006SensitiveInformationFinding): string | undefined {
  if (finding.detectorId === 'password-secret-assignment' || finding.detectorId === 'provider-api-key') {
    return finding.excerpt.text.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]{0,80})\s*[:=]/)?.[1];
  }
  return undefined;
}

export function buildFindingSummary(
  findings: Array<Pick<S006ReportFinding, 'confidence' | 'severity'>>
): S006ReportDetails['findingSummary'] {
  if (!findings.length) {
    return {};
  }
  const confidence = range(findings.map(finding => finding.confidence), rankS006Confidence);
  const severity = range(findings.map(finding => finding.severity), rankS006Severity);
  return {
    confidenceRange: { minimum: confidence.minimum, maximum: confidence.maximum },
    severityRange: { minimum: severity.minimum, maximum: severity.maximum }
  };
}

function range<T extends S006FindingConfidence | S006FindingSeverity>(
  values: T[],
  rank: (value: T) => number
): { minimum: T; maximum: T } {
  const sorted = [...values].sort((left, right) => rank(left) - rank(right));
  return { maximum: sorted[0], minimum: sorted[sorted.length - 1] };
}

function countSkippedReasons(skippedFiles: S006SkippedFile[]): Partial<Record<S006SkippedFile['reason'], number>> {
  const counts: Partial<Record<S006SkippedFile['reason'], number>> = {};
  for (const skippedFile of skippedFiles) {
    counts[skippedFile.reason] = (counts[skippedFile.reason] ?? 0) + 1;
  }
  return counts;
}

function isS006ScanLimitWarning(warning: S006ScanWarning): boolean {
  return (
    warning.kind === 'traversal-limit' ||
    warning.kind === 'candidate-limit' ||
    warning.kind === 'byte-limit' ||
    warning.kind === 'file-truncated' ||
    warning.kind === 'finding-limit'
  );
}
