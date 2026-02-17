import { BaseSectionEvaluator } from '../base/section-evaluator';
import { CriterionResult } from '../../types';
import { LicenseUtils } from '../../utils/license-utils';
import { evaluateS003ThirdPartyLicenses } from '../../utils/license-compliance-evaluator';

/**
 * Abstract base class for Shared/Common criteria (S001-S014).
 * Registers default handlers for all shared criteria. Language-specific subclasses
 * can override individual handlers by calling criterionHandlers.set() in their
 * constructor (Map.set on existing keys replaces the value while preserving
 * insertion-order position).
 */
export abstract class SharedEvaluator extends BaseSectionEvaluator {
  readonly sectionName = 'Shared/Common';

  constructor() {
    super();
    this.criterionHandlers.set('S001', this.evaluateS001.bind(this));
    this.criterionHandlers.set('S002', this.evaluateS002.bind(this));
    this.criterionHandlers.set('S003', this.evaluateS003.bind(this));
    this.criterionHandlers.set('S004', this.evaluateS004.bind(this));
    this.criterionHandlers.set('S005', this.evaluateS005.bind(this));
    this.criterionHandlers.set('S006', this.evaluateS006.bind(this));
    this.criterionHandlers.set('S007', this.evaluateS007.bind(this));
    this.criterionHandlers.set('S008', this.evaluateS008.bind(this));
    this.criterionHandlers.set('S009', this.evaluateS009.bind(this));
    this.criterionHandlers.set('S010', this.evaluateS010.bind(this));
    this.criterionHandlers.set('S011', this.evaluateS011.bind(this));
    this.criterionHandlers.set('S012', this.evaluateS012.bind(this));
    this.criterionHandlers.set('S013', this.evaluateS013.bind(this));
    this.criterionHandlers.set('S014', this.evaluateS014.bind(this));
  }

  private async evaluateS001(repoPath: string): Promise<CriterionResult> {
    return await LicenseUtils.checkApache2License(repoPath, 'S001');
  }

  protected async evaluateS002(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S002', 'Module descriptor validation');
  }

  private async evaluateS003(repoPath: string): Promise<CriterionResult> {
    return await evaluateS003ThirdPartyLicenses(repoPath);
  }

  private async evaluateS004(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S004', 'README file evaluation');
  }

  private async evaluateS005(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S005', 'Version control and branching strategy');
  }

  private async evaluateS006(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S006', 'Code quality and static analysis');
  }

  protected async evaluateS007(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S007', 'Testing requirements');
  }

  protected async evaluateS008(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S008', 'Documentation requirements');
  }

  protected async evaluateS009(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S009', 'Security requirements');
  }

  private async evaluateS010(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S010', 'Performance requirements');
  }

  protected async evaluateS011(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S011', 'Accessibility requirements');
  }

  protected async evaluateS012(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S012', 'Internationalization requirements');
  }

  protected async evaluateS013(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S013', 'Configuration management');
  }

  private async evaluateS014(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S014', 'Monitoring and logging');
  }
}
