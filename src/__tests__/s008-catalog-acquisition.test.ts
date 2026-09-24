import fs from 'fs-extra';
import http from 'http';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import { acquireS008Catalog } from '../tools/acquire-s008-catalog';
import { loadS008Catalog } from '../utils/s008-catalog';

const COMMIT = 'a'.repeat(40);

describe('S008 catalog network acquisition', () => {
  it('uses exact pins, resolves embedded and registry descriptors, excludes experimental, and writes deterministic review artifacts', async () => {
    const requested: string[] = [];
    const server = await fixtureServer((request, response) => {
      requested.push(request.url!);
      if (request.url === `/platform/${COMMIT}/platform-descriptor.json`) return json(response, {
        version: 'R1-2026',
        applications: {
          required: [{ name: 'app-required', version: '1.0.0' }],
          optional: [{ name: 'app-optional', version: '2.0.0' }],
          experimental: [{ name: 'app-experimental', version: '9.9.9' }]
        },
        'eureka-components': [
          { name: 'edge-component', version: '3.0.0' },
          { name: 'folio-keycloak', version: '26.5.4' },
          { name: 'mgr-applications', version: '4.0.1' }
        ]
      });
      if (request.url?.startsWith('/applications?')) {
        const url = new URL(request.url, 'http://localhost');
        expect(url.searchParams.get('full')).toBe('true');
        expect(url.searchParams.get('limit')).toBe('2');
        const query = url.searchParams.get('query');
        if (query === 'id==app-required-1.0.0') return json(response, {
          applicationDescriptors: [{
            id: 'app-required-1.0.0', name: 'app-required', version: '1.0.0',
            modules: [{ id: 'mod-a-1.2.3', name: 'mod-a', version: '1.2.3', url: 'https://untrusted.example.org/descriptors/mod-a.json' }],
            moduleDescriptors: [{ id: 'mod-a-1.2.3', name: 'Module A', metadata: { repository: 'https://github.com/folio-org/mod-a' }, provides: [{ id: 'alpha', version: '1.1' }] }],
            uiModules: [{ id: 'folio_ui-a-4.5.6', name: 'folio_ui-a', version: '4.5.6' }]
          }], totalRecords: 1
        });
        if (query === 'id==app-optional-2.0.0') return json(response, {
          applicationDescriptors: [{
            id: 'app-optional-2.0.0', name: 'app-optional', version: '2.0.0',
            modules: [{ id: 'mod-b-2.1.0', name: 'mod-b', version: '2.1.0' }],
            moduleDescriptors: [{ id: 'mod-b-2.1.0' }]
          }], totalRecords: 1
        });
      }
      if (request.url === '/_/proxy/modules/folio_ui-a-4.5.6') return json(response, { id: 'folio_ui-a-4.5.6', provides: [{ id: 'ui-alpha', version: '4.0' }] });
      if (request.url === '/_/proxy/modules/edge-component-3.0.0') return json(response, { id: 'edge-component-3.0.0', provides: [{ id: 'edge', version: '3.0' }] });
      if (request.url === '/repos/folio-org/mgr-applications/git/ref/tags/v4.0.1') return json(response, { object: { type: 'tag', sha: 'b'.repeat(40) } });
      if (request.url === `/repos/folio-org/mgr-applications/git/tags/${'b'.repeat(40)}`) return json(response, { object: { type: 'commit', sha: 'c'.repeat(40) } });
      if (request.url === `/folio-org/mgr-applications/${'c'.repeat(40)}/src/main/resources/descriptors/ModuleDescriptor.json`) {
        return json(response, { id: 'mgr-applications-4.0.0', provides: [{ id: 'applications', version: '1.3' }] });
      }
      response.writeHead(404).end();
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's008-acquire-'));
    const ledgerPath = path.resolve('config/acceptance-ledger.json');
    const ledgerBefore = sha256(await fs.readFile(ledgerPath));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const output of ['first', 'second']) await acquireS008Catalog({
        platformCommit: COMMIT, channel: 'official', outputDir: path.join(root, output),
        farUrl: base, registryUrl: base, platformRawBaseUrl: `${base}/platform/`,
        githubApiBaseUrl: base, githubRawBaseUrl: base, concurrency: 2
      });

      const first = path.join(root, 'first');
      const catalog = await fs.readJson(path.join(first, 's008-catalog.json'));
      expect(catalog.authoritative).toBe(false);
      expect(catalog.applications.map((application: any) => [application.name, application.optional])).toEqual([
        ['app-required', false], ['app-optional', true]
      ]);
      expect(catalog.providers.map((provider: any) => provider.moduleId)).toEqual([
        'edge-component-3.0.0', 'folio_ui-a-4.5.6', 'mgr-applications-4.0.0', 'mod-a-1.2.3', 'mod-b-2.1.0'
      ]);
      expect(catalog.eurekaComponents).toEqual([
        { familyId: 'edge-component', moduleIdentities: ['edge-component'] },
        { familyId: 'folio-keycloak', moduleIdentities: ['folio-keycloak'] },
        { familyId: 'mgr-applications', moduleIdentities: ['mgr-applications'] }
      ]);
      expect((await fs.readJson(path.join(first, 'acquisition-diagnostics.json'))).complete).toBe(true);
      const loadedCatalog = await loadS008Catalog('official', { official: path.join(first, 's008-catalog.json') });
      expect(loadedCatalog).toMatchObject({ ok: false, diagnostics: [{ code: 'catalog_not_authoritative' }] });

      const discovery = await fs.readJson(path.join(first, 's008-discovered-identities.json'));
      expect(discovery).toMatchObject({ authoritative: false, reviewStatus: 'unreviewed' });
      expect(discovery.identities.every((identity: any) => identity.unreviewed)).toBe(true);
      expect(discovery.identities.find((identity: any) => identity.moduleIdentity === 'mod-a')).toMatchObject({
        observedModules: [{ id: 'mod-a-1.2.3', version: '1.2.3' }],
        suggestions: { familyId: 'mod-a', displayName: 'Module A', canonicalRepositories: ['folio-org/mod-a'] }
      });
      expect(discovery.identities.find((identity: any) => identity.moduleIdentity === 'folio-keycloak')).toMatchObject({
        observedModules: [{ id: 'folio-keycloak-26.5.4', version: '26.5.4' }], descriptors: [],
        descriptorStatus: 'intentionally-descriptorless'
      });
      expect(discovery.identities.find((identity: any) => identity.moduleIdentity === 'mgr-applications')).toMatchObject({
        observedModules: [{ id: 'mgr-applications-4.0.1', version: '4.0.1' }],
        descriptors: [expect.objectContaining({ moduleId: 'mgr-applications-4.0.0' })], descriptorStatus: 'acquired'
      });
      const manifest = await fs.readJson(path.join(first, 'snapshot-manifest.json'));
      expect(manifest.componentSources).toEqual(expect.arrayContaining([
        { name: 'folio-keycloak', version: '26.5.4', status: 'intentionally-descriptorless' },
        expect.objectContaining({
          name: 'mgr-applications', version: '4.0.1', status: 'acquired', tag: 'v4.0.1',
          commit: 'c'.repeat(40), descriptorHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
        })
      ]));
      expect(requested.some(url => url.includes('app-experimental'))).toBe(false);
      expect(requested.some(url => url.includes('untrusted.example.org'))).toBe(false);
      expect(requested).not.toContain('/_/proxy/modules/mod-a-1.2.3');
      expect(requested).not.toContain('/_/proxy/modules/folio-keycloak-26.5.4');
      expect(requested).not.toContain('/_/proxy/modules/mgr-applications-4.0.1');
      expect(requested).toContain('/_/proxy/modules/folio_ui-a-4.5.6');
      expect(await directoryContents(path.join(root, 'first'))).toEqual(await directoryContents(path.join(root, 'second')));
      expect(sha256(await fs.readFile(ledgerPath))).toBe(ledgerBefore);
    } finally {
      await close(server);
      await fs.remove(root);
    }
  });

  it('retains incomplete discovery and emits material diagnostics for acquisition failures and conflicting descriptors', async () => {
    const server = await fixtureServer((request, response) => {
      if (request.url === `/platform/${COMMIT}/platform-descriptor.json`) return json(response, {
        version: 'dev', applications: { required: [
          { name: 'app-zero', version: '1.0.0' }, { name: 'app-many', version: '1.0.0' },
          { name: 'app-auth', version: '1.0.0' }, { name: 'app-left', version: '1.0.0' },
          { name: 'app-right', version: '1.0.0' }
        ] }, 'eureka-components': [
          { name: 'missing-component', version: '1.0.0' },
          { name: 'mgr-tenants', version: '4.0.0' }
        ]
      });
      if (request.url?.startsWith('/applications?')) {
        const query = new URL(request.url, 'http://localhost').searchParams.get('query');
        if (query === 'id==app-zero-1.0.0') return json(response, { applicationDescriptors: [], totalRecords: 0 });
        if (query === 'id==app-many-1.0.0') return json(response, { applicationDescriptors: [{ id: 'one' }, { id: 'two' }], totalRecords: 2 });
        if (query === 'id==app-auth-1.0.0') return response.writeHead(403).end();
        const name = query === 'id==app-left-1.0.0' ? 'app-left' : 'app-right';
        return json(response, { applicationDescriptors: [{
          id: `${name}-1.0.0`, name, version: '1.0.0',
          modules: [{ id: 'mod-shared-1.0.0', name: 'mod-shared', version: '1.0.0' }],
          moduleDescriptors: [{ id: 'mod-shared-1.0.0', provides: [{ id: 'shared', version: name === 'app-left' ? '1.0' : '>=2.0' }] }]
        }], totalRecords: 1 });
      }
      response.writeHead(404).end();
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's008-acquire-errors-'));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const output = path.join(root, 'output');
      await acquireS008Catalog({
        platformCommit: COMMIT, channel: 'development', outputDir: output,
        farUrl: base, registryUrl: base, platformRawBaseUrl: `${base}/platform/`, githubApiBaseUrl: base, githubRawBaseUrl: base
      });
      const report = await fs.readJson(path.join(output, 'acquisition-diagnostics.json'));
      expect(report.complete).toBe(false);
      expect(report.diagnostics.map((item: any) => item.code)).toEqual(expect.arrayContaining([
        'far_cardinality', 'far_request_failed', 'conflicting_descriptor_bytes', 'unresolved_component_descriptor',
        'component_tag_descriptor_failed', 'unsupported_provider_version'
      ]));
      expect(report.diagnostics.filter((item: any) => item.code === 'far_cardinality')).toHaveLength(2);
      expect(report.diagnostics.find((item: any) => item.code === 'far_request_failed').message).toContain('authentication is not supported');
      const catalog = await fs.readJson(path.join(output, 's008-catalog.json'));
      expect(catalog.authoritative).toBe(false);
      expect(catalog.providers).toEqual([]);
      const discovery = await fs.readJson(path.join(output, 's008-discovered-identities.json'));
      expect(discovery.identities.find((identity: any) => identity.moduleIdentity === 'missing-component')).toMatchObject({
        observedModuleIds: ['missing-component-1.0.0'], descriptors: [], unreviewed: true
      });
      expect(discovery.identities.find((identity: any) => identity.moduleIdentity === 'mgr-tenants')).toMatchObject({
        observedModuleIds: ['mgr-tenants-4.0.0'], descriptors: [], descriptorStatus: 'unresolved', unreviewed: true
      });
    } finally {
      await close(server);
      await fs.remove(root);
    }
  });

  it('rejects mutable pins, unsafe hosts, credentials, and existing output directories before acquisition', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's008-acquire-validation-'));
    try {
      await expect(acquireS008Catalog({ platformCommit: 'main', channel: 'official', outputDir: path.join(root, 'a') })).rejects.toThrow('immutable');
      await expect(acquireS008Catalog({ platformCommit: COMMIT, channel: 'official', outputDir: path.join(root, 'b'), farUrl: 'http://far.example.org' })).rejects.toThrow('HTTPS');
      await expect(acquireS008Catalog({ platformCommit: COMMIT, channel: 'official', outputDir: path.join(root, 'c'), registryUrl: 'https://user:secret@example.org' })).rejects.toThrow('credentials');
      await expect(acquireS008Catalog({ platformCommit: COMMIT, channel: 'official', outputDir: path.join(root, 'd'), concurrency: 0 })).rejects.toThrow('positive integer');
      const existing = path.join(root, 'existing');
      await fs.ensureDir(existing);
      await expect(acquireS008Catalog({ platformCommit: COMMIT, channel: 'official', outputDir: existing })).rejects.toThrow('already exists');
    } finally { await fs.remove(root); }
  });

  it('does not publish a partial output directory when acquisition cannot complete', async () => {
    const server = await fixtureServer((_request, response) => response.writeHead(200).end('{not json'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 's008-acquire-atomic-'));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const output = path.join(root, 'output');
      await expect(acquireS008Catalog({
        platformCommit: COMMIT, channel: 'official', outputDir: output,
        farUrl: base, registryUrl: base, platformRawBaseUrl: `${base}/platform/`
      })).rejects.toThrow();
      expect(await fs.pathExists(output)).toBe(false);
      expect((await fs.readdir(root)).filter(name => name.includes('.tmp-'))).toEqual([]);
    } finally {
      await close(server);
      await fs.remove(root);
    }
  });
});

async function fixtureServer(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function json(response: http.ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function sha256(value: Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }

async function directoryContents(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const name of (await fs.readdir(directory)).sort()) {
      const absolute = path.join(directory, name);
      const stat = await fs.stat(absolute);
      if (stat.isDirectory()) await visit(absolute);
      else output[path.relative(root, absolute)] = await fs.readFile(absolute, 'utf8');
    }
  }
  await visit(root);
  return output;
}
