import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, S006SensitiveInformationAnalysisResult } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview } from './criterion-agent-review';
import { withRepositoryBrowsing } from './agent-review-repository';
import { truncateToByteBudget } from './redaction';

export async function reviewS006WithAgent(
  repoPath: string,
  analysis: S006SensitiveInformationAnalysisResult,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  const request = await buildS006AgentReviewRequest(repoPath, analysis);
  return runCriterionAgentReview(request, config, commandRunner);
}

export async function buildS006AgentReviewRequest(
  repoPath: string,
  analysis: S006SensitiveInformationAnalysisResult
): Promise<CriterionAgentReviewRequest> {
  return withRepositoryBrowsing({
    criterionId: 'S006',
    repositoryPath: repoPath,
    instructions: [
      'Evaluate whether committed sensitive or environment-specific information needs reviewer attention. Investigate surrounding source, configuration, CI, documentation, fixtures, and usage paths, including files absent from the scanner findings. Distinguish production usage from examples, synthetic fixtures, and local defaults using cited context.',
      'Scan coverage uncertainty is not itself proof of a leaked secret. Report exclusions and unresolved usage honestly; do not claim the repository is secret-free.',
      'Do not claim that any credential, token, key, password, private URL, credential URL, endpoint, or secret is live, valid, exploitable, revoked, or safe. Never test credentials or contact endpoints. Do not reproduce secret values in your response; cite paths and describe their role instead.',
      'This review is advisory only for Technical Council reviewer judgment. Agent advice must not decide the final S006 status.',
      'Return exactly one JSON object, without prose or Markdown fences: {"recommendation":"needs_reviewer_judgment","confidence":"medium","summary":"...","rationale":"...","evidenceReferences":["path/to/source"]}.',
      'recommendation must be likely_sufficient, likely_insufficient, or needs_reviewer_judgment; confidence must be low, medium, or high. Cite actual inspected repository files.'
    ].join('\n'),
    files: [{
      repoRelativePath: '.criterion-agent/S006/finding-summary.json',
      content: truncateToByteBudget(JSON.stringify({
        criterionId: analysis.criterionId,
        classification: analysis.classification,
        findings: analysis.findings.map(({ valueFingerprint: _fingerprint, ...finding }) => finding),
        coverage: analysis.coverage
      }, null, 2), 24 * 1024)
    }],
    schemaDescription: 'JSON object with recommendation enum, confidence enum, nonblank summary and rationale, nonempty repository evidenceReferences string[]'
  });
}
