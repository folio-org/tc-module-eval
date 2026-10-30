import {
  B011Analysis,
  B011Basis,
  B011Location,
  B011Reference,
  BackendEvidence,
  EvaluationStatus,
  FrontendChecklistItem
} from '../types';
import { SOURCE_FILE } from './backend-evidence';
import { lineCounter, withoutComments } from './backend-routes';
import { CommittedSourceFile } from './committed-source';
import { FrontendChecklistItemDraft, numberObligations } from './frontend-agent-review';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { count, listText, overflowLine, reportPath, reportText, unique } from './report-text';
import { errorMessage, isRecord } from './type-guards';

const MAX_ROWS = 20;
const MAX_OCCURRENCES = 100;
const MAX_FILES_IN_SUMMARY = 3;

/**
 * `_mod_<x>` right after a tenant placeholder (`${myuniversity}`, `${tenant}`, `{tenant}`), a format specifier
 * (`%s`, `%1$s`), a LIKE wildcard (`%`), or a string started by a `+` or `||` concatenation. A literal tenant such as
 * `diku_mod_x` does not match.
 */
const REFERENCE = /(?:\$?\{[^{}\s]{1,100}\}|%(?:\d{1,2}\$)?s|%|(?:\+|\|\|)\s{0,40}["'])_mod_(\w*)(?:\.(\w+))?/gi;
const CONCATENATION = /^(?:\+|\|\|)\s*/;
const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,100}$/;

const GRAILS_SOURCE = /(?:^|\/)grails-app\/.+\.groovy$/;
const GRAILS_MIGRATION = /(?:^|\/)grails-app\/migrations\/.+\.(?:groovy|xml|ya?ml|sql)$/;
const GROOVY = /\.groovy$/;
const RESOURCES = /(?:^|\/)src\/main\/resources\//;
const RESOURCES_ROOT = /(?:^|\/)src\/main\/resources\/$/;
const RESOURCE_SCRIPT = /\.(?:xml|ya?ml)$/i;
const CHANGELOG_FILE = /\.(?:xml|ya?ml|json)$/i;
const LIQUIBASE_FILE = /\.(?:xml|ya?ml|json|sql)$/i;
const SQL_FILE = /\.sql$/i;
const YAML_FILE = /\.ya?ml$/i;
const DB_SCRIPTS = 'templates/db_scripts/';
const RMB_SCHEMA = 'schema.json';

/**
 * B011 (no access to other modules' database schemas, FQM excepted) looks in the comment-stripped SQL scripts,
 * changelogs and sources of a module with storage for schema names qualified by a tenant placeholder or concatenation,
 * such as `${myuniversity}_mod_configuration`, that name another module. References in code and in RMB scripts that
 * run on every install fail; those in migrations, and names built at runtime, go to the reviewer.
 */
export function evaluateB011(evidence: BackendEvidence): B011Analysis {
  const { kind, storage, snapshot } = evidence;
  const sourceDiagnostics = snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const ownSchemas = ownSchemaNames(evidence);
  const base = {
    criterionId: 'B011' as const, kind, storage, ownSchemas, filesRead: 0, ownSchemaReferences: 0, references: [], unreadRmbSchemas: [], sourceDiagnostics
  };
  const result = (status: EvaluationStatus, basis: B011Basis, summary: string, items: FrontendChecklistItem[], extra: Partial<B011Analysis> = {}): B011Analysis =>
    ({ ...base, ...extra, status, basis, summary: `B011 ${status}: ${summary}`, checklist: frontendChecklist(status, items) });
  const unreadItem = (): FrontendChecklistItemDraft => ({
    id: 'B011-C2',
    title: 'The files the tool could not read refer to no other module\'s database schema.',
    startingPoints: sourceDiagnostics.slice(0, MAX_ROWS).map(diagnostic => ({ path: diagnostic.path ?? '.', note: reportText(diagnostic.message) })),
    reviewerOnly: true,
    obligations: [],
    subjects: []
  });

  if (ownSchemas.includes('mod_fqm_manager')) {
    return result(EvaluationStatus.NOT_APPLICABLE, 'fqm', 'The repository is mod-fqm-manager (FQM), which the criterion excepts.', []);
  }
  if (!storage.present) {
    if (snapshot.complete) {
      return result(EvaluationStatus.NOT_APPLICABLE, 'no-storage', 'No storage evidence was found, so the module has no database schema of its own.', []);
    }
    return result(EvaluationStatus.MANUAL, 'storage-not-known',
      'No storage evidence was found, but the committed source was not read completely, so the tool cannot tell whether the module stores data. A reviewer must check the files it could not read.',
      numberObligations([unreadItem()]));
  }

  const { references, filesRead, ownSchemaReferences, unreadRmbSchemas } = scanReferences(snapshot.files, new Set(ownSchemas));
  const extra = { references, filesRead, ownSchemaReferences, unreadRmbSchemas };
  const sourceIncomplete = !snapshot.complete;

  const failing = references.filter(reference => reference.failing);
  const known = references.filter(reference => reference.schema !== undefined);
  const sentences: string[] = [];
  const byLocation = (location: B011Location) => known.filter(reference => reference.location === location);
  const add = (list: B011Reference[], sentence: (oneFile: boolean, schemas: string) => string, describe: (file: string) => string = reportPath) => {
    if (!list.length) return;
    const schemas = new Set(list.map(reference => reference.schema)).size === 1 ? 'another module\'s database schema' : 'other modules\' database schemas';
    sentences.push(`${sentence(new Set(list.map(reference => reference.file)).size === 1, schemas)}: ${filesText(list, describe)}.`);
  };
  add(byLocation('code'), (_oneFile, schemas) => `The module's code refers to ${schemas}, which only FQM may read`);
  add(byLocation('every-install-script'), (oneFile, schemas) => oneFile
    ? `An RMB script that runs on every install and upgrade (schema.json lists it without fromModuleVersion) refers to ${schemas}`
    : `RMB scripts that run on every install and upgrade (schema.json lists them without fromModuleVersion) refer to ${schemas}`);
  const migrations = byLocation('migration');
  add(migrations, (oneFile, schemas) => oneFile ? `A migration refers to ${schemas}` : `Migrations refer to ${schemas}`,
    file => `${reportPath(file)} (${migrationText(migrations.find(reference => reference.file === file)!)})`);
  add(byLocation('unlisted-script'), (oneFile, schemas) => oneFile
    ? `A script in templates/db_scripts that no readable schema.json lists refers to ${schemas}, so when it runs is not known`
    : `Scripts in templates/db_scripts that no readable schema.json lists refer to ${schemas}, so when they run is not known`);
  add(byLocation('other-file'), (oneFile, schemas) => oneFile
    ? `A file the tool cannot place as code or a migration refers to ${schemas}`
    : `Files the tool cannot place as code or a migration refer to ${schemas}`);
  const runtime = references.filter(reference => reference.schema === undefined);
  add(runtime, () => runtime.length === 1
    ? 'A schema name is built at runtime, so the tool cannot tell which module\'s schema it names'
    : 'Schema names are built at runtime, so the tool cannot tell which modules\' schemas they name');
  if (!ownSchemas.length && known.length) {
    sentences.push('The module\'s own name is not known (no pom.xml artifactId, descriptor id or Gradle project name), so the tool cannot tell whether these schemas are its own.');
  }
  if (sourceIncomplete) sentences.push('The committed source was not read completely, so the tool may have missed references.');

  const toReview = references.length - failing.length + (sourceIncomplete ? 1 : 0);
  const status = failing.length ? EvaluationStatus.FAIL : toReview ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  if (status === EvaluationStatus.MANUAL) {
    sentences.push(references.length && references.every(reference => reference.location === 'migration' && reference.schema !== undefined) && ownSchemas.length
      ? `A reviewer must decide whether ${new Set(references.map(reference => reference.file)).size === 1 ? 'this one-time migration is' : 'these one-time migrations are'} acceptable.`
      : 'A reviewer must check them.');
  }
  if (status === EvaluationStatus.PASS) {
    sentences.push(`No reference to another module's database schema was found in the ${count(filesRead, 'SQL script, changelog and source file')} the tool read, with comments removed.`);
  }

  const items: FrontendChecklistItemDraft[] = [];
  if (references.length) {
    items.push({
      id: 'B011-C1',
      title: 'Each reference to another module\'s database schema is unreachable, part of FQM, or an accepted one-time migration.',
      startingPoints: references.map(reference => ({ path: reference.file, line: reference.occurrences[0].line, note: startingPointNote(reference) })),
      reviewerOnly: false,
      obligations: [],
      subjects: references.map(reference => ({ subject: `${reference.file}: ${reference.occurrences[0].text}`, path: reference.file, line: reference.occurrences[0].line }))
    });
  }
  if (sourceIncomplete) items.push(unreadItem());

  return result(status, 'references-checked', sentences.join(' '), numberObligations(items), extra);
}

export function renderB011HumanDetails(analysis: B011Analysis): string {
  if (analysis.basis === 'fqm') return 'Module: mod-fqm-manager, which the criterion excepts';
  const lines = [`Storage: ${analysis.storage.present ? analysis.storage.evidence.map(reportText).join('; ') : 'none found'}`];
  if (analysis.basis === 'references-checked') {
    lines.push(`Own schema: ${analysis.ownSchemas.length
      ? listText(analysis.ownSchemas.map(schema => `<tenant>_${reportText(schema)}`))
      : 'not known (no pom.xml artifactId, descriptor id or Gradle project name)'}`,
    `Files read: ${analysis.filesRead} SQL scripts, changelogs and sources, with comments removed`);
    if (analysis.ownSchemaReferences) lines.push(`Own-schema references (not counted): ${analysis.ownSchemaReferences}`);
    const section = (heading: string, list: B011Reference[]) => {
      const rows = list.flatMap(reference => reference.occurrences.map(occurrence => `  - ${reportPath(reference.file)}:${occurrence.line} — ${reportText(occurrence.text)}`));
      const total = list.reduce((sum, reference) => sum + reference.occurrenceCount, 0);
      if (rows.length) lines.push(`${heading}:`, ...rows.slice(0, MAX_ROWS), ...overflowLine(total, Math.min(rows.length, MAX_ROWS), '  '));
    };
    const known = analysis.references.filter(reference => reference.schema !== undefined);
    const at = (location: B011Location) => known.filter(reference => reference.location === location);
    section('References in the module\'s code', at('code'));
    section('References in RMB scripts that run on every install and upgrade', at('every-install-script'));
    section('References in migrations', at('migration'));
    const firstByFile = new Map<string, B011Reference>();
    for (const reference of analysis.references) if (reference.migration && !firstByFile.has(reference.file)) firstByFile.set(reference.file, reference);
    const migrations = [...firstByFile.values()];
    if (migrations.length) {
      lines.push('How the migrations run:', ...migrations.slice(0, MAX_ROWS).map(reference => `  - ${reportPath(reference.file)} — ${migrationText(reference)}`),
        ...overflowLine(migrations.length, MAX_ROWS, '  '));
    }
    section('References in scripts no readable schema.json lists', at('unlisted-script'));
    section('References in other files', at('other-file'));
    section('Schema names built at runtime', analysis.references.filter(reference => reference.schema === undefined));
  }
  if (analysis.unreadRmbSchemas.length) {
    lines.push('RMB schema files the tool could not read:', ...analysis.unreadRmbSchemas.map(schema => `  - ${reportPath(schema.path)} — ${reportText(schema.message)}`));
  }
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.slice(0, MAX_ROWS).map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`), ...overflowLine(analysis.sourceDiagnostics.length, MAX_ROWS, '  '));
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    lines.push('What to do:', '  - Read the data of other modules through their APIs instead of their database schemas, for each reference in the module\'s code or in an RMB script that runs on every install and upgrade; a one-time copy belongs in a migration (an RMB script with fromModuleVersion, or a Liquibase changeset).');
  }
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  return lines.join('\n');
}

interface Scan {
  references: B011Reference[];
  filesRead: number;
  ownSchemaReferences: number;
  unreadRmbSchemas: B011Analysis['unreadRmbSchemas'];
}

function scanReferences(files: CommittedSourceFile[], ownSchemas: Set<string>): Scan {
  const { scripts, unreadRmbSchemas } = rmbScripts(files);
  const liquibaseRoots = new Set(files.filter(file => RESOURCES.test(file.path) && CHANGELOG_FILE.test(file.path)
    && baseName(file.path).toLowerCase().includes('changelog') && file.content.includes('databaseChangeLog'))
    .map(file => RESOURCES_ROOT.test(directory(file.path)) ? file.path : directory(file.path)));
  const byKey = new Map<string, B011Reference>();
  let filesRead = 0;
  let ownSchemaReferences = 0;
  for (const file of files) {
    const place = locate(file.path, scripts, liquibaseRoots);
    if (!place) continue;
    filesRead++;
    const text = place.source ? withoutComments(file.content) : withoutSqlComments(file.content, YAML_FILE.test(file.path));
    const lineAt = lineCounter(text);
    for (const match of text.matchAll(REFERENCE)) {
      const name = match[1].toLowerCase();
      if (name && ownSchemas.has(`mod_${name}`)) {
        ownSchemaReferences++;
        continue;
      }
      const schema = name ? `mod_${name}` : undefined;
      const key = `${file.path}\n${schema ?? ''}`;
      let reference = byKey.get(key);
      if (!reference) {
        reference = {
          file: file.path,
          ...(schema ? { schema } : {}),
          location: place.location,
          ...(place.migration ? { migration: place.migration } : {}),
          occurrences: [],
          occurrenceCount: 0,
          failing: schema !== undefined && ownSchemas.size > 0 && (place.location === 'code' || place.location === 'every-install-script')
        };
        byKey.set(key, reference);
      }
      reference.occurrenceCount++;
      if (reference.occurrences.length < MAX_OCCURRENCES) {
        const text = match[0].replace(CONCATENATION, '');
        reference.occurrences.push({ line: lineAt(match.index! + match[0].length - text.length), text });
      }
    }
  }
  const references = [...byKey.values()].sort((a, b) => Number(b.failing) - Number(a.failing)
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.schema ?? '').localeCompare(b.schema ?? ''));
  return { references, filesRead, ownSchemaReferences, unreadRmbSchemas };
}

interface Place {
  location: B011Location;
  migration?: B011Reference['migration'];
  /** Java, Groovy or Kotlin, rather than SQL, XML or YAML. */
  source: boolean;
}

function locate(path: string, scripts: Map<string, { fromModuleVersion?: string }>, liquibaseRoots: Set<string>): Place | undefined {
  if (GRAILS_MIGRATION.test(path)) return { location: 'migration', migration: { kind: 'grails' }, source: GROOVY.test(path) };
  if (SOURCE_FILE.test(path) || GRAILS_SOURCE.test(path)) return { location: 'code', source: true };
  const scriptsAt = dbScriptsDirectory(path);
  if (scriptsAt !== undefined) {
    if (path === `${scriptsAt}${RMB_SCHEMA}`) return { location: 'other-file', source: false };
    const script = scripts.get(path);
    if (!script) return SQL_FILE.test(path) ? { location: 'unlisted-script', source: false } : undefined;
    return script.fromModuleVersion === undefined
      ? { location: 'every-install-script', source: false }
      : { location: 'migration', migration: { kind: 'rmb', fromModuleVersion: script.fromModuleVersion }, source: false };
  }
  if (LIQUIBASE_FILE.test(path) && inLiquibaseRoot(path, liquibaseRoots)) return { location: 'migration', migration: { kind: 'liquibase' }, source: false };
  if (SQL_FILE.test(path) || (RESOURCES.test(path) && RESOURCE_SCRIPT.test(path))) return { location: 'other-file', source: false };
  return undefined;
}

function inLiquibaseRoot(path: string, roots: Set<string>): boolean {
  if (roots.has(path)) return true;
  for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
    if (roots.has(path.slice(0, end + 1))) return true;
  }
  return false;
}

/** The `.../templates/db_scripts/` folder a path is in, or undefined. */
function dbScriptsDirectory(path: string): string | undefined {
  const at = path.lastIndexOf(DB_SCRIPTS);
  return at >= 0 && (at === 0 || path[at - 1] === '/') ? path.slice(0, at + DB_SCRIPTS.length) : undefined;
}

/**
 * The `snippetPath` scripts each RMB `schema.json` lists, by repository path. RMB runs a script on a tenant's first
 * install, and then on each upgrade, or with `fromModuleVersion` only on upgrades from an older version. A script
 * listed both ways runs on every upgrade.
 */
function rmbScripts(files: CommittedSourceFile[]): { scripts: Map<string, { fromModuleVersion?: string }>; unreadRmbSchemas: Scan['unreadRmbSchemas'] } {
  const scripts = new Map<string, { fromModuleVersion?: string }>();
  const unreadRmbSchemas: Scan['unreadRmbSchemas'] = [];
  for (const file of files) {
    const folder = dbScriptsDirectory(file.path);
    if (folder === undefined || file.path !== `${folder}${RMB_SCHEMA}`) continue;
    let schema: unknown;
    try {
      schema = JSON.parse(file.content);
    } catch (error) {
      unreadRmbSchemas.push({ path: file.path, message: errorMessage(error) });
      continue;
    }
    const listed = isRecord(schema) ? schema.scripts : undefined;
    if (listed === undefined) continue;
    if (!Array.isArray(listed)) {
      unreadRmbSchemas.push({ path: file.path, message: 'scripts is not a list' });
      continue;
    }
    for (const entry of listed) {
      if (!isRecord(entry) || typeof entry.snippetPath !== 'string') continue;
      const path = `${folder}${entry.snippetPath.replace(/^(?:\.?\/)+/, '')}`;
      const version = typeof entry.fromModuleVersion === 'string' || typeof entry.fromModuleVersion === 'number' ? String(entry.fromModuleVersion) : undefined;
      const known = scripts.get(path);
      scripts.set(path, known && known.fromModuleVersion === undefined ? known : version === undefined ? {} : { fromModuleVersion: version });
    }
  }
  return { scripts, unreadRmbSchemas };
}

/**
 * SQL, XML or YAML text with `--`, nested `/* *\/`, `<!-- -->`, FreeMarker `<#-- -->` and, in YAML, `#` comments
 * replaced by spaces, keeping line breaks and offsets. Quoted strings and identifiers may span lines; backslashes
 * escape only in PostgreSQL `E'...'` strings.
 */
function withoutSqlComments(content: string, yaml: boolean): string {
  const parts: string[] = [];
  let kept = 0;
  let index = 0;
  const blank = (end: number) => {
    parts.push(content.slice(kept, index), content.slice(index, end).replace(/[^\n]/g, ' '));
    kept = index = end;
  };
  while (index < content.length) {
    const character = content[index];
    if (character === '<' && (content.startsWith('<!--', index) || content.startsWith('<#--', index))) {
      const end = content.indexOf('-->', index + 4);
      blank(end < 0 ? content.length : end + 3);
    } else if ((character === '-' && content[index + 1] === '-') || (yaml && character === '#' && (index === 0 || /\s/.test(content[index - 1])))) {
      const end = content.indexOf('\n', index);
      blank(end < 0 ? content.length : end);
    } else if (character === '/' && content[index + 1] === '*') {
      let end = index + 2;
      let depth = 1;
      while (depth > 0 && end < content.length) {
        const pair = content.slice(end, end + 2);
        if (pair === '/*' || pair === '*/') {
          depth += pair === '/*' ? 1 : -1;
          end += 2;
        } else {
          end++;
        }
      }
      blank(Math.min(end, content.length));
    } else if (character === '\'' && /[Ee]/.test(content[index - 1] ?? '') && !/\w/.test(content[index - 2] ?? '')) {
      index++;
      while (index < content.length && content[index] !== '\'') index += content[index] === '\\' ? 2 : 1;
      index++;
    } else if (character === '\'' || character === '"') {
      const end = content.indexOf(character, index + 1);
      index = end < 0 ? content.length : end + 1;
    } else {
      index++;
    }
  }
  parts.push(content.slice(kept));
  return parts.join('');
}

/**
 * The module's own schema names without the tenant (`mod_users`), including those of the modules its descriptor
 * `replaces`: RMB and folio-spring-base name a tenant's schema `<tenant>_<module>` with the module name's hyphens as
 * underscores.
 */
function ownSchemaNames(evidence: BackendEvidence): string[] {
  const descriptor = evidence.template?.descriptor;
  const descriptorId = isRecord(descriptor) && typeof descriptor.id === 'string' && !descriptor.id.includes('${') ? descriptor.id : undefined;
  const gradleNames = evidence.snapshot.files.filter(file => /(?:^|\/)settings\.gradle(?:\.kts)?$/.test(file.path))
    .flatMap(file => [...file.content.matchAll(/^[ \t]*rootProject\.name[ \t]*=[ \t]*["']([^"'\n]{1,200})["']/gm)].map(match => match[1]));
  const replaced = isRecord(descriptor) && Array.isArray(descriptor.replaces) ? descriptor.replaces.filter((name): name is string => typeof name === 'string') : [];
  const version = descriptorId?.search(/-\d/) ?? -1;
  const schema = (name: string) => name.toLowerCase().replace(/-/g, '_');
  return unique([
    ...[evidence.artifactId, version >= 0 ? descriptorId!.slice(0, version) : descriptorId, ...gradleNames]
      .filter((name): name is string => !!name).map(schema),
    ...replaced.map(schema).filter(name => name.startsWith('mod_'))
  ].filter(name => SCHEMA_NAME.test(name)));
}

function migrationText(reference: B011Reference): string {
  const migration = reference.migration!;
  if (migration.kind === 'rmb') {
    return `an RMB script that runs on a tenant's first install and on upgrades from versions before ${reportText(migration.fromModuleVersion!)}`;
  }
  return migration.kind === 'liquibase' ? 'a Liquibase changelog, whose changesets run once per tenant' : 'a Grails database migration, which runs once per tenant';
}

function startingPointNote(reference: B011Reference): string {
  const where = reference.schema === undefined ? 'schema name built at runtime'
    : reference.failing ? (reference.location === 'code' ? 'in the module\'s code' : 'in an RMB script that runs on every install and upgrade')
      : reference.location === 'migration' ? migrationText(reference)
        : reference.location === 'unlisted-script' ? 'in a script no readable schema.json lists'
          : reference.location === 'other-file' ? 'in a file the tool cannot place as code or a migration'
            : 'the module\'s own name is not known';
  return `${reportText(reference.occurrences[0].text)}${linesText(reference, ' at ')}: ${where}`;
}

function linesText(reference: B011Reference, prefix: string): string {
  const lines = unique(reference.occurrences.map(occurrence => occurrence.line));
  return `${prefix}${lines.length === 1 ? 'line' : 'lines'} ${listText(lines.map(String))}`;
}

/** Per file, the references in it: "path refers to A at line 7 and B at lines 49 and 64"; at most three files. */
function filesText(references: B011Reference[], describe: (file: string) => string): string {
  const files = unique(references.map(reference => reference.file));
  const shown = files.slice(0, MAX_FILES_IN_SUMMARY).map(file => `${describe(file)} refers to ${listText(references.filter(reference => reference.file === file)
    .map(reference => `${reportText(reference.occurrences[0].text)}${linesText(reference, ' at ')}`))}`);
  return files.length > MAX_FILES_IN_SUMMARY ? `${shown.join('; ')}; and ${count(files.length - MAX_FILES_IN_SUMMARY, 'more file')}` : shown.join('; ');
}

function directory(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
