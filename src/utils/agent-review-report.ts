import { CriterionAgentReviewResult } from '../types';

const ASSESSMENT_LABELS = {
  aligned_fact: ['Supported by evidence', 'The reviewed source supports this finding; this is not a certification of the whole criterion.'],
  substantive_concern: ['Potential problem', 'The reviewed source indicates a possible problem. Confirm its impact before making a decision.'],
  analyzer_limitation: ['Automated check limitation', 'The automated check could not establish this behavior. That limitation is not itself a defect.'],
  evidence_gap: ['Needs verification', 'Available evidence does not establish the behavior. This is an unanswered question, not a demonstrated defect.'],
  policy_question: ['TC interpretation needed', 'A Technical Council interpretation is needed to decide how the criterion applies.']
} as const;

const SUBJECT_NAMES: Record<string, string> = {
  search: 'Search service', kafka: 'Kafka', database: 'Database',
  'object-storage': 'Object storage', okapi: 'Okapi', java: 'Java',
  'spring-boot': 'Spring Boot', lombok: 'Lombok'
};

// Details use indentation as structure. Model-authored newlines must stay prose.
function prose(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function renderAgentReviewLines(
  review: CriterionAgentReviewResult,
  subjectNames: Record<string, string> = {}
): string[] {
  const recommendations = {
    likely_sufficient: 'Likely sufficient',
    likely_insufficient: 'Likely insufficient',
    needs_reviewer_judgment: 'Reviewer judgment needed'
  };
  const lines = [
    'Agent review (advisory):',
    `  - Recommendation: ${review.recommendation ? recommendations[review.recommendation] : 'Unavailable'}`,
    `  - Confidence: ${review.confidence}`,
    `  - Summary: ${prose(review.summary)}`,
    `  - Rationale: ${prose(review.rationale)}`
  ];
  if (review.assessments?.length) {
    lines.push('  - Findings:');
    for (const assessment of review.assessments) {
      const id = assessment.technologyId.replace(/^discovered:/, '');
      const name = subjectNames[id] ?? SUBJECT_NAMES[id] ?? id.replace(/[-_]/g, ' ');
      const [label, explanation] = ASSESSMENT_LABELS[assessment.type];
      lines.push(
        `    - ${prose(name)} — ${label}:`,
        `      - ${explanation}`,
        `      - Finding: ${prose(assessment.summary)}`,
        '      - Sources:',
        ...assessment.evidenceReferences.map(reference => `        - ${prose(reference)}`)
      );
    }
  }
  if (review.reviewerActions?.length) {
    lines.push('  - What to verify:');
    for (const action of review.reviewerActions) {
      lines.push(
        `    - ${prose(action.action)}`,
        '      - Sources:',
        ...action.evidenceReferences.map(reference => `        - ${prose(reference)}`)
      );
    }
  }
  if (review.evidenceReferences.length) {
    lines.push('  - Sources:', ...review.evidenceReferences.map(reference => `    - ${prose(reference)}`));
  }
  return lines;
}
