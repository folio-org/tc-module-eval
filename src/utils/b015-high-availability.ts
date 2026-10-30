import { B015Analysis, B015Signal, B015SignalKind, BackendEvidence, EvaluationStatus } from '../types';
import { SOURCE_FILE } from './backend-evidence';
import { lineCounter, withoutComments } from './backend-routes';
import { CommittedSourceFile } from './committed-source';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { FrontendChecklistItemDraft, numberObligations } from './frontend-agent-review';
import { count, listText, reportPath, reportText } from './report-text';

const MAX_SIGNALS = 1_000;
const GRAILS_SOURCE = /(?:^|\/)grails-app\/.+\.groovy$/;
const IMPORT_LINE = /^[ \t]*(?:import|package)\b[^\n]*/gm;
const STATEMENT_LOOKBACK = 500;
const BUILDER_LOOKAHEAD = 2_000;
const LEADING_ANNOTATIONS = /^\s*(?:@[\w.]+(?:\s*\([^()]*\))?\s*)*/;
const FIELD_MODIFIER = /^(?:private|protected|public|static)\b/;
const EXPIRY = /\b(?:expireAfter(?:Write|Access)?|refreshAfterWrite|withTTL)\s*\(/;
const EDGE_COMMON_CACHE = /\borg\.folio\.edge\.core\.cache\b/;

interface SignalPattern {
  kind: B015SignalKind;
  pattern: RegExp;
  what: (match: RegExpMatchArray, source: string, original: string) => string | undefined;
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
    what: (match, source, original) => EDGE_COMMON_CACHE.test(original) ? builderNote('edge-common cache', match, source) : undefined
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

/** B015 (high availability) is always manual: it lists the sites that may keep state on one instance or run on every instance. */
export function evaluateB015(evidence: BackendEvidence): B015Analysis {
  const sources = evidence.snapshot.files.filter(file => SOURCE_FILE.test(file.path) || GRAILS_SOURCE.test(file.path));
  const counts: Record<B015SignalKind, number> = { session: 0, 'file-write': 0, 'in-memory-state': 0, scheduler: 0 };
  const signals: B015Signal[] = [];
  for (const file of sources) {
    for (const signal of fileSignals(file)) {
      counts[signal.kind]++;
      if (signals.length < MAX_SIGNALS) signals.push(signal);
    }
  }
  const sourceDiagnostics = evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.material);
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
    signals,
    sourceDiagnostics,
    checklist: frontendChecklist(status, checklistItems(signals))
  };
}

export function renderB015HumanDetails(analysis: B015Analysis): string {
  const files = (kind: B015SignalKind) => new Set(analysis.signals.filter(signal => signal.kind === kind).map(signal => signal.path)).size;
  const row = (label: string, kind: B015SignalKind) =>
    `  - ${label}: ${analysis.counts[kind] ? `${analysis.counts[kind]} in ${count(files(kind), 'file')}` : 'none found'}`;
  const total = KIND_ORDER.reduce((sum, kind) => sum + analysis.counts[kind], 0);
  const lines = [
    'What the tool found:',
    `  - Source read: ${count(analysis.sourceFileCount, 'Java, Groovy or Kotlin file')} in src/main and grails-app, without comments`,
    row('HTTP sessions', 'session'),
    row('Local file writes', 'file-write'),
    row('In-memory caches and maps', 'in-memory-state'),
    row('Scheduled jobs', 'scheduler'),
    ...(total > analysis.signals.length ? [`  - Listed: the first ${analysis.signals.length} of ${total} sites`] : [])
  ];
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  lines.push('What to do:', '  - Check each item below for a deployment of several instances behind a load balancer without session affinity; B015 is always decided by a reviewer.');
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  return lines.join('\n');
}

function fileSignals(file: CommittedSourceFile): B015Signal[] {
  const source = withoutComments(file.content).replace(IMPORT_LINE, line => ' '.repeat(line.length));
  const found: Array<{ index: number; kind: B015SignalKind; what: string }> = [];
  for (const { kind, pattern, what } of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const text = what(match, source, file.content);
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

function builderNote(name: string, match: RegExpMatchArray, source: string): string {
  const start = match.index! + match[0].length;
  const end = source.indexOf(';', start);
  const chain = source.slice(start, end < 0 ? start + BUILDER_LOOKAHEAD : Math.min(end, start + BUILDER_LOOKAHEAD));
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

function checklistItems(signals: B015Signal[]) {
  const item = (id: string, title: string, kind: B015SignalKind): FrontendChecklistItemDraft => {
    const sites = signals.filter(signal => signal.kind === kind);
    const firstByFile = new Map<string, B015Signal>();
    for (const site of sites) if (!firstByFile.has(site.path)) firstByFile.set(site.path, site);
    return {
      id,
      title,
      startingPoints: sites.map(site => ({ path: site.path, line: site.line, note: site.what })),
      reviewerOnly: false,
      obligations: [],
      subjects: [...firstByFile.values()].map(site => ({ subject: site.path, path: site.path, line: site.line }))
    };
  };
  return numberObligations([
    item('B015-C1', 'No request depends on session affinity: no HTTP session state, and no sticky routing.', 'session'),
    item('B015-C2', 'No data is kept only on one instance\'s local disk; temporary files are removed in the same request or job.', 'file-write'),
    item('B015-C3', 'In-memory state is a cache that can be rebuilt from shared storage, not data other instances need.', 'in-memory-state'),
    item('B015-C4', 'Scheduled work runs once across instances, or is safe to run on every instance.', 'scheduler')
  ]);
}
