import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B006Analysis, EvaluationStatus } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, git, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b006(root: string, existingModule = false) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java', existingModule });
  const result = await new BackendEvaluator().evaluateCriterion('B006', root, run);
  return { result, analysis: result.criterionDetails as B006Analysis };
}

const springApp = { 'src/main/java/org/example/Application.java': '@SpringBootApplication\npublic class Application {}\n' };

function descriptor(handlers: Array<[string[], string]>, extra: object[] = []): string {
  return JSON.stringify({
    id: '${artifactId}-1.0.0',
    provides: [
      { id: 'example', version: '1.0', handlers: handlers.map(([methods, pathPattern]) => ({ methods, pathPattern })) },
      { id: '_tenant', version: '2.0', interfaceType: 'system', handlers: [{ methods: ['POST'], pathPattern: '/_/tenant' }] },
      ...extra
    ]
  });
}

const documentation = (analysis: B006Analysis) =>
  Object.fromEntries(analysis.endpoints.map(endpoint => [`${endpoint.method} ${endpoint.path}`, endpoint.documentation]));

describe('B006 API documentation', () => {
  it('follows $ref chains to path items and matches methods and paths with any parameter names', async () => {
    const root = repository({
      'pom.xml': pom('mod-example'),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([
        [['GET', 'PUT', 'DELETE'], '/notes/{id}'],
        // A spec parameter documents any value of its segment; fixed spec segments document a parameter only in part.
        [['GET'], '/notes/types'],
        [['GET'], '/notes/{id}/links'],
        // Okapi's * matches across segments.
        [['POST'], '/notes*'],
        [['POST'], '/data-export/export'],
        [['GET'], '/legacy/items']
      ]),
      'src/main/resources/swagger.api/notes.yaml': [
        'openapi: 3.0.0',
        'paths:',
        '  /notes/{noteId}:',
        '    $ref: paths/note.yaml',
        '  /notes/{noteId}/attachments:',
        '    post: {}',
        '  /notes/default/links:',
        '    get: {}'
      ].join('\n'),
      // Two references in a row, the second with a JSON pointer into a shared file.
      'src/main/resources/swagger.api/paths/note.yaml': '$ref: "../shared/items.yaml#/note~1item"\n',
      'src/main/resources/swagger.api/shared/items.yaml': 'note/item:\n  get:\n    tags: [notes]\n  put: {}\n  parameters: []\n',
      // Paths are relative to the server URL's path, or to Swagger 2.0's basePath.
      'src/main/resources/swagger.api/export.yaml': 'openapi: 3.0.0\nservers:\n  - url: /data-export/\npaths:\n  /export:\n    post: {}\n',
      'src/main/resources/swagger.api/legacy.yaml': 'swagger: "2.0"\nbasePath: /legacy\npaths:\n  $ref: legacy-paths.yaml\n',
      'src/main/resources/swagger.api/legacy-paths.yaml': '/items:\n  get: {}\n'
    });

    const { result, analysis } = await b006(root);

    expect(documentation(analysis)).toEqual({
      'GET /notes/{id}': 'openapi',
      'PUT /notes/{id}': 'openapi',
      'DELETE /notes/{id}': 'undocumented',
      'GET /notes/types': 'openapi',
      'GET /notes/{id}/links': 'partial',
      'POST /notes*': 'openapi',
      'POST /data-export/export': 'openapi',
      'GET /legacy/items': 'openapi'
    });
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B006 fail: 1 of the 8 endpoints in the module descriptor is not documented in any API spec: DELETE /notes/{id}. '
      + '1 of the 8 endpoints in the module descriptor is documented only for fixed values of a path parameter: GET /notes/{id}/links.');
    expect(analysis.endpoints.find(endpoint => endpoint.method === 'PUT')?.specFiles).toEqual(['src/main/resources/swagger.api/notes.yaml']);
  });

  it('needs review, not a fail, when a path parameter is documented only for fixed values', async () => {
    const root = repository({
      'pom.xml': pom('mod-example'),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['POST'], '/jobs/{type}']]),
      'src/main/resources/api/jobs.yaml': 'openapi: 3.0.0\npaths:\n  /jobs/packageImport:\n    post: {}\n  /jobs/{jobId}:\n    get: {}\n'
    });

    const { result, analysis } = await b006(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.checklist.items).toEqual([expect.objectContaining({
      id: 'B006-C2', startingPoints: [{ path: 'src/main/resources/api/jobs.yaml', note: 'documents some paths only for fixed values of a parameter' }]
    })]);
  });

  it.each([
    ['a file that is not committed', 'paths/missing.yaml',
      'src/main/resources/api/paths/missing.yaml could not be read: it is not in the committed source the tool reads'],
    ['a URL', 'https://example.org/notes.yaml', 'it points outside the repository'],
    ['a path outside the repository', '../../../../../outside.yaml', 'it points outside the repository'],
    ['a missing JSON pointer', '#/components/pathItems/missing', 'src/main/resources/api/notes.json has nothing at /components/pathItems/missing'],
    ['a cycle', '#/components/pathItems/a', 'the references form a cycle'],
    ['a chain of 33 references', '#/components/pathItems/p0', 'more than 32 references in a row']
  ])('leaves an endpoint behind %s for the reviewer, neither documented nor undocumented', async (_name, reference, message) => {
    const chain = Object.fromEntries(Array.from({ length: 32 }, (_item, index) => [`p${index}`, { $ref: `#/components/pathItems/p${index + 1}` }]));
    const spec = {
      openapi: '3.1.0',
      paths: { '/notes': { $ref: reference }, '/tags': { get: {} } },
      components: { pathItems: { a: { $ref: '#/components/pathItems/b' }, b: { $ref: '#/components/pathItems/a' }, ...chain, p32: { get: {} } } }
    };
    const root = repository({
      'pom.xml': pom('mod-example'),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/notes'], [['GET'], '/tags']]),
      'src/main/resources/api/notes.json': JSON.stringify(spec)
    });

    const { result, analysis } = await b006(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(documentation(analysis)).toEqual({ 'GET /notes': 'unconfirmed', 'GET /tags': 'openapi' });
    expect(analysis.gaps).toEqual([{ file: 'src/main/resources/api/notes.json', apiPath: '/notes', reference: expect.any(String), message }]);
    expect(analysis.checklist.items.map(item => [item.id, item.startingPoints.map(point => point.path)]))
      .toEqual([['B006-C2', ['src/main/resources/api/notes.json']]]);
  });

  it('stops at YAML alias expansion instead of expanding an alias bomb', async () => {
    const levels = Array.from({ length: 12 }, (_level, index) => `l${index + 1}: &l${index + 1} [${Array(10).fill(`*l${index}`).join(', ')}]`);
    const root = repository({
      'pom.xml': pom('mod-example'),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/notes']]),
      'src/main/resources/api/notes.yaml': ['openapi: 3.0.0', 'x-bomb:', '  l0: &l0 x', ...levels.map(level => `  ${level}`), 'paths:', '  /notes:', '    get: {}'].join('\n')
    });

    const { result, analysis } = await b006(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.gaps).toEqual([{
      file: 'src/main/resources/api/notes.yaml',
      message: 'It could not be parsed: Excessive alias count indicates a resource exhaustion attack'
    }]);
  });

  it.each([
    ['a file it did not read', { 'src/main/resources/api/large.json': JSON.stringify({ data: 'x'.repeat(1100 * 1024) }) }, [],
      'the committed source was not read completely'],
    // mod-codex-mux builds its whole API from RAML in the raml-util submodule.
    ['a git submodule the build reads specs from', {}, ['ramls/raml-util'], 'the build reads API specs from a git submodule the tool does not read']
  ])('needs review, not a fail, when an endpoint may be documented in %s', async (_name, files, submodules, reason) => {
    const root = repository({
      'pom.xml': pom('mod-example', '<properties><ramlfiles_path>${basedir}/ramls/raml-util/ramls/codex</ramlfiles_path></properties>'),
      ...springApp,
      ...files,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/codex-instances']])
    });
    for (const submodule of submodules) git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD')},${submodule}`);
    if (submodules.length) git(root, 'commit', '-qm', 'submodule');

    const { result, analysis } = await b006(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe(`B006 manual: The endpoint in the module descriptor could not be checked, because ${reason}: GET /codex-instances. A reviewer must check it.`);
    expect(documentation(analysis)).toEqual({ 'GET /codex-instances': 'unconfirmed' });
  });

  it('reports a RAML resource that contains itself through a YAML alias instead of recursing', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/a'], [['GET'], '/a/b/b']]),
      'ramls/a.raml': '#%RAML 1.0\ntitle: A\n/a: &a\n  get: {}\n  /b: *a\n'
    });

    const { result, analysis } = await b006(root, true);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(documentation(analysis)).toEqual({ 'GET /a': 'raml', 'GET /a/b/b': 'unconfirmed' });
    expect(analysis.gaps).toEqual([{ file: 'ramls/a.raml', message: 'the resource /a/b contains itself' }]);
  });

  it('matches a wildcard handler in time linear in the spec path', async () => {
    const backend = (size: number) => repository({
      'pom.xml': pom('mod-example'),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], `/${'a*'.repeat(4)}b`]]),
      'src/main/resources/api/a.yaml': `openapi: 3.0.0\npaths:\n  /${'a'.repeat(size)}:\n    get: {}\n`
    });

    const analysis = await expectLinearTime(200, backend, async root => (await b006(root)).analysis);

    expect(analysis.endpoints[0].documentation).toBe('undocumented');
  }, 120_000);

  it('reads routes, constants, specs and build files in linear time', async () => {
    const edge = (size: number) => repository({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`
        + `<properties>${'<ramlDirs>ramls/x</ramlDirs>\n'.repeat(size)}</properties>`),
      'src/main/java/org/folio/edge/example/MainVerticle.java': [
        'class MainVerticle {',
        ...Array.from({ length: size }, (_route, index) => `  static final String P${index} = "/p${index}";\n  router.get(P${index}).handler(h);`),
        `  ${'router.get('.repeat(size)} ${'String s = "'.repeat(size)}`,
        '}'
      ].join('\n'),
      'src/main/resources/api/a.yaml': `openapi: 3.0.0\npaths:\n${Array.from({ length: size }, (_path, index) => `  /p${index}:\n    get: {}\n`).join('')}`,
      'ramls/a.raml': `#%RAML 1.0\ntitle: A\n${Array.from({ length: size }, (_path, index) => `/r${index}:\n  get: {}\n`).join('')}`
    });

    const analysis = await expectLinearTime(2_000, edge, async root => (await b006(root)).analysis);

    expect(analysis.endpoints.length).toBe(8_000);
    expect(new Set(analysis.endpoints.map(endpoint => endpoint.documentation))).toEqual(new Set(['openapi']));
    expect(analysis.unreadRouteCount).toBe(8_000);
    expect(analysis.unreadRoutes.length).toBe(100);
  }, 120_000);

  it('reads a file of router calls that are never closed in linear time', async () => {
    const edge = (size: number) => repository({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      'src/main/java/org/folio/edge/example/MainVerticle.java': `class MainVerticle { ${'router.get('.repeat(size)} }`
    });

    const analysis = await expectLinearTime(4_000, edge, async root => (await b006(root)).analysis);

    expect(analysis.unreadRouteCount).toBe(16_000);
  }, 120_000);

  it.each([
    ['RAML includes that repeat a file at every level', {
      'ramls/x.raml': '#%RAML 1.0\ntitle: X\n/a:\n  get: {}\n  /x: !include l0.raml\n',
      ...Object.fromEntries(Array.from({ length: 24 }, (_level, index) => [`ramls/l${index}.raml`, `get: {}\n/x: !include l${index + 1}.raml\n/y: !include l${index + 1}.raml\n`]))
    }, 'It has more than 20000 resources or 20000 operations; the rest were not read'],
    ['OpenAPI server paths and $ref chains', {
      'src/main/resources/api/a.json': JSON.stringify({
        openapi: '3.0.0',
        servers: Array.from({ length: 8 }, (_server, index) => ({ url: `/s${index}` })),
        paths: { '/a': { get: {} }, ...Object.fromEntries(Array.from({ length: 3000 }, (_path, index) => [`/p${index}`, { $ref: '#/components/pathItems/c0' }])) },
        components: { pathItems: Object.fromEntries(Array.from({ length: 33 }, (_hop, index) => [`c${index}`, {
          ...Object.fromEntries(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].map(method => [method, {}])),
          ...(index < 32 ? { $ref: `#/components/pathItems/c${index + 1}` } : {})
        }])) }
      })
    }, 'It has more than 20000 operations; the rest were not read']
  ])('stops reading a spec whose %s multiply into too many operations', async (_name, files, message) => {
    const root = repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/s0/a'], [['GET'], '/b']]),
      ...files
    });

    const { result, analysis } = await b006(root, true);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.gaps.filter(gap => !gap.apiPath)).toEqual([{ file: Object.keys(files)[0], message }]);
  });

  describe('a RAML-only module', () => {
    const raml = [
      '#%RAML 1.0',
      'title: Items',
      'baseUri: http://github.com/org/folio/mod-example',
      'resourceTypes:',
      '  collection: !include raml-util/rtypes/collection.raml',
      '  collection-item: !include raml-util/rtypes/item-collection.raml',
      '/item-storage:',
      '  /items:',
      '    type: { collection: { schemaCollection: items, schemaItem: item } }',
      '    get:',
      '      is: [pageable]',
      '    /{itemId}:',
      '      type: { collection-item: { schema: item } }'
    ].join('\n');
    // raml-util is FOLIO's shared RAML repository, included as a git submodule; its resource types give the methods.
    const handlers = descriptor([[['GET', 'POST'], '/item-storage/items'], [['GET', 'PUT', 'DELETE'], '/item-storage/items/{id}']]);

    it.each([
      ['an RMB module evaluated as a new module', pom('mod-example', restVerticleBuild), false, EvaluationStatus.FAIL,
        'B006 fail: All 5 endpoints in the module descriptor are documented only in RAML. A new module must document its endpoints in OpenAPI; '
        + 'an RMB module may keep RAML only when evaluated as an existing module (--existing-module).'],
      ['an RMB module evaluated as an existing module', pom('mod-example', restVerticleBuild), true, EvaluationStatus.PASS,
        'B006 pass: All 5 endpoints in the module descriptor are documented in RAML (ramls/items.raml). An RMB module may keep RAML when evaluated as an existing module.'],
      // RAML is allowed for RMB modules only (mod-circulation is plain Vert.x).
      ['a Vert.x module evaluated as an existing module', pom('mod-example'), true, EvaluationStatus.FAIL,
        'B006 fail: All 5 endpoints in the module descriptor are documented only in RAML. Only an RMB module may keep RAML, and the framework is Vert.x.']
    ])('decides %s', async (_name, pomXml, existingModule, status, evidence) => {
      const root = repository({
        'pom.xml': pomXml,
        'src/main/java/org/example/MainVerticle.java': 'public class MainVerticle extends AbstractVerticle {}\n',
        'descriptors/ModuleDescriptor-template.json': handlers,
        'ramls/items.raml': raml
      });

      const { result, analysis } = await b006(root, existingModule);

      expect(result.status).toBe(status);
      expect(result.evidence).toBe(evidence);
      expect(new Set(analysis.endpoints.map(endpoint => endpoint.documentation))).toEqual(new Set(['raml']));
    });

    it('leaves endpoints a library serves to the reviewer, and still fails on RAML in a new module', async () => {
      const root = repository({
        'pom.xml': pom('mod-example', `<dependencies>${dependency('folio-custom-fields')}</dependencies>${restVerticleBuild}`),
        'descriptors/ModuleDescriptor-template.json': descriptor(
          [[['GET', 'POST'], '/item-storage/items'], [['GET', 'PUT', 'DELETE'], '/item-storage/items/{id}']],
          [{ id: 'custom-fields', version: '3.0', handlers: [{ methods: ['GET'], pathPattern: '/custom-fields/{id}' }] }]
        ),
        'ramls/items.raml': raml
      });

      const existing = await b006(root, true);
      const fresh = await b006(root, false);

      expect(existing.result.status).toBe(EvaluationStatus.MANUAL);
      expect(existing.result.evidence).toBe('B006 manual: 1 of the 6 endpoints in the module descriptor comes from folio-custom-fields, '
        + 'whose own spec documents it: GET /custom-fields/{id}. A reviewer must check it.');
      expect(existing.analysis.checklist.items).toEqual([expect.objectContaining({
        id: 'B006-C1', startingPoints: [{ path: 'pom.xml', note: 'depends on folio-custom-fields' }]
      })]);
      expect(fresh.result.status).toBe(EvaluationStatus.FAIL);
    });
  });

  it('checks an edge module\'s router routes, with Vert.x parameters and constants, without the health check', async () => {
    const root = repository({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      'descriptors/ModuleDescriptor-template.json': '{"id": "${artifactId}-1.0.0", "provides": []}',
      'src/main/java/org/folio/edge/example/MainVerticle.java': [
        'public class MainVerticle extends EdgeVerticleHttp {',
        '  private static final String ACCOUNTS = "/example/accounts";',
        '  public Router defineRoutes() {',
        '    router.route(HttpMethod.GET, "/admin/health").handler(this::handleHealthCheck);',
        '    router.route(HttpMethod.GET, "/example/accounts/:accountId").handler(handler::get);',
        '    router.post(ACCOUNTS).handler(handler::post);',
        '    router.route(HttpMethod.PUT, paths.accountPath()).handler(handler::put);',
        '  }',
        '}'
      ].join('\n'),
      'src/main/resources/swagger.api/edge-example.yaml': 'openapi: 3.0.0\npaths:\n  /example/accounts/{id}:\n    get: {}\n'
    });

    const { result, analysis } = await b006(root);

    expect(documentation(analysis)).toEqual({ 'GET /example/accounts/{accountId}': 'openapi', 'POST /example/accounts': 'undocumented' });
    expect(analysis.unreadRoutes).toEqual([{ file: 'src/main/java/org/folio/edge/example/MainVerticle.java', line: 7 }]);
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B006 fail: 1 of the 2 endpoints routed by the edge module is not documented in any API spec: POST /example/accounts. '
      + '1 router route has a path the tool could not read.');
    expect(result.details?.split('\n')).toEqual([
      'Evaluated as: a new module (the default)',
      'Framework: edge module; RAML does not count as documentation',
      'Endpoints: 2 methods and paths from router routes in src/main',
      'API specs:',
      '  - src/main/resources/swagger.api/edge-example.yaml — OpenAPI 3.0.0, 1 operation',
      'Not documented in any API spec:',
      '  - POST /example/accounts (src/main/java/org/folio/edge/example/MainVerticle.java:6)',
      'Documented: 1 in OpenAPI',
      'Router routes the tool could not read:',
      '  - src/main/java/org/folio/edge/example/MainVerticle.java:7',
      'What to do:',
      '  - Document each endpoint listed above in an OpenAPI spec in the repository.',
      'Checklist for the reviewer:',
      '  - B006-C2 Each endpoint the tool could not check is documented in an OpenAPI spec.',
      '    - Start with:',
      '      - src/main/java/org/folio/edge/example/MainVerticle.java:7 — router route whose path the tool could not read'
    ]);
  });

  it.each([
    ['a shared library', { 'pom.xml': pom('folio-spring-base') }, EvaluationStatus.NOT_APPLICABLE, 'library'],
    ['a repository that is neither a module nor a known library', { 'pom.xml': pom('mod-example') }, EvaluationStatus.MANUAL, 'no-descriptor'],
    ['a module that provides only system interfaces', { 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': descriptor([]) },
      EvaluationStatus.NOT_APPLICABLE, 'no-endpoints'],
    ['a module with no spec', { 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/notes']]) },
      EvaluationStatus.FAIL, 'endpoints-checked']
  ])('decides %s', async (_name, files, status, basis) => {
    const { result, analysis } = await b006(repository({ ...files, ...springApp }));

    expect(result.status).toBe(status);
    expect(analysis.basis).toBe(basis);
  });
});
