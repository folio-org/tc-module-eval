import { CriterionResult, EvaluationRun } from '../../types';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { reviewCriterionWithAgent } from '../../utils/criterion-agent-review';
import { hasF003AgentReviewMaterial, reviewF003WithAgent } from '../../utils/f003-agent-review';
import { evaluateF003, renderF003HumanDetails } from '../../utils/f003-internationalization';
import { evaluateF005, renderF005HumanDetails } from '../../utils/f005-stripes-version';
import { getFrontendSource } from '../../utils/frontend-source';
import { getModuleKind } from '../../utils/module-kind';
import { getS007Analysis } from '../../utils/s007-evaluator';

/**
 * Evaluator for Frontend criteria (F001-F007). F003 and F005 have automated logic; the others fall back to the
 * catalog-defined default result.
 */
export class FrontendEvaluator extends CatalogSectionEvaluator {
  constructor() {
    super('Frontend', 'javascript', {
      F003: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateF003(repoPath, evaluationRun),
      F005: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateF005(repoPath, evaluationRun)
    });
  }

  private async evaluateF003(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'F003', evaluationRun);
    const analysis = evaluateF003(await getFrontendSource(run, repoPath));
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'F003',
      status: analysis.status,
      hasReviewMaterial: hasF003AgentReviewMaterial(analysis),
      evaluationRun: run,
      review: (config, commandRunner) => reviewF003WithAgent(repoPath, analysis, config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    return {
      criterionId: 'F003',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderF003HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
    };
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
