import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandRunner,
  CriterionAgentReviewConfig,
  CriterionAgentReviewResult,
  EvaluationRun,
  EvaluationStatus
} from '../types';
import { LocalCommandRunner } from './command-runner';
import { isWithinRepo } from './repo-files';
import { removeOpenCodeRuntimeCredentials, runOpenCodeAgentReview } from './opencode-agent-adapter';
import { redactSensitiveText } from './redaction';

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

  const agentReview = await request.review(request.evaluationRun.agentReview, request.evaluationRun.commandRunner);
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
    return config.fakeResult ?? {
      available: true,
      criterionId: request.criterionId,
      recommendation: 'needs_reviewer_judgment',
      confidence: 'medium',
      summary: 'Fake criterion-agent review completed.',
      rationale: 'Fake adapter was configured for deterministic tests.',
      evidenceReferences: request.files.slice(0, 1).map(file => file.repoRelativePath),
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
    };
  }

  let workspace: PreparedCriterionReviewWorkspace;
  try {
    workspace = prepareCriterionReviewWorkspace(request);
  } catch (error) {
    return { ...unavailable, errors: [`Unable to prepare agent review workspace: ${error instanceof Error ? error.message : String(error)}`] };
  }
  try {
    return await runOpenCodeAgentReview(
      request,
      workspace,
      config,
      commandRunner ?? new LocalCommandRunner(false)
    );
  } finally {
    removeOpenCodeRuntimeCredentials(workspace);
    if (!config.debugRetainWorkspace) {
      fs.rmSync(workspace.rootPath, { recursive: true, force: true });
    }
  }
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
      fs.writeFileSync(workspacePath, redactSensitiveText(file.content, MAX_AGENT_REVIEW_FILE_BYTES), { mode: 0o600 });
      return {
        id: safeRelativePath,
        repoRelativePath: file.repoRelativePath,
        workspacePath: path.relative(rootPath, workspacePath).split(path.sep).join('/')
      };
    });

    const manifestPath = path.join(rootPath, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      criterionId: request.criterionId,
      instructions: redactSensitiveText(request.instructions),
      schemaDescription: request.schemaDescription,
      files: entries
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

function pathIsInsideRepository(repositoryPath: string, candidatePath: string): boolean {
  const repoRoot = path.resolve(repositoryPath);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === repoRoot || resolvedCandidate.startsWith(`${repoRoot}${path.sep}`) || isWithinRepo(repositoryPath, candidatePath);
}

function safeWorkspaceRelativePath(repoRelativePath: string): string {
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
