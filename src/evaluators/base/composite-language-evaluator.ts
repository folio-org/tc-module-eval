import { LanguageEvaluator, CriterionResult, SectionEvaluator } from '../../types';
import { getLogger } from '../../utils/logger';

/**
 * Abstract base class for language evaluators that delegate to
 * an ordered list of section evaluators.
 */
export abstract class CompositeLanguageEvaluator implements LanguageEvaluator {

  abstract canEvaluate(repoPath: string): Promise<boolean>;
  abstract getLanguage(): string;

  /**
   * Return the ordered list of section evaluators to run.
   */
  protected abstract getSectionEvaluators(): SectionEvaluator[];

  /**
   * Evaluate the repository by dispatching to each section evaluator in order.
   * If any section throws, the loop aborts and partial results are returned.
   */
  async evaluate(repoPath: string, criteriaFilter?: string[]): Promise<CriterionResult[]> {
    const results: CriterionResult[] = [];

    try {
      for (const section of this.getSectionEvaluators()) {
        const sectionResults = await section.evaluate(repoPath, criteriaFilter);
        results.push(...sectionResults);
      }
    } catch (error) {
      getLogger().error(`Error during ${this.getLanguage()} evaluation:`, error);
    }

    return results;
  }
}
