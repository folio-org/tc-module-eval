import { CriterionResult, EvaluationRun } from '../../types';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { evaluateB001, renderB001HumanDetails } from '../../utils/b001-descriptor-template';
import { evaluateB003, renderB003HumanDetails } from '../../utils/b003-endpoint-implementations';
import { evaluateB006, renderB006HumanDetails } from '../../utils/b006-api-documentation';
import { getBackendApiSpecs } from '../../utils/backend-api-specs';
import { getBackendEvidence } from '../../utils/backend-evidence';

/**
 * Evaluator for Backend criteria (B001-B016). B001, B003 and B006 have automated logic; the others fall back to the
 * catalog-defined default result.
 */
export class BackendEvaluator extends CatalogSectionEvaluator {
  constructor() {
    super('Backend', 'java', {
      B001: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB001(repoPath, evaluationRun),
      B003: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB003(repoPath, evaluationRun),
      B006: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB006(repoPath, evaluationRun)
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
}
