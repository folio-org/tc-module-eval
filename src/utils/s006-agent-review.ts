import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, S006SensitiveInformationAnalysisResult } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview } from './criterion-agent-review';

export async function reviewS006WithAgent(
  repoPath: string,
  analysis: S006SensitiveInformationAnalysisResult,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  const request = await buildS006AgentReviewRequest(repoPath, analysis);
  return runCriterionAgentReview(request, config, commandRunner);
}

function validateS006Review(
  obligations: ReturnType<typeof reviewObligations>,
  review: CriterionAgentReviewResult,
  availableSourcePaths: ReadonlySet<string>
): string | undefined {
  const assessments = review.assessments ?? [];
  let invalid: string | undefined;
  if (obligations.some(item => assessments.filter(a => a.technologyId === item.id).length !== 1)
    || new Set(assessments.map(a => a.technologyId)).size !== assessments.length
    || assessments.some(a => (!obligations.some(item => item.id === a.technologyId)
      && !/^discovered:[a-z0-9][a-z0-9._-]*$/.test(a.technologyId)) || !a.coverageDisposition)) {
    invalid = 'S006 requires exactly one coverage disposition for every supplied review obligation.';
  } else if (obligations.some(item => item.path && assessments.some(a => a.technologyId === item.id
    && a.coverageDisposition === 'investigated' && (!availableSourcePaths.has(item.path!) || !a.evidenceReferences.includes(item.path!))))) {
    invalid = 'S006 cannot claim direct investigation of an unavailable or uncited finding or coverage path.';
  } else if (obligations.some(item => item.path && item.id.startsWith('finding:') && !availableSourcePaths.has(item.path)
    && assessments.some(a => a.technologyId === item.id && a.coverageDisposition !== 'unresolved'))) {
    invalid = 'S006 findings whose source is excluded must remain unresolved; contextual documentation cannot establish their committed contents.';
  } else if (assessments.some(a => a.coverageDisposition === 'unresolved' && a.type === 'aligned_fact')) {
    invalid = 'S006 unresolved obligations cannot be labeled aligned facts.';
  } else if (review.recommendation === 'likely_sufficient' && assessments.some(a =>
    a.coverageDisposition === 'unresolved' || ['evidence_gap', 'policy_question', 'substantive_concern'].includes(a.type))) {
    invalid = 'S006 likely_sufficient conflicts with unresolved coverage or finding dispositions.';
  } else if (review.recommendation === 'likely_insufficient' && !assessments.some(a => a.type === 'substantive_concern')) {
    invalid = 'S006 likely_insufficient requires a cited substantive concern, not merely incomplete coverage.';
  } else if (review.recommendation === 'needs_reviewer_judgment' && !review.reviewerActions?.length) {
    invalid = 'S006 needs_reviewer_judgment requires a cited action identifying the missing fact.';
  }
  return invalid;
}

function reviewObligations(analysis: S006SensitiveInformationAnalysisResult): Array<{ id: string; description: string; path?: string }> {
  const gaps = new Map<string, { id: string; description: string; path?: string }>();
  for (const warning of analysis.coverage.warnings.filter(item => item.materialToCoverage)) {
    const id = `gap:${warning.path ?? warning.kind}`;
    gaps.set(id, { id, description: warning.message, path: warning.path });
  }
  for (const skipped of analysis.coverage.skippedFiles.filter(item => item.materialToCoverage)) {
    const id = `gap:${skipped.path}`;
    if (!gaps.has(id)) gaps.set(id, { id, description: skipped.message ?? skipped.reason, path: skipped.path });
  }
  if (!analysis.coverage.complete && !gaps.size) {
    gaps.set('gap:incomplete', { id: 'gap:incomplete', description: 'Scanner coverage is incomplete.' });
  }
  return [
    { id: 'scope', description: 'Describe additional source investigated and remaining limitations. This is scoped advice, never repository-wide certification.' },
    ...analysis.findings.map((finding, index) => ({ id: `finding:${index}`, path: finding.path, description: `Disposition for scanner finding ${index}.` })),
    ...gaps.values()
  ];
}

export async function buildS006AgentReviewRequest(
  repoPath: string,
  analysis: S006SensitiveInformationAnalysisResult
): Promise<CriterionAgentReviewRequest> {
  const obligations = reviewObligations(analysis);
  return {
    criterionId: 'S006',
    repositoryPath: repoPath,
    coverageGapIds: obligations.filter(item => item.id.startsWith('gap:')).map(item => item.id),
    instructions: [
      'Evaluate whether committed sensitive or environment-specific information needs reviewer attention. Investigate surrounding source, configuration, CI, documentation, fixtures, and usage paths, including files absent from the scanner findings. Distinguish production usage from examples, synthetic fixtures, and local defaults using cited context.',
      'Scan coverage uncertainty is not itself proof of a leaked secret. Report exclusions and unresolved usage honestly; do not claim the repository is secret-free.',
      'Return exactly one assessment for each reviewObligations ID using it as technologyId. Each assessment needs type (aligned_fact, substantive_concern, analyzer_limitation, evidence_gap, policy_question), summary, repository evidenceReferences, and coverageDisposition (investigated, immaterial, unresolved). For investigated path obligations, cite the original path as well as relevant usage. For immaterial, explain from cited context why the omission does not affect this scoped decision; do not imply direct inspection. Excluded source is not inspected source.',
      'For additional findings discovered outside the scanner inventory, add assessments using discovered:<normalized-id> with the same fields. Do not omit new concerns merely because there is no supplied obligation ID.',
      'sourceAvailable=false means the source cannot be inspected in this snapshot, NOT that it is uncommitted or absent from the repository. A scanner finding with unavailable source must remain unresolved (evidence_gap); documentation can supply context, but cannot establish the actual excluded contents. Cite related available usage and request inspection of the excluded file, without reproducing credential values or assignments.',
      'Narrow citation exception: an unresolved evidence_gap assessment for a supplied gap: ID may cite .criterion-agent/S006/finding-summary.json, because scanner diagnostics establish scanner limitations. This does not support claims about repository contents, resolved gaps, finding: IDs, or reviewer actions; those still need source citations.',
      'Distinguish the built-in candidate scan from Gitleaks, source available to browse, and source actually investigated. Availability alone does not resolve a scan cap. Explain additional investigation and any remaining gap. Confidence applies to this scoped assessment, not assurance that no secrets exist anywhere.',
      'Use likely_sufficient only when every material obligation is resolved and no finding needs further evidence or policy judgment. Unresolved obligations require needs_reviewer_judgment and cited reviewerActions naming the missing fact. Coverage gaps alone never justify likely_insufficient. Keep summary and rationale consistent with these dispositions.',
      'Do not claim that any credential, token, key, password, private URL, credential URL, endpoint, or secret is live, valid, exploitable, revoked, or safe. Never test credentials or contact endpoints. Do not reproduce secret values in your response; cite paths and describe their role instead.',
      'This review is advisory only for Technical Council reviewer judgment. Agent advice must not decide the final S006 status.',
      'Return exactly one JSON object, without prose or Markdown fences, with recommendation, confidence, summary, rationale, evidenceReferences, assessments, and reviewerActions. Each reviewerActions entry contains action and repository evidenceReferences.',
      'recommendation must be likely_sufficient, likely_insufficient, or needs_reviewer_judgment; confidence must be low, medium, or high. Cite actual inspected repository files.'
    ].join('\n'),
    files: [{
      repoRelativePath: '.criterion-agent/S006/finding-summary.json',
      content: JSON.stringify({
        criterionId: analysis.criterionId,
        classification: analysis.classification,
        findings: analysis.findings.map(({ valueFingerprint: _fingerprint, ...finding }) => finding),
        coverage: analysis.coverage
      }, null, 2)
    }],
    prepareAdditionalFiles: availableSourcePaths => [{
      repoRelativePath: '.criterion-agent/S006/review-obligations.json',
      content: JSON.stringify({ reviewObligations: obligations.map(item => ({
        ...item, ...(item.path ? { sourceAvailable: availableSourcePaths.has(item.path) } : {})
      })) }, null, 2)
    }],
    validateReview: (review, availableSourcePaths) => validateS006Review(obligations, review, availableSourcePaths),
    schemaDescription: 'JSON object with recommendation enum, confidence enum, nonblank summary and rationale, nonempty repository evidenceReferences string[], assessments for every reviewObligations ID including coverageDisposition (investigated|immaterial|unresolved), and cited reviewerActions[]'
  };
}
