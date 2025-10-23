import * as fs from 'fs-extra';
import * as path from 'path';
import { LanguageEvaluator, CriterionResult } from '../types';
import { AdministrativeEvaluator } from './shared/administrative-evaluator';
import { JavaScriptSharedEvaluator } from './javascript/javascript-shared-evaluator';
import { FrontendEvaluator } from './javascript/frontend-evaluator';

/**
 * JavaScript/UI module evaluator for FOLIO UI modules
 * Uses composition of section-specific evaluators for comprehensive evaluation
 */
export class JavaScriptEvaluator implements LanguageEvaluator {
  private readonly administrativeEvaluator: AdministrativeEvaluator;
  private readonly sharedEvaluator: JavaScriptSharedEvaluator;
  private readonly frontendEvaluator: FrontendEvaluator;

  constructor() {
    this.administrativeEvaluator = new AdministrativeEvaluator();
    this.sharedEvaluator = new JavaScriptSharedEvaluator();
    this.frontendEvaluator = new FrontendEvaluator();
  }

  /**
   * Check if this evaluator can handle the repository
   * @param repoPath Path to the cloned repository
   * @returns Promise<boolean> true if this is a JavaScript/UI repository
   */
  async canEvaluate(repoPath: string): Promise<boolean> {
    // Check for package.json (primary indicator)
    const hasPackageJson = await fs.pathExists(path.join(repoPath, 'package.json'));

    if (!hasPackageJson) {
      return false;
    }

    // Read package.json to verify it's a FOLIO UI module
    try {
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = await fs.readJson(packageJsonPath);

      // Check for Stripes-related dependencies (strong indicator of FOLIO UI module)
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies
      };

      const hasStripesDependency = Object.keys(dependencies).some(dep =>
        dep.startsWith('@folio/') ||
        dep.startsWith('stripes') ||
        dep === 'react' ||
        dep === 'react-dom'
      );

      return hasStripesDependency;
    } catch (error) {
      // If we can't read package.json but it exists, assume it's a JS project
      console.warn(`Could not parse package.json: ${error}`);
      return true;
    }
  }

  /**
   * Evaluate the JavaScript/UI repository against all applicable criteria
   * @param repoPath Path to the cloned repository
   * @param criteriaFilter Optional array of criterion IDs to filter evaluation
   * @returns Promise<CriterionResult[]> Evaluation results
   */
  async evaluate(repoPath: string, criteriaFilter?: string[]): Promise<CriterionResult[]> {
    const results: CriterionResult[] = [];

    try {
      // Evaluate Administrative criteria (A001)
      const administrativeResults = await this.administrativeEvaluator.evaluate(repoPath, criteriaFilter);
      results.push(...administrativeResults);

      // Evaluate Shared/Common criteria (S001-S014)
      const sharedResults = await this.sharedEvaluator.evaluate(repoPath, criteriaFilter);
      results.push(...sharedResults);

      // Evaluate Frontend criteria (F001-F007) for UI modules
      const frontendResults = await this.frontendEvaluator.evaluate(repoPath, criteriaFilter);
      results.push(...frontendResults);

    } catch (error) {
      console.error('Error during JavaScript evaluation:', error);
      // Continue with partial results rather than failing completely
    }

    return results;
  }

  /**
   * Get the language this evaluator handles
   */
  getLanguage(): string {
    return 'JavaScript';
  }
}
