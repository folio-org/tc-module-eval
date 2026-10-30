import { B008Analysis, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

const LISTING = 'reference-data-listing.txt';
const MAX_LISTED = 2_000;

export function hasB008AgentReviewMaterial(analysis: B008Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB008WithAgent(
  repoPath: string,
  analysis: B008Analysis,
  listedPaths: string[],
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB008AgentReviewRequest(repoPath, analysis, listedPaths);
  } catch (error) {
    return { ...unavailableResult('B008'), errors: [redactEvaluatorSecrets(`Unable to prepare B008 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildB008AgentReviewRequest(repoPath: string, analysis: B008Analysis, listedPaths: string[]): CriterionAgentReviewRequest {
  const listing = [...listedPaths.slice(0, MAX_LISTED), ...(listedPaths.length > MAX_LISTED ? [`... ${listedPaths.length - MAX_LISTED} more`] : [])];
  return buildBackendAgentReviewRequest({
    criterionId: 'B008',
    repositoryPath: repoPath,
    criterionTitle: 'B008: a module that stores data provides reference data for the controlled vocabularies it needs',
    checklist: analysis.checklist,
    discoveredKinds: ['vocabulary'],
    browse: backendBrowse({
      include: () => false,
      scope: `and .criterion-agent/B008/${LISTING}, which lists the files in ref-data/ and reference-data/ folders, including test and non-JSON files B008 does not count (their contents are not browsable)`
    }),
    extraFiles: [{ name: LISTING, content: listing.length ? `${listing.join('\n')}\n` : 'No files in ref-data/ or reference-data/ folders.\n' }],
    criterionInstructions: [
      'A controlled vocabulary is a list of values that other records refer to, such as types, statuses, reasons and categories. Reference data is the set of values the module creates for each tenant at tenant initialization: RMB TenantLoading with the loadReference key, a Spring loadReferenceData() override or tenant service, Liquibase changesets, Grails @Defaults, or similar code.',
      'B008-C1, an obligation with a subject: the subject is a vocabulary (an endpoint path or a Grails refdata category) for which the tool found no reference data. aligned_fact when tenant initialization creates at least one value for it, or when the module needs none (users create every value, or it is not a vocabulary); substantive_concern when the module needs a value and none is created; evidence_gap when the source does not settle it. Cite the obligation\'s own path, and the code or changelog that creates values.',
      'B008-C1, an obligation without a subject: the tool found no vocabulary, or could not read everything. Decide whether the module has controlled vocabularies that need a value after tenant initialization, and whether each has one. Report each such vocabulary without a value as discovered:vocabulary:<n>, citing its endpoint or domain class.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      return {
        criterionId: 'B008',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        framework: analysis.framework.name,
        storage: analysis.storage.evidence,
        templatePath: analysis.templatePath,
        loaders: list(analysis.loaders),
        referenceDataFolders: list(analysis.referenceDataFolders),
        liquibaseInserts: list(analysis.liquibaseInserts),
        vocabularies: list(analysis.vocabularies.map(vocabulary => ({ ...vocabulary, sources: list(vocabulary.sources), notCounted: list(vocabulary.notCounted) }))),
        unreadLoadPaths: list(analysis.unreadLoadPaths),
        unreadSource: list(analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message))
      };
    }
  });
}
