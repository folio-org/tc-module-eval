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
import { redactLocalUserPaths, redactSensitiveText } from './redaction';

const MAX_REPORT_LIST_ITEMS = 8;
const MAX_CRITERION_FINDINGS = 16;
const MAX_CRITERION_SKIPPED_FILES = 40;
const MAX_CRITERION_WARNINGS = 40;

export function formatS006Evidence(
  analysis: S006SensitiveInformationAnalysisResult,
  agentReview?: CriterionAgentReviewResult
): { evidence: string; details: string } {
  const strongestFindings = strongestS006ReportFindings(analysis.findings);
  const deterministicFailures = analysis.findings.filter(finding => finding.statusImpact === 'deterministic_fail');
  const manualFindings = analysis.findings.filter(finding => finding.statusImpact !== 'deterministic_fail');
  const materialWarnings = analysis.coverage.warnings.filter(warning => warning.materialToCoverage);
  const nonMaterialWarnings = analysis.coverage.warnings.filter(warning => !warning.materialToCoverage);
  const materialSkippedFiles = analysis.coverage.skippedFiles.filter(skippedFile => skippedFile.materialToCoverage);
  const nonMaterialSkippedFiles = analysis.coverage.skippedFiles.filter(skippedFile => !skippedFile.materialToCoverage);

  const evidence = formatS006EvidenceSummary(
    analysis,
    deterministicFailures.length,
    materialWarnings.length,
    materialSkippedFiles.length
  );
  const lines: Array<string | undefined> = [
    'Review summary:',
    `  - Status: ${analysis.classification.status}`,
    `  - Findings: ${analysis.findings.length} retained (${deterministicFailures.length} deterministic failure${deterministicFailures.length === 1 ? '' : 's'}, ${manualFindings.length} manual review)`,
    `  - Secret scanner: ${formatScannerSummary(analysis)}`,
    `  - Coverage: ${formatCoverageSummary(analysis, materialSkippedFiles.length, materialWarnings.length)}`,
    agentReview?.available
      ? `  - Agent review: ${agentReview.recommendation ?? 'completed'}${agentReview.confidence ? ` (${agentReview.confidence} confidence)` : ''}`
      : analysis.classification.status === EvaluationStatus.MANUAL
        ? `  - Agent review: not applied (${analysis.agentReviewUnavailableReason ?? 'disabled or unconfigured'})`
        : undefined,
    '',
    'Why:',
    ...formatWhyLines(analysis, deterministicFailures.length, materialWarnings.length, materialSkippedFiles.length),
    '',
    'Reviewer focus:',
    ...formatReviewerFocusLines(analysis, deterministicFailures.length, materialWarnings, materialSkippedFiles, agentReview),
    '',
    'Finding groups:',
    ...formatFindingGroupLines(analysis.findings),
    '',
    'Top redacted examples:',
    ...formatCompactFindingLines(strongestFindings),
    ...formatFindingOverflowLine(analysis.findings.length, strongestFindings.length),
    '',
    'Coverage:',
    `  - Candidate files discovered: ${analysis.coverage.candidateFiles}`,
    `  - Files scanned: ${analysis.coverage.scannedFiles}`,
    `  - Bytes scanned: ${analysis.coverage.scannedBytes}`,
    `  - Skipped files: ${analysis.coverage.skippedFiles.length} (${materialSkippedFiles.length} material, ${nonMaterialSkippedFiles.length} non-material)`,
    `  - Coverage complete: ${analysis.coverage.complete ? 'yes' : 'no'}`,
    `  - Coverage warnings: ${analysis.coverage.warnings.length} (${materialWarnings.length} material, ${nonMaterialWarnings.length} non-material)`,
    ...formatWarningLines('Material coverage warnings:', materialWarnings),
    ...formatWarningLines('Non-material coverage warnings:', nonMaterialWarnings),
    ...formatSkippedLines('Material skipped files:', materialSkippedFiles),
    ...formatSkippedLines('Non-material skipped files:', nonMaterialSkippedFiles)
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

function formatScannerSummary(analysis: S006SensitiveInformationAnalysisResult): string {
  const findingLabel = `${analysis.scanner.findingCount} Gitleaks finding${analysis.scanner.findingCount === 1 ? '' : 's'}`;
  if (analysis.scanner.status === 'completed') {
    return `Gitleaks completed; ${findingLabel}`;
  }

  const warning = analysis.scanner.warning;
  const warningText = warning
    ? `; ${warning.kind}: ${redactS006ReportText(warning.message)}`
    : '';
  return `Gitleaks unavailable; ${findingLabel}${warningText}`;
}

function redactS006ScannerSummary(analysis: S006SensitiveInformationAnalysisResult) {
  return {
    name: analysis.scanner.name,
    status: analysis.scanner.status,
    findingCount: analysis.scanner.findingCount,
    warning: analysis.scanner.warning ? redactS006Warning(analysis.scanner.warning) : undefined
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

function formatS006EvidenceSummary(
  analysis: S006SensitiveInformationAnalysisResult,
  deterministicFailureCount: number,
  materialWarningCount: number,
  materialSkippedFileCount: number
): string {
  if (analysis.classification.status === EvaluationStatus.PASS) {
    return `S006 pass: no retained sensitive/environment-specific findings; scanned ${analysis.coverage.scannedFiles} of ${analysis.coverage.candidateFiles} candidate files.`;
  }
  if (analysis.classification.status === EvaluationStatus.FAIL) {
    return `S006 fail: ${deterministicFailureCount} deterministic failure finding${deterministicFailureCount === 1 ? '' : 's'}; ${analysis.findings.length} total retained finding${analysis.findings.length === 1 ? '' : 's'}.`;
  }

  const coverageNote = analysis.coverage.materiallyWeakened
    ? `; coverage incomplete with ${materialWarningCount} material warning${materialWarningCount === 1 ? '' : 's'} and ${materialSkippedFileCount} material skipped file${materialSkippedFileCount === 1 ? '' : 's'}`
    : '';
  return `S006 manual: ${analysis.findings.length} retained finding${analysis.findings.length === 1 ? '' : 's'}; no deterministic failures${coverageNote}.`;
}

function formatCoverageSummary(
  analysis: S006SensitiveInformationAnalysisResult,
  materialSkippedFileCount: number,
  materialWarningCount: number
): string {
  const scanCount = `scanned ${analysis.coverage.scannedFiles} of ${analysis.coverage.candidateFiles} candidate files`;
  if (analysis.coverage.complete) {
    return `complete; ${scanCount}`;
  }
  return `incomplete; ${scanCount}; ${materialSkippedFileCount} material skipped file${materialSkippedFileCount === 1 ? '' : 's'}; ${materialWarningCount} material warning${materialWarningCount === 1 ? '' : 's'}`;
}

function formatWhyLines(
  analysis: S006SensitiveInformationAnalysisResult,
  deterministicFailureCount: number,
  materialWarningCount: number,
  materialSkippedFileCount: number
): string[] {
  if (analysis.classification.status === EvaluationStatus.PASS) {
    return [
      '  - No retained findings were detected.',
      analysis.coverage.complete
        ? '  - Candidate scan coverage was complete.'
        : '  - Candidate scan coverage had only non-material gaps.'
    ];
  }

  const lines = [
    deterministicFailureCount > 0
      ? `  - ${deterministicFailureCount} high-confidence live-looking finding${deterministicFailureCount === 1 ? '' : 's'} in production or CI/deployment context can fail S006.`
      : '  - No deterministic failure was found.',
    analysis.findings.length > 0
      ? `  - ${analysis.findings.length} redacted finding${analysis.findings.length === 1 ? ' still needs' : 's still need'} reviewer judgment.`
      : undefined,
    analysis.coverage.materiallyWeakened
      ? `  - Scan coverage is materially weakened by ${materialWarningCount || 'one or more'} warning${materialWarningCount === 1 ? '' : 's'} and ${materialSkippedFileCount} material skipped file${materialSkippedFileCount === 1 ? '' : 's'}.`
      : undefined
  ];

  return lines.filter((line): line is string => line !== undefined);
}

function formatReviewerFocusLines(
  analysis: S006SensitiveInformationAnalysisResult,
  deterministicFailureCount: number,
  materialWarnings: S006ScanWarning[],
  materialSkippedFiles: S006SkippedFile[],
  agentReview?: CriterionAgentReviewResult
): string[] {
  const lines: string[] = [];
  if (deterministicFailureCount > 0) {
    lines.push('  - Inspect deterministic failure findings first; these are live-looking secrets in production or CI/deployment context.');
  }
  if (analysis.findings.some(finding => finding.context === 'ci_or_deployment_configuration')) {
    lines.push('  - Verify whether CI workflow values are real committed values or safe references to external secret stores.');
  }
  if (analysis.findings.some(finding => finding.category === 'tenant_or_host_endpoint' || finding.category === 'private_url')) {
    lines.push('  - Check endpoint findings for environment-specific deployment details that should not be public.');
  }
  if (analysis.findings.some(finding => finding.context === 'documentation' || finding.context === 'test_fixture' || finding.context === 'sample_or_example')) {
    lines.push('  - Confirm documentation, sample, and test findings are examples rather than operational credentials.');
  }
  if (analysis.findings.some(finding => finding.context === 'local_docker_defaults')) {
    lines.push('  - Confirm local Docker defaults are not reused outside local development.');
  }
  if (materialWarnings.length || materialSkippedFiles.length) {
    lines.push('  - Review material coverage gaps before treating the scan as complete.');
  }
  if (!agentReview?.available && analysis.classification.status === EvaluationStatus.MANUAL) {
    lines.push('  - Agent advisory review was unavailable; make the S006 call from the redacted findings and coverage notes.');
  }

  return lines.length ? lines : ['  - No reviewer follow-up beyond normal S006 confirmation.'];
}

function formatFindingGroupLines(findings: S006SensitiveInformationFinding[]): string[] {
  if (!findings.length) {
    return ['  - none'];
  }

  const groups = new Map<string, {
    count: number;
    context: S006FindingContext;
    category: string;
    maxSeverity: S006FindingSeverity;
    maxConfidence: S006FindingConfidence;
  }>();

  for (const finding of findings) {
    const key = `${finding.context}\0${finding.category}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.maxSeverity = severityRank(finding.severity) < severityRank(existing.maxSeverity) ? finding.severity : existing.maxSeverity;
      existing.maxConfidence = confidenceRank(finding.confidence) < confidenceRank(existing.maxConfidence) ? finding.confidence : existing.maxConfidence;
    } else {
      groups.set(key, {
        count: 1,
        context: finding.context,
        category: finding.category,
        maxSeverity: finding.severity,
        maxConfidence: finding.confidence
      });
    }
  }

  return [...groups.values()]
    .sort((left, right) =>
      severityRank(left.maxSeverity) - severityRank(right.maxSeverity) ||
      confidenceRank(left.maxConfidence) - confidenceRank(right.maxConfidence) ||
      contextRank(left.context) - contextRank(right.context) ||
      right.count - left.count ||
      left.category.localeCompare(right.category)
    )
    .slice(0, MAX_REPORT_LIST_ITEMS)
    .map(group =>
      `  - ${group.count} ${formatFindingCategory(group.category, group.count)} in ${formatFindingContext(group.context)} (${formatConfidenceSeverity(group.maxConfidence, group.maxSeverity)})`
    );
}

function formatCompactFindingLines(findings: S006SensitiveInformationFinding[]): string[] {
  if (!findings.length) {
    return ['  - none'];
  }

  return findings.slice(0, MAX_REPORT_LIST_ITEMS).map(finding => {
    const location = `${redactS006Path(finding.path)}${finding.line === undefined ? '' : `:${finding.line}`}`;
    const lineRange = finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : '';
    return `  - ${location}${lineRange} | ${formatFindingCategory(finding.category, 1)} | ${formatFindingContext(finding.context)} | ${formatConfidenceSeverity(finding.confidence, finding.severity)} | ${redactS006ReportText(finding.redactedExcerpt.text)}`;
  });
}

function formatConfidenceSeverity(confidence: S006FindingConfidence, severity: S006FindingSeverity): string {
  return `confidence ${confidence}, severity ${severity}`;
}

function formatFindingCategory(category: string, count: number): string {
  const label = category.split('_').join(' ');
  if (count === 1 || label.endsWith('s')) {
    return label;
  }
  return `${label}s`;
}

function formatFindingContext(context: S006FindingContext): string {
  return context.split('_').join(' ');
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
  return finding.statusImpact === 'deterministic_fail' ? 0 : 1;
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


function formatFindingOverflowLine(total: number, visible: number): string[] {
  return total > visible ? [`  - Additional retained findings omitted from report details: ${total - visible}`] : [];
}

function overflowLine(total: number, visible: number): string[] {
  return total > visible ? [`    - ... ${total - visible} more`] : [];
}

function redactS006Path(path: string): string {
  return redactLocalUserPaths(redactS006ReportText(path));
}

function redactS006ReportText(input: string, maxBytes?: number): string {
  return redactLocalUserPaths(redactSensitiveText(input, maxBytes));
}
