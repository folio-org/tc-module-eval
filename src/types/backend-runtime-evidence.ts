/**
 * How far the backend runtime harness got:
 * - `not-configured`: --allow-runtime-checks was not given;
 * - `not-run`: the repository or Docker gave nothing to run;
 * - `build-failed`: the build container or `docker build` failed;
 * - `start-failed`: the module container could not be started or stopped running;
 * - `collected`: the module ran through the health check and the later steps.
 */
export type BackendRuntimeOutcome = 'not-configured' | 'not-run' | 'build-failed' | 'start-failed' | 'collected';

/** One Docker command the harness ran, with environment values masked. */
export interface BackendRuntimeAction {
  step: string;
  command: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs: number;
  problem?: string;
}

/** One HTTP request the probe container sent to the module. */
export interface BackendRuntimeRequest {
  method: string;
  path: string;
  tenant?: string;
  status?: number;
  /** The start of the response body, for the health check and failed tenant initializations. */
  body?: string;
  /** The records in a JSON collection response: `totalRecords`, or else the length of its first array of objects. */
  recordCount?: number;
  error?: string;
}

/** What Docker reports about the module container, read with `docker inspect` after it started. */
export interface BackendRuntimeContainer {
  image: string;
  port: number;
  networkMode: string;
  capDrop: string[];
  capAdd: string[];
  securityOpt: string[];
  privileged: boolean;
  pidsLimit?: number;
  memoryBytes?: number;
  nanoCpus?: number;
  publishedPorts: string[];
  mounts: string[];
  /** The state after the last health check. */
  running?: boolean;
  exitCode?: number;
  oomKilled?: boolean;
}

export interface BackendRuntimeEvidence {
  outcome: BackendRuntimeOutcome;
  problem?: string;
  /** The value of every resource's `tc-module-eval.run` label. */
  runId?: string;
  startedAt?: string;
  durationMs?: number;
  docker?: { serverVersion?: string; context?: string; rootless: boolean };
  /** Every image the harness ran, by role, as pinned in config/backend-runtime-images.json. */
  images: Array<{ role: string; reference: string }>;
  buildTool?: 'maven' | 'gradle';
  /** The end of the build container's output, when the build failed. */
  buildOutput?: string;
  /** The variable names passed to the module: from the template's env lists, and the infrastructure the harness started. */
  env: { template: string[]; harness: string[]; skipped: Array<{ name: string; reason: string }> };
  network?: {
    name: string;
    /** As `docker network inspect` reports it. */
    internal?: boolean;
    /** Connections the probe container tried from the module's network to the internet. */
    egress: Array<{ target: string; result: string }>;
  };
  module?: BackendRuntimeContainer;
  health?: BackendRuntimeRequest & { attempts: number; waitedMs: number };
  tenants: Array<BackendRuntimeRequest & { complete?: boolean }>;
  /** GET requests to provided paths without parameters, in each tenant (B003 statuses, B008 record counts). */
  getRequests: BackendRuntimeRequest[];
  getRequestsCut: number;
  /** Schemas and their table counts, and the tables in `public`, after tenant initialization (B010). */
  database?: { schemas: Array<{ name: string; tables: number }>; publicTables: string[]; problem?: string };
  /** A record created in the first tenant, and whether the second tenant sees it (B013). */
  crossTenant?: {
    path?: string;
    recordId?: string;
    visibleInOwnTenant?: boolean;
    visibleInOtherTenant?: boolean;
    problem?: string;
    requests: BackendRuntimeRequest[];
  };
  actions: BackendRuntimeAction[];
  /** Labelled resources still present after cleanup, and cleanup commands that failed. */
  cleanup: { remaining: string[]; problems: string[] };
}

/** The repository data the harness runs from, derived from backendEvidence only. */
export interface BackendRuntimePlan {
  moduleId: string;
  buildTool: 'maven' | 'gradle';
  /** The folder of the build, relative to the repository: `` or `service`. */
  buildDir: string;
  /** PostgreSQL with storage evidence or a `DB_HOST` variable in the template; Kafka with a `KAFKA_HOST` variable. */
  infrastructure: Array<'postgres' | 'kafka'>;
  env: Array<{ name: string; value: string; source: string }>;
  skippedEnv: Array<{ name: string; reason: string }>;
  getPaths: string[];
  getPathsCut: number;
  /** Paths with both GET and POST and no parameters, with their `{id}` item path when the descriptor has one. */
  collections: Array<{ path: string; itemPath?: string }>;
}

export interface BackendRuntimeHarness {
  collect(repositoryPath: string, plan: BackendRuntimePlan): Promise<BackendRuntimeEvidence>;
}
