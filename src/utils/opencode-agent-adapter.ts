import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandRunner,
  CriterionAgentRecommendation,
  CriterionAgentReviewConfig,
  CriterionAgentReviewResult
} from '../types';
import {
  CriterionAgentReviewRequest,
  PreparedCriterionReviewWorkspace
} from './criterion-agent-review';
import { redactSensitiveText } from './redaction';

const REQUIRED_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR'];
const OPENCODE_RUN_MAX_OUTPUT_BYTES = 1024 * 1024;

export async function runOpenCodeAgentReview(
  request: CriterionAgentReviewRequest,
  workspace: PreparedCriterionReviewWorkspace,
  config: CriterionAgentReviewConfig,
  commandRunner: CommandRunner
): Promise<CriterionAgentReviewResult> {
  const baseUnavailable = (error: string): CriterionAgentReviewResult => ({
    available: false,
    criterionId: request.criterionId,
    evidenceReferences: [],
    warnings: [],
    errors: [redactSensitiveText(error)],
    metadata: openCodeMetadata(config, workspace)
  });

  if (config.providerConfigError) {
    return baseUnavailable(config.providerConfigError);
  }
  if (!config.modelLabel) {
    return baseUnavailable('OpenCode model label is required');
  }
  if (!config.readOnlyAgentName) {
    return baseUnavailable('OpenCode read-only agent name is required');
  }
  if (config.generatedProvider && !process.env[config.generatedProvider.apiKeyEnv]) {
    return baseUnavailable(`${config.generatedProvider.apiKeyEnv} is required for ${config.generatedProvider.name} OpenCode review`);
  }

  let invocation: OpenCodeInvocation;
  try {
    invocation = materializeOpenCodeInvocation(workspace, config);
  } catch (error) {
    return baseUnavailable(`Unable to materialize OpenCode invocation: ${error instanceof Error ? error.message : String(error)}`);
  }
  const configDebug = await commandRunner.run({
    command: 'opencode',
    args: ['debug', 'config'],
    cwd: workspace.rootPath,
    env: invocation.env,
    timeoutMs: config.timeoutMs
  });
  if (configDebug.status !== 'success') {
    return baseUnavailable(`Unable to verify OpenCode config: ${configDebug.errorMessage ?? configDebug.stderr}`);
  }

  const agentDebug = await commandRunner.run({
    command: 'opencode',
    args: ['debug', 'agent', config.readOnlyAgentName],
    cwd: workspace.rootPath,
    env: invocation.env,
    timeoutMs: config.timeoutMs
  });
  if (agentDebug.status !== 'success') {
    return baseUnavailable(`Unable to verify OpenCode agent: ${agentDebug.errorMessage ?? agentDebug.stderr}`);
  }

  const permissionError = validateDebugOutput(configDebug.stdout, agentDebug.stdout, invocation.provenancePaths);
  if (permissionError) {
    return baseUnavailable(permissionError);
  }

  const run = await commandRunner.run({
    command: 'opencode',
    args: [
      'run',
      '--agent',
      config.readOnlyAgentName,
      '--model',
      config.modelLabel,
      '--format',
      'json',
      request.instructions,
      '--file',
      workspace.manifestPath
    ],
    cwd: workspace.rootPath,
    env: invocation.env,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: OPENCODE_RUN_MAX_OUTPUT_BYTES
  });

  if (run.status !== 'success') {
    return baseUnavailable(`OpenCode review failed: ${run.errorMessage ?? run.stderr}`);
  }

  return normalizeOpenCodeResult(run.stdout, request, workspace, config);
}

export function materializeOpenCodeInvocation(
  workspace: PreparedCriterionReviewWorkspace,
  config: CriterionAgentReviewConfig
): OpenCodeInvocation {
  const opencodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'criterion-opencode-runtime-'));
  fs.chmodSync(opencodeRoot, 0o700);
  workspace.runtimeRootPath = opencodeRoot;
  const home = path.join(opencodeRoot, 'home');
  const configRoot = path.join(opencodeRoot, 'config');
  const dataRoot = path.join(opencodeRoot, 'data');
  const opencodeDataRoot = path.join(dataRoot, 'opencode');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(opencodeDataRoot, { recursive: true, mode: 0o700 });
  const generatedConfigPath = path.join(configRoot, 'opencode.json');
  if (!config.trustedConfigPath) {
    fs.writeFileSync(generatedConfigPath, JSON.stringify(buildGeneratedOpenCodeConfig(config), null, 2), { mode: 0o600 });
  }

  if (config.trustedAuthStorePath) {
    const authTarget = path.join(opencodeDataRoot, path.basename(config.trustedAuthStorePath));
    fs.cpSync(config.trustedAuthStorePath, authTarget, { recursive: true });
    setOwnerOnlyPermissions(authTarget);
  } else if (config.generatedProvider) {
    const apiKey = process.env[config.generatedProvider.apiKeyEnv];
    if (apiKey) {
      const authTarget = path.join(opencodeDataRoot, 'auth.json');
      fs.writeFileSync(authTarget, JSON.stringify({
        [config.generatedProvider.name]: {
          type: 'api',
          key: apiKey
        }
      }, null, 2), { mode: 0o600 });
    }
  }

  const env: Record<string, string | undefined> = {};
  for (const key of REQUIRED_ENV_KEYS) {
    env[key] = process.env[key];
  }
  for (const key of [...(config.providerEnvAllowlist ?? []), ...(config.proxyEnvAllowlist ?? [])]) {
    env[key] = process.env[key];
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = configRoot;
  env.XDG_DATA_HOME = dataRoot;
  env.OPENCODE_CONFIG = config.trustedConfigPath ?? generatedConfigPath;
  env.OPENCODE_CONFIG_DIR = configRoot;
  if (config.endpoint) {
    env.OPENCODE_ENDPOINT = config.endpoint;
  }

  return {
    env,
    runtimeRootPath: opencodeRoot,
    provenancePaths: [
      config.trustedConfigPath,
      generatedConfigPath,
      config.trustedAuthStorePath,
      opencodeRoot
    ].filter((candidate): candidate is string => Boolean(candidate))
  };
}

export function removeOpenCodeRuntimeCredentials(workspace: PreparedCriterionReviewWorkspace): void {
  if (workspace.runtimeRootPath) {
    fs.rmSync(workspace.runtimeRootPath, {
      recursive: true,
      force: true
    });
    return;
  }
  fs.rmSync(path.join(workspace.rootPath, '.opencode-runtime', 'data', 'opencode'), {
    recursive: true,
    force: true
  });
}

interface OpenCodeInvocation {
  env: Record<string, string | undefined>;
  runtimeRootPath: string;
  provenancePaths: string[];
}

function buildGeneratedOpenCodeConfig(config: CriterionAgentReviewConfig): Record<string, unknown> {
  const modelLabel = config.modelLabel;
  const agentName = config.readOnlyAgentName ?? 'reviewer';
  const generated: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {},
    plugin: []
  };

  if (modelLabel) {
    generated.model = modelLabel;
  }

  if (config.generatedProvider) {
    generated.provider = {
      [config.generatedProvider.name]: {
        models: {
          [config.generatedProvider.modelId]: {}
        }
      }
    };
  }

  generated.agent = {
    [agentName]: {
      description: 'Read-only criterion advisory reviewer',
      mode: 'primary',
      model: modelLabel,
      permission: {
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        edit: 'deny',
        bash: 'deny',
        external_directory: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
        task: 'deny',
        skill: 'deny',
        todowrite: 'deny',
        lsp: 'deny',
        question: 'deny',
        doom_loop: 'deny'
      }
    }
  };

  return generated;
}

function setOwnerOnlyPermissions(targetPath: string): void {
  const stats = fs.lstatSync(targetPath);
  if (stats.isSymbolicLink()) {
    return;
  }
  fs.chmodSync(targetPath, stats.isDirectory() ? 0o700 : 0o600);
  if (!stats.isDirectory()) {
    return;
  }
  for (const entry of fs.readdirSync(targetPath)) {
    setOwnerOnlyPermissions(path.join(targetPath, entry));
  }
}

function validateDebugOutput(configDebug: string, agentDebug: string, trustedPaths: string[]): string | undefined {
  const config = parseJsonObject(configDebug);
  const agent = parseJsonObject(agentDebug);
  if (!config) {
    return 'OpenCode config debug output was not parseable JSON';
  }
  if (!agent) {
    return 'OpenCode agent debug output was not parseable JSON';
  }

  const configEntryError = validateConfigHasNoExtensionEntries(config);
  if (configEntryError) {
    return configEntryError;
  }

  const permissionError = validateResolvedAgentPermissions(agent);
  if (permissionError) {
    return permissionError;
  }

  if (!trustedPaths.some(trustedPath => configDebug.includes(trustedPath) || agentDebug.includes(trustedPath))) {
    return 'OpenCode config provenance did not prove generated trusted paths';
  }
  return undefined;
}

function validateConfigHasNoExtensionEntries(config: Record<string, unknown> | undefined): string | undefined {
  if (!config) {
    return undefined;
  }
  if (!isEmptyExtensionConfig(config.mcp)) {
    return 'OpenCode read-only validation rejected MCP entries';
  }
  if (!isEmptyExtensionConfig(config.plugin)) {
    return 'OpenCode read-only validation rejected plugin entries';
  }
  return undefined;
}

function isEmptyExtensionConfig(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).length === 0;
  }
  return false;
}

function validateResolvedAgentPermissions(agent: Record<string, unknown> | undefined): string | undefined {
  const toolError = validateResolvedAgentTools(agent);
  if (toolError) {
    return toolError;
  }
  if (agent?.tools && typeof agent.tools === 'object') {
    return undefined;
  }

  const permissions = agent?.permission;
  if (!Array.isArray(permissions)) {
    return 'OpenCode read-only validation could not recognize effective permission schema';
  }

  for (const entry of permissions) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const permissionEntry = entry as Record<string, unknown>;
    const permission = String(permissionEntry.permission ?? '');
    const action = String(permissionEntry.action ?? '');
    if (permission === '*' && action !== 'deny') {
      return 'OpenCode read-only validation rejected wildcard permission';
    }
    if (action !== 'deny' && !isAllowedLegacyReadOnlyPermission(permission)) {
      return `OpenCode read-only validation rejected ${permission || 'unknown'} permission`;
    }
  }

  return undefined;
}

function isAllowedLegacyReadOnlyPermission(permission: string): boolean {
  return permission === 'read' || permission === 'glob' || permission === 'grep' || permission === 'list';
}

function validateResolvedAgentTools(agent: Record<string, unknown> | undefined): string | undefined {
  const tools = agent?.tools;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    return undefined;
  }
  const resolvedTools = tools as Record<string, unknown>;

  for (const tool of ['read', 'glob', 'grep']) {
    if (resolvedTools[tool] !== true) {
      return `OpenCode read-only validation requires ${tool} tool access`;
    }
  }

  const readOnlyTools = new Set(['read', 'glob', 'grep', 'list', 'todoread']);
  const nonCapabilityTools = new Set(['invalid']);
  for (const [tool, value] of Object.entries(resolvedTools)) {
    if (nonCapabilityTools.has(tool)) {
      continue;
    }
    if (!readOnlyTools.has(tool) && value !== false) {
      return `OpenCode read-only validation rejected ${tool} tool access`;
    }
  }

  return undefined;
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOpenCodeResult(
  output: string,
  request: CriterionAgentReviewRequest,
  workspace: PreparedCriterionReviewWorkspace,
  config: CriterionAgentReviewConfig
): CriterionAgentReviewResult {
  const parsed = parseOpenCodeReviewPayload(output);
  if (!parsed) {
    return {
      available: false,
      criterionId: request.criterionId,
      evidenceReferences: [],
      warnings: [],
      errors: ['OpenCode returned malformed JSON']
    };
  }

  const rawEvidenceReferences = Array.isArray(parsed.evidenceReferences) ? parsed.evidenceReferences : [];
  const evidenceReferences = normalizeEvidenceReferences(rawEvidenceReferences, workspace.manifestEntries);
  const warnings = rawEvidenceReferences.length !== evidenceReferences.length
    ? ['Dropped uncited or unknown advisory evidence references']
    : [];
  const recommendation = parseRecommendation(parsed.recommendation);
  const confidence = parseConfidence(parsed.confidence);
  const summary = typeof parsed.summary === 'string' ? redactSensitiveText(parsed.summary) : undefined;
  const rationale = typeof parsed.rationale === 'string' ? redactSensitiveText(parsed.rationale) : undefined;

  if (!recommendation || !confidence || !summary || !rationale) {
    return {
      available: false,
      criterionId: request.criterionId,
      evidenceReferences: [],
      metadata: openCodeMetadata(config, workspace),
      warnings,
      errors: ['OpenCode returned incomplete advisory JSON']
    };
  }

  return {
    available: true,
    criterionId: request.criterionId,
    recommendation,
    confidence,
    summary,
    rationale,
    evidenceReferences,
    metadata: openCodeMetadata(config, workspace),
    warnings,
    errors: []
  };
}

function openCodeMetadata(
  config: CriterionAgentReviewConfig,
  workspace: PreparedCriterionReviewWorkspace
): CriterionAgentReviewResult['metadata'] {
  return {
    adapter: 'opencode',
    modelLabel: config.modelLabel,
    endpointFamily: config.endpointFamily,
    reviewMode: 'read-only',
    promptInputSanitized: true,
    reviewWorkspaceSanitized: true,
    retainedWorkspacePath: config.debugRetainWorkspace ? workspace.rootPath : undefined
  };
}

function parseRecommendation(value: unknown): CriterionAgentRecommendation | undefined {
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

function parseConfidence(value: unknown): 'low' | 'medium' | 'high' | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  if (typeof value === 'number') {
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

function normalizeEvidenceReferences(rawReferences: unknown[], manifestEntries: string[]): string[] {
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

function parseOpenCodeReviewPayload(output: string): Record<string, unknown> | undefined {
  const parsed = parseJsonObject(output);
  if (parsed && !parsed.type) {
    return parsed;
  }

  const textParts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const event = parseJsonObject(line.trim());
    if (!event) {
      continue;
    }
    const text = extractOpenCodeEventText(event);
    if (text) {
      textParts.push(text);
    }
  }

  if (textParts.length === 0) {
    return undefined;
  }
  return parseJsonObjectFromText(textParts.join('\n').trim());
}

function extractOpenCodeEventText(event: Record<string, unknown>): string | undefined {
  const part = event.part;
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const candidate = part as Record<string, unknown>;
    if (candidate.type === 'text') {
      return firstString(candidate.text, candidate.content);
    }
  }

  if (event.type === 'text') {
    return firstString(event.text, event.content);
  }

  const message = event.message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    return extractMessageText(message as Record<string, unknown>);
  }

  return undefined;
}

function extractMessageText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content.flatMap(entry => {
    if (typeof entry === 'string') {
      return [entry];
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const text = firstString((entry as Record<string, unknown>).text, (entry as Record<string, unknown>).content);
      return text ? [text] : [];
    }
    return [];
  });

  return parts.length ? parts.join('\n') : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function parseJsonObjectFromText(text: string): Record<string, unknown> | undefined {
  const candidates: Record<string, unknown>[] = [];
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const fenced = parseJsonObject(fenceMatch[1].trim());
    if (fenced) {
      candidates.push(fenced);
    }
  }

  for (const candidate of extractBalancedJsonObjectTexts(text)) {
    const parsed = parseJsonObject(candidate);
    if (parsed) {
      candidates.push(parsed);
    }
  }

  const whole = parseJsonObject(text);
  if (whole) {
    candidates.push(whole);
  }

  return [...candidates].reverse().find(isAdvisoryPayload) ?? candidates[candidates.length - 1];
}

function isAdvisoryPayload(candidate: Record<string, unknown>): boolean {
  return (
    'recommendation' in candidate &&
    'confidence' in candidate &&
    typeof candidate.summary === 'string' &&
    typeof candidate.rationale === 'string' &&
    Array.isArray(candidate.evidenceReferences)
  );
}

function extractBalancedJsonObjectTexts(text: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') {
      continue;
    }
    const end = findBalancedObjectEnd(text, start);
    if (end > start) {
      candidates.push(text.slice(start, end + 1));
    }
  }
  return candidates;
}

function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}
