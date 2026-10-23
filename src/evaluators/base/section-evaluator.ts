import { SectionEvaluator, CriterionResult, EvaluationStatus, CriterionFunction, EvaluationRun } from '../../types';
import { redactEvaluatorSecrets } from '../../utils/redaction';
import { errorMessage } from '../../utils/type-guards';

export abstract class BaseSectionEvaluator implements SectionEvaluator {
  abstract readonly sectionName: string;

  /**
   * Map of criterion ID to handler function.
   * Subclasses populate this in their constructor.
   * Insertion order determines criteriaIds order.
   */
  protected criterionHandlers: Map<string, CriterionFunction> = new Map();

  get criteriaIds(): string[] {
    return Array.from(this.criterionHandlers.keys());
  }

  async evaluate(repoPath: string, criteriaFilter?: string[], evaluationRun?: EvaluationRun): Promise<CriterionResult[]> {
    const results: Promise<CriterionResult>[] = [];

    const criteriaToEvaluate = criteriaFilter
      ? this.criteriaIds.filter(id => criteriaFilter.includes(id))
      : this.criteriaIds;

    // Criteria run one at a time and in order, except that a criterion waiting on its agent review lets
    // the next one start: reviews overlap (the run bounds how many), while deterministic work stays sequential.
    for (const criterionId of criteriaToEvaluate) {
      const handoff = evaluationRun?.nextAgentReviewHandoff();
      const result = this.evaluateCriterion(criterionId, repoPath, evaluationRun)
        .catch(error => this.createErrorResult(criterionId, error));
      results.push(result);
      await (handoff ? Promise.race([result, handoff]) : result);
    }

    return Promise.all(results);
  }

  async evaluateCriterion(criterionId: string, repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    if (!this.criteriaIds.includes(criterionId)) {
      throw new Error(`Criterion ${criterionId} is not handled by ${this.sectionName} evaluator`);
    }

    return await this.evaluateSpecificCriterion(criterionId, repoPath, evaluationRun);
  }

  protected async evaluateSpecificCriterion(
    criterionId: string,
    repoPath: string,
    evaluationRun?: EvaluationRun
  ): Promise<CriterionResult> {
    const handler = this.criterionHandlers.get(criterionId);
    if (!handler) {
      throw new Error(`No handler registered for criterion: ${criterionId}`);
    }
    return await handler(repoPath, evaluationRun);
  }

  protected createResult(
    criterionId: string,
    status: EvaluationStatus,
    evidence: string,
    details?: string
  ): CriterionResult {
    return {
      criterionId,
      status,
      evidence,
      details
    };
  }

  protected createErrorResult(criterionId: string, error: any): CriterionResult {
    const message = redactEvaluatorSecrets(errorMessage(error));
    return this.createResult(
      criterionId,
      EvaluationStatus.MANUAL,
      `Evaluation failed: ${message}`,
      'Manual review required due to evaluation error'
    );
  }

  protected createManualReviewResult(criterionId: string, reason: string): CriterionResult {
    return this.createResult(
      criterionId,
      EvaluationStatus.MANUAL,
      reason,
      'This criterion requires manual evaluation by a human reviewer'
    );
  }

  protected createNotImplementedResult(criterionId: string, description: string): CriterionResult {
    return this.createResult(
      criterionId,
      EvaluationStatus.MANUAL,
      `${description} - evaluation logic not yet implemented`,
      'This criterion requires manual evaluation by a human reviewer'
    );
  }
}
