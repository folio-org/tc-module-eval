import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandRunner,
  CriterionAgentAssessment,
  CriterionAgentDroppedItem,
  CriterionAgentFailureBound,
  CriterionAgentReviewConfig,
  CriterionAgentReviewerAction,
  CriterionAgentReviewResult,
  EvaluationRun,
  EvaluationStatus
} from '../types';
import { LocalCommandRunner } from './command-runner';
import type { CommittedSourceSnapshot } from './committed-source';
import { prepareRepositoryBrowsing, readRepositorySnapshot } from './agent-review-repository';
import { isWithinRepo, relativePosixPath } from './repo-files';
import { removeOpenCodeRuntimeCredentials, runOpenCodeAgentReview } from './opencode-agent-adapter';
import { redactEvaluatorSecrets, truncateToByteBudget } from './redaction';
import { errorMessage, isRecord } from './type-guards';

const MAX_AGENT_REVIEW_FILE_BYTES = 96 * 1024;

/** A technologyId the agent adds for something the analyzer missed: discovered:<normalized-id>. */
export const DISCOVERED_TECHNOLOGY_ID = /^discovered:[a-z0-9][a-z0-9._-]*$/;

/** S006's generated scanner summary, which an unresolved coverage-gap assessment may cite. */
export const S006_FINDING_SUMMARY_PATH = '.criterion-agent/S006/finding-summary.json';

export interface CriterionAgentReviewFile {
  repoRelativePath: string;
  content: string;
}

export interface CriterionAgentReviewRequest {
  criterionId: string;
  repositoryPath: string;
  instructions: string;
  files: CriterionAgentReviewFile[];
  /** Browse eligible committed source by default; opt out for supplied evidence only. */
  evidenceMode?: 'repository' | 'supplied-files';
  /** Add criterion context that depends on the source actually available to the review. */
  prepareAdditionalFiles?: (availableSourcePaths: ReadonlySet<string>) => CriterionAgentReviewFile[];
  /**
   * Apply criterion-specific semantic checks after shared normalization and citation validation.
   * A hook may first normalize the review in place, as S007 does for discovered technology IDs.
   */
  validateReview?: (
    review: CriterionAgentReviewResult,
    availableSourcePaths: ReadonlySet<string>
  ) => string | undefined;
  /** Narrows the browsable committed source, on top of the shared exclusions. */
  browseInclude?: (repoRelativePath: string) => boolean;
  /** Timeout for each OpenCode command when the run sets none (--criterion-agent-timeout-ms). */
  defaultTimeoutMs?: number;
  /** Generated files an assessment of one of the listed obligations may cite in place of a repository file, when `accepts` allows it. */
  generatedEvidencePaths?: Array<{ path: string; technologyIds: string[]; accepts?: (assessment: CriterionAgentAssessment) => boolean }>;
  /** Drop an invalid or uncited assessment or reviewer action on its own, recording why, instead of rejecting the review. */
  dropInvalidItems?: boolean;
  schemaDescription: string;
}

export interface PreparedCriterionAgentReviewRequest extends CriterionAgentReviewRequest {
  /** Set only by shared repository evidence preparation. */
  repositoryBrowsing?: { maxFileBytes: number; startingFilePaths: string[] };
}

export interface PreparedCriterionReviewWorkspace {
  rootPath: string;
  manifestPath: string;
  manifestEntries: string[];
  runtimeRootPath?: string;
}

export interface OptionalCriterionAgentReviewRequest {
  criterionId: string;
  status: EvaluationStatus;
  hasReviewMaterial: boolean;
  /** Why the review does not run without review material; by default, no candidate evidence was available. */
  notRunReason?: string;
  evaluationRun: EvaluationRun;
  review: (
    config: CriterionAgentReviewConfig,
    commandRunner?: CommandRunner
  ) => Promise<CriterionAgentReviewResult>;
}

export interface OptionalCriterionAgentReviewResult {
  agentReview?: CriterionAgentReviewResult;
  unavailableReason?: string;
}

export async function reviewCriterionWithAgent(
  request: OptionalCriterionAgentReviewRequest
): Promise<OptionalCriterionAgentReviewResult> {
  if (request.status !== EvaluationStatus.MANUAL) {
    return {};
  }
  if (!request.hasReviewMaterial) {
    return { unavailableReason: request.notRunReason ?? 'no candidate evidence was available for agent review' };
  }
  if (!request.evaluationRun.agentReview?.enabled) {
    return { unavailableReason: 'agent review is disabled or unconfigured' };
  }
  if (
    request.evaluationRun.agentReview.enabledCriteria?.length &&
    !request.evaluationRun.agentReview.enabledCriteria.includes(request.criterionId)
  ) {
    return { unavailableReason: `agent review is not enabled for ${request.criterionId}` };
  }

  const run = request.evaluationRun;
  const config: CriterionAgentReviewConfig = {
    ...request.evaluationRun.agentReview,
    readRepositorySnapshot: () => run.getOrCreateArtifact('agentReviewSnapshot', () => readRepositorySnapshot(run.repositoryPath))
  };
  let agentReview: CriterionAgentReviewResult;
  try {
    agentReview = await run.runAgentReview(() => request.review(config, run.commandRunner));
  } catch (error) {
    const message = errorMessage(error);
    return {
      agentReview: {
        available: false,
        criterionId: request.criterionId,
        evidenceReferences: [],
        warnings: [],
        errors: [`Agent review failed unexpectedly: ${redactEvaluatorSecrets(message)}`]
      },
      unavailableReason: `Agent review failed unexpectedly: ${redactEvaluatorSecrets(message)}`
    };
  }
  if (!agentReview.available) {
    return {
      agentReview,
      unavailableReason: agentReview.errors.join('; ') || 'agent review is disabled or unconfigured'
    };
  }

  return { agentReview };
}

export async function runCriterionAgentReview(
  request: CriterionAgentReviewRequest,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  const unavailable = unavailableResult(request.criterionId);
  if (!config?.enabled) {
    return { ...unavailable, errors: ['Agent review is disabled'] };
  }
  if (config.enabledCriteria?.length && !config.enabledCriteria.includes(request.criterionId)) {
    return { ...unavailable, errors: [`Agent review is not enabled for ${request.criterionId}`] };
  }

  if (config.timeoutMs === undefined && request.defaultTimeoutMs !== undefined) {
    config = { ...config, timeoutMs: request.defaultTimeoutMs };
  }
  const validationError = validateAgentReviewConfig(config, request.repositoryPath);
  if (validationError) {
    return { ...unavailable, errors: [validationError] };
  }

  let prepared: PreparedCriterionAgentReview;
  try {
    prepared = await prepareCriterionAgentReviewEvidence(request, config.readRepositorySnapshot);
  } catch (error) {
    return { ...unavailable, errors: [redactEvaluatorSecrets(`Unable to prepare agent review evidence: ${errorMessage(error)}`)] };
  }

  let workspace: PreparedCriterionReviewWorkspace;
  try {
    workspace = prepareCriterionReviewWorkspace(prepared.request);
  } catch (error) {
    return { ...unavailable, errors: [redactEvaluatorSecrets(`Unable to prepare agent review workspace: ${errorMessage(error)}`)] };
  }
  try {
    if (config.adapter === 'fake') {
      return validatePreparedReview(prepared, normalizeFakeCriterionReviewResult(prepared.request, config, config.fakeResult ?? {
        available: true,
        criterionId: prepared.request.criterionId,
        recommendation: 'needs_reviewer_judgment',
        confidence: 'medium',
        summary: 'Fake criterion-agent review completed.',
        rationale: 'Fake adapter was configured for deterministic tests.',
        evidenceReferences: [...prepared.availableSourcePaths].slice(0, 1),
        metadata: {
          adapter: 'fake',
          modelLabel: config.modelLabel,
          endpointFamily: config.endpointFamily,
          reviewMode: 'read-only',
          promptInputSanitized: true,
          reviewWorkspaceSanitized: true
        },
        warnings: [],
        errors: []
      }));
    }
    return validatePreparedReview(prepared, await runOpenCodeAgentReview(
      prepared.request,
      workspace,
      config,
      commandRunner ?? new LocalCommandRunner(false)
    ));
  } finally {
    removeOpenCodeRuntimeCredentials(workspace);
    if (config.adapter !== 'opencode' || !config.debugRetainWorkspace) {
      fs.rmSync(workspace.rootPath, { recursive: true, force: true });
    }
  }
}

export interface PreparedCriterionAgentReview {
  request: PreparedCriterionAgentReviewRequest;
  availableSourcePaths: ReadonlySet<string>;
}

export async function prepareCriterionAgentReviewEvidence(
  request: CriterionAgentReviewRequest,
  readSnapshot?: () => Promise<CommittedSourceSnapshot>
): Promise<PreparedCriterionAgentReview> {
  let preparedRequest: PreparedCriterionAgentReviewRequest;
  let availableSourcePaths: ReadonlySet<string>;
  if (request.evidenceMode === 'supplied-files') {
    const { repositoryBrowsing: _ignored, ...suppliedRequest } = request as CriterionAgentReviewRequest & {
      repositoryBrowsing?: unknown;
    };
    preparedRequest = suppliedRequest;
    availableSourcePaths = new Set(request.files.map(file => file.repoRelativePath));
  } else {
    const preparedRepository = await prepareRepositoryBrowsing(request, readSnapshot);
    preparedRequest = preparedRepository.request;
    availableSourcePaths = preparedRepository.sourcePaths;
  }
  const additionalFiles = request.prepareAdditionalFiles?.(availableSourcePaths) ?? [];
  return {
    request: additionalFiles.length
      ? { ...preparedRequest, files: [...preparedRequest.files, ...additionalFiles] }
      : preparedRequest,
    availableSourcePaths
  };
}

function validatePreparedReview(
  prepared: PreparedCriterionAgentReview,
  review: CriterionAgentReviewResult
): CriterionAgentReviewResult {
  const citationValidated = validateRepositoryCitations(
    prepared.request,
    review,
    prepared.availableSourcePaths
  );
  if (!citationValidated.available || !prepared.request.validateReview) return citationValidated;
  const validationError = prepared.request.validateReview(citationValidated, prepared.availableSourcePaths);
  return validationError
    ? { ...citationValidated, available: false, errors: [...citationValidated.errors, validationError] }
    : citationValidated;
}

function validateRepositoryCitations(
  request: PreparedCriterionAgentReviewRequest,
  review: CriterionAgentReviewResult,
  availableSourcePaths: ReadonlySet<string>
): CriterionAgentReviewResult {
  if (!request.repositoryBrowsing || !review.available) return review;
  const cited = (citations: string[]) => citations.some(citation => availableSourcePaths.has(citation));
  const citedGenerated = (item: CriterionAgentAssessment) => (request.generatedEvidencePaths ?? []).some(generated =>
    generated.technologyIds.includes(item.technologyId) && item.evidenceReferences.includes(generated.path) && (generated.accepts?.(item) ?? true));
  const citedAssessment = (item: CriterionAgentAssessment) => (citedGenerated(item) || cited(item.evidenceReferences))
    && (item.failureBounds ?? []).every(bound => cited(bound.evidenceReferences));
  const citedAction = (item: CriterionAgentReviewerAction) => cited(item.evidenceReferences);
  const assessments = review.assessments ?? [];
  const actions = review.reviewerActions ?? [];
  if (!cited(review.evidenceReferences) || (!request.dropInvalidItems && (!assessments.every(citedAssessment) || !actions.every(citedAction)))) {
    return { ...review, available: false, errors: [...review.errors, 'Agent review requires repository evidence for the review and every assessment and action; generated context alone is not evidence.'] };
  }
  const reason = 'It cites only generated context, not a repository file.';
  const dropped: CriterionAgentDroppedItem[] = [
    ...assessments.filter(item => !citedAssessment(item)).map(item => ({ kind: 'assessment' as const, technologyId: item.technologyId, reason })),
    ...actions.filter(item => !citedAction(item)).map(() => ({ kind: 'reviewer_action' as const, reason }))
  ];
  return dropped.length ? {
    ...review,
    assessments: review.assessments?.filter(citedAssessment),
    reviewerActions: review.reviewerActions?.filter(citedAction),
    droppedItems: [...review.droppedItems ?? [], ...dropped]
  } : review;
}

export function prepareCriterionReviewWorkspace(request: PreparedCriterionAgentReviewRequest): PreparedCriterionReviewWorkspace {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'criterion-agent-review-'));
  try {
    fs.chmodSync(rootPath, 0o700);
    const docsRoot = path.join(rootPath, 'docs');
    fs.mkdirSync(docsRoot, { recursive: true, mode: 0o700 });

    const usedWorkspacePaths = new Set<string>();
    const entries = request.files.map(file => {
      const safeRelativePath = safeWorkspaceRelativePath(file.repoRelativePath);
      const workspacePath = path.join(docsRoot, safeRelativePath);
      const workspaceKey = relativePosixPath(docsRoot, workspacePath);
      if (usedWorkspacePaths.has(workspaceKey)) {
        throw new Error(`Duplicate agent review workspace path: ${workspaceKey}`);
      }
      usedWorkspacePaths.add(workspaceKey);
      fs.mkdirSync(path.dirname(workspacePath), { recursive: true, mode: 0o700 });
      if (request.repositoryBrowsing && Buffer.byteLength(file.content) > request.repositoryBrowsing.maxFileBytes) {
        throw new Error(`Review file exceeds the ${request.repositoryBrowsing.maxFileBytes}-byte workspace limit: ${file.repoRelativePath}`);
      }
      fs.writeFileSync(workspacePath, request.repositoryBrowsing
        ? file.content
        : truncateToByteBudget(file.content, MAX_AGENT_REVIEW_FILE_BYTES), { mode: 0o600 });
      return {
        id: safeRelativePath,
        repoRelativePath: file.repoRelativePath,
        workspacePath: relativePosixPath(rootPath, workspacePath)
      };
    });

    if (request.repositoryBrowsing) {
      fs.writeFileSync(path.join(rootPath, 'repository-files.json'), JSON.stringify(entries, null, 2), { mode: 0o600 });
    }
    const startingFilePaths = new Set(request.repositoryBrowsing?.startingFilePaths);
    const manifestPath = path.join(rootPath, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      criterionId: request.criterionId,
      instructions: request.instructions,
      schemaDescription: request.schemaDescription,
      ...(request.repositoryBrowsing ? { repositoryRoot: 'docs', fileIndex: 'repository-files.json' } : {}),
      files: request.repositoryBrowsing
        ? entries.filter(entry => entry.repoRelativePath.startsWith('.criterion-agent/')
          || startingFilePaths.has(entry.repoRelativePath))
        : entries
    }, null, 2), { mode: 0o600 });

    return {
      rootPath,
      manifestPath,
      manifestEntries: entries.map(entry => entry.repoRelativePath)
    };
  } catch (error) {
    fs.rmSync(rootPath, { recursive: true, force: true });
    throw error;
  }
}

export function validateAgentReviewConfig(
  config: CriterionAgentReviewConfig,
  repositoryPath: string
): string | undefined {
  if (config.adapter === 'opencode') {
    if (config.providerConfigError) return config.providerConfigError;
    if (!config.modelLabel) return 'OpenCode model label is required';
    if (!config.readOnlyAgentName) return 'OpenCode read-only agent name is required';
    if (config.generatedProvider && !process.env[config.generatedProvider.apiKeyEnv]) {
      return `${config.generatedProvider.apiKeyEnv} is required for ${config.generatedProvider.name} OpenCode review`;
    }
  }
  if (config.endpoint) {
    const endpointError = validateEndpointUrl(config.endpoint, config.endpointAllowlist);
    if (endpointError) {
      return endpointError;
    }
  }

  for (const [label, candidatePath] of [
    ['Trusted OpenCode config path', config.trustedConfigPath],
    ['Trusted OpenCode auth-store path', config.trustedAuthStorePath]
  ] as const) {
    if (candidatePath && pathIsInsideRepository(repositoryPath, candidatePath)) {
      return `${label} must not be inside the evaluated repository`;
    }
  }

  return undefined;
}

export function validateEndpointUrl(endpoint: string, allowlist: string[] = []): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return `Invalid OpenCode endpoint URL: ${endpoint}`;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const isAllowlisted = allowlist.some(allowed => endpointMatchesAllowedUrl(parsed, allowed));
  if (parsed.protocol !== 'https:' && !isLocal && !isAllowlisted) {
    return 'OpenCode endpoint must use HTTPS unless it is local or explicitly allowlisted';
  }

  return undefined;
}

function endpointMatchesAllowedUrl(endpoint: URL, allowed: string): boolean {
  let parsedAllowed: URL;
  try {
    parsedAllowed = new URL(allowed);
  } catch {
    return false;
  }
  if (endpoint.origin !== parsedAllowed.origin) {
    return false;
  }
  if (parsedAllowed.search && endpoint.search !== parsedAllowed.search) {
    return false;
  }
  const allowedPath = parsedAllowed.pathname.endsWith('/')
    ? parsedAllowed.pathname
    : `${parsedAllowed.pathname}/`;
  return endpoint.pathname === parsedAllowed.pathname || endpoint.pathname.startsWith(allowedPath);
}

export function unavailableResult(criterionId: string): CriterionAgentReviewResult {
  return {
    available: false,
    criterionId,
    evidenceReferences: [],
    warnings: [],
    errors: []
  };
}

function normalizeFakeCriterionReviewResult(
  request: CriterionAgentReviewRequest,
  config: CriterionAgentReviewConfig,
  rawResult: CriterionAgentReviewResult
): CriterionAgentReviewResult {
  const normalized = normalizeCriterionAgentAdvisoryPayload(
    rawResult as unknown as Record<string, unknown>,
    request.files.map(file => file.repoRelativePath),
    request.dropInvalidItems
  );
  const warnings = [
    ...stringArray(rawResult.warnings).map(warning => redactEvaluatorSecrets(warning)),
    ...normalized.warnings
  ];
  const errors = stringArray(rawResult.errors).map(error => redactEvaluatorSecrets(error));
  const metadata = rawResult.metadata ?? {
    adapter: 'fake' as const,
    modelLabel: config.modelLabel,
    endpointFamily: config.endpointFamily,
    reviewMode: 'read-only' as const,
    promptInputSanitized: true,
    reviewWorkspaceSanitized: true
  };

  if (rawResult.available === false) {
    return {
      available: false,
      criterionId: request.criterionId,
      evidenceReferences: normalized.evidenceReferences,
      metadata,
      warnings,
      errors: errors.length ? errors : ['Fake criterion-agent review was unavailable']
    };
  }

  if (normalized.errors.length) {
    return {
      available: false,
      criterionId: request.criterionId,
      evidenceReferences: [],
      metadata,
      warnings,
      errors: [...errors, 'Fake criterion-agent review returned incomplete advisory JSON', ...normalized.errors]
    };
  }

  return {
    available: true,
    criterionId: request.criterionId,
    recommendation: normalized.recommendation,
    confidence: normalized.confidence,
    summary: normalized.summary,
    rationale: normalized.rationale,
    evidenceReferences: normalized.evidenceReferences,
    assessments: normalized.assessments,
    reviewerActions: normalized.reviewerActions,
    ...(normalized.droppedItems.length ? { droppedItems: normalized.droppedItems } : {}),
    metadata,
    warnings,
    errors
  };
}

export interface NormalizedCriterionAgentAdvisoryPayload {
  recommendation?: CriterionAgentReviewResult['recommendation'];
  confidence?: CriterionAgentReviewResult['confidence'];
  summary?: string;
  rationale?: string;
  evidenceReferences: string[];
  assessments?: CriterionAgentReviewResult['assessments'];
  reviewerActions?: CriterionAgentReviewResult['reviewerActions'];
  droppedItems: CriterionAgentDroppedItem[];
  warnings: string[];
  errors: string[];
}

const DROP_REASONS = {
  'expected an object': 'It is not a JSON object.',
  'invalid coverageDisposition': 'Its coverage judgment is not one the evaluator accepts.',
  'invalid failureBounds fields or citations': 'Its failure bounds are incomplete or cite no repository file.',
  'no evidenceReferences match the source manifest': 'It cites no repository file.',
  'missing technologyId, valid type, or nonblank summary': 'It has no ID, no recognised result type or no summary.',
  'missing nonblank action or source-manifest citation': 'It has no text or cites no repository file.'
} as const;

export function normalizeCriterionAgentAdvisoryPayload(
  payload: Record<string, unknown>,
  manifestEntries: string[],
  dropInvalidItems = false
): NormalizedCriterionAgentAdvisoryPayload {
  const rawEvidenceReferences = Array.isArray(payload.evidenceReferences) ? payload.evidenceReferences : [];
  const evidenceReferences = normalizeAdvisoryEvidenceReferences(rawEvidenceReferences, manifestEntries);
  const errors: string[] = [];
  const droppedItems: CriterionAgentDroppedItem[] = [];
  const reject = (kind: CriterionAgentDroppedItem['kind']): RejectItem => (index, reason, technologyId) => {
    if (dropInvalidItems) droppedItems.push({ kind, ...(technologyId !== undefined ? { technologyId } : {}), reason: DROP_REASONS[reason] });
    else if (errors.length < 16) errors.push(`${kind === 'assessment' ? 'Assessment' : 'Reviewer action'} ${index + 1}: ${reason}.`);
  };
  const assessments = normalizeAssessments(payload.assessments, manifestEntries, reject('assessment'));
  const reviewerActions = normalizeReviewerActions(payload.reviewerActions, manifestEntries, reject('reviewer_action'));
  const recommendation = parseAdvisoryRecommendation(payload.recommendation);
  const confidence = parseAdvisoryConfidence(payload.confidence);
  const summary = typeof payload.summary === 'string' ? redactEvaluatorSecrets(payload.summary).trim() : undefined;
  const rationale = typeof payload.rationale === 'string' ? redactEvaluatorSecrets(payload.rationale).trim() : undefined;
  if (!recommendation) errors.push('recommendation must be a supported advisory recommendation');
  if (!confidence) errors.push('confidence must be low, medium, high, or a finite number between 0 and 1');
  if (!summary) errors.push('summary must be a nonblank string');
  if (!rationale) errors.push('rationale must be a nonblank string');
  if (!Array.isArray(payload.evidenceReferences)) errors.push('evidenceReferences must be an array');
  else if (!evidenceReferences.length) errors.push('evidenceReferences must include a manifest entry');
  if (payload.assessments !== undefined && (!Array.isArray(payload.assessments) || (!dropInvalidItems && assessments?.length !== payload.assessments.length))) {
    errors.push('Invalid or uncited assessments; the complete review was rejected.');
  }
  if (payload.reviewerActions !== undefined && (!Array.isArray(payload.reviewerActions) || (!dropInvalidItems && reviewerActions?.length !== payload.reviewerActions.length))) {
    errors.push('Invalid or uncited reviewer action; actions may not be silently dropped.');
  }
  return {
    recommendation,
    confidence,
    summary,
    rationale,
    evidenceReferences,
    errors,
    assessments,
    reviewerActions,
    droppedItems,
    warnings: [
      // Merged duplicates and line numbers on a listed path are not dropped citations.
      ...(rawEvidenceReferences.some(reference => !normalizeAdvisoryEvidenceReferences([reference], manifestEntries).length)
        ? ['Dropped uncited or unknown advisory evidence references']
        : [])
    ]
  };
}

type RejectItem = (index: number, reason: keyof typeof DROP_REASONS, technologyId?: string) => void;

function normalizeAssessments(
  value: unknown,
  manifestEntries: string[],
  rejectItem: RejectItem
): CriterionAgentReviewResult['assessments'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const validTypes = new Set(['aligned_fact', 'substantive_concern', 'analyzer_limitation', 'evidence_gap', 'policy_question']);
  return value.flatMap((entry, index) => {
    const technologyId = isRecord(entry) && typeof entry.technologyId === 'string' ? entry.technologyId : undefined;
    const reject = (reason: keyof typeof DROP_REASONS): [] => {
      rejectItem(index, reason, technologyId);
      return [];
    };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return reject('expected an object');
    const candidate = entry as Record<string, unknown>;
    const evidenceReferences = normalizeAdvisoryEvidenceReferences(
      Array.isArray(candidate.evidenceReferences) ? candidate.evidenceReferences : [],
      manifestEntries
    );
    const summary = typeof candidate.summary === 'string'
      ? redactEvaluatorSecrets(candidate.summary).trim()
      : '';
    const coverageDisposition = candidate.coverageDisposition as NonNullable<CriterionAgentReviewResult['assessments']>[number]['coverageDisposition'];
    if (coverageDisposition !== undefined && !['investigated', 'immaterial', 'unresolved'].includes(coverageDisposition)) return reject('invalid coverageDisposition');
    const emptyBounds = Array.isArray(candidate.failureBounds) && candidate.failureBounds.length === 0;
    const failureBounds = normalizeFailureBounds(candidate.failureBounds, manifestEntries);
    if (candidate.failureBounds !== undefined && !emptyBounds && !failureBounds) return reject('invalid failureBounds fields or citations');
    if (evidenceReferences.length === 0) return reject('no evidenceReferences match the source manifest');
    if (
      typeof candidate.technologyId !== 'string' ||
      typeof candidate.type !== 'string' ||
      !validTypes.has(candidate.type) ||
      !summary
    ) return reject('missing technologyId, valid type, or nonblank summary');
    return [{
      technologyId: candidate.technologyId,
      type: candidate.type as NonNullable<CriterionAgentReviewResult['assessments']>[number]['type'],
      summary,
      evidenceReferences,
      ...(coverageDisposition !== undefined ? { coverageDisposition } : {}),
      ...(failureBounds ? { failureBounds } : {})
    }];
  });
}

function normalizeFailureBounds(value: unknown, manifestEntries: string[]): CriterionAgentFailureBound[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const bounds: CriterionAgentFailureBound[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    if (!['startup', 'tenant_initialization', 'runtime'].includes(item.phase)
      || !['required', 'optional', 'conditional', 'unknown'].includes(item.requirement)
      || !['established', 'unverified', 'not_applicable'].includes(item.status)
      || typeof item.explanation !== 'string' || !item.explanation.trim()
      || !Array.isArray(item.evidenceReferences)) return undefined;
    // Like assessment and action citations: unknown paths are dropped, and a record left with none is invalid.
    const evidenceReferences = normalizeAdvisoryEvidenceReferences(item.evidenceReferences, manifestEntries);
    if (!evidenceReferences.length) return undefined;
    bounds.push({ phase: item.phase, requirement: item.requirement, status: item.status,
      explanation: redactEvaluatorSecrets(item.explanation).trim(), evidenceReferences });
  }
  return bounds;
}

function normalizeReviewerActions(
  value: unknown,
  manifestEntries: string[],
  rejectItem: RejectItem
): CriterionAgentReviewResult['reviewerActions'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry, index) => {
    const reject = (reason: keyof typeof DROP_REASONS): [] => {
      rejectItem(index, reason);
      return [];
    };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return reject('expected an object');
    const candidate = entry as Record<string, unknown>;
    const evidenceReferences = normalizeAdvisoryEvidenceReferences(
      Array.isArray(candidate.evidenceReferences) ? candidate.evidenceReferences : [],
      manifestEntries
    );
    const action = typeof candidate.action === 'string'
      ? redactEvaluatorSecrets(candidate.action).trim()
      : '';
    if (!action || evidenceReferences.length === 0) return reject('missing nonblank action or source-manifest citation');
    return [{ action, evidenceReferences }];
  });
}

function parseAdvisoryRecommendation(value: unknown): CriterionAgentReviewResult['recommendation'] | undefined {
  if (value === 'likely_sufficient' || value === 'likely_insufficient' || value === 'needs_reviewer_judgment') {
    return value;
  }
  const normalized = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (['pass', 'passed', 'sufficient', 'likely pass', 'likely_pass'].includes(normalized)) {
    return 'likely_sufficient';
  }
  if (['fail', 'failed', 'insufficient', 'likely fail', 'likely_fail'].includes(normalized)) {
    return 'likely_insufficient';
  }
  if (['manual', 'manual_review', 'needs manual review', 'needs_reviewer_judgment'].includes(normalized)) {
    return 'needs_reviewer_judgment';
  }
  return undefined;
}

function parseAdvisoryConfidence(value: unknown): CriterionAgentReviewResult['confidence'] | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    if (value >= 0.75) {
      return 'high';
    }
    if (value >= 0.4) {
      return 'medium';
    }
    return 'low';
  }
  return undefined;
}

// Agents add line numbers to citations (src/Client.java:40-52,60) despite the instructions. The path
// before them must still be an exact manifest entry; the line numbers are dropped.
const LINE_LOCATOR = /:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;

function normalizeAdvisoryEvidenceReferences(rawReferences: unknown[], manifestEntries: string[]): string[] {
  const references = rawReferences
    .map(reference => {
      if (typeof reference === 'string') {
        return reference;
      }
      if (isRecord(reference)) {
        const candidate = reference as Record<string, unknown>;
        if (typeof candidate.repoRelativePath === 'string') {
          return candidate.repoRelativePath;
        }
        if (typeof candidate.path === 'string') {
          return candidate.path;
        }
      }
      return undefined;
    })
    .map(reference => reference === undefined || manifestEntries.includes(reference) ? reference
      : reference.replace(LINE_LOCATOR, ''))
    .filter((reference): reference is string => typeof reference === 'string' && manifestEntries.includes(reference));

  return [...new Set(references)];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function pathIsInsideRepository(repositoryPath: string, candidatePath: string): boolean {
  const repoRoot = path.resolve(repositoryPath);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === repoRoot || resolvedCandidate.startsWith(`${repoRoot}${path.sep}`) || isWithinRepo(repositoryPath, candidatePath);
}

export function safeWorkspaceRelativePath(repoRelativePath: string): string {
  const forwardSlashPath = repoRelativePath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(forwardSlashPath)) {
    throw new Error(`Agent review file path must be repository-relative: ${repoRelativePath}`);
  }
  const normalized = path.posix.normalize(forwardSlashPath);
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Agent review file path must stay inside the repository: ${repoRelativePath}`);
  }
  return normalized;
}
