import { citedTrackedFiles } from '../module-evaluator';
import { EvaluationStatus } from '../types';

describe('citedTrackedFiles', () => {
  it('uses only explicit structured source references, not incidental report prose', () => {
    const criteria = [{
      criterionId: 'S004',
      status: EvaluationStatus.MANUAL,
      evidence: 'README.md and LICENSE are files commonly found in repositories.',
      details: 'See README.md for narrative context.',
      criterionDetails: {
        candidates: [{ path: 'docs/install.md', signals: [] }]
      },
      agentReview: {
        available: true,
        criterionId: 'S004',
        recommendation: 'needs_reviewer_judgment' as const,
        evidenceReferences: ['src/Main.java'],
        warnings: [],
        errors: []
      }
    }];

    expect(citedTrackedFiles(
      criteria,
      ['LICENSE', 'README.md', 'docs/install.md', 'src/Main.java']
    )).toEqual(['docs/install.md', 'src/Main.java']);
  });
});
