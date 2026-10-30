import { B015Analysis, B015Signal, B015SignalKind, BackendEvidence, CriterionAgentReviewResult, EvaluationStatus } from '../types';
import { backendBrowse, numberBackendObligations } from './backend-agent-review';
import { SOURCE_FILE } from './backend-evidence';
import { lineCounter, withoutComments } from './backend-routes';
import { CommittedSourceFile } from './committed-source';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { FrontendChecklistItemDraft } from './frontend-agent-review';
import { count, listText, reportPath, reportText } from './report-text';

const MAX_SIGNALS_PER_KIND = 250;
const GRAILS_SOURCE = /(?:^|\/)grails-app\/.+\.groovy$/;
const IMPORT_LINE = /^[ \t]*(?:import|package)\b[^\n]*/gm;
const STATEMENT_LOOKBACK = 500;
const BUILDER_LOOKAHEAD = 2_000;
const LEADING_ANNOTATIONS = /^\s*(?:@[\w.]+(?:\s*\([^()]*\))?\s*)*/;
const FIELD_MODIFIER = /^(?:private|protected|public|static)\b/;
const EXPIRY = /\b(?:expireAfter(?:Write|Access)?|refreshAfterWrite|withTTL)\s*\(/;
const EDGE_COMMON_CACHE = /\borg\.folio\.edge\.core\.cache\b/;
const LINE_BREAK_STATEMENTS = /\.(?:groovy|kt)$/;
const CONTINUES_BEFORE = new Set([...'=,([+-*/.:?&|!']);
const CONTINUES_AFTER = new Set([...'.?:)]']);
const ANNOTATION_LINE = /^\s*@[\w.]+(?:\s*\([^()]*\))?(?:\s+@[\w.]+(?:\s*\([^()]*\))?)*\s*$/;

interface SignalPattern {
  kind: B015SignalKind;
  pattern: RegExp;
  /** `bounds` is the source with statement ends as `;` and string contents blanked, at the same offsets. */
  what: (match: RegExpMatchArray, bounds: string, edgeCommon: boolean) => string | undefined;
}

const PATTERNS: SignalPattern[] = [
  { kind: 'session', pattern: /\bHttpSession\b/g, what: () => 'HttpSession' },
  { kind: 'session', pattern: /@Enable\w*HttpSession\b/g, what: ([text]) => `${text} (Spring Session)` },
  { kind: 'session', pattern: /@Session(?:Attributes|Scope)\b/g, what: ([text]) => text },
  { kind: 'session', pattern: /\b\w*[Rr]equest\s*\.\s*getSession\s*\(/g, what: () => 'request.getSession()' },
  { kind: 'session', pattern: /\b(?:SessionHandler|LocalSessionStore|ClusteredSessionStore)\b/g, what: ([text]) => `Vert.x ${text}` },
  {
    kind: 'file-write',
    pattern: /\bFiles\s*\.\s*(write|writeString|newOutputStream|newBufferedWriter|createFile|createDirector(?:y|ies)|copy|move|createTempFile|createTempDirectory)\s*\(/g,
    what: ([, method]) => `Files.${method}${method.startsWith('createTemp') ? ' (temporary file)' : ''}`
  },
  { kind: 'file-write', pattern: /\bnew\s+(FileOutputStream|FileWriter|RandomAccessFile)\s*\(/g, what: ([, type]) => `new ${type}` },
  { kind: 'file-write', pattern: /\bFile\s*\.\s*createTempFile\s*\(/g, what: () => 'File.createTempFile (temporary file)' },
  { kind: 'file-write', pattern: /\bFileUtils\s*\.\s*(write\w*|copy\w*|move\w*|touch)\s*\(/g, what: ([, method]) => `FileUtils.${method}` },
  {
    kind: 'file-write',
    pattern: /\bfileSystem\s*\(\s*\)\s*\.\s*(writeFile|open|createFile|copy|move|createTempFile|createTempDirectory)(?:Blocking)?\s*\(/g,
    what: ([, method]) => `Vert.x fileSystem().${method}${method.startsWith('createTemp') ? ' (temporary file)' : ''}`
  },
  { kind: 'in-memory-state', pattern: /@Cache(?:able|Put)\b/g, what: ([text]) => `${text} method (Spring cache)` },
  { kind: 'in-memory-state', pattern: /\bCaffeine\s*\.\s*newBuilder\s*\(/g, what: (match, source) => builderNote('Caffeine cache', match, source) },
  { kind: 'in-memory-state', pattern: /\bCacheBuilder\s*\.\s*newBuilder\s*\(/g, what: (match, source) => builderNote('Guava cache', match, source) },
  {
    kind: 'in-memory-state',
    pattern: /\bnew\s+(?:Cache\s*\.\s*)?Builder\s*</g,
    what: (match, bounds, edgeCommon) => edgeCommon ? builderNote('edge-common cache', match, bounds) : undefined
  },
  { kind: 'in-memory-state', pattern: /\bgetLocal(?:Async)?Map\s*\(/g, what: () => 'Vert.x local map' },
  {
    kind: 'in-memory-state',
    pattern: /\bnew\s+(ConcurrentHashMap|ConcurrentSkipListMap)\b|\b(ConcurrentHashMap)\s*\.\s*newKeySet\s*\(|\bCollections\s*\.\s*(synchronized(?:Map|SortedMap|Set|List))\s*\(/g,
    what: (match, source) => {
      const prefix = statementPrefix(source, match.index!);
      if (prefix === undefined || !FIELD_MODIFIER.test(prefix)) return undefined;
      return `${/^(?:\w+\s+)*static\b/.test(prefix) ? 'static ' : ''}${match[1] ?? match[2] ?? `Collections.${match[3]}`} field`;
    }
  },
  {
    kind: 'scheduler',
    pattern: /@Scheduled\b/g,
    what: (match, source) => declaration(source, match.index!).includes('@SchedulerLock') ? '@Scheduled with a ShedLock @SchedulerLock' : '@Scheduled'
  },
  { kind: 'scheduler', pattern: /\bsetPeriodic\s*\(/g, what: () => 'Vert.x setPeriodic' },
  { kind: 'scheduler', pattern: /\bschedule(AtFixedRate|WithFixedDelay)\s*\(/g, what: ([, method]) => `schedule${method}` },
  { kind: 'scheduler', pattern: /\bnew\s+Timer\s*\(/g, what: () => 'java.util.Timer' },
  { kind: 'scheduler', pattern: /\bstatic\s+triggers\s*=|\bTriggerBuilder\s*\.\s*newTrigger\s*\(/g, what: () => 'Quartz trigger' }
];

const KIND_ORDER: B015SignalKind[] = ['session', 'file-write', 'in-memory-state', 'scheduler'];

/** The kind of site each checklist item is about. */
export const B015_ITEM_KINDS: Record<string, B015SignalKind> = { 'B015-C1': 'session', 'B015-C2': 'file-write', 'B015-C3': 'in-memory-state', 'B015-C4': 'scheduler' };

/** B015 (high availability) is always manual: it lists the sites that may keep state on one instance or run on every instance. */
export function evaluateB015(evidence: BackendEvidence): B015Analysis {
  const sources = evidence.snapshot.files.filter(file => SOURCE_FILE.test(file.path) || GRAILS_SOURCE.test(file.path));
  const counts: Record<B015SignalKind, number> = { session: 0, 'file-write': 0, 'in-memory-state': 0, scheduler: 0 };
  const listed: Record<B015SignalKind, number> = { session: 0, 'file-write': 0, 'in-memory-state': 0, scheduler: 0 };
  const firstInFile: Record<B015SignalKind, Map<string, B015Signal>> = { session: new Map(), 'file-write': new Map(), 'in-memory-state': new Map(), scheduler: new Map() };
  const signals: B015Signal[] = [];
  for (const file of sources) {
    for (const signal of fileSignals(file)) {
      counts[signal.kind]++;
      if (!firstInFile[signal.kind].has(signal.path)) firstInFile[signal.kind].set(signal.path, signal);
      if (listed[signal.kind]++ < MAX_SIGNALS_PER_KIND) signals.push(signal);
    }
  }
  const fileCounts = Object.fromEntries(KIND_ORDER.map(kind => [kind, firstInFile[kind].size])) as Record<B015SignalKind, number>;
  const sourceDiagnostics = evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.material
    && (!diagnostic.path || SOURCE_FILE.test(diagnostic.path) || GRAILS_SOURCE.test(diagnostic.path)));
  const total = KIND_ORDER.reduce((sum, kind) => sum + counts[kind], 0);
  const found = [
    counts.session ? count(counts.session, 'HTTP session use') : undefined,
    counts['file-write'] ? count(counts['file-write'], 'local file write') : undefined,
    counts['in-memory-state'] ? `${counts['in-memory-state']} ${counts['in-memory-state'] === 1 ? 'in-memory cache or map' : 'in-memory caches or maps'}` : undefined,
    counts.scheduler ? count(counts.scheduler, 'scheduled job') : undefined
  ].filter((part): part is string => part !== undefined);
  const sentences = total
    ? [...(counts.session ? [] : ['No HTTP sessions found.']),
      `${listText(found)} may hold state on one instance or run on every instance. A reviewer must check them.`]
    : ['The tool found no HTTP sessions, local file writes, in-memory caches or maps, or scheduled jobs. A reviewer must still confirm that the module can run as several instances.'];
  if (sourceDiagnostics.length) sentences.push('The committed source was not read completely, so the tool may have missed some.');

  const status = EvaluationStatus.MANUAL;
  return {
    criterionId: 'B015',
    status,
    summary: `B015 manual: ${sentences.join(' ')}`,
    kind: evidence.kind,
    sourceFileCount: sources.length,
    counts,
    fileCounts,
    signals,
    sourceDiagnostics,
    agentBrowseScope: backendBrowse().scope,
    checklist: frontendChecklist(status, checklistItems(signals, firstInFile))
  };
}

export function renderB015HumanDetails(analysis: B015Analysis, agentReview?: CriterionAgentReviewResult): string {
  const row = (label: string, kind: B015SignalKind) =>
    `  - ${label}: ${analysis.counts[kind] ? `${analysis.counts[kind]} in ${count(analysis.fileCounts[kind], 'file')}` : 'none found'}`;
  const total = KIND_ORDER.reduce((sum, kind) => sum + analysis.counts[kind], 0);
  const lines = [
    'What the tool found:',
    `  - Source read: ${count(analysis.sourceFileCount, 'Java, Groovy or Kotlin file')} in src/main and grails-app, without comments`,
    row('HTTP sessions', 'session'),
    row('Local file writes', 'file-write'),
    row('In-memory caches and maps', 'in-memory-state'),
    row('Scheduled jobs', 'scheduler'),
    ...(total > analysis.signals.length ? [`  - Listed: the first ${MAX_SIGNALS_PER_KIND} sites of each kind, ${analysis.signals.length} of ${total}`] : []),
    ...(agentReview ? [`  - Agent review scope: ${reportText(analysis.agentBrowseScope)}`] : [])
  ];
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  lines.push('What to do:', '  - Check each item below for a deployment of several instances behind a load balancer without session affinity; B015 is always decided by a reviewer.');
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

function fileSignals(file: CommittedSourceFile): B015Signal[] {
  const source = withoutStringContents(withoutComments(file.content).replace(IMPORT_LINE, line => ' '.repeat(line.length)));
  const bounds = withoutBracesInParentheses(LINE_BREAK_STATEMENTS.test(file.path) ? withLineBreakStatementEnds(source) : source);
  const edgeCommon = EDGE_COMMON_CACHE.test(file.content);
  const found: Array<{ index: number; kind: B015SignalKind; what: string }> = [];
  for (const { kind, pattern, what } of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const text = what(match, bounds, edgeCommon);
      if (text !== undefined) found.push({ index: match.index!, kind, what: text });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const lineAt = lineCounter(source);
  const seen = new Set<string>();
  const signals: B015Signal[] = [];
  for (const { index, kind, what } of found) {
    const line = lineAt(index);
    const key = `${kind}\n${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push({ kind, path: file.path, line, what });
  }
  return signals;
}

function withoutStringContents(source: string): string {
  const parts: string[] = [];
  let kept = 0;
  let index = 0;
  while (index < source.length) {
    const quote = source.startsWith('"""', index) || source.startsWith("'''", index) ? source.slice(index, index + 3)
      : source[index] === '"' || source[index] === "'" ? source[index] : undefined;
    if (!quote) {
      index++;
      continue;
    }
    const start = index + quote.length;
    let end = start;
    if (quote.length === 3) {
      const close = source.indexOf(quote, start);
      end = close < 0 ? source.length : close;
    } else {
      while (end < source.length && source[end] !== quote && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
      end = Math.min(end, source.length);
    }
    parts.push(source.slice(kept, start), source.slice(start, end).replace(/[^\n]/g, ' '));
    kept = end;
    index = end < source.length && source[end] !== '\n' ? end + quote.length : end;
  }
  parts.push(source.slice(kept));
  return parts.join('');
}

/** Array braces in annotation arguments, such as `@SuppressWarnings({"unchecked"})`, do not end a statement. */
function withoutBracesInParentheses(source: string): string {
  let depth = 0;
  return source.replace(/[(){}]/g, character => {
    if (character === '(') depth++;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (depth > 0) return ' ';
    return character;
  });
}

/** Groovy and Kotlin end a statement at a line break, unless the expression continues across it or the line is only annotations. */
function withLineBreakStatementEnds(source: string): string {
  const characters = source.split('');
  let previous = '';
  let annotations = false;
  let pending: number[] = [];
  let offset = 0;
  for (const line of source.split('\n')) {
    const first = line.search(/\S/);
    if (first >= 0) {
      if (pending.length && !annotations && !CONTINUES_BEFORE.has(previous) && !CONTINUES_AFTER.has(line[first])) for (const at of pending) characters[at] = ';';
      pending = [];
      annotations = ANNOTATION_LINE.test(line);
      previous = line.trimEnd().slice(-1);
    }
    offset += line.length;
    if (offset < source.length) pending.push(offset);
    offset++;
  }
  return characters.join('');
}

function builderNote(name: string, match: RegExpMatchArray, source: string): string {
  const start = match.index! + match[0].length;
  const chain = source.slice(start, start + BUILDER_LOOKAHEAD).split(';', 1)[0];
  return `${name} ${EXPIRY.test(chain) ? 'with' : 'without'} expiry`;
}

function statementStart(source: string, index: number): number | undefined {
  const limit = Math.max(0, index - STATEMENT_LOOKBACK);
  let start = index - 1;
  while (start >= limit && !';{}'.includes(source[start])) start--;
  return start < limit && limit > 0 ? undefined : start + 1;
}

function statementPrefix(source: string, index: number): string | undefined {
  const start = statementStart(source, index);
  return start === undefined ? undefined : source.slice(start, index).replace(LEADING_ANNOTATIONS, '');
}

/** The annotations and signature around an annotation, up to the member's body or end. */
function declaration(source: string, index: number): string {
  const limit = Math.min(source.length, index + STATEMENT_LOOKBACK);
  let end = index;
  while (end < limit && source[end] !== '{' && source[end] !== ';') end++;
  return source.slice(statementStart(source, index) ?? index, end);
}

function checklistItems(signals: B015Signal[], firstInFile: Record<B015SignalKind, Map<string, B015Signal>>) {
  const item = (id: string, title: string): FrontendChecklistItemDraft => {
    const kind = B015_ITEM_KINDS[id];
    const sites = signals.filter(signal => signal.kind === kind);
    return {
      id,
      title,
      startingPoints: sites.map(site => ({ path: site.path, line: site.line, note: site.what })),
      reviewerOnly: false,
      obligations: [],
      subjects: [...firstInFile[kind].values()].map(site => ({ subject: site.path, path: site.path, line: site.line }))
    };
  };
  return numberBackendObligations([
    item('B015-C1', 'No request depends on session affinity: no HTTP session state, and no sticky routing.'),
    item('B015-C2', 'No data is kept only on one instance\'s local disk; temporary files are removed in the same request or job.'),
    item('B015-C3', 'In-memory state is a cache that can be rebuilt from shared storage, not data other instances need.'),
    item('B015-C4', 'Scheduled work runs once across instances, or is safe to run on every instance.')
  ]);
}
