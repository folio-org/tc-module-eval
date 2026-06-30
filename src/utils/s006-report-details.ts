import {
  S006RedactedReportDetails,
  S006SensitiveInformationAnalysisResult,
  S006SensitiveInformationFinding,
  S006SkippedFile,
  S006ScanWarning
} from '../types';
import { strongestS006ReportFindings } from './s006-ranking';
import { redactS006Path, redactS006ReportText } from './s006-report-redaction';

const MAX_CRITERION_FINDINGS = 16;
const MAX_CRITERION_SKIPPED_FILES = 40;
const MAX_CRITERION_WARNINGS = 40;

export function buildS006CriterionDetails(
  analysis: S006SensitiveInformationAnalysisResult
): S006RedactedReportDetails {
  return {
    criterionId: 'S006',
    findingCount: analysis.findings.length,
    retainedFindingCount: Math.min(analysis.findings.length, MAX_CRITERION_FINDINGS),
    findings: strongestS006ReportFindings(analysis.findings, MAX_CRITERION_FINDINGS).map(redactS006Finding),
    scanner: redactS006ScannerSummary(analysis),
    coverage: {
      scannedFiles: analysis.coverage.scannedFiles,
      scannedBytes: analysis.coverage.scannedBytes,
      candidateFiles: analysis.coverage.candidateFiles,
      skippedFiles: analysis.coverage.skippedFiles
        .slice(0, MAX_CRITERION_SKIPPED_FILES)
        .map(redactS006SkippedFile),
      warnings: analysis.coverage.warnings
        .slice(0, MAX_CRITERION_WARNINGS)
        .map(redactS006Warning),
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
        .map(redactS006Warning)
    },
    classification: {
      ...analysis.classification,
      reason: redactS006ReportText(analysis.classification.reason),
      findingReferences: analysis.classification.findingReferences
        .slice(0, MAX_CRITERION_FINDINGS)
        .map(redactS006Path)
    },
    warnings: analysis.warnings.slice(0, MAX_CRITERION_WARNINGS).map(redactS006Warning),
    agentReviewUnavailableReason: analysis.agentReviewUnavailableReason
      ? redactS006ReportText(analysis.agentReviewUnavailableReason)
      : undefined
  };
}

function redactS006ScannerSummary(analysis: S006SensitiveInformationAnalysisResult) {
  return {
    name: analysis.scanner.name,
    status: analysis.scanner.status,
    findingCount: analysis.scanner.findingCount,
    warning: analysis.scanner.warning ? redactS006Warning(analysis.scanner.warning) : undefined
  };
}

function redactS006Finding(finding: S006SensitiveInformationFinding) {
  return {
    path: redactS006Path(finding.path),
    line: finding.line,
    endLine: finding.endLine,
    detectorId: finding.detectorId,
    category: finding.category,
    context: finding.context,
    confidence: finding.confidence,
    severity: finding.severity,
    redactedExcerpt: {
      ...finding.redactedExcerpt,
      text: redactS006ReportText(finding.redactedExcerpt.text)
    },
    rationale: redactS006ReportText(finding.rationale)
  };
}

function redactS006SkippedFile(skippedFile: S006SkippedFile): S006SkippedFile {
  return {
    ...skippedFile,
    path: redactS006Path(skippedFile.path),
    message: skippedFile.message ? redactS006ReportText(skippedFile.message) : undefined
  };
}

function redactS006Warning(warning: S006ScanWarning): S006ScanWarning {
  return {
    ...warning,
    message: redactS006ReportText(warning.message),
    path: warning.path ? redactS006Path(warning.path) : undefined
  };
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
