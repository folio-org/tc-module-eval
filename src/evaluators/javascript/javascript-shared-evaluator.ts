import { BaseSectionEvaluator } from '../base/section-evaluator';
import { CriterionResult, CriterionFunction } from '../../types';
import { LicenseUtils } from '../../utils/license-utils';
import { evaluateS003ThirdPartyLicenses } from '../../utils/license-compliance-evaluator';
import { SHARED_CRITERIA } from '../../criteria-definitions';

/**
 * Evaluator for Shared/Common criteria (S001-S014) for JavaScript/UI modules
 * Handles shared requirements with JavaScript-specific implementations where needed
 */
export class JavaScriptSharedEvaluator extends BaseSectionEvaluator {
  readonly sectionName = 'Shared/Common';
  readonly criteriaIds = Array.from(SHARED_CRITERIA);

  private evaluationMap: Map<string, CriterionFunction>;

  constructor() {
    super();
    this.evaluationMap = new Map<string, CriterionFunction>([
      ['S001', this.evaluateS001.bind(this)],
      ['S002', this.evaluateS002.bind(this)],
      ['S003', this.evaluateS003.bind(this)],
      ['S004', this.evaluateS004.bind(this)],
      ['S005', this.evaluateS005.bind(this)],
      ['S006', this.evaluateS006.bind(this)],
      ['S007', this.evaluateS007.bind(this)],
      ['S008', this.evaluateS008.bind(this)],
      ['S009', this.evaluateS009.bind(this)],
      ['S010', this.evaluateS010.bind(this)],
      ['S011', this.evaluateS011.bind(this)],
      ['S012', this.evaluateS012.bind(this)],
      ['S013', this.evaluateS013.bind(this)],
      ['S014', this.evaluateS014.bind(this)]
    ]);
  }

  /**
   * Evaluate specific shared criterion
   * @param criterionId The ID of the criterion to evaluate
   * @param repoPath Path to the cloned repository
   * @returns Promise<CriterionResult> Result of the specific criterion
   */
  protected async evaluateSpecificCriterion(criterionId: string, repoPath: string): Promise<CriterionResult> {
    const evaluator = this.evaluationMap.get(criterionId);
    if (!evaluator) {
      throw new Error(`Unknown shared criterion: ${criterionId}`);
    }
    return await evaluator(repoPath);
  }

  /**
   * S001: Apache 2.0 license check
   * Uses LicenseUtils which checks LICENSE files (universal) and build configs (language-specific)
   * TODO: Enhance LicenseUtils to check package.json for JavaScript modules
   */
  private async evaluateS001(repoPath: string): Promise<CriterionResult> {
    return await LicenseUtils.checkApache2License(repoPath, 'S001');
  }

  /**
   * S002: Module descriptor validation
   * For JavaScript: Check package.json has valid stripes metadata
   * TODO: Implement package.json stripes metadata validation
   */
  private async evaluateS002(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S002', 'package.json and stripes metadata validation');
  }

  /**
   * S003: Third-party license compliance
   * Uses dependency-orchestrator which auto-detects npm and extracts dependencies
   * This is language-agnostic - works for both Java and JavaScript
   */
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

  /**
   * S007: Officially supported technologies
   * For JavaScript: Check for React, Node.js, Stripes versions
   * TODO: Implement package.json technology version checks
   */
  private async evaluateS007(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S007', 'Supported technologies (React, Node.js, Stripes)');
  }

  /**
   * S008: Uses existing FOLIO interfaces
   * For JavaScript: Check for proper Stripes interface usage
   * TODO: Implement Stripes interface usage validation
   */
  private async evaluateS008(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S008', 'FOLIO Stripes interface usage');
  }

  /**
   * S009: No unapproved FOLIO library dependencies
   * For JavaScript: Check npm dependencies against approved list
   * TODO: Implement npm package approval checking
   */
  private async evaluateS009(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S009', 'Approved npm package dependencies');
  }

  private async evaluateS010(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S010', 'Performance requirements');
  }

  /**
   * S011: Sonarqube security checks
   * For JavaScript: Check for sonar configuration files
   * TODO: Implement sonar configuration validation
   */
  private async evaluateS011(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S011', 'Sonarqube security configuration');
  }

  /**
   * S012: Officially supported build tools
   * For JavaScript: Check for npm/yarn usage
   * TODO: Implement npm/yarn validation
   */
  private async evaluateS012(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S012', 'Build tools (npm/yarn)');
  }

  /**
   * S013: 80%+ unit test coverage
   * For JavaScript: Check coverage reports (Istanbul/nyc/Jest)
   * TODO: Implement JavaScript test coverage extraction
   */
  private async evaluateS013(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S013', 'Unit test coverage (Jest/Istanbul)');
  }

  private async evaluateS014(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S014', 'Application descriptor assignment');
  }
}
