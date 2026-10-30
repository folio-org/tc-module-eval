import { B004DocumentationRow, B004LogSignal, B004Source, B004TopLevelEnv } from '../types';
import { SOURCE_FILE } from './backend-evidence';
import { lineCounter, withoutComments } from './backend-routes';
import { CommittedSourceFile } from './committed-source';
import { isRecord } from './type-guards';

export interface B004Read {
  name: string;
  source: B004Source;
}

export interface B004SourceReads {
  reads: B004Read[];
  /** The first MAX_UNREAD_READS; `unreadReadCount` counts them all. */
  unreadReads: Array<{ path: string; line: number }>;
  unreadReadCount: number;
  logSignals: B004LogSignal[];
}

const MAX_UNREAD_READS = 100;
const MAX_ARGUMENTS_LENGTH = 2_000;
const MAX_NAME_LENGTH = 256;
const MAX_DEFAULT_LENGTH = 200;
const MAX_NESTING = 8;
const MAX_ROWS_PER_NAME = 5;

// Spring resolves an upper-case placeholder from the environment; a dotted one, such as ${spring.application.name}, is a property.
const ENV_SHAPED = /^[A-Z][A-Z0-9_]*$/;
const CONFIGURATION_FILE = /(?:^|\/)(?:src\/main\/resources\/(?:[^/]+\/)*|grails-app\/conf\/)application[^/]*\.(?:ya?ml|properties)$/;
const DOCUMENTATION_FILE = /^(?:ENV_VARS|README)\.md$/i;

const JAVA_STRING = /"(?:[^"\\\n]|\\.)*"/g;
const VALUE_ANNOTATION = /@Value\s*\(\s*(?:value\s*=\s*)?$/;
const STRING_CONSTANT = /\b(?:(?:static\s+final|final\s+static)\s+String|const\s+val)\s+([A-Za-z_]\w*)(?:\s*:\s*String)?\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/g;
const GETENV = /\bgetenv\s*\(/g;
const MAP_READ = /\s*\.\s*(get|getOrDefault|containsKey)\s*\(/y;
const LOG_CALL = /\b(?:log|logger)\s*\.\s*(?:info|debug|warn|warning|error|trace|fatal)\s*\(|\bSystem\s*\.\s*(?:out|err)\s*\.\s*print(?:ln|f)?\s*\(/gi;
const READS_CONFIGURATION = /\bgetenv\s*\(|@Value\b|@ConfigurationProperties\b|\bgetProperty\s*\(|\bconfig\s*\(\s*\)/;
const WHOLE_ENVIRONMENT = /\bgetenv\s*\(\s*\)(?!\s*\.\s*(?:get|getOrDefault|containsKey)\s*\()|\bgetProperties\s*\(\s*\)/;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const SECRET_LIKE = /password|passwd|secret|credential|token|api_?key|access_?key|private_?key/i;
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const DECLARED_BEFORE = /\b(?!(?:return|throw|else|case|yield|new|await)\s)[A-Za-z_$][\w$]*(?:<[^<>()]*>)?(?:\[\])?\s+$/;
// A fallback that is only another placeholder without a value of its own, as in ${S3_URL:${AWS_URL:}}, is no default.
const PLACEHOLDER_ONLY = /^\$\{[^:{}]*:?\}$/;

/**
 * The variables the descriptor template's env lists name, and the state of its top-level `env`. Only a top-level
 * `env[].value` is a default; a `launchDescriptor.env[].value` is a deployment value.
 */
export function templateEnvReads(descriptor: unknown, path: string, lineOf: (pointer: string) => number | undefined): { topLevelEnv: Exclude<B004TopLevelEnv, 'no-template' | 'template-unreadable' | 'not-checked'>; reads: B004Read[] } {
  const record = isRecord(descriptor) ? descriptor : {};
  const launch = isRecord(record.launchDescriptor) ? record.launchDescriptor : {};
  const reads: B004Read[] = [];
  const add = (list: unknown, kind: 'env' | 'launch-env', pointer: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') return;
      const line = lineOf(`${pointer}/${index}`);
      reads.push({ name: entry.name, source: { kind, path, ...(line ? { line } : {}), ...(typeof entry.value === 'string' ? { value: entry.value } : {}) } });
    });
  };
  add(record.env, 'env', '/env');
  add(launch.env, 'launch-env', '/launchDescriptor/env');
  const topLevelEnv = record.env === undefined ? 'missing' : !Array.isArray(record.env) ? 'not-a-list' : record.env.length ? 'present' : 'empty';
  return { topLevelEnv, reads };
}

/**
 * Variables read in `src/main` sources and Spring configuration, and log statements in files that read configuration:
 * - `System.getenv(NAME)`, `getenv().get(NAME)` and `getenv().getOrDefault(NAME, default)`, with NAME a string
 *   literal or a string constant (of the same file, or defined once in the repository);
 * - `${NAME}` and `${NAME:default}` placeholders in Java strings and in `application*.yml` and `.properties`, with
 *   NAME upper case; Groovy and Kotlin strings are templates, not placeholders.
 * Comments are left out.
 */
export function sourceEnvReads(files: CommittedSourceFile[]): B004SourceReads {
  const reads: B004Read[] = [];
  const unreadReads: B004SourceReads['unreadReads'] = [];
  let unreadReadCount = 0;
  const logSignals: B004LogSignal[] = [];

  for (const file of files.filter(candidate => CONFIGURATION_FILE.test(candidate.path))) {
    const comment = file.path.endsWith('.properties') ? /^\s*[#!]/ : /^\s*#/;
    file.content.split('\n').forEach((line, index) => {
      if (comment.test(line)) return;
      for (const placeholder of placeholders(line)) {
        reads.push({ name: placeholder.name, source: { kind: 'configuration', path: file.path, line: index + 1, ...defaultValue(placeholder.fallback) } });
      }
    });
  }

  const sources = files.filter(file => SOURCE_FILE.test(file.path)).map(file => ({ path: file.path, content: withoutComments(file.content) }));
  const constants = repositoryConstants(sources);
  for (const file of sources) {
    const lineAt = lineCounter(file.content);
    const fileConstants = stringConstants(file.content);
    const constant = (name: string) => fileConstants.get(name) ?? constants.get(name);
    const events: Array<{ offset: number; handle: (line: number) => void }> = [];

    const kotlin = file.path.endsWith('.kt');
    if (kotlin || file.path.endsWith('.java')) {
      for (const literal of file.content.matchAll(JAVA_STRING)) {
        const found = placeholders(kotlin ? literal[0].replace(/(\\?)\$\{/g, (_text, escaped: string) => escaped ? '${' : '#{') : literal[0]);
        if (!found.length) continue;
        const annotated = VALUE_ANNOTATION.test(file.content.slice(Math.max(0, literal.index! - 40), literal.index!));
        events.push({
          offset: literal.index!,
          handle: line => found.forEach(placeholder => reads.push({ name: placeholder.name, source: {
            kind: 'configuration', path: file.path, line, ...defaultValue(placeholder.fallback),
            ...(annotated && placeholder.depth === 0 && placeholder.fallback === undefined ? { failFast: true } : {})
          } }))
        });
      }
    }

    const quoted = [...file.content.matchAll(QUOTED)].map(match => [match.index!, match.index! + match[0].length]);
    let quote = 0;
    for (const start of file.content.matchAll(GETENV)) {
      while (quote < quoted.length && quoted[quote][1] <= start.index!) quote++;
      if (quote < quoted.length && quoted[quote][0] < start.index!) continue;
      if (DECLARED_BEFORE.test(file.content.slice(Math.max(0, start.index! - 80), start.index!))) continue;
      const open = start.index! + start[0].length - 1;
      const call = callArguments(file.content, open);
      let nameArgument: string | undefined;
      let fallback: string | undefined;
      if (call && call.arguments.length === 0) {
        MAP_READ.lastIndex = call.end;
        const map = MAP_READ.exec(file.content);
        const mapCall = map ? callArguments(file.content, MAP_READ.lastIndex - 1) : undefined;
        nameArgument = mapCall?.arguments[0];
        if (map?.[1] === 'getOrDefault') fallback = mapCall?.arguments[1];
      } else {
        nameArgument = call?.arguments[0];
      }
      const name = nameArgument === undefined ? undefined : stringValue(nameArgument, constant);
      events.push({
        offset: start.index!,
        handle: line => {
          if (name === undefined) {
            if (++unreadReadCount <= MAX_UNREAD_READS) unreadReads.push({ path: file.path, line });
            return;
          }
          const value = fallback === undefined || fallback === 'null' ? undefined : stringValue(fallback, constant) ?? fallback.slice(0, MAX_DEFAULT_LENGTH);
          reads.push({ name, source: { kind: 'code', path: file.path, line, ...(value === undefined ? {} : { value }) } });
        }
      });
    }

    if (READS_CONFIGURATION.test(file.content)) {
      for (const start of file.content.matchAll(LOG_CALL)) {
        const call = callArguments(file.content, start.index! + start[0].length - 1);
        if (!call) continue;
        const text = call.arguments.join(',');
        const signal = logSignal(text);
        if (signal) events.push({ offset: start.index!, handle: line => logSignals.push({ ...signal, path: file.path, line }) });
      }
    }

    events.sort((left, right) => left.offset - right.offset).forEach(event => event.handle(lineAt(event.offset)));
  }
  return { reads, unreadReads, unreadReadCount, logSignals };
}

function logSignal(argumentsText: string): Omit<B004LogSignal, 'path' | 'line'> | undefined {
  const code = argumentsText.replace(QUOTED, '""');
  const whole = WHOLE_ENVIRONMENT.exec(code);
  if (whole) return { kind: 'environment-dump', subject: whole[0].replace(/\s+/g, '') };
  for (const read of argumentsText.matchAll(/\bgetenv\s*\(\s*"([^"\\\n]{1,256})"/g)) {
    if (SECRET_LIKE.test(read[1])) return { kind: 'secret-value', subject: read[1] };
  }
  for (const [identifier] of code.matchAll(IDENTIFIER)) {
    if (SECRET_LIKE.test(identifier)) return { kind: 'secret-value', subject: identifier };
  }
  return undefined;
}

function defaultValue(fallback: string | undefined): { value?: string } {
  return fallback === undefined || PLACEHOLDER_ONLY.test(fallback) ? {} : { value: fallback.slice(0, MAX_DEFAULT_LENGTH) };
}

/**
 * The `${NAME}` and `${NAME:default}` placeholders of one line with an upper-case NAME, nested ones included, in one
 * pass. A placeholder not closed on its line is not one.
 */
function placeholders(line: string): Array<{ name: string; fallback?: string; depth: number }> {
  const found: Array<{ name: string; fallback?: string; depth: number }> = [];
  const open: Array<{ start: number; colon: number }> = [];
  let tooDeep = 0;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '$' && line[index + 1] === '{') {
      if (open.length < MAX_NESTING) open.push({ start: index + 2, colon: -1 });
      else tooDeep++;
      index++;
    } else if (character === ':' && open.length && !tooDeep && open[open.length - 1].colon < 0) {
      open[open.length - 1].colon = index;
    } else if (character === '}' && tooDeep) {
      tooDeep--;
    } else if (character === '}' && open.length) {
      const { start, colon } = open.pop()!;
      const nameEnd = colon < 0 ? index : colon;
      if (nameEnd - start > MAX_NAME_LENGTH) continue;
      const name = line.slice(start, nameEnd);
      if (!ENV_SHAPED.test(name)) continue;
      const depth = open.length;
      found.push(colon < 0 ? { name, depth } : { name, depth, fallback: line.slice(colon + 1, Math.min(index, colon + 1 + MAX_DEFAULT_LENGTH)) });
    }
  }
  return found;
}

/**
 * The top-level arguments of the call whose `(` is at `open`, read up to MAX_ARGUMENTS_LENGTH characters; undefined
 * when the call does not close by then.
 */
function callArguments(content: string, open: number): { arguments: string[]; end: number } | undefined {
  const args: string[] = [];
  let depth = 0;
  let argumentStart = open + 1;
  const limit = Math.min(content.length, open + 1 + MAX_ARGUMENTS_LENGTH);
  for (let index = open + 1; index < limit; index++) {
    const character = content[index];
    if (character === '"' || character === '\'') {
      index++;
      while (index < limit && content[index] !== character && content[index] !== '\n') index += content[index] === '\\' ? 2 : 1;
    } else if (character === '(' || character === '[' || character === '{') {
      depth++;
    } else if (character === ')' || character === ']' || character === '}') {
      if (depth === 0) {
        const last = content.slice(argumentStart, index).trim();
        if (last || args.length) args.push(last);
        return { arguments: args, end: index + 1 };
      }
      depth--;
    } else if (character === ',' && depth === 0) {
      args.push(content.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
  }
  return undefined;
}

/** A string literal without escapes or templates, or a string constant. */
function stringValue(expression: string, constant: (name: string) => string | undefined): string | undefined {
  const literal = /^"([^"\\$]*)"$|^'([^'\\$]*)'$/.exec(expression);
  if (literal) return literal[1] ?? literal[2];
  return /^[A-Za-z_][\w.]*$/.test(expression) ? constant(expression.split('.').pop()!) : undefined;
}

function stringConstants(content: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const [, name, double, single] of content.matchAll(STRING_CONSTANT)) {
    const value = double ?? single;
    if (!/[\\$]/.test(value) && !constants.has(name)) constants.set(name, value);
  }
  return constants;
}

/** String constants defined once in the repository's sources, or with the same value each time. */
function repositoryConstants(sources: Array<{ content: string }>): Map<string, string> {
  const values = new Map<string, string | null>();
  for (const source of sources) {
    for (const [name, value] of stringConstants(source.content)) {
      const known = values.get(name);
      values.set(name, known === undefined || known === value ? value : null);
    }
  }
  return new Map([...values].filter((entry): entry is [string, string] => entry[1] !== null));
}

export interface B004Documentation {
  files: Array<{ path: string; tableCount: number }>;
  /** The table rows that name each token in their name column: the one headed "name" or "variable", or else the first other than the default, required and description columns. */
  rows: Map<string, B004DocumentationRow[]>;
}

/**
 * The Markdown tables of the root ENV_VARS.md and README.md, outside code fences (policy section 3.1: "ENV_VARS.md (or
 * equivalent section in README.md)", in "human-readable table format"). Columns are found by header words: default,
 * required (or optional, mandatory) and description.
 */
export function documentationTables(files: CommittedSourceFile[]): B004Documentation {
  const documentation: B004Documentation = { files: [], rows: new Map() };
  const ordered = files.filter(file => DOCUMENTATION_FILE.test(file.path))
    .sort((left, right) => Number(/^README/i.test(left.path)) - Number(/^README/i.test(right.path)) || left.path.localeCompare(right.path));
  for (const file of ordered) {
    const lines = file.content.split(/\r?\n/);
    let tableCount = 0;
    let fence: string | undefined;
    for (let index = 0; index < lines.length; index++) {
      if (fence) {
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
        if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = undefined;
        continue;
      }
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index]);
      if (opening) {
        fence = opening[1];
        continue;
      }
      if (/^(?: {4}|\t)/.test(lines[index]) || !lines[index].includes('|') || index + 1 >= lines.length || !lines[index + 1].includes('|')) continue;
      const header = tableCells(lines[index]);
      const delimiter = tableCells(lines[index + 1]);
      if (delimiter.length !== header.length || !delimiter.every(cell => /^:?-+:?$/.test(cell))) continue;
      tableCount++;
      const column = (pattern: RegExp) => header.findIndex(cell => pattern.test(cell));
      const columns = {
        default: column(/\bdefault/i),
        required: column(/\b(?:required|optional|mandatory)\b/i),
        description: column(/\bdescription\b/i)
      };
      const optionalHeader = columns.required >= 0 && !/\b(?:required|mandatory)\b/i.test(header[columns.required]);
      const missingColumns = (['default', 'required', 'description'] as const).filter(role => columns[role] < 0);
      const roleColumns = new Set(Object.values(columns));
      const named = header.findIndex((text, cellIndex) => !roleColumns.has(cellIndex) && /\b(?:name|variable)\b/i.test(text));
      const nameColumn = named >= 0 ? named : header.findIndex((_text, cellIndex) => !roleColumns.has(cellIndex));
      for (index += 2; index < lines.length && lines[index].includes('|') && lines[index].trim(); index++) {
        const cells = tableCells(lines[index]);
        const cell = (role: keyof typeof columns) => columns[role] >= 0 ? { [role]: cells[columns[role]] ?? '' } : {};
        const row: B004DocumentationRow = {
          path: file.path, line: index + 1, missingColumns, ...cell('default'), ...cell('description'),
          ...(columns.required >= 0 ? { required: cells[columns.required] ?? '', ...(optionalHeader ? { optionalColumn: true } : {}) } : {})
        };
        const tokens = new Set((cells[nameColumn] ?? '').replace(/\\(.)/g, '$1').split(/[^A-Za-z0-9_.-]+/));
        for (const token of tokens) {
          if (!token) continue;
          const rows = documentation.rows.get(token) ?? [];
          if (rows.length < MAX_ROWS_PER_NAME) rows.push(row);
          documentation.rows.set(token, rows);
        }
      }
      index--;
    }
    documentation.files.push({ path: file.path, tableCount });
  }
  return documentation;
}

/** The cells of a Markdown table line, split at unescaped pipes, without the outer pipes. */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '\\' && index + 1 < line.length) {
      current += line[index] + line[++index];
    } else if (line[index] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += line[index];
    }
  }
  cells.push(current.trim());
  if (cells.length > 1 && cells[0] === '' && /^\s*\|/.test(line)) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1] === '' && /(?:^|[^\\])\|\s*$/.test(line)) cells.pop();
  return cells;
}
