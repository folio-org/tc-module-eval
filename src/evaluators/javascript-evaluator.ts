import * as fs from 'fs-extra';
import * as path from 'path';
import { SectionEvaluator } from '../types';
import { CompositeLanguageEvaluator } from './base/composite-language-evaluator';
import { AdministrativeEvaluator } from './shared/administrative-evaluator';
import { JavaScriptSharedEvaluator } from './javascript/javascript-shared-evaluator';
import { FrontendEvaluator } from './javascript/frontend-evaluator';
import { getLogger } from '../utils/logger';

/**
 * JavaScript/UI module evaluator for FOLIO UI modules
 * Uses composition of section-specific evaluators for comprehensive evaluation
 */
export class JavaScriptEvaluator extends CompositeLanguageEvaluator {
  private readonly administrativeEvaluator: AdministrativeEvaluator;
  private readonly sharedEvaluator: JavaScriptSharedEvaluator;
  private readonly frontendEvaluator: FrontendEvaluator;

  constructor() {
    super();
    this.administrativeEvaluator = new AdministrativeEvaluator();
    this.sharedEvaluator = new JavaScriptSharedEvaluator();
    this.frontendEvaluator = new FrontendEvaluator();
  }

  protected getSectionEvaluators(): SectionEvaluator[] {
    return [this.administrativeEvaluator, this.sharedEvaluator, this.frontendEvaluator];
  }

  async canEvaluate(repoPath: string): Promise<boolean> {
    const hasPackageJson = await fs.pathExists(path.join(repoPath, 'package.json'));

    if (!hasPackageJson) {
      return false;
    }

    try {
      const packageJsonPath = path.join(repoPath, 'package.json');
      const packageJson = await fs.readJson(packageJsonPath);

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
      getLogger().warn(`Could not parse package.json: ${error}`);
      return true;
    }
  }

  getLanguage(): string {
    return 'JavaScript';
  }
}
