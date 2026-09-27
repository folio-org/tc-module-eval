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
  if (ordered.length) lines.push('Dependency scenarios:');
  for (const finding of ordered) {
    lines.push(
      `  - ${finding.dependencyId}${findingSubject(finding)}${finding.scenario ? ` / ${finding.scenario}` : ''}: ${finding.outcome}`,
      `    - ${finding.rationale}`,
      `    - Status determining: ${finding.statusDetermining ? 'yes' : 'no'}`
    );
    for (const evidence of finding.evidence) {
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
  return subject ? ` (${subject})` : '';
}

function findingPriority(finding: S010Finding): number {
  if (finding.statusDetermining) return 0;
  if (finding.outcome === 'unresolved') return 1;
  return 2;
}
