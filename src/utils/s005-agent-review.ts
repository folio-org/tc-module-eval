import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, S005PersonalDataDisclosureAnalysisResult } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview } from './criterion-agent-review';
import { withRepositoryBrowsing } from './agent-review-repository';
import { boundS005Text, MAX_S005_EVIDENCE_TEXT_BYTES_PER_FILE } from './s005-personal-data-disclosure';

export async function reviewS005WithAgent(
  repoPath: string,
  analysis: S005PersonalDataDisclosureAnalysisResult,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  const request = await buildS005AgentReviewRequest(repoPath, analysis);
  return runCriterionAgentReview(request, config, commandRunner);
}

export async function buildS005AgentReviewRequest(
  repoPath: string,
  analysis: S005PersonalDataDisclosureAnalysisResult
): Promise<CriterionAgentReviewRequest> {
  return withRepositoryBrowsing({
    criterionId: 'S005',
    repositoryPath: repoPath,
    instructions: [
      'Evaluate whether PERSONAL_DATA_DISCLOSURE.md is consistent with the repository. Investigate schemas, API contracts, storage, logging, and data flows, including paths missed by the deterministic scan. Distinguish personal data actually handled from incidental examples and field-name matches.',
      'Compare declared categories with cited source behavior. An unchecked category is not a defect unless repository evidence supports a mismatch. Do not infer complete absence of personal data from a search with no matches.',
      'Do not claim legal compliance, GDPR compliance, CCPA compliance, institutional privacy approval, certification, or that the disclosure is definitively accurate.',
      'This review is advisory only for Technical Council reviewer judgment. Agent advice must not decide the final S005 status.',
      'Return exactly one JSON object, without prose or Markdown fences: {"recommendation":"needs_reviewer_judgment","confidence":"medium","summary":"...","rationale":"...","evidenceReferences":["PERSONAL_DATA_DISCLOSURE.md","schemas/user.json"]}.',
      'recommendation must be likely_sufficient, likely_insufficient, or needs_reviewer_judgment; confidence must be low, medium, or high. Cite actual inspected repository files.'
    ].join('\n'),
    files: [{
      repoRelativePath: '.criterion-agent/S005/parsed-disclosure-summary.json',
      content: boundS005Text(JSON.stringify({
        parseState: analysis.classification.parseState,
        classificationReason: analysis.classification.reason,
        metadata: analysis.parseResult?.metadata,
        checkedCategories: analysis.parseResult?.checkedCategories ?? [],
        uncheckedCategories: analysis.parseResult?.uncheckedCategories ?? [],
        contradictions: analysis.contradictions,
        possibleMismatches: analysis.possibleMismatches,
        matchingEvidence: analysis.matchingEvidence,
        supportingEvidence: analysis.supportingEvidence,
        warnings: analysis.warnings
      }, null, 2), MAX_S005_EVIDENCE_TEXT_BYTES_PER_FILE)
    }],
    schemaDescription: 'JSON object with recommendation enum, confidence enum, nonblank summary and rationale, nonempty repository evidenceReferences string[]'
  });
}
