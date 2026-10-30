import { CriterionResult, EvaluationRun, EvaluationStatus } from '../../types';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { evaluateB001, renderB001HumanDetails } from '../../utils/b001-descriptor-template';
import { evaluateB003, renderB003HumanDetails } from '../../utils/b003-endpoint-implementations';
import { evaluateB005, renderB005HumanDetails } from '../../utils/b005-interface-naming';
import { evaluateB006, renderB006HumanDetails } from '../../utils/b006-api-documentation';
import { b007Implementations, hasB007AgentReviewMaterial, reviewB007WithAgent } from '../../utils/b007-agent-review';
import { evaluateB007, renderB007HumanDetails } from '../../utils/b007-endpoint-permissions';
import { evaluateB014, renderB014HumanDetails } from '../../utils/b014-health-check';
import { getBackendApiSpecs } from '../../utils/backend-api-specs';
import { getBackendEvidence } from '../../utils/backend-evidence';
import { reviewCriterionWithAgent } from '../../utils/criterion-agent-review';

/**
 * Evaluator for Backend criteria (B001-B016). B001, B003, B005, B006, B007 and B014 have automated logic; the others fall back to the
 * catalog-defined default result.
 */
export class BackendEvaluator extends CatalogSectionEvaluator {
  constructor() {
    super('Backend', 'java', {
      B001: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB001(repoPath, evaluationRun),
      B003: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB003(repoPath, evaluationRun),
      B005: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB005(repoPath, evaluationRun),
      B006: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB006(repoPath, evaluationRun),
      B007: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB007(repoPath, evaluationRun),
      B014: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB014(repoPath, evaluationRun)
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

  private async evaluateB003(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B003', evaluationRun);
    const analysis = evaluateB003(await getBackendEvidence(run, repoPath), await getBackendApiSpecs(run, repoPath));
    return {
      criterionId: 'B003',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB003HumanDetails(analysis),
      criterionDetails: analysis
    };
  }

  private async evaluateB005(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B005', evaluationRun);
    const analysis = evaluateB005(await getBackendEvidence(run, repoPath), run.existingModule);
    return {
      criterionId: 'B005',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB005HumanDetails(analysis),
      criterionDetails: analysis
    };
  }

  private async evaluateB006(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B006', evaluationRun);
    const analysis = evaluateB006(await getBackendEvidence(run, repoPath), await getBackendApiSpecs(run, repoPath), run.existingModule);
    return {
      criterionId: 'B006',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB006HumanDetails(analysis),
      criterionDetails: analysis
    };
  }

  private async evaluateB007(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B007', evaluationRun);
    const evidence = await getBackendEvidence(run, repoPath);
    const analysis = evaluateB007(evidence);
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'B007',
      status: analysis.status,
      hasReviewMaterial: hasB007AgentReviewMaterial(analysis),
      notRunReason: 'the tool read no endpoints for the agent to review',
      evaluationRun: run,
      review: async (config, commandRunner) => reviewB007WithAgent(repoPath, analysis,
        b007Implementations(evaluateB003(evidence, await getBackendApiSpecs(run, repoPath))), config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    else if (analysis.status === EvaluationStatus.FAIL && run.agentReview?.enabled) {
      analysis.agentReviewUnavailableReason = 'agent review runs only for manual results; each *.all or undefined permission an endpoint requires must be replaced first';
    }
    return {
      criterionId: 'B007',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB007HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
    };
  }

  private async evaluateB014(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B014', evaluationRun);
    const analysis = evaluateB014(await getBackendEvidence(run, repoPath));
    return {
      criterionId: 'B014',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB014HumanDetails(analysis),
      criterionDetails: analysis
    };
  }
}
