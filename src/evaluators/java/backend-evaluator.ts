import { CriterionResult, EvaluationRun } from '../../types';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { evaluateB001, renderB001HumanDetails } from '../../utils/b001-descriptor-template';
import { getBackendEvidence } from '../../utils/backend-evidence';

/**
 * Evaluator for Backend criteria (B001-B016). B001 has automated logic; the others fall back to the catalog-defined
 * default result.
 */
export class BackendEvaluator extends CatalogSectionEvaluator {
  constructor() {
    super('Backend', 'java', {
      B001: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB001(repoPath, evaluationRun)
    });
  }

  private async evaluateB001(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B001', evaluationRun);
    // S002's generated descriptor, when S002 ran the build earlier in this evaluation; B001 does not start the build.
    const analysis = evaluateB001(await getBackendEvidence(run, repoPath), run.artifacts.moduleDescriptor);
    return {
      criterionId: 'B001',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB001HumanDetails(analysis),
      criterionDetails: analysis
    };
  }
}
