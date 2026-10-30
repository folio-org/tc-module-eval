import { BackendRequestSite } from '../types';
import { CommittedSourceFile } from './committed-source';
import { SOURCE_FILE } from './backend-evidence';
import { lineCounter, withoutComments } from './backend-routes';

type SourceText = Pick<CommittedSourceFile, 'path' | 'content'>;

interface Token {
  kind: 'string' | 'word' | 'symbol';
  text: string;
  offset: number;
  /** A string's content, with escapes undone and Groovy interpolations as UNKNOWN. */
  value?: string;
}

type Part = { text: string } | { unknown: string };

interface Constant {
  file: ParsedFile;
  /** The token of its name. */
  name: number;
  start: number;
}

interface ParsedFile {
  path: string;
  content: string;
  tokens: Token[];
  /** For each `(`, the index of its `)`, or the last token when it is not closed. */
  closing: Map<number, number>;
  /** For each token, the innermost `(` it is inside, or -1. */
  enclosing: Int32Array;
  /** For each token, whether it is inside the arguments of an annotation. */
  inAnnotation: Uint8Array;
  constants: Map<string, Constant>;
  /** Names defined more than once in the file, as in two nested classes or two methods, which the tool cannot tell apart. */
  ambiguous: Set<string>;
  /** The token index of each constant's `=`, which starts its definition and not a use. */
  definitions: Set<number>;
  definitionList: Constant[];
  imports: Map<string, string>;
  staticImports: Map<string, string>;
  staticWildcards: string[];
  packageName: string;
  superclass?: string;
  groovy: boolean;
}

const JAVA_OR_GROOVY = /\.(?:java|groovy)$/;
const KOTLIN_SOURCE = /(?:^|\/)src\/main\/.+\.kt$/;
const GRAILS_SOURCE = /(?:^|\/)grails-app\/(?!conf\/).+\.groovy$/;
const URL_MAPPINGS = /(?:^|\/)UrlMappings[^/]*\.groovy$/;

const UNKNOWN = '\u0002';
const BASE = '\u0003';
const FORMAT_SPECIFIER = /%(?:\d+\$)?[sd]/g;
const FORMAT_SPECIFIER_START = /^%(?:\d+\$)?[sd]/;
const MAX_PARTS = 64;
const MAX_TEXT = 2_000;
const MAX_CONSTANT_DEPTH = 8;
const MAX_EXPRESSION_LENGTH = 160;
const BASE_URL = /url|uri|host|okapi/i;
const SPRING_TYPE_ANNOTATIONS = new Set(['HttpExchange', 'FeignClient']);
const EXCHANGE_ANNOTATIONS = new Map([
  ['GetExchange', 'GET'], ['PostExchange', 'POST'], ['PutExchange', 'PUT'], ['DeleteExchange', 'DELETE'], ['PatchExchange', 'PATCH'], ['HttpExchange', '']
]);
const MAPPING_ANNOTATIONS = new Map([
  ['GetMapping', 'GET'], ['PostMapping', 'POST'], ['PutMapping', 'PUT'], ['DeleteMapping', 'DELETE'], ['PatchMapping', 'PATCH'], ['RequestMapping', '']
]);
const ROUTER_METHODS = new Set(['route', 'get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
const NOT_SENT_BY = new Set([
  'startsWith', 'endsWith', 'equals', 'equalsIgnoreCase', 'contains', 'matches', 'indexOf', 'lastIndexOf', 'replace', 'replaceAll',
  'replaceFirst', 'split', 'compile', 'getResource', 'getResourceAsStream', 'File', 'resolveTemplate', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'
]);
const KEPT_BY = new Set(['formatted', 'trim', 'toString', 'intern']);

/**
 * The outbound requests in a module's production Java and Groovy source, read with comments removed:
 * - Spring HTTP interface clients: each method annotated `@GetExchange`, ..., `@HttpExchange`, or in a `@FeignClient`
 *   type `@GetMapping`, ..., `@RequestMapping`, with the type's path in front; a method that takes a `URI` gets its
 *   address at run time;
 * - paths in code: an expression that joins string literals and string constants with `+`, where the first readable
 *   part starts with `/`, or follows a part that names the Okapi URL (`okapiUrl + "/users"`, `"${okapiUrl}/users"`,
 *   or `format("%s/users", okapiUrl)`). Format specifiers, Groovy interpolations and other parts become run-time
 *   segments.
 *
 * Constants are read from the same file, a static import, the superclass, or the class `Name.CONSTANT` names in the
 * same package or through an import; a name defined twice in one file is not read. A constant's definition is not a
 * request; each use is. A constant whose value is an interface path, and whose uses the tool did not read as
 * requests, is a request the tool could not map, at its definition. Paths compared, logged, read as files or
 * registered as router routes, inside annotations, in `case` labels, absolute URLs with a host, and paths to files (a
 * last segment with an extension) are not requests. Kotlin files are listed, not read.
 */
export function outboundRequests(
  files: SourceText[],
  isInterfacePath: (requestPath: string) => boolean
): { sites: BackendRequestSite[]; fileCount: number; kotlinFiles: string[] } {
  const sources = files.filter(file => (SOURCE_FILE.test(file.path) || GRAILS_SOURCE.test(file.path)) && JAVA_OR_GROOVY.test(file.path) && !URL_MAPPINGS.test(file.path));
  const parsed = sources.map(file => parseFile(file.path, withoutComments(file.content)));
  const resolver = new ConstantResolver(parsed);
  const found = new Map(parsed.map(file => [file, [] as Array<{ token: number; site: Omit<BackendRequestSite, 'line'> }>]));
  for (const file of parsed) {
    const emit: Emit = (token, site) => found.get(file)!.push({ token, site });
    springClientSites(file, resolver, emit);
    codeSites(file, resolver, emit, isInterfacePath);
  }
  const read = resolver.readConstants();
  for (const file of parsed) {
    for (const constant of file.definitionList) {
      if (read.site.has(constant) || read.notSent.has(constant) && !read.unread.has(constant)) continue;
      const expression = readExpression(file, constant.start, resolver);
      const reading = expression.parts.length ? readPath(expression.parts, undefined, isInterfacePath) : undefined;
      if (!reading || 'requestPath' in reading && !isInterfacePath(reading.requestPath)) continue;
      found.get(file)!.push({ token: constant.name, site: {
        path: file.path, kind: 'code', expression: oneLine(sourceText(file, constant.name, expression.end)),
        unresolved: 'the tool could not read how this constant is used'
      } });
    }
  }
  const sites: BackendRequestSite[] = [];
  for (const file of parsed) {
    const fileSites = found.get(file)!.sort((left, right) => left.token - right.token);
    const lineAt = lineCounter(file.content);
    for (const { token, site } of fileSites) sites.push({ ...site, line: lineAt(file.tokens[token].offset) });
  }
  return { sites, fileCount: sources.length, kotlinFiles: files.filter(file => KOTLIN_SOURCE.test(file.path)).map(file => file.path) };
}

function tokenize(content: string, groovy: boolean): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < content.length) {
    const character = content[index];
    if (/\s/.test(character)) {
      index++;
    } else if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      while (index < content.length && /[\w$]/.test(content[index])) index++;
      tokens.push({ kind: 'word', text: content.slice(start, index), offset: start });
    } else if (/\d/.test(character)) {
      const start = index;
      while (index < content.length && /[\w.]/.test(content[index])) index++;
      tokens.push({ kind: 'word', text: content.slice(start, index), offset: start });
    } else if (character === '"' || character === '\'') {
      const start = index;
      const triple = content.startsWith(character.repeat(3), index);
      const quote = triple ? character.repeat(3) : character;
      index += quote.length;
      const bodyStart = index;
      while (index < content.length && !content.startsWith(quote, index) && (triple || content[index] !== '\n')) index += content[index] === '\\' ? 2 : 1;
      const raw = content.slice(bodyStart, Math.min(index, content.length));
      index += quote.length;
      tokens.push({ kind: 'string', text: content.slice(start, Math.min(index, content.length)), offset: start, value: stringValue(raw, groovy && character === '"') });
    } else {
      tokens.push({ kind: 'symbol', text: character, offset: index });
      index++;
    }
  }
  return tokens;
}

function stringValue(raw: string, interpolated: boolean): string {
  const unescaped = (text: string) => text.replace(/\\(.)/g, (_escape, character: string) => ({ n: '\n', t: '\t' } as Record<string, string>)[character] ?? character);
  if (!interpolated) return unescaped(raw);
  return raw.split(/(\$\{[^{}\n]*\}|\$[A-Za-z_][\w.]*)/).map((piece, index) =>
    index % 2 ? BASE_URL.test(piece) ? BASE : UNKNOWN : unescaped(piece)).join('');
}

function parseFile(path: string, content: string): ParsedFile {
  const groovy = /\.groovy$/.test(path);
  const tokens = tokenize(content, groovy);
  const closing = new Map<number, number>();
  const enclosing = new Int32Array(tokens.length).fill(-1);
  const inAnnotation = new Uint8Array(tokens.length);
  const stack: number[] = [];
  const annotationDepths: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    enclosing[index] = stack.length ? stack[stack.length - 1] : -1;
    if (annotationDepths.length) inAnnotation[index] = 1;
    if (token.text === '(' && token.kind === 'symbol') {
      if (tokens[index - 1]?.kind === 'word' && annotationStart(tokens, index - 1) !== undefined) annotationDepths.push(stack.length);
      stack.push(index);
    } else if (token.text === ')' && token.kind === 'symbol' && stack.length) {
      closing.set(stack.pop()!, index);
      if (annotationDepths[annotationDepths.length - 1] === stack.length) annotationDepths.pop();
    }
  }
  while (stack.length) closing.set(stack.pop()!, tokens.length - 1);

  const file: ParsedFile = {
    path, content, tokens, closing, enclosing, inAnnotation, constants: new Map(), ambiguous: new Set(), definitions: new Set(),
    definitionList: [], imports: new Map(), staticImports: new Map(), staticWildcards: [], packageName: '', groovy
  };
  const firstWord = tokens.findIndex(token => token.kind === 'word');
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'word' && token.text === 'package' && index === firstWord) {
      file.packageName = qualifiedName(tokens, index + 1).name;
    } else if (token.kind === 'word' && token.text === 'import' && tokens[index - 1]?.text !== '.') {
      const isStatic = tokens[index + 1]?.text === 'static';
      const { name, wildcard } = qualifiedName(tokens, index + (isStatic ? 2 : 1));
      if (!name) continue;
      const simple = name.split('.').pop()!;
      if (isStatic && wildcard) file.staticWildcards.push(name);
      else if (isStatic) file.staticImports.set(simple, name.split('.').slice(0, -1).join('.'));
      else if (!wildcard) file.imports.set(simple, name);
    } else if (token.kind === 'word' && token.text === 'extends' && file.superclass === undefined && tokens[index + 1]?.kind === 'word') {
      file.superclass = tokens[index + 1].text;
    } else if (token.text === '=' && token.kind === 'symbol' && tokens[index + 1]?.text !== '=' && tokens[index - 1]?.kind === 'word' && isConstantDeclaration(tokens, index - 1)) {
      const name = tokens[index - 1].text;
      const constant = { file, name: index - 1, start: index + 1 };
      if (file.constants.has(name)) file.ambiguous.add(name);
      file.constants.set(name, constant);
      file.definitionList.push(constant);
      file.definitions.add(index);
    }
  }
  return file;
}

/** The dotted name from `start`, and whether it ends in `.*`. */
function qualifiedName(tokens: Token[], start: number): { name: string; wildcard: boolean } {
  const parts: string[] = [];
  let index = start;
  while (tokens[index]?.kind === 'word') {
    parts.push(tokens[index].text);
    if (tokens[index + 1]?.text !== '.') return { name: parts.join('.'), wildcard: false };
    if (tokens[index + 2]?.text === '*') return { name: parts.join('.'), wildcard: true };
    index += 2;
  }
  return { name: parts.join('.'), wildcard: false };
}

/**
 * Whether the name at `index` is declared as a constant: `static`, as Java constants and Groovy static fields are, or
 * named in upper case after a type, as interface fields are.
 */
function isConstantDeclaration(tokens: Token[], index: number): boolean {
  if (/^[A-Z][A-Z0-9_]*$/.test(tokens[index].text) && tokens[index - 1]?.kind === 'word') return true;
  for (let back = index - 1; back >= 0 && back >= index - 8; back--) {
    const text = tokens[back].text;
    if (tokens[back].kind === 'symbol' && !'<>[].,?'.includes(text)) return false;
    if (text === 'static') return true;
  }
  return false;
}

/** The annotation name when the word at `index` ends one (`@Name` or `@a.b.Name`). */
function annotationStart(tokens: Token[], index: number): string | undefined {
  let at = index;
  while (tokens[at - 1]?.text === '.' && tokens[at - 2]?.kind === 'word') at -= 2;
  return tokens[at - 1]?.text === '@' && tokens[at - 1].kind === 'symbol' ? tokens[index].text : undefined;
}

type ConstantUse = 'site' | 'notSent' | 'unread';

class ConstantResolver {
  private readonly byClass = new Map<string, ParsedFile[]>();
  private readonly values = new Map<Constant, Part[] | 'reading'>();
  /** Values cut at MAX_CONSTANT_DEPTH, by the depth that was left, so that each is read once per depth. */
  private readonly cutValues = new Map<Constant, Map<number, Part[]>>();
  private readonly dependencies = new Map<Constant, Set<Constant>>();
  private readonly reading: Array<Set<Constant>> = [];
  private readonly uses: Record<ConstantUse, Set<Constant>> = { site: new Set(), notSent: new Set(), unread: new Set() };
  private depth = 0;
  private truncated = false;

  constructor(files: ParsedFile[]) {
    for (const file of files) {
      const name = /([^/]+)\.(?:java|groovy)$/.exec(file.path)?.[1];
      if (!name) continue;
      const key = `${file.packageName}.${name}`;
      const list = this.byClass.get(key);
      if (list) list.push(file);
      else this.byClass.set(key, [file]);
    }
  }

  /** The constant a simple name refers to in `file`: its own, a static import's, or its superclass's. */
  simple(file: ParsedFile, name: string): Constant | undefined {
    if (file.constants.has(name)) return this.unambiguous(file, name);
    const imported = file.staticImports.get(name);
    if (imported) return this.unambiguous(this.classFile(imported), name);
    for (const owner of file.staticWildcards) {
      const constant = this.unambiguous(this.classFile(owner), name);
      if (constant) return constant;
    }
    return file.superclass ? this.unambiguous(this.classIn(file, file.superclass), name) : undefined;
  }

  /** The constant `Owner.NAME` refers to in `file`. */
  qualified(file: ParsedFile, owner: string, name: string): Constant | undefined {
    return this.unambiguous(this.classIn(file, owner), name);
  }

  /** Reads the uses in `read`, and records the constants it reads under the kind of use `kind` returns. */
  track<T>(read: () => T, kind: (result: T) => ConstantUse): T {
    this.reading.push(new Set());
    const result = read();
    const constants = this.reading.pop()!;
    const uses = this.uses[kind(result)];
    constants.forEach(constant => uses.add(constant));
    return result;
  }

  /** For each kind of use, the constants such a use read, and those their values read. */
  readConstants(): Record<ConstantUse, Set<Constant>> {
    const closure = (start: Set<Constant>) => {
      const result = new Set<Constant>();
      const pending = [...start];
      while (pending.length) {
        const constant = pending.pop()!;
        if (result.has(constant)) continue;
        result.add(constant);
        pending.push(...this.dependencies.get(constant) ?? []);
      }
      return result;
    };
    return { site: closure(this.uses.site), notSent: closure(this.uses.notSent), unread: closure(this.uses.unread) };
  }

  /** A constant's value; one that refers to itself, or to constants more than MAX_CONSTANT_DEPTH deep, is unknown. */
  value(constant: Constant, name: string): Part[] {
    this.reading[this.reading.length - 1]?.add(constant);
    const known = this.values.get(constant);
    if (known === 'reading') return [{ unknown: name }];
    if (known) return known;
    const left = MAX_CONSTANT_DEPTH - this.depth;
    const cut = left > 0 ? this.cutValues.get(constant)?.get(left) : undefined;
    if (left <= 0 || cut) {
      this.truncated = true;
      return cut ?? [{ unknown: name }];
    }
    const outerTruncated = this.truncated;
    this.truncated = false;
    this.values.set(constant, 'reading');
    this.depth++;
    this.reading.push(new Set());
    const parts = readExpression(constant.file, constant.start, this).parts;
    const dependencies = this.reading.pop()!;
    this.depth--;
    this.dependencies.set(constant, dependencies);
    if (this.truncated) {
      this.values.delete(constant);
      const byDepth = this.cutValues.get(constant) ?? new Map<number, Part[]>();
      this.cutValues.set(constant, byDepth.set(left, parts));
    } else {
      this.values.set(constant, parts);
    }
    this.truncated ||= outerTruncated;
    return parts;
  }

  private unambiguous(file: ParsedFile | undefined, name: string): Constant | undefined {
    return file && !file.ambiguous.has(name) ? file.constants.get(name) : undefined;
  }

  private classIn(file: ParsedFile, simpleName: string): ParsedFile | undefined {
    if (simpleName.includes('.')) return this.classFile(simpleName);
    return this.classFile(file.imports.get(simpleName) ?? `${file.packageName}.${simpleName}`);
  }

  private classFile(qualified: string): ParsedFile | undefined {
    const candidates = this.byClass.get(qualified);
    return candidates?.length === 1 ? candidates[0] : undefined;
  }
}

interface Expression {
  parts: Part[];
  /** The token after the expression. */
  end: number;
  /** The first argument of `.formatted(...)` on the last operand. */
  formatArgument?: string;
}

/** The expression from `start`: operands joined by `+`. */
function readExpression(file: ParsedFile, start: number, resolver: ConstantResolver): Expression {
  const parts: Part[] = [];
  let index = start;
  for (;;) {
    const operand = readOperand(file, index, resolver);
    if (!operand) break;
    parts.push(...operand.parts);
    index = operand.end;
    if (parts.length > MAX_PARTS || parts.reduce((total, part) => total + ('text' in part ? part.text.length : 0), 0) > MAX_TEXT) {
      return { parts: [{ unknown: sourceText(file, start, index) }], end: index };
    }
    if (operand.formatArgument !== undefined) return { parts, end: index, formatArgument: operand.formatArgument };
    if (file.tokens[index]?.text !== '+' || file.tokens[index + 1]?.text === '+' || file.tokens[index + 1]?.text === '=') break;
    index++;
  }
  return { parts, end: index };
}

function readOperand(file: ParsedFile, start: number, resolver: ConstantResolver): Expression | undefined {
  const { tokens } = file;
  const token = tokens[start];
  if (!token || token.kind === 'symbol' && token.text !== '(') return undefined;
  let index = start;
  let parts: Part[];
  if (token.kind === 'string') {
    parts = [{ text: token.value! }];
    index++;
  } else if (token.text === '(') {
    index = file.closing.get(start)! + 1;
    parts = [{ unknown: sourceText(file, start, index) }];
  } else {
    const names: string[] = [];
    let called = false;
    while (tokens[index]?.kind === 'word') {
      names.push(tokens[index].text);
      index++;
      if (tokens[index]?.text === '(') {
        called = true;
        index = file.closing.get(index)! + 1;
      }
      if (called || tokens[index]?.text !== '.' || tokens[index + 1]?.kind !== 'word' || tokens[index + 2]?.text === '(') break;
      index++;
    }
    const text = sourceText(file, start, index);
    const constant = called ? undefined : names.length === 1
      ? resolver.simple(file, names[0])
      : resolver.qualified(file, names.slice(0, -1).join('.'), names[names.length - 1]);
    parts = constant ? resolver.value(constant, text) : [{ unknown: text }];
  }
  let formatArgument: string | undefined;
  while (tokens[index]?.text === '.' && tokens[index + 1]?.kind === 'word') {
    const method = tokens[index + 1].text;
    index += 2;
    if (tokens[index]?.text === '(') {
      if (method === 'formatted') formatArgument = argumentText(file, index + 1);
      index = file.closing.get(index)! + 1;
    }
    if (!KEPT_BY.has(method)) parts = [{ unknown: sourceText(file, start, index) }];
  }
  return { parts, end: index, ...(formatArgument !== undefined ? { formatArgument } : {}) };
}

/** The text of the call argument starting at `start`, up to the next argument. */
function argumentText(file: ParsedFile, start: number): string {
  let end = start;
  while (end < file.tokens.length && file.tokens[end].text !== ',' && file.tokens[end].text !== ')') {
    end = file.tokens[end].text === '(' ? file.closing.get(end)! + 1 : end + 1;
  }
  return end > start ? sourceText(file, start, end) : '';
}

/** The text of tokens `start` to `end`, cut after MAX_EXPRESSION_LENGTH characters. */
function sourceText(file: ParsedFile, start: number, end: number): string {
  const last = file.tokens[end - 1];
  const from = file.tokens[start].offset;
  return file.content.slice(from, Math.min(last.offset + last.text.length, from + 2 * MAX_EXPRESSION_LENGTH));
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_EXPRESSION_LENGTH ? `${line.slice(0, MAX_EXPRESSION_LENGTH - 1)}…` : line;
}

type PathReading = { requestPath: string; openEnd: boolean } | { unresolved: string } | undefined;

/**
 * The request path an expression's parts spell, or undefined when they are not a request path. A part in front of
 * the path must name the Okapi URL, or be a leading format specifier whose argument does; with any other value in
 * front, the path is unresolved when the rest of it is an interface path, and otherwise not a request. The query
 * string is dropped.
 */
function readPath(parts: Part[], formatArgument: string | undefined, isInterfacePath: (requestPath: string) => boolean): PathReading {
  let text = '';
  for (const part of parts) text += 'text' in part ? part.text.replace(FORMAT_SPECIFIER, UNKNOWN) : BASE_URL.test(part.unknown) ? BASE : UNKNOWN;
  if (/^https?:\/\//i.test(text)) return undefined;
  const leading = /^[\u0002\u0003]*/.exec(text)![0];
  const leadingSpecifier = 'text' in parts[0] && FORMAT_SPECIFIER_START.test(parts[0].text);
  const base = leading === '' || leading === BASE || leading === UNKNOWN && leadingSpecifier && formatArgument !== undefined && BASE_URL.test(formatArgument);
  const rest = text.slice(leading.length).split('?')[0];
  if (!/^\/[A-Za-z_]/.test(rest)) return undefined;
  const segments = rest.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (/^[^\u0002\u0003]*\.[A-Za-z0-9]{1,8}$/.test(last)) return undefined;
  let openEnd = false;
  const requestPath = segments.map((segment, index) => {
    if (index === segments.length - 1 && /^[^\u0002\u0003{}]+[\u0002\u0003]+$/.test(segment) && !rest.endsWith('/')) {
      openEnd = true;
      return segment.replace(/[\u0002\u0003]+$/, '');
    }
    return /[\u0002\u0003{}]/.test(segment) || /^:\w+$/.test(segment) ? '{}' : segment;
  }).join('/');
  if (!base) return isInterfacePath(requestPath) ? { unresolved: 'the path starts with a value the tool cannot read' } : undefined;
  return { requestPath, openEnd };
}

type Emit = (token: number, site: Omit<BackendRequestSite, 'line'>) => void;

function codeSites(file: ParsedFile, resolver: ConstantResolver, emit: Emit, isInterfacePath: (requestPath: string) => boolean): void {
  const { tokens } = file;
  let lineEnd = -1;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'symbol') continue;
    const previous = tokens[index - 1];
    if (file.inAnnotation[index] || previous?.text === 'case') {
      if (previous && previous.text !== '.' && previous.text !== '+') resolver.track(() => readExpression(file, index, resolver), () => 'notSent');
      continue;
    }
    if (token.text === 'import' || token.text === 'package') {
      if (lineEnd < token.offset) {
        lineEnd = file.content.indexOf('\n', token.offset);
        if (lineEnd < 0) lineEnd = file.content.length;
      }
      while (index + 1 < tokens.length && tokens[index].text !== ';' && tokens[index + 1].offset < lineEnd) index++;
      continue;
    }
    if (previous && (previous.text === '.' || previous.text === '+' || previous.text === '@' || previous.text === ':' && tokens[index - 2]?.text === ':')) continue;
    if (file.definitions.has(index - 1) || file.definitions.has(index + 1)) continue;
    const { expression, reading, judged } = resolver.track(() => {
      const read = readExpression(file, index, resolver);
      const judgedNotSent = notSent(file, index);
      const path = !read.parts.some(part => 'text' in part) || judgedNotSent ? undefined
        : readPath(read.parts, read.formatArgument ?? formatArgumentAfter(file, index, read.end), isInterfacePath);
      return { expression: read, reading: path, judged: judgedNotSent };
    }, result => result.reading !== undefined ? 'site' : result.judged ? 'notSent' : 'unread');
    if (judged) continue;
    if (!reading) continue;
    const expressionText = oneLine(sourceText(file, index, expression.end));
    emit(index, 'unresolved' in reading
      ? { path: file.path, kind: 'code', expression: expressionText, unresolved: reading.unresolved }
      : { path: file.path, kind: 'code', expression: expressionText, requestPath: reading.requestPath, ...(reading.openEnd ? { openEnd: true } : {}) });
  }
}

/** The argument after the expression from `start` to `end` when it is the format string of `format(...)`. */
function formatArgumentAfter(file: ParsedFile, start: number, end: number): string | undefined {
  const open = file.enclosing[start];
  return open >= 0 && open === start - 1 && file.tokens[open - 1]?.text === 'format' && file.tokens[end]?.text === ','
    ? argumentText(file, end + 1) : undefined;
}

/** Whether the expression at `start` is an argument of a call that compares, logs, reads it as a file or registers it as a route. */
function notSent(file: ParsedFile, start: number): boolean {
  const open = file.enclosing[start];
  if (open < 0) return false;
  const name = file.tokens[open - 1];
  if (!name || name.kind !== 'word') return false;
  if (NOT_SENT_BY.has(name.text) || name.text === 'RouteRegistration' || /(?:Exception|Error)$/.test(name.text)) return true;
  const receiver = file.tokens[open - 2]?.text === '.' ? file.tokens[open - 3] : undefined;
  return !!receiver && (/^(?:log|logger|LOG|LOGGER|Log|Logger)$/.test(receiver.text) || /^(?:Paths?|Files)$/.test(receiver.text)
    || ROUTER_METHODS.has(name.text) && /[Rr]outer$/.test(receiver.text));
}

function springClientSites(file: ParsedFile, resolver: ConstantResolver, emit: Emit): void {
  resolver.track(() => springClients(file, resolver, emit), () => 'site');
}

function springClients(file: ParsedFile, resolver: ConstantResolver, emit: Emit): void {
  const { tokens } = file;
  let prefix: { path?: string; unresolved?: string; feign: boolean } | undefined;
  let braces = 0;
  let prefixBraces = -1;
  let last: { end: number; declaration: Declaration } | undefined;
  for (let index = 1; index < tokens.length; index++) {
    const text = tokens[index].text;
    if (tokens[index].kind === 'symbol' && !file.inAnnotation[index] && (text === '{' || text === '}')) {
      braces += text === '{' ? 1 : -1;
      if (text === '}' && braces === prefixBraces) prefix = undefined;
      continue;
    }
    if (tokens[index].kind !== 'word' || file.inAnnotation[index] || tokens[index + 1]?.text === '.') continue;
    const name = annotationStart(tokens, index);
    if (!name || !(SPRING_TYPE_ANNOTATIONS.has(name) || EXCHANGE_ANNOTATIONS.has(name) || MAPPING_ANNOTATIONS.has(name))) continue;
    const open = tokens[index + 1]?.text === '(' ? index + 1 : undefined;
    const end = open === undefined ? index + 1 : file.closing.get(open)! + 1;
    const argumentsOf = open === undefined ? new Map<string, number[]>() : annotationArguments(file, open);
    const declaration = last && end <= last.end ? last.declaration : declarationAfter(file, end);
    last = { end: declaration.end, declaration };
    if (declaration.typeToken !== undefined) {
      if (!SPRING_TYPE_ANNOTATIONS.has(name)) continue;
      const feign = name === 'FeignClient';
      const value = feign
        ? argumentsOf.get('url') ? { unresolved: 'the client\'s url is set in its annotation' } : joinedValue(file, resolver, [argumentsOf.get('value') ?? argumentsOf.get('name'), argumentsOf.get('path')])
        : joinedValue(file, resolver, [argumentsOf.get('value') ?? argumentsOf.get('url')]);
      prefix = { ...value, feign };
      prefixBraces = braces;
      continue;
    }
    const isExchange = EXCHANGE_ANNOTATIONS.has(name);
    if (!isExchange && !prefix?.feign) continue;
    const method = isExchange ? EXCHANGE_ANNOTATIONS.get(name) || stringArgument(file, resolver, argumentsOf.get('method')) : MAPPING_ANNOTATIONS.get(name)
      || requestMethod(file, argumentsOf.get('method'));
    const member = joinedValue(file, resolver, [isExchange ? argumentsOf.get('value') ?? argumentsOf.get('url') : argumentsOf.get('value') ?? argumentsOf.get('path')]);
    const typePath = prefix?.path ?? '';
    const expression = oneLine(sourceText(file, index - 1, end));
    const site = { path: file.path, kind: 'spring-client' as const, ...(method ? { method: method.toUpperCase() } : {}), expression };
    const unresolved = prefix?.unresolved ?? member.unresolved ?? (declaration.takesUri ? 'the method takes the request URI as an argument' : undefined);
    if (unresolved) {
      emit(index, { ...site, unresolved });
      continue;
    }
    const joined = joinSpringPaths(typePath, member.path ?? '');
    const requestPath = joined.split('?')[0].replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
      .map(segment => /[{}]/.test(segment) ? '{}' : segment).join('/');
    emit(index, { ...site, requestPath });
  }
}

/** Spring joins a type's and a method's paths with a slash when neither has one at the join. */
function joinSpringPaths(typePath: string, memberPath: string): string {
  if (!typePath) return memberPath;
  if (!memberPath) return typePath;
  return !typePath.endsWith('/') && !memberPath.startsWith('/') ? `${typePath}/${memberPath}` : `${typePath}${memberPath}`;
}

/** An annotation's arguments by name (`value` for a positional one), as the token index each starts at. */
function annotationArguments(file: ParsedFile, open: number): Map<string, number[]> {
  const result = new Map<string, number[]>();
  const close = file.closing.get(open)!;
  let start = open + 1;
  let braces = 0;
  for (let index = open + 1; index <= close; index++) {
    const token = file.tokens[index];
    if (index < close && file.enclosing[index] !== open) continue;
    if (token.text === '{') braces++;
    if (token.text === '}') braces--;
    if (index === close || token.text === ',' && braces === 0) {
      if (start < index) {
        const named = file.tokens[start].kind === 'word' && file.tokens[start + 1]?.text === '=' && file.tokens[start + 2]?.text !== '=';
        const key = named ? file.tokens[start].text : 'value';
        const valueStart = named ? start + 2 : start;
        if (file.tokens[valueStart]?.text === '{') {
          const values: number[] = [];
          for (let item = valueStart + 1; item < index && file.tokens[item].text !== '}'; item++) {
            if (item === valueStart + 1 || file.tokens[item - 1].text === ',') values.push(item);
          }
          result.set(key, values);
        } else {
          result.set(key, [valueStart]);
        }
      }
      start = index + 1;
    }
  }
  return result;
}

/** The value of a path argument (several values are not read), joined to the next with a slash; empty when absent. */
function joinedValue(file: ParsedFile, resolver: ConstantResolver, values: Array<number[] | undefined>): { path?: string; unresolved?: string } {
  let path = '';
  for (const starts of values) {
    if (!starts) continue;
    if (starts.length !== 1) return { unresolved: 'the annotation gives several paths' };
    const value = stringArgument(file, resolver, starts);
    if (value === undefined) return { unresolved: 'the path is not a string or a constant the tool can read' };
    if (/\$\{/.test(value)) return { unresolved: 'the path has a property placeholder' };
    path = joinSpringPaths(path, value);
  }
  return { path };
}

function stringArgument(file: ParsedFile, resolver: ConstantResolver, starts: number[] | undefined): string | undefined {
  if (!starts || starts.length !== 1) return undefined;
  const parts = readExpression(file, starts[0], resolver).parts;
  return parts.every(part => 'text' in part) ? parts.map(part => (part as { text: string }).text).join('') : undefined;
}

/** `RequestMethod.GET` or `GET`. */
function requestMethod(file: ParsedFile, starts: number[] | undefined): string {
  if (!starts || starts.length !== 1) return '';
  const [first, dot, second] = file.tokens.slice(starts[0], starts[0] + 3).map(token => token.text);
  const method = dot === '.' ? second : first;
  return /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(method ?? '') ? method : '';
}

interface Declaration {
  /** The `class`, `interface`, `enum` or `record` keyword of a type declaration. */
  typeToken?: number;
  /** Whether a method takes a `URI` parameter. */
  takesUri: boolean;
  /** The token the declaration's annotations end before, so stacked annotations share one reading. */
  end: number;
}

/** What follows an annotation ending at `start`: a type declaration, or a member, read up to its parameters. */
function declarationAfter(file: ParsedFile, start: number): Declaration {
  const { tokens } = file;
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.text === '@' && tokens[index + 1]?.kind === 'word') {
      index += 2;
      while (tokens[index]?.text === '.' && tokens[index + 1]?.kind === 'word') index += 2;
      if (tokens[index]?.text === '(') index = file.closing.get(index)! + 1;
      continue;
    }
    if (token.kind === 'word' && /^(?:class|interface|enum|record)$/.test(token.text)) return { typeToken: index, takesUri: false, end: index };
    if (token.text === '(') {
      const close = file.closing.get(index)!;
      let takesUri = false;
      for (let parameter = index + 1; parameter < close; parameter++) {
        if (tokens[parameter].text === 'URI' && file.enclosing[parameter] === index && tokens[parameter + 1]?.kind === 'word') takesUri = true;
      }
      return { takesUri, end: index };
    }
    if (token.text === ';' || token.text === '{' || token.text === '=') break;
    index++;
  }
  return { takesUri: false, end: index };
}
