import { CriterionAgentReviewResult, CriterionAgentUsage } from '../types';
import { S006_FINDING_SUMMARY_PATH } from './criterion-agent-review';
import { reportPath, reportText } from './report-text';

export const ASSESSMENT_LABELS = {
  aligned_fact: ['Supported by evidence', 'The reviewed source supports this finding; this is not a certification of the whole criterion.'],
  substantive_concern: ['Potential problem', 'The reviewed source indicates a possible problem. Confirm its impact before making a decision.'],
  analyzer_limitation: ['Automated check limitation', 'The automated check could not establish this behavior. That limitation is not itself a defect.'],
  evidence_gap: ['Needs verification', 'Available evidence does not establish the behavior. This is an unanswered question, not a demonstrated defect.'],
  policy_question: ['TC interpretation needed', 'A Technical Council interpretation is needed to decide how the criterion applies.']
} as const;

export const RECOMMENDATION_LABELS = {
  likely_sufficient: 'Likely sufficient',
  likely_insufficient: 'Likely insufficient',
  needs_reviewer_judgment: 'Reviewer judgment needed'
} as const;

export const COVERAGE_LABELS = {
  investigated: 'Investigated directly',
  immaterial: 'Not material to this scoped decision',
  unresolved: 'Needs further verification'
} as const;

const SUBJECT_NAMES: Record<string, string> = {
  search: 'Search service', kafka: 'Kafka', database: 'Database',
  'object-storage': 'Object storage', okapi: 'Okapi', java: 'Java',
  'folio-interfaces': 'FOLIO interfaces',
  'spring-boot': 'Spring Boot', lombok: 'Lombok'
};

/** One review's OpenCode usage, such as "$0.0089 (11 model steps in 36.5 s)". */
export function agentReviewUsageText(usage: CriterionAgentUsage): string {
  const steps = `${usage.modelSteps} model ${usage.modelSteps === 1 ? 'step' : 'steps'} in ${(usage.durationMs / 1000).toFixed(1)} s`;
  return usage.costUsd === undefined ? `not reported (${steps})` : `$${usage.costUsd.toFixed(4)} (${steps})`;
}

/** The run's agent review cost: the sum over the reviews whose cost was reported, and how many reviews ran. */
export function agentReviewRunCost(reviews: Array<CriterionAgentReviewResult | undefined>): { costUsd: number; reviews: number; unpriced: number } | undefined {
  const usages = reviews.flatMap(review => review?.metadata?.usage ? [review.metadata.usage] : []);
  if (!usages.length) return undefined;
  return {
    costUsd: usages.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0),
    reviews: usages.length,
    unpriced: usages.filter(usage => usage.costUsd === undefined).length
  };
}

// Details use indentation as structure. Model-authored newlines must stay prose.
export function prose(value: string | undefined): string {
  return reportText((value ?? '').replace(/\s+/g, ' ').trim());
}

export function renderAgentReviewLines(
  review: CriterionAgentReviewResult,
  subjectNames: Record<string, string> = {}
): string[] {
  const lines = [
    'Agent review (advisory):',
    `  - Recommendation: ${review.recommendation ? RECOMMENDATION_LABELS[review.recommendation] : 'Unavailable'}`,
    `  - Confidence: ${review.confidence}`,
    `  - Summary: ${prose(review.summary)}`,
    `  - Rationale: ${prose(review.rationale)}`
  ];
  if (review.criterionId === 'S006') {
    lines.push('  - Scope: Advice covers the findings and source investigated below; it is not a repository-wide certification that secrets are absent.');
  }
  if (review.assessments?.length) {
    lines.push('  - Findings:');
    for (const assessment of review.assessments) {
      const id = assessment.technologyId.replace(/^discovered:/, '');
      const name = Object.prototype.hasOwnProperty.call(subjectNames, id) ? subjectNames[id]
        : Object.prototype.hasOwnProperty.call(SUBJECT_NAMES, id) ? SUBJECT_NAMES[id]
          : id === 'scope' ? 'Review scope'
            : /^finding:\d+$/.test(id) ? `Scanner finding ${Number(id.slice(8)) + 1}`
              : id.startsWith('gap:') ? `Coverage: ${id.slice(4)}` : id.replace(/[-_]/g, ' ');
      const [label, explanation] = ASSESSMENT_LABELS[assessment.type];
      lines.push(
        `    - ${prose(name)} — ${label}:`,
        `      - ${explanation}`,
        `      - Finding: ${prose(assessment.summary)}`,
        '      - Sources:',
        ...assessment.evidenceReferences.map(reference => `        - ${reference === S006_FINDING_SUMMARY_PATH
          ? 'Automated scan coverage diagnostics' : reportPath(reference)}`)
      );
      if (assessment.coverageDisposition) {
        lines.push(`      - Coverage judgment: ${COVERAGE_LABELS[assessment.coverageDisposition]}`);
      }
      for (const bound of assessment.failureBounds ?? []) {
        const phases = { startup: 'Process startup', tenant_initialization: 'Tenant initialization', runtime: 'Runtime operations' };
        const statuses = { established: 'Bound supported by evidence', unverified: 'Bound needs verification', not_applicable: 'Not used in this phase' };
        lines.push(`      - ${phases[bound.phase]} — ${statuses[bound.status]}:`,
          `        - Dependency role: ${bound.requirement}`,
          `        - ${prose(bound.explanation)}`,
          '        - Sources:', ...bound.evidenceReferences.map(reference => `          - ${reportPath(reference)}`));
      }
    }
  }
  if (review.reviewerActions?.length) {
    lines.push('  - What to verify:');
    for (const action of review.reviewerActions) {
      lines.push(
        `    - ${prose(action.action)}`,
        '      - Sources:',
        ...action.evidenceReferences.map(reference => `        - ${reportPath(reference)}`)
      );
    }
  }
  if (review.droppedItems?.length) {
    lines.push('  - Dropped from this review:', ...review.droppedItems.map(item => `    - ${item.kind === 'evidence_references' ? 'The review\'s own sources'
      : item.kind === 'reviewer_action' ? 'A reviewer action'
        : !item.technologyId ? 'A result without an ID' : `A result for ${reportText(item.technologyId)}`}: ${reportText(item.reason)}`));
  }
  if (review.evidenceReferences.length) {
    lines.push('  - Sources:', ...review.evidenceReferences.map(reference => `    - ${reportPath(reference)}`));
  }
  return lines;
}
