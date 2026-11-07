import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  CriterionAgentReviewConfig,
  CriterionAgentReviewResult,
  CriterionAgentRunDiagnosis,
  CriterionAgentUsage,
  EvaluationStatus
} from '../types';
import {
  CRITERION_AGENT_TIMEOUT_MS,
  CriterionAgentReviewRequest,
  normalizeCriterionAgentAdvisoryPayload,
  PreparedCriterionReviewWorkspace
} from './criterion-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { getLogger } from './logger';
import { decodeOpenCodeOutput, openCodeEventTrace, OpenCodeEventTrace, OpenCodeOutput, openCodeOutputTraces, parseJsonObject } from './opencode-output';
import { errorMessage } from './type-guards';

const REQUIRED_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR'];
// Tool events dominate the review run's output and the answer comes last. Keep
// the newest output so large modules still produce a review.
const OPENCODE_RUN_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const OPENCODE_SILENCE_MS = 30_000;
const FAIL_INSTRUCTION = 'The tool failed this criterion on its own findings, and that status stands. For each failure, explain in plain words what the module does, which rule it breaks, and what the module team must change, so a reviewer who has not read the code can follow it. Confirm each failure from the source; when one looks like an analyzer mistake, say so and cite the evidence. Use likely_sufficient only when every failure looks like an analyzer mistake.';
const HEARTBEAT_INTERVAL_MS = 30_000;
// A review that writes nothing for this long is treated as stalled, however much of its timeout remains.
const REVIEW_IDLE_TIMEOUT_MS = 300_000;
// opencode debug config, debug agent and models --refresh check the setup and fetch the price catalog; none runs the review.
const SETUP_STAGE_TIMEOUT_MS = 120_000;

export async function runOpenCodeAgentReview(
  request: CriterionAgentReviewRequest,
  workspace: PreparedCriterionReviewWorkspace,
  config: CriterionAgentReviewConfig,
  commandRunner: CommandRunner
): Promise<CriterionAgentReviewResult> {
  const timeoutMs = config.timeoutMs ?? CRITERION_AGENT_TIMEOUT_MS;
  config = { ...config, timeoutMs };
  const baseUnavailable = (error: string): CriterionAgentReviewResult => ({
    available: false,
    criterionId: request.criterionId,
    evidenceReferences: [],
    warnings: [],
    errors: [redactEvaluatorSecrets(error)],
    metadata: openCodeMetadata(config, workspace)
  });

  const stages: Record<string, unknown>[] = [];
  const saveTrace = () => {
    if (config.debugRetainWorkspace) {
      fs.writeFileSync(path.join(workspace.rootPath, 'agent-debug.json'), JSON.stringify({
        version: 1, timeoutMs: config.timeoutMs, stages
      }, null, 2), { mode: 0o600 });
    }
  };
  const runStage = async (stage: string, command: CommandExecutionRequest): Promise<CommandExecutionResult> => {
    if (!config.debugRetainWorkspace) return commandRunner.run(command);
    const entry: Record<string, unknown> = { stage, startedAt: new Date().toISOString(), status: 'running' };
    stages.push(entry);
    saveTrace();
    let result: CommandExecutionResult;
    try {
      result = await commandRunner.run(command);
    } catch (error) {
      entry.status = 'runner_exception';
      entry.finishedAt = new Date().toISOString();
      saveTrace();
      throw error;
    }
    Object.assign(entry, {
      finishedAt: new Date().toISOString(), status: result.status, durationMs: result.durationMs,
      exitCode: result.exitCode, signal: result.signal,
      stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated ?? false, stderrTruncated: result.stderrTruncated ?? false
    });
    if (command.stdoutFormat === 'opencode-json') {
      const events = openCodeOutputTraces(result.stdout);
      entry.events = events.slice(0, 2000).map((event, index) => ({ record: index + 1, ...event }));
      entry.omittedEvents = Math.max(0, events.length - 2000);
    }
    saveTrace();
    return result;
  };

  // Shared orchestration performs these checks before evidence preparation. Keep
  // them here as defense for direct adapter callers and to narrow optional types.
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
    return baseUnavailable(`Unable to materialize OpenCode invocation: ${errorMessage(error)}`);
  }
  const configDebug = await runStage('debug-config', {
    command: 'opencode',
    args: ['debug', 'config'],
    cwd: workspace.rootPath,
    env: invocation.debugEnv,
    timeoutMs: Math.min(SETUP_STAGE_TIMEOUT_MS, timeoutMs),
    stdoutFormat: 'json'
  });
  if (configDebug.status !== 'success' || configDebug.stdoutTruncated) {
    return baseUnavailable(commandFailure('debug config', configDebug, config));
  }

  const agentDebug = await runStage('debug-agent', {
    command: 'opencode',
    args: ['debug', 'agent', config.readOnlyAgentName],
    cwd: workspace.rootPath,
    env: invocation.debugEnv,
    timeoutMs: Math.min(SETUP_STAGE_TIMEOUT_MS, timeoutMs),
    stdoutFormat: 'json'
  });
  if (agentDebug.status !== 'success' || agentDebug.stdoutTruncated) {
    return baseUnavailable(commandFailure('debug agent', agentDebug, config));
  }

  const permissionError = validateDebugOutput(configDebug.stdout, agentDebug.stdout, invocation.provenancePaths);
  if (permissionError) {
    return baseUnavailable(permissionError);
  }

  // OpenCode prices each step from its models.dev catalog; a run that starts before the catalog is cached reports a cost of 0.
  const catalog = await runStage('models-refresh', {
    command: 'opencode',
    args: ['models', config.modelLabel.split('/')[0], '--refresh'],
    cwd: workspace.rootPath,
    env: invocation.debugEnv,
    timeoutMs: Math.min(SETUP_STAGE_TIMEOUT_MS, timeoutMs)
  });

  const heartbeat = reviewHeartbeat(request.criterionId, timeoutMs);
  const run = await runStage('review', {
    command: 'opencode',
    args: [
      'run',
      '--agent',
      config.readOnlyAgentName,
      '--model',
      config.modelLabel,
      '--format',
      'json',
      [
        request.instructions,
        ...(config.deterministicStatus === EvaluationStatus.FAIL ? [FAIL_INSTRUCTION] : []),
        'Writing style for all report prose: write for a Technical Council decision-maker, not an implementation debugger. Use plain English, short sentences, and concrete outcomes. Lead with the conclusion and its operational impact.',
        'Summary: at most two short sentences, targeting 45 words total. State the overall judgment and the main risk or remaining decision. Do not list every dependency or repeat the recommendation label.',
        'Rationale: at most three short sentences, targeting 70 words total. Explain the decisive evidence, scope actually investigated, and material uncertainty without repeating the summary or narrating your investigation.',
        'Assessment summaries: one or two short sentences each, targeting 45 words. State the finding and why it matters. Distinguish an observed defect from behavior that has not been verified. Avoid raw assessment-type identifiers in prose.',
        'Reviewer actions: one direct sentence each, targeting 30 words. Name the specific fact to verify and the decision it resolves. Do not repeat the finding or combine unrelated checks.',
        'Describe operational behavior first: what happens when a dependency is unavailable, what is established, and what remains unknown. Keep analyzer limitations secondary; avoid internal terms such as configuration-absent outcomes in reader-facing prose.',
        'Consolidate repeated observations within each required subject assessment. Explain shared limitations once in the rationale, without dropping distinct risks, required assessments, or citations. Put necessary method names and configuration keys in assessment details, not in executive summaries or reviewer actions unless essential to identify the requested check.',
        'Before returning JSON, check consistency across recommendation, summary, rationale, assessments, and reviewer actions. Never describe behavior as proven in one field while marking it unverified in another. If evidence is incomplete or contradictory, retain that uncertainty throughout; do not resolve it by guessing. This self-check is not proof of correctness.',
        'Keep file paths in evidenceReferences rather than repeating source inventories in prose. Include a technical identifier or supporting line number only when needed to locate or explain decisive evidence or when criterion instructions require it. Explain unfamiliar jargon. Avoid implementation walkthroughs, boilerplate caveats, and repeated qualifications.',
        'These are writing targets, not limits on investigation or material findings. Preserve required citations, meaningful uncertainty, and criterion-specific coverage. Keep the required JSON schema and enum values unchanged.'
      ].join('\n'),
      '--file',
      workspace.manifestPath
    ],
    cwd: workspace.rootPath,
    env: invocation.env,
    timeoutMs: config.timeoutMs,
    idleTimeoutMs: Math.min(config.idleTimeoutMs ?? REVIEW_IDLE_TIMEOUT_MS, timeoutMs),
    stdoutFormat: 'opencode-json',
    maxOutputBytes: OPENCODE_RUN_MAX_OUTPUT_BYTES,
    keepStdoutTail: true,
    captureDebugTrace: true,
    onStdout: heartbeat.onStdout
  }).finally(heartbeat.stop);

  const cut = run.stdoutTruncated === true;
  const decoded = decodeOpenCodeOutput(run.stdout, cut);
  const events = openCodeOutputTraces(run.stdout);
  const usage = openCodeRunUsage(events, run.durationMs, catalog.status === 'success');
  if (run.status !== 'success' || (cut && !decoded.payload)) {
    const unavailable = baseUnavailable(commandFailure('run', run, config, decoded));
    unavailable.metadata = { ...unavailable.metadata!, usage };
    if (run.status === 'failed' || run.status === 'timed_out') {
      const diagnosis = diagnoseOpenCodeRun(run, events);
      unavailable.errors.push(redactEvaluatorSecrets(diagnosis.line, 600));
      unavailable.metadata.runDiagnosis = diagnosis.diagnosis;
    }
    return unavailable;
  }

  const result = normalizeOpenCodeResult(decoded, request, workspace, config);
  result.metadata = { ...result.metadata!, usage };
  if (cut) {
    result.warnings.push(`OpenCode run output exceeded the ${OPENCODE_RUN_MAX_OUTPUT_BYTES}-byte capture limit (stdout ${run.stdoutBytes ?? 'unknown'} bytes); earlier output was dropped and the review was read from the end of the output`);
  }
  if (!result.available) {
    result.errors.push(commandContext('run', run, config));
    if (decoded.diagnostic) result.errors.push(`OpenCode decode: ${decoded.diagnostic}`);
    result.errors.push(...(run.stdoutDiagnostics ?? []).map(diagnostic => `OpenCode capture: ${diagnostic}`));
  }
  return result;
}

/**
 * Logs every HEARTBEAT_INTERVAL_MS how long the review has run and what the agent has done: its model steps and tool
 * calls from OpenCode's JSON events, and how long ago it last wrote output. Only counts and allowlisted tool names
 * are logged, never repository content or agent text.
 */
function reviewHeartbeat(criterionId: string, timeoutMs: number): { onStdout: (chunk: Buffer) => void; stop: () => void } {
  const started = Date.now();
  let lastOutput = started;
  let pending = '';
  let steps = 0;
  let toolCalls = 0;
  let lastTool: string | undefined;
  const onStdout = (chunk: Buffer) => {
    lastOutput = Date.now();
    // A character split across chunks decodes to replacement characters inside a JSON string, which counting ignores.
    const lines = (pending + chunk.toString('utf8')).split('\n');
    pending = lines.pop() ?? '';
    // A line too long to be an event header is not worth holding; its event is not counted.
    if (pending.length > 1024 * 1024) pending = '';
    for (const line of lines) {
      const event = openCodeEventTrace(parseJsonObject(line));
      if (event.type === 'step_start') steps++;
      if (event.type === 'tool_use') {
        toolCalls++;
        lastTool = event.tool;
      }
    }
  };
  const timer = setInterval(() => {
    const now = Date.now();
    getLogger().info(`   ⏳ ${criterionId} agent review: ${minutes(now - started)} of ${minutes(timeoutMs)}; `
      + `${steps} model ${steps === 1 ? 'step' : 'steps'}, ${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}${lastTool ? ` (last: ${lastTool})` : ''}; `
      + `last output ${minutes(now - lastOutput)} ago`);
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return { onStdout, stop: () => clearInterval(timer) };
}

function minutes(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function commandContext(stage: string, run: CommandExecutionResult, config: CriterionAgentReviewConfig): string {
  return redactEvaluatorSecrets(`OpenCode ${stage}: ${run.durationMs}ms elapsed; timeout ${config.timeoutMs}ms; model ${config.modelLabel}; stdout ${run.stdoutBytes ?? 'unknown'} bytes; stderr ${run.stderrBytes ?? 'unknown'} bytes`, 600);
}

function commandFailure(stage: string, run: CommandExecutionResult, config: CriterionAgentReviewConfig, decoded?: OpenCodeOutput): string {
  const reason = run.status === 'success' ? 'capture truncated' : run.idleTimedOut ? 'stalled' : run.status;
  const provider = decoded?.providerError;
  const detail = provider ? [provider.name, provider.statusCode, provider.message].filter(value => value !== undefined).join(': ')
    : decoded?.diagnostic === 'final assistant message start not captured'
      ? 'kept the end of the output, but it did not contain the whole final answer'
      : redactEvaluatorSecrets(run.errorMessage ?? '', 500);
  return `${commandContext(stage, run, config)}; ${reason}${run.stdoutTruncated && run.status !== 'success' ? '; capture truncated' : ''}${detail ? `; ${detail}` : ''}`;
}

function openCodeRunUsage(events: OpenCodeEventTrace[], durationMs: number, priced: boolean): CriterionAgentUsage {
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
  let modelSteps = 0;
  let costUsd: number | undefined;
  for (const event of events) {
    if (event.type !== 'step_finish') continue;
    modelSteps += 1;
    tokens.input += event.tokens?.input ?? 0;
    tokens.output += event.tokens?.output ?? 0;
    tokens.reasoning += event.tokens?.reasoning ?? 0;
    tokens.cacheRead += event.tokens?.cacheRead ?? 0;
    if (event.cost !== undefined) costUsd = (costUsd ?? 0) + event.cost;
  }
  return { durationMs, modelSteps, tokens, ...(priced && costUsd !== undefined ? { costUsd } : {}) };
}

// OpenCode emits tool_use when a tool call ends and text when a text part ends, so a step in progress shows only its step_start.
function diagnoseOpenCodeRun(run: CommandExecutionResult, events: OpenCodeEventTrace[]): { line: string; diagnosis: CriterionAgentRunDiagnosis } {
  const toolCalls: Record<string, number> = {};
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
  let tokensReported = false;
  let stepsStarted = 0;
  let stepsFinished = 0;
  let toolErrors = 0;
  let answerTextParts = 0;
  for (const event of events) {
    if (event.type === 'step_start') stepsStarted += 1;
    if (event.type === 'text') answerTextParts += 1;
    if (event.type === 'tool_use' && event.tool) {
      toolCalls[event.tool] = (toolCalls[event.tool] ?? 0) + 1;
      if (event.status === 'error') toolErrors += 1;
    }
    if (event.type === 'step_finish') {
      stepsFinished += 1;
      if (event.tokens) {
        tokensReported = true;
        tokens.input += event.tokens.input ?? 0;
        tokens.output += event.tokens.output ?? 0;
        tokens.reasoning += event.tokens.reasoning ?? 0;
        tokens.cacheRead += event.tokens.cacheRead ?? 0;
      }
    }
  }
  const last = events[events.length - 1];
  const lastEvent = last && [last.type, last.tool, last.status, last.reason].filter(Boolean).join(' ');
  const calls = Object.values(toolCalls).reduce((sum, count) => sum + count, 0);
  const silentMs = run.lastStdoutMs === undefined ? undefined : Math.max(0, run.durationMs - run.lastStdoutMs);
  const timedOut = run.status === 'timed_out';
  const when = timedOut ? 'when stopped' : 'when it exited';
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const summary = !last
    ? run.stdoutBytes ? 'no OpenCode events in the kept output'
      : `no output from OpenCode before ${timedOut ? `${run.idleTimedOut ? 'the idle limit' : 'the timeout'} (likely provider or startup problem)` : 'it exited'}`
    : last.type === 'error' ? 'OpenCode reported an error'
      : last.type === 'step_finish' && last.reason === 'stop'
        ? `the model finished its answer, but OpenCode ${timedOut ? 'did not exit' : 'then failed'}`
        : silentMs !== undefined && silentMs >= OPENCODE_SILENCE_MS ? `silent for ${seconds(silentMs)} after the last event (likely waiting on the provider)`
          : last.type === 'tool_use' ? `still calling tools ${when} (${calls} tool calls; last: ${last.tool})`
            : last.type === 'text' ? `writing the final answer ${when}`
              : last.type === 'step_start' ? `a model step had started but finished no tool call or text ${when}`
                : last.type === 'step_finish' ? `starting the next model step ${when} (${calls} tool calls)`
                  : `last event was ${last.type} ${when}`;
  const diagnosis: CriterionAgentRunDiagnosis = {
    summary, events: events.length, stepsStarted, stepsFinished, toolCalls, toolErrors, answerTextParts, lastEvent,
    firstOutputMs: run.firstStdoutMs, silentMs, outputTruncated: run.stdoutTruncated === true,
    ...(tokensReported ? { tokens } : {})
  };
  const tools = Object.entries(toolCalls).sort((left, right) => right[1] - left[1]).map(([tool, count]) => `${tool} ${count}`);
  const line = [
    `OpenCode run diagnosis: ${summary}`,
    run.firstStdoutMs !== undefined ? `first output after ${seconds(run.firstStdoutMs)}` : undefined,
    silentMs !== undefined ? `last output ${seconds(silentMs)} before ${timedOut ? 'the stop' : 'exit'}` : undefined,
    ...(last ? [
      `events ${events.length}`,
      `steps started ${stepsStarted}, finished ${stepsFinished}`,
      tools.length ? `tool calls ${tools.join(', ')}${toolErrors ? ` (${toolErrors} failed)` : ''}` : 'no tool calls',
      answerTextParts ? `answer text parts ${answerTextParts}` : 'no answer text',
      tokensReported ? `tokens input ${tokens.input}, output ${tokens.output}, reasoning ${tokens.reasoning}, cache read ${tokens.cacheRead}` : undefined,
      `last event ${lastEvent}`
    ] : []),
    diagnosis.outputTruncated ? 'earlier output was dropped at the capture limit, so counts cover only the kept end' : undefined
  ].filter(Boolean).join('; ');
  return { line, diagnosis };
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
    // OpenCode's preparatory commands leave lock directories in their state directory, which keep the review run from
    // reading the refreshed models.dev catalog, so it would not know the model's price.
    debugEnv: { ...env, XDG_STATE_HOME: path.join(opencodeRoot, 'debug-state') },
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
  debugEnv: Record<string, string | undefined>;
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
    // OpenCode titles each session with its small model, by default a provider's own pick (claude-haiku on OpenRouter),
    // whose cost the run's steps do not report.
    generated.small_model = modelLabel;
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
  if (config.type === 'unsafe_output' || agent.type === 'unsafe_output') {
    return 'OpenCode debug output was unsafe to sanitize';
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

function normalizeOpenCodeResult(
  decoded: OpenCodeOutput,
  request: CriterionAgentReviewRequest,
  workspace: PreparedCriterionReviewWorkspace,
  config: CriterionAgentReviewConfig
): CriterionAgentReviewResult {
  const parsed = decoded.payload;
  if (!parsed) {
    const reasons = {
      malformed_json: 'OpenCode returned malformed JSON',
      no_assistant_text: 'OpenCode returned no assistant text',
      incomplete_response: `OpenCode returned incomplete response (finish: ${decoded.finishReason ?? 'missing'})`,
      provider_error: `OpenCode provider error: ${Object.values(decoded.providerError ?? {}).join(': ')}`
    };
    return {
      available: false,
      criterionId: request.criterionId,
      evidenceReferences: [],
      metadata: openCodeMetadata(config, workspace),
      warnings: [],
      errors: [reasons[decoded.failure ?? 'malformed_json']]
    };
  }

  const normalized = normalizeCriterionAgentAdvisoryPayload(parsed, workspace.manifestEntries, request.dropInvalidItems);

  if (normalized.errors.length) {
    return {
      available: false,
      criterionId: request.criterionId,
      evidenceReferences: [],
      metadata: openCodeMetadata(config, workspace),
      warnings: normalized.warnings,
      errors: ['OpenCode returned incomplete advisory JSON', ...normalized.errors]
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
    metadata: openCodeMetadata(config, workspace),
    warnings: normalized.warnings,
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
