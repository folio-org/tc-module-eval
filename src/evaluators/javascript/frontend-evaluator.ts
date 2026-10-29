import { CriterionResult, EvaluationRun, EvaluationStatus } from '../../types';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { reviewCriterionWithAgent } from '../../utils/criterion-agent-review';
import { hasF001AgentReviewMaterial, reviewF001WithAgent } from '../../utils/f001-agent-review';
import { evaluateF001, loadF001HandlerIndex, renderF001HumanDetails } from '../../utils/f001-consumed-apis';
import { hasF002AgentReviewMaterial, reviewF002WithAgent } from '../../utils/f002-agent-review';
import { analyzeF002, renderF002HumanDetails } from '../../utils/f002-e2e-tests';
import { hasF003AgentReviewMaterial, reviewF003WithAgent } from '../../utils/f003-agent-review';
import { evaluateF003, renderF003HumanDetails } from '../../utils/f003-internationalization';
import { evaluateF005, renderF005HumanDetails } from '../../utils/f005-stripes-version';
import { hasF006AgentReviewMaterial, reviewF006WithAgent } from '../../utils/f006-agent-review';
import { evaluateF006, F006Input, loadF006Guidelines, readF006Css, renderF006HumanDetails } from '../../utils/f006-ui-patterns';
import { getFrontendSource } from '../../utils/frontend-source';
import { getModuleKind } from '../../utils/module-kind';
import { getS007Analysis } from '../../utils/s007-evaluator';
import { collectFrontend } from '../../utils/s008-interface-declarations';
import { errorMessage } from '../../utils/type-guards';
import { getUiRequestSites } from '../../utils/ui-request-sites';

/**
 * Evaluator for Frontend criteria (F001-F007). F001, F002, F003, F005 and F006 have automated logic; the others fall back to
 * the catalog-defined default result.
 */
export class FrontendEvaluator extends CatalogSectionEvaluator {
  constructor() {
    super('Frontend', 'javascript', {
      F001: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateF001(repoPath, evaluationRun),
      F002: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateF002(repoPath, evaluationRun),
      F003: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateF003(repoPath, evaluationRun),
      F005: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateF005(repoPath, evaluationRun),
      F006: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateF006(repoPath, evaluationRun)
    });
  }

  private async evaluateF001(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'F001', evaluationRun);
    const [source, sites] = await Promise.all([getFrontendSource(run, repoPath), getUiRequestSites(run, repoPath)]);
    const index = loadF001HandlerIndex();
    // collectFrontend reads package.json for UI modules and libraries alike; S008's reader rejects libraries.
    const analysis = evaluateF001({ source, sites, declarations: collectFrontend(repoPath), index });
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'F001',
      status: analysis.status,
      hasReviewMaterial: hasF001AgentReviewMaterial(analysis),
      notRunReason: analysis.siteCount ? 'every request was mapped to an interface; what remains is for the reviewer'
        : 'the code sends no requests for the agent to review',
      evaluationRun: run,
      review: (config, commandRunner) => reviewF001WithAgent(repoPath, analysis, index.loaded ? index.patterns : [], config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    else if (analysis.status === EvaluationStatus.FAIL && run.agentReview?.enabled) {
      analysis.agentReviewUnavailableReason = 'agent review runs only for manual results; the reviewer confirms each undeclared interface (F001-C1)';
    }
    return {
      criterionId: 'F001',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderF001HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
    };
  }

  private async evaluateF002(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'F002', evaluationRun);
    const analysis = await analyzeF002(repoPath);
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'F002',
      status: analysis.status,
      hasReviewMaterial: hasF002AgentReviewMaterial(analysis),
      evaluationRun: run,
      review: (config, commandRunner) => reviewF002WithAgent(repoPath, analysis, config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    else if (analysis.status === EvaluationStatus.FAIL && run.agentReview?.enabled) {
      analysis.agentReviewUnavailableReason = 'agent review runs only for manual results';
    }
    return {
      criterionId: 'F002',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderF002HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
    };
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

  private async evaluateF006(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = this.runFor(repoPath, 'F006', evaluationRun);
    const [source, css] = await Promise.all([getFrontendSource(run, repoPath), readF006Css(repoPath)]);
    let guidelines: F006Input['guidelines'];
    try {
      guidelines = loadF006Guidelines();
    } catch (error) {
      guidelines = { problem: `the UX guideline snapshot could not be read: ${errorMessage(error)}` };
    }
    const analysis = evaluateF006({ source, css, guidelines });
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'F006',
      status: analysis.status,
      hasReviewMaterial: hasF006AgentReviewMaterial(analysis),
      evaluationRun: run,
      review: (config, commandRunner) => reviewF006WithAgent(repoPath, analysis, guidelines, config, commandRunner)
    });
    if (unavailableReason) analysis.agentReviewUnavailableReason = unavailableReason;
    return {
      criterionId: 'F006',
      status: analysis.status,
      evidence: analysis.summary,
      details: renderF006HumanDetails(analysis, agentReview),
      criterionDetails: analysis,
      agentReview
    };
  }
}
