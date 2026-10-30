import { CriterionResult, EvaluationRun, EvaluationStatus } from '../../types';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { evaluateB001, renderB001HumanDetails } from '../../utils/b001-descriptor-template';
import { hasB002AgentReviewMaterial, reviewB002WithAgent } from '../../utils/b002-agent-review';
import { evaluateB002, renderB002HumanDetails } from '../../utils/b002-consumed-apis';
import { evaluateB003, renderB003HumanDetails } from '../../utils/b003-endpoint-implementations';
import { hasB004AgentReviewMaterial, reviewB004WithAgent } from '../../utils/b004-agent-review';
import { B004Policy, evaluateB004, loadB004Policy, renderB004HumanDetails } from '../../utils/b004-env-variables';
import { evaluateB005, renderB005HumanDetails } from '../../utils/b005-interface-naming';
import { evaluateB006, renderB006HumanDetails } from '../../utils/b006-api-documentation';
import { b007Implementations, hasB007AgentReviewMaterial, reviewB007WithAgent } from '../../utils/b007-agent-review';
import { analyzeB009, renderB009HumanDetails } from '../../utils/b009-api-tests';
import { evaluateB007, renderB007HumanDetails } from '../../utils/b007-endpoint-permissions';
import { hasB008AgentReviewMaterial, reviewB008WithAgent } from '../../utils/b008-agent-review';
import { evaluateB008, renderB008HumanDetails } from '../../utils/b008-reference-data';
import { hasB010AgentReviewMaterial, reviewB010WithAgent } from '../../utils/b010-agent-review';
import { evaluateB010, renderB010HumanDetails } from '../../utils/b010-tenant-segregation';
import { hasB011AgentReviewMaterial, reviewB011WithAgent } from '../../utils/b011-agent-review';
import { evaluateB011, renderB011HumanDetails } from '../../utils/b011-schema-access';
import { hasB012AgentReviewMaterial, reviewB012WithAgent } from '../../utils/b012-agent-review';
import { evaluateB012, renderB012HumanDetails } from '../../utils/b012-readme-dependencies';
import { hasB013AgentReviewMaterial, reviewB013WithAgent } from '../../utils/b013-agent-review';
import { evaluateB013, renderB013HumanDetails } from '../../utils/b013-tenant-selection';
import { evaluateB014, renderB014HumanDetails } from '../../utils/b014-health-check';
import { evaluateB015, renderB015HumanDetails } from '../../utils/b015-high-availability';
import { evaluateB016, renderB016HumanDetails } from '../../utils/b016-supported-infrastructure';
import { getBackendApiSpecs } from '../../utils/backend-api-specs';
import { getBackendEvidence } from '../../utils/backend-evidence';
import { getBackendInfrastructure } from '../../utils/backend-infrastructure';
import { reviewCriterionWithAgent } from '../../utils/criterion-agent-review';
import { loadF001HandlerIndex } from '../../utils/f001-consumed-apis';
import { loadS007Policy } from '../../utils/s007-policy';
import { collectS008Declarations } from '../../utils/s008-interface-declarations';
import { errorMessage } from '../../utils/type-guards';

/**
 * Evaluator for Backend criteria (B001-B016), each with automated logic.
 */
export class BackendEvaluator extends CatalogSectionEvaluator {
  constructor() {
    super('Backend', 'java', {
      B001: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB001(repoPath, evaluationRun),
      B002: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB002(repoPath, evaluationRun),
      B003: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB003(repoPath, evaluationRun),
      B004: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB004(repoPath, evaluationRun),
      B005: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB005(repoPath, evaluationRun),
      B006: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB006(repoPath, evaluationRun),
      B007: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB007(repoPath, evaluationRun),
      B008: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB008(repoPath, evaluationRun),
      B009: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB009(repoPath, evaluationRun),
      B010: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB010(repoPath, evaluationRun),
      B011: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB011(repoPath, evaluationRun),
      B012: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB012(repoPath, evaluationRun),
      B013: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB013(repoPath, evaluationRun),
      B014: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB014(repoPath, evaluationRun),
      B015: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB015(repoPath, evaluationRun),
      B016: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateB016(repoPath, evaluationRun)
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

  private async evaluateB002(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B002', evaluationRun);
    const evidence = await getBackendEvidence(run, repoPath);
    const s008 = evidence.moduleKind.kind === 'backend-module' ? collectS008Declarations(repoPath, 'backend-module', run.artifacts.moduleDescriptor) : undefined;
    const index = loadF001HandlerIndex();
    const analysis = evaluateB002({ evidence, index, s008 });
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'B002',
      status: analysis.status,
      hasReviewMaterial: hasB002AgentReviewMaterial(analysis),
      notRunReason: 'what remains is for the reviewer: requests made by FOLIO libraries, or declarations the tool could not read',
      evaluationRun: run,
      review: (config, commandRunner) => reviewB002WithAgent(repoPath, analysis, index.loaded ? index.patterns : [], config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    return {
      criterionId: 'B002',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB002HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
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

  private async evaluateB004(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B004', evaluationRun);
    let policy: B004Policy | { problem: string };
    try {
      policy = loadB004Policy();
    } catch (error) {
      policy = { problem: `the policy snapshot could not be read: ${errorMessage(error)}` };
    }
    const analysis = evaluateB004(await getBackendEvidence(run, repoPath), run.existingModule, policy);
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'B004',
      status: analysis.status,
      hasReviewMaterial: hasB004AgentReviewMaterial(analysis),
      notRunReason: 'no variable, read or log statement on the checklist needs the agent\'s judgment',
      evaluationRun: run,
      review: (config, commandRunner) => reviewB004WithAgent(repoPath, analysis, 'problem' in policy ? undefined : policy, config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    else if (analysis.status === EvaluationStatus.FAIL && run.agentReview?.enabled) {
      analysis.agentReviewUnavailableReason = 'agent review runs only for manual results; the failures above are what the tool found on its own';
    }
    return {
      criterionId: 'B004',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB004HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
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

  private async evaluateB008(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B008', evaluationRun);
    const evidence = await getBackendEvidence(run, repoPath);
    const analysis = evaluateB008(evidence);
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'B008',
      status: analysis.status,
      hasReviewMaterial: hasB008AgentReviewMaterial(analysis),
      evaluationRun: run,
      review: (config, commandRunner) => reviewB008WithAgent(repoPath, analysis, evidence.snapshot.listedPaths ?? [], config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    return {
      criterionId: 'B008',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB008HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
    };
  }

  private async evaluateB009(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const analysis = await analyzeB009(repoPath, this.runFor(repoPath, 'B009', evaluationRun));
    return {
      criterionId: 'B009',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB009HumanDetails(analysis),
      criterionDetails: analysis
    };
  }

  private async evaluateB012(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B012', evaluationRun);
    const analysis = evaluateB012(await getBackendEvidence(run, repoPath), await getBackendInfrastructure(run, repoPath));
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'B012',
      status: analysis.status,
      hasReviewMaterial: hasB012AgentReviewMaterial(analysis),
      evaluationRun: run,
      review: (config, commandRunner) => reviewB012WithAgent(repoPath, analysis, config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    return {
      criterionId: 'B012',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB012HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
    };
  }

  private async evaluateB013(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B013', evaluationRun);
    const analysis = evaluateB013(await getBackendEvidence(run, repoPath));
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'B013',
      status: analysis.status,
      hasReviewMaterial: hasB013AgentReviewMaterial(analysis),
      evaluationRun: run,
      review: (config, commandRunner) => reviewB013WithAgent(repoPath, analysis, config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    return {
      criterionId: 'B013',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB013HumanDetails(analysis, agentReview),
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

  private async evaluateB015(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B015', evaluationRun);
    const analysis = evaluateB015(await getBackendEvidence(run, repoPath));
    return {
      criterionId: 'B015',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB015HumanDetails(analysis),
      criterionDetails: analysis
    };
  }

  private async evaluateB016(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B016', evaluationRun);
    const [evidence, infrastructure, policyLoad] = await Promise.all([
      getBackendEvidence(run, repoPath), getBackendInfrastructure(run, repoPath), loadS007Policy()
    ]);
    const analysis = evaluateB016(evidence.kind, infrastructure, policyLoad);
    return {
      criterionId: 'B016',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB016HumanDetails(analysis),
      criterionDetails: analysis
    };
  }

  private async evaluateB011(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B011', evaluationRun);
    const analysis = evaluateB011(await getBackendEvidence(run, repoPath));
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'B011',
      status: analysis.status,
      hasReviewMaterial: hasB011AgentReviewMaterial(analysis),
      notRunReason: 'only the files the tool could not read remain, and the reviewer checks those',
      evaluationRun: run,
      review: (config, commandRunner) => reviewB011WithAgent(repoPath, analysis, config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    else if (analysis.status === EvaluationStatus.FAIL && run.agentReview?.enabled) {
      analysis.agentReviewUnavailableReason = 'agent review runs only for manual results; the reviewer confirms each reference in code or in an every-install script (B011-C1)';
    }
    return {
      criterionId: 'B011',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB011HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
    };
  }

  private async evaluateB010(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'B010', evaluationRun);
    const analysis = evaluateB010(await getBackendEvidence(run, repoPath));
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'B010',
      status: analysis.status,
      hasReviewMaterial: hasB010AgentReviewMaterial(analysis),
      evaluationRun: run,
      review: (config, commandRunner) => reviewB010WithAgent(repoPath, analysis, config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    return {
      criterionId: 'B010',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderB010HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
    };
  }
}
