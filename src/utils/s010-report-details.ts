import { CriterionAgentReviewResult, S010Analysis, S010Finding } from '../types';
import { redactJsonValue, redactSensitiveText } from './redaction';

export function buildS010CriterionDetails(analysis: S010Analysis): S010Analysis {
  return redactJsonValue(analysis);
}

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
  const ordered = [...analysis.findings].sort((left, right) => findingPriority(left) - findingPriority(right));
  if (ordered.length) lines.push('Dependency scenarios:');
  for (const finding of ordered) {
    lines.push(
      `  - ${finding.dependencyId}${finding.scenario ? ` / ${finding.scenario}` : ''}: ${finding.outcome}`,
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
    lines.push(
      'Agent review (advisory):',
      `  - Recommendation: ${agentReview.recommendation}`,
      `  - Confidence: ${agentReview.confidence}`,
      `  - Summary: ${agentReview.summary}`,
      `  - Rationale: ${agentReview.rationale}`
    );
    for (const assessment of agentReview.assessments ?? []) {
      lines.push(`  - Assessment (${assessment.technologyId}/${assessment.type}): ${assessment.summary}`);
      lines.push(`    - Evidence: ${assessment.evidenceReferences.join(', ')}`);
    }
    for (const action of agentReview.reviewerActions ?? []) {
      lines.push(`  - Reviewer action: ${action.action}`);
      lines.push(`    - Evidence: ${action.evidenceReferences.join(', ')}`);
    }
    lines.push('  - Deterministic S010 status remains MANUAL.');
  } else if (analysis.agentReviewUnavailableReason) {
    lines.push('Agent review:', `  - Not applied: ${analysis.agentReviewUnavailableReason}`);
  }
  return redactSensitiveText(lines.join('\n'));
}

function findingPriority(finding: S010Finding): number {
  if (finding.statusDetermining) return 0;
  if (finding.outcome === 'unresolved') return 1;
  return 2;
}
