import { SharedEvaluator } from '../shared/shared-evaluator';
import { CriterionResult } from '../../types';

/**
 * Evaluator for Shared/Common criteria (S001-S014) for JavaScript/UI modules.
 * Extends SharedEvaluator with JavaScript-specific description overrides.
 */
export class JavaScriptSharedEvaluator extends SharedEvaluator {

  constructor() {
    super();
    // Override handlers with JS-specific descriptions
    this.criterionHandlers.set('S002', this.evaluateS002JS.bind(this));
    this.criterionHandlers.set('S007', this.evaluateS007JS.bind(this));
    this.criterionHandlers.set('S008', this.evaluateS008JS.bind(this));
    this.criterionHandlers.set('S009', this.evaluateS009JS.bind(this));
    this.criterionHandlers.set('S011', this.evaluateS011JS.bind(this));
    this.criterionHandlers.set('S012', this.evaluateS012JS.bind(this));
    this.criterionHandlers.set('S013', this.evaluateS013JS.bind(this));
  }

  private async evaluateS002JS(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S002', 'package.json and stripes metadata validation');
  }

  private async evaluateS007JS(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S007', 'Supported technologies (React, Node.js, Stripes)');
  }

  private async evaluateS008JS(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S008', 'FOLIO Stripes interface usage');
  }

  private async evaluateS009JS(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S009', 'Approved npm package dependencies');
  }

  private async evaluateS011JS(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S011', 'Sonarqube security configuration');
  }

  private async evaluateS012JS(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S012', 'Build tools (npm/yarn)');
  }

  private async evaluateS013JS(_repoPath: string): Promise<CriterionResult> {
    return this.createNotImplementedResult('S013', 'Unit test coverage (Jest/Istanbul)');
  }
}
