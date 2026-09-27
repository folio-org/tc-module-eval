import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { collectS010Evidence } from '../utils/s010-evidence';

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
      expect.objectContaining({ message: expect.stringContaining('database or datastore') })
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

  it('recognizes a bounded feature-local Stripes lookup fallback', async () => {
    const root = repository({
      'package.json': JSON.stringify({
        name: '@folio/ui-external-lookup',
        dependencies: { react: '^18.2.0', '@folio/stripes-core': '^10.0.0' },
        stripes: {}
      }),
      'src/lookup.ts': [
        'export async function lookup(term) {',
        '  const controller = new AbortController();',
        '  const timer = setTimeout(() => controller.abort(), 2000);',
        '  try { return await fetch("https://id.example.org/search?q=" + term, { signal: controller.signal }); }',
        '  catch (error) { return []; }',
        '  finally { clearTimeout(timer); }',
        '}'
      ].join('\n')
    });

    const result = await collectS010Evidence(root, 'javascript');

    expect(result.runtimeKind).toBe('stripes-react');
    expect(result.scenarios).toEqual([expect.objectContaining({
      dependencyId: 'id.example.org',
      proof: 'controlled-degradation',
      boundedFailure: 'proven',
      readiness: 'preserved'
    })]);
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
      sourceReferences: [expect.objectContaining({ detail: expect.stringContaining('2 production files') })]
    })]);
    expect(result.diagnostics.filter(item => item.code === 'unsupported-runtime-pattern')).toHaveLength(0);
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/swagger|README/) })
    ]));
  });
});
