import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, F002Analysis } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { buildFrontendAgentReviewRequest, frontendBrowseInclude, givenObligations } from './frontend-agent-review';
import { isF002BrowsePath } from './f002-e2e-tests';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

export function hasF002AgentReviewMaterial(analysis: F002Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewF002WithAgent(
  repoPath: string,
  analysis: F002Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildF002AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return { ...unavailableResult('F002'), errors: [redactEvaluatorSecrets(`Unable to prepare F002 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

/** F002's review: classify each browser test setup as component or end-to-end tests, and say which runner CI uses. */
export function buildF002AgentReviewRequest(repoPath: string, analysis: F002Analysis): CriterionAgentReviewRequest {
  const productionScope = frontendBrowseInclude();
  const policy = analysis.policy.loaded ? `"${analysis.policy.sourceStatement}"` : 'Cypress 12.0';
  return buildFrontendAgentReviewRequest({
    criterionId: 'F002',
    repositoryPath: repoPath,
    criterionTitle: 'F002: if the repository provides end-to-end tests, they use a supported technology',
    checklist: analysis.checklist,
    discoveredKinds: [],
    browseInclude: path => productionScope(path) || isF002BrowsePath(path),
    browseScope: analysis.agentBrowseScope,
    criterionInstructions: [
      `The officially supported technologies page lists one technology for UI integration and end-to-end testing: ${policy}. Karma, BigTest and every other browser test tool are not listed. Jest with React Testing Library in jsdom is unit testing and out of scope here.`,
      'An end-to-end test drives a running FOLIO UI and backend through a browser. A component test renders components in a browser or test runner without a running FOLIO system, usually with mocked network responses (for example BigTest with Mirage).',
      'F002-C1: for each framework in checklist.json, read its configuration and a sample of its test files, and decide what kind of tests they are. aligned_fact when they are component tests, or end-to-end tests in Cypress at or above the listed version; substantive_concern when they are end-to-end tests in another framework or an older Cypress; evidence_gap when the source does not settle it. Cite the obligation\'s own path from checklist.json (often package.json) as well as the test files you read.',
      'F002-C2: read the CI files (.github/workflows/, Jenkinsfile) and the package.json scripts they call, and say which test runner each CI job uses. A job that uses folio-org/.github/.github/workflows/ui.yml runs jest-test-command (default yarn test) unless jest-enabled is false, and bigtest-test-command (default yarn test) when bigtest-enabled is true. aligned_fact when CI runs end-to-end tests only with the supported framework, or runs none; substantive_concern when it runs them with another framework.'
    ],
    evidenceSummary: maxEntries => ({
      criterionId: 'F002',
      deterministicStatus: analysis.status,
      summary: analysis.summary,
      frameworks: analysis.frameworks.map(framework => ({
        name: framework.displayName,
        support: framework.support,
        evidence: framework.evidence.slice(0, maxEntries),
        ...(framework.evidence.length > maxEntries ? { omittedEvidence: framework.evidence.length - maxEntries } : {})
      })),
      ...(analysis.cypress ? { cypressVersion: analysis.cypress } : {}),
      policy: analysis.policy,
      ciFiles: analysis.ciFiles,
      unread: analysis.unread
    })
  });
}
