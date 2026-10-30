import { collectBackendInfrastructure, getBackendInfrastructure } from '../utils/backend-infrastructure';
import { getBackendEvidence } from '../utils/backend-evidence';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function infrastructure(files: Record<string, string>) {
  const root = repository(files);
  return getBackendInfrastructure(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
}

const descriptor = (env: string[]) => JSON.stringify({ id: 'mod-example-1.0.0', launchDescriptor: { env: env.map(name => ({ name, value: '' })) } });
const scoped = (groupId: string, artifactId: string, extra: string) =>
  `<dependency><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId>${extra}</dependency>`;

describe('backend infrastructure', () => {
  it('reads production dependencies, storage, configuration and environment prefixes, and leaves out tests and embedded libraries', async () => {
    const result = await infrastructure({
      'pom.xml': pom('mod-example', `${restVerticleBuild}<dependencies>${[
        dependency('domain-models-runtime'),
        dependency('folio-kafka-wrapper'),
        dependency('jedis', 'redis.clients'),
        scoped('org.mongodb', 'mongodb-driver-sync', '<scope>test</scope>'),
        scoped('org.testcontainers', 'kafka', ''),
        dependency('hazelcast', 'com.hazelcast'),
        dependency('caffeine', 'com.github.ben-manes.caffeine'),
        scoped('io.minio', 'minio', '<optional>true</optional>')
      ].join('')}</dependencies><profiles><profile><id>search</id><dependencies>${dependency('opensearch-java', 'org.opensearch.client')}</dependencies></profile></profiles>`),
      'descriptors/ModuleDescriptor-template.json': descriptor(['DB_HOST', 'RABBITMQ_HOST', 'JAVA_OPTIONS']),
      'src/main/resources/templates/db_scripts/schema.json': '{}',
      'src/main/resources/application.yml': 'spring:\n  rabbitmq:\n    host: ${RABBITMQ_HOST:localhost}\n',
      'src/main/java/org/example/Main.java': 'class Main { String v = System.getenv("VAULT_TOKEN"); String k = System.getenv("KAFKA_HOST"); }',
      'src/test/resources/application.yml': 'spring:\n  data:\n    redis:\n      host: x\n'
    });

    expect(result.items).toEqual([
      {
        id: 'postgresql', name: 'PostgreSQL', usage: 'required', signals: [
          { kind: 'storage', detail: 'RMB database schema src/main/resources/templates/db_scripts/schema.json' },
          { kind: 'environment', detail: 'DB_HOST', path: 'descriptors/ModuleDescriptor-template.json' }
        ]
      },
      {
        id: 'kafka', name: 'Apache Kafka', usage: 'required', signals: [
          { kind: 'dependency', detail: 'org.folio:folio-kafka-wrapper', path: 'pom.xml' },
          { kind: 'environment', detail: 'KAFKA_HOST', path: 'src/main/java/org/example/Main.java' }
        ]
      },
      {
        id: 'opensearch', name: 'OpenSearch', usage: 'optional', signals: [
          { kind: 'dependency', detail: 'org.opensearch.client:opensearch-java', path: 'pom.xml', optional: 'declared in the Maven profile search' }
        ]
      },
      {
        id: 's3', name: 'S3 object storage', usage: 'optional', signals: [
          { kind: 'dependency', detail: 'io.minio:minio', path: 'pom.xml', optional: 'Maven optional dependency' }
        ]
      },
      {
        id: 'redis', name: 'Redis', usage: 'required', signals: [{ kind: 'dependency', detail: 'redis.clients:jedis', path: 'pom.xml' }]
      },
      {
        id: 'rabbitmq', name: 'RabbitMQ', usage: 'configuration-only', signals: [
          { kind: 'configuration', detail: 'spring.rabbitmq.host', path: 'src/main/resources/application.yml' },
          { kind: 'environment', detail: 'RABBITMQ_HOST', path: 'descriptors/ModuleDescriptor-template.json' },
          { kind: 'environment', detail: 'RABBITMQ_HOST', path: 'src/main/resources/application.yml' }
        ]
      },
      {
        id: 'vault', name: 'HashiCorp Vault', usage: 'configuration-only', signals: [
          { kind: 'environment', detail: 'VAULT_TOKEN', path: 'src/main/java/org/example/Main.java' }
        ]
      }
    ]);
    expect(result.buildFiles).toEqual(['pom.xml']);
    expect(result.diagnostics).toEqual([]);
  });

  it('finds no PostgreSQL from the RMB dependency alone, as in mod-circulation', async () => {
    const result = await infrastructure({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('domain-models-runtime')}${dependency('vertx-kafka-client', 'io.vertx')}</dependencies>`),
      'descriptors/ModuleDescriptor-template.json': descriptor(['KAFKA_HOST', 'MONGODB_URI']),
      'src/main/java/org/example/Main.java': 'import org.folio.rest.persist.PostgresClient;\nclass Main extends AbstractVerticle {}'
    });

    expect(result.items.map(item => [item.id, item.usage])).toEqual([['kafka', 'required'], ['mongodb', 'configuration-only']]);
  });

  it('gives the storage evidence to the database a JDBC URL names, and to PostgreSQL otherwise', async () => {
    const files = (url: string) => ({
      'pom.xml': pom('mod-example'),
      'src/main/resources/db/changelog/changelog-master.xml': '<databaseChangeLog/>',
      'src/main/resources/application.properties': `spring.datasource.url=${url}\n`
    });
    const mysql = await infrastructure(files('jdbc:mysql://db/example'));
    const postgresql = await infrastructure(files('jdbc:postgresql://db/example'));

    const storage = [
      { kind: 'storage', detail: 'Liquibase changelog src/main/resources/db/changelog/changelog-master.xml' },
      { kind: 'storage', detail: 'Datasource configured in src/main/resources/application.properties' }
    ];
    expect(mysql.items).toEqual([{
      id: 'mysql', name: 'MySQL', usage: 'required',
      signals: [...storage, { kind: 'configuration', detail: 'spring.datasource.url (jdbc:mysql)', path: 'src/main/resources/application.properties' }]
    }]);
    expect(postgresql.items.map(item => [item.id, item.usage, item.signals.length])).toEqual([['postgresql', 'required', 3]]);
  });

  it('treats Vault and AWS SSM as selectable secure stores only where edge-common chooses the store', async () => {
    const stores = `${dependency('ssm', 'software.amazon.awssdk')}${dependency('vault-java-driver', 'com.bettercloud')}`;
    const edge = await infrastructure({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}${stores}</dependencies>`),
      'src/main/resources/vault.properties': 'secureStore.type=Vault\n'
    });
    const spring = await infrastructure({ 'pom.xml': pom('mod-example', `<dependencies>${stores}</dependencies>`) });
    const dependent = await infrastructure({ 'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}${stores}</dependencies>`) });
    const configured = await infrastructure({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common-spring')}</dependencies>`),
      'src/main/resources/aws_ss.properties': 'secureStore.type=AwsSsm\n',
      'src/main/resources/ephemeral.properties': 'secureStore.type=Ephemeral\n'
    });

    const note = 'edge-common secure store, chosen with secure_store; the default is Ephemeral';
    expect(edge.items).toEqual([
      { id: 'aws-ssm', name: 'AWS Systems Manager Parameter Store', usage: 'optional', signals: [{ kind: 'dependency', detail: 'software.amazon.awssdk:ssm', path: 'pom.xml', optional: note }] },
      {
        id: 'vault', name: 'HashiCorp Vault', usage: 'optional', signals: [
          { kind: 'dependency', detail: 'com.bettercloud:vault-java-driver', path: 'pom.xml', optional: note },
          { kind: 'configuration', detail: 'secureStore.type=Vault', path: 'src/main/resources/vault.properties', optional: note }
        ]
      }
    ]);
    expect(dependent.items.map(item => [item.id, item.usage])).toEqual([['aws-ssm', 'optional'], ['vault', 'optional']]);
    expect(spring.items.map(item => [item.id, item.usage])).toEqual([['aws-ssm', 'required'], ['vault', 'required']]);
    expect(configured.items).toEqual([
      { id: 'aws-ssm', name: 'AWS Systems Manager Parameter Store', usage: 'optional', signals: [{ kind: 'configuration', detail: 'secureStore.type=AwsSsm', path: 'src/main/resources/aws_ss.properties', optional: note }] }
    ]);
  });

  it('reads Gradle declarations with lines and reports the ones it cannot read', async () => {
    const result = await infrastructure({
      'service/build.gradle': [
        'dependencies {',
        '  implementation platform("org.grails:grails-bom:$grailsVersion")',
        '  runtimeOnly "org.postgresql:postgresql:${postgresVersion}"',
        '  implementation group: \'org.apache.kafka\', name: \'kafka-clients\', version: kafkaVersion',
        '  // implementation "redis.clients:jedis:5.0.0"',
        '  testImplementation "org.mongodb:mongodb-driver-sync:5.0.0"',
        '  implementation libs.lettuce',
        '  implementation "${solrGroup}:solr-solrj:9.0.0"',
        '  implementation project(":shared")',
        '}'
      ].join('\n'),
      'buildSrc/build.gradle': 'dependencies { implementation "io.minio:minio:8.5.0" }'
    });

    expect(result.items).toEqual([
      { id: 'postgresql', name: 'PostgreSQL', usage: 'required', signals: [{ kind: 'dependency', detail: 'org.postgresql:postgresql', path: 'service/build.gradle', line: 3 }] },
      { id: 'kafka', name: 'Apache Kafka', usage: 'required', signals: [{ kind: 'dependency', detail: 'org.apache.kafka:kafka-clients', path: 'service/build.gradle', line: 4 }] }
    ]);
    expect(result.buildFiles).toEqual(['service/build.gradle']);
    expect(result.diagnostics).toEqual([
      { path: 'service/build.gradle', line: 7, message: 'a dependency that is not a plain "group:name" string, such as a version catalog entry or a variable' },
      { path: 'service/build.gradle', line: 8, message: 'a dependency that is not a plain "group:name" string, such as a version catalog entry or a variable' }
    ]);
  });

  it('resolves Maven properties in coordinates and reports the ones it cannot resolve or parse', async () => {
    const result = await infrastructure({
      'pom.xml': pom('mod-example', `<properties><redis.group>redis.clients</redis.group></properties><dependencies>${
        dependency('jedis', '${redis.group}')}${dependency('folio-s3-client', '${project.groupId}')}${dependency('lettuce-core', '${lettuce.group}')}</dependencies>`),
      'other/pom.xml': '<project><dependencies>',
      'src/main/resources/application.yml': 'spring: [unclosed\n'
    });

    expect(result.items.map(item => [item.id, item.signals.map(signal => signal.detail)])).toEqual([
      ['s3', ['org.folio:folio-s3-client']],
      ['redis', ['redis.clients:jedis']]
    ]);
    expect(result.diagnostics.map(diagnostic => [diagnostic.path, diagnostic.message.replace(/: .*/s, '')])).toEqual([
      ['other/pom.xml', 'not valid XML'],
      ['pom.xml', 'the dependency ${lettuce.group}:lettuce-core uses a property the tool could not resolve'],
      ['src/main/resources/application.yml', 'not valid YAML']
    ]);
  });

  it('scans build files, configuration and sources in linear time', async () => {
    const evidence = async (size: number) => {
      const root = repository({
        'pom.xml': pom('mod-example', `<dependencies>${Array.from({ length: size }, (_item, index) => dependency(`lib${index}`, '${missing')).join('')}</dependencies>`),
        'build.gradle': `dependencies {\n${'  implementation group: "a b c d e f '.repeat(size)}\n${'  implementation "x:y:1", "${'.repeat(size)}\n}`,
        'src/main/resources/application.yml': `${Array.from({ length: size }, (_item, index) => `k${index}:\n  spring.kafka.x: "jdbc:postgresql:${'$'.repeat(20)}"\n`).join('')}deep: ${'['.repeat(100)}${']'.repeat(100)}\n`,
        'src/main/resources/a.properties': `${'x=${KAFKA_'.repeat(size * 20)}\ny=\${KAFKA_HOST}\n`,
        'src/main/java/org/example/Main.java': `class Main { ${'System.getenv( "KAFKA_X'.repeat(size * 20)} }`
      });
      return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
    };

    const result = await expectLinearTime(400, evidence, collectBackendInfrastructure);

    expect(result.items.map(item => [item.id, item.usage])).toEqual([['postgresql', 'configuration-only'], ['kafka', 'configuration-only']]);
  }, 120_000);
});
