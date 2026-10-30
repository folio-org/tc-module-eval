import { B004Analysis, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { B004Policy } from './b004-env-variables';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

const POLICY_FILE = '.criterion-agent/B004/environment-variables-policy.md';

export function hasB004AgentReviewMaterial(analysis: B004Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB004WithAgent(
  repoPath: string,
  analysis: B004Analysis,
  policy: B004Policy | undefined,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB004AgentReviewRequest(repoPath, analysis, policy);
  } catch (error) {
    return { ...unavailableResult('B004'), errors: [redactEvaluatorSecrets(`Unable to prepare B004 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildB004AgentReviewRequest(repoPath: string, analysis: B004Analysis, policy: B004Policy | undefined): CriterionAgentReviewRequest {
  return buildBackendAgentReviewRequest({
    criterionId: 'B004',
    repositoryPath: repoPath,
    criterionTitle: 'B004: the module\'s environment variables follow the FOLIO Environment Variables policy',
    checklist: analysis.checklist,
    discoveredKinds: ['env'],
    browse: backendBrowse(),
    ...(policy ? { extraFiles: [{ name: 'environment-variables-policy.md', content: policy.text }] } : {}),
    criterionInstructions: [
      ...(policy ? [`${POLICY_FILE} is the policy (page version ${policy.pageVersion}). Section 4 defines required variables and startup behaviour, section 6.1 startup logging.`] : []),
      'Only a Markdown table in ENV_VARS.md or README.md counts as documentation; the descriptor\'s env lists do not. Groovy and Kotlin "${...}" strings and dotted Spring properties such as ${spring.application.name} are not environment variables.',
      'B004-C1: for each System.getenv read whose name the tool could not read, follow the argument to its constants or callers, name the variables it can read, and say whether each is documented. aligned_fact when every one is documented; substantive_concern when one is not; evidence_gap when the names cannot be established. '
        + 'For an obligation without a subject, check that the variables in evidence-summary.json are all the module reads.',
      'B004-C4: for each variable, decide whether the module needs it to start and, if so, whether startup stops with a clear message when it is missing or empty (policy sections 4.2 and 4.3). '
        + 'aligned_fact when it is optional with a working default, or required and startup fails fast with a clear message; substantive_concern when a required variable has no clear failure (startup continues, or fails later with an unclear error); evidence_gap when the code does not show it. Cite the code that reads it.',
      'B004-C5: for each log statement, decide whether startup logs print a secret value (a password, key or token) or the whole environment. aligned_fact when what is logged is not secret (a length, a flag, a name); substantive_concern when a secret value or the environment is printed.',
      'Each obligation names a file in path: cite that file in the assessment\'s evidenceReferences, together with the code you read. A variable listed only in the descriptor template is about its entry there.',
      'Report an environment variable the module reads that evidence-summary.json does not list under variables as discovered:env:<n>, citing the source that reads it.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      return {
        criterionId: 'B004',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        kind: analysis.kind,
        existingModule: analysis.existingModule,
        templatePath: analysis.templatePath,
        topLevelEnv: analysis.topLevelEnv,
        documentationFiles: analysis.documentationFiles,
        variables: list(analysis.variables.map(variable => ({
          name: variable.name,
          sources: variable.sources.slice(0, 3),
          ...(variable.documentation ? { documentation: variable.documentation } : {}),
          ...(variable.required === undefined ? {} : { required: variable.required }),
          ...(variable.defaultFrom ? { defaultFrom: variable.defaultFrom } : {}),
          problems: variable.problems
        }))),
        unreadReads: list(analysis.unreadReads),
        logSignals: list(analysis.logSignals)
      };
    }
  });
}
