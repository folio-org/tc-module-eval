import * as fs from 'fs-extra';
import * as path from 'path';
import { SectionEvaluator } from '../types';
import { CompositeLanguageEvaluator } from './base/composite-language-evaluator';
import { AdministrativeEvaluator } from './shared/administrative-evaluator';
import { JavaSharedEvaluator } from './java/java-shared-evaluator';
import { BackendEvaluator } from './java/backend-evaluator';

/**
 * Java-specific module evaluator
 * Uses composition of section-specific evaluators for comprehensive evaluation
 */
export class JavaEvaluator extends CompositeLanguageEvaluator {
  private readonly administrativeEvaluator: AdministrativeEvaluator;
  private readonly sharedEvaluator: JavaSharedEvaluator;
  private readonly backendEvaluator: BackendEvaluator;

  constructor() {
    super();
    this.administrativeEvaluator = new AdministrativeEvaluator();
    this.sharedEvaluator = new JavaSharedEvaluator();
    this.backendEvaluator = new BackendEvaluator();
  }

  protected getSectionEvaluators(): SectionEvaluator[] {
    return [this.administrativeEvaluator, this.sharedEvaluator, this.backendEvaluator];
  }

  async canEvaluate(repoPath: string): Promise<boolean> {
    const hasPomXml = await fs.pathExists(path.join(repoPath, 'pom.xml'));
    const hasBuildGradle = await fs.pathExists(path.join(repoPath, 'build.gradle')) ||
                          await fs.pathExists(path.join(repoPath, 'build.gradle.kts'));
    const hasJavaFiles = await this.hasJavaSourceFiles(repoPath);

    return hasPomXml || hasBuildGradle || hasJavaFiles;
  }

  getLanguage(): string {
    return 'Java';
  }

  private async hasJavaSourceFiles(repoPath: string): Promise<boolean> {
    try {
      const srcDir = path.join(repoPath, 'src');
      if (await fs.pathExists(srcDir)) {
        return await this.searchForJavaFiles(srcDir);
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  private async searchForJavaFiles(dirPath: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.java')) {
          return true;
        } else if (entry.isDirectory()) {
          const found = await this.searchForJavaFiles(path.join(dirPath, entry.name));
          if (found) return true;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }
}
