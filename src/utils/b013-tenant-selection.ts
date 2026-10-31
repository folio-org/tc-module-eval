import {
  B013Analysis,
  CriterionAgentReviewResult,
  B013AsyncKind,
  B013Mechanism,
  B013RedFlag,
  B013RedFlagKind,
  B013Runtime,
  B013Uses,
  BackendEvidence,
  BackendRuntimeEvidence,
  EvaluationStatus
} from '../types';
import { FRAMEWORK_LABELS } from './b001-descriptor-template';
import { SOURCE_FILE } from './backend-evidence';
import { RUNTIME_TENANTS, runtimeEvidenceLines, runtimeSummary } from './backend-runtime-harness';
import { lineCounter, withoutComments } from './backend-routes';
import { CommittedSourceFile } from './committed-source';
import { backendBrowse, numberBackendObligations } from './backend-agent-review';
import { FrontendChecklistItemDraft } from './frontend-agent-review';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { capitalize, count, listText, overflowLine, reportPath, reportText } from './report-text';

const MAX_SITES = 100;
const MAX_ROWS = 20;
const MAX_TEXT = 160;
const MAX_ANNOTATION_ARGUMENTS = 2_000;

const GRAILS_APP = /(?:^|\/)grails-app\//;
const RESOURCES_CONFIG = /(?:^|\/)src\/main\/resources\/(?:config\/)?[^/]+\.(?:ya?ml|properties)$/;
const GRAILS_CONFIG = /(?:^|\/)grails-app\/conf\//;
const CONFIG_FORMAT = /\.(ya?ml|properties)$/;
const API_SPEC = /^(?:openapi|swagger)[ \t]*:/m;

const MECHANISMS: Array<[B013Mechanism, RegExp]> = [
  ['folio-execution-context', /\bFolioExecutionContext\b/g],
  ['rmb-tenant-tool', /\bTenantTool\s*\.\s*(?:tenantId|calculateTenantId)\b/g],
  ['rmb-pg-util', /\bPgUtil\s*\.\s*\w+\s*\(/g],
  ['grails-tenants', /\bOkapiTenantResolver\b|\bTenants\s*\.\s*(?:withId|withCurrent|currentId)\b/g],
  ['tenant-header', /"[Xx]-[Oo][Kk][Aa][Pp][Ii]-[Tt][Ee][Nn][Aa][Nn][Tt]"|\b(?:XOkapiHeaders\s*\.\s*TENANT|OkapiHeaders?\s*\.\s*TENANT|OKAPI_HEADER_TENANT|X_OKAPI_TENANT)\b/g]
];

const ASYNC_WORK: Array<[B013AsyncKind, RegExp]> = [
  ['kafka-consumer', /@KafkaListener\b|\bKafkaConsumerWrapper\b|\bAsyncRecordHandler\b|\bKafkaConsumer\s*\.\s*create\s*\(|\bnew\s+KafkaConsumer\b/g],
  ['scheduled', /@Scheduled\b|\b(?:setPeriodic|setTimer|scheduleAtFixedRate|scheduleWithFixedDelay)\s*\(|\bnew(?:ScheduledThreadPool|SingleThreadScheduledExecutor)\b/g]
];

const IMPORT_LINE = /^[ \t]*(?:import|package)\b[^\n]*/gm;
const ENVIRONMENT_READ = /\bSystem\s*\.\s*(?:getenv|getProperty)\b[^;\n]{0,200}/g;
const VALUE_ANNOTATION = /@Value\s*\(\s*(?:value\s*=\s*)?(?:"([^"\n]{0,500})"|'([^'\n]{0,500})')/g;
const PROPERTY_PLACEHOLDER = /\$\{([\w.-]+)/g;
const STATIC_FIELD = /^[ \t]*(?:@\w+[ \t]+)*((?:[a-z]+[ \t]+)*)static[ \t]+((?:[a-z]+[ \t]+)*)[\w.$]+(?:<[^;=(){}\n]*>)?(?:\[\])*[ \t]+(\w+)[ \t]*[=;]/gm;
const CACHE_ANNOTATION = /@Cache(?:able|Put)\b/g;
const CACHE_BUILDER = /\b(?:Caffeine|CacheBuilder)\s*\.\s*newBuilder\s*\(/g;
const TENANT = /tenant/i;
const TENANT_ID_VALUE = /[ \t]*"([a-z][a-z0-9_]{0,62})"/y;
const ID_OR_NAME = /^(?:ids?|names?)$/i;
const TENANT_KEY = /(?:^|[-_]|(?<=[a-z0-9])(?=T))(?:tenant|Tenant|TENANT)(?:[-_]?(?:id|Id|ID|name|Name|NAME))?s?$/;
const YAML_ENTRY = /^[ \t]*(?:-[ \t]+)?["']?([\w.-]+)["']?[ \t]*:[ \t]+(.*)$/;
const PROPERTIES_ENTRY = /^[ \t]*([\w.-]+)[ \t]*[=:][ \t]*(.*)$/;

const MECHANISM_LABELS: Record<B013Mechanism, string> = {
  'folio-execution-context': 'folio-spring-base\'s FolioExecutionContext',
  'rmb-tenant-tool': 'RMB\'s TenantTool',
  'rmb-pg-util': 'RMB\'s PgUtil',
  'grails-tenants': 'grails-okapi\'s OkapiTenantResolver with GORM\'s Tenants',
  'tenant-header': 'the X-Okapi-Tenant header by name'
};

const RED_FLAG_LABELS: Record<B013RedFlagKind, string> = {
  'configured-tenant': 'tenant from configuration',
  'static-tenant': 'static tenant field',
  'cache-without-tenant': 'cache without a tenant in its key'
};

const ASYNC_LABELS: Record<B013AsyncKind, [string, string]> = {
  'kafka-consumer': ['Kafka consumer', 'Kafka consumers'],
  scheduled: ['scheduled job or timer', 'scheduled jobs or timers']
};

const WHAT_TO_DO = 'Work through the checklist below, and change any request handler, Kafka consumer or scheduled job that selects tenant data by a tenant other than the one in X-Okapi-Tenant.';

const CONFIRM = 'A reviewer must confirm that every request uses the tenant from X-Okapi-Tenant, that no tenant comes from '
  + 'configuration or shared state, and that Kafka consumers and scheduled jobs set the tenant.';

/**
 * B013 (tenant content selected by X-Okapi-Tenant) is always left to the reviewer. It lists how the module takes the
 * tenant from the header, the possible tenant problems the source shows, and the work that runs outside a request.
 */
export function evaluateB013(evidence: BackendEvidence): B013Analysis {
  const { kind, framework } = evidence;
  const sourceDiagnostics = evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const base = { criterionId: 'B013' as const, kind, framework, sourceDiagnostics };
  if (kind === 'library') {
    return {
      ...base, status: EvaluationStatus.NOT_APPLICABLE, mechanisms: [], redFlags: [], redFlagCount: 0, asyncWork: [],
      summary: `B013 ${EvaluationStatus.NOT_APPLICABLE}: The repository is a shared library, which serves no tenant requests of its own.`,
      checklist: { items: [] }
    };
  }

  const scan = scanSource(evidence.snapshot.files);
  const analysis = { ...base, status: EvaluationStatus.MANUAL, ...scan, redFlags: scan.redFlags.slice(0, MAX_SITES), redFlagCount: scan.redFlags.length };
  return { ...analysis, summary: summaryText(analysis), checklist: frontendChecklist(EvaluationStatus.MANUAL, checklistItems(analysis)) };
}

/** The runtime harness's cross-tenant check, as B013's informational runtime evidence. */
export function b013Runtime(runtime: BackendRuntimeEvidence): B013Runtime {
  return { ...runtimeSummary(runtime), tenants: RUNTIME_TENANTS, ...(runtime.crossTenant ? { crossTenant: runtime.crossTenant } : {}) };
}

export function renderB013HumanDetails(analysis: B013Analysis, agentReview?: CriterionAgentReviewResult): string {
  const lines = [`Framework: ${FRAMEWORK_LABELS[analysis.framework.name]}`];
  if (analysis.status === EvaluationStatus.NOT_APPLICABLE) return [...lines, ...(analysis.runtime ? runtimeLines(analysis.runtime) : [])].join('\n');
  const usesLine = (label: string, uses: B013Uses<string>) => `  - ${label} — ${count(uses.uses, 'reference')} in ${count(uses.fileCount, 'file')}`;
  lines.push('Tenant taken from X-Okapi-Tenant:', ...analysis.mechanisms.length
    ? analysis.mechanisms.map(uses => usesLine(MECHANISM_LABELS[uses.kind], uses))
    : ['  - none found']);
  lines.push('Possible tenant problems:', ...analysis.redFlagCount
    ? [...analysis.redFlags.slice(0, MAX_ROWS).map(flag => `  - ${reportPath(flag.path)}:${flag.line} — ${RED_FLAG_LABELS[flag.kind]}: ${reportText(flag.text)}`),
      ...overflowLine(analysis.redFlagCount, Math.min(MAX_ROWS, analysis.redFlags.length), '  ')]
    : ['  - none found']);
  lines.push('Work outside requests:', ...analysis.asyncWork.length
    ? analysis.asyncWork.map(uses => usesLine(capitalize(ASYNC_LABELS[uses.kind][1]), uses))
    : ['  - none found']);
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  lines.push('What to do:', `  - ${WHAT_TO_DO}`);
  if (analysis.runtime) lines.push(...runtimeLines(analysis.runtime));
  if (agentReview) lines.push(`Agent review scope: ${backendBrowse().scope}`);
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

function runtimeLines(runtime: B013Runtime): string[] {
  return runtimeEvidenceLines(runtime, () => {
    const [own, other] = runtime.tenants;
    const check = runtime.crossTenant;
    if (!check) return ['  - The module ran in Docker; the descriptor provides no path with both GET and POST without parameters for a cross-tenant check'];
    const visible = (value: boolean | undefined) => value === undefined ? 'unknown' : value ? 'yes' : 'no';
    return [
      ...(check.path ? [
        `  - The module ran in Docker. Cross-tenant check: a record created with POST ${reportText(check.path)} in ${own}:`,
        `    - visible in ${own}: ${visible(check.visibleInOwnTenant)}`,
        `    - visible in ${other}: ${visible(check.visibleInOtherTenant)}`
      ] : [`  - The module ran in Docker. No cross-tenant check: ${reportText(check.problem ?? 'no record was created')}`]),
      ...(check.requests.length ? ['  - Requests:', ...check.requests.slice(0, MAX_ROWS).map(request =>
        `    - ${reportText(request.method)} ${reportText(request.path)} in ${reportText(request.tenant ?? '')} ${request.status !== undefined
          ? `answered ${request.status}` : `got no response (${reportText(request.error ?? 'no response')})`}`), ...overflowLine(check.requests.length, MAX_ROWS)] : [])
    ];
  });
}

type Scan = Pick<B013Analysis, 'mechanisms' | 'redFlags' | 'asyncWork'>;

function scanSource(files: CommittedSourceFile[]): Scan {
  const mechanisms = new Map<B013Mechanism, Tally>();
  const asyncWork = new Map<B013AsyncKind, Tally>();
  const redFlags: B013RedFlag[] = [];
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (SOURCE_FILE.test(file.path) || (file.path.endsWith('.groovy') && GRAILS_APP.test(file.path))) {
      const code = withoutComments(file.content).replace(IMPORT_LINE, line => ' '.repeat(line.length));
      for (const [kind, pattern] of MECHANISMS) tally(mechanisms, kind, file.path, code, pattern);
      for (const [kind, pattern] of ASYNC_WORK) tally(asyncWork, kind, file.path, code, pattern);
      redFlags.push(...codeRedFlags(file.path, code));
    } else {
      const format = CONFIG_FORMAT.exec(file.path)?.[1];
      if (format && (RESOURCES_CONFIG.test(file.path) || GRAILS_CONFIG.test(file.path)) && !API_SPEC.test(file.content)) redFlags.push(...configRedFlags(file.path, file.content, format === 'properties' ? PROPERTIES_ENTRY : YAML_ENTRY));
    }
  }
  return { mechanisms: usesOf(mechanisms, MECHANISMS), redFlags, asyncWork: usesOf(asyncWork, ASYNC_WORK) };
}

interface Tally {
  uses: number;
  files: Map<string, number>;
}

function tally<Kind>(tallies: Map<Kind, Tally>, kind: Kind, path: string, code: string, pattern: RegExp): void {
  const lineOf = lineCounter(code);
  for (const match of code.matchAll(pattern)) {
    const entry = tallies.get(kind) ?? { uses: 0, files: new Map<string, number>() };
    entry.uses++;
    if (!entry.files.has(path)) entry.files.set(path, lineOf(match.index!));
    tallies.set(kind, entry);
  }
}

function usesOf<Kind extends string>(tallies: Map<Kind, Tally>, order: Array<[Kind, RegExp]>): Array<B013Uses<Kind>> {
  return order.flatMap(([kind]) => {
    const entry = tallies.get(kind);
    return entry ? [{
      kind, uses: entry.uses, fileCount: entry.files.size,
      sites: [...entry.files].slice(0, MAX_SITES).map(([path, line]) => ({ path, line }))
    }] : [];
  });
}

function codeRedFlags(path: string, code: string): B013RedFlag[] {
  const flags: Array<{ kind: B013RedFlagKind; offset: number; text: string }> = [];
  for (const match of code.matchAll(ENVIRONMENT_READ)) {
    if (TENANT.test(match[0])) flags.push({ kind: 'configured-tenant', offset: match.index!, text: match[0] });
  }
  for (const match of code.matchAll(VALUE_ANNOTATION)) {
    if ([...(match[1] ?? match[2]).matchAll(PROPERTY_PLACEHOLDER)].some(([, key]) => isTenantKey(key))) {
      flags.push({ kind: 'configured-tenant', offset: match.index!, text: match[0] });
    }
  }
  for (const match of code.matchAll(STATIC_FIELD)) {
    const modifiers = `${match[1]} ${match[2]}`.split(/[ \t]+/);
    TENANT_ID_VALUE.lastIndex = match.index! + match[0].length;
    const value = match[0].endsWith('=') && TENANT_KEY.test(match[3]) ? TENANT_ID_VALUE.exec(code)?.[1] : undefined;
    const fixedTenant = value !== undefined && !TENANT.test(value);
    if (modifiers.includes('final') ? fixedTenant : TENANT.test(match[3])) {
      flags.push({ kind: 'static-tenant', offset: match.index! + match[0].length - match[0].trimStart().length, text: match[0] });
    }
  }
  for (const match of code.matchAll(CACHE_ANNOTATION)) {
    const text = annotationText(code, match.index!, match[0].length);
    if (!TENANT.test(text)) flags.push({ kind: 'cache-without-tenant', offset: match.index!, text });
  }
  if (!TENANT.test(code)) {
    for (const match of code.matchAll(CACHE_BUILDER)) {
      flags.push({ kind: 'cache-without-tenant', offset: match.index!, text: code.slice(match.index!, match.index! + MAX_TEXT + 1).split('\n')[0] });
    }
  }
  const lineOf = lineCounter(code);
  return flags.sort((a, b) => a.offset - b.offset)
    .map(flag => ({ kind: flag.kind, path, line: lineOf(flag.offset), text: shortText(flag.text) }));
}

function annotationText(code: string, start: number, nameLength: number): string {
  let index = start + nameLength;
  while (index < code.length && /\s/.test(code[index])) index++;
  if (code[index] !== '(') return code.slice(start, start + nameLength);
  const limit = Math.min(code.length, index + MAX_ANNOTATION_ARGUMENTS);
  let depth = 0;
  for (; index < limit; index++) {
    const character = code[index];
    if (character === '"' || character === '\'') {
      index++;
      while (index < limit && code[index] !== character && code[index] !== '\n') index += code[index] === '\\' ? 2 : 1;
    } else if (character === '(') {
      depth++;
    } else if (character === ')' && --depth === 0) {
      return code.slice(start, index + 1);
    }
  }
  return code.slice(start, limit);
}

function configRedFlags(path: string, content: string, entry: RegExp): B013RedFlag[] {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const match = entry.exec(line);
    if (!match || !isTenantKey(match[1])) return [];
    const value = match[2].replace(/(?:^|\s)#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
    return value && !/^[|>]/.test(value) ? [{ kind: 'configured-tenant' as const, path, line: index + 1, text: shortText(line) }] : [];
  });
}

function isTenantKey(key: string): boolean {
  const segments = key.split('.');
  const last = segments[segments.length - 1];
  return TENANT_KEY.test(last) || (segments.length > 1 && ID_OR_NAME.test(last) && TENANT_KEY.test(segments[segments.length - 2]));
}

function shortText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT ? `${collapsed.slice(0, MAX_TEXT)}…` : collapsed;
}

function summaryText(analysis: Omit<B013Analysis, 'summary' | 'checklist'>): string {
  const sentences: string[] = [];
  if (analysis.kind === 'ambiguous') sentences.push('The repository is not a known module or library, so it is checked as a module.');
  if (analysis.kind === 'edge-module') {
    sentences.push('As an edge module, it relies on edge-common to map each API key to a tenant, which it passes on in X-Okapi-Tenant.');
  }
  const libraries = analysis.mechanisms.filter(uses => uses.kind !== 'tenant-header').map(uses => MECHANISM_LABELS[uses.kind]);
  const byName = analysis.mechanisms.some(uses => uses.kind === 'tenant-header');
  if (libraries.length) {
    sentences.push(`Requests use ${listText(libraries)}, which ${libraries.length === 1 ? 'reads' : 'read'} X-Okapi-Tenant${byName ? ', and the code also names the header itself' : ''}.`);
  } else if (byName) {
    sentences.push('The code names the X-Okapi-Tenant header itself.');
  } else if (analysis.kind !== 'edge-module') {
    sentences.push('The tool found no code that takes the tenant from X-Okapi-Tenant.');
  }
  const found = [
    ...(['configured-tenant', 'static-tenant', 'cache-without-tenant'] as const).flatMap(kind => {
      const flags = analysis.redFlags.filter(flag => flag.kind === kind).length;
      return flags ? [kind === 'cache-without-tenant' ? `${count(flags, 'cache')} without a tenant in the key`
        : kind === 'static-tenant' ? count(flags, 'static tenant field') : `${count(flags, 'tenant')} named in configuration`] : [];
    }),
    ...analysis.redFlagCount > analysis.redFlags.length ? [`${analysis.redFlagCount - analysis.redFlags.length} more possible tenant problems`] : [],
    ...analysis.asyncWork.map(uses => `${ASYNC_LABELS[uses.kind][1]} in ${count(uses.fileCount, 'file')}`)
  ];
  sentences.push(found.length ? `The tool found ${listText(found)}.`
    : 'The tool found no tenant from configuration, static tenant field, cache without a tenant key, Kafka consumer or scheduled job.');
  sentences.push(CONFIRM);
  if (analysis.sourceDiagnostics.length) sentences.push('Not all committed source could be read, so the tool may have missed some of these.');
  return `B013 ${EvaluationStatus.MANUAL}: ${sentences.join(' ')}`;
}

function checklistItems(analysis: Omit<B013Analysis, 'summary' | 'checklist'>): ReturnType<typeof numberBackendObligations> {
  const item = (id: string, title: string, startingPoints: FrontendChecklistItemDraft['startingPoints'],
    subjects: FrontendChecklistItemDraft['subjects'] = []): FrontendChecklistItemDraft => ({ id, title, startingPoints, reviewerOnly: false, obligations: [], subjects });
  const asyncSites = analysis.asyncWork.flatMap(uses => uses.sites.map(site => ({ ...site, note: ASYNC_LABELS[uses.kind][0] })));
  const items = numberBackendObligations([
    item('B013-C1', 'Every request reads the tenant from X-Okapi-Tenant.',
      analysis.mechanisms.flatMap(uses => uses.sites.map(site => ({ ...site, note: MECHANISM_LABELS[uses.kind] })))),
    item('B013-C2', 'No tenant comes from configuration or shared state.',
      analysis.redFlags.map(flag => ({ path: flag.path, line: flag.line, note: `${RED_FLAG_LABELS[flag.kind]}: ${flag.text}` })),
      analysis.redFlags.map(flag => ({ subject: `${flag.path}:${flag.line} (${RED_FLAG_LABELS[flag.kind]})`, path: flag.path, line: flag.line, flag: 'manual' as const }))),
    item('B013-C3', 'Asynchronous work (Kafka consumers, timers) carries the tenant.', asyncSites,
      asyncSites.map(site => ({ subject: `${site.path}:${site.line} (${site.note})`, path: site.path, line: site.line, flag: 'manual' as const })))
  ]);
  const requests = items[0].obligations[0];
  if (requests.withheld) {
    const last = items.flatMap(entry => entry.obligations).filter(obligation => !obligation.withheld)
      .reduce((latest, obligation) => obligation.path! > latest.path! || (obligation.path === latest.path && obligation.line! >= latest.line!) ? obligation : latest);
    last.withheld = true;
    delete requests.withheld;
  }
  return items;
}
