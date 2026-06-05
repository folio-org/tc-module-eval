import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';

/**
 * Evaluator for Frontend criteria (F001-F007)
 * Handles UI-specific requirements for FOLIO modules
 */
export class FrontendEvaluator extends CatalogSectionEvaluator {
  constructor() {
    super('Frontend', 'javascript');
  }
}
