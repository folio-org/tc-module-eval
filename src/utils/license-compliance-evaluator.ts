import {
  CommandExecutionResult,
  CriterionResult,
  EvaluationStatus,
  LicenseIssueType,
  Dependency,
  ComplianceResult,
  DependencyExtractionError,
  EvaluationRun
} from '../types';
import { getDependencies } from './dependency-orchestrator';
import { checkLicenseCompliance } from './license-compliance';
import { readRepoTextFile } from './parsers/common';
import { getLogger } from './logger';
import { reportText } from './report-text';

export interface ThirdPartyLicenseEvaluatorAdapters {
  extractDependencies(repoPath: string, evaluationRun?: EvaluationRun): Promise<{
    dependencies: Dependency[];
    errors: DependencyExtractionError[];
    warnings: DependencyExtractionError[];
  }>;
  readReadmeContent(repoPath: string): string;
  checkCompliance(dependencies: Dependency[], readmeContent: string): ComplianceResult;
}

const MAX_README_BYTES = 1024 * 1024;

const TOOL_TAGS: Record<string, string> = {
  'maven-parser': 'maven',
  'gradle-parser': 'gradle',
  'npm-parser': 'npm'
};

/** Formats an extraction problem as a report row, tagged with the build tool that reported it. */
function formatProblem(problem: DependencyExtractionError): string {
  const tag = TOOL_TAGS[problem.source];
  return `  - ${tag ? `[${tag}] ` : ''}${reportText(problem.message)}`;
}

/**
 * Format extraction errors into a detailed string for inclusion in criterion results.
 */
export function formatExtractionErrors(errors: DependencyExtractionError[]): string {
  return errors
    .map(e => {
      const row = formatProblem(e);
      return e.error?.message && !e.message.includes(e.error.message)
        ? `${row}\n    Cause: ${reportText(e.error.message)}`
        : row;
    })
    .join('\n');
}

function formatWarnings(warnings: DependencyExtractionError[]): string {
  return warnings.length > 0 ? `\n\nWarnings:\n${warnings.map(formatProblem).join('\n')}` : '';
}

const COMMAND_STATUS_LABELS: Record<CommandExecutionResult['status'], string> = {
  success: 'Ran',
  failed: 'Failed',
  timed_out: 'Timed out',
  blocked: 'Not run'
};

/** Report sections for compliance issues, most serious first, with the action that resolves each. */
const ISSUE_GROUPS: Array<{ type: LicenseIssueType; title: string; action: string }> = [
  {
    type: LicenseIssueType.CATEGORY_X_VIOLATION,
    title: 'Prohibited licenses (Category X)',
    action: 'Remove or replace prohibited dependencies.'
  },
  {
    type: LicenseIssueType.UNDOCUMENTED_CATEGORY_B,
    title: 'Must be named in the README',
    action: 'Name these dependencies in the README by full name or artifactId.'
  },
  {
    type: LicenseIssueType.UNKNOWN_LICENSE,
    title: 'Licenses the evaluator does not know',
    action: 'Check unknown licenses against the ASF policy.'
  },
  {
    type: LicenseIssueType.NO_LICENSE_INFO,
    title: 'No license reported',
    action: 'Find the missing licenses and check them.'
  },
  {
    type: LicenseIssueType.PARSER_ERROR,
    title: 'License text that could not be read',
    action: 'Check combined license expressions by hand.'
  }
];

/**
 * Find and read README content from a repository, checking common filename variants.
 */
export function findReadmeContent(repoPath: string): string {
  const readmeFiles = ['README.md', 'README.txt', 'README', 'readme.md', 'readme.txt'];

  for (const readmeFile of readmeFiles) {
    const content = readRepoTextFile(repoPath, readmeFile, MAX_README_BYTES);
    if (content !== null) {
      return content;
    }
  }
  return '';
}

/**
 * Build an evidence summary string from a list of dependencies.
 */
export function buildEvidenceSummary(dependencies: Dependency[]): string {
  // Every dependency is listed, so the HTML report's license groups add up to the count.
  // The report parses this exact "Found N dependencies. Licenses: name:version (license); ..." form.
  const licenseInfo = dependencies
    .map(d => `${d.name}:${d.version} (${d.licenses?.length ? d.licenses.join(', ') : 'No license reported'})`)
    .join('; ');
  const count = dependencies.length === 1 ? '1 dependency' : `${dependencies.length} dependencies`;
  return `Found ${count}. Licenses: ${licenseInfo}`;
}

/**
 * Determine the final CriterionResult based on compliance result, evidence, and warnings.
 */
export function determineComplianceStatus(
  criterionId: string,
  complianceResult: ComplianceResult,
  evidence: string,
  warnings: DependencyExtractionError[]
): CriterionResult {
  const warningInfo = formatWarnings(warnings);

  if (complianceResult.compliant) {
    return {
      criterionId,
      status: EvaluationStatus.PASS,
      evidence,
      details: `Every dependency has a license that the ASF 3rd Party License Policy allows. None is prohibited (Category X), and every dependency that must be named in the README (Category B) is named.${warningInfo}`
    };
  }

  const groups = ISSUE_GROUPS
    .map(group => ({ ...group, issues: complianceResult.issues.filter(issue => issue.issueType === group.type) }))
    .filter(group => group.issues.length > 0);
  const issueDetails = groups
    .map(group => `${group.title}:\n${group.issues
      .map(issue => `  - ${reportText(`${issue.dependency.name}:${issue.dependency.version} - ${issue.reason}`)}`)
      .join('\n')}`)
    .join('\n\n');
  const actions = groups.map(group => group.action).join(' ');

  const hasCategoryXViolation = complianceResult.issues.some(issue =>
    issue.issueType === LicenseIssueType.CATEGORY_X_VIOLATION
  );

  if (hasCategoryXViolation) {
    return {
      criterionId,
      status: EvaluationStatus.FAIL,
      evidence,
      details: `Some dependencies use licenses that the ASF 3rd Party License Policy prohibits.\nWhat to do: ${actions}\n\n${issueDetails}${warningInfo}`
    };
  }

  return {
    criterionId,
    status: EvaluationStatus.MANUAL,
    evidence,
    details: `No prohibited licenses were found, but some dependencies need a reviewer to check their licenses.\nWhat to do: ${actions}\n\n${issueDetails}${warningInfo}`
  };
}

/**
 * Deep module for evaluating third-party license compliance (S003).
 */
export class ThirdPartyLicenseEvaluator {
  constructor(
    private readonly adapters: ThirdPartyLicenseEvaluatorAdapters = {
      extractDependencies: getDependencies,
      readReadmeContent: findReadmeContent,
      checkCompliance: checkLicenseCompliance
    }
  ) {}

  /**
   * Evaluates third-party license compliance for any project type.
   */
  async evaluate(repoPath: string, criterionId: string = 'S003', evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    try {
      const previousCommandIdentities = new Set(evaluationRun?.commandObservations.keys() ?? []);
      const extractionResult = await this.adapters.extractDependencies(repoPath, evaluationRun);
      const { dependencies, errors, warnings } = extractionResult;
      const commandObservations = this.getNewCommandObservations(evaluationRun, previousCommandIdentities);

      if (errors.length > 0) {
        return this.withCommandExecutionDetails(this.createExtractionErrorResult(criterionId, errors), commandObservations);
      }

      if (dependencies.length === 0) {
        return this.withCommandExecutionDetails(this.createNoDependenciesResult(criterionId, warnings), commandObservations);
      }

      const readmeContent = this.adapters.readReadmeContent(repoPath);
      const complianceResult = this.adapters.checkCompliance(dependencies, readmeContent);
      const evidence = buildEvidenceSummary(dependencies);

      return this.withCommandExecutionDetails({
        ...determineComplianceStatus(criterionId, complianceResult, evidence, warnings),
        // The HTML report groups dependencies by license from this list rather than from the evidence text.
        criterionDetails: {
          dependencies: dependencies.map(({ name, version, licenses }) => ({ name, version, licenses: licenses ?? [] }))
        }
      }, commandObservations);
    } catch (error) {
      getLogger().warn(`Error evaluating ${criterionId}:`, error);
      return {
        criterionId,
        status: EvaluationStatus.MANUAL,
        evidence: 'The license check stopped with an unexpected error, so dependency licenses were not checked.',
        details: `The license check stopped with an unexpected error: ${reportText(error instanceof Error ? error.message : 'Unknown error')}.\nWhat to do: Check the dependency licenses by hand.`
      };
    }
  }

  private createExtractionErrorResult(
    criterionId: string,
    errors: DependencyExtractionError[]
  ): CriterionResult {
    const blocked = errors.some(error => error.commandsDisabled);
    return {
      criterionId,
      status: EvaluationStatus.MANUAL,
      evidence: blocked
        ? 'Dependency licenses were not checked because build commands are turned off for this evaluation.'
        : 'Dependency licenses were not checked because the dependencies could not be listed.',
      details: 'S003 lists dependencies by running Maven, Gradle or npm, and that step did not work.\n' +
        (blocked
          ? 'What to do: Rerun the evaluation with --allow-local-commands on a trusted machine, or check the dependency licenses by hand.'
          : 'What to do: Fix the problem below and rerun the evaluation, or check the dependency licenses by hand.') +
        `\n\nWhy the dependencies could not be listed:\n${formatExtractionErrors(errors)}`
    };
  }

  private createNoDependenciesResult(
    criterionId: string,
    warnings: DependencyExtractionError[]
  ): CriterionResult {
    return {
      criterionId,
      status: EvaluationStatus.MANUAL,
      evidence: 'No third-party dependencies were found.',
      details: 'No third-party dependencies were found. This is unusual for a FOLIO module: it may be a library or configuration-only project, or the build files may not have been recognized.\n' +
        `What to do: Confirm that the module really has no third-party dependencies.${formatWarnings(warnings)}`
    };
  }

  private getNewCommandObservations(
    evaluationRun: EvaluationRun | undefined,
    previousIdentities: Set<string>
  ): CommandExecutionResult[] {
    return Array.from(evaluationRun?.commandObservations.values() ?? [])
      .filter(command => !previousIdentities.has(command.identity));
  }

  private withCommandExecutionDetails(
    result: CriterionResult,
    observations: CommandExecutionResult[]
  ): CriterionResult {
    if (observations.length === 0) {
      return result;
    }

    const lines = observations.map(command => {
      const where = command.commandExecutionEnvironment === 'github-actions' ? ' (in GitHub Actions)' : '';
      return `  - ${COMMAND_STATUS_LABELS[command.status]}: ${reportText(`${command.command} ${command.args.join(' ')}`)}${where}`;
    });

    return {
      ...result,
      details: `${result.details ?? ''}\n\nBuild commands:\n${lines.join('\n')}`
    };
  }
}

const defaultThirdPartyLicenseEvaluator = new ThirdPartyLicenseEvaluator();

/**
 * Evaluates third-party license compliance (S003) for any project type.
 * This is a language-agnostic evaluation that works with Maven, Gradle, and npm projects
 * through the dependency-orchestrator auto-detection.
 *
 * @param repoPath Path to the repository to evaluate
 * @returns CriterionResult for S003 evaluation
 */
export async function evaluateS003ThirdPartyLicenses(
  repoPath: string,
  evaluationRun?: EvaluationRun
): Promise<CriterionResult> {
  return await defaultThirdPartyLicenseEvaluator.evaluate(repoPath, 'S003', evaluationRun);
}
