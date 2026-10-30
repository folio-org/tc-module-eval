import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B014Analysis, BackendEvidence, EvaluationStatus } from '../types';
import { evaluateB014 } from '../utils/b014-health-check';
import { dependency, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b014(files: Record<string, string>) {
  const root = repository(files);
  const result = await new BackendEvaluator().evaluateCriterion('B014', root);
  return { result, analysis: result.criterionDetails as B014Analysis, rows: result.details?.split('\n') };
}

const TEMPLATE = { 'descriptors/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0", "provides": []}' };
const APPLICATION = 'src/main/java/org/folio/example/ExampleApplication.java';
const springApplication = '@SpringBootApplication\npublic class ExampleApplication {}\n';
const ACTUATOR = dependency('spring-boot-starter-actuator', 'org.springframework.boot');

const springModule = (config: Record<string, string>, dependencies = ACTUATOR) => ({
  ...TEMPLATE,
  'pom.xml': pom('mod-example', `<dependencies>${dependencies}</dependencies>`),
  [APPLICATION]: springApplication,
  ...config
});

const ADMIN_YAML = 'management:\n  endpoints:\n    web:\n      exposure:\n        include: info,health\n      base-path: /admin\n  health:\n    defaults:\n      enabled: false\n';
const KEY_BASE_PATH = 'management.endpoints.web.base-path';
const CHECKLIST_TITLE = '  - B014-C1 The module answers GET /admin/health with 200 when it runs.';

describe('B014 health check endpoint', () => {
  it('passes a Spring Boot module whose actuator serves health at /admin, saying the endpoint was not called', async () => {
    const { result, analysis, rows } = await b014(springModule({
      'src/main/resources/application.yml': ADMIN_YAML,
      'src/main/resources/application-dev.yaml': ADMIN_YAML
    }));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B014 pass: Spring Boot actuator serves health at /admin/health (management.endpoints.web.base-path in src/main/resources/application.yml:6). '
      + 'The tool found the mechanism in configuration and did not call the endpoint.');
    expect(rows).toEqual([
      'Health check: GET /admin/health was not called; the result comes from the committed files',
      'Found:',
      '  - Spring Boot actuator: src/main/resources/application.yml:6 — management.endpoints.web.base-path /admin; actuator serves health at /admin/health'
    ]);
    expect(analysis.endpointCalled).toBe(false);
    expect(analysis.basis).toBe('mechanism-found');
    expect(analysis.actuator).toEqual([{
      framework: 'spring',
      root: '',
      source: APPLICATION,
      dependency: { path: 'pom.xml', line: 1 },
      configFiles: ['src/main/resources/application-dev.yaml', 'src/main/resources/application.yml'],
      problems: [],
      problemCount: 0
    }]);
    expect(analysis.checklist.items).toEqual([]);
  });

  it('leaves actuator at its default base path to the reviewer, with a checklist', async () => {
    const { result, analysis, rows } = await b014(springModule({
      'src/main/resources/application.yml': 'management.endpoints.web.exposure.include: health\n',
      'src/main/resources/application-dev.yml': 'logging.level.root: info\n'
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B014 manual: The Spring Boot application may not serve health at /admin/health: management.endpoints.web.base-path is not set, so actuator serves health at /actuator/health. '
      + 'The tool found no RMB RestVerticle main verticle and no GET /admin/health route in the source. A reviewer must check that the module answers GET /admin/health with 200.');
    expect(rows).toEqual([
      'Health check: GET /admin/health was not called; the result comes from the committed files',
      'Actuator not counted for the Spring Boot application:',
      `  - ${APPLICATION} — management.endpoints.web.base-path is not set, so actuator serves health at /actuator/health`,
      'Checklist for the reviewer:',
      CHECKLIST_TITLE,
      '    - Start with:',
      `      - ${APPLICATION} — management.endpoints.web.base-path is not set, so actuator serves health at /actuator/health`
    ]);
    expect(analysis.basis).toBe('no-mechanism');
  });

  const YML = 'src/main/resources/application.yml';
  const PROPERTIES = 'src/main/resources/application.properties';
  const HEADER = 'Health check: GET /admin/health was not called; the result comes from the committed files';

  it.each([
    ['a YAML list that includes health', YML, 'management:\n  endpoints:\n    web:\n      base-path: /admin/\n      exposure:\n        include:\n          - info\n          - health\n', 4],
    ['relaxed property names', PROPERTIES, 'management.endpoints.web.basePath=/admin\nmanagement.endpoints.web.exposure.INCLUDE : info, health\n', 1],
    ['an exposure of every endpoint', PROPERTIES, 'management.endpoints.web.exposure.include[0]=*\nmanagement.endpoints.web.base_path /admin\n', 2],
    ['health enabled when endpoints are off by default (mod-agreements)', YML, 'management:\n  endpoints:\n    enabled-by-default: false\n    web:\n      base-path: \'/admin\'\n  endpoint:\n    health:\n      enabled: true\n', 5],
    ['Spring\'s other boolean spellings', PROPERTIES, 'management.endpoints.enabled-by-default=0\nmanagement.endpoint.health.enabled=Yes\nmanagement.endpoints.web.base-path=/admin\n', 3],
    ['a property continued on the next line', PROPERTIES, 'management.endpoints.web.base-path=\\\n    /admin\n', 1],
    ['the base path at the root and health mapped to admin/health', PROPERTIES, 'management.endpoints.web.base-path=/\nmanagement.endpoints.web.path-mapping.health=admin/health\n', 1]
  ])('passes with %s', async (_name, file, config, line) => {
    const { result } = await b014(springModule({ [file]: config }));

    expect(result.evidence).toBe(`B014 pass: Spring Boot actuator serves health at /admin/health (management.endpoints.web.base-path in ${file}:${line}). `
      + 'The tool found the mechanism in configuration and did not call the endpoint.');
  });

  const ADMIN = 'management.endpoints.web.base-path=/admin\n';
  it.each([
    ['an exposure without health', `${ADMIN}management.endpoints.web.exposure.include=info,env\n`, [[2, 'management.endpoints.web.exposure.include does not include health']]],
    ['an exposure that excludes health', `${ADMIN}management.endpoints.web.exposure.exclude=env,health\n`, [[2, 'management.endpoints.web.exposure.exclude excludes health']]],
    ['health disabled', `${ADMIN}management.endpoint.health.enabled=off\n`, [[2, 'management.endpoint.health.enabled is off']]],
    ['endpoints disabled by default', `${ADMIN}management.endpoints.enabled-by-default=no\n`,
      [[2, 'management.endpoints.enabled-by-default is no and management.endpoint.health.enabled is not true']]],
    ['health access none', `${ADMIN}management.endpoint.health.access=none\n`, [[2, 'management.endpoint.health.access is none']]],
    ['access none by default', `${ADMIN}management.endpoints.access.default=none\n`,
      [[2, 'management.endpoints.access.default is none and management.endpoint.health.access is not set']]],
    ['access capped at none', `${ADMIN}management.endpoints.access.max-permitted=none\n`, [[2, 'management.endpoints.access.max-permitted is none']]],
    ['a separate management port written with a Unicode escape', `${ADMIN}management.server.\\u0070ort=9090\n`,
      [[2, 'management.server.port is 9090, so actuator does not listen on the module\'s port']]],
    ['a servlet context path', `${ADMIN}server.servlet.context-path=/notes\n`, [[2, 'server.servlet.context-path is /notes, which comes before every path']]],
    ['a Spring Boot 1 context path', `${ADMIN}server.context-path=/notes\n`, [[2, 'server.context-path is /notes, which comes before every path']]],
    ['a dispatcher servlet path', `${ADMIN}spring.mvc.servlet.path=/api\n`, [[2, 'spring.mvc.servlet.path is /api, which comes before every path']]],
    ['a WebFlux base path', `${ADMIN}spring.webflux.base-path=/api\n`, [[2, 'spring.webflux.base-path is /api, which comes before every path']]],
    ['no web server', `${ADMIN}spring.main.web-application-type=NONE\n`, [[2, 'spring.main.web-application-type is none, so the application starts no web server']]],
    ['HTTP turned off', `${ADMIN}server.port=-1\n`, [[2, 'server.port is -1, so the application serves no HTTP']]],
    ['imported configuration', `${ADMIN}spring.config.import=optional:classpath:management.yml\n`, [[2, 'spring.config.import reads configuration the tool does not read']]],
    ['a base path from an environment variable', 'management.endpoints.web.base-path=${ADMIN_PATH:/admin}\n', [
      [1, 'management.endpoints.web.base-path is set from ${ADMIN_PATH:/admin}, which the deployment decides'],
      [undefined, 'management.endpoints.web.base-path is not set, so actuator serves health at /actuator/health']
    ]],
    ['a base path without a leading slash', 'management.endpoints.web.base-path=admin\n',
      [[1, 'management.endpoints.web.base-path is admin, which does not start with /, so Spring Boot does not start']]],
    ['a base path with a doubled slash', 'management.endpoints.web.base-path=//admin\n', [[1, 'actuator serves health at //admin/health (management.endpoints.web.base-path //admin)']]],
    ['an exposure list in Spring\'s name[] form', `${ADMIN}management.endpoints.web.exposure.include[]=info,env\n`,
      [[2, 'management.endpoints.web.exposure.include does not include health']]],
    ['a repeated list index, the later one replacing the earlier', `${ADMIN}management.endpoints.web.exposure.include[0]=health\nmanagement.endpoints.web.exposure.include[0]=info\n`,
      [[3, 'management.endpoints.web.exposure.include does not include health']]],
    ['an escaped comma in a name[] list', `${ADMIN}management.endpoints.web.exposure.include[]=info\\,health\n`,
      [[2, 'management.endpoints.web.exposure.include does not include health']]],
    ['an exclusion list in Spring\'s name[] form', `${ADMIN}management.endpoints.web.exposure.exclude[]=env,health\n`, [[2, 'management.endpoints.web.exposure.exclude excludes health']]],
    ['a base path with trailing spaces', 'management.endpoints.web.base-path=/admin  \n', [[1, 'actuator serves health at /admin  /health (management.endpoints.web.base-path /admin  )']]],
    ['an indented #--- that does not start a document', `${ADMIN}  #---\nspring.config.activate.on-profile=prod\n`,
      [[undefined, 'management.endpoints.web.base-path is not set, so actuator serves health at /actuator/health']]],
    ['health mapped elsewhere in bracket notation', `${ADMIN}management.endpoints.web.path-mapping[health]=status\n`,
      [[2, 'actuator serves health at /admin/status (management.endpoints.web.base-path /admin and management.endpoints.web.path-mapping[health] status)']]]
  ] as Array<[string, string, Array<[number | undefined, string]>]>)('leaves %s to the reviewer', async (_name, config, problems) => {
    const { result, rows } = await b014(springModule({ [PROPERTIES]: config }));
    const at = (line: number | undefined) => line ? `${PROPERTIES}:${line}` : APPLICATION;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(rows).toEqual([
      HEADER,
      'Actuator not counted for the Spring Boot application:',
      ...problems.map(([line, note]) => `  - ${at(line)} — ${note}`),
      'Checklist for the reviewer:',
      CHECKLIST_TITLE,
      '    - Start with:',
      ...problems.map(([line, note]) => `      - ${at(line)} — ${note}`)
    ]);
  });

  it('does not resolve YAML aliases or merge keys for actuator settings', async () => {
    const nested = await b014(springModule({
      [YML]: 'defaults: &defaults\n  endpoints:\n    web:\n      base-path: /admin\nmanagement:\n  <<: *defaults\n'
    }));
    const topLevel = await b014(springModule({
      [YML]: 'defaults: &defaults\n  management.server.port: 9090\n<<: *defaults\nmanagement.endpoints.web.base-path: /admin\n'
    }));

    expect(nested.analysis.actuator[0].problems).toEqual([
      { path: YML, line: 6, note: 'management is a YAML alias or merge, which the tool does not resolve' },
      { note: 'management.endpoints.web.base-path is not set, so actuator serves health at /actuator/health' }
    ]);
    expect(topLevel.analysis.actuator[0].problems).toEqual([
      { path: YML, line: 3, note: 'the top level of the document is a YAML alias or merge, which the tool does not resolve' }
    ]);
  });

  it('applies application.properties over application.yml, and config/ over both', async () => {
    const yamlOnly = await b014(springModule({
      'src/main/resources/application.yml': 'management.endpoints.web.base-path: /admin\n',
      'src/main/resources/application.properties': 'management.endpoints.web.base-path=/actuator\n'
    }));
    const withConfigFolder = await b014(springModule({
      'src/main/resources/application.properties': 'management.endpoints.web.base-path=/actuator\n',
      'src/main/resources/config/application.yml': 'management.endpoints.web.base-path: /admin\n'
    }));

    expect(yamlOnly.analysis.actuator[0].problems).toEqual([{
      path: 'src/main/resources/application.properties', line: 1,
      note: 'actuator serves health at /actuator/health (management.endpoints.web.base-path /actuator)'
    }]);
    expect(withConfigFolder.result.evidence).toBe('B014 pass: Spring Boot actuator serves health at /admin/health (management.endpoints.web.base-path in src/main/resources/config/application.yml:1). '
      + 'The tool found the mechanism in configuration and did not call the endpoint.');
  });

  it('checks profile documents and files on top of the default configuration, a later list replacing the whole list', async () => {
    const { result, analysis, rows } = await b014(springModule({
      'src/main/resources/application.yml': [
        'management:', '  endpoints:', '    web:', '      base-path: /admin', '      exposure:', '        include: [health, info]',
        '---', 'spring.config.activate.on-profile: prod', 'management.endpoints.web.exposure.include: info',
        '---', 'spring.config.activate.on-profile: test', 'management.endpoints.web.base-path: /admin'
      ].join('\n'),
      'src/main/resources/application-k8s.properties': 'management.server.port=8082\n'
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B014 manual: The Spring Boot application may not serve health at /admin/health: '
      + 'management.endpoints.web.exposure.include does not include health when spring.config.activate.on-profile is prod and '
      + 'management.server.port is 8082, so actuator does not listen on the module\'s port when the profile k8s is active. '
      + 'The tool found no RMB RestVerticle main verticle and no GET /admin/health route in the source. A reviewer must check that the module answers GET /admin/health with 200.');
    expect(rows).toEqual([
      'Health check: GET /admin/health was not called; the result comes from the committed files',
      'Actuator not counted for the Spring Boot application:',
      '  - src/main/resources/application.yml:9 — management.endpoints.web.exposure.include does not include health when spring.config.activate.on-profile is prod',
      '  - src/main/resources/application-k8s.properties:1 — management.server.port is 8082, so actuator does not listen on the module\'s port when the profile k8s is active',
      'Checklist for the reviewer:',
      CHECKLIST_TITLE,
      '    - Start with:',
      '      - src/main/resources/application.yml:9 — management.endpoints.web.exposure.include does not include health when spring.config.activate.on-profile is prod',
      '      - src/main/resources/application-k8s.properties:1 — management.server.port is 8082, so actuator does not listen on the module\'s port when the profile k8s is active'
    ]);
    expect(analysis.actuator[0].problems.map(problem => problem.condition)).toEqual(['when spring.config.activate.on-profile is prod', 'when the profile k8s is active']);
  });

  it('reads a Grails application from grails-app/conf, including its environments', async () => {
    const grails = (production: string) => b014({
      'service/build.gradle': 'dependencies {\n  implementation("org.springframework.boot:spring-boot-starter-actuator")\n}\n',
      'service/src/main/okapi/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0", "provides": []}',
      'service/grails-app/controllers/UrlMappings.groovy': 'class UrlMappings {}\n',
      'service/grails-app/conf/application.groovy': 'grails.gorm.default.mapping = {}\n',
      'service/grails-app/conf/application.yml': `---\nmanagement:\n  endpoints:\n    web:\n      base-path: '/admin'\n---\nenvironments:\n  production:\n${production}`
    });

    const plain = await grails('    dataSource:\n      url: jdbc:postgresql://localhost/olf\n');
    const moved = await grails('    management:\n      endpoints:\n        web:\n          base-path: /manage\n');

    expect(plain.result.evidence).toBe('B014 pass: Spring Boot actuator serves health at /admin/health (management.endpoints.web.base-path in service/grails-app/conf/application.yml:5). '
      + 'The tool found the mechanism in configuration and did not call the endpoint.');
    expect(plain.analysis.actuator.map(({ framework, root, source, dependency }) => ({ framework, root, source, dependency })))
      .toEqual([{ framework: 'grails', root: 'service/', source: 'service/grails-app/', dependency: { path: 'service/build.gradle', line: 2 } }]);
    expect(moved.result.status).toBe(EvaluationStatus.MANUAL);
    expect(moved.analysis.actuator[0].problems).toEqual([{
      path: 'service/grails-app/conf/application.yml', line: 12, condition: 'in the Grails environment production',
      note: 'actuator serves health at /manage/health (management.endpoints.web.base-path /manage)'
    }]);
  });

  it('does not read Groovy configuration that sets management settings', async () => {
    const { analysis } = await b014({
      ...TEMPLATE,
      'build.gradle': 'implementation "org.folio:folio-spring-base:9.0.0"\n',
      'grails-app/conf/application.groovy': 'import x\n\nmanagement.endpoints.web.basePath = "/admin"\n',
      'grails-app/conf/application.yml': 'management.endpoints.web.base-path: /admin\n'
    });

    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.actuator[0].problems).toEqual([{
      path: 'grails-app/conf/application.groovy', line: 3,
      note: 'Groovy configuration sets management, server or spring settings, which the tool does not read'
    }]);
  });

  const NO_DEPENDENCY = 'no build file of the application or its parent folders has a dependency on spring-boot-starter-actuator or folio-spring-base';
  const BOOT = 'org.springframework.boot';
  it.each([
    ['a test-only actuator artifact', { 'pom.xml': pom('mod-example', `<dependencies>${dependency('spring-boot-starter-actuator-test', BOOT)}</dependencies>`) }],
    ['actuator in test scope', { 'pom.xml': pom('mod-example', `<dependencies><dependency><artifactId>spring-boot-starter-actuator</artifactId><scope>test</scope></dependency></dependencies>`) }],
    ['actuator only excluded', { 'pom.xml': pom('mod-example', `<dependencies><dependency><artifactId>folio-service-tools</artifactId><exclusions><exclusion><artifactId>spring-boot-starter-actuator</artifactId></exclusion></exclusions></dependency></dependencies>`) }],
    ['actuator only in a comment', { 'pom.xml': pom('mod-example', `<dependencies><!-- ${dependency('spring-boot-starter-actuator', BOOT)} --></dependencies>`) }],
    ['actuator only in dependency management', { 'pom.xml': pom('mod-example', `<dependencyManagement><dependencies>${dependency('spring-boot-starter-actuator', BOOT)}</dependencies></dependencyManagement>`) }],
    ['actuator only in another module', { 'pom.xml': pom('mod-example'), 'client/pom.xml': pom('mod-example-client', `<dependencies>${ACTUATOR}</dependencies>`) }],
    ['actuator only excluded in Gradle', { 'pom.xml': pom('mod-example'), 'build.gradle': 'dependencies {\n  implementation("org.springframework.boot:spring-boot-starter-web") { exclude module: "spring-boot-starter-actuator" }\n}\n' }],
    ['a Gradle test configuration or a commented-out line', { 'pom.xml': pom('mod-example'), 'build.gradle': 'dependencies {\n  testImplementation "org.springframework.boot:spring-boot-starter-actuator"\n  // implementation "org.folio:folio-spring-base:9.0.0"\n  /*\n  implementation "org.folio:folio-spring-base:9.0.0"\n  */\n}\n' }]
  ])('needs an actuator dependency, not %s', async (_name, build) => {
    const { result, analysis } = await b014({ ...springModule({ [YML]: ADMIN_YAML }), ...build });

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.actuator[0].problems).toEqual([{ note: NO_DEPENDENCY }]);
  });

  it('takes the actuator dependency from a parent folder\'s build file', async () => {
    const { result, analysis } = await b014({
      ...TEMPLATE,
      'pom.xml': pom('mod-example', `<dependencies>\n${ACTUATOR}\n</dependencies>`),
      'mod-example-server/pom.xml': pom('mod-example-server'),
      'mod-example-server/src/main/java/App.java': springApplication,
      'mod-example-server/src/main/resources/application.yml': ADMIN_YAML
    });

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(analysis.actuator[0]).toMatchObject({ root: 'mod-example-server/', dependency: { path: 'pom.xml', line: 2 }, problems: [] });
  });

  it('reads list-form profile activation and properties documents as conditional', async () => {
    const yaml = await b014(springModule({
      [YML]: 'management.endpoints.web.exposure.include: health\n---\nspring.config.activate.on-profile: [prod, eu]\nmanagement.endpoints.web.base-path: /admin\n'
    }));
    const properties = await b014(springModule({
      [PROPERTIES]: `${ADMIN}!---\nspring.config.activate.on-profile[0]=k8s\nmanagement.server.port=9090\n#---\nspring.config.activate.on-cloud-platform=kubernetes\nserver.servlet.context-path=/x\n`
    }));

    expect(yaml.analysis.actuator[0].problems).toEqual([
      { note: 'management.endpoints.web.base-path is not set, so actuator serves health at /actuator/health' }
    ]);
    expect(properties.analysis.actuator[0].problems).toEqual([
      { path: PROPERTIES, line: 4, condition: 'when spring.config.activate.on-profile is k8s', note: 'management.server.port is 9090, so actuator does not listen on the module\'s port' },
      { path: PROPERTIES, line: 7, condition: 'when spring.config.activate.on-cloud-platform is kubernetes', note: 'server.servlet.context-path is /x, which comes before every path' }
    ]);
  });

  it('does not count a route under a context path, and needs every application to serve health', async () => {
    const CONTROLLER = { 'src/main/java/org/folio/example/HealthController.java': '@RestController\npublic class HealthController {\n  @GetMapping("/admin/health")\n  public String health() { return "OK"; }\n}\n' };
    const prefixed = await b014(springModule({ ...CONTROLLER, [PROPERTIES]: `${ADMIN}server.servlet.context-path=/notes\n` }));
    const twoApplications = await b014({
      ...TEMPLATE,
      'pom.xml': pom('mod-example', `<dependencies>${ACTUATOR}</dependencies>`),
      'a/src/main/java/A.java': springApplication,
      'a/src/main/resources/application.yml': ADMIN_YAML,
      'b/src/main/java/B.java': springApplication
    });

    expect(prefixed.result.evidence).toBe('B014 manual: The Spring Boot application may not serve health at /admin/health: server.servlet.context-path is /notes, which comes before every path. '
      + 'The source registers GET /admin/health (src/main/java/org/folio/example/HealthController.java:3), but the application\'s settings put a prefix before every path or serve no HTTP, so the route may not answer at /admin/health. '
      + 'The tool found no RMB RestVerticle main verticle. A reviewer must check that the module answers GET /admin/health with 200.');
    expect(prefixed.analysis.mechanisms).toEqual([]);
    expect(twoApplications.result.status).toBe(EvaluationStatus.MANUAL);
    expect(twoApplications.analysis.mechanisms).toEqual([]);
    expect(twoApplications.analysis.actuator.map(application => [application.root, application.problems.length])).toEqual([['a/', 0], ['b/', 1]]);
  });

  const HEALTH_CONTROLLER = { 'src/main/java/org/folio/example/HealthController.java': '@RestController\npublic class HealthController {\n  @GetMapping("/admin/health")\n  public String health() { return "OK"; }\n}\n' };
  const profiles = Array.from({ length: 101 }, (_unused, index) => `---\nspring.profiles: p${index}\nlogging.level.root: info\n`).join('');
  it.each([
    ['no web server', { [PROPERTIES]: 'spring.main.web-application-type=none\n' }, [[PROPERTIES, 1, 'spring.main.web-application-type is none, so the application starts no web server']]],
    ['HTTP turned off', { [PROPERTIES]: 'server.port=-1\n' }, [[PROPERTIES, 1, 'server.port is -1, so the application serves no HTTP']]],
    ['imported configuration', { [PROPERTIES]: 'spring.config.import=classpath:more.yml\n' }, [[PROPERTIES, 1, 'spring.config.import reads configuration the tool does not read']]],
    ['a Dockerfile that turns HTTP off', { Dockerfile: 'FROM x\nENV SERVER_PORT=-1\n' }, [['Dockerfile', 2, 'the Dockerfile sets SERVER_PORT=-1, which the tool does not read']]],
    ['a Dockerfile that turns HTTP off with a quoted value', { Dockerfile: 'FROM x\nENV SERVER_PORT="-1"\n' }, [['Dockerfile', 2, 'the Dockerfile sets SERVER_PORT="-1, which the tool does not read']]],
    ['a Dockerfile with a dotted lowercase name', { Dockerfile: 'FROM x\nENV management.server.port=9090\n' }, [['Dockerfile', 2, 'the Dockerfile sets management.server.port, which the tool does not read']]],
    ['a YAML alias', { [YML]: 'defaults: &d\n  context-path: /x\nserver:\n  servlet: *d\n' }, [[YML, 4, 'server.servlet is a YAML alias or merge, which the tool does not resolve']]],
    ['a context path from a placeholder', { [PROPERTIES]: 'server.servlet.context-path=${CONTEXT_PATH:}\n' }, [[PROPERTIES, 1, 'server.servlet.context-path is set from ${CONTEXT_PATH:}, which the deployment decides']]],
    ['YAML the tool cannot parse', { [YML]: 'server:\n  servlet: [\n' }, [[YML, 3, 'the tool could not parse this file as YAML (Flow sequence in block collection must be sufficiently indented and end with a ] at line 3, column 1:)']]],
    ['too many profiles', { [YML]: profiles }, [[undefined, undefined, 'the configuration has 101 profile documents, files or Grails environments, and the tool checked only the first 100']]]
  ] as Array<[string, Record<string, string>, Array<[string | undefined, number | undefined, string]>]>)('does not count a route with %s', async (_name, files, problems) => {
    const { analysis } = await b014(springModule({ ...HEALTH_CONTROLLER, ...files }));

    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.mechanisms).toEqual([]);
    expect(analysis.actuator[0].problems.filter(problem => !problem.note.startsWith(KEY_BASE_PATH))).toEqual(problems.map(([path, line, note]) => ({
      ...(path ? { path } : {}), ...(line ? { line } : {}), note
    })));
  });

  it('does not count a route when configuration could not be read or is Groovy', async () => {
    const unread = await b014(springModule({ ...HEALTH_CONTROLLER, [YML]: `# ${'x'.repeat(1024 * 1024)}\n` }));
    const grails = await b014({
      ...TEMPLATE,
      'build.gradle': 'implementation "org.folio:folio-spring-base:9.0.0"\n',
      'grails-app/conf/application.groovy': 'server.servlet.contextPath = "/x"\n',
      'grails-app/controllers/UrlMappings.groovy': 'class UrlMappings {\n  static mappings = {\n    "/admin/health"(controller: "health", action: "index", method: "GET")\n  }\n}\n'
    });

    expect(unread.analysis.mechanisms).toEqual([]);
    expect(unread.analysis.actuator[0].problems[0]).toEqual({ path: YML, note: 'the tool could not read this configuration file (Committed file exceeds the 1048576-byte per-file limit)' });
    expect(grails.analysis.mechanisms).toEqual([]);
    expect(grails.analysis.actuator[0].problems[0]).toEqual({
      path: 'grails-app/conf/application.groovy', line: 1, note: 'Groovy configuration sets management, server or spring settings, which the tool does not read'
    });
  });

  it('does not count a route outside every application when an application puts a prefix before every path', async () => {
    const { result } = await b014({
      ...TEMPLATE,
      'pom.xml': pom('mod-example', `<dependencies>${ACTUATOR}</dependencies>`),
      'service/src/main/java/App.java': springApplication,
      'service/src/main/resources/application.properties': `${ADMIN}server.servlet.context-path=/x\n`,
      'common/src/main/java/org/folio/example/HealthController.java': HEALTH_CONTROLLER['src/main/java/org/folio/example/HealthController.java']
    });

    expect(result.status).toBe(EvaluationStatus.MANUAL);
  });

  it('caps the problems listed per application and counts the rest', async () => {
    const placeholders = Array.from({ length: 60 }, (_unused, index) => `management.endpoints.web.exposure.include[${index}]=\${H${index}}\n`).join('');
    const { result, analysis, rows } = await b014(springModule({ [PROPERTIES]: `${ADMIN}${placeholders}` }));

    expect(analysis.actuator[0].problems).toHaveLength(50);
    expect(analysis.actuator[0].problemCount).toBe(60);
    expect(result.evidence).toContain('management.endpoints.web.exposure.include[2] is set from ${H2}, which the deployment decides, and 57 more. ');
    expect(rows).toContain('  - ... 40 more');
  });

  it('describes profile activation by key and escapes profile names from file paths', async () => {
    const { analysis } = await b014(springModule({
      [YML]: `${ADMIN_YAML}---\nspring.config.activate.on-profile: prod\nspring.config.activate.on-cloud-platform: kubernetes\nserver.port: -1\n`,
      'src/main/resources/application-a\u202eb.properties': 'server.port=-1\n'
    }));

    expect(analysis.actuator[0].problems.map(problem => problem.condition)).toEqual([
      'when spring.config.activate.on-profile is prod and spring.config.activate.on-cloud-platform is kubernetes',
      'when the profile a%E2%80%AEb is active'
    ]);
  });

  it('does not resolve list-form merge keys', async () => {
    const root = await b014(springModule({ [YML]: 'defaults: &d\n  management.server.port: 9090\n<<: [*d]\nmanagement.endpoints.web.base-path: /admin\n' }));
    const nested = await b014(springModule({ [YML]: 'd: &d\n  port: 9090\nmanagement:\n  server:\n    <<: [*d]\n  endpoints.web.base-path: /admin\n' }));

    expect(root.analysis.actuator[0].problems).toEqual([{ path: YML, line: 3, note: 'the top level of the document is a YAML alias or merge, which the tool does not resolve' }]);
    expect(nested.analysis.actuator[0].problems).toEqual([{ path: YML, line: 5, note: 'management.server is a YAML alias or merge, which the tool does not resolve' }]);
  });

  it('does not resolve a YAML alias used as a key', async () => {
    const { analysis } = await b014(springModule({ [YML]: 'k: &k server.port\nmanagement:\n  *k : 9090\n  endpoints.web.base-path: /admin\n' }));

    expect(analysis.actuator[0].problems).toEqual([{ path: YML, line: 3, note: 'management is a YAML alias or merge, which the tool does not resolve' }]);
  });

  it('leaves management settings in a Dockerfile to the reviewer', async () => {
    const { analysis } = await b014(springModule({
      [YML]: ADMIN_YAML,
      Dockerfile: 'FROM eclipse-temurin:21\n# ENV SPRING_MAIN_BANNER_MODE=off\nENV MANAGEMENT_SERVER_PORT=9090\n'
    }));

    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.actuator[0].problems).toEqual([{ path: 'Dockerfile', line: 3, note: 'the Dockerfile sets MANAGEMENT_SERVER_PORT, which the tool does not read' }]);
  });

  it('passes an RMB module from its main verticle, not from an RMB schema alone', async () => {
    const rmb = await b014({ ...TEMPLATE, 'pom.xml': pom('mod-example', restVerticleBuild) });
    const schemaOnly = await b014({ ...TEMPLATE, 'pom.xml': pom('mod-example'), 'src/main/resources/templates/db_scripts/schema.json': '{}' });

    expect(rmb.result.evidence).toBe('B014 pass: RMB\'s RestVerticle, the main verticle in pom.xml:1, serves GET /admin/health. The tool found the mechanism in the build file and did not call the endpoint.');
    expect(rmb.rows).toEqual([
      'Health check: GET /admin/health was not called; the result comes from the committed files',
      'Found:',
      '  - RMB: pom.xml:1 — org.folio.rest.RestVerticle is the main verticle, and RMB serves GET /admin/health'
    ]);
    expect(schemaOnly.result.evidence).toBe('B014 manual: The tool found no RMB RestVerticle main verticle, no Spring Boot or Grails application, and no GET /admin/health route in the source. '
      + 'A reviewer must check that the module answers GET /admin/health with 200.');
    expect(schemaOnly.rows).toEqual([
      'Health check: GET /admin/health was not called; the result comes from the committed files',
      'Checklist for the reviewer:',
      CHECKLIST_TITLE
    ]);
  });

  it('passes an edge module that routes GET /admin/health, but not a commented-out or POST route', async () => {
    const edge = (source: string) => b014({
      ...TEMPLATE,
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      'src/main/java/org/folio/edge/example/MainVerticle.java': `class MainVerticle extends EdgeVerticleHttp {\n  void routes(Router router) {\n${source}\n  }\n}\n`
    });

    const routed = await edge('    router.route(HttpMethod.GET, "/admin/health").handler(this::health);');
    const other = await edge('    // router.get("/admin/health").handler(this::health);\n    router.post("/admin/health").handler(this::health);\n    router.get(path()).handler(this::other);');

    expect(routed.result.evidence).toBe('B014 pass: The source registers GET /admin/health (src/main/java/org/folio/edge/example/MainVerticle.java:3). The tool found the mechanism in the source and did not call the endpoint.');
    expect(routed.analysis.kind).toBe('edge-module');
    expect(other.result.evidence).toBe('B014 manual: The tool found no RMB RestVerticle main verticle, no Spring Boot or Grails application, and no GET /admin/health route in the source. '
      + 'It could not read 1 route in the source, which may serve it. A reviewer must check that the module answers GET /admin/health with 200.');
    expect(other.rows).toEqual([
      'Health check: GET /admin/health was not called; the result comes from the committed files',
      'Routes the tool could not read:',
      '  - src/main/java/org/folio/edge/example/MainVerticle.java:5',
      'Checklist for the reviewer:',
      CHECKLIST_TITLE,
      '    - Start with:',
      '      - src/main/java/org/folio/edge/example/MainVerticle.java:5 — route whose path the tool could not read'
    ]);
  });

  it('counts a route over a Spring actuator that does not serve /admin/health', async () => {
    const { result, rows } = await b014(springModule({
      'src/main/java/org/folio/example/HealthController.java': '@RestController\npublic class HealthController {\n  @GetMapping("/admin/health")\n  public String health() { return "OK"; }\n}\n'
    }));

    expect(result.evidence).toBe('B014 pass: The source registers GET /admin/health (src/main/java/org/folio/example/HealthController.java:3). The tool found the mechanism in the source and did not call the endpoint.');
    expect(rows).toEqual([
      'Health check: GET /admin/health was not called; the result comes from the committed files',
      'Found:',
      '  - Route: src/main/java/org/folio/example/HealthController.java:3 — GET /admin/health',
      'Actuator not counted for the Spring Boot application:',
      `  - ${APPLICATION} — management.endpoints.web.base-path is not set, so actuator serves health at /actuator/health`
    ]);
  });

  it('is not applicable to a shared library and manual for a repository not known to be a module', async () => {
    const library = await b014({ 'pom.xml': pom('folio-spring-base', restVerticleBuild) });
    const ambiguous = await b014({ 'pom.xml': pom('mod-example', restVerticleBuild) });

    expect(library.result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(library.result.evidence).toBe('B014 not_applicable: The repository is a shared library, which is not deployed on its own and serves no health check.');
    expect(library.rows).toEqual(['Health check: not applicable to a shared library']);
    expect(ambiguous.result.evidence).toBe('B014 manual: No module descriptor was found and the repository is not a known shared library, so the tool cannot tell whether it is a module that must serve GET /admin/health (see B001). '
      + 'It found RMB in pom.xml:1. A reviewer must check it.');
    expect(ambiguous.analysis.basis).toBe('ambiguous');
    expect(ambiguous.analysis.checklist.items[0].startingPoints).toEqual([
      { path: 'pom.xml', line: 1, note: 'org.folio.rest.RestVerticle is the main verticle, and RMB serves GET /admin/health' }
    ]);
  });

  it('reads configuration, build files and sources in linear time', async () => {
    const evidence = (size: number): BackendEvidence => {
      const files = [
        { path: 'pom.xml', content: `${'>'.repeat(size)}${' '.repeat(size)}<dependency><artifactId>${' '.repeat(size)}x`.repeat(4) + '<!-- -->'.repeat(size)
          + `${'<exclusions>'.repeat(size)}</exclusions><dependency><artifactId>folio-spring-base</artifactId></dependency>` },
        { path: 'build.gradle', content: `${'implementation spring '.repeat(size)}\n${'/* x */ '.repeat(size)}\n` },
        { path: 'Dockerfile', content: `${'MANAGEMENT'.repeat(size)}\n${'-D'.repeat(size)}\n` },
        { path: `${'a/'.repeat(size / 10)}src/main/java/App.java`, content: `${'\n'.repeat(size)}${' '.repeat(size)}x\n@SpringBootApplication class App {}` },
        { path: `${'a/'.repeat(size / 10)}src/main/resources/application-${'p'.repeat(200)}.properties`,
          content: `${'\\'.repeat(size)}x\n${'k\\\\'.repeat(size)}\n${'@a'.repeat(size)}\n${'key\\\n'.repeat(size)}=v\n#---\n`.repeat(2)
            + `${'[[1['.repeat(size)}=x\n${'[a]'.repeat(size)}=x\n${'\\u00'.repeat(size)}=x\nk[]=${','.repeat(size)}\n` },
        { path: `${'a/'.repeat(size / 10)}src/main/resources/application.yml`,
          content: `management:\n  endpoints:\n    web:\n      base-path: /admin\n      exposure:\n        include:\n${'          - info\n'.repeat(size)}` + '---\nspring.profiles: p\nmanagement.server.port: 1\n'.repeat(Math.min(size, 150)) },
        { path: 'grails-app/conf/application.groovy', content: `${'servers '.repeat(size)}` }
      ].map(file => ({ ...file, oid: '0', size: file.content.length }));
      return {
        kind: 'backend-module', kindEvidence: [], moduleKind: { kind: 'backend-module', evidence: [] }, templateCandidates: [],
        framework: { name: 'spring', evidence: [] }, storage: { present: false, evidence: [] },
        snapshot: { revision: '0', files, diagnostics: [], complete: true }
      } as unknown as BackendEvidence;
    };

    const analysis = await expectLinearTime(4_000, evidence, async backendEvidence => evaluateB014(backendEvidence));

    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.actuator.map(application => application.framework)).toEqual(['grails', 'spring']);
    expect(analysis.actuator[1].problems.map(problem => problem.note)).toEqual([
      'management.endpoints.web.exposure.include does not include health',
      'the configuration has 153 profile documents, files or Grails environments, and the tool checked only the first 100',
      'management.server.port is 1, so actuator does not listen on the module\'s port'
    ]);
  }, 120_000);
});
