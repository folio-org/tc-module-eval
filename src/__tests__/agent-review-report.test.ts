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

it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('renders prototype-property subject %s as text', id => {
  const review: CriterionAgentReviewResult = {
    available: true, criterionId: 'S010', recommendation: 'likely_sufficient', confidence: 'medium',
    summary: 'Review', rationale: 'Read source', evidenceReferences: ['src/A.java'], warnings: [], errors: [],
    assessments: [{ technologyId: `discovered:${id}`, type: 'aligned_fact', summary: 'Observed source.', evidenceReferences: ['src/A.java'] }]
  };
  expect(renderAgentReviewLines(review)).toContain(`    - ${id.replace(/[-_]/g, ' ').trim()} — Supported by evidence:`);
  expect(renderAgentReviewLines(review, Object.fromEntries([[id, 'Explicit subject']]))).toContain('    - Explicit subject — Supported by evidence:');
});

it('renders scoped coverage and phase-level uncertainty without internal enum labels', () => {
  const review: CriterionAgentReviewResult = {
    available: true, criterionId: 'S006', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
    summary: 'More evidence needed.', rationale: 'Inspected source.', evidenceReferences: ['src/A.java'], warnings: [], errors: [],
    assessments: [{ technologyId: 'scope', type: 'evidence_gap', summary: 'Partial review.',
      coverageDisposition: 'unresolved', evidenceReferences: ['src/A.java'],
      failureBounds: [{ phase: 'tenant_initialization', requirement: 'required', status: 'unverified',
        explanation: 'Admin timeout is unknown.', evidenceReferences: ['src/A.java'] }] }]
  };
  const text = renderAgentReviewLines(review).join('\n');
  expect(text).toContain('not a repository-wide certification');
  expect(text).toContain('Coverage judgment: Needs further verification');
  expect(text).toContain('Tenant initialization — Bound needs verification');
  expect(text).toContain('Admin timeout is unknown.');
  expect(text).not.toContain('tenant_initialization');
});
