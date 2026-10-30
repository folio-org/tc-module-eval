import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B002Analysis, EvaluationStatus } from '../types';
import { evaluateB002 } from '../utils/b002-consumed-apis';
import { getBackendEvidence } from '../utils/backend-evidence';
import { outboundRequests } from '../utils/backend-outbound-calls';
import { createEvaluationRun } from '../utils/evaluation-run';
import { loadF001HandlerIndex, mapRequestPath } from '../utils/f001-consumed-apis';
import { dependency, pom, repository } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b002(files: Record<string, string>) {
  const root = repository(files);
  const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
  const result = await new BackendEvaluator().evaluateCriterion('B002', root, run);
  return { result, analysis: result.criterionDetails as B002Analysis, root };
}

type Handler = [string[], string];

function template(requires: string[], options: { optional?: string[]; provides?: Array<{ id: string; interfaceType?: string; handlers: Handler[] }> } = {}): string {
  const entries = (ids: string[]) => ids.map(id => ({ id, version: '1.0' }));
  return JSON.stringify({
    id: '${artifactId}-1.0.0',
    provides: (options.provides ?? []).map(provided => ({
      id: provided.id, version: '1.0', ...(provided.interfaceType ? { interfaceType: provided.interfaceType } : {}),
      handlers: provided.handlers.map(([methods, pathPattern]) => ({ methods, pathPattern }))
    })),
    requires: entries(requires),
    ...(options.optional ? { optional: entries(options.optional) } : {})
  });
}

const backendModule = (descriptor: string, sources: Record<string, string>, pomBody = '') => ({
  'pom.xml': pom('mod-example', pomBody),
  'descriptors/ModuleDescriptor-template.json': descriptor,
  ...sources
});

const JAVA = 'src/main/java/org/folio/example';

const springClients = {
  [`${JAVA}/client/UsersClient.java`]: [
    'package org.folio.example.client;',
    '',
    '@HttpExchange(url = "users", contentType = MediaType.APPLICATION_JSON_VALUE)',
    'public interface UsersClient {',
    '  @GetExchange(value = "/{id}", accept = {MediaType.APPLICATION_JSON_VALUE, MediaType.TEXT_PLAIN_VALUE})',
    '  User getUser(@PathVariable("id") String id);',
    '}'
  ].join('\n'),
  [`${JAVA}/client/ConsortiaClient.java`]: [
    'package org.folio.example.client;',
    '',
    '@HttpExchange("consortia")',
    'public interface ConsortiaClient {',
    '  @GetExchange("{consortiumId}/tenants")',
    '  Tenants getTenants(@PathVariable String consortiumId);',
    '}'
  ].join('\n')
};

describe('B002 consumed APIs declared in requires or optional', () => {
  it('passes when Spring client paths, joined to their type\'s path, go to declared interfaces', async () => {
    const { result, analysis } = await b002(backendModule(template(['users'], { optional: ['consortia', 'notes'] }), springClients));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B002 pass: Every request the tool found in the module\'s code goes to an interface its descriptor declares in requires or optional (2 requests to 2 interfaces).');
    expect(result.details?.split('\n')).toEqual([
      'What the tool found:',
      '  - Requests: 2 requests in production code (Spring HTTP clients 2, paths in code 0); 2 mapped to an interface',
      '  - Declared interfaces: 1 in requires and 2 in optional of descriptors/ModuleDescriptor-template.json',
      '  - Declared and used: consortia, users',
      '  - Declared but not seen (not a problem): notes',
      '  - Handler index: interface paths of R1-2026.27 (platform-lsp 0a70fd2), 413 interfaces',
      '  - Production source: 2 Java or Groovy files under src/main and grails-app'
    ]);
    expect(analysis.declaredAndUsed.map(use => use.sites.map(site => [site.method, site.requestPath, site.pathPattern, site.line]))).toEqual([
      [['GET', 'consortia/{}/tenants', '/consortia/{consortiumId}/tenants', 5]],
      [['GET', 'users/{}', '/users/{id}', 5]]
    ]);
    expect(analysis.checklist.items).toEqual([]);
  });

  it('leaves an interface the code calls but the descriptor does not declare to the reviewer instead of failing (Q3)', async () => {
    const { result, analysis } = await b002(backendModule(template(['users']), {
      [`${JAVA}/client/ConfigurationClient.java`]: [
        'package org.folio.example.client;',
        '',
        'public class ConfigurationClient {',
        '  private static final String CONFIGURATION_ENTRIES_PATH = "/configurations/entries";',
        '  private static final String UNUSED_PATH = "/not-an-interface";',
        '',
        '  public Future<JsonObject> entries(VertxOkapiHttpClient client) {',
        '    return client.get(CONFIGURATION_ENTRIES_PATH, Map.of("query", "module==USERS"), headers);',
        '  }',
        '',
        '  public Future<JsonObject> entry(VertxOkapiHttpClient client, String id) {',
        '    return client.get(CONFIGURATION_ENTRIES_PATH + "/" + id, Map.of(), headers);',
        '  }',
        '}'
      ].join('\n')
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B002 manual: The module sends requests to 1 interface its descriptor declares in neither requires nor optional: '
      + 'configuration (/configurations/entries at src/main/java/org/folio/example/client/ConfigurationClient.java:8). '
      + 'This is not a fail: a reviewer must check that each request is made, and if so declare its interface.');
    expect(result.details?.split('\n')).toEqual([
      'What the tool found:',
      '  - Requests: 2 requests in production code (Spring HTTP clients 0, paths in code 2); 2 mapped to an interface',
      '  - Declared interfaces: 1 in requires and 0 in optional of descriptors/ModuleDescriptor-template.json',
      '  - Declared but not seen (not a problem): users',
      '  - Handler index: interface paths of R1-2026.27 (platform-lsp 0a70fd2), 413 interfaces',
      '  - Production source: 1 Java or Groovy file under src/main and grails-app',
      'Used but not declared:',
      '  - configuration:',
      '    - src/main/java/org/folio/example/client/ConfigurationClient.java:8 — requests /configurations/entries',
      '    - src/main/java/org/folio/example/client/ConfigurationClient.java:12 — requests /configurations/entries/{}',
      'What to do:',
      '  - Add each interface under "Used but not declared" to requires, or to optional when the module works without it, unless the code that sends the request never runs.',
      'Checklist for the reviewer:',
      '  - B002-C1 Each interface under "Used but not declared" is called from code that runs, and is declared in requires, or in optional when the module works without it.',
      '    - Start with:',
      '      - src/main/java/org/folio/example/client/ConfigurationClient.java:8 — configuration: /configurations/entries',
      '      - src/main/java/org/folio/example/client/ConfigurationClient.java:12 — configuration: /configurations/entries/{}',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
    expect(analysis.checklist.items[0].obligations).toEqual([
      { id: 'B002-C1#1', subject: 'interface configuration', path: 'src/main/java/org/folio/example/client/ConfigurationClient.java', line: 8, flag: 'manual' }
    ]);
  });

  it('counts a client built for a path even when nothing calls it, so the reviewer checks whether it is used', async () => {
    const { result, analysis } = await b002(backendModule(template(['users']), {
      [`${JAVA}/support/Clients.java`]: [
        'package org.folio.example.support;',
        '',
        'public class Clients {',
        '  private static CollectionResourceClient createConfigurationStorageClient(OkapiHttpClient client, WebContext context) {',
        '    return getCollectionResourceClient(client, context,',
        '      "/configurations/entries");',
        '  }',
        '',
        '  private static CollectionResourceClient createAutomatedPatronBlocksClient(OkapiHttpClient client, WebContext context) {',
        '    return getCollectionResourceClient(client, context, "/automated-patron-blocks");',
        '  }',
        '}'
      ].join('\n')
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.undeclared.map(use => [use.id, use.sites.map(site => [site.requestPath, site.line])])).toEqual([
      ['automated-patron-blocks', [['automated-patron-blocks', 10]]],
      ['configuration', [['configurations/entries', 6]]]
    ]);
    expect(analysis.unresolvedSites).toEqual([]);
  });

  it('reads Okapi URL prefixes, format strings and constants from other files, and leaves comparisons, logging and annotations out', async () => {
    const { analysis } = await b002(backendModule(template(['users', 'circulation', 'calendar']), {
      [`${JAVA}/Paths.java`]: [
        'package org.folio.example;',
        '',
        'public final class Paths {',
        '  public static final String USERS = USERS_ROOT;',
        '  public static final String USERS_ROOT = "/users";',
        '  public static final String SURROUNDING = "%s/surrounding-openings?date=%s";',
        '}'
      ].join('\n'),
      [`${JAVA}/client/PatronClient.java`]: [
        'package org.folio.example.client;',
        '',
        'import org.folio.example.Paths;',
        'import static org.folio.example.Paths.SURROUNDING;',
        '',
        'public class PatronClient {',
        '  void calls(String okapiURL, String id, String servicePointId) {',
        '    get(format("%s/users?query=externalSystemId==%s", okapiURL, id));',
        '    post(okapiURL + Paths.USERS + "/" + id + "/expire");',
        '    get(String.format(SURROUNDING, servicePointId, "2026-10-30"));',
        '    get(String.format("%s/circulation/requests/%s", okapiURL, id));',
        '    if (path.startsWith("/configurations/entries")) return;',
        '    log.info("/configurations/entries");',
        '    switch (path) { case "/configurations/entries": break; }',
        '    String file = "/templates/configurations.json";',
        '  }',
        '',
        '  @Path("/configurations/entries")',
        '  public void served() { }',
        '',
        '  static final String CONFIG = "/configurations/entries";',
        '  static final String CONFIG_ROUTE = "/configurations/entries";',
        '',
        '  @Path(CONFIG)',
        '  void compared(Router router) {',
        '    switch (path) { case CONFIG: break; }',
        '    if (path.startsWith(CONFIG_ROUTE)) log.info(CONFIG_ROUTE);',
        '    router.get(CONFIG_ROUTE).handler(this::served);',
        '  }',
        '}'
      ].join('\n')
    }));

    expect(analysis.status).toBe(EvaluationStatus.PASS);
    expect(analysis.declaredAndUsed.map(use => [use.id, use.sites.map(site => [site.requestPath, site.line, site.expression])])).toEqual([
      ['circulation', [['circulation/requests/{}', 11, '"%s/circulation/requests/%s"']]],
      ['users', [['users', 8, '"%s/users?query=externalSystemId==%s"'], ['users/{}/expire', 9, 'okapiURL + Paths.USERS + "/" + id + "/expire"']]]
    ]);
    expect(analysis.declaredNotSeen).toEqual(['calendar']);
  });

  it('does not count requests to the module\'s own paths or to Okapi, and maps a path with an unknown prefix only as unresolved', async () => {
    const { result, analysis } = await b002(backendModule(template([], {
      provides: [
        { id: 'notes', handlers: [[['GET'], '/notes/{id}'], [['GET'], '/notes/{id}/links*']] },
        { id: '_timer', interfaceType: 'system', handlers: [[['POST'], '/notes-exp*']] }
      ]
    }), {
      [`${JAVA}/NotesController.java`]: [
        'package org.folio.example;',
        '',
        'public class NotesController {',
        '  void calls(String id, String prefix) {',
        '    URI.create("/notes/" + id);',
        '    timer("/notes-expiry/process");',
        '    tenant(okapiUrl + "/_/tenant");',
        '    get(prefix + "/item-storage/items");',
        '    get(prefix + "/not-an-interface");',
        '    get(prefix + "/notes/" + id);',
        '    get("/notes/" + id + "/linksall");',
        '  }',
        '}'
      ].join('\n')
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B002 manual: Every request the tool could map goes to an interface the module\'s descriptor declares, but 1 request could not be mapped to one interface.');
    expect(analysis.ownSiteCount).toBe(3);
    expect(analysis.gatewaySiteCount).toBe(1);
    expect(result.details?.split('\n').slice(1, 2)).toEqual([
      '  - Requests: 1 request in production code (Spring HTTP clients 0, paths in code 1); 0 mapped to an interface; 3 requests to the module\'s own paths and 1 request to Okapi\'s own _/ endpoints not counted'
    ]);
    expect(result.details?.split('\n').slice(5)).toEqual([
      'Requests the tool could not map to one interface:',
      '  - src/main/java/org/folio/example/NotesController.java:8 — prefix + "/item-storage/items": the path starts with a value the tool cannot read',
      'What to do:',
      '  - Check that each request listed above goes to an interface in requires or optional, starting with the checklist below.',
      'Checklist for the reviewer:',
      '  - B002-C2 Each request the tool could not map to one interface, or whose path is not in the handler index, goes to an interface the descriptor declares, or to a service outside FOLIO.',
      '    - Start with:',
      '      - src/main/java/org/folio/example/NotesController.java:8 — prefix + "/item-storage/items": the path starts with a value the tool cannot read',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
  });

  it('leaves Spring clients whose address is set at run time, and paths not in the handler index, to the reviewer', async () => {
    const { result, analysis } = await b002(backendModule(template(['users']), {
      [`${JAVA}/client/LocationsClient.java`]: [
        'package org.folio.example.client;',
        '',
        '@HttpExchange',
        'public interface LocationsClient {',
        '  @GetExchange(accept = APPLICATION_JSON_VALUE)',
        '  ResultList<Location> getLocations(URI uri, @RequestParam int limit);',
        '',
        '  @PostExchange("${folio.reindex.path}")',
        '  void reindex();',
        '',
        '  @GetExchange("{tenant}/users")',
        '  Users byTenant(@PathVariable String tenant);',
        '}'
      ].join('\n'),
      [`${JAVA}/client/KeycloakClient.java`]: [
        'package org.folio.example.client;',
        '',
        'public class KeycloakClient {',
        '  private static final String REALM_INFO_URI = "/realms/%s/protocol/openid-connect/certs";',
        '  String uri(String realm) { return String.format(REALM_INFO_URI, realm); }',
        '}'
      ].join('\n')
    }, dependency('edge-common')));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B002 manual: Every request the tool could map goes to an interface the module\'s descriptor declares, but 3 requests could not be mapped to one interface, 1 request goes to a path that is not in the handler index, and the module uses edge-common, which sends requests of its own the tool does not see.');
    expect(result.details?.split('\n').slice(6)).toEqual([
      'Requests the tool could not map to one interface:',
      '  - src/main/java/org/folio/example/client/LocationsClient.java:5 — @GetExchange(accept = APPLICATION_JSON_VALUE): the method takes the request URI as an argument',
      '  - src/main/java/org/folio/example/client/LocationsClient.java:8 — @PostExchange("${folio.reindex.path}"): the path has a property placeholder',
      '  - src/main/java/org/folio/example/client/LocationsClient.java:11 — GET /{}/users: run-time parts could reach aggregator-settings, alternative-title-types, applications, and 81 more',
      'Paths not in the handler index:',
      '  - src/main/java/org/folio/example/client/KeycloakClient.java:5 — /realms/{}/protocol/openid-connect/certs',
      'What to do:',
      '  - Check that each request listed above goes to an interface in requires or optional, starting with the checklist below.',
      'Checklist for the reviewer:',
      '  - B002-C2 Each request the tool could not map to one interface, or whose path is not in the handler index, goes to an interface the descriptor declares, or to a service outside FOLIO.',
      '    - Start with:',
      '      - src/main/java/org/folio/example/client/LocationsClient.java:5 — @GetExchange(accept = APPLICATION_JSON_VALUE): the method takes the request URI as an argument',
      '      - src/main/java/org/folio/example/client/LocationsClient.java:8 — @PostExchange("${folio.reindex.path}"): the path has a property placeholder',
      '      - src/main/java/org/folio/example/client/LocationsClient.java:11 — GET /{}/users: run-time parts could reach aggregator-settings, alternative-title-types, applications, and 81 more',
      '      - src/main/java/org/folio/example/client/KeycloakClient.java:5 — /realms/{}/protocol/openid-connect/certs: not in the handler index',
      '  - B002-C3 Requests made through FOLIO libraries go to interfaces the descriptor declares.',
      '    - Start with:',
      '      - pom.xml — edge-common sends requests of its own',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
    expect(analysis.checklist.items.map(item => [item.id, item.reviewerOnly, item.obligations.map(obligation => obligation.subject)])).toEqual([
      ['B002-C2', false, ['@GetExchange(accept = APPLICATION_JSON_VALUE)', '@PostExchange("${folio.reindex.path}")', '/{}/users', '/realms/{}/protocol/openid-connect/certs']],
      ['B002-C3', true, []]
    ]);
  });

  it('leaves constants it cannot tell apart or whose uses it cannot read, and Kotlin, to the reviewer instead of passing', async () => {
    const { result, analysis } = await b002(backendModule(template(['inventory']), {
      [`${JAVA}/Paths.java`]: [
        'package org.folio.example;',
        '',
        'public class Paths {',
        '  static class Users {',
        '    static final String BASE = "/users";',
        '  }',
        '  static class Items {',
        '    static final String BASE = "/inventory/items";',
        '  }',
        '  void run(String id, String baseEndpoint) {',
        '    get(Users.BASE);',
        '    get(Items.BASE);',
        '    log.info("Fetching " + USER_BY_ID); get(USER_BY_ID.replace("{id}", id));',
        '    get(baseEndpoint + "/automated-patron-blocks");',
        '  }',
        '  static final String USER_BY_ID = "/users/{id}";',
        '  void users() { String PATH = "/users"; get(PATH); }',
        '  void items() { String PATH = "/inventory/items"; get(PATH); }',
        '}'
      ].join('\n'),
      'src/main/kotlin/org/folio/example/Client.kt': 'class Client { fun run() = get("${okapiUrl}/users/$id") }'
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B002 manual: Every request the tool could map goes to an interface the module\'s descriptor declares, but 6 requests could not be mapped to one interface and 1 source file is Kotlin, which the tool does not read.');
    expect(analysis.unresolvedSites.map(site => [site.line, site.expression, site.unresolved])).toEqual([
      [5, 'BASE = "/users"', 'the tool could not read how this constant is used'],
      [8, 'BASE = "/inventory/items"', 'the tool could not read how this constant is used'],
      [14, 'baseEndpoint + "/automated-patron-blocks"', 'the path starts with a value the tool cannot read'],
      [16, 'USER_BY_ID = "/users/{id}"', 'the tool could not read how this constant is used'],
      [17, 'PATH = "/users"', 'the tool could not read how this constant is used'],
      [18, 'PATH = "/inventory/items"', 'the tool could not read how this constant is used']
    ]);
    expect(analysis.declaredAndUsed).toEqual([]);
    expect(analysis.kotlinFiles).toEqual(['src/main/kotlin/org/folio/example/Client.kt']);
  });

  it('counts an edge module\'s requests to the paths it serves, but not its router routes', async () => {
    const { result, analysis } = await b002({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      'descriptors/ModuleDescriptor-template.json': template([]),
      'src/main/java/org/folio/edge/example/MainVerticle.java': [
        'package org.folio.edge.example;',
        '',
        'public class MainVerticle {',
        '  void routes(Router router, String okapiURL, String id) {',
        '    router.route(HttpMethod.GET, "/patron/account/:patronId").handler(this::account);',
        '    client.get(okapiURL + "/patron/account/" + id);',
        '  }',
        '}'
      ].join('\n')
    });

    expect(result.evidence).toBe('B002 manual: The module sends requests to 1 interface its descriptor declares in neither requires nor optional: '
      + 'patron (/patron/account/{} at src/main/java/org/folio/edge/example/MainVerticle.java:6). Also, the module uses edge-common, which sends requests of its own the tool does not see. '
      + 'This is not a fail: a reviewer must check that each request is made, and if so declare its interface.');
    expect([analysis.kind, analysis.siteCount, analysis.ownSiteCount]).toEqual(['edge-module', 1, 0]);
  });

  it('keeps a Feign client\'s path to its own type and ignores annotations that share a name with object methods', async () => {
    const { result } = await b002(backendModule(template(['users']), {
      [`${JAVA}/UsersClient.java`]: [
        'package org.folio.example;',
        '',
        '@FeignClient(name = "users")',
        'interface UsersClient {',
        '  record UserCollection(List<User> users) { }',
        '  @GetMapping("/{id}")',
        '  User get(@PathVariable String id);',
        '}',
        '',
        '@RestController',
        'class MineController {',
        '  @GetMapping("/mine")',
        '  String mine() { return "x"; }',
        '',
        '  @toString',
        '  void other() { }',
        '}'
      ].join('\n')
    }));

    expect(result.evidence).toBe('B002 pass: Every request the tool found in the module\'s code goes to an interface its descriptor declares in requires or optional (1 request to 1 interface).');
  });

  it('reads Feign clients and Groovy services', async () => {

    const { analysis } = await b002({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': template(['users'], { optional: ['eholdings', 'circulation'] }),
      'service/grails-app/services/org/olf/EholdingsService.groovy': [
        'package org.olf',
        '',
        'class EholdingsService {',
        '  static final String BULK_URI_PACKAGES = \'/eholdings/packages/bulk/fetch\'',
        '  OkapiClient okapiClient',
        '  def fetch() {',
        '    okapiClient.post(BULK_URI_PACKAGES, [:], null)',
        '    okapiClient.get("${okapiUrl}/users/${id}")',
        '    okapiClient.get("${id}/users")',
        '  }',
        '}'
      ].join('\n'),
      'service/grails-app/controllers/org/olf/UrlMappings.groovy': 'class UrlMappings { static mappings = { "/erm/sas"(resources: "subscriptionAgreement") } }',
      'service/src/main/java/org/olf/CirculationClient.java': [
        'package org.olf;',
        '',
        '@FeignClient(name = "circulation", path = "requests")',
        'public interface CirculationClient {',
        '  @RequestMapping(method = RequestMethod.PUT, value = "/{id}")',
        '  void update(@PathVariable String id, Request request);',
        '}'
      ].join('\n')
    });

    expect(analysis.declaredAndUsed.map(use => [use.id, use.sites.map(site => [site.kind, site.method, site.requestPath, site.line])])).toEqual([
      ['circulation', [['spring-client', 'PUT', 'circulation/requests/{}', 5]]],
      ['eholdings', [['code', undefined, 'eholdings/packages/bulk/fetch', 7]]],
      ['users', [['code', undefined, 'users/{}', 8]]]
    ]);
    expect(analysis.unresolvedSites.map(site => [site.line, site.expression, site.unresolved])).toEqual([
      [9, '"${id}/users"', 'the path starts with a value the tool cannot read']
    ]);
  });

  it('notes when S008 reads declarations that differ from the template B002 reads', async () => {
    const { result } = await b002(backendModule(JSON.stringify({
      id: 'mod-example-1.0.0',
      requires: [{ id: '${usersInterface}', version: '16.0' }, { id: 'configuration', version: '2.0' }]
    }), springClients, '<properties><usersInterface>users</usersInterface></properties>'));

    expect(result.details?.split('\n').slice(3, 6)).toEqual([
      '  - Declared and used: users',
      '  - Declared but not seen (not a problem): configuration',
      '  - S008 reads descriptors/ModuleDescriptor-template.json, whose declared interfaces differ (information only): only the template has users (S008 could not use 1 entry)'
    ]);
  });

  it('leaves declarations it cannot read, and a repository without a descriptor, to the reviewer', async () => {
    const unread = await b002(backendModule(JSON.stringify({ id: 'mod-example-1.0.0', requires: [{ id: '${undefinedInterface}', version: '1.0' }, 'users'] }), {}));
    expect(unread.result.status).toBe(EvaluationStatus.MANUAL);
    expect(unread.result.evidence).toBe('B002 manual: Every request the tool could map goes to an interface the module\'s descriptor declares, but 2 entries of requires or optional could not be read.');
    expect(unread.analysis.checklist.items.map(item => [item.id, item.startingPoints.map(point => point.note)])).toEqual([
      ['B002-C4', ['/requires/0: no interface id the tool can read', '/requires/1: no interface id the tool can read']]
    ]);

    const ambiguous = await b002({ 'pom.xml': pom('example'), [`${JAVA}/Main.java`]: 'class Main { void run() { get("/users"); } }' });
    expect(ambiguous.result.status).toBe(EvaluationStatus.MANUAL);
    expect(ambiguous.result.evidence).toBe('B002 manual: No module descriptor template was found, so the interfaces the module declares are not known (see B001).');
    expect(ambiguous.result.details?.split('\n')).toEqual([
      'What to do:',
      '  - Commit the module descriptor template, with the interfaces the module calls in requires or optional (see B001).',
      'Checklist for the reviewer:',
      '  - B002-C4 The module descriptor declares each interface the module calls in requires, or in optional when the module works without it.',
      'Agent review:',
      '  - Not applied: what remains is for the reviewer: requests made by FOLIO libraries, or declarations the tool could not read'
    ]);

    const library = await b002({ 'pom.xml': pom('folio-spring-base'), [`${JAVA}/Main.java`]: 'class Main { void run() { get("/users"); } }' });
    expect(library.result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(library.result.evidence).toBe('B002 not_applicable: The repository is a shared library, which has no module descriptor to declare the interfaces it calls.');
  });

  it('is manual, never pass, when the handler index did not load', async () => {
    const root = repository(backendModule(template(['users']), springClients));
    const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
    const analysis = evaluateB002({ evidence: await getBackendEvidence(run, root), index: { loaded: false, problem: 'f001-handler-index.json could not be used: test' } });

    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.summary).toBe('B002 manual: Every request the tool could map goes to an interface the module\'s descriptor declares, but 2 requests could not be mapped to one interface and the handler index could not be loaded.');
  });

  describe('scales linearly', () => {
    const index = loadF001HandlerIndex();
    const isInterfacePath = (requestPath: string) => index.loaded && mapRequestPath(requestPath, false, index.patterns).outcome !== 'not-in-index';
    const scan = (content: string, path = `${JAVA}/Big.java`) => async () => outboundRequests([{ path, content }], isInterfacePath);

    it.each([
      ['request literals', (n: number) => 'class Big { void run() {\n' + 'get(okapiUrl + "/users/" + id);\n'.repeat(n) + '} }'],
      ['nested calls with paths', (n: number) => `class Big { void run() { ${'f("/users" + '.repeat(n)}x${')'.repeat(n)}; } }`],
      ['a long qualified name', (n: number) => `class Big { Object x = @${'a.'.repeat(n)}b("x"); Object y = ${'a.'.repeat(n)}b; }`],
      ['constants built from doubled constants', (n: number) => `class Big { static final String C0 = "/users";\n${Array.from({ length: n }, (_, i) => `static final String C${i + 1} = C${i} + C${i};`).join('\n')}\nvoid run() { get(C${n}); } }`],
      ['format specifiers', (n: number) => `class Big { void run() { get(format("%s/users/%${'1'.repeat(100 * n)}/${'%1$'.repeat(100 * n)}", okapiUrl)); } }`],
      ['Spring annotations', (n: number) => `@HttpExchange("users") interface Big {\n${'@GetExchange(value = "/{id}", accept = {A, B}) User get(String id);\n'.repeat(n)}}`],
      ['unclosed parentheses', (n: number) => `class Big { void run() { ${'get("/users", ('.repeat(n)} } }`],
      ['import statements', (n: number) => `${'import;'.repeat(20 * n)}\nclass Big { }`],
      ['stacked annotations', (n: number) => `interface Big {\n${'@GetExchange '.repeat(n)}User get(URI uri);\n}`],
      ['constants read from many constants, many levels deep', (n: number) => `class Big {\n${Array.from({ length: 10 }, (_, level) =>
        `static final String A${level} = ${Array.from({ length: n / 16 }, () => `A${level + 1}.trim()`).join(' + ')};`).join('\n')}\nstatic final String A10 = "/users";\nvoid run() { get(A0); } }`]
    ])('over %s', async (_name, build) => {
      await expectLinearTime(4_000, build, content => scan(content)());
    });

    it('over requests, declarations and build files in an evaluation', async () => {
      await expectLinearTime(250, async (n: number) => {
        const root = repository(backendModule(template(Array.from({ length: n }, (_, i) => `interface-${i}`), {
          provides: [{ id: 'own', handlers: [[['GET'], `/${'a*'.repeat(n)}b`]] }]
        }), {
          [`${JAVA}/Big.java`]: `class Big { void run() {\nget("/${'a'.repeat(4 * n)}");\n${'get(okapiUrl + "/users/" + id); get("/realms/x"); get(prefix + "/item-storage/items");\n'.repeat(n)}} }`
        }, `<dependencies>${'<artifactId>   folio-spring-base   </artifactId>'.repeat(n)}</dependencies>`));
        return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
      }, async evidence => evaluateB002({ evidence, index }));
    });

    it.each([
      ['with their own first segments', (i: number) => `/own${i}/a/b/c`, (i: number) => `get(okapiUrl + "/users/" + id${i});`],
      ['sharing a first segment', (i: number) => `/own/a${i}/b/c`, (i: number) => `get("/own/x${i}/${'s/'.repeat(40)}" + id);`]
    ])('over handlers %s times requests', async (_name, handler, request) => {
      await expectLinearTime(1_000, async (n: number) => {
        const root = repository(backendModule(template(['users'], {
          provides: [{ id: 'own', handlers: Array.from({ length: n }, (_, i): Handler => [['GET'], handler(i)]) }]
        }), {
          [`${JAVA}/Big.java`]: `class Big { void run() {\n${Array.from({ length: n }, (_, i) => request(i)).join('\n')}\n} }`
        }));
        return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
      }, async evidence => evaluateB002({ evidence, index }));
    });

    it('over Groovy interpolations', async () => {
      await expectLinearTime(10_000, (n: number) => `class Big { def run() { get("${'${okapiUrl}/users/$id'.repeat(n)}") } }`,
        content => scan(content, 'service/grails-app/services/Big.groovy')());
    });
  });
});
