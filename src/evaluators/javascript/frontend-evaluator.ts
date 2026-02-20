import { BaseSectionEvaluator } from '../base/section-evaluator';
import { CriterionResult } from '../../types';

/**
 * Evaluator for Frontend criteria (F001-F007)
 * Handles UI-specific requirements for FOLIO modules
 */
export class FrontendEvaluator extends BaseSectionEvaluator {
  readonly sectionName = 'Frontend';

  constructor() {
    super();
    this.criterionHandlers.set('F001', this.evaluateF001.bind(this));
    this.criterionHandlers.set('F002', this.evaluateF002.bind(this));
    this.criterionHandlers.set('F003', this.evaluateF003.bind(this));
    this.criterionHandlers.set('F004', this.evaluateF004.bind(this));
    this.criterionHandlers.set('F005', this.evaluateF005.bind(this));
    this.criterionHandlers.set('F006', this.evaluateF006.bind(this));
    this.criterionHandlers.set('F007', this.evaluateF007.bind(this));
  }

  private async evaluateF001(repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('F001', 'API interface requirements in package.json');
  }

  private async evaluateF002(repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('F002', 'E2E tests in supported technology (Cypress, BigTest, etc.)');
  }

  private async evaluateF003(repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('F003', 'Internationalization support via react-intl');
  }

  private async evaluateF004(repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('F004', 'WCAG 2.1 AA accessibility compliance');
  }

  private async evaluateF005(repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('F005', 'Use of specified Stripes framework version');
  }

  private async evaluateF006(repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('F006', 'Adherence to existing FOLIO UI layouts and patterns');
  }

  private async evaluateF007(repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('F007', 'Browser compatibility with latest Chrome');
  }
}
