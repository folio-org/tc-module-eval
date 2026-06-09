import {
  ArtifactKey,
  CommandExecutionResult,
  CommandRunner,
  EvaluationRun,
  EvaluationRunArtifacts
} from '../types';
import { CriterionLanguage, getCriteriaForCatalogLanguage } from '../criteria-definitions';

export interface CreateEvaluationRunOptions {
  repositoryPath: string;
  language: CriterionLanguage;
  criteriaFilter?: string[];
  repositoryUrl?: string;
  repositoryName?: string;
  commandRunner?: CommandRunner;
}

export function createEvaluationRun(options: CreateEvaluationRunOptions): EvaluationRun {
  const selectedCriteria = options.criteriaFilter?.length
    ? getCriteriaForCatalogLanguage(options.language).filter(id => options.criteriaFilter!.includes(id))
    : [...getCriteriaForCatalogLanguage(options.language)];

  const artifacts: EvaluationRunArtifacts = {};
  const commandObservations = new Map<string, CommandExecutionResult>();

  const run: EvaluationRun = {
    repositoryPath: options.repositoryPath,
    repositoryUrl: options.repositoryUrl,
    repositoryName: options.repositoryName,
    language: options.language,
    selectedCriteria,
    artifacts,
    commandObservations,
    commandRunner: options.commandRunner,
    async getOrCreateArtifact<K extends ArtifactKey>(
      key: K,
      producer: () => Promise<NonNullable<EvaluationRunArtifacts[K]>>
    ): Promise<NonNullable<EvaluationRunArtifacts[K]>> {
      const existing = artifacts[key];
      if (existing) {
        return existing as NonNullable<EvaluationRunArtifacts[K]>;
      }

      const created = await producer();
      artifacts[key] = created as EvaluationRunArtifacts[K];
      return created;
    }
  };

  return run;
}

export function languageToCatalogLanguage(language: string): CriterionLanguage {
  return language.toLowerCase() === 'javascript' ? 'javascript' : 'java';
}
