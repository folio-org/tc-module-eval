import { CriterionAgentReviewResult, S010Analysis, S010Finding } from '../types';
import { renderAgentReviewLines } from './agent-review-report';

export function renderS010HumanDetails(
  analysis: S010Analysis,
  agentReview?: CriterionAgentReviewResult
): string {
  const lines = [
    `Runtime kind: ${analysis.evidence.runtimeKind}`,
    `Repository kind: ${analysis.evidence.moduleKind.kind}`,
    `Discovery coverage: ${analysis.evidence.discoveryCoverage}`,
    `Semantic coverage: ${analysis.evidence.semanticCoverage}`
  ];
  const ordered = [...analysis.findings].sort((left, right) =>
    findingPriority(left) - findingPriority(right)
    || left.dependencyId.localeCompare(right.dependencyId)
    || left.id.localeCompare(right.id)
  );
  if (ordered.length) lines.push('Dependency observations (unresolved outcomes are scenarios requiring review, not confirmed defects):');
  for (const group of groupFindings(ordered)) {
    const finding = group[0];
    const subjects = [...new Set(group.map(item => findingSubject(item)).filter(Boolean))];
    lines.push(
      `  - ${finding.dependencyId}${subjects.length ? ` (${subjects.join(', ')})` : ''}${finding.scenario ? ` / ${finding.scenario}` : ''}: ${finding.outcome}`,
      `    - ${finding.rationale}`,
      `    - Status determining: ${finding.statusDetermining ? 'yes' : 'no'}`
    );
    for (const evidence of group.flatMap(item => item.evidence)) {
      lines.push(`    - Evidence: ${evidence.path}${evidence.line ? `:${evidence.line}` : ''} — ${evidence.detail}`);
    }
  }
  if (analysis.diagnostics.length) lines.push('Diagnostics:');
  for (const diagnostic of analysis.diagnostics) {
    lines.push(`  - ${diagnostic.path ? `${diagnostic.path} — ` : ''}${diagnostic.message}`);
  }
  if (agentReview?.available) {
    lines.push(...renderAgentReviewLines(agentReview));
    lines.push('  - Deterministic result remains Manual review.');
  } else if (analysis.agentReviewUnavailableReason) {
    lines.push('Agent review:', `  - Not applied: ${analysis.agentReviewUnavailableReason}`);
  }
  return lines.join('\n');
}

// Finding ids look like `dependency:subject/scenario`; the subject (config key, file, or
// interface) is what tells otherwise identical scenario rows apart.
function findingSubject(finding: S010Finding): string {
  const subject = finding.id.match(/^[^:/]+:(.+)\/[^/]+$/)?.[1];
  return subject ?? '';
}

function groupFindings(findings: S010Finding[]): S010Finding[][] {
  const groups = new Map<string, S010Finding[]>();
  for (const finding of findings) {
    const key = JSON.stringify([
      finding.dependencyId, finding.scenario, finding.outcome, finding.rationale, finding.statusDetermining
    ]);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }
  return [...groups.values()];
}

function findingPriority(finding: S010Finding): number {
  if (finding.statusDetermining) return 0;
  if (finding.outcome === 'unresolved') return 1;
  return 2;
}
