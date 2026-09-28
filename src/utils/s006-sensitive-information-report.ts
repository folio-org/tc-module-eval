import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  S006FindingConfidence,
  S006FindingContext,
  S006FindingSeverity,
  S006ReportFinding,
  S006SensitiveInformationAnalysisResult,
  S006SensitiveInformationFinding,
  S006SkippedFile,
  S006ScanWarning
} from '../types';
import {
  rankS006Confidence,
  rankS006Context,
  rankS006Severity,
  strongestS006ReportFindings
} from './s006-ranking';
import { redactSensitiveText, truncateToByteBudget } from './redaction';
import { buildFindingSummary, projectS006ReportFinding } from './s006-report-details';

const MAX_REPORT_LIST_ITEMS = 8;

export function formatS006Evidence(
  analysis: S006SensitiveInformationAnalysisResult,
  agentReview?: CriterionAgentReviewResult
): { evidence: string; details: string } {
  const report = summarizeS006Report(analysis);

  const evidence = formatS006EvidenceSummary(
    analysis,
    report.deterministicFailures.length,
    report.materialWarnings.length,
    report.materialSkippedFiles.length
  );
  const lines: Array<string | undefined> = [
    'Review summary:',
    `  - Status: ${analysis.classification.status}`,
    `  - Findings: ${analysis.findings.length} retained (${report.deterministicFailures.length} deterministic failure${report.deterministicFailures.length === 1 ? '' : 's'}, ${report.manualFindings.length} scanner/pattern candidate${report.manualFindings.length === 1 ? '' : 's'})`,
    ...formatAggregateRangeLines(analysis.findings),
    `  - Secret scanner: ${formatScannerSummary(analysis)}`,
    `  - Coverage: ${formatCoverageSummary(analysis, report.materialSkippedFiles.length, report.materialWarnings.length)}`,
    agentReview?.available
      ? `  - Agent review: ${agentReview.recommendation ?? 'completed'}${agentReview.confidence ? ` (${agentReview.confidence} confidence)` : ''}`
      : analysis.classification.status === EvaluationStatus.MANUAL
        ? `  - Agent review: not applied (${analysis.agentReviewUnavailableReason ?? 'disabled or unconfigured'})`
        : undefined,
    '',
    'Why:',
    ...formatWhyLines(analysis, report.deterministicFailures.length, report.materialWarnings.length, report.materialSkippedFiles.length),
    '',
    'Reviewer focus:',
    ...formatReviewerFocusLines(analysis, report.deterministicFailures.length, report.materialWarnings, report.materialSkippedFiles, agentReview),
    '',
    'Finding groups:',
    ...formatFindingGroupLines(analysis.findings),
    '',
    'Top examples:',
    ...formatCompactFindingLines(report.strongestFindings.map(projectS006ReportFinding)),
    ...formatFindingOverflowLine(analysis.findings.length, report.strongestFindings.length),
    '',
    'Coverage:',
    `  - Candidate files discovered: ${analysis.coverage.candidateFiles}`,
    `  - Files scanned: ${analysis.coverage.scannedFiles}`,
    `  - Bytes scanned: ${analysis.coverage.scannedBytes}`,
    `  - Skipped files: ${analysis.coverage.skippedFiles.length} (${report.materialSkippedFiles.length} material, ${report.nonMaterialSkippedFiles.length} non-material)`,
    `  - Coverage complete: ${analysis.coverage.complete ? 'yes' : 'no'}`,
    `  - Coverage warnings: ${analysis.coverage.warnings.length} (${report.materialWarnings.length} material, ${report.nonMaterialWarnings.length} non-material)`,
    ...formatWarningLines('Material coverage warnings:', report.materialWarnings),
    ...formatWarningLines('Non-material coverage warnings:', report.nonMaterialWarnings),
    ...formatSkippedLines('Material skipped files:', report.materialSkippedFiles),
    ...formatSkippedLines('Non-material skipped files:', report.nonMaterialSkippedFiles)
  ];

  appendAgentReviewLines(lines, analysis, agentReview);

  return {
    evidence: truncateToByteBudget(evidence, 700),
    details: truncateToByteBudget(lines.filter((line): line is string => line !== undefined).join('\n'), 12_000)
  };
}

function formatScannerSummary(analysis: S006SensitiveInformationAnalysisResult): string {
  const findingLabel = `${analysis.scanner.findingCount} Gitleaks finding${analysis.scanner.findingCount === 1 ? '' : 's'}`;
  if (analysis.scanner.status === 'completed') {
    return `Gitleaks completed; ${findingLabel}`;
  }

  const warning = analysis.scanner.warning;
  const warningText = warning
    ? `; ${warning.kind}: ${warning.message}`
    : '';
  return `Gitleaks unavailable; ${findingLabel}${warningText}`;
}

interface S006ReportSummary {
  strongestFindings: S006SensitiveInformationFinding[];
  deterministicFailures: S006SensitiveInformationFinding[];
  manualFindings: S006SensitiveInformationFinding[];
  materialWarnings: S006ScanWarning[];
  nonMaterialWarnings: S006ScanWarning[];
  materialSkippedFiles: S006SkippedFile[];
  nonMaterialSkippedFiles: S006SkippedFile[];
}

function summarizeS006Report(analysis: S006SensitiveInformationAnalysisResult): S006ReportSummary {
  return {
    strongestFindings: strongestS006ReportFindings(analysis.findings, MAX_REPORT_LIST_ITEMS),
    deterministicFailures: analysis.findings.filter(finding => finding.statusImpact === 'deterministic_fail'),
    manualFindings: analysis.findings.filter(finding => finding.statusImpact !== 'deterministic_fail'),
    materialWarnings: analysis.coverage.warnings.filter(warning => warning.materialToCoverage),
    nonMaterialWarnings: analysis.coverage.warnings.filter(warning => !warning.materialToCoverage),
    materialSkippedFiles: analysis.coverage.skippedFiles.filter(skippedFile => skippedFile.materialToCoverage),
    nonMaterialSkippedFiles: analysis.coverage.skippedFiles.filter(skippedFile => !skippedFile.materialToCoverage)
  };
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
    analysis.findings.length - deterministicFailureCount > 0
      ? `  - ${analysis.findings.length - deterministicFailureCount} scanner/pattern candidate${analysis.findings.length - deterministicFailureCount === 1 ? '' : 's'} ${analysis.findings.length - deterministicFailureCount === 1 ? 'needs' : 'need'} reviewer judgment.`
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
    lines.push('  - Agent advisory review was unavailable; make the S006 call from the findings and coverage notes.');
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
      existing.maxSeverity = rankS006Severity(finding.severity) < rankS006Severity(existing.maxSeverity) ? finding.severity : existing.maxSeverity;
      existing.maxConfidence = rankS006Confidence(finding.confidence) < rankS006Confidence(existing.maxConfidence) ? finding.confidence : existing.maxConfidence;
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
      rankS006Severity(left.maxSeverity) - rankS006Severity(right.maxSeverity) ||
      rankS006Confidence(left.maxConfidence) - rankS006Confidence(right.maxConfidence) ||
      rankS006Context(left.context) - rankS006Context(right.context) ||
      right.count - left.count ||
      left.category.localeCompare(right.category)
    )
    .slice(0, MAX_REPORT_LIST_ITEMS)
    .map(group =>
      `  - ${group.count} ${formatFindingCategory(group.category, group.count)} in ${formatFindingContext(group.context)} (maximum confidence ${group.maxConfidence}, maximum severity ${group.maxSeverity})`
    );
}

function formatCompactFindingLines(findings: S006ReportFinding[]): string[] {
  if (!findings.length) {
    return ['  - none'];
  }

  return findings.slice(0, MAX_REPORT_LIST_ITEMS).map(finding => {
    const location = `${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}`;
    const lineRange = finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : '';
    const label = finding.disposition === 'deterministic_failure'
      ? 'deterministic failure'
      : 'scanner/pattern candidate';
    return `  - ${location}${lineRange} | ${label} | rule ${finding.detectorId} | ${formatFindingCategory(finding.category, 1)} | ${formatFindingContext(finding.context)} | ${formatConfidenceSeverity(finding.confidence, finding.severity)} | ${finding.excerpt.text}`;
  });
}

function formatConfidenceSeverity(confidence: S006FindingConfidence, severity: S006FindingSeverity): string {
  return `confidence ${confidence}, severity ${severity}`;
}

function formatAggregateRangeLines(findings: S006SensitiveInformationFinding[]): string[] {
  const summary = buildFindingSummary(findings);
  if (!summary.confidenceRange || !summary.severityRange) {
    return [];
  }
  return [
    `  - Aggregate confidence range: ${summary.confidenceRange.minimum} to ${summary.confidenceRange.maximum} (maximum ${summary.confidenceRange.maximum})`,
    `  - Aggregate severity range: ${summary.severityRange.minimum} to ${summary.severityRange.maximum} (maximum ${summary.severityRange.maximum})`
  ];
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
      `    - ${warning.path ? `${warning.path} [${warning.kind}]` : `[${warning.kind}]`} ${warning.message}`
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
      `    - ${skippedFile.path} [${skippedFile.reason}]${skippedFile.message ? ` ${skippedFile.message}` : ''}`
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
      agentReview.summary ? `  - Summary: ${redactSensitiveText(agentReview.summary)}` : undefined,
      agentReview.rationale ? `  - Rationale: ${redactSensitiveText(agentReview.rationale)}` : undefined,
      agentReview.warnings.length ? `  - Warnings: ${redactSensitiveText(agentReview.warnings.join('; '))}` : undefined,
      agentReview.errors.length ? `  - Errors: ${redactSensitiveText(agentReview.errors.join('; '))}` : undefined,
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

function formatFindingOverflowLine(total: number, visible: number): string[] {
  return total > visible ? [`  - Additional retained findings omitted from report details: ${total - visible}`] : [];
}

function overflowLine(total: number, visible: number): string[] {
  return total > visible ? [`    - ... ${total - visible} more`] : [];
}
