import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { collectS010Evidence } from '../utils/s010-evidence';
import { evaluateS010 } from '../utils/s010-evaluator';
import { EvaluationStatus } from '../types';
import { expectLinearTime } from './helpers/linear-time';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's010-evidence-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
  return root;
}

describe('S010 evidence collection', () => {
  it.each([
    'org.opensearch.client.RestHighLevelClient',
    'org.opensearch.client.RestClient',
    'org.opensearch.client.opensearch.OpenSearchClient',
    'org.opensearch.client.opensearch.OpenSearchAsyncClient'
  ])('recognizes %s without inferring resilience from nearby signals', async clientType => {
    const client = clientType.split('.').pop();
    const root = repository({
      'pom.xml': '<project><artifactId>mod-search</artifactId></project>',
      'descriptors/ModuleDescriptor.json': '{"id":"mod-search-1.0.0"}',
      'src/main/java/IndexRepository.java': [
        `import ${clientType};`,
        '@ConditionalOnProperty(name="SEARCH_ENABLED")',
        `class IndexRepository { ${client} openSearchClient;`,
        '  Object search() { return openSearchClient.search(request); }',
        `  void setElasticsearchClient(${client} elasticsearchClient) { this.openSearchClient = elasticsearchClient; }`,
        '  void unrelated() { try { other.connectTimeout(1000); } catch (Exception e) {} }',
        '}'
      ].join('\n'),
      'src/main/java/Other.java': 'class Other { void setup() { other.readTimeout(1000); } }',
      'src/test/java/TestClient.java': 'import org.opensearch.client.RestHighLevelClient;'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      id: 'search/runtime-unavailable', dependencyId: 'search', requirement: 'unresolved',
      proof: 'unresolved', boundedFailure: 'unknown', readiness: 'unknown',
      sourceReferences: [expect.objectContaining({ path: 'src/main/java/IndexRepository.java', line: 1 })]
    })]);
    expect(result.diagnostics).toEqual([]);
    expect(result.semanticCoverage).toBe('incomplete');
    expect(evaluateS010(result).status).toBe(EvaluationStatus.MANUAL);
  });

  it('retains unsupported clients beside recognized OpenSearch clients and in other files', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-search</artifactId></project>',
      'descriptors/ModuleDescriptor.json': '{"id":"mod-search-1.0.0"}',
      'src/main/java/Mixed.java': 'class Mixed { org.opensearch.client.opensearch.OpenSearchClient search; MongoClient mongo; ElasticsearchClient elastic; }',
      'src/main/java/Unknown.java': 'class Unknown { CustomClient openSearchClient; }',
      'src/main/java/Elastic.java': 'class Elastic { ElasticsearchClient elastic; }'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].sourceReferences.map(ref => ref.path)).toEqual(['src/main/java/Mixed.java']);
    const diagnostic = result.diagnostics.find(item => item.code === 'unsupported-runtime-pattern');
    expect(diagnostic?.message).toContain('3 files use datastore clients');
    for (const name of ['Mixed', 'Unknown', 'Elastic']) expect(diagnostic?.message).toContain(`${name}.java`);
  });

  it('does not treat defaulted or non-required configuration inputs as optional services', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-search</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({
        id: 'mod-search-1.0.0',
        launchDescriptor: { env: [
          { name: 'KAFKA_HOST', value: 'kafka' },
          { name: 'ELASTICSEARCH_URL', required: false, value: 'http://opensearch:9200' },
          { name: 'DB_HOST', required: true, value: '' }
        ] }
      }),
      'src/main/java/org/folio/Config.java': 'class Config { @Value("${DB_HOST}") String host; }'
    });

    const result = await collectS010Evidence(root, 'java');
    const configuration = result.scenarios.filter(scenario => scenario.scenario === 'configuration-absent');
    expect(configuration.map(scenario => [scenario.dependencyId, scenario.requirement, scenario.proof])).toEqual([
      ['kafka', 'unresolved', 'unresolved'],
      ['search', 'unresolved', 'unresolved'],
      ['database', 'required', 'clear-fail-fast']
    ]);
    expect(configuration[0].sourceReferences[0].detail).toContain('does not show whether the service is optional');
  });

  it('recognizes required Spring configuration with framework fail-fast semantics', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-search-client</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({
        id: 'mod-search-client-1.0.0',
        launchDescriptor: { env: [{ name: 'SEARCH_URL', required: true, value: '' }] }
      }),
      'src/main/java/org/folio/SearchConfig.java': 'class SearchConfig { @Value("${SEARCH_URL}") String url; }'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.runtimeKind).toBe('java');
    expect(result.scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dependencyId: 'search',
        requirement: 'required',
        scenario: 'configuration-absent',
        proof: 'clear-fail-fast'
      })
    ]));
    expect(JSON.stringify(result)).not.toContain('SEARCH_URL\":\"');
  });

  it('does not infer a violation from a required setting with an empty default', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-search-client</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({
        id: 'mod-search-client-1.0.0',
        launchDescriptor: { env: [{ name: 'SEARCH_URL', required: true, value: '' }] }
      }),
      'src/main/java/org/folio/SearchConfig.java': 'class SearchConfig { @Value("${SEARCH_URL:}") String url; }'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios[0]).toMatchObject({ proof: 'unresolved' });
    expect(result.semanticCoverage).toBe('incomplete');
  });

  it('keeps same-family environment declarations distinct and matches only the exact variable', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-database-client</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({
        id: 'mod-database-client-1.0.0',
        launchDescriptor: { env: [
          { name: 'DB_HOST', required: true, value: '' },
          { name: 'DB_USERNAME', required: true, value: '' }
        ] }
      }),
      'src/main/java/org/folio/DatabaseConfig.java': 'class DatabaseConfig { @Value("${DB_USERNAME}") String username; }'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'database:DB_HOST/configuration-absent', proof: 'unresolved' }),
      expect.objectContaining({ id: 'database:DB_USERNAME/configuration-absent', proof: 'clear-fail-fast' })
    ]));
    expect(result.scenarios).toHaveLength(2);
    expect(result.semanticCoverage).toBe('incomplete');
  });

  it.each([
    ['S3_URL', 'object-storage'],
    ['ELASTICSEARCH_URL', 'search']
  ])('matches the exact %s Spring placeholder', async (variable, dependencyId) => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-client</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({
        id: 'mod-client-1.0.0',
        launchDescriptor: { env: [{ name: variable, required: true, value: '' }] }
      }),
      'src/main/java/org/folio/ClientConfig.java': `class ClientConfig { @Value("\${${variable}}") String value; }`
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({ dependencyId, proof: 'clear-fail-fast' })]);
  });

  it('keeps the unresolved result when duplicate declarations disagree', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-client</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({
        id: 'mod-client-1.0.0',
        launchDescriptor: { env: [{ name: 'SEARCH_URL', required: true, value: '' }] }
      }),
      'config/ModuleDescriptor.json': JSON.stringify({
        id: 'mod-client-1.0.0',
        launchDescriptor: { env: [{ name: 'SEARCH_URL', required: false, value: '' }] }
      }),
      'src/main/java/org/folio/SearchConfig.java': 'class SearchConfig { @Value("${SEARCH_URL}") String url; }'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      id: 'search:SEARCH_URL/configuration-absent',
      requirement: 'unresolved',
      proof: 'unresolved'
    })]);
  });

  it('links an optional Java client fallback only when bound and handling share a source owner', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-optional-search</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({ id: 'mod-optional-search-1.0.0' }),
      'src/main/java/org/folio/SearchClient.java': [
        '@ConditionalOnProperty(name="SEARCH_ENABLED", havingValue="true")',
        'class SearchClient {',
        '  Mono<String> lookup() {',
        '    return WebClient.create().get().retrieve().bodyToMono(String.class)',
        '      .timeout(Duration.ofSeconds(2)).onErrorResume(error -> Mono.just("unavailable"));',
        '  }',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      dependencyId: 'search',
      requirement: 'optional',
      proof: 'controlled-degradation',
      boundedFailure: 'proven',
      readiness: 'preserved'
    })]);
  });

  it.each([
    ['a timeout and error handler on another call', [
      '  Mono<String> lookup() { return WebClient.create().get().retrieve().bodyToMono(String.class); }',
      '  Mono<String> other(Mono<String> value) { return value.timeout(Duration.ofSeconds(2)).onErrorResume(error -> Mono.empty()); }'
    ]],
    ['a second call without a timeout', [
      '  private final WebClient client;',
      '  Mono<String> lookup() { return client.get().retrieve().bodyToMono(String.class).timeout(Duration.ofSeconds(2)).onErrorResume(e -> Mono.empty()); }',
      '  Mono<String> refresh() { return client.post().retrieve().bodyToMono(String.class).onErrorResume(e -> Mono.empty()); }'
    ]],
    ['a catch block around a different statement', [
      '  private final WebClient client;',
      '  String lookup() { String value = client.get().retrieve().bodyToMono(String.class).timeout(Duration.ofSeconds(2)).block();',
      '    try { log(); } catch (Exception e) { } return value; }'
    ]],
    ['an unchecked call with explicit type arguments', [
      '  HttpClient client;',
      '  Object safe(HttpRequest r) { return client.sendAsync(r, BodyHandlers.ofString()).orTimeout(2, TimeUnit.SECONDS).exceptionally(e -> null); }',
      '  Object unsafe(HttpRequest r) { return client.<String>sendAsync(r, BodyHandlers.ofString()); }'
    ]],
    ['a second client in the same declaration', [
      '  HttpClient safe, unsafe;',
      '  Object one(HttpRequest r) { return safe.sendAsync(r, BodyHandlers.ofString()).orTimeout(2, TimeUnit.SECONDS).exceptionally(e -> null); }',
      '  Object two(HttpRequest r) { return unsafe.sendAsync(r, BodyHandlers.ofString()); }'
    ]],
    ['an unchecked call after 200 checked ones', [
      '  WebClient client;',
      ...Array(200).fill('  String a() { return client.get().retrieve().bodyToMono(String.class).timeout(Duration.ofSeconds(2)).onErrorReturn("").block(); }'),
      '  String b() { return client.get().retrieve().bodyToMono(String.class).block(); }'
    ]],
    ['a timeout and error handler on an argument, not the request', [
      '  WebClient client;',
      '  Mono<String> lookup(Mono<String> payload) {',
      '    return client.post().uri("/x").bodyValue(payload.timeout(Duration.ofSeconds(1)).onErrorReturn("fallback").block())',
      '      .retrieve().bodyToMono(String.class);',
      '  }'
    ]],
    ['a timeout and error handler in a comment', [
      '  WebClient client;',
      '  Mono<String> lookup() { return client.get().retrieve().bodyToMono(String.class)',
      '    /* .timeout(Duration.ofSeconds(2)).onErrorResume(e -> Mono.empty()) */; }'
    ]],
    ['an asynchronous result returned from a try block', [
      '  HttpClient client;',
      '  Object lookup(HttpRequest r) {',
      '    try { return client.sendAsync(r, BodyHandlers.ofString()).orTimeout(2, TimeUnit.SECONDS); }',
      '    catch (Exception error) { return CompletableFuture.completedFuture(null); }',
      '  }'
    ]],
    ['a second client declared with an initializer', [
      '  WebClient safeClient = WebClient.create(),',
      '            unsafeClient = WebClient.create();',
      '  Mono<String> lookup() { return safeClient.get().retrieve().bodyToMono(String.class).timeout(Duration.ofSeconds(2)).onErrorReturn(""); }',
      '  Mono<String> unchecked() { return unsafeClient.get().retrieve().bodyToMono(String.class); }'
    ]],
    ['a new client handed straight to other code', [
      '  WebClient client;',
      '  Mono<String> lookup() { return client.get().retrieve().bodyToMono(String.class).timeout(Duration.ofSeconds(2)).onErrorReturn(""); }',
      '  Mono<String> unchecked() { return Helper.call(WebClient.create()); }'
    ]],
    ['an error handler on another expression after the request', [
      '  WebClient client;',
      '  String lookup(Mono<String> fallback) {',
      '    return client.get().retrieve().bodyToMono(String.class).timeout(Duration.ofSeconds(2)).block()',
      '      + fallback.onErrorReturn("").block();',
      '  }'
    ]],
    ['a reactive request returned from a try block', [
      '  WebClient client;',
      '  Mono<String> lookup() {',
      '    try { return client.get().retrieve().bodyToMono(String.class).timeout(Duration.ofSeconds(2)); }',
      '    catch (Exception error) { return Mono.empty(); }',
      '  }'
    ]],
    ['a client handed to code the tool does not follow', [
      '  WebClient client;',
      '  Mono<String> lookup() { return client.get().retrieve().bodyToMono(String.class).timeout(Duration.ofSeconds(2)).onErrorResume(e -> Mono.empty()); }',
      '  Mono<String> other() { return Helper.call(client); }'
    ]]
  ])('keeps an optional Java client manual with %s', async (_name, body) => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-optional-search</artifactId></project>',
      'src/main/java/org/folio/SearchClient.java': [
        '@ConditionalOnProperty(name="SEARCH_ENABLED", havingValue="true")',
        'class SearchClient {',
        ...body,
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({ dependencyId: 'search', proof: 'unresolved' })]);
    expect(evaluateS010(result).status).toBe(EvaluationStatus.MANUAL);
  });

  it('accepts an asynchronous Java client call with a timeout and error handler on its own chain', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-optional-search</artifactId></project>',
      'src/main/java/org/folio/SearchClient.java': [
        'import java.net.http.HttpClient;',
        '@ConditionalOnProperty(name="SEARCH_ENABLED", havingValue="true")',
        'class SearchClient {',
        '  private final HttpClient client;',
        '  SearchClient(HttpClient client, Config config) { this.client = client; }',
        '  Object lookup(HttpRequest request) {',
        '    return client.<String>sendAsync(request, BodyHandlers.ofString())',
        '      .orTimeout(2, TimeUnit.SECONDS).exceptionally(error -> null);',
        '  }',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({ proof: 'controlled-degradation', boundedFailure: 'proven' })]);
  });

  it('accepts a Java client call bounded on its own statement and caught by its own try block', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-optional-search</artifactId></project>',
      'src/main/java/org/folio/SearchClient.java': [
        '@ConditionalOnProperty(name="SEARCH_ENABLED", havingValue="true")',
        'class SearchClient {',
        '  private final KafkaTemplate<String, String> template;',
        '  void send(String event) {',
        '    try {',
        '      template.send("topic", event).get(2, TimeUnit.SECONDS);',
        '    } catch (Exception error) {',
        '      log.warn("Search events are unavailable", error);',
        '    }',
        '  }',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      dependencyId: 'search', proof: 'controlled-degradation', boundedFailure: 'proven', readiness: 'preserved'
    })]);
  });

  it('keeps unlinked Java resilience signals unresolved', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-wrapper</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({ id: 'mod-wrapper-1.0.0' }),
      'src/main/java/org/folio/SearchClient.java': 'class SearchClient { String lookup() { return WebClient.create().get().toString(); } }',
      'src/main/java/org/folio/OtherClient.java': 'class OtherClient { void bounded() { timeout(Duration.ofSeconds(2)); onErrorResume(x -> empty()); } }'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({ proof: 'unresolved' })]);
    expect(result.semanticCoverage).toBe('incomplete');
  });

  it('checks runtime clients even when the same file supplies configuration evidence', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-kafka</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({
        id: 'mod-kafka-1.0.0',
        launchDescriptor: { env: [{ name: 'KAFKA_HOST', required: true, value: '' }] }
      }),
      'src/main/java/org/folio/KafkaConfig.java': [
        'class KafkaConfig {',
        '  @Value("${KAFKA_HOST}") String host;',
        '  KafkaTemplate<String, String> template;',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'kafka:KAFKA_HOST/configuration-absent' }),
      expect.objectContaining({ scenario: 'runtime-unavailable', proof: 'unresolved' })
    ]));
    expect(result.scenarios).toHaveLength(2);
  });

  it('keeps colliding file-derived dependency names as separate runtime scenarios', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-inventory</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({ id: 'mod-inventory-1.0.0' }),
      'src/main/java/one/InventoryClient.java': 'class InventoryClient { WebClient client; }',
      'src/main/java/two/InventoryService.java': 'class InventoryService { RestTemplate client; }',
      'src/main/java/three/Client.java': 'class Client { HttpClient client; }',
      'src/main/java/four/Client.java': 'class Client { WebClient client; }'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios.filter(item => item.scenario === 'runtime-unavailable')).toHaveLength(4);
    expect(new Set(result.scenarios.map(item => item.id)).size).toBe(4);
  });

  it('collects one bounded required database startup scenario from Spring lifecycle evidence', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-database</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({ id: 'mod-database-1.0.0' }),
      'src/main/resources/application.yml': [
        'spring:',
        '  datasource:',
        '    url: jdbc:postgresql://localhost/postgres?socketTimeout=10',
        '    hikari:',
        '      connection-timeout: 5000'
      ].join('\n'),
      'src/main/java/org/folio/SystemSchemaInitializer.java': [
        '@Component',
        'class SystemSchemaInitializer implements InitializingBean {',
        '  private final FolioSpringLiquibase liquibase;',
        '  public void afterPropertiesSet() throws LiquibaseException {',
        '    liquibase.performLiquibaseUpdate();',
        '  }',
        '}'
      ].join('\n'),
      'src/main/java/org/folio/RecordsRepository.java': 'class RecordsRepository { private JdbcTemplate jdbcTemplate; }'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      id: 'database/startup-unavailable',
      dependencyId: 'database',
      requirement: 'required',
      scenario: 'startup-unavailable',
      proof: 'clear-fail-fast',
      boundedFailure: 'proven',
      readiness: 'not-applicable'
    })]);
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('datastore clients') })
    ]));
  });

  it('keeps required database startup manual when no complete failure bound is visible', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-database</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({ id: 'mod-database-1.0.0' }),
      'src/main/resources/application.yml': [
        'spring:',
        '  datasource:',
        '    url: jdbc:postgresql://localhost/postgres',
        '    hikari:',
        '      connection-timeout: 5000',
        'folio:',
        '  migration-statement-timeout: 0'
      ].join('\n'),
      'src/main/java/org/folio/SystemSchemaInitializer.java': [
        'class SystemSchemaInitializer implements InitializingBean {',
        '  FolioSpringLiquibase liquibase;',
        '  public void afterPropertiesSet() throws LiquibaseException { liquibase.performLiquibaseUpdate(); }',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      id: 'database/startup-unavailable',
      requirement: 'required',
      proof: 'clear-fail-fast',
      boundedFailure: 'unknown'
    })]);
    expect(result.semanticCoverage).toBe('incomplete');
  });

  it('does not use unrelated HTTP timeout settings as a database startup bound', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-database</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({ id: 'mod-database-1.0.0' }),
      'src/main/resources/application.yml': [
        'spring:',
        '  datasource:',
        '    url: jdbc:postgresql://localhost/postgres',
        'folio:',
        '  http-client:',
        '    connection-timeout: 5000',
        '    socketTimeout: 10'
      ].join('\n'),
      'src/main/java/org/folio/SystemSchemaInitializer.java': [
        'class SystemSchemaInitializer implements InitializingBean {',
        '  FolioSpringLiquibase liquibase;',
        '  public void afterPropertiesSet() throws LiquibaseException { liquibase.performLiquibaseUpdate(); }',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      id: 'database/startup-unavailable',
      boundedFailure: 'unknown'
    })]);
  });

  it('does not use YAML comments or block scalar text as database startup bounds', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-database</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({ id: 'mod-database-1.0.0' }),
      'src/main/resources/application.yml': [
        'spring:',
        '  datasource:',
        '    url: jdbc:postgresql://localhost/postgres',
        '    # connection-timeout: 5000',
        'documentation: |2-',
        '  datasource:',
        '    connection-timeout: 5000',
        '    socketTimeout: 10',
        'notes: &documentation >-',
        '  r2dbc:',
        '    connection-timeout: 5000',
        '    socketTimeout: 10'
      ].join('\n'),
      'src/main/java/org/folio/SystemSchemaInitializer.java': [
        'class SystemSchemaInitializer implements InitializingBean {',
        '  FolioSpringLiquibase liquibase;',
        '  public void afterPropertiesSet() throws LiquibaseException { liquibase.performLiquibaseUpdate(); }',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      id: 'database/startup-unavailable',
      boundedFailure: 'unknown'
    })]);
    expect(result.semanticCoverage).toBe('incomplete');
  });

  it('recognizes a bounded optional database path without inferring required startup ownership', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-optional-database</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({ id: 'mod-optional-database-1.0.0' }),
      'src/main/resources/application.yml': [
        'spring:',
        '  datasource:',
        '    url: jdbc:postgresql://localhost/postgres?socketTimeout=10',
        '    hikari:',
        '      connection-timeout: 5000'
      ].join('\n'),
      'src/main/java/org/folio/OptionalRepository.java': [
        '@ConditionalOnProperty(name="DATABASE_ENABLED", havingValue="true")',
        'class OptionalRepository {',
        '  JdbcTemplate jdbcTemplate;',
        '  String find() { try { return jdbcTemplate.queryForObject("select 1", String.class); }',
        '    catch (DataAccessException error) { return "unavailable"; } }',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      id: 'database/runtime-unavailable',
      requirement: 'optional',
      proof: 'controlled-degradation',
      boundedFailure: 'proven',
      readiness: 'preserved'
    })]);
  });

  it.each([
    'interface Records extends JpaRepository<Record, String> {}',
    'class Records { R2dbcEntityTemplate database; }'
  ])('recognizes database framework ownership without pretending its behavior is known: %s', async source => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-database</artifactId></project>',
      'descriptors/ModuleDescriptor.json': JSON.stringify({ id: 'mod-database-1.0.0' }),
      'src/main/java/org/folio/Records.java': source
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([expect.objectContaining({
      id: 'database/runtime-unavailable',
      requirement: 'unresolved',
      proof: 'unresolved'
    })]);
    expect(result.semanticCoverage).toBe('incomplete');
  });

  const lookupFile = (gate = '') => [
    'export async function lookup(stripes, term) {',
    gate,
    '  const controller = new AbortController();',
    '  const timer = setTimeout(() => controller.abort(), 2000);',
    '  try { return await fetch("https://id.example.org/search?q=" + term, { signal: controller.signal }); }',
    '  catch (error) { return []; }',
    '  finally { clearTimeout(timer); }',
    '}'
  ].join('\n');
  it.each([
    ['an interface check', {}, "  if (!stripes.hasInterface('id-lookup')) return [];"],
    ['a setting', {}, '  if (!stripes.config.idLookupEnabled) return [];'],
    ['optional interfaces in package.json', { optionalOkapiInterfaces: { 'id-lookup': '1.0' } }, '']
  ])('recognizes a bounded Stripes lookup that %s can turn off', async (_name, stripes, gate) => {
    const root = repository({
      'package.json': JSON.stringify({
        name: '@folio/ui-external-lookup',
        dependencies: { react: '^18.2.0', '@folio/stripes-core': '^10.0.0' },
        stripes
      }),
      'src/lookup.ts': lookupFile(gate)
    });

    const result = await collectS010Evidence(root, 'javascript');

    expect(result.runtimeKind).toBe('stripes-react');
    expect(result.scenarios).toEqual(expect.arrayContaining([expect.objectContaining({
      dependencyId: 'id.example.org',
      requirement: 'optional',
      proof: 'controlled-degradation',
      boundedFailure: 'proven',
      readiness: 'preserved'
    })]));
  });

  it.each([
    ['nothing', ''],
    ['a setting named only in a comment', '  // TODO: read stripes.config.idLookupEnabled'],
    ['an interface check named only in a string', "  const help = 'call stripes.hasInterface(\"id-lookup\") first';"],
    ['a setting named only in a nested template', '  const help = `Documentation: ${`stripes.config.idLookupEnabled`}`;'],
    ['a setting named only in a regular expression', '  const pattern = /stripes.config.idLookupEnabled/;']
  ])('does not treat a bounded, handled Stripes request as optional when %s can turn it off', async (_name, gate) => {
    const root = repository({
      'package.json': JSON.stringify({
        name: '@folio/ui-external-lookup',
        dependencies: { react: '^18.2.0', '@folio/stripes-core': '^10.0.0' },
        stripes: { okapiInterfaces: {} }
      }),
      'src/lookup.ts': lookupFile(gate)
    });

    const result = await collectS010Evidence(root, 'javascript');

    expect(result.scenarios).toEqual([expect.objectContaining({
      dependencyId: 'id.example.org',
      requirement: 'unresolved',
      proof: 'unresolved',
      boundedFailure: 'proven',
      rationale: expect.stringContaining('no setting or interface check that turns the feature off')
    })]);
    expect(evaluateS010(result).status).toBe(EvaluationStatus.MANUAL);
  });

  it('does not treat a ui-like Node package as a supported Stripes runtime', async () => {
    const root = repository({
      'package.json': JSON.stringify({ name: 'ui-misleading', dependencies: { express: '^4.0.0' } }),
      'src/index.js': 'require("express")().listen(3000);'
    });

    const result = await collectS010Evidence(root, 'javascript');

    expect(result.runtimeKind).toBe('node');
    expect(result.semanticCoverage).toBe('unsupported');
  });

  it('groups supported Java database clients without scanning excluded sources', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-example</artifactId></project>',
      'descriptors/ModuleDescriptor-template.json': '{"id":"mod-example-1.0.0"}',
      'src/main/java/Storage.java': 'class Storage { JdbcTemplate database; }',
      'src/main/java/TenantStorage.java': 'class TenantStorage { DataSource database; }',
      'src/main/java/OkapiHeaders.java': 'class OkapiHeaders { String okapiTenant; }',
      'src/main/resources/swagger.api/paths/search.yaml': 'x-okapi-tenant: required',
      'docker/README.md': 'Set the Okapi URL before starting the container.'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.semanticCoverage).toBe('incomplete');
    expect(result.scenarios).toEqual([expect.objectContaining({
      id: 'database/runtime-unavailable',
      requirement: 'unresolved',
      proof: 'unresolved',
      sourceReferences: [expect.objectContaining({ detail: expect.stringContaining('first of 2 files') })]
    })]);
    expect(result.diagnostics.filter(item => item.code === 'unsupported-runtime-pattern')).toHaveLength(0);
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/swagger|README/) })
    ]));
  });
  it('reads Stripes interfaces declared as an object of interface versions', async () => {
    const root = repository({
      'package.json': JSON.stringify({
        name: '@folio/notes',
        dependencies: { react: '^18.2.0', '@folio/stripes-core': '^10.0.0' },
        stripes: { okapiInterfaces: { notes: '4.0', users: '16.0' }, optionalOkapiInterfaces: { tags: '1.0' } }
      }),
      'src/index.js': 'export default function Notes() { return null; }'
    });

    const result = await collectS010Evidence(root, 'javascript');

    expect(result.scenarios.map(scenario => scenario.dependencyId)).toEqual([
      'folio-interface:notes', 'folio-interface:users', 'folio-interface:tags'
    ]);
    expect(evaluateS010(result).status).toBe(EvaluationStatus.MANUAL);
  });

  it('does not read co-located tests and mocks as production code', async () => {
    const root = repository({
      'package.json': JSON.stringify({ name: '@folio/x', dependencies: { react: '^18.2.0', '@folio/stripes-core': '^10.0.0' }, stripes: {} }),
      'src/Users.test.js': 'import axios from "axios"; fetch(url);',
      'src/Users.spec.tsx': 'const okapi = { url: "" };',
      'src/__mocks__/stripes.js': 'export const mutator = {};',
      'src/Users.js': 'export const Users = () => null;'
    });

    const result = await collectS010Evidence(root, 'javascript');

    expect(result.diagnostics).toEqual([]);
    expect(evaluateS010(result).status).toBe(EvaluationStatus.PASS);
  });

  it('diagnoses browser requests whose target is not a literal address', async () => {
    const root = repository({
      'package.json': JSON.stringify({ name: '@folio/x', dependencies: { react: '^18.2.0', '@folio/stripes-core': '^10.0.0' }, stripes: {} }),
      'src/lookup.js': 'export const lookup = term => fetch(`https://api.example.org/search?q=${term}`);',
      'src/users.js': 'export const users = url => fetch(`${url}/users`);',
      'src/upload.js': 'export const upload = () => new XMLHttpRequest();',
      'src/hooks.js': 'export const reload = query => refetch(query);'
    });

    const result = await collectS010Evidence(root, 'javascript');

    expect(result.scenarios.map(scenario => scenario.dependencyId)).toEqual(['api.example.org']);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'unsupported-runtime-pattern',
      message: expect.stringMatching(/^2 files use browser requests the tool cannot follow .* for example src\/upload\.js, src\/users\.js\.$/)
    })]);
    expect(evaluateS010(result).status).toBe(EvaluationStatus.MANUAL);
  });

  it('diagnoses Java clients it cannot analyse instead of reporting no dependencies', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-example</artifactId></project>',
      'src/main/java/Listener.java': 'class Listener { @KafkaListener(topics = "t") void on(String event) {} }',
      'src/main/java/Exports.java': 'class Exports { private final FolioS3Client s3; }',
      'src/main/java/UsersClient.java': '@HttpExchange("users") interface UsersClient { @GetExchange User get(); }',
      'src/main/java/Pool.java': 'class Pool { HikariDataSource pool; }',
      'src/main/java/RulesMapper.java': 'class RulesMapper { DataSourceResolver resolver; Object rule() { return rule.getDataSource(); } }'
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios).toEqual([]);
    expect(Object.fromEntries(result.diagnostics.map(item => [item.message.replace(/ \(.*/, ''), item.path]))).toEqual({
      'Uses HTTP clients': 'src/main/java/UsersClient.java',
      'Uses datastore clients': 'src/main/java/Pool.java',
      'Uses object storage clients': 'src/main/java/Exports.java',
      'Uses messaging or RPC clients': 'src/main/java/Listener.java'
    });
    expect(evaluateS010(result).status).toBe(EvaluationStatus.MANUAL);
  });

  it('cites the descriptor line of each environment variable and the line of its Spring binding', async () => {
    const root = repository({
      'pom.xml': '<project><artifactId>mod-example</artifactId></project>',
      'descriptors/ModuleDescriptor-template.json': JSON.stringify({
        id: 'mod-example-1.0.0',
        launchDescriptor: { env: [{ name: 'DB_HOST', value: 'postgres' }, { name: 'SEARCH_URL', required: true }] }
      }, null, 2),
      'src/main/java/Config.java': [
        'class Config {',
        '  @Value("${server.port}") int port;',
        '  @Value("${SEARCH_URL}") String url;',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios.map(scenario => scenario.sourceReferences)).toEqual([
      [{ path: 'descriptors/ModuleDescriptor-template.json', line: 6,
        detail: 'DB_HOST is not marked required (this does not show whether the service is optional)' }],
      [
        { path: 'descriptors/ModuleDescriptor-template.json', line: 10, detail: 'SEARCH_URL is marked required' },
        { path: 'src/main/java/Config.java', line: 3, detail: 'Reads SEARCH_URL with a Spring @Value binding' }
      ]
    ]);
    expect(result.scenarios[1].proof).toBe('clear-fail-fast');
  });

  it('classifies a fetch address the same way with or without spaces, and treats a computed host as unknown', async () => {
    const request = (call: string) => `export const load = (stripes, domain) => stripes.hasInterface('lookup') && ${call}, { signal: AbortSignal.timeout(1000) }).catch(() => null);`;
    const root = repository(uiModule({
      'src/spaced.js': request('fetch( "https://api.example.org/v1"'),
      'src/unspaced.js': request('fetch("https://api.example.org/v1"'),
      'src/computed.js': request('fetch(`https://api.${domain}/v1`')
    }));

    const result = await collectS010Evidence(root, 'javascript');

    expect(result.scenarios.map(scenario => [scenario.sourceReferences[0].path, scenario.dependencyId, scenario.proof])).toEqual([
      ['src/spaced.js', 'api.example.org', 'controlled-degradation'],
      ['src/unspaced.js', 'api.example.org', 'controlled-degradation']
    ]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      path: 'src/computed.js', message: expect.stringContaining('browser requests the tool cannot follow')
    })]);
  });

  it('still diagnoses other clients in a file with a recognized OpenSearch client', async () => {
    const root = repository(javaModule({
      'src/main/java/Search.java': [
        'import org.opensearch.client.RestClient;',
        'import org.springframework.web.client.RestClient;',
        'class Search { org.opensearch.client.opensearch.OpenSearchClient search; RestClient low; HikariDataSource pool; }'
      ].join('\n')
    }));

    const result = await collectS010Evidence(root, 'java');

    expect(result.diagnostics.map(item => item.message.replace(/ \(.*/, ''))).toEqual(['Uses HTTP clients', 'Uses datastore clients']);
  });

  it('treats AWS_* and S3_* settings as one object storage service', async () => {
    const root = repository(javaModule({
      'descriptors/ModuleDescriptor-template.json': JSON.stringify({ launchDescriptor: { env: [
        { name: 'AWS_URL' }, { name: 'AWS_BUCKET' }, { name: 'AWS_REGION' }, { name: 'AWS_ACCESS_KEY_ID' }, { name: 'S3_URL' }, { name: 'LAWS_URL' }
      ] } })
    }));

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios.filter(scenario => scenario.scenario === 'configuration-absent')
      .map(scenario => scenario.id)).toEqual([
      'object-storage:AWS_URL/configuration-absent',
      'object-storage:AWS_BUCKET/configuration-absent',
      'object-storage:AWS_REGION/configuration-absent',
      'object-storage:AWS_ACCESS_KEY_ID/configuration-absent',
      'object-storage:S3_URL/configuration-absent',
      'laws:LAWS_URL/configuration-absent'
    ]);
  });

  it('cites no descriptor line when the variable name appears more than once', async () => {
    const root = repository(javaModule({
      'descriptors/ModuleDescriptor-template.json': JSON.stringify({
        metadata: { name: 'DB_HOST' },
        launchDescriptor: { env: [{ name: 'DB_HOST' }, { name: 'DB_PORT' }] }
      }, null, 2)
    }));

    const result = await collectS010Evidence(root, 'java');

    expect(result.scenarios.filter(scenario => scenario.scenario === 'configuration-absent')
      .map(scenario => [scenario.id, scenario.sourceReferences[0].line])).toEqual([
      ['database:DB_HOST/configuration-absent', undefined],
      ['database:DB_PORT/configuration-absent', 11]
    ]);
  });

  const javaModule = (files: Record<string, string>) => ({
    'pom.xml': '<project><artifactId>mod-example</artifactId></project>',
    'src/main/java/Migrations.java': 'class Migrations implements InitializingBean { Flyway flyway; }',
    ...files
  });
  const uiModule = (files: Record<string, string>) => ({
    'package.json': JSON.stringify({ name: '@folio/x', dependencies: { react: '^18.2.0', '@folio/stripes-core': '^10.0.0' }, stripes: {} }),
    ...files
  });
  const databaseYaml = (line: string) => ({ 'src/main/resources/application.yml': `spring:\n  datasource:\n${line}` });
  // Before its fix, each input took seconds at four times the size, because the work grew faster than linearly.
  it.each<[string, (size: number) => Record<string, string>, 'java' | 'javascript', number]>([
    ['a Spring @Value default that never closes', size => javaModule({
      'descriptors/ModuleDescriptor-template.json': JSON.stringify({ launchDescriptor: { env: Array(3).fill({ name: 'DB_URL', required: true }) } }),
      'src/main/java/Config.java': '@Value("${DB_URL:'.repeat(size)
    }), 'java', 2_750],
    ['a startup method signature that never closes', size => javaModule({
      'src/main/java/Migrations.java': `class Migrations implements InitializingBean { Flyway flyway; ${'run('.repeat(size)} }`
    }), 'java', 11_250],
    ['a long run of YAML indentation', size => javaModule(databaseYaml(`${' '.repeat(size)}x`)), 'java', 15_000],
    ['a long run of spaces inside a YAML value', size => javaModule(databaseYaml(`    url: jdbc${' '.repeat(size)}x`)), 'java', 15_000],
    ['a long run of spaces before a carriage return in a YAML value', size => javaModule(databaseYaml(`    url: ${' '.repeat(size)}x\ry`)), 'java', 8_750],
    ['an unclosed process.env lookup', size => javaModule({ 'src/main/js/env.js': 'process.env['.repeat(size) }), 'java', 4_000],
    ['many browser requests in one file', size => uiModule({
      'src/requests.js': 'fetch("https://a.b/");\n'.repeat(size)
    }), 'javascript', 2_000],
    // Merging the declarations grew with the square of the number of files that declare the variable.
    ['one environment variable declared many times', size => javaModule(Object.fromEntries(Array.from({ length: size }, (_, index) => [
      `descriptors/ModuleDescriptor-${index}.json`, JSON.stringify({ launchDescriptor: { env: Array(1_600).fill({ name: 'DB_URL' }) } })
    ]))), 'java', 40]
  ])('stays linear in time on %s', async (_name, files, language, size) => {
    const result = await expectLinearTime(size, inputSize => repository(files(inputSize)), root => collectS010Evidence(root, language));

    // Every file of the larger input was read, so no source limit made that run cheaper.
    expect(result.discoveryCoverage).toBe('complete');
  }, 300_000);

  it('lists at most 1,000 dependency checks and says the list was cut', async () => {
    const root = repository({
      'package.json': JSON.stringify({ name: '@folio/x', dependencies: { react: '^18.2.0', '@folio/stripes-core': '^10.0.0' }, stripes: {} }),
      // Each request is bounded and handled, so without the limit the module would pass.
      'src/hosts.js': [
        'const signal = AbortSignal.timeout(1000);',
        ...Array.from({ length: 1_100 }, (_, index) => `fetch("https://host${index}.example.org/", { signal }).catch(() => null);`)
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'javascript');

    expect(result.scenarios).toHaveLength(1_000);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'scenario-limit', message: 'Found 1100 dependency checks; only the first 1000 are listed.', material: true
    })]);
    expect(evaluateS010(result).status).toBe(EvaluationStatus.MANUAL);
  });
});
