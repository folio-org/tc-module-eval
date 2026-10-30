import YAML from 'yaml';
import {
  BackendEvidence,
  BackendInfrastructure,
  BackendInfrastructureEvidence,
  BackendInfrastructureId,
  BackendInfrastructureSignal,
  EvaluationRun
} from '../types';
import { getBackendEvidence, SOURCE_FILE } from './backend-evidence';
import { CommittedSourceFile } from './committed-source';
import {
  asArray,
  parseJavaProperties,
  parsePom,
  quotedGradleLiteral,
  scanGradleDeclarations,
  splitGradleArguments,
  stripGradleComments,
  xmlText
} from './manifest-parsers';
import { listText, unique } from './report-text';
import { errorMessage, isRecord } from './type-guards';

interface Definition {
  id: BackendInfrastructureId;
  name: string;
  dependency: RegExp;
  configuration?: RegExp;
  environment?: RegExp;
}

const DEFINITIONS: Definition[] = [
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    dependency: /^(?:org\.postgresql:(?:postgresql|r2dbc-postgresql)|io\.vertx:vertx-pg-client)$/,
    environment: /^DB_/
  },
  {
    id: 'kafka',
    name: 'Apache Kafka',
    dependency: /^(?:org\.apache\.kafka:.+|org\.springframework\.kafka:spring-kafka|org\.springframework\.boot:spring-boot-(?:starter-)?kafka|io\.vertx:vertx-kafka-client|org\.folio:(?:folio-kafka-wrapper|folio-spring-kafka)|org\.springframework\.cloud:spring-cloud-stream-binder-kafka(?:-streams)?)$/,
    configuration: /^spring\.kafka\./,
    environment: /^KAFKA_/
  },
  {
    id: 'opensearch',
    name: 'OpenSearch',
    dependency: /^(?:org\.opensearch\.client:.+|org\.opensearch:opensearch(?:-java|-rest-client|-rest-high-level-client)?)$/,
    configuration: /^(?:spring\.)?opensearch\./,
    environment: /^OPENSEARCH_/
  },
  {
    id: 'elasticsearch',
    name: 'Elasticsearch',
    dependency: /^(?:co\.elastic\.clients:.+|org\.elasticsearch\.client:.+|org\.elasticsearch:elasticsearch|org\.springframework\.data:spring-data-elasticsearch|org\.springframework\.boot:spring-boot-starter-data-elasticsearch)$/,
    configuration: /^spring\.(?:data\.)?elasticsearch\./,
    environment: /^ELASTICSEARCH_/
  },
  {
    id: 's3',
    name: 'S3 object storage',
    dependency: /^(?:io\.minio:minio|software\.amazon\.awssdk:s3(?:-transfer-manager)?|com\.amazonaws:aws-java-sdk-s3|org\.folio:folio-s3-client|io\.awspring\.cloud:spring-cloud-aws-starter-s3)$/,
    environment: /^S3_/
  },
  {
    id: 'keycloak',
    name: 'Keycloak',
    dependency: /^org\.keycloak:keycloak-(?:admin-client|authz-client)$/,
    environment: /^KEYCLOAK_/
  },
  {
    id: 'redis',
    name: 'Redis',
    dependency: /^(?:redis\.clients:jedis|io\.lettuce:lettuce-core|org\.redisson:.+|org\.springframework\.data:spring-data-redis|org\.springframework\.boot:spring-boot-starter-data-redis(?:-reactive)?|io\.vertx:vertx-redis-client)$/,
    configuration: /^spring\.(?:data\.)?redis\./,
    environment: /^REDIS_/
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    dependency: /^(?:org\.mongodb:.+|org\.springframework\.data:spring-data-mongodb|org\.springframework\.boot:spring-boot-starter-data-mongodb(?:-reactive)?|io\.vertx:vertx-mongo-client)$/,
    configuration: /^spring\.(?:data\.)?mongodb\./,
    environment: /^MONGO(?:DB)?_/
  },
  {
    id: 'rabbitmq',
    name: 'RabbitMQ',
    dependency: /^(?:com\.rabbitmq:.+|org\.springframework\.amqp:.+|org\.springframework\.boot:spring-boot-starter-amqp|io\.vertx:vertx-rabbitmq-client)$/,
    configuration: /^spring\.rabbitmq\./,
    environment: /^RABBITMQ_/
  },
  {
    id: 'activemq',
    name: 'Apache ActiveMQ',
    dependency: /^(?:org\.apache\.activemq:.+|org\.springframework\.boot:spring-boot-starter-(?:activemq|artemis))$/,
    configuration: /^spring\.(?:activemq|artemis)\./,
    environment: /^(?:ACTIVEMQ|ARTEMIS)_/
  },
  {
    id: 'cassandra',
    name: 'Apache Cassandra',
    dependency: /^(?:com\.datastax\.(?:oss|cassandra):.+|org\.apache\.cassandra:java-driver-.+|org\.springframework\.data:spring-data-cassandra|org\.springframework\.boot:spring-boot-starter-data-cassandra(?:-reactive)?|io\.vertx:vertx-cassandra-client)$/,
    configuration: /^spring\.(?:data\.)?cassandra\./,
    environment: /^CASSANDRA_/
  },
  {
    id: 'solr',
    name: 'Apache Solr',
    dependency: /^(?:org\.apache\.solr:solr-solrj|org\.springframework\.data:spring-data-solr)$/,
    environment: /^SOLR_/
  },
  {
    id: 'hazelcast',
    name: 'Hazelcast (client)',
    dependency: /^com\.hazelcast:hazelcast-client(?:-.+)?$/
  },
  {
    id: 'aws-ssm',
    name: 'AWS Systems Manager Parameter Store',
    dependency: /^(?:software\.amazon\.awssdk:ssm|com\.amazonaws:aws-java-sdk-ssm|io\.awspring\.cloud:spring-cloud-aws-starter-parameter-store)$/
  },
  {
    id: 'aws-sqs',
    name: 'Amazon SQS',
    dependency: /^(?:software\.amazon\.awssdk:sqs|com\.amazonaws:aws-java-sdk-sqs|io\.awspring\.cloud:spring-cloud-aws-starter-sqs)$/
  },
  {
    id: 'aws-sns',
    name: 'Amazon SNS',
    dependency: /^(?:software\.amazon\.awssdk:sns|com\.amazonaws:aws-java-sdk-sns|io\.awspring\.cloud:spring-cloud-aws-starter-sns)$/
  },
  {
    id: 'vault',
    name: 'HashiCorp Vault',
    dependency: /^(?:com\.bettercloud:vault-java-driver|io\.github\.jopenlibs:vault-java-driver|org\.springframework\.vault:.+|org\.springframework\.cloud:spring-cloud-(?:starter-)?vault-config|io\.vertx:vertx-config-vault)$/,
    configuration: /^spring\.cloud\.vault\./,
    environment: /^VAULT_/
  },
  {
    id: 'mysql',
    name: 'MySQL',
    dependency: /^(?:mysql:mysql-connector-java|com\.mysql:mysql-connector-j|io\.vertx:vertx-mysql-client)$/
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    dependency: /^org\.mariadb\.jdbc:mariadb-java-client$/
  }
];

const JDBC_URL = /^\s*jdbc:(postgresql|mysql|mariadb):/i;
const SIGNAL_ORDER: Array<BackendInfrastructureSignal['kind']> = ['dependency', 'storage', 'configuration', 'environment'];
const OTHER_DATABASES: BackendInfrastructureId[] = ['mysql', 'mariadb'];
const JDBC_IDS: Record<string, BackendInfrastructureId> = { postgresql: 'postgresql', mysql: 'mysql', mariadb: 'mariadb' };

// edge-common reads the secure store from `secure_store` (Ephemeral, AwsSsm or Vault; default Ephemeral) and its
// settings, including `secureStore.type`, from the properties file `secure_store_props` names.
const SECURE_STORES: Record<string, BackendInfrastructureId> = { awsssm: 'aws-ssm', vault: 'vault' };
const SECURE_STORE_KEY = 'securestore.type';
const SECURE_STORE_NOTE = 'edge-common secure store, chosen with secure_store; the default is Ephemeral';
const EDGE_COMMON = /^org\.folio:edge-common(?:-spring)?$/;

const GRADLE_CONFIGURATIONS = ['api', 'implementation', 'compileOnly', 'runtimeOnly', 'compile', 'runtime'];
const GRADLE_IGNORED = /^(?:project|files|fileTree|platform|enforcedPlatform|gradleApi|localGroovy|kotlin)\s*\(/;
const GRADLE_BUILD = /(?:^|\/)build\.gradle(?:\.kts)?$/;
const MAVEN_BUILD = /(?:^|\/)pom\.xml$/;
const BUILD_SCRIPTS = /^(?:buildSrc|build-logic)\//;
const CONFIGURATION_FILE = /(?:^|\/)(?:src\/main\/resources|grails-app\/conf)\/(?:.*\/)?[^/]+\.(?:ya?ml|properties)$/;
const ENV_PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)[:}]/g;
const GETENV = /\bSystem\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g;
const MAVEN_PROPERTY = /\$\{([^{}]+)\}/g;

/** The infrastructure in backendEvidence's snapshot, collected once per run. */
export function getBackendInfrastructure(run: EvaluationRun, repoPath: string): Promise<BackendInfrastructureEvidence> {
  return run.getOrCreateArtifact('backendInfrastructure', async () => collectBackendInfrastructure(await getBackendEvidence(run, repoPath)));
}

/**
 * Infrastructure from direct production dependencies in every `pom.xml` and `build.gradle(.kts)` (test scopes and
 * configurations left out), backendEvidence's storage evidence (PostgreSQL), configuration keys and JDBC URLs, and
 * environment variable prefixes. Transitive dependencies are not visible without running the build.
 */
export async function collectBackendInfrastructure(evidence: BackendEvidence): Promise<BackendInfrastructureEvidence> {
  const files = evidence.snapshot.files;
  const signals = new Map<BackendInfrastructureId, BackendInfrastructureSignal[]>();
  const add = (id: BackendInfrastructureId, signal: BackendInfrastructureSignal) => {
    const list = signals.get(id) ?? [];
    signals.set(id, list);
    list.push(signal);
  };
  const diagnostics: BackendInfrastructureEvidence['diagnostics'] = [];
  const buildFiles: string[] = [];
  const coordinates: Array<{ coordinate: string; path: string; line?: number; optional?: string }> = [];

  for (const file of files) {
    if (BUILD_SCRIPTS.test(file.path)) continue;
    if (MAVEN_BUILD.test(file.path)) {
      buildFiles.push(file.path);
      await mavenDependencies(file, coordinates, diagnostics);
    } else if (GRADLE_BUILD.test(file.path)) {
      buildFiles.push(file.path);
      gradleDependencies(file, coordinates, diagnostics);
    }
  }

  const configuration = configurationEvidence(files, diagnostics);
  const usesSecureStores = ['edge-common', 'edge-common-spring'].includes(evidence.artifactId ?? '')
    || coordinates.some(({ coordinate, optional }) => !optional && EDGE_COMMON.test(coordinate))
    || configuration.secureStores.length > 0;

  for (const { coordinate, path, line, optional } of coordinates) {
    const definition = DEFINITIONS.find(candidate => candidate.dependency.test(coordinate));
    if (!definition) continue;
    const secureStore = usesSecureStores && (definition.id === 'aws-ssm' || definition.id === 'vault');
    add(definition.id, { kind: 'dependency', detail: coordinate, path, ...(line ? { line } : {}), ...(optional || secureStore ? { optional: optional ?? SECURE_STORE_NOTE } : {}) });
  }
  for (const { id, path, details } of configuration.keys) add(id, { kind: 'configuration', detail: listText(unique(details)), path });
  if (evidence.storage.present) {
    const databases = OTHER_DATABASES.filter(id => signals.has(id));
    for (const id of databases.length ? databases : ['postgresql' as const]) {
      for (const detail of evidence.storage.evidence) add(id, { kind: 'storage', detail });
    }
  }
  for (const { id, path, key, value } of configuration.secureStores) {
    add(id, { kind: 'configuration', detail: `${key}=${value}`, path, optional: SECURE_STORE_NOTE });
  }
  for (const { path, names } of environmentNames(evidence, files)) {
    for (const definition of DEFINITIONS) {
      const matching = unique(names.filter(name => definition.environment?.test(name)));
      if (matching.length) add(definition.id, { kind: 'environment', detail: listText(matching), path });
    }
  }

  const items: BackendInfrastructure[] = DEFINITIONS.flatMap(({ id, name }) => {
    const found = signals.get(id);
    if (!found) return [];
    const required = found.some(signal => (signal.kind === 'dependency' || signal.kind === 'storage') && !signal.optional);
    const usage = required ? 'required' : found.some(signal => signal.optional) ? 'optional' : 'configuration-only';
    return [{ id, name, usage, signals: [...found].sort((left, right) => SIGNAL_ORDER.indexOf(left.kind) - SIGNAL_ORDER.indexOf(right.kind)) }];
  });
  return { items, buildFiles, diagnostics, sourceDiagnostics: evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.material) };
}

async function mavenDependencies(
  file: CommittedSourceFile,
  coordinates: Array<{ coordinate: string; path: string; optional?: string }>,
  diagnostics: BackendInfrastructureEvidence['diagnostics']
): Promise<void> {
  const parsed = await parsePom(file.content);
  if (!parsed.ok) {
    diagnostics.push({ path: file.path, message: parsed.reason === 'invalid-xml' ? `not valid XML: ${parsed.message}` : 'no <project> element' });
    return;
  }
  const project = parsed.project;
  const properties = new Map<string, string>();
  if (isRecord(project.properties)) for (const [name, value] of Object.entries(project.properties)) properties.set(name, xmlText(value));
  const groupId = xmlText(project.groupId) || xmlText(project.parent?.groupId);
  for (const [name, value] of [['project.groupId', groupId], ['project.artifactId', xmlText(project.artifactId)],
    ['project.parent.groupId', xmlText(project.parent?.groupId)]]) {
    if (value) properties.set(name, value);
  }
  const resolve = (text: string) => text.replace(MAVEN_PROPERTY, (whole, name: string) => properties.get(name) ?? whole);
  const read = (dependencies: unknown, profile?: string) => {
    for (const dependency of asArray(dependencies)) {
      if (xmlText(dependency?.scope) === 'test') continue;
      const coordinate = `${resolve(xmlText(dependency?.groupId))}:${resolve(xmlText(dependency?.artifactId))}`;
      if (coordinate.includes('${')) {
        diagnostics.push({ path: file.path, message: `the dependency ${coordinate} uses a property the tool could not resolve` });
        continue;
      }
      const optional = xmlText(dependency?.optional) === 'true' ? 'Maven optional dependency'
        : profile !== undefined ? `declared in the Maven profile ${profile || '(no id)'}` : undefined;
      coordinates.push({ coordinate, path: file.path, ...(optional ? { optional } : {}) });
    }
  };
  read(project.dependencies?.dependency);
  for (const profile of asArray(project.profiles?.profile)) read(profile?.dependencies?.dependency, xmlText(profile?.id));
}

function gradleDependencies(
  file: CommittedSourceFile,
  coordinates: Array<{ coordinate: string; path: string; line?: number }>,
  diagnostics: BackendInfrastructureEvidence['diagnostics']
): void {
  const content = stripGradleComments(file.content);
  const lineStarts = [0];
  for (let index = content.indexOf('\n'); index >= 0; index = content.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  const lineOf = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  if (/\bapply\s*(?:\(\s*)?from\s*[:=]/.test(content)) {
    diagnostics.push({ path: file.path, message: 'applies another Gradle script (apply from), which may declare more dependencies' });
  }
  for (const declaration of scanGradleDeclarations(content, GRADLE_CONFIGURATIONS)) {
    const line = lineOf(declaration.offset);
    const expression = declaration.expression.trim();
    if (expression.startsWith('{')) continue;
    const group = /\bgroup\s*[:=]\s*(['"])([^'"]*)\1/.exec(expression);
    const name = /\bname\s*[:=]\s*(['"])([^'"]*)\1/.exec(expression);
    const argumentsList = group && name ? [] : splitGradleArguments(expression);
    const literals = group && name ? [`${group[2]}:${name[2]}`] : argumentsList.map(argument => {
      if (GRADLE_IGNORED.test(argument)) return null;
      return quotedGradleLiteral(argument) ?? undefined;
    });
    for (const literal of literals) {
      if (literal === null) continue;
      const [groupId, artifactId] = literal?.split(':') ?? [];
      if (!groupId || !artifactId || /\$/.test(`${groupId}:${artifactId}`)) {
        diagnostics.push({ path: file.path, line, message: 'a dependency that is not a plain "group:name" string, such as a version catalog entry or a variable' });
        continue;
      }
      coordinates.push({ coordinate: `${groupId}:${artifactId}`, path: file.path, line });
    }
  }
}

interface ConfigurationEvidence {
  keys: Array<{ id: BackendInfrastructureId; path: string; details: string[] }>;
  secureStores: Array<{ id: BackendInfrastructureId; path: string; key: string; value: string }>;
}

function configurationEvidence(files: CommittedSourceFile[], diagnostics: BackendInfrastructureEvidence['diagnostics']): ConfigurationEvidence {
  const result: ConfigurationEvidence = { keys: [], secureStores: [] };
  for (const file of files) {
    if (!CONFIGURATION_FILE.test(file.path)) continue;
    let entries: Array<[string, string]>;
    if (file.path.endsWith('.properties')) {
      entries = [...parseJavaProperties(file.content)];
    } else {
      const parsed = yamlEntries(file.content);
      if ('error' in parsed) {
        diagnostics.push({ path: file.path, message: `not valid YAML: ${parsed.error}` });
        continue;
      }
      entries = parsed.entries;
    }
    const keys = new Map<BackendInfrastructureId, string[]>();
    const note = (id: BackendInfrastructureId, detail: string) => keys.set(id, [...keys.get(id) ?? [], detail]);
    for (const [key, value] of entries) {
      const lower = key.toLowerCase();
      for (const definition of DEFINITIONS) {
        if (definition.configuration?.test(lower)) note(definition.id, key);
      }
      const jdbc = JDBC_URL.exec(value);
      if (jdbc) note(JDBC_IDS[jdbc[1].toLowerCase()], `${key} (jdbc:${jdbc[1].toLowerCase()})`);
      const store = lower === SECURE_STORE_KEY ? SECURE_STORES[value.trim().toLowerCase()] : undefined;
      if (store) result.secureStores.push({ id: store, path: file.path, key, value: value.trim() });
    }
    for (const [id, details] of keys) result.keys.push({ id, path: file.path, details });
  }
  return result;
}

function yamlEntries(content: string): { entries: Array<[string, string]> } | { error: string } {
  const entries: Array<[string, string]> = [];
  try {
    for (const document of YAML.parseAllDocuments(content, { schema: 'failsafe', uniqueKeys: false, logLevel: 'error' })) {
      if (document.errors.length) return { error: document.errors[0].message };
      const stack: Array<[string, unknown]> = [['', document.toJS({ maxAliasCount: 100 })]];
      while (stack.length) {
        const [prefix, value] = stack.pop()!;
        if (isRecord(value)) {
          for (const [key, child] of Object.entries(value)) stack.push([prefix ? `${prefix}.${key}` : key, child]);
        } else if (Array.isArray(value)) {
          for (const child of value) stack.push([prefix, child]);
        } else if (prefix) {
          entries.push([prefix, typeof value === 'string' ? value : '']);
        }
      }
    }
  } catch (error) {
    return { error: errorMessage(error) };
  }
  return { entries };
}

function environmentNames(evidence: BackendEvidence, files: CommittedSourceFile[]): Array<{ path: string; names: string[] }> {
  const result: Array<{ path: string; names: string[] }> = [];
  const template = evidence.template;
  if (template?.descriptor && isRecord(template.descriptor)) {
    const launch = isRecord(template.descriptor.launchDescriptor) ? template.descriptor.launchDescriptor.env : undefined;
    const names = [...asArray(launch), ...asArray(template.descriptor.env)]
      .flatMap(entry => isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : []);
    if (names.length) result.push({ path: template.path, names });
  }
  for (const file of files) {
    const pattern = CONFIGURATION_FILE.test(file.path) ? ENV_PLACEHOLDER : SOURCE_FILE.test(file.path) ? GETENV : undefined;
    if (!pattern) continue;
    const names = [...file.content.matchAll(pattern)].map(match => match[1]);
    if (names.length) result.push({ path: file.path, names });
  }
  return result;
}
