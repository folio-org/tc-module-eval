import semver from 'semver';
import { S012AnalysisResult, S012Finding, S012VersionCheck } from '../types';
import { reportPath, reportText } from './report-text';

const MAX_WARNING_PATHS = 5;
const ROLE_ORDER: Record<S012Finding['role'], number> = { primary: 0, secondary: 1, incidental: 2, coverage: 3 };
const COMPARISONS: Record<S012VersionCheck['comparison'], string> = {
  compliant: 'allowed',
  noncompliant: 'not allowed',
  overlap: 'allows both supported and unsupported versions',
  unresolved: 'could not be read as a version'
};

export function renderS012HumanDetails(analysis: S012AnalysisResult): string {
  const lines: string[] = [];
  const tools = analysis.findings.filter(finding => finding.role !== 'coverage')
    .sort((left, right) => ROLE_ORDER[left.role] - ROLE_ORDER[right.role]);
  if (tools.length) {
    lines.push('Build tools found:');
    for (const finding of tools) {
      if (finding.role === 'primary') {
        const files = finding.files.map(reportPath).join(', ');
        lines.push(`  - ${finding.displayName}: ${files || 'no build file'}${finding.via ? `; built by ${finding.via}` : ''}`);
        lines.push(`    - ${finding.rationale}`);
        // Without a version rule (Gradle, Make) versions are shown, not judged. A passing rationale already names
        // the versions that settle it, so only requirements (which do not pick a version) are listed below it.
        const judged = Boolean(finding.matchedPolicy?.constraint);
        const shown = finding.contribution === 'pass' ? finding.versions.filter(check => check.kind === 'requirement' || check.inactive) : finding.versions;
        for (const check of shown) lines.push(`    - ${versionLine(check, judged)}`);
      } else {
        lines.push(`  - ${finding.displayName}: ${finding.rationale}`);
      }
    }
  }
  const review = analysis.findings.filter(finding => finding.role === 'coverage');
  if (review.length) {
    lines.push('Needs review:');
    for (const finding of review) lines.push(`  - ${finding.rationale}`);
  }
  if (analysis.policyDiagnostics.length) {
    lines.push('Configuration problems:');
    for (const diagnostic of analysis.policyDiagnostics) lines.push(`  - ${reportText(diagnostic.message)}`);
  }
  lines.push(...warningLines(analysis.evidence.diagnostics));

  const policy = analysis.policy;
  if (policy) {
    const status = [policy.documentStatus, policy.exportDate && `exported ${policy.exportDate}`].filter(Boolean).join(', ');
    lines.push(`Policy: ${policy.title ?? 'Officially Supported Technologies'}${status ? ` (${status})` : ''}, ${policy.sourcePath}`);
  }
  const table = analysis.sharedWorkflowTable;
  if (table) {
    lines.push(`FOLIO shared workflows: folio-org/.github ${table.ref}, reviewed ${table.reviewedAt}, ${table.sourcePath}`);
  }
  return lines.join('\n');
}

function versionLine(check: S012VersionCheck, judged: boolean): string {
  const verdict = check.inactive
    ? ` - not applied (${reportText(check.inactive)}), so it does not count`
    : judged ? ` - ${COMPARISONS[check.comparison]}` : '';
  if (check.inherited) {
    const recorded = check.inherited.source ? ` (${check.inherited.source}, recorded ${check.inherited.recordedAt})` : '';
    return `Version from ${check.label}: ${check.text}${recorded}, not pinned in the repository${verdict}`;
  }
  // Wrappers name the version inside a download URL; show the version, then what was read.
  const exact = check.range && semver.valid(check.range) && check.range !== check.text.trim() ? check.range : undefined;
  const meaning = check.label === 'maven-enforcer-plugin requireMavenVersion' && check.range?.startsWith('>=') && !check.range.includes(' ')
    ? ` (means ${check.range.slice(2)} or later)`
    : check.label === 'yarn.lock format'
      ? { v1: ' (written by Yarn 1)', berry: ' (written by Yarn 2 or later)' }[check.text] ?? ''
      : exact ? ` (from ${reportText(check.text)})` : '';
  return `${check.label} in ${reportPath(check.path ?? '')}: ${exact ?? reportText(check.text)}${meaning}${verdict}`;
}

// Problems with the same message are merged into one row that lists every file.
function warningLines(diagnostics: S012AnalysisResult['evidence']['diagnostics']): string[] {
  if (!diagnostics.length) return [];
  const groups = new Map<string, string[]>();
  for (const diagnostic of diagnostics) {
    const message = reportText(diagnostic.message);
    const paths = groups.get(message) ?? [];
    if (diagnostic.path && !paths.includes(diagnostic.path)) paths.push(diagnostic.path);
    groups.set(message, paths);
  }
  return ['Warnings:', ...[...groups].map(([message, paths]) => {
    const shown = paths.slice(0, MAX_WARNING_PATHS).map(reportPath).join(', ');
    const more = paths.length > MAX_WARNING_PATHS ? ` and ${paths.length - MAX_WARNING_PATHS} more` : '';
    return `  - ${shown ? `${shown}${more}: ` : ''}${message}`;
  })];
}
