import { B015Analysis, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

export function hasB015AgentReviewMaterial(analysis: B015Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB015WithAgent(
  repoPath: string,
  analysis: B015Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB015AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return { ...unavailableResult('B015'), errors: [redactEvaluatorSecrets(`Unable to prepare B015 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

/**
 * B015's review: one obligation per file with sites of a checklist item, or the whole item when the tool found none,
 * each judged for a deployment of several instances; sites the tool missed are `discovered:site:<n>`.
 */
export function buildB015AgentReviewRequest(repoPath: string, analysis: B015Analysis): CriterionAgentReviewRequest {
  return buildBackendAgentReviewRequest({
    criterionId: 'B015',
    repositoryPath: repoPath,
    criterionTitle: 'B015: the module is highly available, so it runs correctly as several instances behind a load balancer without session affinity',
    checklist: analysis.checklist,
    discoveredKinds: ['site'],
    browse: backendBrowse(),
    criterionInstructions: [
      'Assume two or more instances of the module serve the same tenants, any request can reach any instance, and instances are restarted or replaced at any time.',
      'An obligation with a subject is one file: read every starting point of its item in that file (checklist.json gives their lines) and decide whether the item\'s desired state holds for all of them. An obligation without a subject is the whole item: search the browse scope for anything of that kind.',
      'B015-C1: look for HTTP session state (HttpSession, session attributes, Vert.x sessions) or cookies that tie a client to one instance. Sticky routing is deployment configuration; say whether the README, Dockerfile or descriptor asks for it.',
      'B015-C2: decide whether a file written to local disk is read again by a later request, job or instance, or is the only copy of the data. A temporary file is fine when the same request or job deletes it (look for delete calls and finally blocks); data that must survive belongs in the database or object storage.',
      'B015-C3: decide whether each cache or map is rebuilt from shared storage on a miss, and how stale it can get when another instance changes the data (expiry, invalidation, tenant in the key). A map that holds data other instances need, such as job progress, locks or queued work, is a substantive_concern.',
      'B015-C4: decide whether each scheduled job runs on every instance and whether that is safe: idempotent work, a database or ShedLock lock, or work Okapi triggers through a _timer interface (Okapi calls one instance) are fine; duplicated side effects such as sending notices twice are a substantive_concern.',
      'A substantive_concern says in its summary what goes wrong with two instances. Cite the file and say which lines you read.',
      'Report a site of the same four kinds that checklist.json does not list as discovered:site:<n>, citing its file.'
    ],
    evidenceSummary: maxEntries => ({
      criterionId: 'B015',
      deterministicStatus: analysis.status,
      summary: analysis.summary,
      repositoryKind: analysis.kind,
      sourceFileCount: analysis.sourceFileCount,
      counts: analysis.counts,
      signals: { items: analysis.signals.slice(0, maxEntries), ...(analysis.signals.length > maxEntries ? { omitted: analysis.signals.length - maxEntries } : {}) },
      unreadFiles: analysis.sourceDiagnostics.slice(0, maxEntries).map(diagnostic => diagnostic.path ?? diagnostic.message)
    })
  });
}
