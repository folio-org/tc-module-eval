import { CriterionResult, EvaluationRun } from '../../types';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { evaluateF005, renderF005HumanDetails } from '../../utils/f005-stripes-version';
import { getModuleKind } from '../../utils/module-kind';
import { getS007Analysis } from '../../utils/s007-evaluator';

/**
 * Evaluator for Frontend criteria (F001-F007). F005 has automated logic; the others fall back to the
 * catalog-defined default result.
 */
export class FrontendEvaluator extends CatalogSectionEvaluator {
  constructor() {
    super('Frontend', 'javascript', {
      F005: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateF005(repoPath, evaluationRun)
    });
  }

  private async evaluateF005(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'F005', evaluationRun);
    const [s007, moduleKind] = await Promise.all([getS007Analysis(run, repoPath), getModuleKind(run, repoPath)]);
    const analysis = evaluateF005(s007, moduleKind, repoPath);
    return {
      criterionId: 'F005',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderF005HumanDetails(analysis),
      criterionDetails: analysis
    };
  }
}
