import {
  S006FindingConfidence,
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
    excerpt: {
      ...finding.excerpt,
      text: reportSafeExcerpt(finding)
    },
    rationale: disposition === 'deterministic_failure'
      ? `Deterministic failure under S006 policy; rule=${finding.detectorId}, context=${finding.context}.`
      : `Scanner/pattern candidate requiring reviewer judgment; rule=${finding.detectorId}, context=${finding.context}.`
  };
}

function reportSafeExcerpt(finding: S006SensitiveInformationFinding): string {
  if (finding.detectorId === 'password-secret-assignment' || finding.detectorId === 'provider-api-key') {
    const key = finding.excerpt.text.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]{0,80})\s*[:=]/)?.[1];
    if (key) {
      return `${key}=[REDACTED]`;
    }
  }
  return `[REDACTED_${finding.category.toUpperCase()}]`;
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
