import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B003Analysis, EvaluationStatus } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b003(root: string) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
  const result = await new BackendEvaluator().evaluateCriterion('B003', root, run);
  return { result, analysis: result.criterionDetails as B003Analysis };
}

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

const implementations = (analysis: B003Analysis) =>
  Object.fromEntries(analysis.endpoints.map(endpoint => [`${endpoint.method} ${endpoint.path}`, endpoint.implementation]));

const springApp = { 'src/main/java/org/example/Application.java': '@SpringBootApplication\npublic class Application {}\n' };
const vertxApp = { 'src/main/java/org/example/MainVerticle.java': 'public class MainVerticle extends AbstractVerticle {}\n' };
const useTags = (value: boolean) => pom('mod-example', `<build><plugins><plugin><artifactId>openapi-generator-maven-plugin</artifactId><configuration><configOptions><useTags>${value}</useTags></configOptions></configuration></plugin></plugins></build>`);

describe('B003 endpoint implementations', () => {
  it('names the interface RMB generates after the top-level RAML resource, and fails on an endpoint in no spec', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      'descriptors/ModuleDescriptor-template.json': descriptor([
        [['GET', 'POST'], '/loan-storage/loans'],
        [['GET'], '/loan-storage/loans/{id}'],
        [['POST'], '/check-in-storage/check-ins'],
        [['GET'], '/request-storage/requests'],
        [['DELETE'], '/loan-storage/loans/{id}']
      ]),
      'ramls/loan-storage.raml': '#%RAML 1.0\ntitle: Loans\n/loan-storage:\n  /loans:\n    get:\n    post:\n    /{loanId}:\n      get:\n',
      'ramls/check-in.raml': '#%RAML 1.0\ntitle: Check-ins\n/check-in-storage/check-ins:\n  post:\n',
      'ramls/requests.raml': '#%RAML 1.0\ntitle: Requests\n/request-storage:\n  /requests:\n    get:\n',
      'src/main/java/org/folio/rest/impl/LoansAPI.java': [
        'public class LoansAPI extends BaseApi<Loan, Map<String, List<Loan>>>',
        '  implements Comparable<Map<String, Loan>>, org.folio.rest.jaxrs.resource.LoanStorage {',
        '}'
      ].join('\n'),
      'src/main/java/org/folio/rest/impl/CheckInAPI.java': 'public class CheckInAPI implements CheckInStorageCheckIns {}\n',
      'src/main/java/org/folio/rest/impl/RequestsAPI.java': '// public class RequestsAPI implements RequestStorage {\n/* class Old implements RequestStorage { */\nclass RequestsAPI {}\n',
      'src/main/java/org/folio/rest/support/RequestsAPI.java': 'public class RequestsAPI implements RequestStorage {}\n'
    });

    const { result, analysis } = await b003(root);

    expect(implementations(analysis)).toEqual({
      'GET /loan-storage/loans': 'interface',
      'POST /loan-storage/loans': 'interface',
      'GET /loan-storage/loans/{id}': 'interface',
      'POST /check-in-storage/check-ins': 'interface',
      'GET /request-storage/requests': 'no-implementing-class',
      'DELETE /loan-storage/loans/{id}': 'not-found'
    });
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B003 fail: 1 of the 6 endpoints in the module descriptor is in no API spec, and no route in the source serves it: DELETE /loan-storage/loans/{id}. '
      + 'A RAML Module Builder (RMB) module serves only the endpoints its API spec generates, so it has no implementation. '
      + '1 of the 6 endpoints in the module descriptor is in an API spec, but the tool found no committed class that implements it through the interface the build generates: GET /request-storage/requests.');
    expect(result.details?.split('\n')).toEqual([
      'Framework: RAML Module Builder (RMB)',
      'Endpoints: 6 methods and paths from handlers in descriptors/ModuleDescriptor-template.json, without system interfaces',
      'Implementations: committed classes in org.folio.rest.impl that implement the interface RMB generates for each top-level RAML resource (for example, LoanStorage for /loan-storage), '
        + 'or routes registered in the source (Vert.x router, RouteRegistration, Spring mapping annotations, Grails URL mappings)',
      'Routes found in the source: 0',
      'In no API spec and served by no route:',
      '  - DELETE /loan-storage/loans/{id} (interface example)',
      'In an API spec, but no committed class implements it through its generated interface:',
      '  - GET /request-storage/requests (interface example) — RequestStorage in ramls/requests.raml',
      'Implemented: 4 by classes implementing generated interfaces',
      'What to do:',
      '  - Implement each endpoint listed under "In no API spec and served by no route", or remove its handler from the module descriptor.',
      'Checklist for the reviewer:',
      '  - B003-C1 Each endpoint the tool could not match has an implementation that serves its methods.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json — DELETE /loan-storage/loans/{id}: in no API spec and no route',
      '      - ramls/requests.raml — GET /request-storage/requests: no committed class implements it through RequestStorage'
    ]);
    expect(analysis.endpoints.find(endpoint => endpoint.path === '/loan-storage/loans/{id}')).toMatchObject({
      generatedInterfaces: ['LoanStorage'], implementedBy: [{ file: 'src/main/java/org/folio/rest/impl/LoansAPI.java', line: 2 }]
    });
  });

  it.each([
    [true, 'NotesApi', 'interface'],
    [false, 'NoteLinksApi', 'interface'],
    [false, 'NotesApi', 'no-implementing-class']
  ])('names the Spring interface after the tag when useTags is %s, else after the spec path\'s first segment (%s: %s)', async (tags, implemented, implementation) => {
    const root = repository({
      'pom.xml': useTags(tags),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/notes-api/note-links/type/{type}']]),
      'src/main/resources/swagger.api/notes.yaml': 'openapi: 3.0.0\nservers:\n  - url: /notes-api\npaths:\n  /note-links/type/{objectType}:\n    get:\n      operationId: getNoteLinks\n      tags: [notes]\n',
      'src/main/java/org/example/NotesController.java': `@RestController\n@RequestMapping("/")\npublic class NotesController implements ${implemented} {\n  public ResponseEntity<NoteLinks> getNoteLinks(String type) { return null; }\n}\n`
    });

    expect(implementations((await b003(root)).analysis)).toEqual({ 'GET /notes-api/note-links/type/{type}': implementation });
  });

  it.each([
    [false, { 'GET /items': 'interface', 'DELETE /items': 'no-implementing-class' }],
    [true, { 'GET /items': 'interface', 'DELETE /items': 'interface' }]
  ])('requires a Spring class to declare each operation unless skipDefaultInterface is %s', async (skip, expected) => {
    const root = repository({
      'pom.xml': pom('mod-example', `<build><plugins><plugin><configuration><configOptions><useTags>true</useTags><skipDefaultInterface>${skip}</skipDefaultInterface></configOptions></configuration></plugin></plugins></build>`),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET', 'DELETE'], '/items']]),
      'src/main/resources/swagger.api/items.yaml': 'openapi: 3.0.0\npaths:\n  /items:\n    get:\n      operationId: getItems\n      tags: [items]\n    delete:\n      operationId: deleteItems\n      tags: [items]\n',
      'src/main/java/org/example/ItemsController.java': 'public class ItemsController implements ItemsApi {\n  // deleteItems() is not overridden\n  public ResponseEntity<Items> getItems() { return null; }\n}\n'
    });

    expect(implementations((await b003(root)).analysis)).toEqual(expected);
  });

  it.each([
    ['a property placeholder in the class-level path', '@RequestMapping("${api.base:}")\npublic class C {\n  @GetMapping("/items") void items() {}\n}\n'],
    ['a second type in the file', '@RequestMapping("/a")\npublic class C {\n  static class D {\n    @GetMapping("/items") void items() {}\n  }\n}\n'],
    ['an interface a controller elsewhere implements under its own prefix', 'public interface C {\n  @GetMapping("/items") void items();\n}\n'],
    ['a constant of another class', 'public class C {\n  static final String ITEMS = "/items";\n  @GetMapping(Paths.ITEMS) void items() {}\n}\n']
  ])('leaves a Spring mapping with %s to the reviewer instead of reading its path', async (_name, source) => {
    const root = repository({
      'pom.xml': useTags(true),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/items']]),
      'src/main/java/org/example/C.java': source
    });

    const { result, analysis } = await b003(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(implementations(analysis)).toEqual({ 'GET /items': 'unconfirmed' });
  });

  it('reads Spring mapping annotations under a class-level prefix, with their methods', async () => {
    const root = repository({
      'pom.xml': useTags(true),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([
        [['GET'], '/api/items'], [['GET'], '/items'], [['PUT'], '/api/a'], [['PUT'], '/api/b/{id}'], [['GET'], '/api/a'], [['DELETE'], '/api']
      ]),
      'src/main/java/org/example/ItemsController.java': [
        '@RestController',
        '@RequestMapping("/api/")',
        '@SuppressWarnings({"unchecked", "rawtypes"})',
        'public class ItemsController {',
        '  private static final String B = "b/{itemId}";',
        '  @GetMapping(value = "/items", produces = "application/json")',
        '  public List<Item> items() { return List.of(); }',
        '  @RequestMapping(path = {"/a", B}, method = {RequestMethod.PUT})',
        '  public void put() {}',
        '  @DeleteMapping',
        '  public void delete() {}',
        '}'
      ].join('\n'),
      'src/main/java/org/example/ItemsClient.java': '@FeignClient("items")\n@RequestMapping("/")\npublic interface ItemsClient {\n  @GetMapping("/items")\n  List<Item> items();\n}\n'
    });

    const { result, analysis } = await b003(root);

    expect(implementations(analysis)).toEqual({
      'GET /api/items': 'route',
      'GET /items': 'not-found',
      'PUT /api/a': 'route',
      'PUT /api/b/{id}': 'route',
      'GET /api/a': 'not-found',
      'DELETE /api': 'route'
    });
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(analysis.endpoints[0].implementedBy).toEqual([{ file: 'src/main/java/org/example/ItemsController.java', line: 6 }]);
  });

  it.each([
    ['an RMB endpoint in no spec', pom('mod-example', restVerticleBuild), {}, EvaluationStatus.FAIL, 'not-found'],
    ['an RMB endpoint in no spec with a route the tool cannot read', pom('mod-example', restVerticleBuild),
      { 'src/main/java/org/example/Routes.java': 'class Routes { void r(Router router) { router.get(paths.items()).handler(h); } }\n' }, EvaluationStatus.MANUAL, 'unconfirmed'],
    ['an RMB endpoint in no spec with a committed source file the tool did not read', pom('mod-example', restVerticleBuild),
      { 'src/main/resources/large.json': JSON.stringify({ data: 'x'.repeat(1100 * 1024) }) }, EvaluationStatus.MANUAL, 'unconfirmed'],
    ['a Vert.x endpoint in no spec and no route', pom('mod-example'), vertxApp, EvaluationStatus.MANUAL, 'not-found'],
    ['an RMB endpoint whose RAML interface no class implements', pom('mod-example', restVerticleBuild),
      { 'ramls/items.raml': '#%RAML 1.0\ntitle: Items\n/items:\n  get:\n' }, EvaluationStatus.MANUAL, 'no-implementing-class'],
    ['an RMB endpoint whose RAML file could not be parsed', pom('mod-example', restVerticleBuild),
      { 'ramls/items.raml': '#%RAML 1.0\ntitle: Items\n/items:\n  get: [\n' }, EvaluationStatus.MANUAL, 'unconfirmed'],
    ['an RMB endpoint in RAML that a router route serves although no class implements its interface', pom('mod-example', restVerticleBuild), {
      'ramls/items.raml': '#%RAML 1.0\ntitle: Items\n/items:\n  get:\n',
      'src/main/java/org/example/Routes.java': 'class Routes { void r(Router router) { router.get("/items").handler(h); } }\n'
    }, EvaluationStatus.PASS, 'route']
  ])('decides %s', async (_name, pomXml, files, status, implementation) => {
    const root = repository({ 'pom.xml': pomXml, ...files, 'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/items']]) });

    const { result, analysis } = await b003(root);

    expect(result.status).toBe(status);
    expect(implementations(analysis)).toEqual({ 'GET /items': implementation });
  });

  it('needs review, not a fail, when a path parameter is in the spec only for fixed values', async () => {
    const root = repository({
      'pom.xml': useTags(true),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['POST'], '/jobs/{type}']]),
      'src/main/resources/api/jobs.yaml': 'openapi: 3.0.0\npaths:\n  /jobs/packageImport:\n    post:\n      tags: [jobs]\n'
    });

    const { result, analysis } = await b003(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(implementations(analysis)).toEqual({ 'POST /jobs/{type}': 'partial' });
    expect(analysis.checklist.items[0].startingPoints).toEqual([{ path: 'src/main/resources/api/jobs.yaml', note: 'POST /jobs/{type}: found only for fixed values of a path parameter' }]);
  });

  it('gives the reasons that apply to each endpoint it could not check', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/other']]),
      'src/main/resources/api/notes.yaml': 'openapi: 3.0.0\npaths:\n  /notes:\n    $ref: missing.yaml\n',
      'src/main/java/org/example/Routes.java': 'class Routes { void r(Router router) { router.get(paths.items()).handler(h); } }\n'
    });

    const { result } = await b003(root);

    expect(result.evidence).toBe('B003 manual: The endpoint in the module descriptor could not be checked, because the tool could not read 1 route in the source: GET /other. A reviewer must check it.');
  });

  it('leaves a wildcard handler to the reviewer, even when every other endpoint is implemented and the spec has no path under it', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/groups'], [['POST'], '/groups/{id}*'], [['GET'], '/other*']]),
      'ramls/groups.raml': '#%RAML 1.0\ntitle: Groups\n/groups:\n  get:\n  /{groupId}:\n    post:\n',
      'src/main/java/org/folio/rest/impl/GroupsAPI.java': 'public class GroupsAPI implements Groups {}\n'
    });

    const { result, analysis } = await b003(root);

    expect(implementations(analysis)).toEqual({ 'GET /groups': 'interface', 'POST /groups/{id}*': 'wildcard', 'GET /other*': 'wildcard' });
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B003 manual: 2 of the 3 endpoints in the module descriptor have wildcard paths, which the tool cannot match to an implementation: '
      + 'POST /groups/{id}* and GET /other*. A reviewer must check them.');
  });

  it('reads mod-circulation\'s RouteRegistration, chained or through a variable, and skips its own router calls', async () => {
    const root = repository({
      'pom.xml': pom('mod-example'),
      ...vertxApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([
        [['GET', 'DELETE'], '/circulation/loans'], [['GET', 'PUT'], '/circulation/loans/{id}'], [['POST'], '/circulation/loans/{id}/change-due-date'],
        [['POST', 'GET'], '/a'], [['GET', 'POST'], '/b']
      ]),
      'src/main/java/org/example/support/RouteRegistration.java': [
        'public class RouteRegistration {',
        '  public void get(Handler<RoutingContext> handler) { router.route(HttpMethod.GET, rootPath + "/:id").handler(handler); }',
        '}'
      ].join('\n'),
      'src/main/java/org/example/LoansResource.java': [
        'public class LoansResource {',
        '  private static final String ROOT = "/circulation/loans";',
        '  public void register(Router router) {',
        '    RouteRegistration routeRegistration = new RouteRegistration(ROOT, router);',
        '    routeRegistration.getMany(this::getMany);',
        '    routeRegistration.get(this::get);',
        '    new RouteRegistration("/circulation/loans/:id/change-due-date", router)',
        '      .create(this::changeDueDate);',
        '    RouteRegistration r = new RouteRegistration("/a", router);',
        '    r.create(this::a);',
        '    r = new RouteRegistration("/b", router);',
        '    r.getMany(this::b);',
        '    router.put("/circulation/loans/*").handler(BodyHandler.create());',
        '    register(new RouteRegistration("/c", router));',
        '  }',
        '}'
      ].join('\n')
    });

    const { result, analysis } = await b003(root);

    expect(implementations(analysis)).toEqual({
      'GET /circulation/loans': 'route',
      'DELETE /circulation/loans': 'unconfirmed',
      'GET /circulation/loans/{id}': 'route',
      'PUT /circulation/loans/{id}': 'unconfirmed',
      'POST /circulation/loans/{id}/change-due-date': 'route',
      'POST /a': 'route',
      'GET /a': 'unconfirmed',
      'GET /b': 'route',
      'POST /b': 'unconfirmed'
    });
    expect(analysis.unreadRoutes).toEqual([{ file: 'src/main/java/org/example/LoansResource.java', line: 14 }]);
    expect(result.status).toBe(EvaluationStatus.MANUAL);
  });

  it('reads Grails URL mappings, with RESTful resources, collections, groups and optional variables', async () => {
    const root = repository({
      'service/build.gradle': 'apply plugin: "org.grails.grails-web"\n',
      'service/src/main/okapi/ModuleDescriptor-template.json': descriptor([
        [['GET', 'POST'], '/erm/sas'], [['GET', 'PUT', 'DELETE'], '/erm/sas/{id}'], [['GET'], '/erm/sas/{id}/resources'], [['GET'], '/erm/sas/{id}/resources/{format}'],
        [['POST', 'DELETE'], '/erm/sas/publicLookup'], [['GET'], '/erm/statistics/kbCount'], [['GET'], '/erm/statistics/{name}'], [['GET'], '/erm/hidden'], [['GET'], '/']
      ]),
      'service/grails-app/controllers/org/example/UrlMappings.groovy': [
        'package org.example',
        'class UrlMappings {',
        '  static mappings = {',
        '    Closure extra = Helper.buildRoutes("/erm", [[path: \'/x\', controller: \'x\']])',
        '    "/"(controller: \'application\', action: \'index\')',
        '    "404"(view: \'/notFound\')',
        '    \'/erm/sas\'(resources: \'subscriptionAgreement\', excludes: [\'delete\', \'patch\']) {',
        '      "/resources/$format?"(action: \'resources\', method: \'GET\')',
        '      collection {',
        '        \'/publicLookup\' {',
        '          controller = \'subscriptionAgreement\'',
        '          method = \'POST\'',
        '          filters = { "owner==${params.id}" }',
        '        }',
        '      }',
        '    }',
        '    group \'/erm/statistics\', {',
        '      \'/kbCount\'(controller: \'statistics\', method: \'GET\')',
        '    }',
        '    // "/erm/hidden"(controller: \'hidden\')',
        '  }',
        '}'
      ].join('\n')
    });

    const { result, analysis } = await b003(root);

    expect(implementations(analysis)).toEqual({
      'GET /erm/sas': 'route',
      'POST /erm/sas': 'route',
      'GET /erm/sas/{id}': 'route',
      'PUT /erm/sas/{id}': 'route',
      'DELETE /erm/sas/{id}': 'unconfirmed',
      'GET /erm/sas/{id}/resources': 'route',
      'GET /erm/sas/{id}/resources/{format}': 'route',
      'POST /erm/sas/publicLookup': 'route',
      'DELETE /erm/sas/publicLookup': 'unconfirmed',
      'GET /erm/statistics/kbCount': 'route',
      'GET /erm/statistics/{name}': 'unconfirmed',
      'GET /erm/hidden': 'unconfirmed',
      'GET /': 'route'
    });
    expect(analysis.unreadRoutes).toEqual([{ file: 'service/grails-app/controllers/org/example/UrlMappings.groovy', line: 4 }]);
    expect(result.status).toBe(EvaluationStatus.MANUAL);
  });

  it.each([
    ['a method that is not a string', '"/books"(controller: \'book\', method: HttpMethod.POST)'],
    ['a method assigned from a variable', '\'/books\' {\n      controller = \'book\'\n      method = POST\n    }'],
    ['an action variable', '"/books/$action"(controller: \'book\')'],
    ['a controller variable', '"/$controller/$action?/$id?"()']
  ])('leaves a Grails mapping with %s to the reviewer', async (_name, mapping) => {
    const root = repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': descriptor([[['GET'], '/books/list']]),
      'service/grails-app/controllers/UrlMappings.groovy': `class UrlMappings {\n  static mappings = {\n    ${mapping}\n  }\n}\n`
    });

    const { result, analysis } = await b003(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(implementations(analysis)).toEqual({ 'GET /books/list': 'unconfirmed' });
  });

  it('checks an edge module\'s documented operations against its router routes', async () => {
    const files = {
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      'descriptors/ModuleDescriptor-template.json': '{"id": "${artifactId}-1.0.0", "provides": []}',
      'src/main/java/org/folio/edge/example/MainVerticle.java': [
        'public class MainVerticle extends EdgeVerticleHttp {',
        '  public Router defineRoutes() {',
        '    router.route(HttpMethod.GET, "/example/accounts/:accountId").handler(handler::get);',
        '  }',
        '}'
      ].join('\n')
    };
    const documented = repository({ ...files, 'src/main/resources/swagger.api/edge-example.yaml': 'openapi: 3.0.0\npaths:\n  /example/accounts/{id}:\n    get: {}\n    put: {}\n' });

    const { result, analysis } = await b003(documented);
    const undocumented = await b003(repository(files));

    expect(implementations(analysis)).toEqual({ 'GET /example/accounts/{id}': 'route', 'PUT /example/accounts/{id}': 'not-found' });
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B003 manual: 1 of the 2 endpoints the edge module provides or documents is in an API spec, but no route in the source serves it: '
      + 'PUT /example/accounts/{id}. A reviewer must check it.');
    expect(undocumented.result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(undocumented.analysis.basis).toBe('no-endpoints');
  });

  it.each([
    ['a shared library', { 'pom.xml': pom('folio-spring-base') }, EvaluationStatus.NOT_APPLICABLE, 'library'],
    ['a repository that is neither a module nor a known library', { 'pom.xml': pom('mod-example') }, EvaluationStatus.MANUAL, 'no-descriptor'],
    ['a module that provides only system interfaces', { 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': descriptor([]) },
      EvaluationStatus.NOT_APPLICABLE, 'no-endpoints']
  ])('decides %s', async (_name, files, status, basis) => {
    const { result, analysis } = await b003(repository({ ...files, ...springApp }));

    expect(result.status).toBe(status);
    expect(analysis.basis).toBe(basis);
  });

  it('leaves endpoints a library serves to the reviewer', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('folio-custom-fields')}</dependencies>${restVerticleBuild}`),
      'descriptors/ModuleDescriptor-template.json': descriptor([], [{ id: 'custom-fields', version: '3.0', handlers: [{ methods: ['GET'], pathPattern: '/custom-fields/{id}' }] }])
    });

    const { result, analysis } = await b003(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B003 manual: The endpoint in the module descriptor comes from folio-custom-fields, which implements it: GET /custom-fields/{id}. A reviewer must check it.');
    expect(analysis.checklist.items[0].startingPoints).toEqual([{ path: 'pom.xml', note: 'GET /custom-fields/{id}: served by folio-custom-fields' }]);
  });

  it('reads implemented interfaces, Spring mappings and RouteRegistration in linear time', async () => {
    const backend = (size: number) => repository({
      'pom.xml': useTags(true),
      ...springApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['GET'], '/p0']]),
      'src/main/resources/api/many.yaml': 'openapi: 3.0.0\npaths:\n  /p0:\n    get:\n      operationId: m0\n      tags: [many]\n',
      'src/main/java/org/example/Many.java': [
        '@RequestMapping("/")',
        'public class Many implements ManyApi, B<C<D, E>> {',
        ...Array.from({ length: size }, (_item, index) => [
          `  @GetMapping("/p${index}") void m${index}() {}`,
          `  void r${index}() { RouteRegistration r = new RouteRegistration("/r${index}", router); r.create(h); }`,
          `  String s${index} = "// not a comment"; /* ${index} */`
        ].join('\n')),
        '}'
      ].join('\n'),
      'src/main/java/org/example/Implementations.java': Array.from({ length: size }, (_item, index) => `class C${index} implements I${index}, J<K<L, M>> { void i${index}() {} }\n`).join(''),
      'src/main/java/org/example/Unclosed.java': `${'@GetMapping('.repeat(size)} ${'new RouteRegistration('.repeat(size)} ${'implements '.repeat(size)} ${'@PostMapping '.repeat(size)} "${'x'.repeat(size)} /* ${'y'.repeat(size)}`
    });

    const { analysis } = await expectLinearTime(1_000, backend, root => b003(root));

    expect(analysis.routeCount).toBe(8_000);
    expect(implementations(analysis)).toEqual({ 'GET /p0': 'interface' });
  }, 120_000);

  it('pairs RouteRegistration variables with their calls in linear time', async () => {
    const vertx = (size: number) => repository({
      'pom.xml': pom('mod-example'),
      ...vertxApp,
      'descriptors/ModuleDescriptor-template.json': descriptor([[['POST'], '/r0']]),
      'src/main/java/org/example/Routes.java': `class Routes {\n${'RouteRegistration r=new RouteRegistration("/r0",x);r.create(h);\n'.repeat(size)}}\n`
    });

    const { analysis } = await expectLinearTime(4_000, vertx, root => b003(root));

    expect(analysis.routeCount).toBe(16_000);
  }, 120_000);

  it('reads Grails URL mappings in linear time, including deep and unclosed nesting', async () => {
    const grails = (size: number) => repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': descriptor([[['GET'], '/m0']]),
      'service/grails-app/controllers/UrlMappings.groovy': [
        'class UrlMappings {',
        '  static mappings = {',
        ...Array.from({ length: size }, (_item, index) => `    "/m${index}"(resources: 'm${index}', excludes: ['a', 'b']) { collection { '/c'(method: 'GET') } }`),
        ...Array.from({ length: size }, (_item, index) => `    '/q${index}' { method = GET }`),
        `    "/o${'/$v?'.repeat(size)}"(controller: 'o')`,
        `    ${'\'/n\' { '.repeat(size)}`,
        `    ${'x('.repeat(size)}`,
        `    ${'"/u"('.repeat(size)}`,
        '  }',
        '}'
      ].join('\n')
    });

    const { analysis } = await expectLinearTime(1_000, grails, root => b003(root));

    expect(implementations(analysis)).toEqual({ 'GET /m0': 'route' });
  }, 120_000);
});
