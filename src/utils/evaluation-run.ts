import {
  ArtifactKey,
  CommandExecutionResult,
  CommandRunner,
  EvaluationRun,
  EvaluationRunArtifacts
} from '../types';
import { CriterionLanguage, getCriteriaForCatalogLanguage } from '../criteria-definitions';
import { S008CatalogChannel } from '../types';

export interface CreateEvaluationRunOptions {
  repositoryPath: string;
  language: CriterionLanguage;
  criteriaFilter?: string[];
  repositoryUrl?: string;
  repositoryName?: string;
  commandRunner?: CommandRunner;
  agentReview?: EvaluationRun['agentReview'];
  s008CatalogChannel?: S008CatalogChannel;
  repositoryCommit?: string;
  requestedBranch?: string;
  remoteLookups?: EvaluationRun['remoteLookups'];
  s014Application?: string;
  s014PlatformRef?: string;
}

export function createEvaluationRun(options: CreateEvaluationRunOptions): EvaluationRun {
  const selectedCriteria = options.criteriaFilter?.length
    ? getCriteriaForCatalogLanguage(options.language).filter(id => options.criteriaFilter!.includes(id))
    : [...getCriteriaForCatalogLanguage(options.language)];

  const artifacts: EvaluationRunArtifacts = {};
  const commandObservations = new Map<string, CommandExecutionResult>();
  const pendingArtifacts = new Map<ArtifactKey, Promise<unknown>>();

  const run: EvaluationRun = {
    repositoryPath: options.repositoryPath,
    repositoryUrl: options.repositoryUrl,
    repositoryName: options.repositoryName,
    language: options.language,
    selectedCriteria,
    artifacts,
    commandObservations,
    commandRunner: options.commandRunner,
    agentReview: options.agentReview,
    s008CatalogChannel: options.s008CatalogChannel ?? 'official',
    repositoryCommit: options.repositoryCommit,
    requestedBranch: options.requestedBranch,
    remoteLookups: options.remoteLookups,
    s014Application: options.s014Application,
    s014PlatformRef: options.s014PlatformRef,
    async getOrCreateArtifact<K extends ArtifactKey>(
      key: K,
      producer: () => Promise<NonNullable<EvaluationRunArtifacts[K]>>
    ): Promise<NonNullable<EvaluationRunArtifacts[K]>> {
      const existing = artifacts[key];
      if (existing) {
        return existing as NonNullable<EvaluationRunArtifacts[K]>;
      }

      // Concurrent callers share the in-flight producer; a failed one is evicted so a later call retries.
      let pending = pendingArtifacts.get(key) as Promise<NonNullable<EvaluationRunArtifacts[K]>> | undefined;
      if (!pending) {
        pending = producer().then(created => {
          artifacts[key] = created as EvaluationRunArtifacts[K];
          return created;
        });
        pendingArtifacts.set(key, pending);
        pending.then(() => pendingArtifacts.delete(key), () => pendingArtifacts.delete(key));
      }
      return pending;
    }
  };

  return run;
}

export function languageToCatalogLanguage(language: string): CriterionLanguage {
  return language.toLowerCase() === 'javascript' ? 'javascript' : 'java';
}
