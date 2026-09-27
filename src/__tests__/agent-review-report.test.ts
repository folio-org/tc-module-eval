import { renderAgentReviewLines } from '../utils/agent-review-report';
import { CriterionAgentReviewResult } from '../types';

it.each([
  ['aligned_fact', 'Supported by evidence'],
  ['substantive_concern', 'Potential problem'],
  ['analyzer_limitation', 'Automated check limitation'],
  ['evidence_gap', 'Needs verification'],
  ['policy_question', 'TC interpretation needed']
] as const)('explains %s without exposing its identifier or changing structured data', (type, label) => {
  const review: CriterionAgentReviewResult = {
    available: true, criterionId: 'S010', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
    summary: 'Review', rationale: 'Read source', evidenceReferences: ['src/A.java'], warnings: [], errors: [],
    assessments: [{ technologyId: 'discovered:custom-client', type, summary: 'Connection bound unknown.\nCheck the caller.',
      evidenceReferences: ['src/A.java', 'test/B.java'] }]
  };
  const original = JSON.stringify(review);
  const lines = renderAgentReviewLines(review, { 'custom-client': 'Remote catalog' });
  expect(lines).toContain(`    - Remote catalog — ${label}:`);
  expect(lines).toContain('  - Recommendation: Reviewer judgment needed');
  expect(lines).toContain('      - Finding: Connection bound unknown. Check the caller.');
  expect(lines).toContain('        - test/B.java');
  expect(lines.join('\n')).not.toContain('discovered:');
  expect(lines.join('\n')).not.toContain(type);
  if (type === 'evidence_gap') expect(lines.join('\n')).toContain('not a demonstrated defect');
  expect(JSON.stringify(review)).toBe(original);
});
