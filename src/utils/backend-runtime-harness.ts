import { ChildProcess, spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  BackendEvidence,
  BackendRuntimeAction,
  BackendRuntimeContainer,
  BackendRuntimeEvidence,
  BackendRuntimeHarness,
  BackendRuntimeOutcome,
  BackendRuntimePlan,
  EvaluationRun
} from '../types';
import { descriptorEndpoints } from './backend-endpoints';
import { getBackendEvidence } from './backend-evidence';
import { probeProgram, ProbeInput, ProbeOutput } from './backend-runtime-probe';
import { addEvaluatorSecretValues, redactEvaluatorSecrets, redactEvaluatorSecretsInValue } from './redaction';
import { overflowLine, reportText } from './report-text';
import { errorMessage, isRecord } from './type-guards';

export const RUNTIME_LABEL = 'tc-module-eval.run';
export const RUNTIME_IMAGES_PATH = path.resolve(__dirname, '../../config/backend-runtime-images.json');
export const RUNTIME_TENANTS = ['tcevala', 'tcevalb'];

export type RuntimeImageRole = 'maven' | 'gradle' | 'postgres' | 'kafka' | 'node';
export type RuntimeImages = Record<RuntimeImageRole, string>;

export interface BackendRuntimeLimits {
  buildMs: number;
  runtimeMs: number;
  pullMs: number;
  commandMs: number;
  healthChunkMs: number;
  healthSettleMs: number;
  laterStepsMs: number;
  requestTimeoutMs: number;
  bodyChars: number;
  maxResponseBytes: number;
  probeOutputBytes: number;
  buildOutputBytes: number;
  cleanupRetryMs: number;
}

export const BACKEND_RUNTIME_LIMITS: Readonly<BackendRuntimeLimits> = {
  buildMs: 15 * 60_000,
  runtimeMs: 10 * 60_000,
  pullMs: 5 * 60_000,
  commandMs: 2 * 60_000,
  healthChunkMs: 20_000,
  healthSettleMs: 60_000,
  laterStepsMs: 3 * 60_000,
  requestTimeoutMs: 15_000,
  bodyChars: 2_000,
  maxResponseBytes: 1024 * 1024,
  probeOutputBytes: 2 * 1024 * 1024,
  buildOutputBytes: 8 * 1024,
  cleanupRetryMs: 1_000
};

const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._/-]{0,200}(?::[\w.-]{1,128})?@sha256:[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MODULE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const VOLUME_PATH = /^\/[\w./-]{0,255}$/;
const EXPOSED_TCP_PORT = /^(\d{1,5})\/tcp$/;
const MAX_ENV = 200;
const CLEANUP_PASSES = 3;
const MAX_ENV_VALUE_CHARS = 4096;
const MAX_GET_PATHS = 25;
const MAX_COLLECTIONS = 3;
const MAX_LISTED = 200;
const DEFAULT_PORT = 8081;
const DB_USER = 'folio_admin';
const DB_NAME = 'okapi_modules';
const OKAPI_STUB_URL = 'http://okapi-stub:9130';
const EGRESS_TARGETS = [{ host: '1.1.1.1', port: 443 }, { host: '8.8.8.8', port: 53 }, { host: '169.254.169.254', port: 80 }];
const BLOCKED_EGRESS = /^(?:failed \((?:ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND)\)|timed out)$/;
const MAX_PATH_CHARS = 300;
const EGRESS_DNS_NAME = 'github.com';
const OKAPI_STUB = "require('http').createServer((request, response) => { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('Not found'); }).listen(9130);";
const DATABASE_QUERY = `select json_build_object(
  'schemas', coalesce((select json_agg(json_build_object('name', s.nspname, 'tables', (select count(*) from pg_tables t where t.schemaname = s.nspname)) order by s.nspname)
    from (select nspname from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema' order by nspname limit ${MAX_LISTED}) s), '[]'::json),
  'publicTables', coalesce((select json_agg(p.tablename order by p.tablename) from (select tablename from pg_tables where schemaname = 'public' order by tablename limit ${MAX_LISTED}) p), '[]'::json))`;
const KAFKA_ENV: Record<string, string> = {
  KAFKA_NODE_ID: '1',
  KAFKA_PROCESS_ROLES: 'broker,controller',
  KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
  KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:9092',
  KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
  KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
  KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
  KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
  KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
  KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
  KAFKA_NUM_PARTITIONS: '1'
};

/** Reads the committed image pins; every image must be pinned by digest. */
export function loadRuntimeImages(file = RUNTIME_IMAGES_PATH): RuntimeImages {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const roles: RuntimeImageRole[] = ['maven', 'gradle', 'postgres', 'kafka', 'node'];
  if (!isRecord(value)) throw new Error(`${file} is not a JSON object`);
  for (const role of roles) {
    const reference = value[role];
    if (typeof reference !== 'string' || !IMAGE_REFERENCE.test(reference)) throw new Error(`${file}: the ${role} image must be pinned by digest (name@sha256:...)`);
  }
  return Object.fromEntries(roles.map(role => [role, value[role]])) as RuntimeImages;
}

/** What the harness runs from the repository: the template's env lists and handlers, the build files and the Dockerfile. */
export function backendRuntimePlan(evidence: BackendEvidence): BackendRuntimePlan | string {
  if (evidence.kind !== 'backend-module' && evidence.kind !== 'edge-module') return 'the repository is not a backend or edge module';
  const template = evidence.template;
  const descriptor = template?.descriptor;
  if (!template || !isRecord(descriptor)) return 'there is no readable module descriptor template';
  const files = new Set(evidence.snapshot.files.map(file => file.path));
  if (!files.has('Dockerfile')) return 'the repository has no Dockerfile at its root';
  const build = files.has('pom.xml') ? { buildTool: 'maven' as const, buildDir: '' }
    : files.has('build.gradle') || files.has('build.gradle.kts') ? { buildTool: 'gradle' as const, buildDir: '' }
      : files.has('service/build.gradle') || files.has('service/build.gradle.kts') ? { buildTool: 'gradle' as const, buildDir: 'service' }
        : undefined;
  if (!build) return 'the repository has no Maven or Gradle build at its root or in service/';

  const unresolved = new Set(template.placeholders.flatMap(placeholder => placeholder.value === undefined ? placeholder.pointers : []));
  const skippedEnv: BackendRuntimePlan['skippedEnv'] = [];
  const env = new Map<string, BackendRuntimePlan['env'][number]>();
  const lists: Array<[string, unknown]> = [['/env', descriptor.env], ['/launchDescriptor/env', isRecord(descriptor.launchDescriptor) ? descriptor.launchDescriptor.env : undefined]];
  let read = 0;
  for (const [pointer, list] of lists) {
    if (!Array.isArray(list)) continue;
    for (const [index, entry] of list.entries()) {
      const name = isRecord(entry) && typeof entry.name === 'string' ? entry.name.slice(0, 200) : `${pointer}/${index}`;
      if (++read > MAX_ENV) continue;
      if (!isRecord(entry) || typeof entry.name !== 'string' || !ENV_NAME.test(entry.name)) {
        skippedEnv.push({ name, reason: 'not a variable name' });
        continue;
      }
      const value = typeof entry.value === 'string' ? entry.value : typeof entry.value === 'number' || typeof entry.value === 'boolean' ? String(entry.value) : undefined;
      if (value === undefined) skippedEnv.push({ name, reason: 'no value' });
      else if (unresolved.has(`${pointer}/${index}/value`)) skippedEnv.push({ name, reason: 'its value has a build placeholder the build properties do not define' });
      else if (value.length > MAX_ENV_VALUE_CHARS || value.includes('\0')) skippedEnv.push({ name, reason: `its value is longer than ${MAX_ENV_VALUE_CHARS} characters or has a NUL character` });
      else env.set(name, { name, value, source: pointer.slice(1) });
    }
  }

  if (read > MAX_ENV) skippedEnv.push({ name: `${read - MAX_ENV} more`, reason: `over the limit of ${MAX_ENV} variables` });

  const infrastructure: BackendRuntimePlan['infrastructure'] = [];
  if (evidence.storage.present || env.has('DB_HOST')) infrastructure.push('postgres');
  if (env.has('KAFKA_HOST')) infrastructure.push('kafka');

  const endpoints = descriptorEndpoints(descriptor);
  const plain = (endpointPath: string) => endpointPath.length <= MAX_PATH_CHARS && /^\/(?!\/)[^{}*?#\s\\]*$/.test(endpointPath);
  const getPaths = [...new Set(endpoints.filter(endpoint => endpoint.method === 'GET' && plain(endpoint.path)).map(endpoint => endpoint.path))];
  const posted = new Set(endpoints.filter(endpoint => endpoint.method === 'POST').map(endpoint => endpoint.path));
  const itemPaths = endpoints.filter(endpoint => endpoint.method === 'GET' && endpoint.path.length <= MAX_PATH_CHARS
    && /^\/(?!\/)[^{}*?#\s\\]*\/\{[^{}/\\]+\}$/.test(endpoint.path)).map(endpoint => endpoint.path);
  const collections = getPaths.filter(getPath => posted.has(getPath)).slice(0, MAX_COLLECTIONS).map(collectionPath => {
    const itemPath = itemPaths.find(item => item.slice(0, item.lastIndexOf('/')) === collectionPath);
    return itemPath ? { path: collectionPath, itemPath } : { path: collectionPath };
  });
  const id = descriptor.id;
  return {
    moduleId: typeof id === 'string' && MODULE_ID.test(id) && !unresolved.has('/id') ? id : 'module-1.0.0',
    ...build,
    infrastructure,
    env: [...env.values()],
    skippedEnv,
    getPaths: getPaths.slice(0, MAX_GET_PATHS),
    getPathsCut: Math.max(0, getPaths.length - MAX_GET_PATHS),
    collections
  };
}

function emptyEvidence(outcome: BackendRuntimeOutcome, problem?: string): BackendRuntimeEvidence {
  return {
    outcome,
    ...(problem ? { problem } : {}),
    images: [],
    env: { template: [], harness: [], skipped: [] },
    tenants: [],
    getRequests: [],
    getRequestsCut: 0,
    actions: [],
    cleanup: { remaining: [], problems: [] }
  };
}

/** The run's runtime evidence; the harness runs at most once per evaluation, and only with --allow-runtime-checks. */
export function getBackendRuntimeEvidence(run: EvaluationRun, repoPath: string): Promise<BackendRuntimeEvidence> {
  return run.getOrCreateArtifact('backendRuntimeEvidence', async () => {
    if (!run.backendRuntime) return emptyEvidence('not-configured');
    const plan = backendRuntimePlan(await getBackendEvidence(run, repoPath));
    if (typeof plan === 'string') return emptyEvidence('not-run', plan);
    return run.backendRuntime.collect(repoPath, plan);
  });
}

/** What became of the runtime harness, for a report row. */
export function runtimeOutcomeText(outcome: BackendRuntimeOutcome, problem?: string): string {
  const reason = problem ? `: ${reportText(problem)}` : '';
  switch (outcome) {
    case 'not-configured': return 'Not collected: --allow-runtime-checks was not given';
    case 'not-run': return `The runtime harness did not run${reason}`;
    case 'build-failed': return `The module could not be built in Docker${reason}`;
    case 'start-failed': return `The module did not start in Docker${reason}`;
    case 'collected': return `The module ran in Docker${reason}`;
  }
}

/** Report rows for the Docker daemon the harness used and for what its cleanup left behind. */
export function runtimeDockerLines(docker: BackendRuntimeEvidence['docker'], cleanup: BackendRuntimeEvidence['cleanup']): string[] {
  const left = [...cleanup.remaining, ...cleanup.problems];
  return [
    ...(docker ? [`  - Docker ${reportText(docker.serverVersion ?? 'unknown version')}${docker.context ? `, context ${reportText(docker.context)}` : ''}, ${docker.rootless
      ? 'rootless' : 'not rootless (root-equivalent on this host)'}`] : []),
    ...(left.length ? ['  - Cleanup left Docker resources of this run behind; remove them by hand:', ...left.slice(0, 20).map(item => `    - ${reportText(item)}`),
      ...overflowLine(left.length, 20)] : [])
  ];
}

export interface DockerCommand {
  args: string[];
  timeoutMs: number;
  /** Written to the command's standard input. */
  input?: string;
  /** Another Docker command whose standard output is this command's standard input. */
  stdinFrom?: string[];
  maxOutputBytes?: number;
  /** Keep the end of the output instead of its start. */
  keepTail?: boolean;
  /** Variables for the Docker CLI process itself, added to the evaluator's environment. */
  cliEnv?: Record<string, string>;
}

export interface DockerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/** Runs the Docker CLI. The CLI's own environment selects the daemon; no container receives it. */
export interface DockerRunner {
  run(command: DockerCommand): Promise<DockerResult>;
  runSync(args: string[], timeoutMs: number): DockerResult;
  /** Kills every Docker CLI process `run` started that is still running. */
  cancel(): void;
}

export class CliDockerRunner implements DockerRunner {
  private readonly live = new Set<ChildProcess>();

  constructor(private readonly executable = 'docker') {}

  cancel(): void {
    for (const child of this.live) child.kill('SIGKILL');
  }

  run(command: DockerCommand): Promise<DockerResult> {
    const max = command.maxOutputBytes ?? 64 * 1024;
    const env = command.cliEnv ? { ...process.env, ...command.cliEnv } : process.env;
    return new Promise(resolve => {
      const source = command.stdinFrom ? spawn(this.executable, command.stdinFrom, { stdio: ['ignore', 'pipe', 'pipe'], env }) : undefined;
      const child = spawn(this.executable, command.args, { stdio: ['pipe', 'pipe', 'pipe'], env });
      for (const process of [source, child]) {
        if (!process) continue;
        this.live.add(process);
        process.on('close', () => this.live.delete(process));
      }
      let open = source ? 2 : 1;
      const stdout = new OutputBuffer(max, command.keepTail === true);
      const stderr = new OutputBuffer(16 * 1024, true);
      let timedOut = false;
      let error: string | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        source?.kill('SIGKILL');
        child.kill('SIGKILL');
      }, command.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
      child.stdin.on('error', () => undefined);
      if (source) {
        source.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
        source.on('error', sourceError => { error = sourceError.message; child.kill('SIGKILL'); });
        source.on('close', code => { if (code) error ??= `the docker ${command.stdinFrom![0]} that fed it exited with ${code}`; });
        source.stdout.pipe(child.stdin);
      } else {
        child.stdin.end(command.input ?? '');
      }
      child.on('error', spawnError => { error = spawnError.message; });
      let exitCode: number | null = null;
      const closed = () => {
        if (--open > 0) return;
        clearTimeout(timer);
        resolve({ exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut, ...(error ? { error } : {}) });
      };
      source?.on('close', closed);
      child.on('close', code => {
        exitCode = code;
        source?.kill('SIGKILL');
        closed();
      });
    });
  }

  runSync(args: string[], timeoutMs: number): DockerResult {
    const result = spawnSync(this.executable, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? '',
      stderr: (result.stderr ?? '').slice(-16 * 1024),
      timedOut: result.error?.message.includes('ETIMEDOUT') ?? false,
      ...(result.error ? { error: result.error.message } : {})
    };
  }
}

class OutputBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly max: number, private readonly tail: boolean) {}

  add(chunk: Buffer): void {
    if (!this.tail && this.bytes >= this.max) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.tail && this.bytes > this.max * 2) {
      const joined = Buffer.concat(this.chunks);
      this.chunks = [joined.subarray(joined.length - this.max)];
      this.bytes = this.max;
    }
  }

  text(): string {
    const joined = Buffer.concat(this.chunks);
    return (this.tail ? joined.subarray(Math.max(0, joined.length - this.max)) : joined.subarray(0, this.max)).toString('utf8');
  }
}

export interface SignalHooks {
  on(event: 'SIGINT' | 'SIGTERM' | 'exit', listener: (signal: NodeJS.Signals) => void): void;
  off(event: 'SIGINT' | 'SIGTERM' | 'exit', listener: (signal: NodeJS.Signals) => void): void;
  kill(signal: NodeJS.Signals): void;
}

const PROCESS_SIGNALS: SignalHooks = {
  on: (event, listener) => { process.on(event, listener); },
  off: (event, listener) => { process.off(event, listener); },
  kill: signal => { process.kill(process.pid, signal); }
};

export interface DockerBackendRuntimeHarnessOptions {
  docker?: DockerRunner;
  images?: RuntimeImages;
  limits?: Partial<BackendRuntimeLimits>;
  now?: () => number;
  signals?: SignalHooks;
  /** The Docker CLI's configuration folder; DOCKER_CONFIG or ~/.docker by default. */
  dockerConfigDir?: string;
  /** The user the build container runs as, which must own the copied clone; the evaluator's own uid:gid by default. */
  buildUser?: string;
}

class Stop extends Error {
  constructor(readonly outcome: BackendRuntimeOutcome, message: string) {
    super(message);
  }
}

interface RunContext {
  runId: string;
  label: string;
  evidence: BackendRuntimeEvidence;
  deadline: number;
  containers: number;
  /** The signal that stopped the run; no Docker command starts after it. */
  stoppedBy?: NodeJS.Signals;
}

/**
 * Builds the module in a pinned build container from a copy of the clone, builds its image with the repository's
 * Dockerfile, and runs it with the infrastructure it needs on an internal Docker network, where a probe container
 * calls it. Every resource carries the run's label and is removed afterwards, also on SIGINT and SIGTERM.
 */
export class DockerBackendRuntimeHarness implements BackendRuntimeHarness {
  private readonly docker: DockerRunner;
  private readonly limits: BackendRuntimeLimits;
  private readonly now: () => number;
  private readonly signals: SignalHooks;
  private readonly imagesOption?: RuntimeImages;

  constructor(private readonly options: DockerBackendRuntimeHarnessOptions = {}) {
    this.docker = options.docker ?? new CliDockerRunner();
    this.limits = { ...BACKEND_RUNTIME_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.signals = options.signals ?? PROCESS_SIGNALS;
    this.imagesOption = options.images;
  }

  async collect(repositoryPath: string, plan: BackendRuntimePlan): Promise<BackendRuntimeEvidence> {
    const started = this.now();
    const runId = randomBytes(6).toString('hex');
    const evidence: BackendRuntimeEvidence = {
      ...emptyEvidence('not-run'),
      runId,
      startedAt: new Date(started).toISOString(),
      buildTool: plan.buildTool,
      getRequestsCut: plan.getPathsCut
    };
    const context: RunContext = { runId, label: `${RUNTIME_LABEL}=${runId}`, evidence, deadline: Infinity, containers: 0 };
    const cleanup = () => this.cleanup(context);
    const onSignal = (signal: NodeJS.Signals) => {
      context.stoppedBy = signal;
      this.docker.cancel();
      cleanup();
      this.signals.off('SIGINT', onSignal);
      this.signals.off('SIGTERM', onSignal);
      this.signals.off('exit', onExit);
      this.signals.kill(signal);
    };
    const onExit = () => cleanup();

    const docker = await this.dockerInfo(context);
    if (!docker) return this.finish(evidence, started);
    evidence.docker = docker;

    this.signals.on('SIGINT', onSignal);
    this.signals.on('SIGTERM', onSignal);
    this.signals.on('exit', onExit);
    try {
      await this.run(context, repositoryPath, plan);
    } catch (error) {
      if (error instanceof Stop) {
        evidence.outcome = error.outcome;
        evidence.problem = error.message;
      } else {
        evidence.outcome = evidence.module ? 'start-failed' : 'not-run';
        evidence.problem = firstLine(errorMessage(error));
      }
    } finally {
      cleanup();
      this.signals.off('SIGINT', onSignal);
      this.signals.off('SIGTERM', onSignal);
      this.signals.off('exit', onExit);
    }
    return this.finish(evidence, started);
  }

  private finish(evidence: BackendRuntimeEvidence, started: number): BackendRuntimeEvidence {
    evidence.durationMs = this.now() - started;
    return redactEvaluatorSecretsInValue(evidence);
  }

  private async dockerInfo(context: RunContext): Promise<BackendRuntimeEvidence['docker'] | undefined> {
    if (dockerConfigSetsProxies(this.options.dockerConfigDir)) {
      context.evidence.problem = 'the Docker CLI configuration (config.json) sets proxies, which the CLI would pass into every container';
      return undefined;
    }
    const info = await this.exec(context, 'preflight', ['info', '--format', '{{json .}}'], { timeoutMs: 30_000 });
    const parsed = parseJson(info.stdout);
    const serverVersion = isRecord(parsed) && typeof parsed.ServerVersion === 'string' ? parsed.ServerVersion : undefined;
    if (info.exitCode !== 0 || !serverVersion) {
      context.evidence.problem = `the Docker daemon is not reachable: ${firstLine(info.error ?? info.stderr) || 'docker info gave no server version'}`;
      return undefined;
    }
    const securityOptions = isRecord(parsed) && Array.isArray(parsed.SecurityOptions) ? parsed.SecurityOptions.filter((item): item is string => typeof item === 'string') : [];
    const contextName = (await this.exec(context, 'preflight', ['context', 'show'], { timeoutMs: 30_000 })).stdout.trim();
    return {
      serverVersion: serverVersion.slice(0, 100),
      ...(contextName ? { context: contextName.slice(0, 100) } : {}),
      rootless: securityOptions.some(option => option.split(',').includes('name=rootless'))
    };
  }

  private async run(context: RunContext, repositoryPath: string, plan: BackendRuntimePlan): Promise<void> {
    const { evidence, runId } = context;
    const images = this.imagesOption ?? loadRuntimeImages();
    const buildImage = images[plan.buildTool];
    const needed: Array<[string, string]> = [['build', buildImage], ['probe and Okapi stub', images.node], ...plan.infrastructure.map(role => [role, images[role]] as [string, string])];
    evidence.images = needed.map(([role, reference]) => ({ role, reference }));
    for (const [, reference] of needed) {
      await this.must(context, 'pull', ['pull', '--quiet', reference], 'not-run', { timeoutMs: this.limits.pullMs });
    }

    const dbPassword = randomBytes(18).toString('base64url');
    addEvaluatorSecretValues('BACKEND_RUNTIME_DB_PASSWORD', [dbPassword]);
    const harnessEnv = new Map<string, string>([
      ...(plan.infrastructure.includes('postgres')
        ? [['DB_HOST', 'postgres'], ['DB_PORT', '5432'], ['DB_USERNAME', DB_USER], ['DB_PASSWORD', dbPassword], ['DB_DATABASE', DB_NAME]] as Array<[string, string]>
        : []),
      ...(plan.infrastructure.includes('kafka') ? [['KAFKA_HOST', 'kafka'], ['KAFKA_PORT', '9092']] as Array<[string, string]> : []),
      ['OKAPI_URL', OKAPI_STUB_URL]
    ]);
    const moduleEnv = new Map<string, string>();
    for (const entry of plan.env) {
      if (harnessEnv.has(entry.name)) evidence.env.skipped.push({ name: entry.name, reason: 'set by the harness for the infrastructure it started' });
      else {
        moduleEnv.set(entry.name, entry.value);
        evidence.env.template.push(entry.name);
      }
    }
    evidence.env.skipped.push(...plan.skippedEnv);
    evidence.env.harness = [...harnessEnv.keys()];
    for (const [name, value] of harnessEnv) moduleEnv.set(name, value);

    const moduleImage = await this.build(context, repositoryPath, plan, buildImage);

    context.deadline = this.now() + this.limits.runtimeMs;
    const moduleConfig = parseJson((await this.must(context, 'inspect', ['image', 'inspect', moduleImage, '--format', '{{json .Config}}'], 'start-failed')).stdout);
    const port = exposedPort(moduleConfig);
    const network = `tcme-${runId}`;
    await this.must(context, 'network', ['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.inhibit_ipv4=true', '--label', context.label, network], 'start-failed');
    const internal = parseJson((await this.must(context, 'network', ['network', 'inspect', network, '--format', '{{json .Internal}}'], 'start-failed')).stdout);
    evidence.network = { name: network, ...(typeof internal === 'boolean' ? { internal } : {}), egress: [] };
    if (internal !== true) throw new Stop('start-failed', `Docker did not create ${network} as an internal network`);

    await this.must(context, 'okapi-stub', await this.runArgs(context, { name: 'okapi-stub', image: images.node, alias: 'okapi-stub', detach: true,
      user: 'node', readOnly: true, limits: ['--pids-limit', '64', '--cpus', '0.5', '--memory', '128m'], command: ['node', '-e', OKAPI_STUB] }), 'start-failed');
    if (plan.infrastructure.includes('postgres')) {
      await this.must(context, 'postgres', await this.runArgs(context, { name: 'postgres', image: images.postgres, alias: 'postgres', detach: true, user: 'postgres',
        limits: ['--pids-limit', '512', '--cpus', '1', '--memory', '1g'], env: new Map([['POSTGRES_USER', DB_USER], ['POSTGRES_PASSWORD', dbPassword], ['POSTGRES_DB', DB_NAME]]) }), 'start-failed');
    }
    if (plan.infrastructure.includes('kafka')) {
      await this.must(context, 'kafka', await this.runArgs(context, { name: 'kafka', image: images.kafka, alias: 'kafka', detach: true,
        limits: ['--pids-limit', '1024', '--cpus', '1', '--memory', '1g'], env: new Map(Object.entries(KAFKA_ENV)) }), 'start-failed');
    }
    if (plan.infrastructure.includes('postgres')) {
      await this.must(context, 'postgres', await this.runArgs(context, { name: 'postgres-ready', image: images.postgres, user: 'postgres', remove: true, readOnly: true,
        limits: ['--pids-limit', '64', '--cpus', '0.5', '--memory', '128m'],
        command: ['sh', '-c', `for i in $(seq 60); do pg_isready -q -h postgres -U ${DB_USER} && exit 0; sleep 1; done; exit 1`] }), 'start-failed', { timeoutMs: 90_000 });
    }

    const bridge = parseJson((await this.exec(context, 'network', ['network', 'inspect', 'bridge', '--format', '{{json .IPAM.Config}}'])).stdout);
    const hostAddresses = (Array.isArray(bridge) ? bridge.filter(isRecord) : []).flatMap(config =>
      typeof config.Gateway === 'string' && net.isIPv4(config.Gateway) ? [{ host: config.Gateway, port: 2375 }] : []);
    const egress = await this.probe(context, images.node, { phase: 'egress', egressTargets: [...EGRESS_TARGETS, ...hostAddresses], dnsName: EGRESS_DNS_NAME });
    evidence.network.egress = egress?.egress ?? [{ target: 'probe', result: 'the probe gave no result' }];
    const open = evidence.network.egress.filter(entry => !BLOCKED_EGRESS.test(entry.result));
    if (open.length) {
      throw new Stop('start-failed', `the internal network is not isolated: ${open.map(entry => `${entry.target} ${entry.result}`).join(', ')}`);
    }

    const moduleName = `tcme-${runId}-module`;
    await this.must(context, 'module', await this.runArgs(context, { name: 'module', image: moduleImage, alias: 'module', detach: true,
      limits: ['--pids-limit', '512', '--cpus', '2', '--memory', '2g'], env: moduleEnv }), 'start-failed');
    evidence.module = await this.inspectModule(context, moduleName, moduleImage, port);

    const moduleUrl = `http://module:${port}`;
    const healthDeadline = context.deadline - this.limits.laterStepsMs;
    const healthStarted = this.now();
    let attempts = 0;
    let firstAnswer: number | undefined;
    let health: ProbeOutput['health'];
    for (;;) {
      const waitMs = Math.max(0, Math.min(this.limits.healthChunkMs, healthDeadline - this.now()));
      const output = await this.probe(context, images.node, { phase: 'health', moduleUrl, waitMs, pollMs: 2_000 }, waitMs);
      if (!output?.health) break;
      health = output.health;
      attempts += output.health.attempts;
      const state = await this.inspectModule(context, moduleName, moduleImage, port);
      evidence.module = { ...evidence.module, running: state.running, ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}), ...(state.oomKilled ? { oomKilled: true } : {}) };
      if (!state.running) {
        throw new Stop('start-failed', `the module container stopped running (exit code ${state.exitCode ?? 'unknown'}${state.oomKilled ? ', out of memory' : ''})`);
      }
      if (health?.status === 200) break;
      if (health?.status !== undefined) {
        firstAnswer ??= this.now();
        if (this.now() - firstAnswer >= this.limits.healthSettleMs) break;
      }
      if (this.now() >= healthDeadline) break;
    }
    evidence.health = { ...(health ?? { method: 'GET', path: '/admin/health', error: 'the probe gave no result' }), attempts, waitedMs: this.now() - healthStarted };
    evidence.outcome = 'collected';
    if (health?.status === undefined) {
      evidence.problem = `GET /admin/health got no response within ${Math.round((this.now() - healthStarted) / 1000)} s`;
      return;
    }

    const tenants = await this.probe(context, images.node, { phase: 'tenants', moduleUrl, tenants: RUNTIME_TENANTS, moduleId: plan.moduleId });
    evidence.tenants = tenants?.tenants ?? [];
    if (plan.infrastructure.includes('postgres')) evidence.database = await this.database(context, images.postgres, dbPassword);
    const requests = await this.probe(context, images.node, { phase: 'requests', moduleUrl, tenants: RUNTIME_TENANTS, getPaths: plan.getPaths,
      collections: plan.collections, maxCollections: MAX_COLLECTIONS });
    evidence.getRequests = requests?.getRequests ?? [];
    if (requests?.crossTenant) evidence.crossTenant = requests.crossTenant;
  }

  private async build(context: RunContext, repositoryPath: string, plan: BackendRuntimePlan, buildImage: string): Promise<string> {
    const { runId, evidence } = context;
    const buildEnds = this.now() + this.limits.buildMs;
    const remaining = () => Math.max(1, buildEnds - this.now());
    const network = `tcme-${runId}-build`;
    const container = `tcme-${runId}-build`;
    await this.must(context, 'build', ['network', 'create', '--label', context.label, network], 'build-failed');
    const folder = plan.buildDir ? `/workspace/${plan.buildDir}` : '/workspace';
    const submodules = 'cd /workspace && if [ -f .gitmodules ]; then git submodule update --init --recursive; fi';
    const script = plan.buildTool === 'maven'
      ? `set -e; ${submodules}; cd ${folder}; mvn -B -ntp -DskipTests -Dmaven.test.skip=true -Dmaven.repo.local=/tmp/m2 -Duser.home=/tmp/home package`
      : `set -e; ${submodules}; cd ${folder}; if [ -f gradlew ]; then sh gradlew --no-daemon -q assemble; else gradle --no-daemon -q assemble; fi`;
    const user = this.options.buildUser ?? `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    await this.must(context, 'build', await this.runArgs(context, { name: 'build', image: buildImage, create: true, network, user,
      limits: ['--pids-limit', '2048', '--cpus', '2', '--memory', '4g'], env: new Map([['HOME', '/tmp/home'], ['GRADLE_USER_HOME', '/tmp/gradle']]),
      entrypoint: 'sh', command: ['-c', script] }), 'build-failed');
    await this.must(context, 'build', ['cp', `${path.resolve(repositoryPath)}/.`, `${container}:/workspace`], 'build-failed', { timeoutMs: Math.min(remaining(), this.limits.commandMs) });
    const built = await this.exec(context, 'build', ['start', '--attach', container], { timeoutMs: remaining(), keepTail: true, maxOutputBytes: this.limits.buildOutputBytes });
    if (built.exitCode !== 0 || built.timedOut) {
      evidence.buildOutput = redactEvaluatorSecrets(`${built.stdout}\n${built.stderr}`.trim()).slice(-this.limits.buildOutputBytes);
      throw new Stop('build-failed', built.timedOut ? `the build did not finish within ${minutes(this.limits.buildMs)}` : `the build exited with ${built.exitCode}`);
    }
    const image = `tcme-${runId}-module:latest`;
    const imageBuilt = await this.exec(context, 'image', ['build', '--label', context.label, '--rm', '--force-rm', '--memory', '4g', '--memory-swap', '4g',
      '--cpu-period', '100000', '--cpu-quota', '200000', '-t', image, '-f', 'Dockerfile', '-'],
    { timeoutMs: remaining(), stdinFrom: ['cp', `${container}:/workspace/.`, '-'], keepTail: true, maxOutputBytes: this.limits.buildOutputBytes, cliEnv: { DOCKER_BUILDKIT: '0' } });
    if (imageBuilt.exitCode !== 0 || imageBuilt.timedOut || imageBuilt.error) {
      evidence.buildOutput = redactEvaluatorSecrets(`${imageBuilt.stdout}\n${imageBuilt.stderr}`.trim()).slice(-this.limits.buildOutputBytes);
      throw new Stop('build-failed', imageBuilt.timedOut ? `docker build did not finish within ${minutes(this.limits.buildMs)}`
        : `docker build with the repository's Dockerfile failed${imageBuilt.error ? `: ${imageBuilt.error}` : ` with ${imageBuilt.exitCode}`}`);
    }
    await this.exec(context, 'build', ['rm', '--force', '--volumes', container], { timeoutMs: this.limits.commandMs });
    await this.exec(context, 'build', ['network', 'rm', network], { timeoutMs: this.limits.commandMs });
    return image;
  }

  private async runArgs(context: RunContext, spec: {
    name: string; image: string; alias?: string; network?: string; user?: string; detach?: boolean; remove?: boolean; create?: boolean;
    interactive?: boolean; readOnly?: boolean; limits: string[]; env?: Map<string, string>; entrypoint?: string; command?: string[];
  }): Promise<string[]> {
    const volumes = await this.imageVolumes(context, spec.image);
    return [
      spec.create ? 'create' : 'run',
      ...(spec.detach ? ['--detach'] : []),
      ...(spec.remove ? ['--rm'] : []),
      ...(spec.interactive ? ['--interactive'] : []),
      '--name', `tcme-${context.runId}-${spec.name}${spec.remove ? `-${++context.containers}` : ''}`,
      '--label', context.label,
      '--network', spec.network ?? `tcme-${context.runId}`,
      ...(spec.alias ? ['--network-alias', spec.alias] : []),
      ...(spec.user ? ['--user', spec.user] : []),
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      ...spec.limits,
      ...(spec.readOnly ? ['--read-only'] : []),
      ...volumes.flatMap(volume => ['--mount', `type=volume,dst=${volume},volume-label=${context.label}`]),
      ...[...(spec.env ?? new Map<string, string>())].flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      ...(spec.entrypoint ? ['--entrypoint', spec.entrypoint] : []),
      spec.image,
      ...(spec.command ?? [])
    ];
  }

  private async imageVolumes(context: RunContext, image: string): Promise<string[]> {
    const result = await this.exec(context, 'inspect', ['image', 'inspect', image, '--format', '{{json .Config.Volumes}}'], { timeoutMs: this.limits.commandMs });
    const volumes = parseJson(result.stdout);
    return isRecord(volumes) ? Object.keys(volumes).filter(volume => VOLUME_PATH.test(volume)) : [];
  }

  private async inspectModule(context: RunContext, name: string, image: string, port: number): Promise<BackendRuntimeContainer> {
    const inspected = parseJson((await this.exec(context, 'inspect', ['container', 'inspect', name, '--format', '{{json .}}'], { timeoutMs: this.limits.commandMs })).stdout);
    const record = isRecord(inspected) ? inspected : {};
    const host = isRecord(record.HostConfig) ? record.HostConfig : {};
    const state = isRecord(record.State) ? record.State : {};
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 50) : [];
    const ports = isRecord(record.NetworkSettings) && isRecord(record.NetworkSettings.Ports) ? record.NetworkSettings.Ports : {};
    const bindings = isRecord(host.PortBindings) ? host.PortBindings : {};
    const published = [...Object.entries(ports), ...Object.entries(bindings)].filter(([, value]) => Array.isArray(value) && value.length).map(([key]) => key);
    const number = (value: unknown) => typeof value === 'number' ? value : undefined;
    return {
      image,
      port,
      networkMode: typeof host.NetworkMode === 'string' ? host.NetworkMode : 'unknown',
      capDrop: strings(host.CapDrop),
      capAdd: strings(host.CapAdd),
      securityOpt: strings(host.SecurityOpt),
      privileged: host.Privileged === true,
      ...(number(host.PidsLimit) !== undefined ? { pidsLimit: number(host.PidsLimit) } : {}),
      ...(number(host.Memory) !== undefined ? { memoryBytes: number(host.Memory) } : {}),
      ...(number(host.NanoCpus) !== undefined ? { nanoCpus: number(host.NanoCpus) } : {}),
      publishedPorts: [...new Set(published)],
      mounts: (Array.isArray(record.Mounts) ? record.Mounts.filter(isRecord) : []).map(mount => `${mount.Type} ${mount.Destination}`),
      running: state.Running === true,
      ...(number(state.ExitCode) !== undefined ? { exitCode: number(state.ExitCode) } : {}),
      ...(state.OOMKilled === true ? { oomKilled: true } : {})
    };
  }

  private async probe(context: RunContext, nodeImage: string, phase: Omit<ProbeInput, 'moduleUrl' | 'okapiUrl' | 'requestTimeoutMs' | 'bodyChars' | 'maxResponseBytes'> & { moduleUrl?: string },
    waitMs = 0): Promise<ProbeOutput | undefined> {
    const remaining = context.deadline - this.now();
    if (remaining <= 0) return undefined;
    const input: ProbeInput = {
      moduleUrl: 'http://module:8081',
      okapiUrl: OKAPI_STUB_URL,
      requestTimeoutMs: this.limits.requestTimeoutMs,
      bodyChars: this.limits.bodyChars,
      maxResponseBytes: this.limits.maxResponseBytes,
      budgetMs: Math.max(0, remaining - 30_000),
      ...phase
    };
    const result = await this.exec(context, `probe ${phase.phase}`, await this.runArgs(context, { name: 'probe', image: nodeImage, remove: true, interactive: true,
      user: 'node', readOnly: true, limits: ['--pids-limit', '64', '--cpus', '1', '--memory', '256m'], command: ['node', '-'] }),
    { timeoutMs: phase.phase === 'health' ? Math.min(remaining, waitMs + this.limits.requestTimeoutMs * 2 + 30_000) : remaining,
      input: probeProgram(input), maxOutputBytes: this.limits.probeOutputBytes });
    return parseProbeOutput(result.stdout);
  }

  private async database(context: RunContext, postgresImage: string, password: string): Promise<BackendRuntimeEvidence['database']> {
    const result = await this.exec(context, 'probe database', await this.runArgs(context, { name: 'database-probe', image: postgresImage, remove: true, user: 'postgres',
      readOnly: true, limits: ['--pids-limit', '64', '--cpus', '0.5', '--memory', '128m'], env: new Map([['PGPASSWORD', password]]),
      command: ['psql', '-h', 'postgres', '-U', DB_USER, '-d', DB_NAME, '-At', '-c', DATABASE_QUERY] }),
    { timeoutMs: Math.max(1, Math.min(this.limits.commandMs, context.deadline - this.now())), maxOutputBytes: this.limits.probeOutputBytes });
    const parsed = parseJson(result.stdout);
    if (result.exitCode !== 0 || !isRecord(parsed)) return { schemas: [], publicTables: [], problem: `the database probe failed: ${firstLine(result.stderr) || `exit code ${result.exitCode}`}` };
    const schemas = (Array.isArray(parsed.schemas) ? parsed.schemas.filter(isRecord) : [])
      .flatMap(schema => typeof schema.name === 'string' && typeof schema.tables === 'number' ? [{ name: schema.name.slice(0, 200), tables: schema.tables }] : []);
    const publicTables = (Array.isArray(parsed.publicTables) ? parsed.publicTables : []).filter((table): table is string => typeof table === 'string').map(table => table.slice(0, 200));
    return { schemas: schemas.slice(0, MAX_LISTED), publicTables: publicTables.slice(0, MAX_LISTED) };
  }

  private async must(context: RunContext, step: string, args: string[], outcome: BackendRuntimeOutcome, options: Partial<DockerCommand> = {}): Promise<DockerResult> {
    const result = await this.exec(context, step, args, options);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Stop(outcome, `${step}: docker ${args[0]} ${result.timedOut ? 'did not finish in time' : `failed: ${firstLine(result.error ?? result.stderr) || `exit code ${result.exitCode}`}`}`);
    }
    return result;
  }

  private async exec(context: RunContext, step: string, args: string[], options: Partial<DockerCommand> = {}): Promise<DockerResult> {
    if (context.stoppedBy) throw new Stop('not-run', `the evaluation was stopped by ${context.stoppedBy}`);
    const started = this.now();
    const remaining = context.deadline - started;
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? this.limits.commandMs, remaining));
    const result = await this.docker.run({ ...options, args, timeoutMs });
    this.record(context, step, args, result, started, options.stdinFrom);
    return result;
  }

  private record(context: RunContext, step: string, args: string[], result: DockerResult, started: number, stdinFrom?: string[]): void {
    const failed = result.exitCode !== 0 || result.timedOut || result.error !== undefined;
    const action: BackendRuntimeAction = {
      step,
      command: `${stdinFrom ? `docker ${commandText(stdinFrom)} | ` : ''}docker ${commandText(args)}`,
      exitCode: result.exitCode,
      ...(result.timedOut ? { timedOut: true } : {}),
      durationMs: this.now() - started,
      ...(failed && (result.error || result.stderr) ? { problem: firstLine(result.error ?? result.stderr) } : {})
    };
    context.evidence.actions.push(action);
  }

  private cleanup(context: RunContext): void {
    const filter = ['--filter', `label=${context.label}`];
    const run = (args: string[]) => {
      const started = this.now();
      const result = this.docker.runSync(args, this.limits.commandMs);
      this.record(context, 'cleanup', args, result, started);
      if (result.exitCode !== 0 || result.timedOut) context.evidence.cleanup.problems.push(`docker ${commandText(args)}: ${firstLine(result.error ?? result.stderr) || `exit code ${result.exitCode}`}`);
      return result;
    };
    const ids = (args: string[]) => run(args).stdout.split('\n').map(line => line.trim()).filter(Boolean);
    const kinds: Array<[string, string[], string[]]> = [
      ['container', ['ps', '--all', '--quiet', ...filter], ['rm', '--force', '--volumes']],
      ['network', ['network', 'ls', '--quiet', ...filter], ['network', 'rm']],
      ['volume', ['volume', 'ls', '--quiet', ...filter], ['volume', 'rm', '--force']],
      ['image', ['image', 'ls', '--quiet', ...filter], ['image', 'rm', '--force']]
    ];
    for (let pass = 0; pass < CLEANUP_PASSES; pass++) {
      if (pass) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.limits.cleanupRetryMs);
      for (const [, list, remove] of kinds) {
        const found = ids(list);
        if (found.length) run([...remove, ...new Set(found)]);
      }
      context.evidence.cleanup.remaining = kinds.flatMap(([kind, list]) => ids(list).map(id => `${kind} ${id}`));
      if (!context.evidence.cleanup.remaining.length) break;
    }
    context.evidence.cleanup.problems = [...new Set(context.evidence.cleanup.problems)];
  }
}

/** The probe's JSON line, or undefined when it printed none or an error. */
export function parseProbeOutput(stdout: string): ProbeOutput | undefined {
  const parsed = parseJson(stdout);
  if (!isRecord(parsed) || 'error' in parsed) return undefined;
  const text = (value: unknown, max = BACKEND_RUNTIME_LIMITS.bodyChars) => typeof value === 'string' ? value.slice(0, max) : undefined;
  const request = (value: unknown) => {
    if (!isRecord(value) || typeof value.method !== 'string' || typeof value.path !== 'string') return [];
    const status = typeof value.status === 'number' && Number.isInteger(value.status) ? value.status : undefined;
    const recordCount = typeof value.recordCount === 'number' && Number.isFinite(value.recordCount) ? value.recordCount : undefined;
    return [{
      method: value.method.slice(0, 10),
      path: value.path.slice(0, 300),
      ...(text(value.tenant, 40) ? { tenant: text(value.tenant, 40) } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(text(value.body) !== undefined ? { body: text(value.body) } : {}),
      ...(recordCount !== undefined ? { recordCount } : {}),
      ...(text(value.error, 300) ? { error: text(value.error, 300) } : {})
    }];
  };
  const list = (value: unknown, max: number) => (Array.isArray(value) ? value.slice(0, max) : []).flatMap(request);
  const output: ProbeOutput = {};
  if (Array.isArray(parsed.egress)) {
    output.egress = parsed.egress.slice(0, 10).filter(isRecord).map(entry => ({ target: text(entry.target, 100) ?? '', result: text(entry.result, 200) ?? '' }));
  }
  if (isRecord(parsed.health)) {
    const [health] = request(parsed.health);
    if (health) output.health = { ...health, attempts: typeof parsed.health.attempts === 'number' ? parsed.health.attempts : 0 };
  }
  if (Array.isArray(parsed.tenants)) {
    output.tenants = parsed.tenants.slice(0, RUNTIME_TENANTS.length).flatMap(tenant => request(tenant).map(entry =>
      ({ ...entry, ...(isRecord(tenant) && typeof tenant.complete === 'boolean' ? { complete: tenant.complete } : {}) })));
  }
  if (Array.isArray(parsed.getRequests)) output.getRequests = list(parsed.getRequests, MAX_GET_PATHS * RUNTIME_TENANTS.length);
  if (isRecord(parsed.crossTenant)) {
    const cross = parsed.crossTenant;
    const flag = (value: unknown) => typeof value === 'boolean' ? value : undefined;
    output.crossTenant = {
      ...(text(cross.path, 300) ? { path: text(cross.path, 300) } : {}),
      ...(text(cross.recordId, 100) ? { recordId: text(cross.recordId, 100) } : {}),
      ...(flag(cross.visibleInOwnTenant) !== undefined ? { visibleInOwnTenant: flag(cross.visibleInOwnTenant) } : {}),
      ...(flag(cross.visibleInOtherTenant) !== undefined ? { visibleInOtherTenant: flag(cross.visibleInOtherTenant) } : {}),
      ...(text(cross.problem, 300) ? { problem: text(cross.problem, 300) } : {}),
      requests: list(cross.requests, 50)
    };
  }
  return output;
}

function dockerConfigSetsProxies(directory = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker')): boolean {
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
  } catch {
    return false;
  }
  return isRecord(config) && isRecord(config.proxies) && Object.keys(config.proxies).length > 0;
}

function exposedPort(config: unknown): number {
  const ports = isRecord(config) && isRecord(config.ExposedPorts) ? Object.keys(config.ExposedPorts) : [];
  const tcp = ports.flatMap(port => {
    const value = Number(EXPOSED_TCP_PORT.exec(port)?.[1]);
    return value > 0 && value < 65536 ? [value] : [];
  });
  return tcp.includes(DEFAULT_PORT) || tcp.length !== 1 ? DEFAULT_PORT : tcp[0];
}

function commandText(args: string[]): string {
  return args.map((arg, index) => {
    const masked = args[index - 1] === '--env' ? `${arg.slice(0, arg.indexOf('='))}=…` : arg;
    return /^[\w@%+=:,./…-]+$/.test(masked) ? masked : `'${masked.replace(/'/g, `'\\''`).slice(0, 300)}'`;
  }).join(' ');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 300) ?? '';
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} minutes`;
}
