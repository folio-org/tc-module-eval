import { CriterionResult } from '../../types';
import {
  createDefaultCriterionResult,
  CriterionLanguage,
  CriterionSection,
  getAcceptanceCriterionDefinition,
  getCriteriaForSection
} from '../../criteria-definitions';
import { CriterionFunction } from '../../types';
import { BaseSectionEvaluator } from './section-evaluator';

/**
 * Section evaluator that derives handled criteria and fallback results from
 * the acceptance criterion catalog.
 */
export abstract class CatalogSectionEvaluator extends BaseSectionEvaluator {
  readonly sectionName: string;
  protected readonly language: CriterionLanguage;

  constructor(
    sectionName: CriterionSection,
    language: CriterionLanguage,
    handlerOverrides: Record<string, CriterionFunction> = {}
  ) {
    super();
    this.sectionName = sectionName;
    this.language = language;

    for (const criterionId of getCriteriaForSection(sectionName, language)) {
      const override = handlerOverrides[criterionId];
      if (override) {
        this.criterionHandlers.set(criterionId, override);
        continue;
      }

      const definition = getAcceptanceCriterionDefinition(criterionId);
      if (!definition?.defaultEvaluation) {
        throw new Error(`No default evaluation or handler registered for criterion: ${criterionId}`);
      }

      this.criterionHandlers.set(criterionId, async () => this.createDefaultCatalogResult(criterionId));
    }
  }

  private createDefaultCatalogResult(criterionId: string): CriterionResult {
    return createDefaultCriterionResult(criterionId, this.language);
  }
}
