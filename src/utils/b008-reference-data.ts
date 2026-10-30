import {
  B008Analysis,
  BackendDescriptorTemplate,
  CriterionAgentReviewResult,
  B008Basis,
  B008Runtime,
  B008Source,
  B008Vocabulary,
  BackendEvidence,
  BackendRuntimeEvidence,
  EvaluationStatus
} from '../types';
import { CommittedSourceFile } from './committed-source';
import { descriptorEndpoints } from './backend-endpoints';
import { numberBackendObligations } from './backend-agent-review';
import { SOURCE_FILE, TEST_SOURCES, templateLineOf } from './backend-evidence';
import { runtimeEvidenceLines, runtimeSummary } from './backend-runtime-harness';
import { lineCounter, literalPath, stringConstants, withoutComments } from './backend-routes';
import { isSystemInterface } from './descriptor-handlers';
import { FrontendChecklistItemDraft } from './frontend-agent-review';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { capitalize, count, listText, overflowLine, reportPath, reportText, unique } from './report-text';
import { isRecord } from './type-guards';

const MAX_ROWS = 20;
const MAX_UNREAD = 100;
const REFERENCE_KEY = 'loadReference';
const VOCABULARY_NAME = /-(?:types|statuses|reasons|categories)$/;
const VERSION_SUFFIX = /-v?\d+(?:\.\d+)+$/;
const CHAIN_CALL = /\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/y;
const NEW_INSTANCE = /\b([A-Za-z_$][\w$]*)\s*=\s*new\s+TenantLoading\b/g;
const TENANT_LOADING_VARIABLE = /\bTenantLoading\s+([A-Za-z_$][\w$]*)\s*(?=[=;,)])|\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+TenantLoading\b/g;
const STATEMENT = /[^;{}]+/g;
const CHAIN_HEAD = /(?:(?<=\bthis\.)|(?<![\w$.]))(?:([A-Za-z_$][\w$]*)|new\s+TenantLoading\s*\(\s*\))\s*\./g;
const LOAD_REFERENCE_DATA = /\b(?:void|fun)\s+loadReferenceData\s*\(/;
const RESOURCE = /(?:^|\/)src\/main\/resources\//;
const XML_INSERT = /<(?:insert|loadData|loadUpdateData)\b([^<>]*)>/g;
const TABLE_ATTRIBUTE = /\btableName\s*=\s*["']([^"']*)["']/;
const SQL_INSERT = /\binsert\s+into\s+((?:[\w$"`{}]+\.)*[\w$"`{}]+)\s*(?:\([^()]*\)\s*)?values\b/gi;
const YAML_CHANGE = /^(\s*)(?:-\s*)?(?:insert|loadData|loadUpdateData)\s*:\s*$/;
const YAML_TABLE = /^\s*(?:-\s*)?tableName\s*:\s*['"]?([\w$.{}]+)/;
const YAML_LOOKAHEAD = 50;
const YAML_COMMENT = /(?:^|\s)#[\s\S]*$/;
const DECLARED = /\bTenantLoading\s+([A-Za-z_$][\w$]*)\s*(?=[,)])/g;
const YAML_ROLLBACK = /^\s*(?:-\s*)?rollback\s*:/;
const SQL_BODY = /<sql\b[^<>]*>/g;
const MAX_SUFFIX_WORDS = 4;
const GRAILS_DOMAIN = /(?:^|\/)grails-app\/domain\//;
const GRAILS_PROPERTY = /^(?:(?:private|protected|public|transient|final)\s+)*RefdataValue\s+([A-Za-z_$][\w$]*)\s*(?:=[\s\S]*)?$/;
const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
const SOURCE_TEXT: Record<B008Source['kind'], string> = {
  'reference-data-folder': 'reference-data folders',
  'liquibase-insert': 'Liquibase inserts',
  'grails-defaults': '@Defaults values of Grails refdata properties'
};
const REASON_TEXT: Record<B008Vocabulary['reason'], string> = {
  name: 'collection endpoint named like a vocabulary',
  'reference-data': 'endpoint that reference data names',
  'grails-refdata': 'Grails refdata category'
};
const LOADER_TEXT: Record<B008Analysis['loaders'][number]['mechanism'], string> = {
  'rmb-tenant-loading': 'RMB TenantLoading for the loadReference key',
  'spring-load-reference-data': 'loadReferenceData() override'
};

type Loads = Pick<B008Analysis, 'loaders' | 'unreadLoadPaths'> & {
  paths: Array<{ filePath: string; uriPath: string; file: string; line: number }>;
  unreadCount: number;
  referencePathsUnread: boolean;
};
type Folder = { path: string; relative: string; loaded: boolean };
type GrailsProperty = { category: string; file: string; line: number; defaults: number };

/**
 * B008 (reference data where applicable) looks for the module's controlled vocabularies and the reference data that
 * gives each a value at tenant initialization: reference-data folders an RMB TenantLoading or a Spring
 * loadReferenceData override loads, Liquibase inserts, and Grails refdata defaults.
 */
export function evaluateB008(evidence: BackendEvidence): B008Analysis {
  const { kind, framework, storage, template, snapshot } = evidence;
  const sourceDiagnostics = snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const base = {
    criterionId: 'B008' as const, kind, framework, storage, loaders: [], referenceDataFolders: [], liquibaseInserts: [], vocabularies: [],
    unreadLoadPaths: [], unreadLoadPathCount: 0, sourceDiagnostics
  };
  const result = (status: EvaluationStatus, basis: B008Basis, summary: string, items: FrontendChecklistItemDraft[], extra: Partial<B008Analysis> = {}): B008Analysis =>
    ({ ...base, ...extra, status, basis, summary: `B008 ${status}: ${summary}`, checklist: frontendChecklist(status, numberBackendObligations(items)) });

  if (kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'library', 'The repository is a shared library; reference data belongs to the modules that store data.', []);
  }
  if (!storage.present) {
    if (!sourceDiagnostics.length) {
      return result(EvaluationStatus.NOT_APPLICABLE, 'no-storage', 'The tool found no storage evidence (an RMB schema.json, PostgresClient or PgUtil use, a Liquibase changelog, a datasource, or Grails domain classes with a datasource), so the module keeps no data that needs reference values.', []);
    }
    return result(EvaluationStatus.MANUAL, 'storage-unconfirmed', 'The tool found no storage evidence, but the committed source was not read completely, so it could not rule storage out.', [checklistItem([], [])]);
  }

  const loads = referenceLoads(snapshot.files);
  const loadedPaths = new Set(loads.paths.map(load => trimSlashes(load.filePath)));
  const folders = referenceDataFolders(snapshot.listedPaths ?? []).map(folder => ({
    ...folder,
    loaded: loads.referencePathsUnread || loadedPaths.has(folder.relative)
  }));
  const inserts = liquibaseInserts(snapshot.files);
  const vocabularies: B008Vocabulary[] = [];
  if (template?.descriptor) vocabularies.push(...endpointVocabularies(template, loads, folders, inserts));
  vocabularies.push(...grailsVocabularies(snapshot.files));
  const facts: Partial<B008Analysis> = {
    templatePath: template?.path,
    loaders: loads.loaders,
    referenceDataFolders: folders.map(({ path, loaded }) => ({ path, loaded })),
    liquibaseInserts: inserts,
    vocabularies,
    unreadLoadPaths: loads.unreadLoadPaths,
    unreadLoadPathCount: loads.unreadCount
  };

  const missing = vocabularies.filter(vocabulary => !vocabulary.sources.length);
  const startingPoints = [
    ...missing.map(vocabulary => ({ path: vocabulary.file, line: vocabulary.line, note: `${reportText(vocabulary.name)}: ${REASON_TEXT[vocabulary.reason]}, no reference data found` })),
    ...missing.flatMap(vocabulary => vocabulary.notCounted.map(entry => ({ path: entry.file, line: entry.line, note: `${reportText(vocabulary.name)}: ${entry.note}` }))),
    ...loads.unreadLoadPaths.map(entry => ({ path: entry.file, line: entry.line, note: 'reference-data load path the tool could not read' }))
  ];
  const foundElsewhere = [
    ...loads.loaders.map(loader => ({ path: loader.file, line: loader.line, note: LOADER_TEXT[loader.mechanism] })),
    ...folders.slice(0, MAX_ROWS).map(folder => ({ path: folder.path, note: folder.loaded ? 'reference-data folder' : 'reference-data folder not loaded as reference data' })),
    ...inserts.slice(0, MAX_ROWS).map(insert => ({ path: insert.file, line: insert.line, note: `Liquibase ${insert.count === 1 ? 'insert' : 'inserts'} into ${reportText(insert.table)}` }))
  ];
  const subjects = missing.map(vocabulary => ({ subject: vocabulary.name, path: vocabulary.file, ...(vocabulary.line ? { line: vocabulary.line } : {}), flag: 'manual' as const }));
  const sentences: string[] = [];
  const incomplete = sourceDiagnostics.length > 0;

  if (!template?.descriptor) {
    sentences.push(`${kind === 'ambiguous' ? 'No module descriptor template was found' : 'The module descriptor template could not be read'}, so the module's endpoints, and the controlled vocabularies among them, are not known (see B001).`);
  }
  if (!vocabularies.length && template?.descriptor) {
    sentences.push(`The tool found no controlled vocabulary: no collection endpoint in ${reportPath(template.path)} is named like one (*-types, *-statuses, *-reasons, *-categories) or is named by reference data${framework.name === 'grails' ? ', and no Grails domain class has a refdata property' : ''}.`);
    const found = foundText(loads, folders, inserts);
    if (found) sentences.push(found);
  }
  if (missing.length) {
    const names = listText(missing.map(vocabulary => reportText(vocabulary.name)));
    sentences.push(vocabularies.length === 1
      ? `The controlled vocabulary ${names} has no reference data the tool found.`
      : missing.length === vocabularies.length
        ? `None of the ${vocabularies.length} controlled vocabularies has reference data the tool found: ${names}.`
        : `${missing.length} of the ${vocabularies.length} controlled vocabularies ${missing.length === 1 ? 'has' : 'have'} no reference data the tool found: ${names}.`);
  }
  if (incomplete) sentences.push('The committed source was not read completely, so the tool may have missed reference data.');

  const covered = vocabularies.filter(vocabulary => vocabulary.sources.length);
  if (template?.descriptor && vocabularies.length && !missing.length && !incomplete) {
    const kinds = unique(covered.flatMap(vocabulary => vocabulary.sources.map(source => source.kind)));
    const loaderFiles = unique(loads.loaders.map(loader => reportPath(loader.file)));
    const from = kinds.map(sourceKind => sourceKind === 'reference-data-folder' ? `${SOURCE_TEXT[sourceKind]} loaded by ${listText(loaderFiles)}` : SOURCE_TEXT[sourceKind]);
    return result(EvaluationStatus.PASS, 'vocabularies-checked', `${vocabularies.length === 1
      ? `The controlled vocabulary ${reportText(vocabularies[0].name)} has`
      : `Each of the ${vocabularies.length} controlled vocabularies has`} reference data loaded at tenant initialization, from ${listText(from)}${vocabularies.length === 1 ? '' : `: ${listText(vocabularies.map(vocabulary => reportText(vocabulary.name)))}`}.`, [], facts);
  }

  sentences.push(missing.length
    ? `A reviewer must check whether ${missing.length === 1 ? 'it needs' : 'each needs'} a value after tenant initialization.`
    : vocabularies.length
      ? 'A reviewer must check whether the parts the tool could not read hold controlled vocabularies without reference data.'
      : 'A reviewer must decide whether the module has controlled vocabularies that need a value after tenant initialization.');
  const basis: B008Basis = !template?.descriptor ? 'no-descriptor' : vocabularies.length ? 'vocabularies-checked' : 'no-vocabularies';
  return result(EvaluationStatus.MANUAL, basis, sentences.join(' '), [checklistItem(
    missing.length ? startingPoints : [...(template ? [{ path: template.path, note: 'the endpoints the module provides' }] : []), ...startingPoints, ...foundElsewhere],
    subjects
  )], facts);
}

function checklistItem(startingPoints: FrontendChecklistItemDraft['startingPoints'], subjects: FrontendChecklistItemDraft['subjects']): FrontendChecklistItemDraft {
  return {
    id: 'B008-C1',
    title: 'Each controlled vocabulary the module needs at least one value for has one after tenant initialization.',
    startingPoints,
    reviewerOnly: false,
    obligations: [],
    subjects
  };
}

function foundText(loads: Loads, folders: Folder[], inserts: B008Analysis['liquibaseInserts']): string | undefined {
  const parts = [
    ...(loads.loaders.length ? [`code that loads reference data in ${listText(unique(loads.loaders.map(loader => reportPath(loader.file))))}`] : []),
    ...(folders.length ? [`${folders.length === 1 ? 'a reference-data folder' : `${folders.length} reference-data folders`}`] : []),
    ...(inserts.length ? [`Liquibase inserts into ${listText(unique(inserts.map(insert => reportText(insert.table))))}`] : [])
  ];
  return parts.length ? `It found ${listText(parts)}, which no vocabulary-like endpoint matches.` : undefined;
}

function endpointVocabularies(
  template: BackendDescriptorTemplate,
  loads: Loads,
  folders: Folder[],
  inserts: B008Analysis['liquibaseInserts']
): B008Vocabulary[] {
  const methods = new Map<string, Set<string>>();
  const lines = handlerLines(template);
  for (const endpoint of descriptorEndpoints(template.descriptor)) {
    const key = trimSlashes(endpoint.path);
    methods.set(key, (methods.get(key) ?? new Set()).add(endpoint.method));
  }
  const namedPaths = new Map<string, Array<{ folder?: Folder; load?: Loads['paths'][number] }>>();
  const name = (uriPath: string, entry: { folder?: Folder; load?: Loads['paths'][number] }) => {
    const entries = namedPaths.get(uriPath);
    if (entries) entries.push(entry);
    else namedPaths.set(uriPath, [entry]);
  };
  const byRelative = new Map(folders.map(folder => [folder.relative, folder]));
  const unloaded = new Map<string, Folder[]>();
  for (const folder of folders) {
    const stripped = stripVersions(folder.relative);
    if (folder.loaded) name(stripped, { folder });
    else if (unloaded.has(stripped)) unloaded.get(stripped)!.push(folder);
    else unloaded.set(stripped, [folder]);
  }
  for (const load of loads.paths) name(trimSlashes(load.uriPath), { folder: byRelative.get(trimSlashes(load.filePath)), load });

  const vocabularies: B008Vocabulary[] = [];
  const exact = new Map<string, B008Vocabulary[]>();
  const ending = new Map<string, B008Vocabulary[]>();
  const index = (map: Map<string, B008Vocabulary[]>, key: string, vocabulary: B008Vocabulary) => {
    if (map.has(key)) map.get(key)!.push(vocabulary);
    else map.set(key, [vocabulary]);
  };
  for (const [apiPath, pathMethods] of [...methods].sort(([left], [right]) => left.localeCompare(right))) {
    const last = apiPath.split('/').pop() ?? '';
    const named = !apiPath.includes('*') && !last.includes('{') && pathMethods.has('GET') && pathMethods.has('POST') && VOCABULARY_NAME.test(last);
    const entries = namedPaths.get(apiPath) ?? [];
    if (!named && !entries.length) continue;
    const sources: B008Source[] = unique(entries.flatMap(entry => entry.folder ? [entry.folder] : []))
      .map(folder => ({ kind: 'reference-data-folder', file: folder.path, detail: folder.path }));
    const notCounted: B008Vocabulary['notCounted'] = (unloaded.get(apiPath) ?? []).map(folder => ({
      file: folder.path,
      note: loads.loaders.some(loader => loader.mechanism === 'rmb-tenant-loading')
        ? 'reference-data folder that no reference load path names'
        : loads.loaders.length
          ? 'reference-data folder; the tool does not read which folders loadReferenceData() loads'
          : 'reference-data folder, but no code that loads reference data at tenant initialization was found'
    }));
    for (const entry of entries) {
      if (entry.load && !entry.folder) {
        notCounted.push({ file: entry.load.file, line: entry.load.line, note: `loaded from ${reportText(trimSlashes(entry.load.filePath))}, but no ref-data/ or reference-data/ folder of that name holds files` });
      }
    }
    const line = lines.get(apiPath);
    const vocabulary: B008Vocabulary = { name: `/${apiPath}`, reason: named ? 'name' : 'reference-data', file: template.path, ...(line ? { line } : {}), sources, notCounted };
    vocabularies.push(vocabulary);
    const segmentWords = words(last);
    index(exact, segmentWords.join('-'), vocabulary);
    for (let length = 1; length < segmentWords.length && length <= MAX_SUFFIX_WORDS; length++) index(ending, segmentWords.slice(-length).join('-'), vocabulary);
  }

  for (const insert of inserts) {
    const key = words(insert.table).join('-');
    const suffixOf = ending.get(key) ?? [];
    for (const vocabulary of exact.get(key) ?? (suffixOf.length === 1 ? suffixOf : [])) {
      vocabulary.sources.push({ kind: 'liquibase-insert', file: insert.file, line: insert.line, detail: insert.table });
    }
  }
  return vocabularies;
}

function handlerLines(template: BackendDescriptorTemplate): Map<string, number> {
  const lineOf = templateLineOf(template);
  const lines = new Map<string, number>();
  const provides = isRecord(template.descriptor) && Array.isArray(template.descriptor.provides) ? template.descriptor.provides : [];
  provides.forEach((provided, index) => {
    if (!isRecord(provided) || isSystemInterface(provided) || !Array.isArray(provided.handlers)) return;
    provided.handlers.forEach((handler, handlerIndex) => {
      if (!isRecord(handler)) return;
      const handlerPath = typeof handler.pathPattern === 'string' ? handler.pathPattern : typeof handler.path === 'string' ? `${handler.path}*` : undefined;
      if (handlerPath === undefined || lines.has(trimSlashes(handlerPath))) return;
      const line = lineOf(`/provides/${index}/handlers/${handlerIndex}`);
      if (line) lines.set(trimSlashes(handlerPath), line);
    });
  });
  return lines;
}

function words(name: string): string[] {
  const parts = name.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  if (parts.length) parts[parts.length - 1] = singular(parts[parts.length - 1]);
  return parts;
}

function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|us)es$/.test(word)) return word.slice(0, -2);
  if (/[^su]s$/.test(word)) return word.slice(0, -1);
  return word;
}

function stripVersions(relative: string): string {
  return relative.split('/').map(segment => segment.replace(VERSION_SUFFIX, '')).join('/');
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

function referenceDataFolders(listedPaths: string[]): Array<{ path: string; relative: string }> {
  const folders = new Map<string, string>();
  for (const listed of listedPaths) {
    if (!listed.endsWith('.json') || TEST_SOURCES.test(listed)) continue;
    const segments = listed.split('/');
    const root = segments.findIndex(segment => segment === 'ref-data' || segment === 'reference-data');
    if (root < 0 || root >= segments.length - 2) continue;
    folders.set(segments.slice(0, -1).join('/'), segments.slice(root + 1, -1).join('/'));
  }
  return [...folders].sort(([left], [right]) => left.localeCompare(right)).map(([path, relative]) => ({ path, relative }));
}

// https://github.com/folio-org/raml-module-builder/blob/master/domain-models-runtime/src/main/java/org/folio/rest/tools/utils/TenantLoading.java
function referenceLoads(files: CommittedSourceFile[]): Loads {
  const loads: Loads = { loaders: [], paths: [], unreadLoadPaths: [], unreadCount: 0, referencePathsUnread: false };
  const unread = (file: string, line: number) => {
    if (loads.unreadCount++ < MAX_UNREAD) loads.unreadLoadPaths.push({ file, line });
  };
  for (const file of files.filter(candidate => SOURCE_FILE.test(candidate.path))) {
    if (!/loadReferenceData|TenantLoading/.test(file.content)) continue;
    const content = withoutComments(file.content);
    const override = LOAD_REFERENCE_DATA.exec(content);
    if (override) loads.loaders.push({ file: file.path, line: lineCounter(content)(override.index), mechanism: 'spring-load-reference-data' });
    if (!/\bTenantLoading\b/.test(content)) continue;
    const variables = new Set([...content.matchAll(TENANT_LOADING_VARIABLE)].map(match => match[1] ?? match[2]));
    const keys = new Map<string, string | null | undefined>();
    const constants = stringConstants(content);
    const line = lineCounter(content);
    for (const statement of content.matchAll(STATEMENT)) {
      for (const declared of statement[0].matchAll(DECLARED)) keys.set(declared[1], null);
      const assigned = [...statement[0].matchAll(NEW_INSTANCE)].map(match => match[1]);
      for (const variable of assigned) keys.set(variable, undefined);
      const chain = [...statement[0].matchAll(CHAIN_HEAD)].find(match => match[1] === undefined || variables.has(match[1]));
      if (!chain) continue;
      const variable = chain[1];
      let key = variable === undefined ? undefined : keys.has(variable) ? keys.get(variable) : null;
      for (const call of chainCalls(statement[0], chain.index! + chain[0].length - 1)) {
        const offset = statement.index! + call.offset;
        const values = call.args.includes('(') ? [undefined] : call.args.split(',').map(argument => literalPath(argument.trim(), constants));
        const resolved = values.every(value => value !== undefined) ? values as string[] : undefined;
        if (call.name === 'withKey') {
          key = resolved?.length === 1 ? resolved[0] : null;
          if (key === REFERENCE_KEY && !loads.loaders.some(loader => loader.file === file.path && loader.mechanism === 'rmb-tenant-loading')) {
            loads.loaders.push({ file: file.path, line: line(offset), mechanism: 'rmb-tenant-loading' });
          }
        } else if (call.name === 'add' && key === REFERENCE_KEY) {
          if (resolved && (resolved.length === 1 || resolved.length === 2)) {
            loads.paths.push({ filePath: resolved[0], uriPath: resolved[resolved.length - 1], file: file.path, line: line(offset) });
          } else {
            loads.referencePathsUnread = true;
            unread(file.path, line(offset));
          }
        } else if (call.name === 'add' && key === null) {
          unread(file.path, line(offset));
        }
      }
      if (variable !== undefined) keys.set(variable, key);
      else for (const name of assigned) keys.set(name, key);
    }
  }
  return loads;
}

function* chainCalls(text: string, start: number): Generator<{ name: string; args: string; offset: number }> {
  let index = start;
  for (;;) {
    CHAIN_CALL.lastIndex = index;
    const call = CHAIN_CALL.exec(text);
    if (!call) return;
    const open = CHAIN_CALL.lastIndex - 1;
    const close = closingParen(text, open);
    yield { name: call[1], args: close < 0 ? '(' : text.slice(open + 1, close), offset: index + call[0].indexOf('.') };
    if (close < 0) return;
    index = close + 1;
  }
}

function closingParen(text: string, open: number): number {
  let level = 0;
  for (let index = open; index < text.length; index++) {
    const character = text[index];
    if (character === '"' || character === '\'') index = stringEnd(text, index) - 1;
    else if (character === '(') level++;
    else if (character === ')' && --level === 0) return index;
  }
  return -1;
}

function liquibaseInserts(files: CommittedSourceFile[]): B008Analysis['liquibaseInserts'] {
  const changelogs = files.filter(file => RESOURCE.test(file.path) && /\.(?:xml|ya?ml)$/i.test(file.path) && file.content.includes('databaseChangeLog'));
  const folders = unique(changelogs.map(file => `${file.path.slice(0, file.path.lastIndexOf('/'))}/`));
  const sqlFiles = files.filter(file => /\.sql$/i.test(file.path) && folders.some(folder => file.path.startsWith(folder)));
  const inserts = new Map<string, B008Analysis['liquibaseInserts'][number]>();
  const add = (table: string, file: string, line: number) => {
    const name = table.split('.').pop()!.replace(/["`]/g, '');
    if (!name || /[${}]/.test(name)) return;
    const key = `${file}\n${name}`;
    const insert = inserts.get(key);
    if (!insert) inserts.set(key, { table: name, file, line, count: 1 });
    else {
      insert.count++;
      insert.line = Math.min(insert.line, line);
    }
  };
  const sqlInserts = (file: string, code: string, base: number, line: (offset: number) => number) => {
    for (const match of code.matchAll(SQL_INSERT)) add(match[1], file, line(base + match.index!));
  };
  for (const file of changelogs) {
    if (/\.xml$/i.test(file.path)) {
      const content = blankSpans(blankSpans(file.content, /<!--/g, () => '-->'), /<rollback\b[^<>]*>/g, opening => opening.endsWith('/>') ? '' : '</rollback>');
      const line = lineCounter(content);
      for (const match of content.matchAll(XML_INSERT)) {
        const table = TABLE_ATTRIBUTE.exec(match[1])?.[1];
        if (table) add(table, file.path, line(match.index!));
      }
      const bodyLine = lineCounter(content);
      SQL_BODY.lastIndex = 0;
      for (let open = SQL_BODY.exec(content); open; open = SQL_BODY.exec(content)) {
        if (open[0].endsWith('/>')) continue;
        const close = content.indexOf('</sql>', SQL_BODY.lastIndex);
        if (close < 0) break;
        sqlInserts(file.path, sqlCode(content.slice(SQL_BODY.lastIndex, close)), SQL_BODY.lastIndex, bodyLine);
        SQL_BODY.lastIndex = close;
      }
      continue;
    }
    const lines = file.content.split('\n').map(text => text.replace(YAML_COMMENT, ''));
    let rollbackIndent = -1;
    lines.forEach((text, index) => {
      const indent = /^\s*/.exec(text)![0].length;
      if (rollbackIndent >= 0 && (!text.trim() || indent > rollbackIndent || (indent === rollbackIndent && text.trimStart().startsWith('-')))) return;
      rollbackIndent = YAML_ROLLBACK.test(text) ? indent : -1;
      const change = YAML_CHANGE.exec(text);
      if (!change) return;
      for (let next = index + 1; next < Math.min(lines.length, index + 1 + YAML_LOOKAHEAD); next++) {
        if (lines[next].trim() && /^\s*/.exec(lines[next])![0].length <= change[1].length) break;
        const table = YAML_TABLE.exec(lines[next])?.[1];
        if (table) {
          add(table, file.path, index + 1);
          break;
        }
      }
    });
  }
  for (const file of sqlFiles) sqlInserts(file.path, sqlCode(file.content), 0, lineCounter(file.content));
  return [...inserts.values()].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

function blankSpans(content: string, start: RegExp, end: (opening: string) => string): string {
  const parts: string[] = [];
  let kept = 0;
  start.lastIndex = 0;
  for (let match = start.exec(content); match; match = start.exec(content)) {
    const close = content.indexOf(end(match[0]), match.index + match[0].length);
    const stop = close < 0 ? content.length : close + end(match[0]).length;
    parts.push(content.slice(kept, match.index), content.slice(match.index, stop).replace(/[^\n]/g, ' '));
    kept = start.lastIndex = stop;
    if (close < 0) break;
  }
  parts.push(content.slice(kept));
  return parts.join('');
}

function sqlCode(content: string): string {
  return blankSpans(content, /--|\/\*|'|\$(?:[A-Za-z_]\w*)?\$/g, opening => opening === '--' ? '\n' : opening === '/*' ? '*/' : opening);
}

// https://github.com/k-int/web-toolkit-ce: @CategoryId names a property's category, `<Class>.<Property>` by default.
function grailsVocabularies(files: CommittedSourceFile[]): B008Vocabulary[] {
  const byCategory = new Map<string, GrailsProperty[]>();
  for (const file of files.filter(candidate => candidate.path.endsWith('.groovy') && GRAILS_DOMAIN.test(candidate.path))) {
    for (const property of grailsProperties(file)) {
      if (byCategory.has(property.category)) byCategory.get(property.category)!.push(property);
      else byCategory.set(property.category, [property]);
    }
  }
  return [...byCategory].sort(([left], [right]) => left.localeCompare(right)).map(([category, properties]) => ({
    name: category,
    reason: 'grails-refdata',
    file: properties[0].file,
    line: properties[0].line,
    sources: properties.filter(property => property.defaults > 0).map(property => ({
      kind: 'grails-defaults' as const, file: property.file, line: property.line, detail: `${property.defaults} ${property.defaults === 1 ? 'value' : 'values'}`
    })),
    notCounted: []
  }));
}

function grailsProperties(file: CommittedSourceFile): GrailsProperty[] {
  const content = withoutComments(file.content);
  const line = lineCounter(content);
  const properties: GrailsProperty[] = [];
  let depth = 0;
  let nesting = 0;
  let outer = '';
  let className: string | undefined;
  let statementStart = -1;
  let pending: Array<{ name: string; args: string }> = [];
  const flush = (end: number) => {
    if (statementStart < 0) return;
    const statement = content.slice(statementStart, end);
    const offset = statementStart + (/^\s*/.exec(statement)![0].length);
    statementStart = -1;
    const { annotations, rest } = leadingAnnotations(statement.trim());
    if (!annotations.length && !rest) return;
    if (!rest) {
      pending.push(...annotations);
      return;
    }
    const declaration = GRAILS_PROPERTY.exec(rest);
    const all = [...pending, ...annotations];
    pending = [];
    if (!declaration || !className) return;
    const categoryId = all.find(annotation => annotation.name === 'CategoryId');
    const defaults = all.find(annotation => annotation.name === 'Defaults');
    properties.push({
      category: (categoryId && categoryValue(categoryId.args)) ?? `${className}.${capitalize(declaration[1])}`,
      file: file.path,
      line: line(offset),
      defaults: defaults ? defaultValues(defaults.args) : 0
    });
  };
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character === '"' || character === '\'') {
      if (depth === 1 && statementStart < 0) statementStart = index;
      index = stringEnd(content, index) - 1;
      continue;
    }
    if (character === '{') {
      if (depth === 0) {
        className = [...outer.matchAll(/\b(?:class|trait|enum|interface)\s+([A-Za-z_$][\w$]*)/g)].pop()?.[1];
        outer = '';
      } else if (depth === 1) {
        statementStart = -1;
        pending = [];
        nesting = 0;
      }
      depth++;
      continue;
    }
    if (character === '}') {
      if (depth === 1) flush(index);
      depth = Math.max(0, depth - 1);
      if (depth === 0) className = undefined;
      if (depth === 1) pending = [];
      continue;
    }
    if (depth === 0) {
      outer = character === ';' ? '' : outer + character;
      continue;
    }
    if (depth !== 1) continue;
    if (character === '(' || character === '[') nesting++;
    if (character === ')' || character === ']') nesting = Math.max(0, nesting - 1);
    if ((character === '\n' || character === ';') && nesting === 0) {
      flush(index);
      continue;
    }
    if (statementStart < 0 && !/\s/.test(character)) statementStart = index;
  }
  return properties;
}

function stringEnd(content: string, start: number): number {
  const triple = content.slice(start, start + 3);
  if (triple === '"""' || triple === '\'\'\'') {
    const end = content.indexOf(triple, start + 3);
    return end < 0 ? content.length : end + 3;
  }
  let index = start + 1;
  while (index < content.length && content[index] !== content[start] && content[index] !== '\n') index += content[index] === '\\' ? 2 : 1;
  return index + 1;
}

function leadingAnnotations(statement: string): { annotations: Array<{ name: string; args: string }>; rest: string } {
  const annotations: Array<{ name: string; args: string }> = [];
  let index = 0;
  const name = /@([A-Za-z_$][\w$.]*)\s*/y;
  const space = /\s*/y;
  for (;;) {
    name.lastIndex = index;
    const match = name.exec(statement);
    if (!match) break;
    index = name.lastIndex;
    let args = '';
    if (statement[index] === '(') {
      let level = 0;
      let end = index;
      for (; end < statement.length; end++) {
        if (statement[end] === '"' || statement[end] === '\'') {
          end = stringEnd(statement, end) - 1;
          continue;
        }
        if (statement[end] === '(') level++;
        if (statement[end] === ')' && --level === 0) break;
      }
      args = statement.slice(index + 1, end);
      space.lastIndex = end + 1;
      space.exec(statement);
      index = Math.max(space.lastIndex, end + 1);
    }
    annotations.push({ name: match[1].split('.').pop()!, args });
  }
  return { annotations, rest: statement.slice(index).trim() };
}

function defaultValues(args: string): number {
  const values = /^\s*(?:value\s*=\s*)?\[([^\[\]]*)\]/.exec(args)?.[1] ?? (/^\s*['"]/.test(args) && !args.includes('=') ? args : '');
  return [...values.matchAll(STRING_LITERAL)].length;
}

function categoryValue(args: string): string | undefined {
  const literal = /^\s*value\s*=\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/.exec(args)?.[1]
    ?? /,\s*value\s*=\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/.exec(args)?.[1]
    ?? /^\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/.exec(args)?.[1];
  return literal ? literal.slice(1, -1) : undefined;
}

/** The runtime harness's tenant initialization and record counts, as B008's informational runtime evidence. */
export function b008Runtime(runtime: BackendRuntimeEvidence): B008Runtime {
  return {
    ...runtimeSummary(runtime),
    tenants: runtime.tenants.map(request => ({
      tenant: request.tenant ?? '',
      ...(request.status !== undefined ? { status: request.status } : {}),
      ...(request.complete !== undefined ? { complete: request.complete } : {}),
      ...(request.body ? { body: request.body } : {}),
      ...(request.error ? { error: request.error } : {})
    })),
    requests: runtime.getRequests.map(request => ({
      path: request.path,
      tenant: request.tenant ?? '',
      ...(request.status !== undefined ? { status: request.status } : {}),
      ...(request.recordCount !== undefined ? { recordCount: request.recordCount } : {}),
      ...(request.error ? { error: request.error } : {})
    })),
    requestsCut: runtime.getRequestsCut
  };
}

export function renderB008HumanDetails(analysis: B008Analysis, agentReview?: CriterionAgentReviewResult): string {
  const lines: string[] = [];
  if (analysis.kind !== 'library') {
    lines.push(`Storage: ${analysis.storage.present ? reportText(analysis.storage.evidence.join('; ')) : 'none found'}`);
  }
  if (analysis.loaders.length) {
    lines.push('Code that loads reference data at tenant initialization:', ...analysis.loaders.slice(0, MAX_ROWS).map(loader =>
      `  - ${reportPath(loader.file)}:${loader.line} — ${LOADER_TEXT[loader.mechanism]}`), ...overflowLine(analysis.loaders.length, MAX_ROWS, '  '));
  }
  if (analysis.referenceDataFolders.length) {
    lines.push('Reference-data folders:', ...analysis.referenceDataFolders.slice(0, MAX_ROWS).map(folder =>
      `  - ${reportPath(folder.path)}${folder.loaded ? '' : ' — not loaded as reference data'}`), ...overflowLine(analysis.referenceDataFolders.length, MAX_ROWS, '  '));
  }
  if (analysis.liquibaseInserts.length) {
    lines.push('Liquibase inserts:', ...analysis.liquibaseInserts.slice(0, MAX_ROWS).map(insert =>
      `  - ${reportPath(insert.file)}:${insert.line} — into ${reportText(insert.table)}${insert.count === 1 ? '' : ` (${insert.count} inserts)`}`), ...overflowLine(analysis.liquibaseInserts.length, MAX_ROWS, '  '));
  }
  const covered = analysis.vocabularies.filter(vocabulary => vocabulary.sources.length);
  const missing = analysis.vocabularies.filter(vocabulary => !vocabulary.sources.length);
  if (covered.length) {
    lines.push('Controlled vocabularies with reference data:', ...covered.slice(0, MAX_ROWS).map(vocabulary =>
      `  - ${reportText(vocabulary.name)} — ${listText(vocabulary.sources.map(sourceText))}`), ...overflowLine(covered.length, MAX_ROWS, '  '));
  }
  if (missing.length) {
    lines.push('Controlled vocabularies without reference data found:', ...missing.slice(0, MAX_ROWS).flatMap(vocabulary => [
      `  - ${reportText(vocabulary.name)} — ${REASON_TEXT[vocabulary.reason]}, ${location(vocabulary.file, vocabulary.line)}`,
      ...vocabulary.notCounted.slice(0, MAX_ROWS).map(entry => `    - ${location(entry.file, entry.line)} — ${entry.note}`),
      ...overflowLine(vocabulary.notCounted.length, MAX_ROWS)
    ]), ...overflowLine(missing.length, MAX_ROWS, '  '));
  }
  if (analysis.unreadLoadPathCount) {
    lines.push('Reference-data load paths the tool could not read:', ...analysis.unreadLoadPaths.slice(0, MAX_ROWS).map(entry => `  - ${reportPath(entry.file)}:${entry.line}`),
      ...overflowLine(analysis.unreadLoadPathCount, MAX_ROWS, '  '));
  }
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  if (missing.length && analysis.status === EvaluationStatus.MANUAL) {
    lines.push('What to do:', '  - For each vocabulary listed under "Controlled vocabularies without reference data found" that needs a value, ship reference data that tenant initialization loads, or record why it needs none.');
  }
  if (analysis.runtime) lines.push(...runtimeLines(analysis.runtime));
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

function runtimeLines(runtime: B008Runtime): string[] {
  return runtimeEvidenceLines(runtime, () => {
    const paths = new Map<string, B008Runtime['requests']>();
    for (const request of runtime.requests) {
      const list = paths.get(request.path);
      if (list) list.push(request);
      else paths.set(request.path, [request]);
    }
    const listed = [...paths].slice(0, MAX_ROWS);
    return [
      '  - The module ran in Docker. Tenant initialization with loadReference=true:',
      ...(runtime.tenants.length ? runtime.tenants.map(tenant => `    - ${reportText(tenant.tenant)}: POST /_/tenant ${tenantAnswer(tenant)}`) : ['    - the probe gave no result']),
      ...(paths.size ? [
        '  - Records each provided GET path without parameters returned afterwards:',
        ...listed.map(([path, requests]) => `    - GET ${reportText(path)}: ${requests.map(request => `${reportText(request.tenant)} ${requestAnswer(request)}`).join(', ')}`),
        ...overflowLine(paths.size + runtime.requestsCut, listed.length)
      ] : ['  - The descriptor provides no GET path without parameters to call'])
    ];
  });
}

function tenantAnswer(tenant: B008Runtime['tenants'][number]): string {
  if (tenant.status === undefined) return `got no response (${reportText(tenant.error ?? 'no response')})`;
  const body = tenant.body ? `: ${reportText(tenant.body)}` : '';
  if (tenant.status < 200 || tenant.status >= 300) return `answered ${tenant.status}${body}`;
  if (tenant.complete === false) return `answered ${tenant.status}; the tenant job did not complete`;
  return body ? `answered ${tenant.status}; the tenant job failed${body}` : `answered ${tenant.status}`;
}

function requestAnswer(request: B008Runtime['requests'][number]): string {
  if (request.recordCount !== undefined) return count(request.recordCount, 'record');
  return request.status !== undefined ? `answered ${request.status}` : `got no response (${reportText(request.error ?? 'no response')})`;
}

function sourceText(source: B008Source): string {
  if (source.kind === 'reference-data-folder') return `reference-data folder ${reportPath(source.file)}`;
  if (source.kind === 'liquibase-insert') return `Liquibase insert into ${reportText(source.detail)}, ${location(source.file, source.line)}`;
  return `@Defaults (${reportText(source.detail)}), ${location(source.file, source.line)}`;
}

function location(file: string, line?: number): string {
  return `${reportPath(file)}${line ? `:${line}` : ''}`;
}
