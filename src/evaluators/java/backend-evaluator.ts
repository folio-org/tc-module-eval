import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';

/**
 * Evaluator for Backend criteria (B001-B016)
 * Handles backend-specific requirements for FOLIO modules
 */
export class BackendEvaluator extends CatalogSectionEvaluator {
  constructor() {
    super('Backend', 'java');
  }
}
