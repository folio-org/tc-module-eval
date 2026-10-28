import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionResult, EvaluationStatus, F001Analysis, F001HandlerIndex, S008Catalog } from '../types';
import { compilePatterns, evaluateF001, loadF001HandlerIndex } from '../utils/f001-consumed-apis';
import { readFrontendSource } from '../utils/frontend-source';
import { DEFAULT_S008_CATALOG_PATHS } from '../utils/s008-catalog';
import { collectFrontend } from '../utils/s008-interface-declarations';
import { extractUiRequestSites } from '../utils/ui-request-sites';

// These tests use the committed handler index (R1-2026 GA), so the interfaces below are real ones.
describe('F001 consumed interfaces', () => {
  let parent: string;
  let repoPath: string;

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'f001-'));
    // A directory named like a UI module; F001 must go by package.json, never by the directory name.
    repoPath = path.join(parent, 'ui-orders');
    fs.mkdirSync(repoPath);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
  });
  afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

  it('fails for each undeclared interface, choosing the most specific path and reading tokens, constants and optional declarations', async () => {
    writePackage({ okapiInterfaces: { inventory: '14.0', circulation: '14.0' }, optionalOkapiInterfaces: { 'service-points': '3.0' } });
    write('src/constants.js', "export const MOVE_API = 'inventory/items/move';\n");
    write('src/api/index.js', "export * from '../constants';\n");
    write('src/Scan.js', [
      "import { MOVE_API } from './api';",
      'const MAX = 1000;',
      'export default class Scan {',
      '  static manifest = Object.freeze({',
      "    item: { type: 'okapi', path: 'inventory/items/%{activeRecord.id}' },",
      '    servicePoints: { type: \'okapi\', path: `service-points?limit=${MAX}` },',
      "    endSession: { type: 'okapi', path: 'circulation/end-patron-action-session', fetch: false },",
      "    modules: { type: 'okapi', path: '_/proxy/tenants/!{tenant}/modules' },",
      '  });',
      '}',
      "export const useMove = () => { const ky = useOkapiKy(); return id => ky.post(MOVE_API, { json: { id } }); };"
    ].join('\n'));
    // Tests are not production code, so this undeclared interface does not count.
    write('src/Scan.test.js', "it('scans', () => ky.get('staff-slips-storage/staff-slips'));\n");
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('F001 fail: The module calls 2 interfaces it does not declare in package.json: inventory-move and patron-action-session.');
    // inventory/items/move also matches inventory's /inventory/items/{id}; the fixed segment is more specific.
    expect(analysis.undeclared.map(use => [use.id, use.sites.map(site => `${site.path}:${site.line} ${site.requestPath}`)])).toEqual([
      ['inventory-move', ['src/Scan.js:11 inventory/items/move']],
      ['patron-action-session', ['src/Scan.js:7 circulation/end-patron-action-session']]
    ]);
    expect(analysis.declaredAndUsed.map(use => [use.id, use.sites.map(site => site.requestPath)])).toEqual([
      ['inventory', ['inventory/items/{}']],
      ['service-points', ['service-points']]
    ]);
    expect(analysis.declaredNotSeen).toEqual(['circulation']);
    expect([analysis.siteCount, analysis.gatewaySiteCount, analysis.unresolvedSites, analysis.notInIndexSites]).toEqual([4, 1, [], []]);
    expect(result.details).toContain('Used but not declared:\n  - inventory-move:\n    - src/Scan.js:11 — requests POST inventory/items/move\n');
    expect(analysis.checklist.items.map(item => [item.id, item.reviewerOnly, item.obligations])).toEqual([['F001-C1', true, []]]);
  });

  it('stays manual, and names the candidates, when a request cannot be read or could reach several interfaces', async () => {
    writePackage({ okapiInterfaces: { users: '16.5', configuration: '2.0' } });
    // A path constant in a test fixture is not production code, so the tool does not read it.
    write('src/fixtures/api.js', "export const LOANS_API = 'loan-anonymization/by-user';\n");
    write('src/Settings.js', [
      "import { LOANS_API } from './fixtures/api';",
      "import { LINES_API } from '@folio/stripes-acq-components';",
      'export const useSettings = ({ moduleName, userId }) => {',
      '  const ky = useOkapiKy();',
      "  ky.get('users');",
      '  ky.get(`${moduleName}/entries`);',
      '  ky.post(`${LOANS_API}/${userId}`);',
      '  ky.get(LINES_API);',
      "  return ky.get('inventory/items' + window.location.search);",
      '};'
    ].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('F001 manual: Every request the tool could map goes to an interface the module declares, but 4 requests could not be mapped to one interface.');
    expect(analysis.declaredAndUsed.map(use => use.id)).toEqual(['users']);
    // {}/entries could be configurations/entries (declared) or settings/entries (not), so it proves nothing.
    expect(analysis.unresolvedSites.map(site => [site.line, site.outcome, site.requestPath, site.openEnd])).toEqual([
      [6, 'dynamic', '{}/entries', undefined],
      [7, 'unresolved', undefined, undefined],
      [8, 'unresolved', undefined, undefined],
      // Whatever follows inventory/items could also reach inventory-move or inventory-update-ownership.
      [9, 'dynamic', 'inventory/items', true]
    ]);
    expect(analysis.unresolvedSites[0].interfaces).toEqual(expect.arrayContaining(['configuration', 'settings']));
    expect(analysis.unresolvedSites[3].interfaces).toEqual(expect.arrayContaining(['inventory', 'inventory-move']));
    expect(analysis.unresolvedSites[1].unresolved).toBe('part of the path could not be read: it is imported from ./fixtures/api, which is not in the production source that was read');
    expect(analysis.unresolvedSites[2].unresolved).toBe('part of the path could not be read: it is imported from @folio/stripes-acq-components');
    expect(analysis.checklist.items.find(item => item.id === 'F001-C2')?.obligations.map(obligation => [obligation.id, obligation.subject, obligation.line])).toEqual([
      ['F001-C2#1', 'GET {}/entries', 6], ['F001-C2#2', 'POST `${LOANS_API}/${userId}`', 7], ['F001-C2#3', 'GET LINES_API', 8], ['F001-C2#4', 'GET inventory/items…', 9]
    ]);
  });

  it('does not fail when a declaration map cannot be read, since it might declare the interface', async () => {
    writePackage({ okapiInterfaces: { users: '16.5' }, optionalOkapiInterfaces: ['circulation'] });
    write('src/Loans.js', [
      "import { API } from '../../outside/api';",
      "export const useLoans = () => { const ky = useOkapiKy(); ky.get(API); return ky.get('circulation/loans'); };"
    ].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('F001 manual: The module calls 1 interface package.json does not seem to declare (circulation), '
      + 'but 1 request could not be mapped to one interface and not all interface declarations in package.json could be read.');
    expect(analysis.unresolvedSites.map(site => site.unresolved)).toEqual(['part of the path could not be read: it is imported from ../../outside/api, outside the repository']);
  });

  it('passes when every request maps to a declared interface, through ky.extend prefixes, the Okapi URL and path functions', async () => {
    writePackage({ okapiInterfaces: { users: '16.5' }, optionalOkapiInterfaces: { circulation: '14.0', 'users-keycloak': '1.0' } });
    write('src/User.js', [
      'export const useUser = (id, okapi) => {',
      '  const api = useOkapiKy().extend({ prefixUrl: \'users\' });',
      '  fetch(`${okapi.url}/circulation/loans?query=userId==${id}`);',
      '  return api.get(`${id}`);',
      '};',
      'export const manifest = {',
      '  user: {',
      "    type: 'okapi',",
      "    path: (_q, _p, _r, _l, props) => { if (props.stripes.hasInterface('users-keycloak')) return `users-keycloak/users/${props.id}`; return null; },",
      '  },',
      '};'
    ].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('F001 pass: Every request in the module\'s code goes to an interface it declares in package.json (3 requests to 3 interfaces).');
    expect(analysis.declaredAndUsed.map(use => [use.id, use.sites[0].kind, use.sites[0].requestPath])).toEqual([
      ['circulation', 'fetch', 'circulation/loans'], ['users', 'ky', 'users/{}'], ['users-keycloak', 'stripes-connect', 'users-keycloak/users/{}']
    ]);
    expect(analysis.checklist.items).toEqual([]);
  });

  it('evaluates a library by its package.json, as it does a module', async () => {
    write('package.json', JSON.stringify({ name: '@folio/stripes-acq-components', stripes: { actsAs: [''], okapiInterfaces: { users: '16.5' } } }));
    write('lib/hooks.js', [
      "export const useUsers = () => useOkapiKy().get('users');",
      "export const useFields = () => useOkapiKy().get('custom-fields');"
    ].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(analysis.undeclared.map(use => use.id)).toEqual(['custom-fields']);
    expect(analysis.declaredAndUsed.map(use => use.id)).toEqual(['users']);
  });

  it('calls equally specific paths of two interfaces ambiguous, and an index built from another catalog not loaded', async () => {
    writePackage({ okapiInterfaces: { alpha: '1.0' } });
    write('src/Things.js', "export const useThing = id => useOkapiKy().get(`things/${id}`);\n");
    commit();
    const source = await readFrontendSource(repoPath);
    const sites = extractUiRequestSites(source);
    const declarations = collectFrontend(repoPath);
    const index: F001HandlerIndex = {
      schemaVersion: '1.0', baseline: { platformRepository: 'p', platformCommit: 'c', descriptorVersion: 'R1' }, s008Catalog: { path: 'x', digest: 'd' },
      providers: [{ moduleId: 'mod-a-1.0.0', descriptorHash: 'h', interfaces: [
        { id: 'alpha', version: '1.0', handlers: [{ methods: ['GET'], pathPattern: '/things/{id}' }] },
        { id: 'beta', version: '1.0', handlers: [{ methods: ['GET'], pathPattern: '/things/{thingId}' }] }
      ] }]
    };

    const ambiguous = evaluateF001({ source, sites, declarations, index: { loaded: true, index, patterns: compilePatterns(index) } });
    expect(ambiguous.status).toBe(EvaluationStatus.MANUAL);
    expect(ambiguous.unresolvedSites.map(site => [site.outcome, site.interfaces])).toEqual([['ambiguous', ['alpha', 'beta']]]);

    const indexPath = path.join(parent, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(index));
    const stale = loadF001HandlerIndex(indexPath);
    expect(stale).toEqual({ loaded: false, problem: 'index.json could not be used: it was built from a different S008 catalog; rebuild it with yarn build:f001-handler-index' });
    const withoutIndex = evaluateF001({ source, sites, declarations, index: stale });
    expect(withoutIndex.status).toBe(EvaluationStatus.MANUAL);
    expect(withoutIndex.summary).toContain('the handler index could not be loaded');
  });

  it('has a committed index for exactly the providers of the committed S008 catalog', () => {
    const loaded = loadF001HandlerIndex();
    if (!loaded.loaded) throw new Error(loaded.problem);
    const catalog = JSON.parse(fs.readFileSync(DEFAULT_S008_CATALOG_PATHS.official, 'utf8')) as S008Catalog;
    expect(loaded.index.providers.map(provider => [provider.moduleId, provider.descriptorHash]).sort())
      .toEqual(catalog.providers.map(provider => [provider.moduleId, provider.descriptorHash]).sort());
    expect(loaded.index.baseline.platformCommit).toBe(catalog.baseline.platformCommit);
    // Added to the catalog by hand from app-requests-ecs; its handlers come from the same descriptor.
    const bff = loaded.index.providers.find(provider => provider.moduleId === 'mod-circulation-bff-1.2.3');
    expect(bff?.interfaces.map(provided => provided.id)).toContain('circulation-bff-loans');
    expect(loaded.patterns.some(pattern => pattern.interfaceId.startsWith('_'))).toBe(false);
  });

  async function evaluate(): Promise<{ result: CriterionResult; analysis: F001Analysis }> {
    const result = await new FrontendEvaluator().evaluateCriterion('F001', repoPath);
    return { result, analysis: result.criterionDetails as F001Analysis };
  }
  function writePackage(stripes: Record<string, unknown>): void {
    write('package.json', JSON.stringify({ name: '@folio/example', stripes: { actsAs: ['app'], ...stripes } }));
  }
  function write(relativePath: string, content: string): void {
    const absolutePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repoPath });
  }
  function commit(): void {
    git('add', '.');
    git('commit', '-qm', 'fixture');
  }
});
