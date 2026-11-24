import { createDefaultCriterionResult, CriterionLanguage } from '../../criteria-definitions';
import { EvaluationStatus } from '../../types';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';

export class AdministrativeEvaluator extends CatalogSectionEvaluator {
  constructor(language: CriterionLanguage = 'java') {
    super('Administrative', language, {
      // The TC criteria: "For existing module evaluation: This criterion is inapplicable."
      A001: async (_repoPath, run) => run?.existingModule
        ? {
          criterionId: 'A001',
          status: EvaluationStatus.NOT_APPLICABLE,
          evidence: 'A001 not applicable: A Product Council listing is required only of new modules, and this is an existing-module evaluation.',
          details: 'Evaluated as: an existing module (--existing-module)\nWhat to do: Nothing; the criterion does not apply to an existing module.'
        }
        : createDefaultCriterionResult('A001', language)
    });
  }
}
