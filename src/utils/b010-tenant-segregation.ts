import {
  B010Analysis,
  B010Basis,
  B010Mechanism,
  B010RedFlag,
  B010RedFlagKind,
  B010Runtime,
  BackendEvidence,
  BackendRuntimeEvidence,
  CriterionAgentReviewResult,
  EvaluationStatus,
  FrontendChecklistItem
} from '../types';
import { numberBackendObligations } from './backend-agent-review';
import { SOURCE_FILE } from './backend-evidence';
import { RUNTIME_TENANTS, runtimeEvidenceLines, runtimeSummary } from './backend-runtime-harness';
import { lineCounter, withoutComments } from './backend-routes';
import { CommittedSourceFile } from './committed-source';
import { FrontendChecklistItemDraft } from './frontend-agent-review';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { count, listText, overflowLine, reportPath, reportText } from './report-text';

const MAX_LISTED = 100;
const MAX_ROWS = 20;
const MAX_CALL_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 120;

const GRAILS_SOURCE = /(?:^|\/)grails-app\/.+\.groovy$/;
const GRAILS_MIGRATION = /(?:^|\/)grails-app\/migrations\/.+\.groovy$/;
const DOMAIN_CLASS = /(?:^|\/)grails-app\/domain\/.+\.groovy$/;
const GRAILS_CONFIG = /(?:^|\/)grails-app\/conf\/[^/]+\.(?:ya?ml|groovy|properties)$/;
const SQL_FILE = /\.sql$/i;
const RESOURCE_CHANGELOG = /(?:^|\/)src\/main\/resources\/.+\.(?:xml|ya?ml|json)$/i;
const NAMED_CHANGELOG = /(?:^|\/)src\/main\/resources\/(?:.*\/)?[^/]*changelog[^/]*\.(?:xml|ya?ml|json)$/i;
const RMB_SCHEMA = /(?:^|\/)templates\/db_scripts\/schema\.json$/;
const BUILD_FILE = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/;

const CLIENT_CALL = /\bPostgresClient\s*\.\s*getInstance\s*\(/g;
const PG_UTIL = /\bPgUtil\s*\.\s*\w+\s*\(/;
const OWN_DATASOURCE = /\b(DataSourceBuilder\s*\.\s*create|new\s+(?:HikariDataSource|DriverManagerDataSource|SimpleDriverDataSource|SingleConnectionDataSource|PGSimpleDataSource|PGPoolingDataSource)|DriverManager\s*\.\s*getConnection|PgBuilder\s*\.\s*pool|(?:PgPool|Pool)\s*\.\s*pool)\s*\(/g;
const JPA_TABLE = /@(?:(?:jakarta|javax)\.persistence\.)?Table\s*\(((?:[^()]|\([^()]*\))*)\)/g;
const JPA_SCHEMA = /\bschema\s*=\s*"([^"]*)"/;
const PUBLIC_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?|CREATE(?:\s+OR\s+REPLACE)?(?:\s+(?:TEMP|TEMPORARY|UNLOGGED))?\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|FUNCTION|PROCEDURE|TYPE)(?:\s+IF\s+NOT\s+EXISTS)?|CREATE(?:\s+UNIQUE)?\s+INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?(?:\s+\w+)?\s+ON(?:\s+ONLY)?)\s+"?public"?\s*\.\s*"?(\w+)/gi;
const CREATE_SCHEMA = /\bCREATE\s+SCHEMA(?:\s+IF\s+NOT\s+EXISTS)?\s+(?!IF\s)("?)([A-Za-z_]\w*)\1(?![\w$.{])/gi;
const SCHEMA_NAME = /\bschemaName"?\s*[=:]\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"',)>}]+))/g;
const TYPE_DECLARATION = /(?<![\w.$])(class|enum|interface|trait)\s+([A-Za-z_]\w*)([^{;]*)/g;
const MULTI_TENANCY_MODE = /multiTenancy\.mode\s*[:=]\s*['"]?([A-Za-z]+)/g;

const MECHANISM_PHRASES: Record<B010Mechanism['name'], string> = {
  rmb: 'RMB\'s PostgresClient, which keeps each tenant in its own schema',
  'folio-spring-base': 'folio-spring-base, which sets each database connection to the tenant\'s schema',
  grails: 'GORM multi-tenancy, which keeps each tenant in its own schema or database'
};
const GRAILS_WITHOUT_MODE_PHRASE = 'GORM MultiTenant domain classes, but the tool found no multi-tenancy mode that keeps each tenant in its own schema or database';

interface ScannedFile {
  path: string;
  content: string;
}

/**
 * B010 (data segregated by tenant at the storage layer) applies when the repository has storage evidence. It is then
 * always manual: the tool lists how the framework keeps each tenant in its own schema and the places where data may be
 * stored outside one, for a reviewer to confirm.
 */
export function evaluateB010(evidence: BackendEvidence): B010Analysis {
  const { kind, storage, snapshot } = evidence;
  const sourceDiagnostics = snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const base = { criterionId: 'B010' as const, kind, storage, mechanisms: [], redFlags: [], redFlagCount: 0, unreadClientCalls: [], unreadClientCallCount: 0, sourceDiagnostics };
  const result = (status: EvaluationStatus, basis: B010Basis, summary: string, drafts: FrontendChecklistItemDraft[], extra: Partial<B010Analysis> = {}): B010Analysis =>
    ({ ...base, ...extra, status, basis, summary: `B010 ${status}: ${summary}`, checklist: frontendChecklist(status, wholeItemsFirst(numberBackendObligations(drafts))) });
  const subject = kind === 'library' ? 'The library' : kind === 'ambiguous' ? 'The repository' : kind === 'edge-module' ? 'The edge module' : 'The module';

  if (!storage.present && snapshot.complete) {
    return result(EvaluationStatus.NOT_APPLICABLE, 'no-storage', `${subject} stores no data: the tool found no RMB database schema, PostgresClient or PgUtil use, `
      + 'Liquibase changelog, datasource configuration, or Grails domain classes with a datasource.', []);
  }

  const code: ScannedFile[] = snapshot.files.filter(file => SOURCE_FILE.test(file.path) || GRAILS_SOURCE.test(file.path))
    .map(file => ({ path: file.path, content: withoutComments(file.content) }));
  const changelogs: ScannedFile[] = snapshot.files.filter(file => SQL_FILE.test(file.path) || (RESOURCE_CHANGELOG.test(file.path) && /databaseChangeLog/.test(file.content)))
    .map(file => ({ path: file.path, content: withoutSqlComments(file.content, /\.ya?ml$/i.test(file.path) ? 'yaml' : /\.xml$/i.test(file.path) ? 'xml' : /\.json$/i.test(file.path) ? 'json' : 'sql') }));
  const flags = new Flags();
  const clients = clientCalls(code, flags);
  for (const file of code) {
    scan(file, OWN_DATASOURCE, match => flags.add('own-datasource', file.path, match.line, match.groups[0]));
    scan(file, JPA_TABLE, match => {
      const schema = JPA_SCHEMA.exec(match.groups[0])?.[1];
      if (schema !== undefined && isFixedName(schema)) flags.add('fixed-schema', file.path, match.line, schema);
    });
  }
  for (const file of [...code, ...changelogs]) sqlFlags(file, flags);
  for (const file of [...changelogs, ...code.filter(candidate => GRAILS_MIGRATION.test(candidate.path))]) {
    scan(file, SCHEMA_NAME, match => {
      const value = match.groups.find(group => group !== undefined)!;
      if (isFixedName(value)) flags.add('fixed-schema', file.path, match.line, value);
    });
  }
  const grails = grailsEvidence(snapshot.files, code, flags);
  const mechanisms = [...rmbMechanism(snapshot.files, code, clients.withTenant), ...springMechanism(snapshot.files), ...grails];
  const redFlags = flags.sorted();
  const unreadClientCalls = clients.unread.slice(0, MAX_LISTED);
  const facts = { mechanisms, redFlags: redFlags.slice(0, MAX_LISTED), redFlagCount: redFlags.length, unreadClientCalls, unreadClientCallCount: clients.unread.length };

  const drafts: FrontendChecklistItemDraft[] = [{
    id: 'B010-C1',
    title: 'Every table the module writes is in a per-tenant schema.',
    startingPoints: mechanisms.flatMap(mechanism => mechanism.evidence),
    reviewerOnly: false,
    obligations: [],
    subjects: []
  }];
  if (redFlags.length || clients.unread.length) {
    const byFile = new Map<string, number>();
    for (const flag of redFlags) if (!byFile.has(flag.path)) byFile.set(flag.path, flag.line);
    for (const call of clients.unread) if (!byFile.has(call.path)) byFile.set(call.path, call.line);
    drafts.push({
      id: 'B010-C2',
      title: 'Each place listed stores no tenant data in a schema, table or connection that tenants share.',
      startingPoints: [
        ...redFlags.map(flag => ({ path: flag.path, line: flag.line, note: flagNote(flag) })),
        ...clients.unread.map(call => ({ path: call.path, line: call.line, note: 'PostgresClient.getInstance call whose arguments the tool could not read' }))
      ],
      reviewerOnly: false,
      obligations: [],
      subjects: [...byFile].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([path, line]) => ({ subject: path, path, line, flag: 'manual' as const }))
    });
  }
  drafts.push({
    id: 'B010-C3',
    title: 'Caches and files that hold tenant data are keyed by tenant.',
    startingPoints: [],
    reviewerOnly: false,
    obligations: [],
    subjects: []
  });

  const sentences: string[] = [];
  if (!storage.present) {
    sentences.push(`The tool found no storage evidence, but the committed source was not read completely, so it could not confirm that ${subject.toLowerCase()} stores no data.`);
  } else if (mechanisms.length) {
    sentences.push(`${subject} stores data with ${listText(mechanisms.map(mechanismPhrase))}${redFlags.length || clients.unread.length ? '.' : '; no shared-schema use was found.'}`);
  } else {
    sentences.push(`${subject} stores data, but the tool found no tenant-schema mechanism it knows: RMB's PostgresClient, folio-spring-base or GORM multi-tenancy.`);
  }
  if (redFlags.length) {
    sentences.push(`The tool found ${count(redFlags.length, 'place')} where tenant data may be stored outside a tenant's schema: `
      + `${listText(redFlags.map(flag => `${flagNote(flag)} (${reportPath(flag.path)}:${flag.line})`))}.`);
  }
  if (clients.unread.length) {
    sentences.push(`The tool could not read the arguments of ${count(clients.unread.length, 'PostgresClient.getInstance call')}, so it could not check that ${clients.unread.length === 1 ? 'it passes' : 'they pass'} a tenant id.`);
  }
  if (storage.present && !snapshot.complete) sentences.push('The committed source was not read completely, so the tool may have missed some.');
  sentences.push('A reviewer must confirm.');
  return result(EvaluationStatus.MANUAL, storage.present ? 'storage' : 'storage-unconfirmed', sentences.join(' '), drafts, facts);
}

/** The schemas the runtime harness found after initializing its tenants, as B010's informational runtime evidence. */
export function b010Runtime(runtime: BackendRuntimeEvidence): B010Runtime {
  return { ...runtimeSummary(runtime), tenants: RUNTIME_TENANTS, ...(runtime.database ? { database: runtime.database } : {}) };
}

export function renderB010HumanDetails(analysis: B010Analysis, agentReview?: CriterionAgentReviewResult): string {
  const lines = [`Storage: ${analysis.storage.present ? 'found' : 'none found'}`, ...analysis.storage.evidence.map(item => `  - ${reportText(item)}`)];
  if (analysis.status !== EvaluationStatus.NOT_APPLICABLE) {
    const evidence = analysis.mechanisms.flatMap(mechanism => mechanism.evidence);
    lines.push(`Tenant-schema mechanism: ${evidence.length ? 'found' : 'none found'}`, ...evidence.map(item => `  - ${location(item)} — ${reportText(item.note)}`));
    lines.push(`Places where tenant data may be stored outside a tenant's schema: ${analysis.redFlagCount ? 'found' : 'none found'}`,
      ...analysis.redFlags.slice(0, MAX_ROWS).map(flag => `  - ${location(flag)} — ${flagNote(flag)}`),
      ...overflowLine(analysis.redFlagCount, Math.min(MAX_ROWS, analysis.redFlags.length), '  '));
    if (analysis.unreadClientCalls.length) {
      lines.push('PostgresClient.getInstance calls the tool could not read:', ...analysis.unreadClientCalls.slice(0, MAX_ROWS).map(call => `  - ${location(call)}`),
        ...overflowLine(analysis.unreadClientCallCount, Math.min(MAX_ROWS, analysis.unreadClientCalls.length), '  '));
    }
  }
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  if (analysis.runtime) lines.push(...runtimeLines(analysis.runtime));
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

function mechanismPhrase(mechanism: B010Mechanism): string {
  return mechanism.name === 'grails' && !GRAILS_CONFIG.test(mechanism.evidence[0].path) ? GRAILS_WITHOUT_MODE_PHRASE : MECHANISM_PHRASES[mechanism.name];
}

function wholeItemsFirst(items: FrontendChecklistItem[]): FrontendChecklistItem[] {
  const obligations = items.flatMap(item => item.obligations);
  const withheldWhole = obligations.filter(obligation => obligation.withheld && obligation.subject === undefined);
  const givenSubjects = obligations.filter(obligation => !obligation.withheld && obligation.subject !== undefined);
  withheldWhole.forEach((obligation, index) => {
    const replaced = givenSubjects[givenSubjects.length - 1 - index];
    if (!replaced) return;
    delete obligation.withheld;
    replaced.withheld = true;
  });
  return items;
}

function location(item: { path: string; line?: number }): string {
  return `${reportPath(item.path)}${item.line ? `:${item.line}` : ''}`;
}

function flagNote(flag: B010RedFlag): string {
  const text = reportText(flag.text);
  switch (flag.kind) {
    case 'shared-client': return `${text} has no tenant id, so RMB connects it to the shared public schema`;
    case 'fixed-tenant': return `PostgresClient.getInstance with the fixed tenant id ${text}`;
    case 'own-datasource': return `${text} creates its own database connection, outside the framework's per-tenant connection`;
    case 'public-schema': return `${text} is in the public schema, which all tenants share`;
    case 'fixed-schema': return `the schema ${text} has a fixed name, so all tenants share it`;
    case 'not-multitenant': return `the domain class ${text} does not implement MultiTenant`;
    case 'discriminator': return 'GORM multi-tenancy in DISCRIMINATOR mode keeps all tenants in shared tables';
  }
}

class Flags {
  private readonly seen = new Set<string>();
  private readonly flags: B010RedFlag[] = [];

  add(kind: B010RedFlagKind, path: string, line: number, text: string): void {
    const shown = shorten(text);
    const key = `${kind}\n${path}\n${shown}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.flags.push({ kind, path, line, text: shown });
  }

  sorted(): B010RedFlag[] {
    return [...this.flags].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.line - right.line);
  }
}

function shorten(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > MAX_TEXT_LENGTH ? `${single.slice(0, MAX_TEXT_LENGTH)}…` : single;
}

function isFixedName(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name);
}

function scan(file: ScannedFile, pattern: RegExp, found: (match: { line: number; groups: string[] }) => void): void {
  const lineAt = lineCounter(file.content);
  for (const match of file.content.matchAll(pattern)) found({ line: lineAt(match.index!), groups: match.slice(1) });
}

function sqlFlags(file: ScannedFile, flags: Flags): void {
  scan(file, PUBLIC_WRITE, match => flags.add('public-schema', file.path, match.line, `${match.groups[0].replace(/\s+/g, ' ').toUpperCase()} public.${match.groups[1]}`));
  scan(file, CREATE_SCHEMA, match => flags.add('fixed-schema', file.path, match.line, match.groups[1]));
}

function clientCalls(code: ScannedFile[], flags: Flags): { withTenant: Array<{ path: string; line: number }>; unread: Array<{ path: string; line: number }> } {
  const withTenant: Array<{ path: string; line: number }> = [];
  const unread: Array<{ path: string; line: number }> = [];
  for (const file of code) {
    const lineAt = lineCounter(file.content);
    for (const match of file.content.matchAll(CLIENT_CALL)) {
      const line = lineAt(match.index!);
      const args = callArguments(file.content, match.index! + match[0].length);
      if (!args) {
        unread.push({ path: file.path, line });
      } else if (args.length < 2) {
        flags.add('shared-client', file.path, line, `PostgresClient.getInstance(${args.join('')})`);
      } else if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(args[1])) {
        flags.add('fixed-tenant', file.path, line, args[1]);
      } else {
        withTenant.push({ path: file.path, line });
      }
    }
  }
  return { withTenant, unread };
}

function callArguments(content: string, start: number): string[] | undefined {
  const args: string[] = [];
  let depth = 1;
  let from = start;
  const end = Math.min(content.length, start + MAX_CALL_LENGTH);
  for (let index = start; index < end; index++) {
    const character = content[index];
    if (character === '"' || character === '\'') {
      index++;
      while (index < end && content[index] !== character && content[index] !== '\n') index += content[index] === '\\' ? 2 : 1;
    } else if (character === '(' || character === '[' || character === '{') {
      depth++;
    } else if (character === ')' || character === ']' || character === '}') {
      if (--depth === 0) {
        const last = content.slice(from, index).trim();
        return last || args.length ? [...args, last] : [];
      }
    } else if (character === ',' && depth === 1) {
      args.push(content.slice(from, index).trim());
      from = index + 1;
    }
  }
  return undefined;
}

function rmbMechanism(files: CommittedSourceFile[], code: ScannedFile[], withTenant: Array<{ path: string; line: number }>): B010Mechanism[] {
  const schema = files.find(file => RMB_SCHEMA.test(file.path));
  const pgUtil = code.flatMap(file => {
    const match = PG_UTIL.exec(file.content);
    return match ? [{ path: file.path, line: lineCounter(file.content)(match.index) }] : [];
  });
  const evidence: B010Mechanism['evidence'] = [];
  if (schema) evidence.push({ path: schema.path, note: 'RMB database schema; RMB creates these tables in each tenant\'s own schema' });
  if (withTenant.length) {
    evidence.push({ ...withTenant[0], note: `PostgresClient.getInstance with a tenant id: ${count(withTenant.length, 'call')} in ${count(new Set(withTenant.map(call => call.path)).size, 'file')}` });
  }
  if (pgUtil.length) evidence.push({ ...pgUtil[0], note: `PgUtil, which takes the tenant from the request's Okapi headers: used in ${count(pgUtil.length, 'file')}` });
  return evidence.length ? [{ name: 'rmb', evidence }] : [];
}

function springMechanism(files: CommittedSourceFile[]): B010Mechanism[] {
  const build = files.find(file => BUILD_FILE.test(file.path) && /folio-spring-base/.test(file.content));
  if (!build) return [];
  const changelogs = files.filter(file => NAMED_CHANGELOG.test(file.path));
  const changelog = changelogs.find(file => /master[^/]*$/i.test(file.path)) ?? changelogs[0];
  return [{
    name: 'folio-spring-base',
    evidence: [
      { path: build.path, note: 'folio-spring-base, whose DataSource sets each connection\'s search_path to the request tenant\'s schema' },
      ...(changelog ? [{ path: changelog.path, note: 'Liquibase changelog, which folio-spring-base runs in each tenant\'s schema' }] : [])
    ]
  }];
}

function grailsEvidence(files: CommittedSourceFile[], code: ScannedFile[], flags: Flags): B010Mechanism[] {
  const evidence: B010Mechanism['evidence'] = [];
  for (const file of files.filter(candidate => GRAILS_CONFIG.test(candidate.path))) {
    const content = /\.groovy$/.test(file.path) ? withoutComments(file.content) : file.content;
    for (const { mode, line } of multiTenancyModes(content)) {
      if (mode === 'SCHEMA' || mode === 'DATABASE') {
        if (!evidence.length) evidence.push({ path: file.path, line, note: `GORM multi-tenancy in ${mode} mode: one ${mode === 'SCHEMA' ? 'schema' : 'database'} per tenant` });
      } else if (mode === 'DISCRIMINATOR') {
        flags.add('discriminator', file.path, line, mode);
      }
    }
  }

  const types = new Map<string, Array<{ multiTenant: boolean; parents: string[] }>>();
  const domainClasses: Array<{ path: string; line: number; name: string; multiTenant: boolean; parents: string[] }> = [];
  for (const file of code.filter(candidate => DOMAIN_CLASS.test(candidate.path) || /\.groovy$/.test(candidate.path))) {
    scan(file, TYPE_DECLARATION, match => {
      const [keyword, name, header] = match.groups;
      if (keyword !== 'class' && keyword !== 'trait') return;
      const type = { multiTenant: /\bMultiTenant\b/.test(header), parents: /\b(?:extends|implements)\b/.test(header) ? [...header.matchAll(/\b[A-Z][\w$]*/g)].map(([parent]) => parent) : [] };
      types.set(name, [...types.get(name) ?? [], type]);
      if (keyword === 'class' && DOMAIN_CLASS.test(file.path)) domainClasses.push({ path: file.path, line: match.line, name, ...type });
    });
  }
  const resolved = new Map<string, boolean>();
  const isMultiTenant = (start: string): boolean => {
    const stack = [start];
    const visiting = new Set<string>();
    while (stack.length) {
      const name = stack[stack.length - 1];
      const declared = types.get(name) ?? [];
      if (resolved.has(name)) {
        stack.pop();
      } else if (!visiting.has(name)) {
        visiting.add(name);
        if (declared.some(type => type.multiTenant)) {
          resolved.set(name, true);
          stack.pop();
        } else {
          for (const type of declared) for (const parent of type.parents) if (!resolved.has(parent) && !visiting.has(parent)) stack.push(parent);
        }
      } else {
        resolved.set(name, declared.some(type => type.parents.some(parent => resolved.get(parent) === true)));
        stack.pop();
      }
    }
    return resolved.get(start)!;
  };
  let multiTenantCount = 0;
  let first: { path: string; line: number } | undefined;
  for (const domainClass of domainClasses) {
    if (domainClass.multiTenant || domainClass.parents.some(isMultiTenant)) {
      multiTenantCount++;
      first ??= { path: domainClass.path, line: domainClass.line };
    } else {
      flags.add('not-multitenant', domainClass.path, domainClass.line, domainClass.name);
    }
  }
  if (first) evidence.push({ ...first, note: `${multiTenantCount} of ${domainClasses.length} domain ${domainClasses.length === 1 ? 'class implements' : 'classes implement'} MultiTenant` });
  return evidence.length ? [{ name: 'grails', evidence }] : [];
}

function multiTenancyModes(content: string): Array<{ mode: string; line: number }> {
  const modes: Array<{ mode: string; line: number }> = [];
  const lines = content.split('\n');
  let blockIndent: number | undefined;
  lines.forEach((text, index) => {
    text = text.replace(/^\s*!.*$|(^|\s)#.*$/, '$1');
    const indent = text.length - text.trimStart().length;
    if (blockIndent !== undefined && text.trim() && indent <= blockIndent) blockIndent = undefined;
    if (/^\s*multiTenancy:\s*(?:#.*)?$/.test(text)) {
      blockIndent = indent;
      return;
    }
    const mode = blockIndent !== undefined ? /^\s*mode:\s*['"]?([A-Za-z]+)/.exec(text)?.[1] : undefined;
    if (mode) modes.push({ mode: mode.toUpperCase(), line: index + 1 });
    for (const match of text.matchAll(MULTI_TENANCY_MODE)) modes.push({ mode: match[1].toUpperCase(), line: index + 1 });
  });
  return modes;
}

function withoutSqlComments(content: string, format: 'sql' | 'yaml' | 'xml' | 'json'): string {
  if (format === 'json') return content;
  const parts: string[] = [];
  let kept = 0;
  let index = 0;
  const blank = (end: number) => {
    parts.push(content.slice(kept, index), content.slice(index, end).replace(/[^\n]/g, ' '));
    kept = index = end;
  };
  const lineEnd = () => {
    const end = content.indexOf('\n', index);
    return end < 0 ? content.length : end;
  };
  const sqlCommentAllowed = () => format !== 'xml' || index === 0 || /[\s>]/.test(content[index - 1]);
  while (index < content.length) {
    if (content.startsWith('<!--', index)) {
      const end = content.indexOf('-->', index + 4);
      blank(end < 0 ? content.length : end + 3);
    } else if (content.startsWith('/*', index) && sqlCommentAllowed()) {
      const end = content.indexOf('*/', index + 2);
      blank(end < 0 ? content.length : end + 2);
    } else if ((content.startsWith('--', index) && sqlCommentAllowed()) || (format === 'yaml' && content[index] === '#' && (index === 0 || /\s/.test(content[index - 1])))) {
      blank(lineEnd());
    } else if (content[index] === '\'' && format !== 'xml') {
      index++;
      while (index < content.length && content[index] !== '\'' && content[index] !== '\n') index++;
      index++;
    } else {
      index++;
    }
  }
  parts.push(content.slice(kept));
  return parts.join('');
}

function runtimeLines(runtime: B010Runtime): string[] {
  return runtimeEvidenceLines(runtime, () => {
    const database = runtime.database;
    if (!database) return ['  - The module ran in Docker without PostgreSQL: the tool found no storage and no DB_HOST variable'];
    if (database.problem) return [`  - The module ran in Docker, but the schemas could not be listed: ${reportText(database.problem)}`];
    const schemas = database.schemas.slice(0, MAX_ROWS);
    const tables = database.publicTables.slice(0, MAX_ROWS);
    return [
      `  - The module ran in Docker. Schemas after POST /_/tenant for ${listText(runtime.tenants)}:`,
      ...schemas.map(schema => `    - ${reportText(schema.name)}: ${count(schema.tables, 'table')}`),
      ...overflowLine(database.schemas.length, schemas.length),
      `  - Tables in public: ${tables.length ? tables.map(reportText).join(', ') : 'none'}${database.publicTables.length > tables.length ? `, and ${database.publicTables.length - tables.length} more` : ''}`
    ];
  });
}
