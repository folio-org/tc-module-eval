import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  S006FindingConfidence,
  S006FindingContext,
  S006FindingSeverity,
  S006RedactedReportDetails,
  S006SensitiveInformationAnalysisResult,
  S006SensitiveInformationFinding,
  S006SkippedFile,
  S006ScanWarning
} from '../types';
import { redactSensitiveText } from './redaction';

const MAX_REPORT_LIST_ITEMS = 8;
const MAX_CRITERION_FINDINGS = 16;
const MAX_CRITERION_SKIPPED_FILES = 40;
const MAX_CRITERION_WARNINGS = 40;

type S006FindingStatusImpact = 'deterministic_fail' | 'manual_review';

export function formatS006Evidence(
  analysis: S006SensitiveInformationAnalysisResult,
  agentReview?: CriterionAgentReviewResult
): { evidence: string; details: string } {
  const strongestFindings = strongestS006ReportFindings(analysis.findings);
  const deterministicFailures = strongestFindings.filter(isS006ReportFailureFinding);
  const manualFindings = strongestFindings.filter(finding => !isS006ReportFailureFinding(finding));
  const materialWarnings = analysis.coverage.warnings.filter(warning => warning.materialToCoverage);
  const nonMaterialWarnings = analysis.coverage.warnings.filter(warning => !warning.materialToCoverage);
  const materialSkippedFiles = analysis.coverage.skippedFiles.filter(skippedFile => skippedFile.materialToCoverage);
  const nonMaterialSkippedFiles = analysis.coverage.skippedFiles.filter(skippedFile => !skippedFile.materialToCoverage);

  const evidence = `S006 ${analysis.classification.status}: ${analysis.classification.reason}`;
  const lines: Array<string | undefined> = [
    'Status rationale:',
    `  - Deterministic status: ${analysis.classification.status}`,
    `  - Reason: ${analysis.classification.reason}`,
    `  - Materially weakened coverage: ${analysis.classification.materiallyWeakenedCoverage ? 'yes' : 'no'}`,
    analysis.classification.findingReferences.length
      ? `  - Finding references: ${formatReferences(analysis.classification.findingReferences)}`
      : '  - Finding references: none',
    '',
    'Scan coverage:',
    `  - Candidate files discovered: ${analysis.coverage.candidateFiles}`,
    `  - Files scanned: ${analysis.coverage.scannedFiles}`,
    `  - Bytes scanned: ${analysis.coverage.scannedBytes}`,
    `  - Skipped files: ${analysis.coverage.skippedFiles.length} (${materialSkippedFiles.length} material, ${nonMaterialSkippedFiles.length} non-material)`,
    `  - Coverage complete: ${analysis.coverage.complete ? 'yes' : 'no'}`,
    `  - Coverage warnings: ${analysis.coverage.warnings.length} (${materialWarnings.length} material, ${nonMaterialWarnings.length} non-material)`,
    ...formatWarningLines('Material scan-limit warnings:', materialWarnings),
    ...formatWarningLines('Non-material coverage warnings:', nonMaterialWarnings),
    ...formatSkippedLines('Material skipped files:', materialSkippedFiles),
    ...formatSkippedLines('Non-material skipped files:', nonMaterialSkippedFiles),
    '',
    'Deterministic failure findings:',
    ...formatFindingLines(deterministicFailures),
    '',
    'Manual review findings:',
    ...formatFindingLines(manualFindings),
    ...formatFindingOverflowLine(analysis.findings.length, strongestFindings.length)
  ];

  appendAgentReviewLines(lines, analysis, agentReview);

  return {
    evidence: redactS006ReportText(evidence, 700),
    details: redactS006ReportText(lines.filter((line): line is string => line !== undefined).join('\n'), 12_000)
  };
}

export function buildS006CriterionDetails(
  analysis: S006SensitiveInformationAnalysisResult
): S006RedactedReportDetails {
  return {
    criterionId: 'S006',
    findingCount: analysis.findings.length,
    retainedFindingCount: Math.min(analysis.findings.length, MAX_CRITERION_FINDINGS),
    findings: strongestS006ReportFindings(analysis.findings, MAX_CRITERION_FINDINGS).map(redactS006Finding),
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

export function buildS006RedactedReportDetails(
  analysis: S006SensitiveInformationAnalysisResult
): S006RedactedReportDetails {
  return buildS006CriterionDetails(analysis);
}

export function strongestS006ReportFindings(
  findings: S006SensitiveInformationFinding[],
  limit: number = MAX_REPORT_LIST_ITEMS
): S006SensitiveInformationFinding[] {
  return [...findings]
    .sort((left, right) =>
      impactRank(left) - impactRank(right) ||
      severityRank(left.severity) - severityRank(right.severity) ||
      confidenceRank(left.confidence) - confidenceRank(right.confidence) ||
      contextRank(left.context) - contextRank(right.context) ||
      left.path.localeCompare(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.detectorId.localeCompare(right.detectorId)
    )
    .slice(0, limit);
}

function formatFindingLines(findings: S006SensitiveInformationFinding[]): string[] {
  if (!findings.length) {
    return ['  - none'];
  }

  return findings.slice(0, MAX_REPORT_LIST_ITEMS).map(finding => {
    const location = `${redactS006Path(finding.path)}${finding.line === undefined ? '' : `:${finding.line}`}`;
    const lineRange = finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : '';
    const localDefault = finding.context === 'local_docker_defaults'
      ? ' local-default context; verify values are not reused outside local development.'
      : '';
    const documentation = finding.context === 'documentation'
      ? ' documentation evidence; reviewer should verify this is example text, not an operational token.'
      : '';

    return [
      `  - ${location}${lineRange} [${finding.context}/${finding.confidence}/${finding.severity}/${finding.category}] ${finding.detectorId}`,
      `    rationale: ${redactS006ReportText(finding.rationale)}${localDefault}${documentation}`,
      `    excerpt: ${redactS006ReportText(finding.redactedExcerpt.text)}`
    ].join('\n');
  });
}

function formatWarningLines(heading: string, warnings: S006ScanWarning[]): string[] {
  if (!warnings.length) {
    return [`  - ${heading} none`];
  }

  return [
    `  - ${heading}`,
    ...warnings.slice(0, MAX_REPORT_LIST_ITEMS).map(warning =>
      `    - ${warning.kind}${warning.path ? ` ${redactS006Path(warning.path)}` : ''}: ${redactS006ReportText(warning.message)}`
    ),
    ...overflowLine(warnings.length, MAX_REPORT_LIST_ITEMS)
  ];
}

function formatSkippedLines(heading: string, skippedFiles: S006SkippedFile[]): string[] {
  if (!skippedFiles.length) {
    return [`  - ${heading} none`];
  }

  return [
    `  - ${heading}`,
    ...skippedFiles.slice(0, MAX_REPORT_LIST_ITEMS).map(skippedFile =>
      `    - ${redactS006Path(skippedFile.path)} (${skippedFile.reason}${skippedFile.message ? `: ${redactS006ReportText(skippedFile.message)}` : ''})`
    ),
    ...overflowLine(skippedFiles.length, MAX_REPORT_LIST_ITEMS)
  ];
}

function appendAgentReviewLines(
  lines: Array<string | undefined>,
  analysis: S006SensitiveInformationAnalysisResult,
  agentReview?: CriterionAgentReviewResult
): void {
  if (agentReview?.available) {
    lines.push(
      '',
      'Agent review:',
      agentReview.recommendation ? `  - Advisory recommendation: ${agentReview.recommendation}` : undefined,
      agentReview.confidence ? `  - Confidence: ${agentReview.confidence}` : undefined,
      agentReview.summary ? `  - Summary: ${redactS006ReportText(agentReview.summary)}` : undefined,
      agentReview.rationale ? `  - Rationale: ${redactS006ReportText(agentReview.rationale)}` : undefined,
      agentReview.evidenceReferences.length ? `  - Evidence references: ${agentReview.evidenceReferences.map(redactS006Path).join(', ')}` : undefined,
      agentReview.warnings.length ? `  - Warnings: ${agentReview.warnings.map(warning => redactS006ReportText(warning)).join('; ')}` : undefined,
      agentReview.errors.length ? `  - Errors: ${agentReview.errors.map(error => redactS006ReportText(error)).join('; ')}` : undefined,
      agentReview.metadata ? `  - Adapter: ${agentReview.metadata.adapter}` : undefined,
      agentReview.metadata?.modelLabel ? `  - Model label: ${agentReview.metadata.modelLabel}` : undefined
    );
    return;
  }

  if (analysis.classification.status !== EvaluationStatus.MANUAL) {
    return;
  }

  lines.push(
    '',
    'Agent review:',
    `  - Not applied: ${analysis.agentReviewUnavailableReason ?? 'agent review is disabled or unconfigured'}`
  );
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

function impactRank(finding: S006SensitiveInformationFinding): number {
  return isS006ReportFailureFinding(finding) ? 0 : 1;
}

function severityRank(severity: S006FindingSeverity): number {
  const ranks: Record<S006FindingSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4
  };
  return ranks[severity];
}

function confidenceRank(confidence: S006FindingConfidence): number {
  const ranks: Record<S006FindingConfidence, number> = {
    high: 0,
    medium: 1,
    low: 2
  };
  return ranks[confidence];
}

function contextRank(context: S006FindingContext): number {
  const ranks: Record<S006FindingContext, number> = {
    production_source_or_configuration: 0,
    ci_or_deployment_configuration: 1,
    local_docker_defaults: 2,
    documentation: 3,
    test_fixture: 4,
    sample_or_example: 5,
    unknown: 6,
    generated_content: 7
  };
  return ranks[context];
}

function isS006ReportFailureFinding(finding: S006SensitiveInformationFinding): boolean {
  return (
    finding.rationale.includes('deterministic failure candidate') ||
    (
      finding.confidence === 'high' &&
      finding.valueClassification === 'live-looking' &&
      (finding.context === 'production_source_or_configuration' || finding.context === 'ci_or_deployment_configuration') &&
      (finding.severity === 'critical' || finding.severity === 'high')
    )
  );
}

function formatReferences(references: string[]): string {
  const visible = references.slice(0, MAX_REPORT_LIST_ITEMS).map(redactS006Path).join(', ');
  const hiddenCount = references.length - MAX_REPORT_LIST_ITEMS;
  return hiddenCount > 0 ? `${visible}, ... ${hiddenCount} more` : visible;
}

function formatFindingOverflowLine(total: number, visible: number): string[] {
  return total > visible ? [`  - Additional retained findings omitted from report details: ${total - visible}`] : [];
}

function overflowLine(total: number, visible: number): string[] {
  return total > visible ? [`    - ... ${total - visible} more`] : [];
}

function redactS006Path(path: string): string {
  return redactS006ReportText(path)
    .replace(/\/Users\/[^/\s]+/g, '/Users/[REDACTED_USER]')
    .replace(/\/home\/[^/\s]+/g, '/home/[REDACTED_USER]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, 'C:\\Users\\[REDACTED_USER]');
}

function redactS006ReportText(input: string, maxBytes?: number): string {
  return redactSensitiveText(input, maxBytes);
}
