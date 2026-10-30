import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import { BackendRuntimePlan } from '../../types';
import { backendRuntimePlan, DockerBackendRuntimeHarness, loadRuntimeImages, RUNTIME_LABEL } from '../../utils/backend-runtime-harness';
import { getBackendEvidence } from '../../utils/backend-evidence';
import { createEvaluationRun } from '../../utils/evaluation-run';
import { pom, repository } from '../helpers/backend-repository';

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
const DOCKER_AVAILABLE = docker('info', '--format', '{{.ServerVersion}}').status === 0;
const describeWithDocker = DOCKER_AVAILABLE ? describe : describe.skip;
if (!DOCKER_AVAILABLE) {
  console.warn('Skipping the backend runtime harness Docker tests: the Docker daemon is not reachable (docker info failed). Start Docker and give this user access to it to run them.');
}

const SERVER = `const http = require('http');
const net = require('net');
const fs = require('fs');
const items = new Map();
const egress = new Promise(resolve => {
  const socket = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
  socket.on('connect', () => { socket.destroy(); resolve('connected'); });
  socket.on('timeout', () => { socket.destroy(); resolve('blocked'); });
  socket.on('error', () => resolve('blocked'));
});
const send = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(value === undefined ? undefined : JSON.stringify(value)); };
http.createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', async () => {
    const tenant = request.headers['x-okapi-tenant'];
    const list = items.get(tenant) || [];
    items.set(tenant, list);
    const url = request.url.split('?')[0];
    if (url === '/admin/health') return send(response, Number(process.env.HEALTH_STATUS), { status: process.env.HEALTH_STATUS === '200' ? 'UP' : 'DOWN' });
    if (url === '/_/tenant') { if (!list.length) list.push({ id: 'ref-' + tenant, name: 'Reference' }); return send(response, 204); }
    if (url === '/egress') return send(response, (await egress) === 'blocked' ? 200 : 500);
    if (url === '/caps') return send(response, /CapEff:\\s*0+\\n/.test(fs.readFileSync('/proc/self/status', 'utf8')) ? 200 : 500);
    if (url === '/items' && request.method === 'GET') return send(response, 200, { items: list, totalRecords: list.length });
    if (url === '/items' && request.method === 'POST') { const item = JSON.parse(body); list.push(item); return send(response, 201, item); }
    if (url.startsWith('/items/')) return list.some(item => item.id === url.slice(7)) ? send(response, 200, {}) : send(response, 404);
    send(response, 404);
  });
}).listen(8081);
`;

function fixture(healthStatus: string): string {
  return repository({
    'pom.xml': pom('mod-runtime-fixture', '<version>1.0.0</version><packaging>pom</packaging>'),
    Dockerfile: `FROM ${loadRuntimeImages().node}\nCOPY server.js /server.js\nUSER node\nEXPOSE 8081\nCMD ["node", "/server.js"]\n`,
    'server.js': SERVER,
    'descriptors/ModuleDescriptor-template.json': JSON.stringify({
      id: '${artifactId}-${version}',
      provides: [{ id: 'items', version: '1.0', handlers: [
        { methods: ['GET', 'POST'], pathPattern: '/items' },
        { methods: ['GET'], pathPattern: '/items/{id}' },
        { methods: ['GET'], pathPattern: '/egress' },
        { methods: ['GET'], pathPattern: '/caps' },
        { methods: ['GET'], pathPattern: '/unserved' }
      ] }],
      launchDescriptor: {
        dockerImage: 'mod-runtime-fixture:1.0.0',
        dockerArgs: { HostConfig: { Privileged: true, Binds: ['/:/host'], NetworkMode: 'host', PortBindings: { '8081/tcp': [{ HostPort: '18081' }] } } },
        env: [{ name: 'HEALTH_STATUS', value: healthStatus }, { name: 'DB_HOST', value: 'shared-db.example.org' }]
      }
    })
  });
}

async function plan(root: string): Promise<BackendRuntimePlan> {
  const result = backendRuntimePlan(await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root));
  if (typeof result === 'string') throw new Error(result);
  return result;
}

function labelled(runId: string): string[] {
  const filter = `label=${RUNTIME_LABEL}=${runId}`;
  return [
    ...docker('ps', '--all', '--quiet', '--filter', filter).stdout.split('\n'),
    ...docker('network', 'ls', '--quiet', '--filter', filter).stdout.split('\n'),
    ...docker('volume', 'ls', '--quiet', '--filter', filter).stdout.split('\n'),
    ...docker('image', 'ls', '--quiet', '--filter', filter).stdout.split('\n')
  ].filter(Boolean);
}

describeWithDocker('backend runtime harness with Docker', () => {
  jest.setTimeout(600_000);

  it('runs the module isolated: internal network, no capabilities, no template Docker settings, and nothing left afterwards', async () => {
    const root = fixture('200');
    const evidence = await new DockerBackendRuntimeHarness().collect(root, await plan(root));

    expect(evidence.outcome).toBe('collected');
    expect(evidence.health).toEqual(expect.objectContaining({ status: 200, body: '{"status":"UP"}' }));
    expect(evidence.network).toEqual(expect.objectContaining({ internal: true }));
    expect(evidence.network!.egress.map(entry => entry.target.replace(/^172\.\d+\.0\.1:/, 'host:'))).toEqual(['1.1.1.1:443', '8.8.8.8:53', '169.254.169.254:80', 'host:2375', 'DNS github.com']);
    expect(evidence.network!.egress.filter(entry => !/^(?:failed \((?:ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND)\)|timed out)$/.test(entry.result))).toEqual([]);
    expect(evidence.database).toEqual({ schemas: [{ name: 'public', tables: 0 }], publicTables: [] });
    expect(evidence.env.harness).toEqual(['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE', 'OKAPI_URL']);
    expect(evidence.module).toEqual(expect.objectContaining({ capDrop: ['ALL'], privileged: false, publishedPorts: [], pidsLimit: 512, memoryBytes: 2 * 1024 ** 3,
      nanoCpus: 2e9, networkMode: `tcme-${evidence.runId}` }));
    expect(evidence.module!.mounts).toEqual([]);
    expect(evidence.getRequests.filter(request => request.tenant === 'tcevala').map(request => `${request.path} ${request.status}`))
      .toEqual(['/items 200', '/egress 200', '/caps 200', '/unserved 404']);
    expect(evidence.crossTenant).toEqual(expect.objectContaining({ path: '/items', visibleInOwnTenant: true, visibleInOtherTenant: false }));
    expect(evidence.cleanup).toEqual({ remaining: [], problems: [] });
    expect(labelled(evidence.runId!)).toEqual([]);
  });

  it('records a health check that answers 503', async () => {
    const root = fixture('503');
    const evidence = await new DockerBackendRuntimeHarness({ limits: { healthSettleMs: 5_000, healthChunkMs: 5_000 } }).collect(root, await plan(root));
    expect(evidence.outcome).toBe('collected');
    expect(evidence.health).toEqual(expect.objectContaining({ status: 503, body: '{"status":"DOWN"}' }));
    expect(labelled(evidence.runId!)).toEqual([]);
  });

  it('removes every labelled resource when the evaluator gets SIGINT', async () => {
    const root = fixture('200');
    const before = new Set(docker('ps', '--all', '--filter', `label=${RUNTIME_LABEL}`, '--format', `{{.Label "${RUNTIME_LABEL}"}}`).stdout.split('\n').filter(Boolean));
    const repo = path.resolve(__dirname, '../../..');
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
      const { backendRuntimePlan, DockerBackendRuntimeHarness } = require('./src/utils/backend-runtime-harness');
      const { getBackendEvidence } = require('./src/utils/backend-evidence');
      const { createEvaluationRun } = require('./src/utils/evaluation-run');
      const root = ${JSON.stringify(root)};
      getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root)
        .then(evidence => new DockerBackendRuntimeHarness({ limits: { healthChunkMs: 60_000 } }).collect(root, backendRuntimePlan(evidence)));
    `], { cwd: repo, stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>(resolve => child.on('exit', (_code, signal) => resolve(signal)));
    let runId: string | undefined;
    for (let attempt = 0; attempt < 600 && !runId; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const running = docker('ps', '--filter', `label=${RUNTIME_LABEL}`, '--filter', 'name=-module$', '--format', `{{.Label "${RUNTIME_LABEL}"}}`).stdout.split('\n');
      runId = running.find(id => id && !before.has(id));
    }
    expect(runId).toMatch(/^[0-9a-f]{12}$/);
    child.kill('SIGINT');
    expect(await exited).toBe('SIGINT');
    expect(labelled(runId!)).toEqual([]);
  });
});
