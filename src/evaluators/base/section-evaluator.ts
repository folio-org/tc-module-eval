import { SectionEvaluator, CriterionResult, EvaluationStatus, CriterionFunction, EvaluationRun } from '../../types';
import { redactSensitiveText } from '../../utils/redaction';

/**
 * Abstract base class for section-specific evaluators
 * Provides common evaluation infrastructure for all section evaluators
 */
export abstract class BaseSectionEvaluator implements SectionEvaluator {
  /**
   * The name of the section this evaluator handles
   */
  abstract readonly sectionName: string;

  /**
   * Map of criterion ID to handler function.
   * Subclasses populate this in their constructor.
   * Insertion order determines criteriaIds order.
   */
  protected criterionHandlers: Map<string, CriterionFunction> = new Map();

  /**
   * Array of criterion IDs this evaluator handles, derived from the handler map.
   */
  get criteriaIds(): string[] {
    return Array.from(this.criterionHandlers.keys());
  }

  /**
   * Evaluate all criteria in this section
   * @param repoPath Path to the cloned repository
   * @param criteriaFilter Optional array of criterion IDs to filter evaluation
   * @returns Promise<CriterionResult[]> Results of all criteria in this section
   */
  async evaluate(repoPath: string, criteriaFilter?: string[], evaluationRun?: EvaluationRun): Promise<CriterionResult[]> {
    const results: Promise<CriterionResult>[] = [];

    // Determine which criteria to evaluate
    const criteriaToEvaluate = criteriaFilter
      ? this.criteriaIds.filter(id => criteriaFilter.includes(id))
      : this.criteriaIds;

    // Criteria run one at a time and in order, except that a criterion waiting on its agent review lets
    // the next one start: reviews overlap (the run bounds how many), while deterministic work stays sequential.
    for (const criterionId of criteriaToEvaluate) {
      const handoff = evaluationRun?.nextAgentReviewHandoff();
      const result = this.evaluateCriterion(criterionId, repoPath, evaluationRun)
        // If evaluation fails, create a manual review result
        .catch(error => this.createErrorResult(criterionId, error));
      results.push(result);
      await (handoff ? Promise.race([result, handoff]) : result);
    }

    return Promise.all(results);
  }

  /**
   * Evaluate a specific criterion by ID
   * @param criterionId The ID of the criterion to evaluate
   * @param repoPath Path to the cloned repository
   * @returns Promise<CriterionResult> Result of the specific criterion
   */
  async evaluateCriterion(criterionId: string, repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    // Check if this evaluator handles the criterion
    if (!this.criteriaIds.includes(criterionId)) {
      throw new Error(`Criterion ${criterionId} is not handled by ${this.sectionName} evaluator`);
    }

    // Delegate to the specific evaluation method
    return await this.evaluateSpecificCriterion(criterionId, repoPath, evaluationRun);
  }

  /**
   * Look up and invoke the handler for a specific criterion.
   * Subclasses may override this if they need custom dispatch logic.
   */
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

  /**
   * Create a standardized result object
   */
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

  /**
   * Create an error result when evaluation fails
   */
  protected createErrorResult(criterionId: string, error: any): CriterionResult {
    const errorMessage = redactSensitiveText(error instanceof Error ? error.message : String(error));
    return this.createResult(
      criterionId,
      EvaluationStatus.MANUAL,
      `Evaluation failed: ${errorMessage}`,
      'Manual review required due to evaluation error'
    );
  }

  /**
   * Create a manual review result for criteria that require human evaluation
   */
  protected createManualReviewResult(criterionId: string, reason: string): CriterionResult {
    return this.createResult(
      criterionId,
      EvaluationStatus.MANUAL,
      reason,
      'This criterion requires manual evaluation by a human reviewer'
    );
  }

  /**
   * Create a manual review result for a criterion with stub implementation
   */
  protected createNotImplementedResult(criterionId: string, description: string): CriterionResult {
    return this.createResult(
      criterionId,
      EvaluationStatus.MANUAL,
      `${description} - evaluation logic not yet implemented`,
      'This criterion requires manual evaluation by a human reviewer'
    );
  }
}
