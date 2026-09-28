import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandRunner,
  CriterionAgentFailureBound,
  CriterionAgentReviewConfig,
  CriterionAgentReviewResult,
  EvaluationRun,
  EvaluationStatus
} from '../types';
import { LocalCommandRunner } from './command-runner';
import { isWithinRepo } from './repo-files';
import { removeOpenCodeRuntimeCredentials, runOpenCodeAgentReview } from './opencode-agent-adapter';
import { redactSensitiveText, truncateToByteBudget } from './redaction';

const MAX_AGENT_REVIEW_FILE_BYTES = 96 * 1024;

export interface CriterionAgentReviewFile {
  repoRelativePath: string;
  content: string;
}

export interface CriterionAgentReviewRequest {
  criterionId: string;
  repositoryPath: string;
  instructions: string;
  files: CriterionAgentReviewFile[];
  /** Browse intact source on disk instead of attaching its entire inventory to the prompt. */
  repositoryBrowsing?: { maxFileBytes: number };
  /** Trusted S006 scanner gaps; unresolved coverage claims may cite scanner diagnostics. */
  coverageGapIds?: string[];
  schemaDescription: string;
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
    return { unavailableReason: 'no candidate evidence was available for agent review' };
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

  let agentReview: CriterionAgentReviewResult;
  try {
    agentReview = await request.review(request.evaluationRun.agentReview, request.evaluationRun.commandRunner);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      agentReview: {
        available: false,
        criterionId: request.criterionId,
        evidenceReferences: [],
        warnings: [],
        errors: [`Agent review failed unexpectedly: ${redactSensitiveText(message)}`]
      },
      unavailableReason: `Agent review failed unexpectedly: ${redactSensitiveText(message)}`
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

  const validationError = validateAgentReviewConfig(config, request.repositoryPath);
  if (validationError) {
    return { ...unavailable, errors: [validationError] };
  }

  if (config.adapter === 'fake') {
    return validateRepositoryCitations(request, normalizeFakeCriterionReviewResult(request, config, config.fakeResult ?? {
      available: true,
      criterionId: request.criterionId,
      recommendation: 'needs_reviewer_judgment',
      confidence: 'medium',
      summary: 'Fake criterion-agent review completed.',
      rationale: 'Fake adapter was configured for deterministic tests.',
      evidenceReferences: request.files.filter(file => !request.repositoryBrowsing || !file.repoRelativePath.startsWith('.criterion-agent/')).slice(0, 1).map(file => file.repoRelativePath),
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

  let workspace: PreparedCriterionReviewWorkspace;
  try {
    workspace = prepareCriterionReviewWorkspace(request);
  } catch (error) {
    return { ...unavailable, errors: [`Unable to prepare agent review workspace: ${error instanceof Error ? error.message : String(error)}`] };
  }
  try {
    return validateRepositoryCitations(request, await runOpenCodeAgentReview(
      request,
      workspace,
      config,
      commandRunner ?? new LocalCommandRunner(false)
    ));
  } finally {
    removeOpenCodeRuntimeCredentials(workspace);
    if (!config.debugRetainWorkspace) {
      fs.rmSync(workspace.rootPath, { recursive: true, force: true });
    }
  }
}

function validateRepositoryCitations(request: CriterionAgentReviewRequest, review: CriterionAgentReviewResult): CriterionAgentReviewResult {
  if (!request.repositoryBrowsing || !review.available) return review;
  const paths = new Set(request.files.filter(file => !file.repoRelativePath.startsWith('.criterion-agent/')).map(file => file.repoRelativePath));
  const references = [review.evidenceReferences, ...(review.assessments ?? []).filter(item => !(request.criterionId === 'S006'
      && request.coverageGapIds?.includes(item.technologyId)
      && item.coverageDisposition === 'unresolved' && item.type === 'evidence_gap'
      && item.evidenceReferences.includes('.criterion-agent/S006/finding-summary.json'))).map(item => item.evidenceReferences),
    ...(review.assessments ?? []).flatMap(item => (item.failureBounds ?? []).map(bound => bound.evidenceReferences)),
    ...(review.reviewerActions ?? []).map(item => item.evidenceReferences)];
  if (references.some(citations => !citations.some(citation => paths.has(citation)))) {
    return { ...review, available: false, errors: [...review.errors, 'Agent review requires repository evidence for the review and every assessment and action; generated context alone is not evidence.'] };
  }
  return review;
}

export function prepareCriterionReviewWorkspace(request: CriterionAgentReviewRequest): PreparedCriterionReviewWorkspace {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'criterion-agent-review-'));
  try {
    fs.chmodSync(rootPath, 0o700);
    const docsRoot = path.join(rootPath, 'docs');
    fs.mkdirSync(docsRoot, { recursive: true, mode: 0o700 });

    const usedWorkspacePaths = new Set<string>();
    const entries = request.files.map(file => {
      const safeRelativePath = safeWorkspaceRelativePath(file.repoRelativePath);
      const workspacePath = path.join(docsRoot, safeRelativePath);
      const workspaceKey = path.relative(docsRoot, workspacePath).split(path.sep).join('/');
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
        workspacePath: path.relative(rootPath, workspacePath).split(path.sep).join('/')
      };
    });

    if (request.repositoryBrowsing) {
      fs.writeFileSync(path.join(rootPath, 'repository-files.json'), JSON.stringify(entries, null, 2), { mode: 0o600 });
    }
    const manifestPath = path.join(rootPath, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      criterionId: request.criterionId,
      instructions: request.instructions,
      schemaDescription: request.schemaDescription,
      ...(request.repositoryBrowsing ? { repositoryRoot: 'docs', fileIndex: 'repository-files.json' } : {}),
      files: request.repositoryBrowsing
        ? entries.filter(entry => entry.repoRelativePath.startsWith('.criterion-agent/'))
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

function unavailableResult(criterionId: string): CriterionAgentReviewResult {
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
    request.files.map(file => file.repoRelativePath)
  );
  const warnings = [
    ...stringArray(rawResult.warnings).map(warning => redactSensitiveText(warning)),
    ...normalized.warnings
  ];
  const errors = stringArray(rawResult.errors).map(error => redactSensitiveText(error));
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
  warnings: string[];
  errors: string[];
}

export function normalizeCriterionAgentAdvisoryPayload(
  payload: Record<string, unknown>,
  manifestEntries: string[]
): NormalizedCriterionAgentAdvisoryPayload {
  const rawEvidenceReferences = Array.isArray(payload.evidenceReferences) ? payload.evidenceReferences : [];
  const evidenceReferences = normalizeAdvisoryEvidenceReferences(rawEvidenceReferences, manifestEntries);
  const errors: string[] = [];
  const assessments = normalizeAssessments(payload.assessments, manifestEntries, errors);
  const reviewerActions = normalizeReviewerActions(payload.reviewerActions, manifestEntries, errors);
  const recommendation = parseAdvisoryRecommendation(payload.recommendation);
  const confidence = parseAdvisoryConfidence(payload.confidence);
  const summary = typeof payload.summary === 'string' ? redactSensitiveText(payload.summary).trim() : undefined;
  const rationale = typeof payload.rationale === 'string' ? redactSensitiveText(payload.rationale).trim() : undefined;
  if (!recommendation) errors.push('recommendation must be a supported advisory recommendation');
  if (!confidence) errors.push('confidence must be low, medium, high, or a finite number between 0 and 1');
  if (!summary) errors.push('summary must be a nonblank string');
  if (!rationale) errors.push('rationale must be a nonblank string');
  if (!Array.isArray(payload.evidenceReferences)) errors.push('evidenceReferences must be an array');
  else if (!evidenceReferences.length) errors.push('evidenceReferences must include a manifest entry');
  if (payload.assessments !== undefined && (!Array.isArray(payload.assessments) || assessments?.length !== payload.assessments.length)) {
    errors.push('Invalid or uncited assessments; the complete review was rejected.');
  }
  if (payload.reviewerActions !== undefined && (!Array.isArray(payload.reviewerActions) || reviewerActions?.length !== payload.reviewerActions.length)) {
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
    warnings: [
      ...(rawEvidenceReferences.length !== evidenceReferences.length
        ? ['Dropped uncited or unknown advisory evidence references']
        : [])
    ]
  };
}

function normalizeAssessments(
  value: unknown,
  manifestEntries: string[],
  errors: string[]
): CriterionAgentReviewResult['assessments'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const validTypes = new Set(['aligned_fact', 'substantive_concern', 'analyzer_limitation', 'evidence_gap', 'policy_question']);
  return value.flatMap((entry, index) => {
    const reject = (reason: string): [] => {
      if (errors.length < 16) errors.push(`Assessment ${index + 1}: ${reason}.`);
      return [];
    };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return reject('expected an object');
    const candidate = entry as Record<string, unknown>;
    const evidenceReferences = normalizeAdvisoryEvidenceReferences(
      Array.isArray(candidate.evidenceReferences) ? candidate.evidenceReferences : [],
      manifestEntries
    );
    const summary = typeof candidate.summary === 'string'
      ? redactSensitiveText(candidate.summary).trim()
      : '';
    const coverageDisposition = candidate.coverageDisposition as NonNullable<CriterionAgentReviewResult['assessments']>[number]['coverageDisposition'];
    if (coverageDisposition !== undefined && !['investigated', 'immaterial', 'unresolved'].includes(coverageDisposition)) return reject('invalid coverageDisposition');
    const failureBounds = normalizeFailureBounds(candidate.failureBounds, manifestEntries);
    if (candidate.failureBounds !== undefined && !failureBounds) return reject('invalid failureBounds fields or citations');
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
    const evidenceReferences = normalizeAdvisoryEvidenceReferences(item.evidenceReferences, manifestEntries);
    if (!evidenceReferences.length || evidenceReferences.length !== item.evidenceReferences.length) return undefined;
    bounds.push({ phase: item.phase, requirement: item.requirement, status: item.status,
      explanation: redactSensitiveText(item.explanation).trim(), evidenceReferences });
  }
  return bounds;
}

function normalizeReviewerActions(
  value: unknown,
  manifestEntries: string[],
  errors: string[]
): CriterionAgentReviewResult['reviewerActions'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry, index) => {
    const reject = (reason: string): [] => {
      if (errors.length < 16) errors.push(`Reviewer action ${index + 1}: ${reason}.`);
      return [];
    };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return reject('expected an object');
    const candidate = entry as Record<string, unknown>;
    const evidenceReferences = normalizeAdvisoryEvidenceReferences(
      Array.isArray(candidate.evidenceReferences) ? candidate.evidenceReferences : [],
      manifestEntries
    );
    const action = typeof candidate.action === 'string'
      ? redactSensitiveText(candidate.action).trim()
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

function normalizeAdvisoryEvidenceReferences(rawReferences: unknown[], manifestEntries: string[]): string[] {
  const references = rawReferences
    .map(reference => {
      if (typeof reference === 'string') {
        return reference;
      }
      if (reference && typeof reference === 'object' && !Array.isArray(reference)) {
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
