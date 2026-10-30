import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { ModuleEvaluator } from '../module-evaluator';
import { B003Analysis, BackendRuntimeEvidence, BackendRuntimeHarness, BackendRuntimePlan } from '../types';
import { getBackendEvidence } from '../utils/backend-evidence';
import {
  backendRuntimePlan,
  DockerBackendRuntimeHarness,
  getBackendRuntimeEvidence,
  loadRuntimeImages,
  parseProbeOutput,
  RUNTIME_IMAGES_PATH
} from '../utils/backend-runtime-harness';
import { createEvaluationRun } from '../utils/evaluation-run';
import { pom, repository } from './helpers/backend-repository';
import { FakeDocker, FakeSignals, IMAGES, probeInput } from './helpers/fake-docker';
import { expectLinearTime } from './helpers/linear-time';

function template(extra: object = {}): string {
  return JSON.stringify({
    id: '${artifactId}-1.0.0',
    provides: [
      {
        id: 'example', version: '1.0', handlers: [
          { methods: ['GET', 'POST'], pathPattern: '/examples' },
          { methods: ['GET', 'PUT'], pathPattern: '/examples/{id}' },
          { methods: ['GET'], pathPattern: '/example-missing' },
          { methods: ['GET'], pathPattern: '/wild*' }
        ]
      },
      { id: '_tenant', version: '2.0', interfaceType: 'system', handlers: [{ methods: ['POST'], pathPattern: '/_/tenant' }, { methods: ['GET'], pathPattern: '/_/tenant/status' }] }
    ],
    env: [{ name: 'TOP_LEVEL', value: 'from env' }, { name: 'SHARED', value: 'top-level value' }],
    launchDescriptor: {
      dockerImage: 'evil/image:latest',
      dockerPull: true,
      dockerCMD: ['sh', '-c', 'cat /host/secret'],
      dockerArgs: { HostConfig: { Privileged: true, Binds: ['/:/host'], NetworkMode: 'host', PortBindings: { '8081/tcp': [{ HostPort: '%p' }] } } },
      env: [
        { name: 'JAVA_OPTIONS', value: '-XX:MaxRAMPercentage=66.0' },
        { name: 'SHARED', value: 'launch value' },
        { name: 'DB_HOST', value: 'shared-db.example.org' },
        { name: 'KAFKA_HOST', value: 'localhost' },
        { name: 'bad name', value: 'x' },
        { name: 'NO_VALUE' },
        { name: 'PLACEHOLDER', value: '${undefined.property}' }
      ]
    },
    ...extra
  });
}

function moduleRepository(files: Record<string, string> = {}): string {
  return repository({
    'pom.xml': pom('mod-example'),
    Dockerfile: 'FROM base\nCOPY target/*.jar /app.jar\n',
    'descriptors/ModuleDescriptor-template.json': template(),
    'src/main/java/org/example/Application.java': '@SpringBootApplication\npublic class Application {}\n',
    ...files
  });
}

async function plan(root: string): Promise<BackendRuntimePlan> {
  const result = backendRuntimePlan(await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root));
  if (typeof result === 'string') throw new Error(result);
  return result;
}

async function collect(docker = new FakeDocker(), signals = new FakeSignals(), root = moduleRepository()) {
  const harness = new DockerBackendRuntimeHarness({ docker, images: IMAGES, now: docker.now, signals, buildUser: '1000:1000', dockerConfigDir: os.tmpdir() });
  const evidence = await harness.collect(root, await plan(root));
  return { evidence, docker, signals, root };
}

const option = (args: string[], name: string) => args.flatMap((arg, index) => arg === name ? [args[index + 1]] : []);
const containerName = (args: string[]) => option(args, '--name')[0];
const imageOf = (args: string[]) => {
  const flagsWithValues = new Set(['--name', '--label', '--network', '--network-alias', '--user', '--cap-drop', '--security-opt', '--pids-limit',
    '--cpus', '--memory', '--mount', '--env', '--entrypoint']);
  for (let index = 1; index < args.length; index++) {
    if (flagsWithValues.has(args[index])) index++;
    else if (!args[index].startsWith('--')) return args[index];
  }
  return undefined;
};

describe('backend runtime harness plan', () => {
  it('takes env name/value pairs from both template lists, never the template\'s Docker settings, and GET paths without parameters', async () => {
    expect(await plan(moduleRepository())).toEqual({
      moduleId: 'mod-example-1.0.0',
      buildTool: 'maven',
      buildDir: '',
      infrastructure: ['postgres', 'kafka'],
      env: [
        { name: 'TOP_LEVEL', value: 'from env', source: 'env' },
        { name: 'SHARED', value: 'launch value', source: 'launchDescriptor/env' },
        { name: 'JAVA_OPTIONS', value: '-XX:MaxRAMPercentage=66.0', source: 'launchDescriptor/env' },
        { name: 'DB_HOST', value: 'shared-db.example.org', source: 'launchDescriptor/env' },
        { name: 'KAFKA_HOST', value: 'localhost', source: 'launchDescriptor/env' }
      ],
      skippedEnv: [
        { name: 'bad name', reason: 'not a variable name' },
        { name: 'NO_VALUE', reason: 'no value' },
        { name: 'PLACEHOLDER', reason: 'its value has a build placeholder the build properties do not define' }
      ],
      getPaths: ['/examples', '/example-missing'],
      getPathsCut: 0,
      collections: [{ path: '/examples', itemPath: '/examples/{id}' }]
    });
  });

  it('keeps env names such as constructor, caps skipped rows, and leaves out GET paths that could name another host', async () => {
    const env = [{ name: 'constructor', value: 'a' }, { name: '__proto__', value: 'b' }, ...Array.from({ length: 205 }, (_, index) => ({ name: `V${index}`, value: 'x' }))];
    const root = moduleRepository({ 'descriptors/ModuleDescriptor-template.json': JSON.stringify({
      id: 'mod-example-1.0.0',
      provides: [{ id: 'x', version: '1.0', handlers: [
        { methods: ['GET'], pathPattern: '//postgres:5432/x' },
        { methods: ['GET'], pathPattern: '/\\kafka:9092/' },
        { methods: ['GET'], pathPattern: `/${'a'.repeat(300)}` },
        { methods: ['GET'], pathPattern: `/${'b'.repeat(299)}` }
      ] }],
      env
    }) });
    const result = await plan(root);
    expect(result.env.slice(0, 2)).toEqual([{ name: 'constructor', value: 'a', source: 'env' }, { name: '__proto__', value: 'b', source: 'env' }]);
    expect(result.env).toHaveLength(200);
    expect(result.skippedEnv).toEqual([{ name: '7 more', reason: 'over the limit of 200 variables' }]);
    expect(result.getPaths).toEqual([`/${'b'.repeat(299)}`]);
    const docker = new FakeDocker();
    const harness = new DockerBackendRuntimeHarness({ docker, images: IMAGES, now: docker.now, signals: new FakeSignals(), dockerConfigDir: os.tmpdir() });
    const evidence = await harness.collect(root, result);
    expect(evidence.env.template.slice(0, 2)).toEqual(['constructor', '__proto__']);
    expect(option(docker.runs().find(args => containerName(args)?.endsWith('-module'))!, '--env').slice(0, 2)).toEqual(['constructor=a', '__proto__=b']);
  });

  it('does not run a library, a repository without a Dockerfile or one without a Maven or Gradle build', async () => {
    const evidenceFor = async (root: string) => backendRuntimePlan(await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root));
    expect(await evidenceFor(repository({ 'pom.xml': pom('folio-spring-base'), Dockerfile: 'FROM x\n' }))).toBe('the repository is not a backend or edge module');
    const noDockerfile = repository({ 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': template() });
    expect(await evidenceFor(noDockerfile)).toBe('the repository has no Dockerfile at its root');
    const noBuild = repository({ Dockerfile: 'FROM x\n', 'descriptors/ModuleDescriptor-template.json': template() });
    expect(await evidenceFor(noBuild)).toBe('the repository has no Maven or Gradle build at its root or in service/');
    const grails = repository({ Dockerfile: 'FROM x\n', 'service/build.gradle': 'apply plugin: "grails"\n', 'service/grails-app/conf/application.yml': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': template() });
    expect(await evidenceFor(grails)).toEqual(expect.objectContaining({ buildTool: 'gradle', buildDir: 'service' }));
  });

  it('reads only the committed image pins that name a digest', () => {
    expect(Object.values(loadRuntimeImages())).toEqual(Object.values(loadRuntimeImages()).filter(reference => /@sha256:[0-9a-f]{64}$/.test(reference)));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-images-'));
    const file = path.join(directory, 'images.json');
    const pins = JSON.parse(fs.readFileSync(RUNTIME_IMAGES_PATH, 'utf8')) as Record<string, string>;
    fs.writeFileSync(file, JSON.stringify({ ...pins, postgres: 'postgres:16' }));
    expect(() => loadRuntimeImages(file)).toThrow(`${file}: the postgres image must be pinned by digest (name@sha256:...)`);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe('backend runtime harness isolation rules', () => {
  it('builds in the pinned build container from a copy of the clone, without host mounts or host environment, on its own network', async () => {
    const { evidence, docker, root } = await collect();
    const buildNetwork = `tcme-${evidence.runId}-build`;
    const create = docker.runs().find(args => args[0] === 'create')!;

    expect(docker.calls.map(call => call.args).filter(args => args[0] === 'network' && args[1] === 'create')).toEqual([
      ['network', 'create', '--label', `tc-module-eval.run=${evidence.runId}`, buildNetwork],
      ['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.inhibit_ipv4=true', '--label', `tc-module-eval.run=${evidence.runId}`, `tcme-${evidence.runId}`]
    ]);
    expect(imageOf(create)).toBe(IMAGES.maven);
    expect(option(create, '--network')).toEqual([buildNetwork]);
    expect(option(create, '--user')).toEqual(['1000:1000']);
    expect(option(create, '--env')).toEqual(['HOME=/tmp/home', 'GRADLE_USER_HOME=/tmp/gradle']);
    expect(option(create, '--mount')).toEqual([]);
    expect(docker.calls.find(call => call.args[0] === 'cp')!.args).toEqual(['cp', `${root}/.`, `tcme-${evidence.runId}-build:/workspace`]);
    for (const args of docker.calls.map(call => call.args)) {
      expect(args).not.toContain('--volume');
      expect(args).not.toContain('-v');
      expect(args).not.toContain('--env-file');
      expect(args).not.toContain('--follow-link');
      expect(args).not.toContain('-L');
      expect(option(args, '--mount').filter(mount => !mount.startsWith('type=volume,'))).toEqual([]);
      expect(option(args, '--env').filter(env => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(env))).toEqual([]);
    }
  });

  it('builds the image with docker build from the repository\'s Dockerfile, fed from the build container', async () => {
    const { evidence, docker } = await collect();
    const build = docker.calls.find(call => call.args[0] === 'build')!;
    expect(build.args).toEqual(['build', '--label', `tc-module-eval.run=${evidence.runId}`, '--rm', '--force-rm', '--memory', '4g', '--memory-swap', '4g',
      '--cpu-period', '100000', '--cpu-quota', '200000', '-t', `tcme-${evidence.runId}-module:latest`, '-f', 'Dockerfile', '-']);
    expect(build.stdinFrom).toEqual(['cp', `tcme-${evidence.runId}-build:/workspace/.`, '-']);
    expect(build.cliEnv).toEqual({ DOCKER_BUILDKIT: '0' });
  });

  it('runs the stub, infrastructure, module and probes only on an internal network, without published ports, and reads only probe output', async () => {
    const { evidence, docker } = await collect();
    const network = `tcme-${evidence.runId}`;
    const runtimeRuns = docker.runs().filter(args => args[0] === 'run');
    expect(runtimeRuns.map(containerName).map(name => name.replace(evidence.runId!, 'ID'))).toEqual([
      'tcme-ID-okapi-stub', 'tcme-ID-postgres', 'tcme-ID-kafka', 'tcme-ID-postgres-ready-1', 'tcme-ID-probe-2', 'tcme-ID-module',
      'tcme-ID-probe-3', 'tcme-ID-probe-4', 'tcme-ID-database-probe-5', 'tcme-ID-probe-6'
    ]);
    for (const args of runtimeRuns) {
      expect(option(args, '--network')).toEqual([network]);
      for (const flag of ['-p', '--publish', '-P', '--publish-all', '--privileged', '--cap-add', '--pid', '--ipc', '--uts', '--userns', '--device']) expect(args).not.toContain(flag);
    }
    const subcommands = new Set(docker.calls.map(call => call.args[0] === 'image' || call.args[0] === 'network' || call.args[0] === 'container' || call.args[0] === 'context'
      ? `${call.args[0]} ${call.args[1]}` : call.args[0]));
    expect([...subcommands].sort()).toEqual(['build', 'container inspect', 'context show', 'cp', 'create', 'image inspect', 'info', 'network create', 'network inspect',
      'network rm', 'pull', 'rm', 'run', 'start'].sort());
    expect(docker.calls.filter(call => call.args[0] === 'cp').map(call => call.args[2])).toEqual([`tcme-${evidence.runId}-build:/workspace`]);
    expect(evidence.network).toEqual({ name: network, internal: true, egress: [
      { target: '1.1.1.1:443', result: 'failed (ENETUNREACH)' },
      { target: '8.8.8.8:53', result: 'failed (ENETUNREACH)' },
      { target: '169.254.169.254:80', result: 'failed (ENETUNREACH)' },
      { target: '172.17.0.1:2375', result: 'failed (ENETUNREACH)' },
      { target: 'DNS github.com', result: 'failed (EAI_AGAIN)' }
    ] });
  });

  it.each([
    ['the host', '172.17.0.1:2375', 'failed (ECONNREFUSED)'],
    ['the internet', '1.1.1.1:443', 'connected'],
    ['DNS', 'DNS github.com', 'resolved to 140.82.112.3']
  ])('stops before starting the module when the probe reaches %s from the internal network', async (_name, target, result) => {
    const docker = new FakeDocker();
    const blocked = docker.probe;
    docker.probe = input => input.phase === 'egress'
      ? { egress: blocked(input).egress!.map(entry => entry.target === target ? { target, result } : entry) }
      : blocked(input);
    const { evidence } = await collect(docker);
    expect(evidence.outcome).toBe('start-failed');
    expect(evidence.problem).toBe(`the internal network is not isolated: ${target} ${result}`);
    expect(docker.runs().filter(args => containerName(args)?.endsWith('-module'))).toEqual([]);
  });

  it('starts no container on a network Docker does not report as internal', async () => {
    const docker = new FakeDocker(command => command.args[0] === 'network' && command.args[1] === 'inspect'
      ? { exitCode: 0, stdout: 'false', stderr: '', timedOut: false } : undefined);
    const { evidence } = await collect(docker);
    expect(evidence.outcome).toBe('start-failed');
    expect(evidence.problem).toBe(`Docker did not create tcme-${evidence.runId} as an internal network`);
    expect(docker.runs().filter(args => args[0] === 'run')).toEqual([]);
  });

  it('runs only images pinned by digest and the image it built', async () => {
    const { evidence, docker } = await collect();
    const pinned = new Set([...Object.values(IMAGES), `tcme-${evidence.runId}-module:latest`]);
    expect(docker.runs().map(imageOf).filter(image => !pinned.has(image!))).toEqual([]);
    expect(docker.calls.filter(call => call.args[0] === 'pull').map(call => call.args[2])).toEqual([IMAGES.maven, IMAGES.node, IMAGES.postgres, IMAGES.kafka]);
    expect(evidence.images).toEqual([
      { role: 'build', reference: IMAGES.maven },
      { role: 'probe and Okapi stub', reference: IMAGES.node },
      { role: 'postgres', reference: IMAGES.postgres },
      { role: 'kafka', reference: IMAGES.kafka }
    ]);
  });

  it('passes the module only the template\'s env pairs and the infrastructure hosts, never the template\'s Docker settings', async () => {
    const { evidence, docker } = await collect();
    const module = docker.runs().find(args => containerName(args) === `tcme-${evidence.runId}-module`)!;
    const env = option(module, '--env');
    expect(env.filter(entry => !entry.startsWith('DB_PASSWORD='))).toEqual([
      'TOP_LEVEL=from env', 'SHARED=launch value', 'JAVA_OPTIONS=-XX:MaxRAMPercentage=66.0',
      'DB_HOST=postgres', 'DB_PORT=5432', 'DB_USERNAME=folio_admin', 'DB_DATABASE=okapi_modules', 'KAFKA_HOST=kafka', 'KAFKA_PORT=9092',
      'OKAPI_URL=http://okapi-stub:9130'
    ]);
    expect(env.filter(entry => entry.startsWith('DB_PASSWORD='))).toHaveLength(1);
    const everything = JSON.stringify(docker.calls);
    for (const fromTemplate of ['evil/image', 'cat /host/secret', 'Privileged', '/:/host', '"host"', 'HostPort', 'shared-db.example.org']) expect(everything).not.toContain(fromTemplate);
    expect(evidence.env).toEqual({
      template: ['TOP_LEVEL', 'SHARED', 'JAVA_OPTIONS'],
      harness: ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE', 'KAFKA_HOST', 'KAFKA_PORT', 'OKAPI_URL'],
      skipped: [
        { name: 'DB_HOST', reason: 'set by the harness for the infrastructure it started' },
        { name: 'KAFKA_HOST', reason: 'set by the harness for the infrastructure it started' },
        { name: 'bad name', reason: 'not a variable name' },
        { name: 'NO_VALUE', reason: 'no value' },
        { name: 'PLACEHOLDER', reason: 'its value has a build placeholder the build properties do not define' }
      ]
    });
    expect(evidence.actions.find(action => action.command.includes(' --name tcme-') && action.command.includes('-module '))!.command)
      .toContain('--env TOP_LEVEL=… --env SHARED=… --env JAVA_OPTIONS=… --env DB_HOST=…');
  });

  it('drops all capabilities and limits every container, with the module at 512 processes, 2 CPUs and 2 GB', async () => {
    const { evidence, docker } = await collect();
    const module = docker.runs().find(args => containerName(args) === `tcme-${evidence.runId}-module`)!;
    const index = module.indexOf('--cap-drop');
    expect(module.slice(index, index + 10)).toEqual(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--cpus', '2', '--memory', '2g']);
    for (const args of docker.runs()) {
      expect(option(args, '--cap-drop')).toEqual(['ALL']);
      expect(option(args, '--security-opt')).toEqual(['no-new-privileges']);
      expect(option(args, '--pids-limit')).toHaveLength(1);
      expect(option(args, '--memory')).toHaveLength(1);
      expect(option(args, '--cpus')).toHaveLength(1);
    }
    expect(evidence.module).toEqual(expect.objectContaining({ capDrop: ['ALL'], privileged: false, pidsLimit: 512, memoryBytes: 2147483648, nanoCpus: 2000000000, publishedPorts: [], mounts: [] }));
  });

  it('gives the build 15 minutes and start-up and probes 10 minutes', async () => {
    const docker = new FakeDocker();
    docker.health = () => ({ method: 'GET', path: '/admin/health', error: 'connect ECONNREFUSED', attempts: 10 });
    const { evidence } = await collect(docker);
    expect(docker.calls.find(call => call.args[0] === 'start')!.timeoutMs).toBe(15 * 60_000);
    expect(evidence.outcome).toBe('collected');
    expect(evidence.health).toEqual({ method: 'GET', path: '/admin/health', error: 'connect ECONNREFUSED', attempts: 210, waitedMs: 7 * 60_000 });
    expect(evidence.problem).toBe('GET /admin/health got no response within 420 s');
    expect(evidence.tenants).toEqual([]);
    const moduleStarted = docker.calls.findIndex(call => call.args.includes(`tcme-${evidence.runId}-module`));
    const runtimeStart = 1_000_000;
    let clock = runtimeStart;
    for (const call of docker.calls.slice(moduleStarted)) {
      expect(call.timeoutMs).toBeLessThanOrEqual(runtimeStart + 10 * 60_000 - clock);
      if (call.input && probeInput(call).phase === 'health') clock += probeInput(call).waitMs ?? 0;
    }
  });

  it('stops the build at its time limit and keeps the end of its output', async () => {
    const docker = new FakeDocker(command => command.args[0] === 'start'
      ? { exitCode: null, stdout: 'line\n'.repeat(5000) + 'last line', stderr: '', timedOut: true } : undefined);
    const { evidence } = await collect(docker);
    expect(evidence.outcome).toBe('build-failed');
    expect(evidence.problem).toBe('the build did not finish within 15 minutes');
    expect(evidence.buildOutput!.endsWith('line\nlast line')).toBe(true);
    expect(evidence.buildOutput!.length).toBeLessThanOrEqual(8 * 1024);
    expect(docker.runs().filter(args => args[0] === 'run')).toEqual([]);
  });

  it('labels every resource and volume and removes them afterwards, also when a step fails', async () => {
    const docker = new FakeDocker(command => containerName(command.args)?.endsWith('-module')
      ? { exitCode: 125, stdout: '', stderr: 'docker: Error response from daemon: boom', timedOut: false } : undefined);
    const { evidence } = await collect(docker);
    expect(evidence.outcome).toBe('start-failed');
    expect(evidence.problem).toBe('module: docker run failed: docker: Error response from daemon: boom');
    const label = `tc-module-eval.run=${evidence.runId}`;
    expect(evidence.runId).toMatch(/^[0-9a-f]{12}$/);
    for (const args of [...docker.runs(), ...docker.calls.map(call => call.args).filter(args => args[0] === 'build' || (args[0] === 'network' && args[1] === 'create'))]) {
      expect(option(args, '--label')).toEqual([label]);
    }
    expect(option(docker.runs().find(args => containerName(args)?.endsWith('-postgres'))!, '--mount'))
      .toEqual([`type=volume,dst=/var/lib/postgresql/data,volume-label=${label}`]);
    expect(option(docker.runs().find(args => containerName(args)?.endsWith('-module'))!, '--mount')).toEqual([`type=volume,dst=/data,volume-label=${label}`]);
    expect(docker.syncCalls).toEqual([
      ['ps', '--all', '--quiet', '--filter', `label=${label}`], ['rm', '--force', '--volumes', 'ps-id'],
      ['network', 'ls', '--quiet', '--filter', `label=${label}`], ['network', 'rm', 'network-id'],
      ['volume', 'ls', '--quiet', '--filter', `label=${label}`], ['volume', 'rm', '--force', 'volume-id'],
      ['image', 'ls', '--quiet', '--filter', `label=${label}`], ['image', 'rm', '--force', 'image-id'],
      ['ps', '--all', '--quiet', '--filter', `label=${label}`], ['network', 'ls', '--quiet', '--filter', `label=${label}`],
      ['volume', 'ls', '--quiet', '--filter', `label=${label}`], ['image', 'ls', '--quiet', '--filter', `label=${label}`]
    ]);
    expect(evidence.cleanup).toEqual({ remaining: [], problems: [] });
  });

  it('stops listening for signals once a run ends', async () => {
    const { signals } = await collect();
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM') + signals.listenerCount('exit')).toBe(0);
    expect(signals.killed).toEqual([]);
  });

  it('reports labelled resources that cleanup could not remove', async () => {
    const docker = new FakeDocker();
    docker.runSync = (args: string[]) => {
      docker.syncCalls.push(args);
      if (args[0] === 'volume' && args[1] === 'ls') return { exitCode: 0, stdout: 'stuck-volume\n', stderr: '', timedOut: false };
      if (args[0] === 'volume' && args[1] === 'rm') return { exitCode: 1, stdout: '', stderr: 'volume is in use', timedOut: false };
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const { evidence } = await collect(docker);
    expect(evidence.cleanup).toEqual({ remaining: ['volume stuck-volume'], problems: ['docker volume rm --force stuck-volume: volume is in use'] });
  });

  it('removes everything on SIGINT and then lets the signal end the process', async () => {
    const signals = new FakeSignals();
    const docker = new FakeDocker(command => {
      if (command.args[0] === 'start') signals.emit('SIGINT', 'SIGINT');
      return undefined;
    });
    const { evidence } = await collect(docker, signals);
    const label = `label=tc-module-eval.run=${evidence.runId}`;
    expect(signals.killed).toEqual(['SIGINT']);
    expect(docker.syncCalls.slice(0, 2)).toEqual([['ps', '--all', '--quiet', '--filter', label], ['rm', '--force', '--volumes', 'ps-id']]);
    expect(docker.syncCalls.filter(args => args[0] === 'rm')).toHaveLength(1);
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM') + signals.listenerCount('exit')).toBe(0);
  });

  it('on SIGTERM during a docker run, kills the Docker CLI, starts nothing more, and sweeps until a late container is gone', async () => {
    const signals = new FakeSignals();
    const docker = new FakeDocker(command => {
      if (containerName(command.args)?.endsWith('-module')) signals.emit('SIGTERM', 'SIGTERM');
      return undefined;
    });
    let containerLists = 0;
    let removed = false;
    docker.runSync = (args: string[]) => {
      docker.syncCalls.push(args);
      if (args[0] === 'rm') removed = true;
      const late = args[0] === 'ps' && ++containerLists >= 2 && !removed;
      return { exitCode: 0, stdout: late ? 'late-module\n' : '', stderr: '', timedOut: false };
    };
    const harness = new DockerBackendRuntimeHarness({ docker, images: IMAGES, now: docker.now, signals, buildUser: '1000:1000', limits: { cleanupRetryMs: 0 } });
    const root = moduleRepository();
    const evidence = await harness.collect(root, await plan(root));
    const label = `label=tc-module-eval.run=${evidence.runId}`;

    expect(docker.cancelled).toBe(1);
    expect(signals.killed).toEqual(['SIGTERM']);
    expect(docker.calls.map(call => call.args).slice(docker.calls.findIndex(call => containerName(call.args)?.endsWith('-module')) + 1)).toEqual([]);
    expect(evidence.outcome).toBe('not-run');
    expect(evidence.problem).toBe('the evaluation was stopped by SIGTERM');
    expect(docker.syncCalls.filter(args => args[0] === 'rm')).toEqual([['rm', '--force', '--volumes', 'late-module']]);
    expect(docker.syncCalls.filter(args => args[0] === 'ps')).toEqual(Array(6).fill(['ps', '--all', '--quiet', '--filter', label]));
    expect(evidence.actions.filter(action => action.step === 'cleanup' && action.command.startsWith('docker rm '))).toHaveLength(1);
    expect(evidence.cleanup).toEqual({ remaining: [], problems: [] });
  });

  it('refuses to run when the Docker CLI configuration sets proxies, which the CLI would pass into containers', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-config-'));
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ proxies: { default: { httpProxy: 'http://user:secret@proxy:3128' } } }));
    const docker = new FakeDocker();
    const harness = new DockerBackendRuntimeHarness({ docker, images: IMAGES, now: docker.now, signals: new FakeSignals(), dockerConfigDir: directory });
    const root = moduleRepository();
    const evidence = await harness.collect(root, await plan(root));
    fs.rmSync(directory, { recursive: true, force: true });
    expect(evidence.outcome).toBe('not-run');
    expect(evidence.problem).toBe('the Docker CLI configuration (config.json) sets proxies, which the CLI would pass into every container');
    expect(docker.calls).toEqual([]);
  });

  it('gives each run its own label', async () => {
    const first = await collect();
    const second = await collect();
    expect(first.evidence.runId).not.toBe(second.evidence.runId);
    expect(first.evidence.runId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('runs nothing when the Docker daemon is not reachable', async () => {
    const docker = new FakeDocker(command => command.args[0] === 'info'
      ? { exitCode: 1, stdout: '', stderr: 'failed to connect to the docker API at unix:///var/run/docker.sock\nmore', timedOut: false } : undefined);
    const signals = new FakeSignals();
    const { evidence } = await collect(docker, signals);
    expect(evidence.outcome).toBe('not-run');
    expect(evidence.problem).toBe('the Docker daemon is not reachable: failed to connect to the docker API at unix:///var/run/docker.sock');
    expect(docker.calls.map(call => call.args[0])).toEqual(['info']);
    expect(docker.syncCalls).toEqual([]);
  });

  it('records the module\'s health, tenants, database and requests from probe output', async () => {
    const { evidence } = await collect();
    expect(evidence).toEqual(expect.objectContaining({
      outcome: 'collected',
      docker: { serverVersion: '29.9.2', context: 'default', rootless: false },
      health: { method: 'GET', path: '/admin/health', status: 200, body: '{"status":"UP"}', attempts: 1, waitedMs: 0 },
      tenants: [
        { method: 'POST', path: '/_/tenant', tenant: 'tcevala', status: 204, complete: true },
        { method: 'POST', path: '/_/tenant', tenant: 'tcevalb', status: 204, complete: true }
      ],
      database: { schemas: [{ name: 'tcevala_mod_example', tables: 3 }, { name: 'public', tables: 0 }], publicTables: [] },
      getRequests: [
        { method: 'GET', path: '/examples', tenant: 'tcevala', status: 200 },
        { method: 'GET', path: '/examples', tenant: 'tcevalb', status: 200 },
        { method: 'GET', path: '/example-missing', tenant: 'tcevala', status: 404 },
        { method: 'GET', path: '/example-missing', tenant: 'tcevalb', status: 404 }
      ]
    }));
  });

  it('stops waiting for health a minute after the module first answers with another status', async () => {
    const docker = new FakeDocker();
    docker.health = () => ({ method: 'GET', path: '/admin/health', status: 503, body: '{"status":"DOWN"}', attempts: 10 });
    const { evidence } = await collect(docker);
    expect(evidence.health).toEqual({ method: 'GET', path: '/admin/health', status: 503, body: '{"status":"DOWN"}', attempts: 40, waitedMs: 80_000 });
    expect(evidence.outcome).toBe('collected');
    expect(evidence.tenants).toHaveLength(2);
  });

  it('reports a module that stops running as a failed start', async () => {
    let inspections = 0;
    const docker = new FakeDocker(command => command.args[0] === 'container' && ++inspections > 1
      ? { exitCode: 0, stdout: JSON.stringify({ HostConfig: {}, State: { Running: false, ExitCode: 137, OOMKilled: true } }), stderr: '', timedOut: false }
      : undefined);
    const { evidence } = await collect(docker);
    expect(evidence.outcome).toBe('start-failed');
    expect(evidence.problem).toBe('the module container stopped running (exit code 137, out of memory)');
  });
});

describe('backend runtime evidence in the evaluation', () => {
  class CannedHarness implements BackendRuntimeHarness {
    readonly plans: BackendRuntimePlan[] = [];
    constructor(private readonly evidence: Partial<BackendRuntimeEvidence>) {}
    async collect(_root: string, runPlan: BackendRuntimePlan): Promise<BackendRuntimeEvidence> {
      this.plans.push(runPlan);
      return { outcome: 'collected', images: [], env: { template: [], harness: [], skipped: [] }, tenants: [], getRequests: [], getRequestsCut: 0, actions: [],
        cleanup: { remaining: [], problems: [] }, ...this.evidence };
    }
  }

  async function b003(root: string, backendRuntime?: BackendRuntimeHarness) {
    const run = createEvaluationRun({ repositoryPath: root, language: 'java', backendRuntime });
    const result = await new BackendEvaluator().evaluateCriterion('B003', root, run);
    return { result, analysis: result.criterionDetails as B003Analysis, run };
  }

  it('adds runtime GET statuses to B003 as rows that do not change its status', async () => {
    const root = moduleRepository();
    const without = await b003(root);
    const harness = new CannedHarness({
      getRequests: [
        { method: 'GET', path: '/examples', tenant: 'tcevala', status: 200, recordCount: 1 },
        { method: 'GET', path: '/examples', tenant: 'tcevalb', status: 200 },
        { method: 'GET', path: '/example-missing', tenant: 'tcevala', status: 404 },
        { method: 'GET', path: '/slow\nrow', tenant: 'tcevala', error: 'no response within 15000 ms' }
      ],
      getRequestsCut: 2,
      docker: { serverVersion: '29.9.2', context: 'default', rootless: false },
      cleanup: { remaining: ['network 7b2b710f1bd2'], problems: ['docker network rm 7b2b710f1bd2: network has active endpoints'] }
    });
    const { result, analysis } = await b003(root, harness);

    expect(result.status).toBe(without.result.status);
    expect(analysis.runtime).toEqual({
      outcome: 'collected',
      tenant: 'tcevala',
      requests: [{ path: '/examples', status: 200 }, { path: '/example-missing', status: 404 }, { path: '/slow\nrow', error: 'no response within 15000 ms' }],
      requestsCut: 2,
      docker: { serverVersion: '29.9.2', context: 'default', rootless: false },
      cleanup: { remaining: ['network 7b2b710f1bd2'], problems: ['docker network rm 7b2b710f1bd2: network has active endpoints'] }
    });
    const runtimeRows = result.details!.split('\n').filter(line => !without.result.details!.split('\n').includes(line));
    expect(runtimeRows).toEqual([
      'Runtime evidence (informational; it does not change the status):',
      '  - Docker 29.9.2, context default, not rootless (root-equivalent on this host)',
      '  - Cleanup left Docker resources of this run behind; remove them by hand:',
      '    - network 7b2b710f1bd2',
      '    - docker network rm 7b2b710f1bd2: network has active endpoints',
      '  - The module ran in Docker. GET requests in tenant tcevala to each provided path without parameters; 404 or 405 means no implementation answered:',
      '    - GET /examples answered 200',
      '    - GET /example-missing answered 404',
      '    - GET /slow ↵ row answered nothing (no response within 15000 ms)',
      '    - ... 2 more'
    ]);
    expect(harness.plans).toHaveLength(1);
  });

  it.each([
    ['collected', 'GET /admin/health got no response within 420 s', '  - The module ran in Docker: GET /admin/health got no response within 420 s'],
    ['not-run', 'the repository has no Dockerfile at its root', '  - The runtime harness did not run: the repository has no Dockerfile at its root'],
    ['build-failed', 'the build exited with 1', '  - The module could not be built in Docker: the build exited with 1'],
    ['start-failed', 'the module container stopped running (exit code 1)', '  - The module did not start in Docker: the module container stopped running (exit code 1)']
  ] as const)('says why B003 has no runtime statuses when the harness outcome is %s', async (outcome, problem, row) => {
    const { result } = await b003(moduleRepository(), new CannedHarness({ outcome, problem }));
    const lines = result.details!.split('\n');
    const at = lines.indexOf('Runtime evidence (informational; it does not change the status):');
    expect(lines.slice(at, at + 2)).toEqual(['Runtime evidence (informational; it does not change the status):', row]);
  });

  it('leaves B003 unchanged and runs nothing without --allow-runtime-checks', async () => {
    const root = moduleRepository();
    const { analysis, run } = await b003(root);
    expect('runtime' in analysis).toBe(false);
    expect(run.artifacts.backendRuntimeEvidence).toBeUndefined();
    expect(await getBackendRuntimeEvidence(run, root)).toEqual(expect.objectContaining({ outcome: 'not-configured', actions: [] }));
  });

  it('creates the Docker harness only when runtime checks and local commands are both allowed', async () => {
    const root = moduleRepository();
    const plansFor = async (allowRuntimeChecks: boolean, allowLocalCommands: boolean): Promise<number> => {
      const harness = new CannedHarness({});
      await new ModuleEvaluator({ allowRuntimeChecks, allowLocalCommands, backendRuntime: harness, criteriaFilter: ['B003'],
        tempDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-gate-')), commandRunner: { run: async () => { throw new Error('no commands'); }, normalize: () => '' } })
        .evaluateModule(root);
      return harness.plans.length;
    };
    expect(await plansFor(true, true)).toBe(1);
    expect(await plansFor(true, false)).toBe(0);
    expect(await plansFor(false, true)).toBe(0);
  });

  it('refuses --allow-runtime-checks without --allow-local-commands on the command line', () => {
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/cli.ts', 'evaluate', 'https://github.com/folio-org/mod-example', '--allow-runtime-checks'],
      { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n').slice(-1)).toEqual(['Use --allow-runtime-checks together with --allow-local-commands: the runtime harness builds and runs repository code.']);
  });
});

describe('backend runtime harness scans', () => {
  it('builds the plan in linear time', async () => {
    const root = moduleRepository();
    const base = await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
    await expectLinearTime(20_000, size => ({
      ...base,
      template: {
        ...base.template!,
        descriptor: {
          id: `mod-${'a'.repeat(size)}`,
          provides: [{ id: 'x', version: '1.0', handlers: Array.from({ length: size }, (_, index) => ({ methods: ['GET', 'POST'], pathPattern: `/${'/'.repeat(index % 50)}a${index}/{id` })) }],
          env: Array.from({ length: size }, (_, index) => ({ name: `${'A'.repeat(index % 300)}_${index}`, value: 'v'.repeat(index % 500) }))
        }
      }
    }), async evidence => backendRuntimePlan(evidence));
  });

  it('parses probe output in linear time and keeps only bounded fields', async () => {
    const result = await expectLinearTime(40_000, size => JSON.stringify({
      health: { method: 'GET', path: '/admin/health', status: 200, body: 'x'.repeat(size * 10), attempts: 1 },
      getRequests: Array.from({ length: size }, (_, index) => ({ method: 'GET', path: `/${'p'.repeat(index % 60)}`, tenant: 'tcevala', status: 200 + (index % 3) })),
      egress: Array.from({ length: size }, () => ({ target: 't', result: 'r' }))
    }), async stdout => parseProbeOutput(stdout));
    expect(result!.health!.body).toHaveLength(2_000);
    expect(result!.getRequests).toHaveLength(50);
    expect(result!.getRequests!.map(request => request.path.length)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(result!.egress).toHaveLength(10);
  });

  it('rejects probe output that is not its JSON', () => {
    expect(parseProbeOutput('Hello from the module')).toBeUndefined();
    expect(parseProbeOutput('{"error":"boom"}')).toBeUndefined();
    expect(parseProbeOutput(JSON.stringify({ getRequests: [{ method: 'GET', path: '/a', status: '200' }, { path: '/b' }] }))).toEqual({ getRequests: [{ method: 'GET', path: '/a' }] });
  });
});
