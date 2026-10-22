import * as path from 'path';
import { CriterionLanguage } from '../criteria-definitions';
import {
  ModuleKindResult,
  S010Diagnostic,
  S010Evidence,
  S010RuntimeKind,
  S010ScenarioEvidence
} from '../types';
import { CommittedSourceFile, readCommittedSource } from './committed-source';

const LIBRARY_NAMES = new Set([
  'folio-spring-base',
  'folio-spring-support',
  'folio-kafka-wrapper',
  'stripes-components',
  'stripes-core',
  'stripes-connect',
  'stripes-smart-components',
  'stripes-testing'
]);

export const S010_SOURCE_LIMITS = {
  maxFiles: 1_500,
  maxFileBytes: 192 * 1024,
  maxTotalBytes: 6 * 1024 * 1024
};

const MAX_SCENARIOS = 1_000;

const SOURCE_PATTERN = /(?:^|\/)(?:src|descriptors?|config)(?:\/|$)|(?:^|\/)(?:pom\.xml|package\.json|build\.gradle(?:\.kts)?|README(?:\.md)?|ENV_VARS\.md)$/i;
const EXTERNAL_CONFIG_PATTERN = /(?:URL|URI|HOST|BROKER|ENDPOINT|BUCKET|DATABASE|DB_|KAFKA|S3_|ELASTIC|OPENSEARCH|SMTP|OKAPI)/i;
const JAVA_DATABASE_PATTERN = /\b(?:JdbcTemplate|NamedParameterJdbcTemplate|DataSource|JpaRepository|CrudRepository|EntityManager|R2dbcEntityTemplate|DatabaseClient|FolioSpringLiquibase|SpringLiquibase|Flyway)\b/;
const JAVA_OPENSEARCH_PATTERN = /\borg\.opensearch\.client\.(?:RestHighLevelClient|RestClient|opensearch\.OpenSearch(?:Async)?Client)\b/;
// A browser fetch call whose URL starts with a literal absolute address; the host is captured. The host
// must end at a delimiter, so `https://api.${domain}` is a computed address, not host "api.".
const LITERAL_HOST = String.raw`['"\x60]https?:\/\/([^/'"\x60?#$\s:\\]+)(?=[/'"\x60?#:])`;
const LITERAL_FETCH_PATTERN = new RegExp(String.raw`(?<![\w$])fetch\s*\(\s*` + LITERAL_HOST, 'g');
// Each entry lists patterns any of which marks a file; `searchFilePatterns` replace them in files with a
// recognized OpenSearch client, whose RestClient and elasticsearchClient names are already covered.
// Quantifiers stay bounded so repository content cannot make matching slow.
const UNSUPPORTED_PATTERNS: Array<{
  category: string;
  patterns: RegExp[];
  searchFilePatterns?: RegExp[];
  javascriptOnly?: boolean;
  excludeDatabaseFiles?: boolean;
}> = [
  { category: 'code loaded at runtime (reflection or ServiceLoader)', patterns: [/java\.lang\.reflect|Class\.forName|ServiceLoader/i] },
  { category: 'Vert.x, RAML Module Builder or generated clients', patterns: [/generated[-_/ ]client|vertx|raml-module-builder/i] },
  {
    category: 'HTTP clients (Spring HTTP interfaces, RestClient, Feign, Retrofit, OkHttp, Apache HttpClient or URLConnection)',
    patterns: [/URLConnection|FeignClient|Retrofit|OkHttpClient|CloseableHttpClient|\bHttpClients\b|@(?:Http|Get|Post|Put|Patch|Delete)Exchange\b/i, /\bRestClient\b/],
    // Beside an OpenSearch client, a bare RestClient is OpenSearch's; Spring's is recognized by its import.
    searchFilePatterns: [
      /URLConnection|FeignClient|Retrofit|OkHttpClient|CloseableHttpClient|\bHttpClients\b|@(?:Http|Get|Post|Put|Patch|Delete)Exchange\b/i,
      /\borg\.springframework\.web\.client\.RestClient\b/
    ]
  },
  {
    category: 'datastore clients (JDBC, Redis, MongoDB or Elasticsearch)',
    // Plain DataSource is the database recognizer's; here only type names such as HikariDataSource count, not
    // dataSource props, MetadataSource or DataSourceResolver.
    patterns: [/JdbcTemplate|RedisTemplate|MongoClient|ElasticsearchClient|OpenSearchClient/i, /\b[A-Z][A-Za-z0-9]*DataSource\b/],
    // Beside an OpenSearch client, elasticsearchClient and openSearchClient names are that client's.
    searchFilePatterns: [/\b(?:JdbcTemplate|DataSource|RedisTemplate|MongoClient|ElasticsearchClient)\b/, /\b[A-Z][A-Za-z0-9]*DataSource\b/],
    excludeDatabaseFiles: true
  },
  { category: 'object storage clients (AWS S3, MinIO or the FOLIO S3 client)', patterns: [/\b(?:AmazonS3|S3AsyncClient|MinioClient|MinioAsyncClient|FolioS3Client)\b/] },
  {
    category: 'messaging or RPC clients (Kafka listeners and consumers, JMS, RabbitMQ or gRPC)',
    patterns: [/RabbitTemplate|ManagedChannelBuilder|@KafkaListener\b|\bKafkaConsumer\b|\bKafkaProducer\b|@RabbitListener\b|\bJmsTemplate\b|@JmsListener\b/i]
  },
  {
    category: 'Stripes or browser request helpers (stripes-connect, ky, axios or process.env)',
    patterns: [/\baxios\b|\bky\s*\(|\bokapi\b|\bmutator\b|process\.env\[[^\]]{1,256}\]/i],
    javascriptOnly: true
  },
  {
    category: 'browser requests the tool cannot follow (fetch with a computed or relative URL, XMLHttpRequest, WebSocket or EventSource)',
    // The lookahead holds the whitespace so it cannot be backtracked to dodge the literal-address check.
    patterns: [new RegExp(String.raw`(?<![\w$])fetch\s*\((?!\s*` + LITERAL_HOST + String.raw`)|\bXMLHttpRequest\b|\bnew\s+(?:WebSocket|EventSource)\s*\(|\bsendBeacon\s*\(`)],
    javascriptOnly: true
  }
];

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  stripes?: Record<string, unknown>;
}

interface EnvDeclaration {
  name: string;
  line?: number;
  dependencyId: string;
  required: boolean;
  hasDefault: boolean;
  defaultIsEmpty: boolean;
  path: string;
}

export async function collectS010Evidence(
  repoPath: string,
  language: CriterionLanguage
): Promise<S010Evidence> {
  const snapshot = await readCommittedSource(repoPath, { include: isDeterministicS010Path, ...S010_SOURCE_LIMITS });
  const diagnostics: S010Diagnostic[] = snapshot.diagnostics.map(item => ({ ...item }));
  const files = new Map(snapshot.files.map(file => [file.path, file]));
  const packageJson = parsePackageJson(files.get('package.json'), diagnostics);
  const pom = files.get('pom.xml')?.content;
  const runtimeKind = determineRuntimeKind(snapshot.files, packageJson, language);
  const moduleKind = determineModuleKind(snapshot.files, packageJson, pom, runtimeKind);
  const scenarios: S010ScenarioEvidence[] = [];
  let semanticIncomplete = runtimeKind === 'node' || runtimeKind === 'mixed' || runtimeKind === 'unknown';

  const declarations = collectEnvDeclarations(snapshot.files, diagnostics);
  const javaFiles = snapshot.files.filter(file => file.path.endsWith('.java') && isProductionSource(file.path));
  const bindings = springBindings(javaFiles);
  for (const declaration of declarations) {
    const binding = bindings.get(declaration.name);
    const clearFailFast = Boolean(declaration.required && !declaration.hasDefault && binding?.withoutDefault);
    scenarios.push({
      id: `${declaration.dependencyId}:${declaration.name}/configuration-absent`,
      dependencyId: declaration.dependencyId,
      // A default or non-required override says nothing about service optionality.
      requirement: declaration.required ? 'required' : 'unresolved',
      scenario: 'configuration-absent',
      proof: clearFailFast ? 'clear-fail-fast' : 'unresolved',
      sourceReferences: [
        { path: declaration.path, ...(declaration.line ? { line: declaration.line } : {}), detail: declaration.required
          ? `${declaration.name} is marked required`
          : `${declaration.name} is not marked required (this does not show whether the service is optional)` },
        ...(binding ? [{ path: binding.path, line: binding.line, detail: `Reads ${declaration.name} with a Spring @Value binding` }] : [])
      ],
      boundedFailure: 'not-applicable',
      readiness: 'not-applicable',
      ...(!clearFailFast ? { rationale: 'The code does not show what happens at startup when this configuration is missing.' } : {})
    });
    if (!clearFailFast) semanticIncomplete = true;
  }

  const databaseFiles = javaFiles.filter(file => JAVA_DATABASE_PATTERN.test(file.content));
  if (databaseFiles.length > 0) {
    const databaseScenario = collectJavaDatabaseScenario(databaseFiles, snapshot.files);
    scenarios.push(databaseScenario);
    if (
      databaseScenario.proof === 'unresolved'
      || databaseScenario.boundedFailure === 'unknown'
      || databaseScenario.readiness === 'unknown'
    ) {
      semanticIncomplete = true;
    }
  }

  const searchFiles = javaFiles.filter(file => JAVA_OPENSEARCH_PATTERN.test(file.content));
  if (searchFiles.length > 0) {
    scenarios.push({
      id: 'search/runtime-unavailable',
      dependencyId: 'search',
      requirement: 'unresolved',
      scenario: 'runtime-unavailable',
      proof: 'unresolved',
      sourceReferences: searchFiles.map(file => ({
        path: file.path,
        line: lineAtOffset(file.content, JAVA_OPENSEARCH_PATTERN.exec(file.content)!.index),
        detail: 'Uses an OpenSearch client'
      })),
      boundedFailure: 'unknown',
      readiness: 'unknown',
      rationale: 'The module uses an OpenSearch client, but the tool does not follow its calls. Check that search calls have time limits, how an outage affects startup, tenant setup and readiness, and how the module recovers. A timeout setting or a catch block alone does not show this.'
    });
    semanticIncomplete = true;
  }

  for (const file of javaFiles) {
    if (!hasJavaClientOperation(file.content)) continue;
    const dependencyId = dependencyFromFile(file.path);
    const conditional = /@ConditionalOnProperty\b|@Profile\b/.test(file.content);
    const bounded = /\.timeout\s*\(|TimeLimiter|connectTimeout|readTimeout|responseTimeout/.test(file.content);
    const handled = /onErrorResume\s*\(|onErrorReturn\s*\(|fallbackMethod\s*=|catch\s*\(/.test(file.content);
    const startupCoupled = /@PostConstruct\b|ApplicationReadyEvent|HealthIndicator|ReadinessState/.test(file.content);
    const controlled = conditional && bounded && handled && !startupCoupled;
    scenarios.push({
      id: `${dependencyId}:${file.path}/runtime-unavailable`,
      dependencyId,
      requirement: conditional ? 'optional' : 'unresolved',
      scenario: 'runtime-unavailable',
      proof: controlled ? 'controlled-degradation' : 'unresolved',
      sourceReferences: [{ path: file.path, line: clientLine(file.content), detail: 'Uses an HTTP, Kafka or S3 client' }],
      boundedFailure: bounded ? 'proven' : 'unknown',
      readiness: controlled ? 'preserved' : 'unknown',
      ...(!controlled ? { rationale: 'The tool could not confirm that calls through the client have a time limit and error handling, whether the service is optional, or how an outage affects readiness.' } : {})
    });
    if (!controlled) semanticIncomplete = true;
  }

  if (runtimeKind === 'stripes-react') {
    for (const file of snapshot.files.filter(isJavaScriptProductionSource)) {
      const matches = [...file.content.matchAll(LITERAL_FETCH_PATTERN)];
      if (!matches.length) continue;
      const lineAt = lineLookup(file.content);
      // File-wide signals, checked once per file rather than once per request.
      const bounded = /AbortController|AbortSignal\.timeout|signal\s*:|\btimeout\s*:/.test(file.content);
      const handled = /catch\s*\(|\.catch\s*\(|onError\s*:/.test(file.content);
      const bootstrap = /ReactDOM\.render|createRoot\s*\(|bootstrap|module\.exports\s*=/.test(file.content)
        || /(?:^|\/)(?:index|bootstrap)\.[jt]sx?$/.test(file.path);
      const controlled = bounded && handled && !bootstrap;
      for (const match of matches) {
        const dependencyId = match[1].toLowerCase();
        const operationLine = lineAt(match.index ?? 0);
        scenarios.push({
          id: `${dependencyId}:${file.path}:${operationLine}/runtime-unavailable`,
          dependencyId,
          requirement: controlled ? 'optional' : 'unresolved',
          scenario: 'runtime-unavailable',
          proof: controlled ? 'controlled-degradation' : 'unresolved',
          sourceReferences: [{ path: file.path, line: operationLine, detail: 'Sends a request to this host' }],
          boundedFailure: bounded ? 'proven' : 'unknown',
          readiness: controlled ? 'preserved' : 'unknown',
          ...(!controlled ? { rationale: 'The tool could not confirm that this request has a time limit and error handling and only affects the feature that sends it.' } : {})
        });
        if (!controlled) semanticIncomplete = true;
      }
    }
    const interfaces = packageStripesInterfaces(packageJson);
    for (const interfaceId of interfaces) {
      scenarios.push({
        id: `folio-interface:${interfaceId}/runtime-unavailable`,
        dependencyId: `folio-interface:${interfaceId}`,
        requirement: 'unresolved',
        scenario: 'runtime-unavailable',
        proof: 'unresolved',
        sourceReferences: [{ path: 'package.json', detail: 'Lists the interfaces the UI needs' }],
        boundedFailure: 'unknown',
        readiness: 'unknown',
        rationale: 'The UI needs these interfaces, but the tool does not follow how it behaves when the modules behind them are down.'
      });
      semanticIncomplete = true;
    }
  }

  const productionCode = snapshot.files.filter(file => isProductionCode(file.path));
  for (const unsupported of UNSUPPORTED_PATTERNS) {
    const matchingPaths = productionCode
      .filter(file => !unsupported.javascriptOnly || /\.[cm]?[jt]sx?$/.test(file.path))
      .filter(file => !unsupported.excludeDatabaseFiles || !databaseFiles.includes(file))
      .filter(file => {
        const patterns = searchFiles.includes(file) ? unsupported.searchFilePatterns ?? unsupported.patterns : unsupported.patterns;
        return patterns.some(pattern => pattern.test(file.content));
      })
      .map(file => file.path);
    if (matchingPaths.length === 0) continue;
    diagnostics.push({
      code: 'unsupported-runtime-pattern',
      message: unsupportedDiagnosticMessage(unsupported.category, matchingPaths),
      material: true,
      ...(matchingPaths.length === 1 ? { path: matchingPaths[0] } : {})
    });
    semanticIncomplete = true;
  }

  // Keep the report proportionate to the module, not to however many calls a repository repeats.
  const uniqueScenarios = deduplicateScenarios(scenarios);
  if (uniqueScenarios.length > MAX_SCENARIOS) {
    diagnostics.push({
      code: 'scenario-limit',
      message: `Found ${uniqueScenarios.length} dependency checks; only the first ${MAX_SCENARIOS} are listed.`,
      material: true
    });
  }

  return {
    moduleKind,
    runtimeKind,
    discoveryCoverage: snapshot.complete ? 'complete' : 'incomplete',
    semanticCoverage: runtimeKind === 'node' || runtimeKind === 'mixed'
      ? 'unsupported'
      : semanticIncomplete || diagnostics.some(item => item.material)
        ? 'incomplete'
        : 'complete',
    scenarios: uniqueScenarios.slice(0, MAX_SCENARIOS),
    diagnostics
  };
}

function collectJavaDatabaseScenario(
  databaseFiles: CommittedSourceFile[],
  allFiles: CommittedSourceFile[]
): S010ScenarioEvidence {
  const startupOwner = databaseFiles.find(file => isDatabaseStartupOwner(file.content));
  const conditional = databaseFiles.every(file => /@ConditionalOnProperty\b|@Profile\b/.test(file.content));
  const bounded = hasGlobalDatabaseFailureBound(allFiles, Boolean(startupOwner));
  const handled = databaseFiles.some(file => /catch\s*\(\s*(?:[\w.]+\.)?(?:DataAccessException|SQLException)\b/.test(file.content));
  const healthCoupled = databaseFiles.some(file => /\bHealthIndicator\b|\bReadinessState\b/.test(file.content));
  const configFile = allFiles
    .filter(file => /(?:application|bootstrap)[^/]*\.(?:ya?ml|properties)$/i.test(file.path)
      && /(?:spring\.datasource|datasource\s*:|jdbc:|r2dbc:)/i.test(file.content))
    .sort((left, right) => databaseConfigPriority(left.path) - databaseConfigPriority(right.path))[0];
  const sourceReferences = [
    ...(startupOwner ? [{
      path: startupOwner.path,
      line: databaseLine(startupOwner.content),
      detail: 'Runs database setup (migrations) at startup'
    }] : [{
      path: databaseFiles[0].path,
      line: databaseLine(databaseFiles[0].content),
      detail: databaseFiles.length === 1
        ? 'Uses the database'
        : `Uses the database (first of ${databaseFiles.length} files that do)`
    }]),
    ...(configFile ? [{ path: configFile.path, detail: 'Database connection settings' }] : [])
  ];

  if (startupOwner) {
    const clearFailFast = databaseStartupPropagates(startupOwner.content);
    return {
      id: 'database/startup-unavailable',
      dependencyId: 'database',
      requirement: 'required',
      scenario: 'startup-unavailable',
      proof: clearFailFast ? 'clear-fail-fast' : 'unresolved',
      sourceReferences,
      boundedFailure: bounded ? 'proven' : 'unknown',
      readiness: 'not-applicable',
      ...(!clearFailFast || !bounded ? {
        rationale: !clearFailFast
          ? 'The module sets up the database at startup, but the code does not show that a failure stops startup with a clear error.'
          : 'A database failure at startup stops the module, but the settings do not give both a connection timeout and a socket timeout, so startup could hang.'
      } : {})
    };
  }

  const controlled = conditional && bounded && handled && !healthCoupled;
  return {
    id: 'database/runtime-unavailable',
    dependencyId: 'database',
    requirement: conditional ? 'optional' : 'unresolved',
    scenario: 'runtime-unavailable',
    proof: controlled ? 'controlled-degradation' : 'unresolved',
    sourceReferences,
    boundedFailure: bounded ? 'proven' : 'unknown',
    readiness: controlled ? 'preserved' : 'unknown',
    ...(!controlled ? {
      rationale: 'The module uses a database, but the tool could not confirm whether it is optional, whether calls have time limits and error handling, or how an outage affects readiness.'
    } : {})
  };
}

function isDatabaseStartupOwner(content: string): boolean {
  const lifecycle = /implements\s+InitializingBean\b|@PostConstruct\b|\b(?:ApplicationRunner|CommandLineRunner)\b/.test(content);
  const migration = /\b(?:FolioSpringLiquibase|SpringLiquibase|Flyway)\b|\b(?:migrate|performLiquibaseUpdate)\s*\(/.test(content);
  const conditional = /@ConditionalOnProperty\b|@Profile\b/.test(content);
  return lifecycle && migration && !conditional;
}

function databaseStartupPropagates(content: string): boolean {
  return /afterPropertiesSet\s*\([^()]{0,256}\)\s*throws\b/.test(content)
    || /\b(?:run|migrate)\s*\([^()]{0,256}\)\s*throws\b/.test(content);
}

function hasGlobalDatabaseFailureBound(files: CommittedSourceFile[], startup: boolean): boolean {
  const content = files
    .filter(file => /\.(?:properties|ya?ml)$/.test(file.path))
    .map(file => databaseConfiguration(file))
    .join('\n');
  const connectionBound = hasPositiveSetting(content, /(?:connection[-.]?timeout|setConnectionTimeout)\s*(?:[:=(]\s*)/gi);
  const operationBound = hasPositiveSetting(
    content,
    startup
      ? /socketTimeout\s*(?:[:=(]\s*)/gi
      : /(?:socketTimeout|query[-.]?timeout|statement[-.]?timeout)\s*(?:[:=(]\s*)/gi
  );
  return connectionBound && operationBound;
}

function databaseConfiguration(file: CommittedSourceFile): string {
  if (file.path.endsWith('.properties')) {
    return file.content.split('\n')
      .filter(line => /^\s*(?:spring|quarkus)\.(?:datasource|r2dbc)\./i.test(line))
      .join('\n');
  }

  const settings: string[] = [];
  const parents: Array<{ indentation: number; key: string }> = [];
  let scalarIndentation: number | undefined;
  for (const line of file.content.split('\n')) {
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (scalarIndentation !== undefined) {
      if (!line.trim() || indentation > scalarIndentation) continue;
      scalarIndentation = undefined;
    }
    if (!line.trim() || /^\s*#/.test(line)) continue;

    // Split at the first colon instead of matching the value with overlapping whitespace quantifiers.
    const mapping = /^\s*([^\s:#][^:]*):/.exec(line);
    if (!mapping) continue;
    while (parents.length > 0 && parents[parents.length - 1].indentation >= indentation) parents.pop();

    const key = mapping[1].trim().replace(/^['"]|['"]$/g, '');
    const value = line.slice(mapping[0].length).replace(/(?<!\s)\s+#.*$/, '').trim();
    const path = [...parents.map(parent => parent.key), key].join('.');
    if (/^(?:(?:[&!]\S+)\s+)*[>|](?:[1-9][+-]?|[+-][1-9]?)?$/.test(value)) {
      scalarIndentation = indentation;
      continue;
    }
    if (value) {
      if (/(?:^|\.)(?:datasource|r2dbc)(?:\.|$)/i.test(path)) settings.push(`${key}: ${value}`);
    } else {
      parents.push({ indentation, key });
    }
  }
  return settings.join('\n');
}

function hasPositiveSetting(content: string, prefix: RegExp): boolean {
  for (const match of content.matchAll(prefix)) {
    const tail = content.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 80);
    const value = tail.match(/^(?:\$\{[^}:]+:)?\s*([0-9]+)(?:ms|s|min|m|h)?/i)?.[1];
    if (value && Number(value) > 0) return true;
  }
  return false;
}

function databaseLine(content: string): number {
  const match = JAVA_DATABASE_PATTERN.exec(content);
  return lineAtOffset(content, match?.index ?? 0);
}

function databaseConfigPriority(filePath: string): number {
  return /(?:^|\/)application\.(?:ya?ml|properties)$/i.test(filePath) ? 0 : 1;
}

function determineRuntimeKind(
  files: CommittedSourceFile[],
  packageJson: PackageJson | undefined,
  language: CriterionLanguage
): S010RuntimeKind {
  const java = files.some(file => file.path === 'pom.xml' || /build\.gradle(?:\.kts)?$/.test(file.path) || file.path.endsWith('.java'));
  const javascript = Boolean(packageJson);
  if (java && javascript) return 'mixed';
  if (java || language === 'java') return 'java';
  if (packageJson) {
    const dependencies = { ...packageJson.dependencies, ...packageJson.peerDependencies };
    const stripes = Object.keys(dependencies).some(name => name.startsWith('@folio/stripes') || name.startsWith('stripes-'));
    if (dependencies.react && (stripes || packageJson.stripes)) return 'stripes-react';
    return 'node';
  }
  return 'unknown';
}

function determineModuleKind(
  files: CommittedSourceFile[],
  packageJson: PackageJson | undefined,
  pom: string | undefined,
  runtimeKind: S010RuntimeKind
): ModuleKindResult {
  const names = [
    packageJson?.name?.replace(/^@folio\//, ''),
    pom?.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]
  ].filter((name): name is string => Boolean(name));
  const library = names.find(name => LIBRARY_NAMES.has(name));
  if (library) return { kind: 'library', evidence: [`Explicit library marker: ${library}`], warnings: [] };
  const descriptor = files.find(file => /(?:^|\/)ModuleDescriptor[^/]*\.json$/i.test(file.path));
  if (descriptor) return { kind: 'backend-module', evidence: [`Committed module descriptor: ${descriptor.path}`], warnings: [] };
  if (runtimeKind === 'stripes-react') return { kind: 'ui-module', evidence: ['Committed React and Stripes package metadata'], warnings: [] };
  return { kind: 'ambiguous', evidence: ['No explicit deployable module or library marker found'], warnings: [] };
}

function parsePackageJson(file: CommittedSourceFile | undefined, diagnostics: S010Diagnostic[]): PackageJson | undefined {
  if (!file) return undefined;
  try {
    return JSON.parse(file.content) as PackageJson;
  } catch {
    diagnostics.push({ code: 'package-json-invalid', message: 'Not valid JSON, so the tool could not read it.', material: true, path: file.path });
    return undefined;
  }
}

function collectEnvDeclarations(files: CommittedSourceFile[], diagnostics: S010Diagnostic[]): EnvDeclaration[] {
  const declarations: EnvDeclaration[] = [];
  for (const file of files.filter(item => /ModuleDescriptor[^/]*\.json$/i.test(item.path))) {
    try {
      const descriptor = JSON.parse(file.content) as Record<string, unknown>;
      const launch = descriptor.launchDescriptor as Record<string, unknown> | undefined;
      const env = (launch?.env ?? descriptor.env) as unknown;
      if (!Array.isArray(env)) continue;
      const nameLines = jsonNameLines(file.content);
      for (const value of env) {
        if (!value || typeof value !== 'object') continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.name !== 'string' || !EXTERNAL_CONFIG_PATTERN.test(entry.name)) continue;
        declarations.push({
          name: entry.name,
          line: nameLines.get(entry.name),
          dependencyId: dependencyFromConfig(entry.name),
          required: entry.required === true,
          hasDefault: typeof entry.value === 'string' && entry.value.length > 0,
          defaultIsEmpty: entry.value === '',
          path: file.path
        });
      }
    } catch {
      diagnostics.push({ code: 'descriptor-invalid', message: 'Not valid JSON, so the tool could not read its environment variables.', material: true, path: file.path });
    }
  }
  return declarations;
}

interface SpringBinding {
  path: string;
  line: number;
  withoutDefault: boolean;
}

// One pass over each file, instead of one regular expression per declaration and file. A placeholder
// belongs to the first file that binds it; that file proves fail-fast if it binds it without a default.
function springBindings(files: CommittedSourceFile[]): Map<string, SpringBinding> {
  const bindings = new Map<string, SpringBinding>();
  for (const file of files) {
    const lineAt = lineLookup(file.content);
    const inFile = new Map<string, SpringBinding>();
    for (const match of file.content.matchAll(/@Value\s*\(\s*["']\$\{([^}:"'\s]{1,256})(:[^}]{0,1024})?\}["']\s*\)/g)) {
      const existing = inFile.get(match[1]);
      if (!existing || (!match[2] && !existing.withoutDefault)) {
        inFile.set(match[1], { path: file.path, line: lineAt(match.index ?? 0), withoutDefault: !match[2] });
      }
    }
    for (const [name, binding] of inFile) {
      if (!bindings.has(name)) bindings.set(name, binding);
    }
  }
  return bindings;
}

// Line of each `"name": "<value>"` member whose value appears only once in the file. A value named
// more than once may belong to another member or a duplicate entry, so it is cited without a line.
function jsonNameLines(content: string): Map<string, number> {
  const lines = new Map<string, number>();
  const repeated = new Set<string>();
  const lineAt = lineLookup(content);
  for (const match of content.matchAll(/"name"\s*:\s*("(?:[^"\\\n]|\\.){0,1024}")/g)) {
    let name: string;
    try {
      name = JSON.parse(match[1]) as string;
    } catch {
      continue;
    }
    if (lines.has(name)) repeated.add(name);
    else lines.set(name, lineAt(match.index ?? 0));
  }
  for (const name of repeated) lines.delete(name);
  return lines;
}

function dependencyFromConfig(name: string): string {
  const upper = name.toUpperCase();
  if (/^(?:DB_|DATABASE)/.test(upper)) return 'database';
  if (/^S3_|BUCKET/.test(upper)) return 'object-storage';
  if (/KAFKA|BROKER/.test(upper)) return 'kafka';
  if (/ELASTIC|OPENSEARCH/.test(upper)) return 'search';
  if (/OKAPI/.test(upper)) return 'okapi';
  return upper.replace(/_(?:URL|URI|HOST|ENDPOINT|PORT).*$/, '').toLowerCase().replace(/_/g, '-');
}

function dependencyFromFile(filePath: string): string {
  const name = path.basename(filePath).replace(/(?:Client|Service|Connector)?\.java$/i, '');
  return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() || 'external-service';
}

function hasJavaClientOperation(content: string): boolean {
  return /\bWebClient\b|\bHttpClient\b|\bRestTemplate\b|\bKafkaTemplate\b|\bS3Client\b/.test(content);
}

function clientLine(content: string): number {
  const match = /\b(?:WebClient|HttpClient|RestTemplate|KafkaTemplate|S3Client)\b/.exec(content);
  return lineAtOffset(content, match?.index ?? 0);
}

function packageStripesInterfaces(packageJson: PackageJson | undefined): string[] {
  const stripes = packageJson?.stripes;
  if (!stripes) return [];
  // Stripes declares interfaces as an object of interface → version; older packages use a list of "id version".
  const values = [stripes.okapiInterfaces, stripes.optionalOkapiInterfaces];
  return values.flatMap(value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value) : [])
    .flatMap(value => typeof value === 'string' ? [value] : [])
    .map(value => value.trim().split(/\s+/)[0])
    .filter(Boolean);
}

// Merges scenarios with the same id, keeping each distinct source reference once. References are
// tracked in a set so that many repeated declarations cost linear, not quadratic, time.
function deduplicateScenarios(scenarios: S010ScenarioEvidence[]): S010ScenarioEvidence[] {
  const unique = new Map<string, { scenario: S010ScenarioEvidence; referenceKeys: Set<string> }>();
  for (const scenario of scenarios) {
    const existing = unique.get(scenario.id);
    const entry = existing
      ? { scenario: { ...mergeScenarios(existing.scenario, scenario), sourceReferences: existing.scenario.sourceReferences }, referenceKeys: existing.referenceKeys }
      : { scenario: { ...scenario, sourceReferences: [] as S010ScenarioEvidence['sourceReferences'] }, referenceKeys: new Set<string>() };
    for (const reference of scenario.sourceReferences) {
      const key = JSON.stringify([reference.path, reference.line, reference.detail]);
      if (entry.referenceKeys.has(key)) continue;
      entry.referenceKeys.add(key);
      entry.scenario.sourceReferences.push(reference);
    }
    unique.set(scenario.id, entry);
  }
  return [...unique.values()].map(entry => entry.scenario);
}

function mergeScenarios(left: S010ScenarioEvidence, right: S010ScenarioEvidence): S010ScenarioEvidence {
  const proof = left.proof === 'uncontrolled-failure' || right.proof === 'uncontrolled-failure'
    ? 'uncontrolled-failure'
    : left.proof === right.proof
      ? left.proof
      : 'unresolved';
  const readiness = left.readiness === 'not-preserved' || right.readiness === 'not-preserved'
    ? 'not-preserved'
    : left.readiness === right.readiness
      ? left.readiness
      : 'unknown';
  return {
    ...left,
    requirement: left.requirement === right.requirement ? left.requirement : 'unresolved',
    proof,
    boundedFailure: left.boundedFailure === right.boundedFailure ? left.boundedFailure : 'unknown',
    readiness,
    ...(proof === 'unresolved' ? {
      rationale: left.rationale ?? right.rationale ?? 'The code gives conflicting evidence for this service.'
    } : {})
  };
}

function isProductionSource(filePath: string): boolean {
  return !/(?:^|\/)(?:test|tests|__tests__|__mocks__|fixtures?|examples?|docs?|target|dist|build)(?:\/|$)/i.test(filePath)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath);
}

function isProductionCode(filePath: string): boolean {
  return isProductionSource(filePath) && /\.(?:java|[cm]?[jt]sx?)$/.test(filePath);
}

function isDeterministicS010Path(candidate: string): boolean {
  return SOURCE_PATTERN.test(candidate)
    && !/(?:^|\/)(?:src\/test|src\/integrationTest|swagger\.api|ramls?|api-examples?|docs?|docker)(?:\/|$)/i.test(candidate);
}

function unsupportedDiagnosticMessage(category: string, paths: string[]): string {
  if (paths.length === 1) {
    return `Uses ${category}, which the tool cannot analyse.`;
  }
  const representatives = paths.slice(0, 3).join(', ');
  const remainder = paths.length > 3 ? ` (+${paths.length - 3} more)` : '';
  return `${paths.length} files use ${category}, which the tool cannot analyse, for example ${representatives}${remainder}.`;
}

function isJavaScriptProductionSource(file: CommittedSourceFile): boolean {
  return isProductionCode(file.path) && /\.[cm]?[jt]sx?$/.test(file.path);
}

// Line numbers for many offsets in one file, without rescanning the file for each offset.
function lineLookup(content: string): (offset: number) => number {
  const starts = [0];
  for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) starts.push(index + 1);
  return offset => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

function lineAtOffset(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}
