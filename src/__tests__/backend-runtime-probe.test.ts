import http from 'http';
import { AddressInfo } from 'net';
import { ProbeInput, probeProgram, runtimeProbe } from '../utils/backend-runtime-probe';
import { expectLinearTime } from './helpers/linear-time';

interface Hit {
  method: string;
  url: string;
  tenant?: string;
  okapiUrl?: string;
  body: string;
}

async function serve(handler: (hit: Hit, response: http.ServerResponse) => void) {
  const hits: Hit[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const hit = { method: request.method ?? '', url: request.url ?? '', tenant: request.headers['x-okapi-tenant'] as string | undefined,
        okapiUrl: request.headers['x-okapi-url'] as string | undefined, body };
      hits.push(hit);
      handler(hit, response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

const json = (response: http.ServerResponse, status: number, value?: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(value === undefined ? undefined : JSON.stringify(value));
};

function input(moduleUrl: string, phase: Partial<ProbeInput>): ProbeInput {
  return { phase: 'requests', moduleUrl, okapiUrl: 'http://okapi-stub:9130', requestTimeoutMs: 2_000, bodyChars: 100, maxResponseBytes: 64 * 1024,
    tenants: ['tcevala', 'tcevalb'], ...phase };
}

describe('backend runtime probe', () => {
  it('polls /admin/health until it answers 200 and keeps the start of the body', async () => {
    let calls = 0;
    const server = await serve((_hit, response) => (++calls < 3 ? json(response, 503, { status: 'DOWN' }) : json(response, 200, { status: 'UP', detail: 'x'.repeat(500) })));
    const output = await runtimeProbe(input(server.url, { phase: 'health', waitMs: 10_000, pollMs: 10 }));
    await server.close();
    expect(output.health).toEqual({ method: 'GET', path: '/admin/health', status: 200, body: `{"status":"UP","detail":"${'x'.repeat(75)}`, attempts: 3 });
    expect(server.hits.map(hit => `${hit.method} ${hit.url} ${hit.tenant}`)).toEqual(Array(3).fill('GET /admin/health undefined'));
  });

  it('stops polling a health check that keeps failing when its wait ends', async () => {
    const server = await serve((_hit, response) => json(response, 503, { status: 'DOWN' }));
    const output = await runtimeProbe(input(server.url, { phase: 'health', waitMs: 0, pollMs: 10 }));
    await server.close();
    expect(output.health).toEqual({ method: 'GET', path: '/admin/health', status: 503, body: '{"status":"DOWN"}', attempts: 1 });
  });

  it('initializes each tenant with reference data, following an RMB tenant job until it completes', async () => {
    const polls: string[] = [];
    const server = await serve((hit, response) => {
      if (hit.method === 'POST' && hit.tenant === 'tcevala') return json(response, 201, { id: 'job-1', complete: false });
      if (hit.method === 'POST') return json(response, 500, { error: 'reference data failed' });
      polls.push(hit.url);
      return json(response, 200, { id: 'job-1', complete: polls.length > 1 });
    });
    const output = await runtimeProbe(input(server.url, { phase: 'tenants', moduleId: 'mod-example-1.0.0' }));
    await server.close();
    expect(output.tenants).toEqual([
      { method: 'POST', path: '/_/tenant', tenant: 'tcevala', status: 201, complete: true },
      { method: 'POST', path: '/_/tenant', tenant: 'tcevalb', status: 500, body: '{"error":"reference data failed"}' }
    ]);
    expect(server.hits.filter(hit => hit.method === 'POST').map(hit => JSON.parse(hit.body))).toEqual(Array(2).fill({
      module_to: 'mod-example-1.0.0', parameters: [{ key: 'loadReference', value: 'true' }, { key: 'loadSample', value: 'false' }]
    }));
    expect(polls).toEqual(['/_/tenant/job-1?wait=1000', '/_/tenant/job-1?wait=1000']);
  });

  it('sends GET only to the listed paths in both tenants, and writes only one copied record to one collection', async () => {
    const stored = new Map<string, Array<Record<string, unknown>>>([['tcevala', [{ id: 'ref-1', name: 'General', metadata: { createdDate: 'x' } }]], ['tcevalb', [{ id: 'ref-1', name: 'General' }]]]);
    const server = await serve((hit, response) => {
      const [pathname] = hit.url.split('?');
      const records = stored.get(hit.tenant ?? '') ?? [];
      if (pathname === '/types' && hit.method === 'GET') return json(response, 200, { types: records, totalRecords: records.length });
      if (pathname === '/types' && hit.method === 'POST') {
        records.push(JSON.parse(hit.body));
        return json(response, 201, JSON.parse(hit.body));
      }
      if (pathname.startsWith('/types/')) return records.some(item => item.id === pathname.slice(7)) ? json(response, 200, {}) : json(response, 404);
      if (pathname === '/empty') return json(response, 200, { items: [] });
      return json(response, 404);
    });
    const output = await runtimeProbe(input(server.url, {
      getPaths: ['/types', '/missing'],
      collections: [{ path: '/empty' }, { path: '/types', itemPath: '/types/{typeId}' }, { path: '/never' }]
    }));
    await server.close();
    const created = stored.get('tcevala')![1];
    expect(output.getRequests).toEqual([
      { method: 'GET', path: '/types', tenant: 'tcevala', status: 200, recordCount: 1 },
      { method: 'GET', path: '/types', tenant: 'tcevalb', status: 200, recordCount: 1 },
      { method: 'GET', path: '/missing', tenant: 'tcevala', status: 404 },
      { method: 'GET', path: '/missing', tenant: 'tcevalb', status: 404 }
    ]);
    expect(created).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: `General tc-module-eval ${String(created.id).slice(0, 8)}` });
    expect(output.crossTenant).toEqual({
      path: '/types', recordId: created.id, visibleInOwnTenant: true, visibleInOtherTenant: false,
      requests: [
        { method: 'GET', path: '/empty', tenant: 'tcevala', status: 200 },
        { method: 'GET', path: '/types', tenant: 'tcevala', status: 200 },
        { method: 'POST', path: '/types', tenant: 'tcevala', status: 201 },
        { method: 'GET', path: `/types/${created.id}`, tenant: 'tcevala', status: 200 },
        { method: 'GET', path: `/types/${created.id}`, tenant: 'tcevalb', status: 404 }
      ]
    });
    expect(server.hits.filter(hit => hit.method !== 'GET').map(hit => `${hit.method} ${hit.url} ${hit.tenant}`)).toEqual(['POST /types tcevala']);
    expect(new Set(server.hits.map(hit => hit.okapiUrl))).toEqual(new Set(['http://okapi-stub:9130']));
  });

  it('records a missing response and stops reading a response at the byte limit', async () => {
    const server = await serve((hit, response) => {
      if (hit.url === '/big') return json(response, 200, { items: Array(10_000).fill({ id: 'x' }) });
      response.destroy();
    });
    const output = await runtimeProbe(input(server.url, { getPaths: ['/big', '/dropped'], tenants: ['tcevala', 'tcevalb'], maxResponseBytes: 1024 }));
    await server.close();
    expect(output.getRequests).toEqual([
      { method: 'GET', path: '/big', tenant: 'tcevala', status: 200 },
      { method: 'GET', path: '/big', tenant: 'tcevalb', status: 200 },
      { method: 'GET', path: '/dropped', tenant: 'tcevala', error: 'socket hang up' },
      { method: 'GET', path: '/dropped', tenant: 'tcevalb', error: 'socket hang up' }
    ]);
  });

  it('sends nothing to a path that would leave the module', async () => {
    const server = await serve((_hit, response) => json(response, 200, {}));
    const output = await runtimeProbe({ ...input('http://module.invalid:8081', { getPaths: [`@${new URL(server.url).host}/x`] }), tenants: ['tcevala'] });
    await server.close();
    expect(output.getRequests).toEqual([
      { method: 'GET', path: `@${new URL(server.url).host}/x`, tenant: 'tcevala', error: 'not sent: the path leads outside the module' },
      { method: 'GET', path: `@${new URL(server.url).host}/x`, error: 'not sent: the path leads outside the module' }
    ]);
    expect(server.hits).toEqual([]);
  });

  it('sends nothing once its time budget has run out', async () => {
    const server = await serve((_hit, response) => json(response, 200, {}));
    const output = await runtimeProbe(input(server.url, { getPaths: ['/a'], collections: [{ path: '/a' }], budgetMs: 0 }));
    await server.close();
    expect(output).toEqual({
      getRequests: [
        { method: 'GET', path: '/a', tenant: 'tcevala', error: 'not sent: the time budget ran out' },
        { method: 'GET', path: '/a', tenant: 'tcevalb', error: 'not sent: the time budget ran out' }
      ],
      crossTenant: { problem: 'the time budget ran out', requests: [] }
    });
    expect(server.hits).toEqual([]);
  });

  it('tries connections to the internet and a DNS name and reports each result', async () => {
    const server = await serve((_hit, response) => json(response, 200));
    const port = Number(new URL(server.url).port);
    const output = await runtimeProbe(input(server.url, { phase: 'egress', egressTargets: [{ host: '127.0.0.1', port }], dnsName: 'name.invalid' }));
    await server.close();
    expect(output.egress).toEqual([{ target: `127.0.0.1:${port}`, result: 'connected' }, { target: 'DNS name.invalid', result: expect.stringMatching(/^failed \(/) }]);
  });

  it('is a self-contained program for the probe container', async () => {
    const program = probeProgram(input('http://module:8081', { phase: 'health', waitMs: 0 }));
    expect(() => new Function(program)).not.toThrow();
    expect(program).not.toMatch(/\brequire\((?!'(?:http|net|dns|crypto)'\))/);
  });

  it('counts the records of a large collection response in linear time', async () => {
    const server = await serve((hit, response) => {
      const size = Number(hit.url.split('size=')[1]);
      json(response, 200, { [`k${'e'.repeat(size)}`]: 'v', items: Array.from({ length: size }, (_, index) => ({ id: String(index), nested: { a: [1, 2, 3] } })) });
    });
    const output = await expectLinearTime(5_000, size => size, size => runtimeProbe(input(server.url, { getPaths: [`/c?size=${size}`], tenants: ['tcevala', 'tcevalb'], maxResponseBytes: 64 * 1024 * 1024 })));
    await server.close();
    expect(output.getRequests![0].recordCount).toBe(20_000);
  });
});
