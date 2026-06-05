import { CriterionLanguage } from '../../criteria-definitions';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';

/**
 * Evaluator for Administrative criteria (A001)
 * Handles administrative requirements for FOLIO modules
 */
export class AdministrativeEvaluator extends CatalogSectionEvaluator {
  constructor(language: CriterionLanguage = 'java') {
    super('Administrative', language);
  }
}
