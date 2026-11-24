import { AdministrativeEvaluator } from '../evaluators/shared/administrative-evaluator';
import { EvaluationStatus } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';

describe('A001 Product Council listing', () => {
  const evaluate = (existingModule: boolean) => new AdministrativeEvaluator('javascript')
    .evaluateCriterion('A001', '/unused', createEvaluationRun({ repositoryPath: '/unused', language: 'javascript', existingModule }));

  it('is not applicable to an existing module', async () => {
    expect(await evaluate(true)).toEqual({
      criterionId: 'A001',
      status: EvaluationStatus.NOT_APPLICABLE,
      evidence: 'A001 not applicable: A Product Council listing is required only of new modules, and this is an existing-module evaluation.',
      details: 'Evaluated as: an existing module (--existing-module)\nWhat to do: Nothing; the criterion does not apply to an existing module.'
    });
  });

  it('leaves a new module to the reviewer', async () => {
    expect(await evaluate(false)).toEqual({
      criterionId: 'A001',
      status: EvaluationStatus.MANUAL,
      evidence: 'Product Council approval verification requires manual review',
      details: 'This criterion requires manual evaluation by a human reviewer'
    });
  });
});
