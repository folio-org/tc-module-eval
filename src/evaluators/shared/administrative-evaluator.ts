import { BaseSectionEvaluator } from '../base/section-evaluator';
import { CriterionResult } from '../../types';

/**
 * Evaluator for Administrative criteria (A001)
 * Handles administrative requirements for FOLIO modules
 */
export class AdministrativeEvaluator extends BaseSectionEvaluator {
  readonly sectionName = 'Administrative';

  constructor() {
    super();
    this.criterionHandlers.set('A001', this.evaluateA001.bind(this));
  }

  private async evaluateA001(repoPath: string): Promise<CriterionResult> {
    return this.createManualReviewResult(
      'A001',
      'Product Council approval verification requires manual review'
    );
  }
}
