import { B012Analysis, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

export function hasB012AgentReviewMaterial(analysis: B012Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB012WithAgent(
  repoPath: string,
  analysis: B012Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB012AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return { ...unavailableResult('B012'), errors: [redactEvaluatorSecrets(`Unable to prepare B012 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildB012AgentReviewRequest(repoPath: string, analysis: B012Analysis): CriterionAgentReviewRequest {
  const readme = analysis.readmePaths.join(', ') || 'README.md (there is none at the repository root)';
  return buildBackendAgentReviewRequest({
    criterionId: 'B012',
    repositoryPath: repoPath,
    criterionTitle: 'B012: the non-interface dependencies of the module (infrastructure, external services, and Kafka topics of other modules) are declared in README.md',
    checklist: analysis.checklist,
    discoveredKinds: ['service', 'topic'],
    browse: backendBrowse(),
    criterionInstructions: [
      `The README is ${readme}. evidence-summary.json lists the infrastructure the tool found and whether the README names it; do not assess that infrastructure again.`,
      'B012-C1: find the external services the module calls that are neither FOLIO interfaces (requests through Okapi or Kong to other modules) nor the infrastructure listed, such as mail servers, LDAP, identity providers or third-party HTTP APIs, and check whether the README names each. aligned_fact when every one is named or there is none; substantive_concern when one is not named. Report each service the README does not name as discovered:service:<n>, citing the source that calls it.',
      'B012-C2: find the Kafka topics the module consumes from or produces for other modules (not topics only the module itself reads and writes), and check whether the README names each. aligned_fact when every one is named or there is none; substantive_concern when one is not named. Report each topic the README does not name as discovered:topic:<n>, citing the source that subscribes or sends to it. An unnamed topic is advice for the reviewer; it never fails B012.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      return {
        criterionId: 'B012',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        readmePaths: analysis.readmePaths,
        readme: analysis.basis,
        infrastructure: list(analysis.infrastructure.map(item => ({
          id: item.id, name: item.name, usage: item.usage, namedInReadme: item.namedAs ?? null, signals: list(item.signals)
        }))),
        unreadFiles: list(analysis.diagnostics)
      };
    }
  });
}
