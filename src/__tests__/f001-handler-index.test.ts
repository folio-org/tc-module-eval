import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { buildF001HandlerIndex } from '../tools/build-f001-handler-index';
import { stableStringify } from '../tools/acquire-s008-catalog';
import { sha256Digest } from '../utils/repo-files';

describe('F001 handler index build', () => {
  const backend = {
    id: 'mod-a-1.0.0',
    provides: [
      { id: 'alpha', version: '1.2', handlers: [{ methods: ['POST', 'GET'], pathPattern: '/alpha/{id}', permissionsRequired: ['alpha.get'] }] },
      // System interfaces are named with a leading underscore, or typed system; either is enough.
      { id: '_tenant', version: '2.0', handlers: [{ methods: ['POST'], pathPattern: '/_/tenant' }] },
      { id: 'alpha-timer', version: '1.0', interfaceType: 'system', handlers: [{ methods: ['POST'], pathPattern: '/alpha/expire' }] },
      { id: 'alpha-events', version: '1.0' }
    ]
  };
  // A provider added by hand from outside the platform's applications, like mod-circulation-bff.
  const extra = { id: 'mod-b-2.0.0', provides: [{ id: 'beta', version: '2.0', handlers: [{ methods: ['GET'], pathPattern: '/beta*' }] }] };
  let server: http.Server;
  let base: string;
  let directory: string;
  const requested: string[] = [];

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'f001-index-'));
    requested.length = 0;
    server = http.createServer((request, response) => {
      requested.push(request.url!);
      const body = request.url!.startsWith('/applications?') && new URL(request.url!, base).searchParams.get('query') === 'id==app-a-1.0.0'
        ? { totalRecords: 1, applicationDescriptors: [{ id: 'app-a-1.0.0', name: 'app-a', version: '1.0.0', moduleDescriptors: [backend], uiModuleDescriptors: [] }] }
        : request.url === '/descriptors/mod-b.json' ? extra : undefined;
      if (!body) return void response.writeHead(404).end();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function writeCatalog(hashA = sha256Digest(stableStringify(backend))): string {
    const catalogPath = path.join(directory, 'catalog.json');
    fs.writeFileSync(catalogPath, JSON.stringify({
      baseline: { platformRepository: 'https://github.com/folio-org/platform-lsp', platformCommit: 'a'.repeat(40), descriptorVersion: 'R1-2026' },
      providers: [
        { moduleId: 'mod-a-1.0.0', source: 'FAR:app-a-1.0.0', descriptorHash: hashA, provides: [] },
        { moduleId: 'mod-b-2.0.0', source: `${base}/descriptors/mod-b.json`, descriptorHash: sha256Digest(stableStringify(extra)), provides: [] }
      ]
    }));
    return catalogPath;
  }

  it('indexes the handlers of each catalog provider from its recorded source, without system interfaces', async () => {
    const catalogPath = writeCatalog();
    const index = await buildF001HandlerIndex({ catalogPath, farUrl: base });

    expect(requested).toEqual(expect.arrayContaining(['/applications?query=id%3D%3Dapp-a-1.0.0&full=true&limit=2', '/descriptors/mod-b.json']));
    expect(index.s008Catalog.digest).toBe(sha256Digest(fs.readFileSync(catalogPath, 'utf8')));
    expect(index.providers).toEqual([
      { moduleId: 'mod-a-1.0.0', descriptorHash: sha256Digest(stableStringify(backend)),
        interfaces: [{ id: 'alpha', version: '1.2', handlers: [{ methods: ['GET', 'POST'], pathPattern: '/alpha/{id}' }] }] },
      { moduleId: 'mod-b-2.0.0', descriptorHash: sha256Digest(stableStringify(extra)),
        interfaces: [{ id: 'beta', version: '2.0', handlers: [{ methods: ['GET'], pathPattern: '/beta*' }] }] }
    ]);
  });

  it('refuses a descriptor that is not the one the catalog reviewed', async () => {
    await expect(buildF001HandlerIndex({ catalogPath: writeCatalog(`sha256:${'0'.repeat(64)}`), farUrl: base }))
      .rejects.toThrow(`The descriptor of mod-a-1.0.0 from FAR:app-a-1.0.0 does not match the catalog's hash sha256:${'0'.repeat(64)}.`);
  });
});
