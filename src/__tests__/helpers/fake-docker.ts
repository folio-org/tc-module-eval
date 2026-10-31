import { EventEmitter } from 'events';
import { DockerCommand, DockerResult, DockerRunner, RuntimeImages, SignalHooks } from '../../utils/backend-runtime-harness';
import type { ProbeInput, ProbeOutput } from '../../utils/backend-runtime-probe';

export const IMAGES: RuntimeImages = {
  maven: `maven:3.9@sha256:${'1'.repeat(64)}`,
  gradle: `gradle:8@sha256:${'2'.repeat(64)}`,
  postgres: `postgres:16@sha256:${'3'.repeat(64)}`,
  kafka: `apache/kafka:4@sha256:${'4'.repeat(64)}`,
  node: `node:22@sha256:${'5'.repeat(64)}`
};

const ok = (stdout = ''): DockerResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

export function probeInput(command: DockerCommand): ProbeInput {
  const json = /\}\)\((\{.*\})\)\.then\(output/s.exec(command.input ?? '')?.[1];
  return JSON.parse(json!) as ProbeInput;
}

/**
 * A Docker CLI double: answers like a daemon on which every step succeeds, unless `answer` returns something else
 * for a command, and records every command. Its clock advances only by the time a health probe waits.
 */
export class FakeDocker implements DockerRunner {
  readonly calls: DockerCommand[] = [];
  readonly syncCalls: string[][] = [];
  cancelled = 0;
  clock = 1_000_000;
  health: (input: ProbeInput) => NonNullable<ProbeOutput['health']> = () => ({ method: 'GET', path: '/admin/health', status: 200, body: '{"status":"UP"}', attempts: 1 });
  probe: (input: ProbeInput) => ProbeOutput = input => this.defaultProbe(input);
  private listed = new Set<string>();

  constructor(private readonly answer: (command: DockerCommand) => DockerResult | undefined = () => undefined) {}

  async run(command: DockerCommand): Promise<DockerResult> {
    this.calls.push(command);
    const answered = this.answer(command);
    if (answered) return answered;
    const [first, second] = command.args;
    if (first === 'info') return ok(JSON.stringify({ ServerVersion: '29.9.2', SecurityOptions: ['name=seccomp,profile=builtin'] }));
    if (first === 'context') return ok('default\n');
    if (first === 'image' && second === 'inspect') {
      const format = command.args[command.args.length - 1];
      if (format === '{{json .Config}}') return ok(JSON.stringify({ ExposedPorts: { '8081/tcp': {} } }));
      if (command.args[2] === IMAGES.postgres) return ok(JSON.stringify({ '/var/lib/postgresql/data': {} }));
      if (command.args[2].startsWith('tcme-')) return ok(JSON.stringify({ '/data': {}, '/bad,path': {} }));
      return ok('null');
    }
    if (first === 'network' && second === 'inspect') return ok(command.args[2] === 'bridge' ? JSON.stringify([{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }]) : 'true');
    if (first === 'container' && second === 'inspect') {
      return ok(JSON.stringify({ HostConfig: { NetworkMode: 'tcme-net', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Privileged: false, PidsLimit: 512, Memory: 2147483648, NanoCpus: 2000000000 }, State: { Running: true, ExitCode: 0 }, Mounts: [] }));
    }
    if (first === 'run' && command.args.includes('psql')) return ok(JSON.stringify({ schemas: [{ name: 'tcevala_mod_example', tables: 3 }, { name: 'public', tables: 0 }], publicTables: [] }));
    if (first === 'run' && command.input) {
      const input = probeInput(command);
      const output = this.probe(input);
      if (input.phase === 'health' && output.health?.status !== 200) this.clock += input.waitMs ?? 0;
      return ok(JSON.stringify(output));
    }
    return ok();
  }

  cancel(): void {
    this.cancelled++;
  }

  runSync(args: string[]): DockerResult {
    this.syncCalls.push(args);
    const list = args.includes('--quiet') && !args.includes('prune');
    if (!list) return ok();
    const kind = args[0];
    if (this.listed.has(kind)) return ok('');
    this.listed.add(kind);
    return ok(`${kind}-id\n`);
  }

  now = () => this.clock;

  runs(): string[][] {
    return this.calls.map(call => call.args).filter(args => args[0] === 'run' || args[0] === 'create');
  }

  private defaultProbe(input: ProbeInput): ProbeOutput {
    if (input.phase === 'egress') {
      return { egress: [...(input.egressTargets ?? []).map(target => ({ target: `${target.host}:${target.port}`, result: 'failed (ENETUNREACH)' })),
        { target: `DNS ${input.dnsName}`, result: 'failed (EAI_AGAIN)' }] };
    }
    if (input.phase === 'health') return { health: this.health(input) };
    if (input.phase === 'tenants') return { tenants: (input.tenants ?? []).map(tenant => ({ method: 'POST', path: '/_/tenant', tenant, status: 204, complete: true })) };
    return {
      getRequests: (input.getPaths ?? []).flatMap(path => (input.tenants ?? []).map(tenant => ({ method: 'GET', path, tenant, status: path.endsWith('missing') ? 404 : 200 })))
    };
  }
}

export class FakeSignals extends EventEmitter implements SignalHooks {
  readonly killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): void {
    if (this.listenerCount(signal)) this.emit(signal, signal);
    else this.killed.push(signal);
  }
}
