import { BackendDescriptorTemplate, BackendEvidence, BackendFramework, BackendPlaceholder, BackendRepositoryKind, EvaluationRun, ModuleKindResult } from '../types';
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, YAMLMap } from 'yaml';
import { CommittedSourceFile, CommittedSourceSnapshot, readCommittedSource } from './committed-source';
import { parseJavaProperties, parsePom, pomDependencies, xmlText } from './manifest-parsers';
import { getModuleKind, pomArtifactId } from './module-kind';
import { errorMessage, isRecord } from './type-guards';

const MAX_FILES = 2_000;
// A file over the default 256 KB cannot be skipped as data without reading it: the largest selected files in
// folio-org's backend repositories are reference data (mod-linked-data's 718 KB profile CSV, mod-source-record-manager's
// 584 KB MARC mapping rules) but also OpenAPI specs in the same folders (mod-erm-usage-counter's 816 KB
// COUNTER_API.json, mod-workflow's 462 KB openapi.yaml). Read them all; the 8 MB total budget still applies.
const MAX_FILE_BYTES = 1024 * 1024;

// The directories classifyModuleKind looks in for a descriptor, so a backend module always has a candidate here.
const TEMPLATE_CANDIDATE = /^(?:descriptors\/|src\/main\/resources\/descriptors\/|service\/src\/main\/okapi\/)?ModuleDescriptor[^/]*\.json$/i;

export const TEST_SOURCES = /(?:^|\/)src\/(?:test|it|integration-?test)[^/]*\//i;
const INCLUDED = [
  /(?:^|\/)src\/main\//,
  /(?:^|\/)grails-app\//,
  /(?:^|\/)ModuleDescriptor[^/]*\.json$/i,
  /(?:^|\/)ramls\//,
  /(?:^|\/)templates\/db_scripts\//,
  // OpenAPI files kept outside src/main, such as mod-agreements' docs/API/.
  /(?:^|\/)(?:api|openapi|swagger)\/(?:.*\/)?[^/]+\.(?:ya?ml|json)$/i,
  /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|Dockerfile)$/,
  /^(?:README[^/]*|ENV_VARS\.md)$/i
];

/**
 * The paths backendEvidence reads. Everything else, such as test images or large test payloads, is left out, so a
 * binary or oversized file there does not make the evidence incomplete.
 */
function isBackendEvidencePath(path: string): boolean {
  return !TEST_SOURCES.test(path) && INCLUDED.some(pattern => pattern.test(path));
}

// Reference data is listed, not read: mod-inventory-storage keeps 624 files in reference-data/ at the repository root.
const REFERENCE_DATA = /(?:^|\/)(?:ref-data|reference-data)\//;

/** The run's backend evidence, read once and shared by the B criteria. */
export function getBackendEvidence(run: EvaluationRun, repoPath: string): Promise<BackendEvidence> {
  return run.getOrCreateArtifact('backendEvidence', async () =>
    collectBackendEvidence(await getModuleKind(run, repoPath), await readCommittedSource(repoPath, {
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      include: path => isBackendEvidencePath(path) && !REFERENCE_DATA.test(path),
      list: path => REFERENCE_DATA.test(path),
      // RMB modules include shared RAML (raml-util, acq-models, raml-storage) as git submodules.
      skipSubmodules: true
    })));
}

async function collectBackendEvidence(moduleKind: ModuleKindResult, snapshot: CommittedSourceSnapshot): Promise<BackendEvidence> {
  const files = new Map(snapshot.files.map(file => [file.path, file]));
  const rootPom = files.get('pom.xml');
  const project = rootPom ? await pomProject(rootPom.content) : undefined;
  const artifactId = rootPom ? pomArtifactId(rootPom.content, []) : undefined;
  const { kind, evidence: kindEvidence } = repositoryKind(moduleKind, artifactId, project);

  const templateCandidates = [...new Set([
    ...snapshot.files.map(file => file.path),
    ...snapshot.diagnostics.flatMap(diagnostic => diagnostic.path ? [diagnostic.path] : [])
  ].filter(path => TEMPLATE_CANDIDATE.test(path)))].sort();
  const template = templateCandidates.length === 1
    ? await readTemplate(templateCandidates[0], files, snapshot)
    : undefined;

  return {
    kind,
    kindEvidence,
    moduleKind,
    artifactId,
    templateCandidates,
    template,
    framework: detectFramework(kind, snapshot.files),
    storage: detectStorage(snapshot.files),
    snapshot
  };
}

/**
 * classifyModuleKind decides module, library or neither; the B layer splits off edge modules. An edge module is
 * recognised by its artifactId and dependency, so one without a descriptor is still an edge module (and fails B001).
 */
function repositoryKind(
  moduleKind: ModuleKindResult,
  artifactId: string | undefined,
  project: Record<string, any> | undefined
): { kind: BackendRepositoryKind; evidence: string[] } {
  if (moduleKind.kind === 'library') return { kind: 'library', evidence: moduleKind.evidence };
  const edgeCommon = pomDependencies(project?.dependencies?.dependency)
    .find(dependency => /^edge-common(?:-|$)/.test(dependency.artifactId));
  if (artifactId?.startsWith('edge-') && edgeCommon) {
    return {
      kind: 'edge-module',
      evidence: [...(moduleKind.kind === 'backend-module' ? moduleKind.evidence : []),
        `Edge module: pom.xml artifactId ${artifactId} with a dependency on ${edgeCommon.artifactId}`]
    };
  }
  if (moduleKind.kind === 'backend-module') return { kind: 'backend-module', evidence: moduleKind.evidence };
  return {
    kind: 'ambiguous',
    evidence: [...(moduleKind.kind === 'ui-module' ? moduleKind.evidence : []), `No module descriptor found, and the repository is not an allowlisted shared library${artifactId ? ` (pom.xml artifactId ${artifactId})` : ''}`]
  };
}

async function pomProject(content: string): Promise<Record<string, any> | undefined> {
  const parsed = await parsePom(content);
  return parsed.ok ? parsed.project : undefined;
}

// `${name}` (Maven, Gradle ReplaceTokens) and `@name@` (Spring Boot's Maven resource delimiter).
export const PLACEHOLDER = /\$\{([^{}\s"\\]+)\}|@([A-Za-z0-9_.-]+)@/g;

async function readTemplate(
  path: string,
  files: Map<string, CommittedSourceFile>,
  snapshot: CommittedSourceSnapshot
): Promise<BackendDescriptorTemplate> {
  const file = files.get(path);
  if (!file) {
    const diagnostic = snapshot.diagnostics.find(candidate => candidate.path === path);
    return { path, placeholders: [], readError: diagnostic?.message ?? 'it was not read' };
  }
  const properties = await buildProperties(path, files);
  const inString = stringMask(file.content);
  const placeholders = new Map<string, BackendPlaceholder>();
  // The build substitutes text, so a value is inserted as written; an unresolved placeholder in a string stays as
  // written, and one outside a string becomes null so the rest of the template can still be read.
  const content = file.content.replace(PLACEHOLDER, (text, braced: string | undefined, at: string | undefined, offset: number) => {
    const name = braced ?? at!;
    const property = properties(name);
    const placeholder = placeholders.get(text) ?? { text, name, value: property?.value, source: property?.source, outsideString: false, pointers: [] };
    if (!inString[offset]) placeholder.outsideString = true;
    placeholders.set(text, placeholder);
    return property ? property.value : inString[offset] ? text : 'null';
  });
  const template: BackendDescriptorTemplate = { path, content, placeholders: [...placeholders.values()] };
  try {
    template.descriptor = JSON.parse(content);
  } catch (error) {
    template.parseError = errorMessage(error);
    return template;
  }
  for (const placeholder of template.placeholders) {
    if (placeholder.value === undefined) placeholder.pointers = stringPointers(template.descriptor, placeholder.text);
  }
  return template;
}

/**
 * The line of the template where the value at a JSON pointer (`/provides/3`) starts, or undefined when the template
 * could not be parsed or has no such value. Replaced placeholders keep the template's lines.
 */
export function templateLineOf(template: BackendDescriptorTemplate | undefined): (pointer: string) => number | undefined {
  if (template?.content === undefined || template.descriptor === undefined) return () => undefined;
  const lineCounter = new LineCounter();
  const document = parseDocument(template.content, { lineCounter, uniqueKeys: false });
  if (document.errors.length) return () => undefined;
  const maps = new WeakMap<YAMLMap, Map<string, unknown>>();
  const member = (map: YAMLMap, key: string) => {
    let entries = maps.get(map);
    if (!entries) {
      // Like JSON.parse, the last of duplicate keys wins.
      entries = new Map(map.items.flatMap(pair => isScalar(pair.key) ? [[String(pair.key.value), pair.value] as [string, unknown]] : []));
      maps.set(map, entries);
    }
    return entries.get(key);
  };
  return pointer => {
    let node: unknown = document.contents;
    for (const key of pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      node = isSeq(node) ? node.items[Number(key)] : isMap(node) ? member(node, key) : undefined;
    }
    return isNode(node) && node.range ? lineCounter.linePos(node.range[0]).line : undefined;
  };
}

/** For each character of JSON text, whether it is inside a string literal. */
function stringMask(content: string): boolean[] {
  const mask: boolean[] = new Array(content.length).fill(false);
  let inString = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (inString) {
      mask[index] = true;
      if (character === '\\') {
        mask[++index] = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
      mask[index] = true;
    }
  }
  return mask;
}

function stringPointers(value: unknown, text: string, pointer = ''): string[] {
  if (typeof value === 'string') return value.includes(text) ? [pointer || '/'] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringPointers(item, text, `${pointer}/${index}`));
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => stringPointers(item, text, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  }
  return [];
}

interface BuildProperty {
  value: string;
  source: string;
}

/**
 * The properties a build substitutes into the template, looked up by name: from the gradle.properties files of the
 * template's directory and its parents, nearest first, and the nearest pom.xml. In the pom, `project.` names are the
 * project's own fields (the version and groupId fall back to the parent's), and bare names are its <properties>
 * first, then those fields. Values may refer to other properties; each name is resolved once, and a cycle is
 * unresolved.
 */
async function buildProperties(templatePath: string, files: Map<string, CommittedSourceFile>): Promise<(name: string) => BuildProperty | undefined> {
  const directories = templatePath.split('/').slice(0, -1).map((_part, index, parts) => parts.slice(0, parts.length - index).join('/'));
  directories.push('');
  const raw = new Map<string, BuildProperty>();
  const add = (name: string, value: string, source: string) => {
    if (!raw.has(name)) raw.set(name, { value, source });
  };

  for (const directory of directories) {
    const gradle = files.get(directory ? `${directory}/gradle.properties` : 'gradle.properties');
    if (gradle) parseJavaProperties(gradle.content).forEach((value, name) => add(name, value, gradle.path));
  }
  const pomPath = directories.map(directory => directory ? `${directory}/pom.xml` : 'pom.xml').find(path => files.has(path));
  const project = pomPath ? await pomProject(files.get(pomPath)!.content) : undefined;
  if (project && pomPath) {
    const fields: Array<[string, string]> = (['artifactId', 'version', 'groupId', 'name'] as const).map(field =>
      [field, xmlText(project[field]) || (field === 'version' || field === 'groupId' ? xmlText(project.parent?.[field]) : '')]);
    for (const [field, value] of fields) {
      if (value) for (const name of [`project.${field}`, `pom.${field}`]) add(name, value, `${pomPath} <${field}>`);
    }
    const parentVersion = xmlText(project.parent?.version);
    if (parentVersion) add('project.parent.version', parentVersion, `${pomPath} <parent><version>`);
    if (isRecord(project.properties)) {
      for (const [name, value] of Object.entries(project.properties)) add(name, xmlText(value), `${pomPath} <properties>`);
    }
    for (const [field, value] of fields) if (value && field !== 'name') add(field, value, `${pomPath} <${field}>`);
  }

  const resolved = new Map<string, BuildProperty | undefined>();
  const inProgress = new Set<string>();
  const resolve = (name: string): BuildProperty | undefined => {
    if (resolved.has(name)) return resolved.get(name);
    const property = raw.get(name);
    if (!property || inProgress.has(name)) return undefined;
    inProgress.add(name);
    let complete = true;
    const value = property.value.replace(/\$\{([^{}\s]+)\}/g, (text, inner: string) => {
      const innerProperty = resolve(inner);
      if (!innerProperty) complete = false;
      return innerProperty?.value ?? text;
    });
    inProgress.delete(name);
    const result = complete ? { value, source: property.source } : undefined;
    resolved.set(name, result);
    return result;
  };
  return resolve;
}

export const SOURCE_FILE = /(?:^|\/)src\/main\/(?:java|groovy|kotlin)\/.+\.(?:java|groovy|kt)$/;
export const REST_VERTICLE = />\s*org\.folio\.rest\.RestVerticle\s*</;

function detectFramework(kind: BackendRepositoryKind, files: CommittedSourceFile[]): BackendEvidence['framework'] {
  const result = (name: BackendFramework, evidence: string[]) => ({ name, evidence });
  // The repository kind's evidence already says why.
  if (kind === 'library') return result('library', []);
  if (kind === 'edge-module') return result('edge', []);

  const grails = files.find(file => /(?:^|\/)grails-app\//.test(file.path));
  if (grails) return result('grails', [`Grails application folder ${grails.path.replace(/(grails-app)\/.*$/, '$1/')}`]);

  const restVerticle = files.find(file => /(?:^|\/)pom\.xml$/.test(file.path) && REST_VERTICLE.test(file.content));
  const schema = files.find(file => /(?:^|\/)templates\/db_scripts\/schema\.json$/.test(file.path));
  if (restVerticle || schema) {
    return result('rmb', [
      ...(restVerticle ? [`${restVerticle.path} sets org.folio.rest.RestVerticle as the main verticle`] : []),
      ...(schema ? [`RMB database schema ${schema.path}`] : [])
    ]);
  }

  const sources = files.filter(file => SOURCE_FILE.test(file.path));
  const spring = sources.find(file => /^\s*@SpringBootApplication\b/m.test(file.content));
  if (spring) {
    const folioSpringBase = files.find(file => /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(file.path) && /folio-spring-base/.test(file.content));
    return result('spring', [`@SpringBootApplication in ${spring.path}`,
      folioSpringBase ? `folio-spring-base in ${folioSpringBase.path}` : 'No folio-spring-base dependency found']);
  }

  const verticle = sources.find(file => /\bextends\s+AbstractVerticle\b/.test(file.content));
  if (verticle) return result('vertx', [`${verticle.path} extends AbstractVerticle`]);

  return result('unknown', ['No RMB, Spring Boot, Vert.x or Grails main class found']);
}

/**
 * Positive storage evidence only. A framework dependency is not storage: mod-circulation depends on
 * domain-models-runtime for logging and has no database.
 */
function detectStorage(files: CommittedSourceFile[]): BackendEvidence['storage'] {
  const evidence: string[] = [];
  const first = (predicate: (file: CommittedSourceFile) => boolean, describe: (file: CommittedSourceFile) => string) => {
    const file = files.find(predicate);
    if (file) evidence.push(describe(file));
  };
  first(file => /(?:^|\/)templates\/db_scripts\/schema\.json$/.test(file.path), file => `RMB database schema ${file.path}`);
  first(file => SOURCE_FILE.test(file.path) && /^(?!\s*import\b).*\b(?:PostgresClient|PgUtil)\b/m.test(file.content),
    file => `PostgresClient or PgUtil used in ${file.path}`);
  // changelog-master.xml, db.changelog-master.yaml (Spring's default), data-export-worker-changelog-master.xml
  first(file => /(?:^|\/)src\/main\/resources\/(?:.*\/)?[^/]*changelog[^/]*\.(?:xml|ya?ml|json)$/i.test(file.path), file => `Liquibase changelog ${file.path}`);
  first(file => /(?:^|\/)src\/main\/resources\/application[^/]*\.(?:ya?ml|properties)$/.test(file.path)
    && /^\s*(?:spring\.)?datasource[.:]/im.test(file.content), file => `Datasource configured in ${file.path}`);
  const grailsDomain = files.some(file => /(?:^|\/)grails-app\/domain\/.+\.groovy$/.test(file.path));
  first(file => grailsDomain && /(?:^|\/)grails-app\/conf\/application[^/]*\.ya?ml$/.test(file.path) && /^\s*dataSources?:/m.test(file.content),
    file => `Grails domain classes with a datasource in ${file.path}`);
  return { present: evidence.length > 0, evidence };
}
