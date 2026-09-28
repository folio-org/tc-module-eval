import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, S007AnalysisResult, S007OfficiallySupportedTechnologiesPolicy } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview } from './criterion-agent-review';

export async function reviewS007WithAgent(
  repoPath: string,
  analysis: S007AnalysisResult,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner,
  policy?: S007OfficiallySupportedTechnologiesPolicy
): Promise<CriterionAgentReviewResult> {
  const request = await buildS007AgentReviewRequest(repoPath, analysis, policy);
  const review = await runCriterionAgentReview(request, config, commandRunner);
  if (!review.available) return review;
  const known = new Set(analysis.findings.map(finding => finding.technologyId));
  const canonical = new Set(policy?.sections.filter(section => section.consumer === 's007')
    .flatMap(section => section.entries.map(entry => entry.id)));
  for (const assessment of review.assessments ?? []) {
    const id = assessment.technologyId;
    if (!known.has(id) && canonical.has(id) && /^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      assessment.technologyId = `discovered:${id}`;
      review.warnings.push(`Normalized trusted policy identifier ${id} to discovered:${id}.`);
    }
  }
  const invalid = validateS007Review(analysis, review);
  return invalid ? { ...review, available: false, errors: [...review.errors, invalid] } : review;
}

export async function buildS007AgentReviewRequest(
  repoPath: string,
  analysis: S007AnalysisResult,
  policy?: S007OfficiallySupportedTechnologiesPolicy
): Promise<CriterionAgentReviewRequest> {
  return {
    criterionId: 'S007',
    repositoryPath: repoPath,
    instructions: [
      'Review officially supported technologies using the supplied trusted policy and committed repository source. Investigate manifests, parent configuration, version properties, lockfiles, containers, and CI to resolve effective technologies and versions, including declarations missed by the analyzer. Do not assume a test or CI version is the deployed runtime version.',
      'Assess practical significance instead of restating uncertainty. Distinguish aligned facts, substantive concerns, analyzer limitations, evidence gaps, and policy questions.',
      'Treat a missing or unresolved version as an evidence gap unless repository evidence establishes a substantive mismatch. External parents and dependency internals absent from the snapshot remain unverified; do not infer their contents from memory.',
      'When repository evidence satisfies a policy general rule, report that aligned fact; do not turn an unneeded exception into an evidence gap.',
      'Do not reinterpret the current OST JSON or invent policy. Only the supplied policy context is authoritative. If policy is unavailable or its applicability is unclear, retain that uncertainty and request TC interpretation rather than claiming compliance.',
      'This review is advisory only. Do not change, approve, reject, pass, or fail the deterministic S007 status.',
      'The generated summary provides policy context but is not repository evidence. Before returning, check each evidenceReferences array separately: every assessment and action must cite repository source, including policy questions. Cite the declaration that makes the question relevant.',
      'Use a technologyId from the deterministic summary, or discovered:<normalized-id> for a technology missed by the analyzer.',
      'Use likely_insufficient only when an assessment identifies a substantive_concern supported by repository evidence.',
      'Use needs_reviewer_judgment only when reviewerActions names a narrow action that can resolve an evidence gap or policy question.',
      'Each reviewer action must name the exact missing artifact or fact to obtain and the decision it will resolve; do not merely say to review, check, or confirm compliance.',
      'Return only JSON with recommendation, confidence, summary, rationale, evidenceReferences, assessments, and reviewerActions.',
      'Each assessment must contain technologyId, type, summary, and evidenceReferences. type must be aligned_fact, substantive_concern, analyzer_limitation, evidence_gap, or policy_question.',
      'Each reviewer action must contain action and evidenceReferences. recommendation must be likely_sufficient, likely_insufficient, or needs_reviewer_judgment; confidence must be low, medium, or high.'
    ].join('\n'),
    files: [{
      repoRelativePath: '.criterion-agent/S007/deterministic-summary.json',
      content: JSON.stringify(analysis, null, 2)
    }, {
      repoRelativePath: '.criterion-agent/S007/policy-context.json',
      content: JSON.stringify(policy ?? { unavailable: true, diagnostics: analysis.policyDiagnostics }, null, 2)
    }],
    schemaDescription: 'JSON object with recommendation enum, confidence enum, summary string, rationale string, repository evidenceReferences string[], nonempty cited assessments[], and cited reviewerActions[]'
  };
}

function validateS007Review(analysis: S007AnalysisResult, review: CriterionAgentReviewResult): string | undefined {
  if (!review.assessments?.length) return 'S007 agent review returned no cited practical assessments.';
  const technologyIds = new Set(analysis.findings.map(finding => finding.technologyId));
  if (review.assessments.some(assessment => !technologyIds.has(assessment.technologyId)
    && !/^discovered:[a-z0-9][a-z0-9._-]*$/.test(assessment.technologyId))) {
    return 'S007 agent review returned an assessment for an unknown technology.';
  }
  if (review.recommendation === 'likely_insufficient'
    && !review.assessments.some(assessment => assessment.type === 'substantive_concern')) {
    return 'S007 likely_insufficient recommendation did not identify a cited substantive concern.';
  }
  if (review.recommendation === 'needs_reviewer_judgment' && !review.reviewerActions?.length) {
    return 'S007 needs_reviewer_judgment recommendation did not provide a cited reviewer action.';
  }
  return undefined;
}
