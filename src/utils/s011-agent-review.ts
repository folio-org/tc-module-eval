import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, EvaluationStatus, S011Analysis } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview } from './criterion-agent-review';
import { redactSensitiveText } from './redaction';

const SUMMARY_BYTES = 64 * 1024;

/** Reviews run only for a deterministic manual result with something in the repository to judge. */
export function hasS011AgentReviewMaterial(analysis: S011Analysis): boolean {
  return analysis.status === EvaluationStatus.MANUAL && analysis.reviewGroups.length > 0;
}

export async function reviewS011WithAgent(
  repoPath: string,
  analysis: S011Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildS011AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return {
      available: false, criterionId: 'S011', evidenceReferences: [], warnings: [],
      errors: [redactSensitiveText(`Unable to prepare S011 agent review material: ${error instanceof Error ? error.message : String(error)}`)]
    };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildS011AgentReviewRequest(repoPath: string, analysis: S011Analysis): CriterionAgentReviewRequest {
  const groups = analysis.reviewGroups.map(group => ({
    id: group.id,
    kind: group.kind,
    ...(group.rule ? { rule: group.rule } : {}),
    ...(group.ruleName ? { ruleName: group.ruleName } : {}),
    ...(group.appliesTo ? { javacWarningNameSuppressingSonarRules: group.appliesTo } : {}),
    path: group.path,
    lines: group.lines.slice(0, 50),
    ...(group.lines.length > 50 ? { omittedLines: group.lines.length - 50 } : {}),
    guidanceFlags: group.flags,
    adjacentComments: group.comments.slice(0, 5).map(comment => comment.slice(0, 200)),
    ...(group.settings ? { settings: group.settings.map(setting => ({ key: setting.key, value: setting.value.slice(0, 500) })) } : {})
  }));
  const summary = JSON.stringify({
    criterionId: 'S011',
    deterministicStatus: analysis.status,
    summary: analysis.summary.slice(0, 2_000),
    sonarCloudProject: analysis.projectKey,
    sonarCloudSideIgnored: 'Issues accepted in SonarCloud, hotspots reviewed as safe, and SonarCloud project settings are listed for the human reviewer only; they are not repository files and are not part of this review.',
    reviewGroups: groups
  }, null, 2);
  if (Buffer.byteLength(summary) > SUMMARY_BYTES) throw new Error('the suppression summary is too large to send');
  const paths = new Map(groups.map(group => [group.id, group.path]));
  return {
    criterionId: 'S011',
    repositoryPath: repoPath,
    instructions: [
      'Act as an advisory reviewer for S011: SonarQube has found no security issues, no issues of high or greater severity, and no excessive duplication, and any disabled or ignored rules are reasonably justified.',
      'Your only question is whether each Sonar rule suppression or analysis-scope setting the repository makes is reasonably justified. Do not re-judge SonarCloud findings, duplication or the deterministic status.',
      'review-groups.json lists every group: suppressions of one Sonar rule in one file (suppression:<rule>:<path>; the rule can be a javac warning name such as unused or null, which sonar-java treats as suppressing the listed Sonar rules), NOSONAR comments in one file (nosonar:<path>), @SuppressWarnings("all") in one file (all:<path>), and Sonar analysis-scope settings in one build or CI file (scope:<path>). Lines are 1-based.',
      'For each group, read the suppressed code at the listed lines and enough surrounding code and callers to tell whether the rule\'s concern applies. For a security rule (for example java:S2077 SQL formatting or java:S5542 encryption mode), trace where the values come from: a suppression is justified only when the code shows the risk cannot occur, for example identifiers from constants or validated input.',
      'For a scope group, decide whether each excluded path or narrowed source root is generated, third-party, test-only or otherwise reasonably outside analysis, by checking what the excluded files contain.',
      'FOLIO guidance (dev.folio.org): suppress false positives with @SuppressWarnings("<rule>") at method or variable level, never at class level, always with a comment naming the rule and giving the justification, and never with NOSONAR or @SuppressWarnings("all"). guidanceFlags lists where a group departs from it. A missing comment is a guidance gap worth noting but does not by itself make a technically sound suppression unjustified.',
      'Return exactly one assessment per group, with the group id as technologyId and no other assessments. Use type aligned_fact when the suppression or setting looks justified, substantive_concern when the code shows it hides a real problem or is not justified, and evidence_gap when the code does not settle it. Put the reasoning in summary, with line numbers, and cite the group\'s file and any other files you relied on in evidenceReferences.',
      'Use likely_sufficient only when every group is aligned_fact; likely_insufficient only with at least one substantive_concern; otherwise needs_reviewer_judgment with at least one reviewer action naming the fact to check.',
      'This review is advisory only. Do not change, approve, pass, fail or override the deterministic S011 status.',
      'Every evidenceReferences value must exactly match a repoRelativePath listed in repository-files.json; the generated .criterion-agent files are not evidence.',
      'Return only one JSON object with recommendation, confidence, summary, rationale, evidenceReferences, assessments and reviewerActions. See response-shape.json.'
    ].join('\n'),
    files: [
      { repoRelativePath: '.criterion-agent/S011/review-groups.json', content: summary },
      {
        repoRelativePath: '.criterion-agent/S011/response-shape.json',
        content: JSON.stringify({
          note: 'Shape example only, not findings. Replace ids, prose and citations with investigated evidence, and return one assessment for every review group.',
          response: {
            recommendation: 'needs_reviewer_judgment', confidence: 'medium',
            summary: 'State the overall judgment across the groups.', rationale: 'State the decisive evidence and what was inspected.',
            evidenceReferences: ['actual/source/path'],
            assessments: [
              { technologyId: 'suppression:java:S2077:src/main/java/Example.java', type: 'aligned_fact', summary: 'Lines 40-48: the table name comes from a constant, so the SQL cannot be injected.', evidenceReferences: ['src/main/java/Example.java'] },
              { technologyId: 'scope:pom.xml', type: 'evidence_gap', summary: 'model/** is excluded; the code does not show whether it is generated.', evidenceReferences: ['pom.xml'] }
            ],
            reviewerActions: [{ action: 'Name the fact to check and the group it settles.', evidenceReferences: ['actual/source/path'] }]
          }
        }, null, 2)
      }
    ],
    validateReview: (review, available) => validateS011Review(paths, review, available),
    schemaDescription: 'JSON object with recommendation (likely_sufficient|likely_insufficient|needs_reviewer_judgment), confidence (low|medium|high), nonblank summary and rationale, nonempty evidenceReferences, assessments (exactly one per review group: technologyId = group id, type aligned_fact|substantive_concern|evidence_gap, summary, evidenceReferences), and reviewerActions [{ action, evidenceReferences }]. Every reference must exactly match a repository-files.json repoRelativePath. See response-shape.json.'
  };
}

/** Group id to the file it is in; a group's judgment must cite that file, and one whose file the review cannot read stays a gap. */
export function validateS011Review(
  paths: ReadonlyMap<string, string>,
  review: CriterionAgentReviewResult,
  availableSourcePaths: ReadonlySet<string>
): string | undefined {
  const assessments = review.assessments ?? [];
  if (assessments.length !== paths.size || new Set(assessments.map(item => item.technologyId)).size !== assessments.length
    || assessments.some(item => !paths.has(item.technologyId))) {
    return 'S011 requires exactly one assessment for every supplied review group and no other assessments.';
  }
  if (assessments.some(item => !['aligned_fact', 'substantive_concern', 'evidence_gap'].includes(item.type))) {
    return 'S011 assessments must be aligned_fact, substantive_concern or evidence_gap.';
  }
  for (const item of assessments) {
    const file = paths.get(item.technologyId)!;
    if (!availableSourcePaths.has(file) ? item.type !== 'evidence_gap' : !item.evidenceReferences.includes(file)) {
      return `S011 group ${item.technologyId} must cite its own file, or stay an evidence_gap when that file could not be reviewed.`;
    }
  }
  if (review.recommendation === 'likely_sufficient' && assessments.some(item => item.type !== 'aligned_fact')) {
    return 'S011 likely_sufficient conflicts with a group that is not judged justified.';
  }
  if (review.recommendation === 'likely_insufficient' && !assessments.some(item => item.type === 'substantive_concern')) {
    return 'S011 likely_insufficient requires a cited substantive concern.';
  }
  if (review.recommendation === 'needs_reviewer_judgment' && !review.reviewerActions?.length) {
    return 'S011 needs_reviewer_judgment requires a cited reviewer action.';
  }
  return undefined;
}
