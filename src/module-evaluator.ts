import { GitUtils } from './utils/git';
import { JavaEvaluator } from './evaluators/java-evaluator';
import { JavaScriptEvaluator } from './evaluators/javascript-evaluator';
import { LanguageEvaluator, EvaluationResult, EvaluationConfig, CriterionResult, EvaluationStatus } from './types';
import { getCriteriaForLanguage } from './criteria-definitions';
import { getLogger } from './utils/logger';
import { createEvaluationRun, languageToCatalogLanguage } from './utils/evaluation-run';
import { LocalCommandRunner } from './utils/command-runner';
import { RemoteEvidenceTransport } from './utils/remote-evidence';
import { PlaywrightUiRuntimeProbe } from './utils/ui-runtime-probe';
import packageMetadata from '../package.json';

export function citedTrackedFiles(criteria: CriterionResult[], trackedFiles: string[]): string[] {
  const explicitReferences = new Set<string>();
  const collect = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key === 'path' || key === 'sourcePath' || key === 'versionSourcePath' || key === 'evidenceReferences' || key === 'projectFiles') {
        explicitReferences.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => collect(item, key));
      return;
    }
    if (value && typeof value === 'object') {
      // S009 records each hashed source file as a key of fileHashes.
      if (key === 'fileHashes') Object.keys(value).forEach(file => explicitReferences.add(file));
      Object.entries(value).forEach(([childKey, child]) => collect(child, childKey));
    }
  };

  criteria.forEach(result => {
    collect(result.criterionDetails);
    collect(result.agentReview);
  });
  return trackedFiles.filter(file => explicitReferences.has(file));
}

/**
 * Main orchestrator for module evaluation
 *
 * S001-S014, B001-B006, B008, B009, B011, B012, B014, B016, F001-F003 and F005 have automated evaluation logic and return
 * MANUAL only when the evidence is inconclusive; B007 returns MANUAL whenever it applies and does not fail, B010
 * whenever the repository stores data, and F004, F006 and F007 whenever the package renders a user interface. The
 * other 3 of the 38 criteria always return MANUAL: A001 is a manual review by design, and B013 and B015 (Java)
 * have no evaluation logic yet.
 */
export class ModuleEvaluator {
  private gitUtils: GitUtils;
  private evaluators: LanguageEvaluator[];
  private config: EvaluationConfig;

  constructor(config: EvaluationConfig) {
    this.config = config;
    this.gitUtils = new GitUtils(config.tempDir);

    this.evaluators = [
      new JavaEvaluator(),
      new JavaScriptEvaluator()
    ];
  }

  async evaluateModule(repositoryUrl: string): Promise<EvaluationResult> {
    let repoPath = '';

    try {
      getLogger().info(`Starting evaluation of: ${repositoryUrl}`);

      repoPath = await this.gitUtils.cloneRepository(repositoryUrl, this.config.branch);
      
      const evaluator = await this.selectEvaluator(repoPath);
      if (!evaluator) {
        throw new Error('No suitable evaluator found for this repository');
      }
      
      getLogger().info(`Using ${evaluator.getLanguage()} evaluator`);

      if (this.config.criteriaFilter) {
        this.validateCriteriaFilter(this.config.criteriaFilter, evaluator);
      }

      const repoInfo = await this.gitUtils.getRepoInfo(repoPath);

      const commandRunner = this.config.commandRunner ??
        (this.config.allowLocalCommands
          ? new LocalCommandRunner({
              allowLocalCommands: true,
              commandExecutionEnvironment: this.config.commandExecutionEnvironment
            })
          : undefined);
      const evaluationRun = createEvaluationRun({
        repositoryPath: repoPath,
        repositoryUrl,
        repositoryName: repoInfo.name,
        language: languageToCatalogLanguage(evaluator.getLanguage()),
        criteriaFilter: this.config.criteriaFilter,
        commandRunner,
        agentReview: this.config.agentReview,
        s008CatalogChannel: this.config.s008CatalogChannel,
        repositoryCommit: repoInfo.commit,
        requestedBranch: this.config.branch,
        remoteLookups: this.config.remoteLookups ?? (this.config.allowRemoteLookups
          ? new RemoteEvidenceTransport({
              credentials: { sonarToken: process.env.SONAR_TOKEN || undefined, githubToken: process.env.GITHUB_TOKEN || undefined }
            })
          : undefined),
        s014Application: this.config.s014Application,
        s014PlatformRef: this.config.s014PlatformRef,
        existingModule: this.config.existingModule,
        uiRuntime: this.config.uiRuntimeProbe ?? (this.config.uiRuntime
          ? new PlaywrightUiRuntimeProbe({
              ...this.config.uiRuntime,
              username: process.env.FOLIO_UI_USERNAME || undefined,
              password: process.env.FOLIO_UI_PASSWORD || undefined
            })
          : undefined)
      });

      const criterionResults = await evaluator.evaluate(repoPath, this.config.criteriaFilter, evaluationRun);
      
      const result: EvaluationResult = {
        repositoryUrl,
        moduleName: repoInfo.name,
        language: evaluator.getLanguage(),
        evaluatedAt: new Date(),
        provenance: {
          repositoryCommit: repoInfo.commit,
          evaluator: {
            name: packageMetadata.name,
            version: packageMetadata.version
          },
          agentReviewModel: this.config.agentReview?.modelLabel,
          citedSourcePaths: citedTrackedFiles(criterionResults, repoInfo.trackedFiles)
        },
        criteria: criterionResults
      };
      
      getLogger().info(`Evaluation completed. Results: ${this.summarizeResults(criterionResults)}`);
      return result;
      
    } finally {
      if (repoPath && !this.config.skipCleanup) {
        await this.gitUtils.cleanup(repoPath);
      } else if (repoPath && this.config.skipCleanup) {
        getLogger().info(`Repository preserved at: ${repoPath}`);
      }
    }
  }

  private async selectEvaluator(repoPath: string): Promise<LanguageEvaluator | null> {
    for (const evaluator of this.evaluators) {
      if (await evaluator.canEvaluate(repoPath)) {
        return evaluator;
      }
    }
    return null;
  }

  private summarizeResults(results: CriterionResult[]): string {
    const pass = results.filter(r => r.status === EvaluationStatus.PASS).length;
    const fail = results.filter(r => r.status === EvaluationStatus.FAIL).length;
    const manual = results.filter(r => r.status === EvaluationStatus.MANUAL).length;
    const notApplicable = results.filter(r => r.status === EvaluationStatus.NOT_APPLICABLE).length;

    return `${pass} passed, ${fail} failed, ${manual} require manual review, ${notApplicable} not applicable`;
  }

  addEvaluator(evaluator: LanguageEvaluator): void {
    this.evaluators.push(evaluator);
  }

  getSupportedLanguages(): string[] {
    return this.evaluators.map(evaluator => evaluator.getLanguage());
  }

  private validateCriteriaFilter(criteriaFilter: string[], evaluator: LanguageEvaluator): void {
    const availableCriteria = Array.from(getCriteriaForLanguage(evaluator.getLanguage()));
    const invalidCriteria = criteriaFilter.filter(id => !availableCriteria.includes(id));

    if (invalidCriteria.length > 0) {
      throw new Error(
        `Invalid criterion IDs: ${invalidCriteria.join(', ')}\n` +
        `Available criteria for ${evaluator.getLanguage()}: ${availableCriteria.join(', ')}`
      );
    }
  }
}
