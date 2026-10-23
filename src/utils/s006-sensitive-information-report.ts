import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  S006FindingContext,
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
import { reportPath, reportText } from './report-text';
import {
  S006_CATEGORY_LABELS,
  S006_CONTEXT_LABELS_PLAIN,
  S006_DETECTOR_TAGS,
  S006_SKIPPED_REASON_LABELS,
  s006AssignedName
} from './s006-report-details';
import { MAX_S006_SCAN_BYTES_PER_FILE } from './s006-scanner';

const MAX_REPORT_LIST_ITEMS = 8;

export function formatS006Evidence(
  analysis: S006SensitiveInformationAnalysisResult,
  agentReview?: CriterionAgentReviewResult
): { evidence: string; details: string } {
  const failFindings = analysis.findings.filter(finding => finding.statusImpact === 'deterministic_fail');
  const strongestFindings = strongestS006ReportFindings(analysis.findings, MAX_REPORT_LIST_ITEMS);
  const lines: Array<string | undefined> = [
    ...formatWhatToDoLines(analysis, failFindings.length),
    'Findings:',
    `  - Values that fail S006: ${failFindings.length}`,
    `  - Values to check: ${analysis.findings.length - failFindings.length}`,
    ...formatFindingGroupLines(analysis.findings),
    '',
    ...(strongestFindings.length ? [
      'Strongest examples (values hidden):',
      ...formatExampleLines(strongestFindings),
      ...overflowLine(analysis.findings.length, strongestFindings.length, '  '),
      ''
    ] : []),
    'Coverage:',
    `  - Gitleaks: ${formatScannerSummary(analysis)}`,
    analysis.scanner.ignoreFilePresent
      ? '  - Note: the repository has a .gitleaksignore file, which tells Gitleaks to skip the findings it lists. Check that it does not hide a real secret.'
      : undefined,
    `  - Built-in scan: read ${analysis.coverage.scannedFiles} of ${analysis.coverage.candidateFiles} file${analysis.coverage.candidateFiles === 1 ? '' : 's'} (${formatKilobytes(analysis.coverage.scannedBytes)} read)`,
    `  - Complete: ${analysis.coverage.complete ? 'yes' : analysis.coverage.materiallyWeakened ? 'no, see Coverage gaps' : 'no, but nothing left out affects the result; see Skipped'}`,
    ...formatCoverageGapLines(analysis),
    ...formatOtherLimitLines(analysis)
  ];

  appendAgentReviewLines(lines, analysis, agentReview);

  return {
    evidence: truncateToByteBudget(`S006 ${analysis.classification.status}: ${analysis.classification.reason}`, 700),
    details: truncateToByteBudget(lines.filter((line): line is string => line !== undefined).join('\n'), 12_000)
  };
}

function formatWhatToDoLines(analysis: S006SensitiveInformationAnalysisResult, failCount: number): string[] {
  const findings = analysis.findings;
  const lines: string[] = [];
  if (failCount > 0) {
    lines.push('  - Remove the values marked "Fails S006" from the repository, load them from environment variables or a secret store, and replace each one, because the old value stays in the Git history.');
  }
  if (findings.some(finding => finding.context === 'ci_or_deployment_configuration')) {
    lines.push('  - In CI and deployment files, read secrets from the CI secret store (for example ${{ secrets.NAME }}) instead of writing the value.');
  }
  if (findings.some(finding => finding.statusImpact !== 'deterministic_fail' && isSecretCategory(finding))) {
    lines.push('  - Open each possible secret and decide whether it is real. Made-up values in tests, documentation, and examples are fine.');
  }
  if (findings.some(finding => finding.category === 'tenant_or_host_endpoint' || finding.category === 'private_url')) {
    lines.push('  - Check that the host names and network addresses are public or local examples, not details of a real deployment.');
  }
  if (findings.some(finding => finding.context === 'local_docker_defaults')) {
    lines.push('  - Check that local Docker defaults are used only for local development.');
  }
  if (analysis.coverage.materiallyWeakened) {
    lines.push('  - Check the files under Coverage gaps, which were not fully scanned.');
  }
  return lines.length ? ['What to do:', ...lines, ''] : [];
}

function isSecretCategory(finding: S006SensitiveInformationFinding): boolean {
  return finding.category !== 'tenant_or_host_endpoint' &&
    finding.category !== 'private_url' &&
    finding.category !== 'local_absolute_path';
}

function formatScannerSummary(analysis: S006SensitiveInformationAnalysisResult): string {
  if (analysis.scanner.status !== 'completed') {
    return 'did not run, see Coverage gaps';
  }
  const count = analysis.scanner.findingCount;
  return `ran and reported ${count} possible secret${count === 1 ? '' : 's'}`;
}

function formatFindingGroupLines(findings: S006SensitiveInformationFinding[]): string[] {
  if (!findings.length) {
    return [];
  }

  const groups = new Map<string, {
    count: number;
    context: S006FindingContext;
    category: S006SensitiveInformationFinding['category'];
    severityRank: number;
    confidenceRank: number;
  }>();

  for (const finding of findings) {
    const key = `${finding.context}\0${finding.category}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.severityRank = Math.min(existing.severityRank, rankS006Severity(finding.severity));
      existing.confidenceRank = Math.min(existing.confidenceRank, rankS006Confidence(finding.confidence));
    } else {
      groups.set(key, {
        count: 1,
        context: finding.context,
        category: finding.category,
        severityRank: rankS006Severity(finding.severity),
        confidenceRank: rankS006Confidence(finding.confidence)
      });
    }
  }

  const sorted = [...groups.values()]
    .sort((left, right) =>
      left.severityRank - right.severityRank ||
      left.confidenceRank - right.confidenceRank ||
      rankS006Context(left.context) - rankS006Context(right.context) ||
      right.count - left.count ||
      left.category.localeCompare(right.category)
    );
  return [
    '  - By type:',
    ...sorted.slice(0, MAX_REPORT_LIST_ITEMS).map(group => {
      const label = S006_CATEGORY_LABELS[group.category];
      return `    - ${group.count} ${group.count === 1 ? label.one : label.many} in ${S006_CONTEXT_LABELS_PLAIN[group.context]}`;
    }),
    ...overflowLine(sorted.length, MAX_REPORT_LIST_ITEMS, '    ')
  ];
}

function formatExampleLines(findings: S006SensitiveInformationFinding[]): string[] {
  return findings.map(finding => {
    const location = `${reportPath(finding.path)}${finding.line === undefined ? '' : `:${finding.line}`}`;
    const lineRange = finding.endLine && finding.line !== undefined && finding.endLine !== finding.line ? `-${finding.endLine}` : '';
    const label = S006_CATEGORY_LABELS[finding.category].one;
    const name = s006AssignedName(finding);
    const where = `${name ? `assigned to ${reportText(name)} ` : ''}in ${S006_CONTEXT_LABELS_PLAIN[finding.context]}`;
    const foundByBoth = finding.detectedBy.length > 1 ? ', found by both Gitleaks and the built-in scan' : '';
    const description = finding.statusImpact === 'deterministic_fail'
      ? `Fails S006: ${label} that looks real, ${where}${foundByBoth}`
      : `${capitalize(label)} ${where}${VALUE_NOTES[finding.valueClassification]}${foundByBoth}`;
    return `  - ${location}${lineRange} [${S006_DETECTOR_TAGS[finding.detectorId]}] ${description}`;
  });
}

const VALUE_NOTES: Record<S006SensitiveInformationFinding['valueClassification'], string> = {
  placeholder: ', placeholder value',
  synthetic: ', looks like a test or example value',
  'live-looking': ''
};

function formatCoverageGapLines(analysis: S006SensitiveInformationAnalysisResult): string[] {
  const rows = coverageRows(
    analysis.coverage.warnings.filter(warning => warning.materialToCoverage),
    analysis.coverage.skippedFiles.filter(skippedFile => skippedFile.materialToCoverage)
  );
  return rows.length ? ['', 'Coverage gaps:', ...rows] : [];
}

function formatOtherLimitLines(analysis: S006SensitiveInformationAnalysisResult): string[] {
  const rows = coverageRows(
    analysis.coverage.warnings.filter(warning => !warning.materialToCoverage),
    analysis.coverage.skippedFiles.filter(skippedFile => !skippedFile.materialToCoverage)
  );
  return rows.length ? ['', 'Skipped (does not affect the result):', ...rows] : [];
}

// A file that was skipped and also warned about appears once; files skipped for the same reason share one row.
function coverageRows(warnings: S006ScanWarning[], skippedFiles: S006SkippedFile[]): string[] {
  const skippedPaths = new Set(skippedFiles.map(skippedFile => skippedFile.path));
  const rows: string[] = [];
  const pathWarnings = new Map<string, string[]>();
  for (const warning of warnings) {
    if (warning.path && skippedPaths.has(warning.path)) {
      continue;
    }
    if (warning.path && (warning.kind === 'file-truncated' || warning.kind === 'unreadable-file')) {
      const heading = warning.kind === 'file-truncated'
        ? `Files only partly read (at most ${formatKilobytes(MAX_S006_SCAN_BYTES_PER_FILE)} of each)`
        : 'Files or folders that could not be read';
      pathWarnings.set(heading, [...(pathWarnings.get(heading) ?? []), warning.path]);
      continue;
    }
    rows.push(`  - ${reportText(warning.message)}`);
  }

  const skippedByReason = new Map<string, string[]>();
  for (const skippedFile of skippedFiles) {
    // Only symbolic links are unsupported without being material; material ones sit in high-signal folders.
    const heading = skippedFile.reason !== 'unsupported-file'
      ? S006_SKIPPED_REASON_LABELS[skippedFile.reason]
      : skippedFile.materialToCoverage
        ? 'Files of a type the built-in scan does not read, in folders where secrets are often kept'
        : 'Symbolic links, which are not followed';
    skippedByReason.set(heading, [...(skippedByReason.get(heading) ?? []), skippedFile.path]);
  }

  for (const [heading, paths] of [...pathWarnings, ...skippedByReason]) {
    rows.push(
      `  - ${heading}:`,
      ...paths.slice(0, MAX_REPORT_LIST_ITEMS).map(filePath => `    - ${reportPath(filePath)}`),
      ...overflowLine(paths.length, MAX_REPORT_LIST_ITEMS, '    ')
    );
  }
  return rows;
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
      agentReview.summary ? `  - Summary: ${reportText(redactSensitiveText(agentReview.summary))}` : undefined,
      agentReview.rationale ? `  - Rationale: ${reportText(redactSensitiveText(agentReview.rationale))}` : undefined,
      agentReview.warnings.length ? `  - Warnings: ${reportText(redactSensitiveText(agentReview.warnings.join('; ')))}` : undefined,
      agentReview.errors.length ? `  - Errors: ${reportText(redactSensitiveText(agentReview.errors.join('; ')))}` : undefined,
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
    `  - Not applied: ${reportText(analysis.agentReviewUnavailableReason ?? 'agent review is disabled or unconfigured')}`
  );
}

function formatKilobytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function overflowLine(total: number, visible: number, indent: string): string[] {
  return total > visible ? [`${indent}- ... ${total - visible} more`] : [];
}
