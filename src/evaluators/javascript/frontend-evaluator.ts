import { BaseSectionEvaluator } from '../base/section-evaluator';
import { CriterionResult, CriterionFunction } from '../../types';
import { FRONTEND_CRITERIA } from '../../criteria-definitions';

/**
 * Evaluator for Frontend criteria (F001-F007)
 * Handles UI-specific requirements for FOLIO modules
 */
export class FrontendEvaluator extends BaseSectionEvaluator {
  readonly sectionName = 'Frontend';
  readonly criteriaIds = Array.from(FRONTEND_CRITERIA);

  private evaluationMap: Map<string, CriterionFunction>;

  constructor() {
    super();
    this.evaluationMap = new Map<string, CriterionFunction>([
      ['F001', this.evaluateF001.bind(this)],
      ['F002', this.evaluateF002.bind(this)],
      ['F003', this.evaluateF003.bind(this)],
      ['F004', this.evaluateF004.bind(this)],
      ['F005', this.evaluateF005.bind(this)],
      ['F006', this.evaluateF006.bind(this)],
      ['F007', this.evaluateF007.bind(this)]
    ]);
  }

  /**
   * Evaluate specific frontend criterion
   * @param criterionId The ID of the criterion to evaluate
   * @param repoPath Path to the cloned repository
   * @returns Promise<CriterionResult> Result of the specific criterion
   */
  protected async evaluateSpecificCriterion(criterionId: string, repoPath: string): Promise<CriterionResult> {
    const evaluator = this.evaluationMap.get(criterionId);
    if (!evaluator) {
      throw new Error(`Unknown frontend criterion: ${criterionId}`);
    }
    return await evaluator(repoPath);
  }

  // STUB IMPLEMENTATIONS - Framework provides structure but evaluation logic not yet implemented
  // All methods below currently return NOT_APPLICABLE status and require detailed implementation
  // Future implementation will analyze package.json, UI components, tests, and configurations

  /**
   * F001: API interface requirements in package.json
   * Check if package.json properly declares stripes dependencies and interfaces
   */
  private async evaluateF001(repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult(
      'F001',
      'API interface requirements in package.json'
    );
  }

  /**
   * F002: E2E tests in supported technology
   * Check for E2E tests using supported frameworks (e.g., Cypress, BigTest)
   */
  private async evaluateF002(repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult(
      'F002',
      'E2E tests in supported technology (Cypress, BigTest, etc.)'
    );
  }

  /**
   * F003: i18n support via react-intl
   * Check if module uses react-intl for internationalization
   */
  private async evaluateF003(repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult(
      'F003',
      'Internationalization support via react-intl'
    );
  }

  /**
   * F004: WCAG 2.1 AA compliance
   * Check for accessibility compliance (automated tests, documentation)
   */
  private async evaluateF004(repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult(
      'F004',
      'WCAG 2.1 AA accessibility compliance'
    );
  }

  /**
   * F005: Use specified Stripes version
   * Check if module uses officially supported Stripes version
   */
  private async evaluateF005(repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult(
      'F005',
      'Use of specified Stripes framework version'
    );
  }

  /**
   * F006: Follow existing UI layouts/patterns
   * Check if module follows FOLIO UI conventions and patterns
   */
  private async evaluateF006(repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult(
      'F006',
      'Adherence to existing FOLIO UI layouts and patterns'
    );
  }

  /**
   * F007: Works in latest Chrome
   * Check browser compatibility documentation and testing
   */
  private async evaluateF007(repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult(
      'F007',
      'Browser compatibility with latest Chrome'
    );
  }
}
