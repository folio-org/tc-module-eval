import {
  CommandRunner,
  CriterionAgentReviewConfig,
  CriterionAgentReviewResult,
  EvaluationStatus,
  S010Analysis
} from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview } from './criterion-agent-review';
import { withRepositoryBrowsing } from './agent-review-repository';
import { redactSensitiveText, truncateToByteBudget } from './redaction';

const SUMMARY_PATH = '.criterion-agent/S010/deterministic-summary.json';

export function hasS010AgentReviewMaterial(analysis: S010Analysis): boolean {
  return analysis.status === EvaluationStatus.MANUAL && analysis.evidence.moduleKind.kind !== 'library';
}

export async function reviewS010WithAgent(
  repoPath: string,
  analysis: S010Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = await buildS010AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return unavailable(`Unable to prepare S010 agent review material: ${errorMessage(error)}`);
  }
  const review = await runCriterionAgentReview(request, config, commandRunner);
  if (!review.available) return review;
  const invalid = validateS010Review(analysis, review);
  return invalid ? { ...unavailable(invalid), metadata: review.metadata } : review;
}

export async function buildS010AgentReviewRequest(
  repoPath: string,
  analysis: S010Analysis
): Promise<CriterionAgentReviewRequest> {
  const summary = truncateToByteBudget(JSON.stringify({
    criterionId: 'S010',
    deterministicStatus: analysis.status,
    summary: analysis.summary,
    runtimeKind: analysis.evidence.runtimeKind,
    discoveryCoverage: analysis.evidence.discoveryCoverage,
    semanticCoverage: analysis.evidence.semanticCoverage,
    scenarios: analysis.evidence.scenarios.map(scenario => ({
      ...scenario,
      proof: scenario.proof === 'clear-fail-fast' && scenario.boundedFailure !== 'proven'
        ? 'failure-propagation-observed-duration-unverified' : scenario.proof
    })),
    findings: analysis.findings,
    diagnostics: analysis.diagnostics
  }, null, 2), 48 * 1024);
  return withRepositoryBrowsing({
    criterionId: 'S010',
    repositoryPath: repoPath,
    instructions: [
      'Act as an advisory reviewer for S010: Gracefully handles the absence of third party systems or related configuration.',
      'The deterministic summary is a starting point, not an exhaustive inventory or a conclusion to accept. Seek missed dependencies and evidence contradicting the analyzer. Follow calls, wrappers, configuration, failure handling, startup/readiness paths, and tests across files, including files absent from the summary.',
      'Describe the scope actually investigated and unresolved paths in your rationale. Cite exact repository paths in evidenceReferences and give supporting line numbers in assessment summaries. Never treat an uninspected or excluded path as proof of absence. If you cannot complete a material trace within the review budget, return needs_reviewer_judgment with a narrow follow-up action; do not claim comprehensive coverage.',
      'Inventory runtime dependencies outside this module, including FOLIO modules, databases, brokers, object storage, search, and external services. Do not assess S008 or S009 governance acceptance.',
      'For each material dependency, trace dependency, operation, configuration or enabling condition, failure path, bounded failure mechanism, fallback outcome, startup coupling, health/readiness effect, and relevant tests.',
      'Investigate in lifecycle order: startup callbacks and bean creation performing I/O; tenant/provisioning handlers and their helpers; runtime callers and listeners; then effective client timeouts and retries. Exception propagation, finite retry counts, and a complete-operation deadline are different facts; do not substitute one for another.',
      'Establish whether each service is required for essential module functionality, optional, or conditional from cited architecture, usage, and feature-gating evidence. A configuration-absent scenario describes a configuration input, not service optionality: a default address or an environment variable not marked required does not make the service optional. If service ownership remains ambiguous, report that specific evidence gap rather than assuming optionality.',
      'Required dependencies need not have a fallback that keeps the module working without them. Clear, bounded startup or tenant-initialization failure can satisfy S010; controlled runtime failure and truthful loss of readiness can also be appropriate. Startup coupling, refusal to initialize a tenant, or lack of a feature toggle is not by itself a substantive concern for a required service.',
      'Distinguish process startup, tenant initialization, and runtime operations, and distinguish liveness from readiness. Do not infer process startup failure from tenant-init failure or require readiness to remain UP during a required-service outage. Assess actual failure bounds, diagnostics, readiness semantics, and recovery behavior; indefinite hangs, misleading readiness, uncontrolled resource consumption, or data corruption are concerns only when supported by evidence. An exception or connect timeout alone does not prove the whole failure path is bounded.',
      'Optional dependencies may use feature isolation or controlled module-wide degradation, but their absence must not make the module unready. Appropriate bounded failure handling is required; no single timeout or retry mechanism is universally required.',
      'Do not claim a proven end-to-end failure bound from assumed Hikari, Liquibase, Kafka, or HTTP-client defaults. Cite the effective bound and its connection to the complete operation, including retries; if the relevant library behavior is outside the snapshot, leave the bound unverified in both the finding and the executive summary.',
      'Missing required configuration with no sensible default may satisfy S010 through clear startup fail-fast. Explicit continuation or deferred failure is a concern. Absence of visible handling alone is an evidence gap, not proof of failure.',
      'Tests strengthen evidence but are not mandatory. General Node.js behavior is outside deterministic phase-one support and needs reviewer judgment.',
      'This review is advisory only. Do not change, approve, pass, fail, or override the deterministic S010 status.',
      'Every assessment and reviewer action must cite one or more actual repository repoRelativePath values in repository-files.json; generated summary and snapshot-manifest files do not count as repository citations.',
      'Use a deterministic dependencyId from the summary as technologyId, or discovered:<normalized-id> for a missed dependency found in repository source.',
      'Use likely_insufficient only with a cited substantive_concern. Use needs_reviewer_judgment only with a cited narrow reviewer action naming the missing fact and the decision it resolves.',
      'Return at least one assessment, accounting for every ID in candidateDependencyIds and every additional discovered dependency. Candidates are analyzer suggestions, not established external dependencies. Each assessment must contain technologyId, type, summary, and evidenceReferences. Allowed type values are aligned_fact, substantive_concern, analyzer_limitation, evidence_gap, and policy_question.',
      'For an internal component that is not an independent external dependency, use type analyzer_limitation with coverageDisposition immaterial and omit failureBounds. Cite why it is internal and incorporate relevant configuration into the actual service assessment. Do not exclude a candidate by filename alone. Actual external dependencies must include failureBounds.',
      'failureBounds must contain exactly one record for each phase: startup, tenant_initialization, runtime. Each record contains phase, requirement (required|optional|conditional|unknown), status (established|unverified|not_applicable), explanation, and repository evidenceReferences. For established, explain the effective mechanism and its connection to the complete operation including retries and intervening calls. For unverified, name the missing fact. For not_applicable, cite why the dependency is not used in that phase. Conditional dependencies still require evaluation of the enabled path.',
      'Use likely_sufficient only if all applicable phase bounds are established or demonstrably not_applicable and requirements are known. Supported aligned_fact observations may coexist with unverified bounds; distinguish the observed behavior from its unknown duration. Unresolved decision-relevant bounds or roles require needs_reviewer_judgment and a cited action, unless a cited substantive concern supports likely_insufficient. Optional deployment tuning is compatible with established bounds; uncertainty about whether any finite bound exists is not tuning. Keep the executive summary consistent with these records.',
      'Each reviewerActions entry must contain exactly action and evidenceReferences. For needs_reviewer_judgment, return at least one reviewer action.',
      'Every evidenceReferences value must exactly match a repoRelativePath listed in repository-files.json (without the docs/ workspace prefix). Do not cite a path merely because deterministic-summary.json mentions it.',
      'Return only one JSON object with recommendation, confidence, summary, rationale, evidenceReferences, assessments (including failureBounds), and reviewerActions.'
    ].join('\n'),
    files: [
      { repoRelativePath: SUMMARY_PATH, content: summary },
      { repoRelativePath: '.criterion-agent/S010/candidate-dependencies.json', content: JSON.stringify({
        candidateDependencyIds: [...new Set(analysis.evidence.scenarios.map(scenario => scenario.dependencyId))]
      }) },
      { repoRelativePath: '.criterion-agent/S010/response-shape.json', content: JSON.stringify({
        note: 'Shape example only, not findings. Replace IDs, prose, roles, statuses, and citations with investigated evidence. Account for every candidate. Internal components may use analyzer_limitation with coverageDisposition immaterial and no failureBounds. Do not omit record fields for not_applicable phases of actual dependencies.',
        response: {
          recommendation: 'needs_reviewer_judgment', confidence: 'medium',
          summary: 'State the operational judgment and remaining uncertainty.', rationale: 'State the decisive evidence and actual investigation scope.',
          evidenceReferences: ['actual/source/path'],
          assessments: [{ technologyId: 'dependency-id', type: 'evidence_gap', summary: 'State the missing fact and its impact.',
            evidenceReferences: ['actual/source/path'], failureBounds: ['startup', 'tenant_initialization', 'runtime'].map(phase => ({
              phase, requirement: 'required', status: 'unverified', explanation: 'Name the missing complete-operation bound, or explain the verified mechanism including retries.',
              evidenceReferences: ['actual/source/path']
            })) }],
          reviewerActions: [{ action: 'Name the fact needed to resolve the decision.', evidenceReferences: ['actual/source/path'] }]
        }
      }, null, 2) }
    ],
    schemaDescription: 'JSON object. Required: recommendation (likely_sufficient|likely_insufficient|needs_reviewer_judgment), confidence (low|medium|high), nonblank summary and rationale, nonempty evidenceReferences, nonempty assessments, reviewerActions. Each assessment includes technologyId, type, summary, evidenceReferences and failureBounds with exactly three cited records (startup, tenant_initialization, runtime): phase, requirement (required|optional|conditional|unknown), status (established|unverified|not_applicable), explanation, evidenceReferences. Exception: cited internal components use type analyzer_limitation and coverageDisposition immaterial without failureBounds. Every reference must exactly match a repository-files.json repoRelativePath. See response-shape.json for a complete example.'
  });
}

function validateS010Review(
  analysis: S010Analysis,
  review: CriterionAgentReviewResult
): string | undefined {
  if (!review.assessments?.length) return 'S010 agent review returned no cited practical assessments.';
  const dependencyIds = new Set(analysis.evidence.scenarios.map(scenario => scenario.dependencyId));
  for (const assessment of review.assessments) {
    if (!dependencyIds.has(assessment.technologyId) && !/^discovered:[a-z0-9][a-z0-9._-]*$/.test(assessment.technologyId)) {
      return 'S010 agent review returned an assessment for an unknown dependency.';
    }
  }
  if (review.recommendation === 'likely_insufficient'
      && !review.assessments.some(assessment => assessment.type === 'substantive_concern')) {
    return 'S010 likely_insufficient recommendation did not identify a cited substantive concern.';
  }
  if (review.recommendation === 'needs_reviewer_judgment' && !review.reviewerActions?.length) {
    return 'S010 needs_reviewer_judgment recommendation did not provide a cited reviewer action.';
  }
  if ([...dependencyIds].some(id => !review.assessments!.some(item => item.technologyId === id))
    || new Set(review.assessments.map(item => item.technologyId)).size !== review.assessments.length) {
    return 'S010 requires one assessment for every supplied dependency and no duplicate assessments.';
  }
  for (const assessment of review.assessments) {
    const bounds = assessment.failureBounds;
    if (assessment.type === 'analyzer_limitation' && assessment.coverageDisposition === 'immaterial' && !bounds) continue;
    if (bounds?.length !== 3 || new Set(bounds.map(bound => bound.phase)).size !== 3) {
      return `S010 dependency ${assessment.technologyId} requires cited failureBounds for startup, tenant_initialization, and runtime.`;
    }
    const unresolved = bounds.find(bound => bound.status === 'unverified' || bound.requirement === 'unknown');
    if (unresolved && review.recommendation === 'likely_sufficient') {
      return `S010 dependency ${assessment.technologyId}, phase ${unresolved.phase}: status=${unresolved.status}, requirement=${unresolved.requirement} conflicts with recommendation=likely_sufficient.`;
    }
  }
  if (review.recommendation === 'likely_sufficient' && review.assessments.some(item =>
    ['evidence_gap', 'policy_question', 'substantive_concern'].includes(item.type))) {
    return 'S010 likely_sufficient conflicts with unresolved assessments.';
  }
  return undefined;
}

function unavailable(message: string): CriterionAgentReviewResult {
  return { available: false, criterionId: 'S010', evidenceReferences: [], warnings: [], errors: [redactSensitiveText(message)] };
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
