import {
  S006ReportDetails,
  S006ReportFinding,
  S006SensitiveInformationAnalysisResult,
  S006SensitiveInformationFinding,
  S006SkippedFile,
  S006ScanWarning
} from '../types';
import { strongestS006ReportFindings } from './s006-ranking';

const MAX_CRITERION_FINDINGS = 16;
const MAX_CRITERION_SKIPPED_FILES = 40;
const MAX_CRITERION_WARNINGS = 40;

export function buildS006CriterionDetails(
  analysis: S006SensitiveInformationAnalysisResult
): S006ReportDetails {
  return {
    criterionId: 'S006',
    findingCount: analysis.findings.length,
    retainedFindingCount: Math.min(analysis.findings.length, MAX_CRITERION_FINDINGS),
    findings: strongestS006ReportFindings(analysis.findings, MAX_CRITERION_FINDINGS).map(toS006ReportFinding),
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

function toS006ReportFinding(finding: S006SensitiveInformationFinding): S006ReportFinding {
  return {
    path: finding.path,
    line: finding.line,
    endLine: finding.endLine,
    detectorId: finding.detectorId,
    category: finding.category,
    context: finding.context,
    confidence: finding.confidence,
    severity: finding.severity,
    excerpt: finding.excerpt,
    rationale: finding.rationale
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
