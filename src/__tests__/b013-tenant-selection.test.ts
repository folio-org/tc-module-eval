import * as fs from 'fs';
import * as path from 'path';
import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B013Analysis, BackendEvidence, CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus } from '../types';
import { buildB013AgentReviewRequest } from '../utils/b013-agent-review';
import { evaluateB013 } from '../utils/b013-tenant-selection';
import { backendBrowse } from '../utils/backend-agent-review';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, git, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b013(root: string, agentReview?: CriterionAgentReviewConfig) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java', ...(agentReview ? { agentReview } : {}) });
  const result = await new BackendEvaluator().evaluateCriterion('B013', root, run);
  return { result, analysis: result.criterionDetails as B013Analysis };
}

const descriptor = { 'descriptors/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0", "provides": []}' };
const CONFIRM = 'A reviewer must confirm that every request uses the tenant from X-Okapi-Tenant, that no tenant comes from '
  + 'configuration or shared state, and that Kafka consumers and scheduled jobs set the tenant.';
const WHAT_TO_DO = ['What to do:', '  - Work through the checklist below, and change any request handler, Kafka consumer or scheduled job that selects tenant data by a tenant other than the one in X-Okapi-Tenant.'];
const obligationIds = (analysis: B013Analysis) => analysis.checklist.items.map(item => item.obligations.map(obligation => obligation.subject ?? obligation.id));

describe('B013 tenant selection', () => {
  it('lists a Spring module\'s FolioExecutionContext, caches without a tenant key, and its Kafka consumers and scheduled jobs', async () => {
    const { result, analysis } = await b013(repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('folio-spring-base')}</dependencies>`),
      ...descriptor,
      'src/main/java/org/example/Application.java': '@SpringBootApplication\npublic class Application {}\n',
      'src/main/java/org/example/ItemService.java': [
        'package org.example;',
        '',
        'import org.folio.spring.FolioExecutionContext;',
        '',
        'public class ItemService {',
        '  private final FolioExecutionContext context;',
        '',
        '  @Cacheable(cacheNames = "items",',
        '    key = "\'items\'.concat(\'_\').concat(@folioExecutionContext.getTenantId())")',
        '  public Item item() { return null; }',
        '',
        '  @Cacheable(value = "types", key = "#id")',
        '  public Type type(String id) { return null; }',
        '  @Cacheable(cacheNames = names(), key = "@folioExecutionContext.tenantId")',
        '  public Type named() { return null; }',
        '  // @Cacheable("commented") @KafkaListener FolioExecutionContext',
        '}'
      ].join('\n'),
      'src/main/java/org/example/OnlyImport.java': 'import org.folio.spring.FolioExecutionContext;\nimport org.springframework.kafka.annotation.KafkaListener;\npublic class OnlyImport {}\n',
      'src/main/java/org/example/Listener.java': [
        'public class Listener {',
        '  @KafkaListener(topics = "items")',
        '  public void handle(String event) {}',
        '',
        '  @Scheduled(fixedDelay = 1000)',
        '  public void cleanup() {}',
        '}'
      ].join('\n'),
      'src/main/java/org/example/CacheConfig.java': 'public class CacheConfig {\n  Object cache = Caffeine.newBuilder();\n}\n',
      'src/main/java/org/example/TenantCache.java': 'public class TenantCache {\n  Object cache = Caffeine.newBuilder();\n  Object get(String tenantId) { return null; }\n}\n'
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B013 manual: Requests use folio-spring-base\'s FolioExecutionContext, which reads X-Okapi-Tenant. '
      + `The tool found 2 caches without a tenant in the key, Kafka consumers in 1 file, and scheduled jobs or timers in 1 file. ${CONFIRM}`);
    expect(result.details?.split('\n')).toEqual([
      'Framework: Spring Boot',
      'Tenant taken from X-Okapi-Tenant:',
      '  - folio-spring-base\'s FolioExecutionContext — 1 reference in 1 file',
      'Possible tenant problems:',
      '  - src/main/java/org/example/CacheConfig.java:2 — cache without a tenant in its key: Caffeine.newBuilder();',
      '  - src/main/java/org/example/ItemService.java:12 — cache without a tenant in its key: @Cacheable(value = "types", key = "#id")',
      'Work outside requests:',
      '  - Kafka consumers — 1 reference in 1 file',
      '  - Scheduled jobs or timers — 1 reference in 1 file',
      ...WHAT_TO_DO,
      'Checklist for the reviewer:',
      '  - B013-C1 Every request reads the tenant from X-Okapi-Tenant.',
      '    - Start with:',
      '      - src/main/java/org/example/ItemService.java:6 — folio-spring-base\'s FolioExecutionContext',
      '  - B013-C2 No tenant comes from configuration or shared state.',
      '    - Start with:',
      '      - src/main/java/org/example/CacheConfig.java:2 — cache without a tenant in its key: Caffeine.newBuilder();',
      '      - src/main/java/org/example/ItemService.java:12 — cache without a tenant in its key: @Cacheable(value = "types", key = "#id")',
      '  - B013-C3 Asynchronous work (Kafka consumers, timers) carries the tenant.',
      '    - Start with:',
      '      - src/main/java/org/example/Listener.java:2 — Kafka consumer',
      '      - src/main/java/org/example/Listener.java:5 — scheduled job or timer',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
    expect(obligationIds(analysis)).toEqual([
      ['B013-C1#1'],
      ['src/main/java/org/example/CacheConfig.java:2 (cache without a tenant in its key)', 'src/main/java/org/example/ItemService.java:12 (cache without a tenant in its key)'],
      ['src/main/java/org/example/Listener.java:2 (Kafka consumer)', 'src/main/java/org/example/Listener.java:5 (scheduled job or timer)']
    ]);
  });

  it('lists an RMB module\'s TenantTool, PgUtil and header reads, and tenants from configuration or static fields', async () => {
    const { result } = await b013(repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      ...descriptor,
      'src/main/java/org/folio/rest/impl/ItemsAPI.java': [
        'package org.folio.rest.impl;',
        '',
        'public class ItemsAPI {',
        '  private static final String TENANT_HEADER = "x-okapi-tenant";',
        '  private static String currentTenant;',
        '  static volatile Map<String, String> tenantIds = new HashMap<>();',
        '  private static final Logger log = LogManager.getLogger();',
        '',
        '  public void getItems(Map<String, String> okapiHeaders) {',
        '    String tenantId = TenantTool.tenantId(okapiHeaders);',
        '    PgUtil.get("items", okapiHeaders);',
        '    String fallback = System.getenv("DEFAULT_TENANT_ID");',
        '    String host = System.getenv("DB_HOST");',
        '    String header = okapiHeaders.get(XOkapiHeaders.TENANT);',
        '    String doc = "use static String tenantId; carefully";',
        '  }',
        '}'
      ].join('\n'),
      'src/main/resources/application.yml': [
        'folio:',
        '  tenant: # nested',
        '    validation: true',
        '  default-tenant: diku',
        '  tenantId: ${TENANT_ID:diku}',
        'logging:',
        '  tenant-pattern: "%t"'
      ].join('\n'),
      'src/main/resources/config.properties': [
        '# tenant=commented',
        'folio.tenant.validation.enabled=true',
        'appender.layout.tenantId.key = tenantId',
        'tenants=diku,college',
        'lieutenant=x'
      ].join('\n'),
      'src/main/resources/examples/item.yaml': 'tenantId: diku\n',
      'src/main/resources/openapi.yaml': 'openapi: 3.0.0\ninfo:\n  tenantId: diku\n'
    }));

    expect(result.evidence).toBe('B013 manual: Requests use RMB\'s TenantTool and RMB\'s PgUtil, which read X-Okapi-Tenant, and the code also names the header itself. '
      + `The tool found 4 tenants named in configuration and 2 static tenant fields. ${CONFIRM}`);
    expect(result.details?.split('\n')).toEqual([
      'Framework: RAML Module Builder (RMB)',
      'Tenant taken from X-Okapi-Tenant:',
      '  - RMB\'s TenantTool — 1 reference in 1 file',
      '  - RMB\'s PgUtil — 1 reference in 1 file',
      '  - the X-Okapi-Tenant header by name — 2 references in 1 file',
      'Possible tenant problems:',
      '  - src/main/java/org/folio/rest/impl/ItemsAPI.java:5 — static tenant field: private static String currentTenant;',
      '  - src/main/java/org/folio/rest/impl/ItemsAPI.java:6 — static tenant field: static volatile Map<String, String> tenantIds =',
      '  - src/main/java/org/folio/rest/impl/ItemsAPI.java:12 — tenant from configuration: System.getenv("DEFAULT_TENANT_ID")',
      '  - src/main/resources/application.yml:4 — tenant from configuration: default-tenant: diku',
      '  - src/main/resources/application.yml:5 — tenant from configuration: tenantId: ${TENANT_ID:diku}',
      '  - src/main/resources/config.properties:4 — tenant from configuration: tenants=diku,college',
      'Work outside requests:',
      '  - none found',
      ...WHAT_TO_DO,
      'Checklist for the reviewer:',
      '  - B013-C1 Every request reads the tenant from X-Okapi-Tenant.',
      '    - Start with:',
      '      - src/main/java/org/folio/rest/impl/ItemsAPI.java:10 — RMB\'s TenantTool',
      '      - src/main/java/org/folio/rest/impl/ItemsAPI.java:11 — RMB\'s PgUtil',
      '      - src/main/java/org/folio/rest/impl/ItemsAPI.java:4 — the X-Okapi-Tenant header by name',
      '  - B013-C2 No tenant comes from configuration or shared state.',
      '    - Start with:',
      '      - src/main/java/org/folio/rest/impl/ItemsAPI.java:5 — static tenant field: private static String currentTenant;',
      '      - src/main/java/org/folio/rest/impl/ItemsAPI.java:6 — static tenant field: static volatile Map<String, String> tenantIds =',
      '      - src/main/java/org/folio/rest/impl/ItemsAPI.java:12 — tenant from configuration: System.getenv("DEFAULT_TENANT_ID")',
      '      - src/main/resources/application.yml:4 — tenant from configuration: default-tenant: diku',
      '      - src/main/resources/application.yml:5 — tenant from configuration: tenantId: ${TENANT_ID:diku}',
      '      - src/main/resources/config.properties:4 — tenant from configuration: tenants=diku,college',
      '  - B013-C3 Asynchronous work (Kafka consumers, timers) carries the tenant.',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
  });

  it('reads Grails tenants and @Value tenant properties, and a tenant named in Grails configuration', async () => {
    const { result } = await b013(repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0", "provides": []}',
      'service/grails-app/services/org/example/HarvestService.groovy': [
        'class HarvestService {',
        '  @Value(\'${okapi.tenant}\') String name',
        '  @Value("${okapi.service.name}") String service',
        '  @Value("${folio.default-tenant:diku}") String tenant',
        '  @Value("${header.x-okapi-tenant.exclude}") String excluded',
        '  def run(String tenantId) {',
        '    Tenants.withId(tenantId) { }',
        '  }',
        '}'
      ].join('\n'),
      'service/grails-app/conf/application.yml': 'grails:\n  gorm:\n    multiTenancy:\n      tenantResolverClass: com.k_int.okapi.OkapiTenantResolver\n      tenantId: public # resolver default\n'
    }));

    expect(result.evidence).toBe('B013 manual: Requests use grails-okapi\'s OkapiTenantResolver with GORM\'s Tenants, which reads X-Okapi-Tenant. '
      + `The tool found 3 tenants named in configuration. ${CONFIRM}`);
    expect(result.details?.split('\n').slice(0, 7)).toEqual([
      'Framework: Grails',
      'Tenant taken from X-Okapi-Tenant:',
      '  - grails-okapi\'s OkapiTenantResolver with GORM\'s Tenants — 1 reference in 1 file',
      'Possible tenant problems:',
      '  - service/grails-app/conf/application.yml:5 — tenant from configuration: tenantId: public # resolver default',
      '  - service/grails-app/services/org/example/HarvestService.groovy:2 — tenant from configuration: @Value(\'${okapi.tenant}\'',
      '  - service/grails-app/services/org/example/HarvestService.groovy:4 — tenant from configuration: @Value("${folio.default-tenant:diku}"'
    ]);
  });

  it('says an edge module maps API keys to tenants, and that no tenant resolution was found where the code has none', async () => {
    const edge = await b013(repository({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      ...descriptor,
      'src/main/java/org/folio/edge/example/Client.java': 'class Client {\n  String secure() { return System.getenv().getOrDefault(SECURE_TENANT_ID, "secure"); }\n}\n'
    }));
    expect(edge.result.evidence).toBe('B013 manual: As an edge module, it relies on edge-common to map each API key to a tenant, which it passes on in X-Okapi-Tenant. '
      + `The tool found 1 tenant named in configuration. ${CONFIRM}`);

    const none = await b013(repository({
      'pom.xml': pom('mod-example'),
      'src/main/java/org/example/Main.java': [
        'import org.folio.okapi.common.XOkapiHeaders;',
        'class Main {',
        '  // String tenant = TenantTool.tenantId(okapiHeaders);',
        '  /* @KafkaListener @Scheduled System.getenv("TENANT") */',
        '  String text = "no X-Okapi-Tenant here";',
        '}'
      ].join('\n')
    }));
    expect(none.result.status).toBe(EvaluationStatus.MANUAL);
    expect(none.result.evidence).toBe('B013 manual: The repository is not a known module or library, so it is checked as a module. '
      + 'The tool found no code that takes the tenant from X-Okapi-Tenant. '
      + `The tool found no tenant from configuration, static tenant field, cache without a tenant key, Kafka consumer or scheduled job. ${CONFIRM}`);
    expect(obligationIds(none.analysis)).toEqual([['B013-C1#1'], ['B013-C2#1'], ['B013-C3#1']]);
  });

  it('reads CRLF configuration, tenant id and name keys, and final fields that fix a tenant', async () => {
    const { analysis } = await b013(repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      ...descriptor,
      'src/main/resources/application.yml': 'folio:\r\n  tenantId: diku\r\n  tenant.id: college\r\n  user.id: x\r\n',
      'src/main/resources/system.properties': 'system.tenant.name=diku\r\nsystem.user.name=admin\r\n',
      'src/main/java/org/folio/Constants.java': [
        'class Constants {',
        '  private static final String DEFAULT_TENANT = "diku";',
        '  private static final String TENANT_HEADER = "x-okapi-tenant";',
        '  public static final String TENANT = "X-Okapi-Tenant";',
        '  static final String TENANT_ID = "tenantId";',
        '  static final String DELETE_FOR_TENANT = "delete from items";',
        '  static final String CENTRAL_TENANT_ID = "central_tenant_id";',
        '  static final Map<String, String> TENANTS = new HashMap<>();',
        '  @Value("${folio.tenant.id}") String tenant;',
        '}'
      ].join('\n')
    }));

    expect(analysis.redFlags).toEqual([
      { kind: 'static-tenant', path: 'src/main/java/org/folio/Constants.java', line: 2, text: 'private static final String DEFAULT_TENANT =' },
      { kind: 'configured-tenant', path: 'src/main/java/org/folio/Constants.java', line: 9, text: '@Value("${folio.tenant.id}"' },
      { kind: 'configured-tenant', path: 'src/main/resources/application.yml', line: 2, text: 'tenantId: diku' },
      { kind: 'configured-tenant', path: 'src/main/resources/application.yml', line: 3, text: 'tenant.id: college' },
      { kind: 'configured-tenant', path: 'src/main/resources/system.properties', line: 1, text: 'system.tenant.name=diku' }
    ]);
  });

  it('is not applicable to a shared library', async () => {
    const { result, analysis } = await b013(repository({
      'pom.xml': pom('folio-spring-base'),
      'src/main/java/org/folio/spring/Context.java': 'class Context { private static String tenantId; }\n'
    }));

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.evidence).toBe('B013 not_applicable: The repository is a shared library, which serves no tenant requests of its own.');
    expect(result.details).toBe('Framework: shared library');
    expect(analysis.checklist.items).toEqual([]);
  });

  it('says when the committed source was not read completely', async () => {
    const root = repository({ 'pom.xml': pom('mod-example', restVerticleBuild), ...descriptor });
    fs.mkdirSync(path.join(root, 'src/main/resources'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/main/resources/application.properties'), `tenantId=${'x'.repeat(1024 * 1024)}\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'large');

    const { result } = await b013(root);

    expect(result.evidence).toBe('B013 manual: The tool found no code that takes the tenant from X-Okapi-Tenant. '
      + `The tool found no tenant from configuration, static tenant field, cache without a tenant key, Kafka consumer or scheduled job. ${CONFIRM} `
      + 'Not all committed source could be read, so the tool may have missed some of these.');
    expect(result.details?.split('\n').slice(7, 9)).toEqual([
      'What the tool could not read:',
      '  - src/main/resources/application.properties — Committed file exceeds the 1048576-byte per-file limit'
    ]);
  });

  it('keeps the first 100 possible problems and counts the rest, and always gives the agent request handling', async () => {
    const lines = Array.from({ length: 105 }, (_unused, index) => `app${index}.tenantId=diku`);
    const { result, analysis } = await b013(repository({
      'pom.xml': pom('mod-example', restVerticleBuild), ...descriptor, 'src/main/resources/application.properties': lines.join('\n'),
      'src/main/java/org/folio/rest/impl/ItemsAPI.java': 'class ItemsAPI { void get(Map<String, String> h) { TenantTool.tenantId(h); } }\n',
      'src/main/java/org/folio/Consumer.java': 'class Consumer {\n  @KafkaListener(topics = "items")\n  void handle(String event) {}\n}\n'
    }));

    expect(analysis.redFlags).toHaveLength(100);
    expect(analysis.redFlagCount).toBe(105);
    const obligations = analysis.checklist.items.flatMap(item => item.obligations);
    expect(obligations.filter(obligation => !obligation.withheld).map(obligation => obligation.subject ?? obligation.id)).toEqual([
      'B013-C1#1',
      ...Array.from({ length: 23 }, (_unused, index) => `src/main/resources/application.properties:${index + 1} (tenant from configuration)`),
      'src/main/java/org/folio/Consumer.java:2 (Kafka consumer)'
    ]);
    expect(obligations.filter(obligation => obligation.withheld)).toHaveLength(77);
    expect(result.evidence).toBe(`B013 manual: Requests use RMB's TenantTool, which reads X-Okapi-Tenant. The tool found 100 tenants named in configuration, 5 more possible tenant problems, and Kafka consumers in 1 file. ${CONFIRM}`);
    const details = result.details!.split('\n');
    expect(details.slice(details.indexOf('Possible tenant problems:') + 20, details.indexOf('Possible tenant problems:') + 23)).toEqual([
      '  - src/main/resources/application.properties:20 — tenant from configuration: app19.tenantId=diku',
      '  - ... 85 more',
      'Work outside requests:'
    ]);
  });

  describe('agent review', () => {
    const ITEMS = 'src/main/java/org/folio/rest/impl/ItemsAPI.java';
    const CONSUMER = 'src/main/java/org/folio/Consumer.java';
    const module = () => repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      ...descriptor,
      [ITEMS]: 'class ItemsAPI {\n  private static String currentTenant;\n  void get(Map<String, String> okapiHeaders) { TenantTool.tenantId(okapiHeaders); }\n}\n',
      [CONSUMER]: 'class Consumer {\n  @KafkaListener(topics = "items")\n  void handle(String event) {}\n}\n',
      'src/test/java/ItemsTest.java': 'class ItemsTest {}\n',
      'docs/tenants.md': '# tenants\n'
    });
    const assessment = (technologyId: string, fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
      technologyId, type: 'aligned_fact', summary: 'The tenant comes from the request.', evidenceReferences: [ITEMS], coverageDisposition: 'investigated', ...fields
    });
    const fakeConfig = (fields: Record<string, unknown>, enabledCriteria: string[] | undefined = ['B013']): CriterionAgentReviewConfig => ({
      enabled: true, ...(enabledCriteria ? { enabledCriteria } : {}), adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
        available: true, criterionId: 'B013', recommendation: 'likely_insufficient', confidence: 'medium', summary: 'A static field holds the tenant.',
        rationale: 'Read ItemsAPI and Consumer.', evidenceReferences: [ITEMS], warnings: [], errors: [], reviewerActions: [], ...fields
      } as CriterionAgentReviewConfig['fakeResult']
    });
    const concern = assessment('B013-C2#1', { type: 'substantive_concern', summary: 'currentTenant is shared by every request.' });
    const C2_HEAD = [
      '  - B013-C2 No tenant comes from configuration or shared state.',
      '    - Start with:',
      `      - ${ITEMS}:2 — static tenant field: private static String currentTenant;`
    ];
    const rowsFrom = (details: string | undefined, heading: string, count: number) => {
      const lines = (details ?? '').split('\n');
      return lines.slice(lines.indexOf(heading), lines.indexOf(heading) + count);
    };

    it('gives the agent the backend scope and one obligation for requests, per possible problem (flagged first) and per async file', async () => {
      const root = module();
      const { analysis } = await b013(root);
      const prepared = await prepareCriterionAgentReviewEvidence(buildB013AgentReviewRequest(root, analysis));

      expect([...prepared.availableSourcePaths].sort()).toEqual(['descriptors/ModuleDescriptor-template.json', 'pom.xml', CONSUMER, ITEMS]);
      expect(prepared.request.instructions).toContain(`You may browse only: ${backendBrowse().scope}.`);
      const checklist = JSON.parse(prepared.request.files.find(file => file.repoRelativePath === '.criterion-agent/B013/checklist.json')!.content);
      expect(checklist.items.flatMap((item: { obligations: unknown[] }) => item.obligations)).toEqual([
        { id: 'B013-C1#1' },
        { id: 'B013-C2#1', subject: `${ITEMS}:2 (static tenant field)`, path: ITEMS, line: 2, flag: 'manual' },
        { id: 'B013-C3#1', subject: `${CONSUMER}:2 (Kafka consumer)`, path: CONSUMER, line: 2, flag: 'manual' }
      ]);
    });

    it('attaches an accepted review to the checklist items and keeps the status', async () => {
      const { result } = await b013(module(), fakeConfig({ assessments: [
        assessment('B013-C1#1'), concern, assessment('B013-C3#1', { summary: 'The consumer sets the tenant from the record header.', evidenceReferences: [CONSUMER] })
      ], reviewerActions: [{ action: 'Check whether currentTenant is read by another request.', evidenceReferences: [ITEMS] }] }));

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.agentReview?.available).toBe(true);
      expect(rowsFrom(result.details, C2_HEAD[0], 8)).toEqual([...C2_HEAD,
        `    - Agent: Potential problem — ${ITEMS}:2 (static tenant field): currentTenant is shared by every request.`,
        '      - Sources:',
        `        - ${ITEMS}`,
        '      - Coverage judgment: Investigated directly',
        '  - B013-C3 Asynchronous work (Kafka consumers, timers) carries the tenant.'
      ]);
      expect(result.details?.split('\n')).toContain(`Agent review scope: ${backendBrowse().scope}`);
      expect(result.details?.split('\n').slice(-1)).toEqual(['  - Advisory only; the criterion status is unchanged.']);
    });

    it('drops an assessment that does not cite the file it is about, on its own', async () => {
      const { result } = await b013(module(), fakeConfig({ assessments: [
        assessment('B013-C1#1'), concern, assessment('B013-C3#1', { summary: 'The consumer sets the tenant.' })
      ] }, undefined));

      expect(result.agentReview?.assessments?.map(kept => kept.technologyId)).toEqual(['B013-C1#1', 'B013-C2#1']);
      expect(rowsFrom(result.details, '  - B013-C3 Asynchronous work (Kafka consumers, timers) carries the tenant.', 5)).toEqual([
        '  - B013-C3 Asynchronous work (Kafka consumers, timers) carries the tenant.',
        '    - Start with:',
        `      - ${CONSUMER}:2 — Kafka consumer`,
        `    - Agent result dropped — ${CONSUMER}:2 (Kafka consumer): It is marked as investigated directly but does not cite the file it is about.`,
        'Agent review (advisory):'
      ]);
    });

    it('says why a review that returned nothing usable was not applied', async () => {
      const { result } = await b013(module(), fakeConfig({ available: false, errors: ['OpenCode returned incomplete response (finish: missing)'] }));

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.details?.split('\n').slice(-2)).toEqual(['Agent review:', '  - Not applied: OpenCode returned incomplete response (finish: missing)']);
    });
  });

  describe('scans in linear time', () => {
    const evidence = (content: string, filePath: string): BackendEvidence => ({
      kind: 'backend-module', kindEvidence: [], moduleKind: { kind: 'backend-module', evidence: [], warnings: [] }, templateCandidates: [],
      framework: { name: 'rmb', evidence: [] }, storage: { present: false, evidence: [] },
      snapshot: { revision: 'HEAD', files: [{ path: filePath, oid: '0', size: content.length, content }], diagnostics: [], complete: true }
    });
    it.each([
      ['static modifiers without a declaration', (size: number) => `  static ${'final '.repeat(size)}`],
      ['static generics without a name', (size: number) => `static Map<${'> x'.repeat(size * 10)}`],
      ['unclosed cache annotations', (size: number) => '@Cacheable(('.repeat(size)],
      ['environment reads', (size: number) => 'System.getenv('.repeat(size)],
      ['@Value placeholders', (size: number) => '@Value("${a.tenant'.repeat(size * 4)],
      ['cache builders in a file without a tenant', (size: number) => 'Caffeine.newBuilder('.repeat(size)],
      ['tenant references', (size: number) => ('FolioExecutionContext TenantTool.calculateTenantId PgUtil.get( OkapiTenantResolver Tenants.withCurrent "X-OKAPI-TENANT" '
        + 'XOkapiHeaders.TENANT OkapiHeader.TENANT OKAPI_HEADER_TENANT X_OKAPI_TENANT @KafkaListener KafkaConsumerWrapper AsyncRecordHandler KafkaConsumer.create( new KafkaConsumer '
        + '@Scheduled setPeriodic( scheduleAtFixedRate( newScheduledThreadPool ').repeat(size)],
      ['import lines', (size: number) => '  import a.b.FolioExecutionContext;\npackage x;\n'.repeat(size)],
      ['final static fields', (size: number) => '  private static final String DEFAULT_TENANT =   \n'.repeat(size)]
    ])('%s', async (_name, content) => {
      await expectLinearTime(2_000, size => evidence(content(size), 'src/main/java/org/example/Big.java'), async input => evaluateB013(input));
    });
    it.each([
      ['a long YAML key', 'application.yml', (size: number) => `${'a-'.repeat(size * 20)}tenantx: y\n`],
      ['repeated tenant words in a key', 'application.properties', (size: number) => `${'tenant'.repeat(size * 20)}x= y\n`],
      ['many short entries', 'application.yml', (size: number) => '- tenantId: diku\r\n'.repeat(size)],
      ['comment and quote runs in a value', 'application.yml', (size: number) => `tenantId: "${' #'.repeat(size * 10)}\n`],
      ['dotted keys', 'application.properties', (size: number) => `${'tenant.'.repeat(size * 10)}id=x\n`],
      ['API spec markers', 'application.yml', (size: number) => `${'x: y\n'.repeat(size)}openapi: 3.0.0\n`]
    ])('%s', async (_name, file, content) => {
      await expectLinearTime(4_000, size => evidence(content(size), `src/main/resources/${file}`), async input => evaluateB013(input));
    });
    it('matches configuration paths in linear time', async () => {
      await expectLinearTime(20_000, size => evidence('tenantId: diku\n', `${'grails-app/conf/'.repeat(size)}x/${'src/main/resources/'.repeat(size)}a.groovy.yml`),
        async input => evaluateB013(input));
      await expectLinearTime(20_000, size => evidence('class A {}\n', `${'grails-app/x/'.repeat(size)}A.groovy`), async input => evaluateB013(input));
    });
  });
});
