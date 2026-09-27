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

const SOURCE_PATTERN = /(?:^|\/)(?:src|descriptors?|config)(?:\/|$)|(?:^|\/)(?:pom\.xml|package\.json|build\.gradle(?:\.kts)?|README(?:\.md)?|ENV_VARS\.md)$/i;
const EXTERNAL_CONFIG_PATTERN = /(?:URL|URI|HOST|BROKER|ENDPOINT|BUCKET|DATABASE|DB_|KAFKA|S3_|ELASTIC|OPENSEARCH|SMTP|OKAPI)/i;
const JAVA_DATABASE_PATTERN = /\b(?:JdbcTemplate|NamedParameterJdbcTemplate|DataSource|JpaRepository|CrudRepository|EntityManager|R2dbcEntityTemplate|DatabaseClient|FolioSpringLiquibase|SpringLiquibase|Flyway)\b/;
const UNSUPPORTED_PATTERNS = [
  { category: 'dynamic runtime discovery', pattern: /java\.lang\.reflect|Class\.forName|ServiceLoader/i },
  { category: 'generated or framework client', pattern: /generated[-_/ ]client|vertx|raml-module-builder/i },
  { category: 'HTTP client wrapper', pattern: /URLConnection|FeignClient|Retrofit/i },
  { category: 'datastore client', pattern: /JdbcTemplate|DataSource|RedisTemplate|MongoClient|ElasticsearchClient|OpenSearchClient/i },
  { category: 'messaging or RPC client', pattern: /RabbitTemplate|ManagedChannelBuilder/i },
  {
    category: 'browser client wrapper',
    pattern: /\baxios\b|\bky\s*\(|\bokapi\b|\bmutator\b|process\.env\[[^\]]+\]/i,
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
  const snapshot = await readCommittedSource(repoPath, {
    include: isDeterministicS010Path,
    maxFiles: 1_500,
    maxFileBytes: 192 * 1024,
    maxTotalBytes: 6 * 1024 * 1024
  });
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
  for (const declaration of declarations) {
    const binding = javaFiles.find(file => springBinding(file.content, declaration));
    const clearFailFast = Boolean(
      declaration.required
      && !declaration.hasDefault
      && binding
      && springPlaceholder(binding.content, declaration, false)
    );
    scenarios.push({
      id: `${declaration.dependencyId}:${declaration.name}/configuration-absent`,
      dependencyId: declaration.dependencyId,
      requirement: declaration.required ? 'required' : 'optional',
      scenario: 'configuration-absent',
      proof: clearFailFast ? 'clear-fail-fast' : 'unresolved',
      sourceReferences: [
        { path: declaration.path, detail: `${declaration.required ? 'Required' : 'Optional'} external configuration declaration` },
        ...(binding ? [{ path: binding.path, line: lineOf(binding.content, '@Value'), detail: 'Spring configuration binding' }] : [])
      ],
      boundedFailure: 'not-applicable',
      readiness: 'not-applicable',
      ...(!clearFailFast ? { rationale: 'Static evidence does not prove the missing-configuration startup outcome.' } : {})
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
      sourceReferences: [{ path: file.path, line: clientLine(file.content), detail: 'Runtime client operation' }],
      boundedFailure: bounded ? 'proven' : 'unknown',
      readiness: controlled ? 'preserved' : 'unknown',
      ...(!controlled ? { rationale: 'Client operation, failure bound, handling, optionality, and readiness were not linked conclusively.' } : {})
    });
    if (!controlled) semanticIncomplete = true;
  }

  if (runtimeKind === 'stripes-react') {
    for (const file of snapshot.files.filter(isJavaScriptProductionSource)) {
      for (const match of file.content.matchAll(/fetch\s*\(\s*['"]https?:\/\/([^/'"?]+)/g)) {
        const dependencyId = match[1].toLowerCase();
        const operationLine = lineAtOffset(file.content, match.index ?? 0);
        const bounded = /AbortController|AbortSignal\.timeout|signal\s*:|\btimeout\s*:/.test(file.content);
        const handled = /catch\s*\(|\.catch\s*\(|onError\s*:/.test(file.content);
        const bootstrap = /ReactDOM\.render|createRoot\s*\(|bootstrap|module\.exports\s*=/.test(file.content)
          || /(?:^|\/)(?:index|bootstrap)\.[jt]sx?$/.test(file.path);
        const controlled = bounded && handled && !bootstrap;
        scenarios.push({
          id: `${dependencyId}:${file.path}:${operationLine}/runtime-unavailable`,
          dependencyId,
          requirement: controlled ? 'optional' : 'unresolved',
          scenario: 'runtime-unavailable',
          proof: controlled ? 'controlled-degradation' : 'unresolved',
          sourceReferences: [{ path: file.path, line: operationLine, detail: 'Direct browser request' }],
          boundedFailure: bounded ? 'proven' : 'unknown',
          readiness: controlled ? 'preserved' : 'unknown',
          ...(!controlled ? { rationale: 'Direct browser dependency behavior is not bounded and feature-local in the available evidence.' } : {})
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
        sourceReferences: [{ path: 'package.json', detail: 'Declared FOLIO runtime interface' }],
        boundedFailure: 'unknown',
        readiness: 'unknown',
        rationale: 'Interface declaration does not establish runtime failure handling.'
      });
      semanticIncomplete = true;
    }
  }

  const productionCode = snapshot.files.filter(file => isProductionCode(file.path));
  for (const unsupported of UNSUPPORTED_PATTERNS) {
    const matchingPaths = productionCode
      .filter(file => !('javascriptOnly' in unsupported) || /\.[cm]?[jt]sx?$/.test(file.path))
      .filter(file => unsupported.category !== 'datastore client'
        || !databaseFiles.some(databaseFile => databaseFile.path === file.path))
      .filter(file => unsupported.pattern.test(file.content))
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

  return {
    moduleKind,
    runtimeKind,
    discoveryCoverage: snapshot.complete ? 'complete' : 'incomplete',
    semanticCoverage: runtimeKind === 'node' || runtimeKind === 'mixed'
      ? 'unsupported'
      : semanticIncomplete || diagnostics.some(item => item.material)
        ? 'incomplete'
        : 'complete',
    scenarios: deduplicateScenarios(scenarios),
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
      detail: 'Unconditional database startup lifecycle owner'
    }] : [{
      path: databaseFiles[0].path,
      line: databaseLine(databaseFiles[0].content),
      detail: `${databaseFiles.length} production file${databaseFiles.length === 1 ? '' : 's'} use database framework APIs`
    }]),
    ...(configFile ? [{ path: configFile.path, detail: 'Datasource configuration' }] : [])
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
          ? 'Database startup ownership is visible, but local evidence does not prove clear exception propagation.'
          : 'Database startup failure propagates, but no complete finite connection and operation bound is visible.'
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
      rationale: 'Database usage is visible, but optionality, complete failure bounds, handling, and readiness were not linked conclusively.'
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
  return /afterPropertiesSet\s*\([^)]*\)\s*throws\b/.test(content)
    || /\b(?:run|migrate)\s*\([^)]*\)\s*throws\b/.test(content);
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

    const mapping = /^(\s*)([^:#][^:]*):(?:\s*(.*))?$/.exec(line);
    if (!mapping) continue;
    while (parents.length > 0 && parents[parents.length - 1].indentation >= indentation) parents.pop();

    const key = mapping[2].trim().replace(/^['"]|['"]$/g, '');
    const value = (mapping[3] ?? '').replace(/\s+#.*$/, '').trim();
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
    diagnostics.push({ code: 'package-json-invalid', message: 'Unable to parse committed package.json.', material: true, path: file.path });
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
      for (const value of env) {
        if (!value || typeof value !== 'object') continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.name !== 'string' || !EXTERNAL_CONFIG_PATTERN.test(entry.name)) continue;
        declarations.push({
          name: entry.name,
          dependencyId: dependencyFromConfig(entry.name),
          required: entry.required === true,
          hasDefault: typeof entry.value === 'string' && entry.value.length > 0,
          defaultIsEmpty: entry.value === '',
          path: file.path
        });
      }
    } catch {
      diagnostics.push({ code: 'descriptor-invalid', message: 'Unable to parse a committed module descriptor.', material: true, path: file.path });
    }
  }
  return declarations;
}

function springBinding(content: string, declaration: EnvDeclaration): boolean {
  return springPlaceholder(content, declaration, false) || springPlaceholder(content, declaration, true);
}

function springPlaceholder(content: string, declaration: EnvDeclaration, withDefault: boolean): boolean {
  const name = escapeRegExp(declaration.name);
  const suffix = withDefault ? ':[^}]*' : '';
  return new RegExp(`@Value\\s*\\(\\s*["']\\$\\{${name}${suffix}\\}["']\\s*\\)`).test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const values = [stripes.okapiInterfaces, stripes.optionalOkapiInterfaces];
  return values.flatMap(value => Array.isArray(value) ? value : [])
    .flatMap(value => typeof value === 'string' ? [value] : [])
    .map(value => value.split(/\s+/)[0])
    .filter(Boolean);
}

function deduplicateScenarios(scenarios: S010ScenarioEvidence[]): S010ScenarioEvidence[] {
  const unique = new Map<string, S010ScenarioEvidence>();
  for (const scenario of scenarios) {
    const existing = unique.get(scenario.id);
    unique.set(scenario.id, existing ? mergeScenarios(existing, scenario) : scenario);
  }
  return [...unique.values()];
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
  const sourceReferences = [...left.sourceReferences, ...right.sourceReferences].filter((reference, index, all) =>
    all.findIndex(candidate => candidate.path === reference.path
      && candidate.line === reference.line
      && candidate.detail === reference.detail) === index
  );
  return {
    ...left,
    requirement: left.requirement === right.requirement ? left.requirement : 'unresolved',
    proof,
    boundedFailure: left.boundedFailure === right.boundedFailure ? left.boundedFailure : 'unknown',
    readiness,
    sourceReferences,
    ...(proof === 'unresolved' ? {
      rationale: left.rationale ?? right.rationale ?? 'Conflicting repository evidence remains unresolved.'
    } : {})
  };
}

function isProductionSource(filePath: string): boolean {
  return !/(?:^|\/)(?:test|tests|__tests__|fixtures?|examples?|docs?|target|dist|build)(?:\/|$)/i.test(filePath);
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
    return `A production file uses an unsupported ${category} pattern.`;
  }
  const representatives = paths.slice(0, 3).join(', ');
  const remainder = paths.length > 3 ? ` (+${paths.length - 3} more)` : '';
  return `${paths.length} production files use unsupported ${category} patterns; representative paths: ${representatives}${remainder}.`;
}

function isJavaScriptProductionSource(file: CommittedSourceFile): boolean {
  return isProductionCode(file.path) && /\.[cm]?[jt]sx?$/.test(file.path);
}

function lineOf(content: string, needle: string): number {
  return lineAtOffset(content, Math.max(0, content.indexOf(needle)));
}

function lineAtOffset(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}
