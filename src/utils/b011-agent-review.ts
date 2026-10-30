import { B011Analysis, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

export function hasB011AgentReviewMaterial(analysis: B011Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB011WithAgent(
  repoPath: string,
  analysis: B011Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB011AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return { ...unavailableResult('B011'), errors: [redactEvaluatorSecrets(`Unable to prepare B011 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildB011AgentReviewRequest(repoPath: string, analysis: B011Analysis): CriterionAgentReviewRequest {
  const own = analysis.ownSchemas.length
    ? `The module's own schema is <tenant>_${analysis.ownSchemas.join(' or <tenant>_')}; references to it are not listed.`
    : 'The module\'s own name is not known, so a listed schema may be its own; say so when it is.';
  return buildBackendAgentReviewRequest({
    criterionId: 'B011',
    repositoryPath: repoPath,
    criterionTitle: 'B011: the module does not access other modules\' database schemas (FQM excepted)',
    checklist: analysis.checklist,
    discoveredKinds: ['schema'],
    browse: backendBrowse(),
    criterionInstructions: [
      `A tenant's schema is <tenant>_<module> with the module name's hyphens as underscores, such as diku_mod_users. ${own}`,
      'RMB runs a script that templates/db_scripts/schema.json lists under scripts on a tenant\'s first install, and then on every upgrade unless it has fromModuleVersion, in which case only on upgrades from an older version. A Liquibase changeset runs once per tenant unless it has runAlways or runOnChange. A Grails database migration runs once per tenant.',
      'B011-C1: each obligation is one file\'s references to one other module\'s schema (or to a schema name built at runtime). Decide whether the module reads or writes that schema when it runs. aligned_fact when the code is unreachable, belongs to FQM, or is a one-time migration that copies data while upgrading and tolerates the other schema being absent (name the guard and how often it runs); substantive_concern when the module accesses the schema at runtime, on every install or upgrade, or fails when the other module is absent; analyzer_limitation when the name is not another module\'s schema (the module\'s own or former name, a comment the tool misread); policy_question when only a one-time migration remains and its acceptability is a policy decision.',
      'Search the sources and scripts for other modules\' schemas the checklist does not list, such as names built from a tenant and a module name, search_path changes, or a datasource pointed at another module\'s schema, and report each as discovered:schema:<n>, citing the file.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      return {
        criterionId: 'B011',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        storage: analysis.storage,
        ownSchemas: analysis.ownSchemas,
        filesRead: analysis.filesRead,
        ownSchemaReferences: analysis.ownSchemaReferences,
        references: list(analysis.references.map(reference => ({ ...reference, occurrences: reference.occurrences.slice(0, maxEntries) }))),
        unreadRmbSchemas: list(analysis.unreadRmbSchemas),
        unreadFiles: list(analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message))
      };
    }
  });
}
