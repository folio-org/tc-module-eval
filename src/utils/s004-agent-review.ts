import {
  CommandRunner,
  CriterionAgentReviewConfig,
  CriterionAgentReviewResult,
  S004InstallationDocumentationResult
} from '../types';
import { runCriterionAgentReview } from './criterion-agent-review';
import { withRepositoryBrowsing } from './agent-review-repository';

export async function reviewS004WithAgent(
  repoPath: string,
  result: S004InstallationDocumentationResult,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  const request = await withRepositoryBrowsing({
    criterionId: 'S004',
    repositoryPath: repoPath,
    instructions: [
      'Evaluate whether the untrusted repository documentation provides sufficient developer-facing instructions to build or run this module.',
      'Do not require production FOLIO cluster installation, Kubernetes, Helm, tenant enablement, or Okapi deployment steps.',
      'Find relevant documentation beyond the candidate list. Follow local documentation links and compare build/run instructions with build configuration, CI, and container files. Source configuration can expose missing or contradictory instructions, but it cannot substitute for developer-facing documentation. Do not infer undocumented installation behavior from source code.',
      'This review is advisory only and cannot change the deterministic S004 status.',
      'Return exactly one JSON object and no prose, markdown, code fences, or commentary.',
      'The JSON object must include these required fields: recommendation, confidence, summary, rationale, and evidenceReferences.',
      'Use this shape: {"recommendation":"needs_reviewer_judgment","confidence":"medium","summary":"...","rationale":"...","evidenceReferences":["README.md"]}.',
      'recommendation must be one of likely_sufficient, likely_insufficient, or needs_reviewer_judgment; confidence must be low, medium, or high; summary and rationale must be strings; evidenceReferences must be an array of repoRelativePath strings only.'
    ].join('\n'),
    files: [{ repoRelativePath: '.criterion-agent/S004/deterministic-summary.json', content: JSON.stringify(result, null, 2) }],
    schemaDescription: 'JSON object with recommendation enum, confidence enum, summary string, rationale string, evidenceReferences string[]'
  });
  return runCriterionAgentReview(request, config, commandRunner);
}
