import { CriterionResult } from '../../types';
import { CriterionLanguage } from '../../criteria-definitions';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { LicenseUtils } from '../../utils/license-utils';
import { evaluateS003ThirdPartyLicenses } from '../../utils/license-compliance-evaluator';

/**
 * Abstract base class for Shared/Common criteria (S001-S014). Handled criterion
 * IDs and their fallback results are derived from the acceptance-criterion catalog
 * by CatalogSectionEvaluator. Automated criteria are supplied as handler overrides
 * to super() (here S001 and S003); every other criterion falls back to the
 * catalog-defined default result for the given language.
 */
export abstract class SharedEvaluator extends CatalogSectionEvaluator {
  constructor(language: CriterionLanguage = 'java') {
    super('Shared/Common', language, {
      S001: async (repoPath: string) => this.evaluateS001(repoPath),
      S003: async (repoPath: string) => this.evaluateS003(repoPath)
    });
  }

  private async evaluateS001(repoPath: string): Promise<CriterionResult> {
    return await LicenseUtils.checkApache2License(repoPath, 'S001');
  }

  private async evaluateS003(repoPath: string): Promise<CriterionResult> {
    return await evaluateS003ThirdPartyLicenses(repoPath);
  }
}
