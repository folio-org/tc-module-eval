import { CommittedSourceFile } from './committed-source';
import { SOURCE_FILE } from './backend-evidence';

/** A route the source registers: a method (`*` for every method) on a path, with `{name}` parameters. */
export interface SourceRoute {
  method: string;
  path: string;
  file: string;
  line: number;
}

/** Routes found in source, and the route registrations whose path or method the tool could not read. */
export interface RouteScan {
  routes: SourceRoute[];
  /** The first MAX_UNREAD_ROUTES; `unreadRouteCount` counts them all. */
  unreadRoutes: Array<{ file: string; line: number }>;
  unreadRouteCount: number;
}

type SourceText = Pick<CommittedSourceFile, 'path' | 'content'>;

const MAX_UNREAD_ROUTES = 100;
const STRING_CONSTANT = /\bString\s+(\w+)\s*=\s*"((?:[^"\\\n]|\\.)*)"\s*;/g;

// Vert.x Router calls: route(HttpMethod.GET, path), get(path), post(path), ..., or route(path) for every method.
const ROUTE_START = /\b\w*[Rr]outer\s*\.\s*(?:route|get|post|put|delete|patch|head|options)\s*\(/g;
// Tried at each ROUTE_START; the argument is bounded, so a file of unclosed calls is not scanned to its end from each.
const ROUTE_CALL = /\w*[Rr]outer\s*\.\s*(route|get|post|put|delete|patch|head|options)\s*\(([^;]{0,1000}?)\)\s*[.;]/y;

const ROUTE_REGISTRATION_START = /\bnew\s+RouteRegistration\s*\(/g;
const ROUTE_REGISTRATION_CALL = /new\s+RouteRegistration\s*\(([^;]{0,1000}?),\s*\w+\s*\)/y;
const ROUTE_REGISTRATION_METHOD = /\b(\w+)\s*\.\s*(getMany|get|create|replace|deleteAll|delete)\s*\(/g;
/**
 * The routes each method of mod-circulation's RouteRegistration registers for its root path:
 * https://github.com/folio-org/mod-circulation/blob/796a6ddbd10baa0815afdaa078cfc2ec32875077/src/main/java/org/folio/circulation/support/RouteRegistration.java
 */
const ROUTE_REGISTRATION_ROUTES: Record<string, { method: string; suffix: string }> = {
  get: { method: 'GET', suffix: '/{id}' },
  getMany: { method: 'GET', suffix: '' },
  create: { method: 'POST', suffix: '' },
  replace: { method: 'PUT', suffix: '/{id}' },
  delete: { method: 'DELETE', suffix: '/{id}' },
  deleteAll: { method: 'DELETE', suffix: '' }
};

const MAPPING_START = /@(Request|Get|Post|Put|Delete|Patch)Mapping\b/g;
const MAPPING_ARGUMENTS = /\s*\(([^()]{0,1000})\)/y;
const MAPPING_DECLARATION_WINDOW = 2_000;
const TYPE_DECLARATION = /\b(abstract\s+class|class|interface|enum|record)\s+\w/g;

const URL_MAPPINGS = /(?:^|\/)grails-app\/controllers\/(?:.*\/)?UrlMappings[^/]*\.groovy$/;
const MAX_MAPPING_DEPTH = 16;
const MAX_OPTIONAL_PATHS = 16;
// https://docs.grails.org/latest/guide/theWebLayer.html#restfulMappings
const GRAILS_RESOURCES_ACTIONS: Array<[string, string, string]> = [
  ['index', 'GET', ''], ['create', 'GET', '/create'], ['save', 'POST', ''], ['show', 'GET', '/{id}'],
  ['edit', 'GET', '/{id}/edit'], ['update', 'PUT', '/{id}'], ['patch', 'PATCH', '/{id}'], ['delete', 'DELETE', '/{id}']
];
const GRAILS_RESOURCE_ACTIONS: Array<[string, string, string]> = [
  ['show', 'GET', ''], ['create', 'GET', '/create'], ['save', 'POST', ''], ['edit', 'GET', '/edit'],
  ['update', 'PUT', ''], ['patch', 'PATCH', ''], ['delete', 'DELETE', '']
];

class RouteCollector {
  readonly routes: SourceRoute[] = [];
  readonly unreadRoutes: RouteScan['unreadRoutes'] = [];
  unreadRouteCount = 0;

  unread(file: string, line: number): void {
    if (++this.unreadRouteCount <= MAX_UNREAD_ROUTES) this.unreadRoutes.push({ file, line });
  }

  scan(): RouteScan {
    return { routes: this.routes, unreadRoutes: this.unreadRoutes, unreadRouteCount: this.unreadRouteCount };
  }
}

/** Vert.x router routes in `src/main` sources, read with comments removed, with a path literal or a string constant in the same file. */
export function routerRoutes(files: SourceText[]): RouteScan {
  return vertxRoutes(commentFreeSources(files));
}

function commentFreeSources(files: SourceText[]): SourceText[] {
  return files.filter(file => SOURCE_FILE.test(file.path)).map(file => ({ path: file.path, content: withoutComments(file.content) }));
}

function vertxRoutes(sources: SourceText[]): RouteScan {
  const collector = new RouteCollector();
  for (const file of sources) {
    const constants = stringConstants(file.content);
    const lineAt = lineCounter(file.content);
    let readUntil = 0;
    for (const start of file.content.matchAll(ROUTE_START)) {
      if (start.index! < readUntil) continue;
      const line = lineAt(start.index!);
      ROUTE_CALL.lastIndex = start.index!;
      const match = ROUTE_CALL.exec(file.content);
      if (!match) {
        collector.unread(file.path, line);
        continue;
      }
      readUntil = ROUTE_CALL.lastIndex;
      const call = match[1];
      const argument = match[2].trim();
      if (!argument) continue;
      const method = /^HttpMethod\s*\.\s*([A-Z]+)\s*,\s*([\s\S]*)$/.exec(argument);
      const literal = pathValue(method ? method[2] : argument, constants);
      if (literal === undefined) {
        collector.unread(file.path, line);
        continue;
      }
      const routePath = vertxPath(literal);
      if (!routePath.startsWith('/')) continue;
      collector.routes.push({ method: method?.[1] ?? (call === 'route' ? '*' : call.toUpperCase()), path: routePath, file: file.path, line });
    }
  }
  return collector.scan();
}

/**
 * Every route the committed source registers, read with comments removed: Vert.x router routes, mod-circulation's
 * RouteRegistration, Spring mapping annotations (`@GetMapping`, a class-level `@RequestMapping` prefix, ...) and
 * Grails URL mappings.
 */
export function sourceRoutes(files: SourceText[]): RouteScan {
  const sources = commentFreeSources(files);
  const router = vertxRoutes(sources.filter(file => !/\bclass\s+RouteRegistration\b/.test(file.content)));
  const collector = new RouteCollector();
  router.unreadRoutes.forEach(route => collector.unread(route.file, route.line));
  collector.unreadRouteCount = router.unreadRouteCount;
  collector.routes.push(...router.routes);
  for (const file of sources) {
    const constants = stringConstants(file.content);
    routeRegistrations(file, constants, collector);
    if (!/@FeignClient\b/.test(file.content)) springMappings(file, constants, collector);
  }
  for (const file of files.filter(candidate => URL_MAPPINGS.test(candidate.path))) grailsUrlMappings(file, collector);
  return collector.scan();
}

/** Java or Groovy source with comments replaced by spaces, keeping line breaks and offsets. */
export function withoutComments(content: string): string {
  const parts: string[] = [];
  let kept = 0;
  let index = 0;
  const blank = (end: number) => {
    parts.push(content.slice(kept, index), content.slice(index, end).replace(/[^\n]/g, ' '));
    kept = index = end;
  };
  while (index < content.length) {
    const character = content[index];
    if (character === '/' && content[index + 1] === '/') {
      const end = content.indexOf('\n', index);
      blank(end < 0 ? content.length : end);
    } else if (character === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2);
      blank(end < 0 ? content.length : end + 2);
    } else if (content.startsWith('"""', index) || content.startsWith("'''", index)) {
      const end = content.indexOf(content.slice(index, index + 3), index + 3);
      index = end < 0 ? content.length : end + 3;
    } else if (character === '"' || character === '\'') {
      index++;
      while (index < content.length && content[index] !== character && content[index] !== '\n') index += content[index] === '\\' ? 2 : 1;
      index++;
    } else {
      index++;
    }
  }
  parts.push(content.slice(kept));
  return parts.join('');
}

function stringConstants(content: string): Map<string, string> {
  return new Map([...content.matchAll(STRING_CONSTANT)].map(([, name, value]) => [name, value]));
}

/** The line of each offset, for offsets in increasing order. */
export function lineCounter(content: string): (offset: number) => number {
  let line = 1;
  let counted = 0;
  return offset => {
    for (; counted < offset; counted++) if (content.charCodeAt(counted) === 10) line++;
    return line;
  };
}

/** A string literal, or a string constant (`PATH` or `Paths.PATH`) defined in the same file. */
function pathValue(expression: string, constants: Map<string, string>): string | undefined {
  return /^"((?:[^"\\]|\\.)*)"$/.exec(expression)?.[1] ?? (/^[A-Za-z_][\w.]*$/.test(expression) ? constants.get(expression.split('.').pop()!) : undefined);
}

/** A string literal or an unqualified string constant of the same file, without Spring property placeholders. */
function literalPath(expression: string, constants: Map<string, string>): string | undefined {
  const value = /^"((?:[^"\\]|\\.)*)"$/.exec(expression)?.[1] ?? (/^[A-Za-z_]\w*$/.test(expression) ? constants.get(expression) : undefined);
  return value === undefined || /[$#]\{/.test(value) ? undefined : value;
}

function vertxPath(routePath: string): string {
  return routePath.replace(/:(\w+)/g, '{$1}');
}

function routeRegistrations(file: SourceText, constants: Map<string, string>, collector: RouteCollector): void {
  const calls = new Map<string, Array<{ index: number; call: string }>>();
  for (const match of file.content.matchAll(ROUTE_REGISTRATION_METHOD)) {
    const list = calls.get(match[1]) ?? [];
    calls.set(match[1], list);
    list.push({ index: match.index!, call: match[2] });
  }
  const lineAt = lineCounter(file.content);
  const registrations: Array<{ variable?: string; end: number; line: number; path?: string; methods: string[] }> = [];
  let readUntil = 0;
  for (const start of file.content.matchAll(ROUTE_REGISTRATION_START)) {
    if (start.index! < readUntil) continue;
    const line = lineAt(start.index!);
    ROUTE_REGISTRATION_CALL.lastIndex = start.index!;
    const match = ROUTE_REGISTRATION_CALL.exec(file.content);
    if (!match) {
      collector.unread(file.path, line);
      continue;
    }
    readUntil = ROUTE_REGISTRATION_CALL.lastIndex;
    const chained = /^\s*\.\s*(getMany|get|create|replace|deleteAll|delete)\s*\(/.exec(file.content.slice(readUntil, readUntil + 200))?.[1];
    const variable = chained ? undefined : /(\w+)\s*=\s*$/.exec(file.content.slice(Math.max(0, start.index! - 200), start.index!))?.[1];
    registrations.push({ variable, end: readUntil, line, path: literalPath(match[1].trim(), constants), methods: chained ? [chained] : [] });
  }
  const latest = new Map<string, (typeof registrations)[number]>();
  const events = [
    ...registrations.flatMap(registration => registration.variable ? [{ index: registration.end, variable: registration.variable, registration }] : []),
    ...[...calls].flatMap(([variable, list]) => list.map(call => ({ index: call.index, variable, call: call.call })))
  ].sort((left, right) => left.index - right.index);
  for (const event of events) {
    if ('registration' in event) latest.set(event.variable, event.registration);
    else latest.get(event.variable)?.methods.push(event.call);
  }
  for (const registration of registrations) {
    if (registration.path === undefined || !registration.methods.length) {
      collector.unread(file.path, registration.line);
      continue;
    }
    for (const call of registration.methods) {
      const { method, suffix } = ROUTE_REGISTRATION_ROUTES[call];
      collector.routes.push({ method, path: vertxPath(registration.path) + suffix, file: file.path, line: registration.line });
    }
  }
}

function springMappings(file: SourceText, constants: Map<string, string>, collector: RouteCollector): void {
  const lineAt = lineCounter(file.content);
  let prefixes: string[] | undefined = [''];
  const types = [...file.content.matchAll(TYPE_DECLARATION)].map(match => match[1]);
  const membersReadable = types.length === 1 && (types[0] === 'class' || types[0] === 'enum' || types[0] === 'record');
  for (const start of file.content.matchAll(MAPPING_START)) {
    const line = lineAt(start.index!);
    let end = start.index! + start[0].length;
    MAPPING_ARGUMENTS.lastIndex = end;
    const argumentMatch = MAPPING_ARGUMENTS.exec(file.content);
    if (argumentMatch) {
      end = MAPPING_ARGUMENTS.lastIndex;
    } else if (/^\s*\(/.test(file.content.slice(end, end + 200))) {
      collector.unread(file.path, line);
      continue;
    }
    const mapping = springMapping(start[1], argumentMatch?.[1] ?? '', constants);
    const declaration = declarationAfter(file.content, end);
    if (declaration === 'type') {
      prefixes = mapping?.paths;
      continue;
    }
    if (!mapping || !prefixes || declaration === undefined || !membersReadable) {
      collector.unread(file.path, line);
      continue;
    }
    for (const prefix of prefixes) {
      for (const mappingPath of mapping.paths) {
        for (const method of mapping.methods) collector.routes.push({ method, path: joinPaths(prefix, mappingPath), file: file.path, line });
      }
    }
  }
}

/** The paths and methods of a Spring mapping annotation's arguments, or undefined when one cannot be read. */
function springMapping(kind: string, argumentText: string, constants: Map<string, string>): { paths: string[]; methods: string[] } | undefined {
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (const argument of splitTopLevel(argumentText)) {
    const assignment = /^(\w+)\s*=\s*([\s\S]*)$/.exec(argument);
    if (assignment) named.set(assignment[1], assignment[2].trim());
    else if (argument) positional.push(argument);
  }
  const pathText = positional[0] ?? named.get('value') ?? named.get('path');
  const paths = pathText === undefined ? [''] : listValues(pathText).map(value => literalPath(value, constants)?.replace(/\{(\w+):[^/]*\}(?=\/|$)/g, '{$1}'));
  if (paths.some(value => value === undefined)) return undefined;
  let methods = [kind.toUpperCase()];
  if (kind === 'Request') {
    const methodText = named.get('method');
    methods = methodText === undefined ? ['*'] : listValues(methodText).map(value => /^(?:RequestMethod\s*\.\s*)?([A-Z]+)$/.exec(value)?.[1] ?? '');
    if (methods.some(method => !method)) return undefined;
  }
  return { paths: paths as string[], methods };
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      const end = stringEnd(text, index);
      current += text.slice(index, end);
      index = end - 1;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}') depth--;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/** The values of `{a, b}`, or the value itself. */
function listValues(text: string): string[] {
  const list = /^\{([\s\S]*)\}$/.exec(text.trim());
  return list ? splitTopLevel(list[1]) : [text.trim()];
}

function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
  return index + 1;
}

/**
 * Whether the declaration an annotation ending at `start` belongs to is a type or a member: the text up to the next
 * `{` or `;` outside parentheses and strings names a class, interface, record or enum for a type.
 */
function declarationAfter(content: string, start: number): 'type' | 'member' | undefined {
  let depth = 0;
  let outside = '';
  const end = Math.min(content.length, start + MAPPING_DECLARATION_WINDOW);
  for (let index = start; index < end; index++) {
    const character = content[index];
    if (character === '"') {
      index = stringEnd(content, index) - 1;
    } else if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth--;
    } else if (depth === 0 && (character === '{' || character === ';')) {
      return /\b(?:class|interface|record|enum)\s+\w/.test(outside) ? 'type' : 'member';
    } else if (depth === 0) {
      outside += character;
    }
  }
  return undefined;
}

function joinPaths(prefix: string, routePath: string): string {
  const tail = routePath && !routePath.startsWith('/') ? `/${routePath}` : routePath;
  return `${prefix.replace(/\/+$/, '')}${tail}` || '/';
}

interface GroovyToken {
  type: 'string' | 'word' | 'symbol';
  text: string;
  line: number;
}

function groovyTokens(content: string): GroovyToken[] {
  const tokens: GroovyToken[] = [];
  const lineAt = lineCounter(content);
  let index = 0;
  while (index < content.length) {
    const character = content[index];
    if (/\s/.test(character)) {
      index++;
    } else if (content.startsWith('//', index)) {
      const end = content.indexOf('\n', index);
      index = end < 0 ? content.length : end;
    } else if (content.startsWith('/*', index)) {
      const end = content.indexOf('*/', index + 2);
      index = end < 0 ? content.length : end + 2;
    } else if (content.startsWith('"""', index) || content.startsWith("'''", index)) {
      const end = content.indexOf(content.slice(index, index + 3), index + 3);
      tokens.push({ type: 'string', text: content.slice(index + 3, end < 0 ? content.length : end), line: lineAt(index) });
      index = end < 0 ? content.length : end + 3;
    } else if (character === '"' || character === '\'') {
      let end = index + 1;
      while (end < content.length && content[end] !== character && content[end] !== '\n') end += content[end] === '\\' ? 2 : 1;
      tokens.push({ type: 'string', text: content.slice(index + 1, end), line: lineAt(index) });
      index = end + 1;
    } else if (/[\w$]/.test(character)) {
      let end = index + 1;
      while (end < content.length && /[\w$]/.test(content[end])) end++;
      tokens.push({ type: 'word', text: content.slice(index, end), line: lineAt(index) });
      index = end;
    } else {
      tokens.push({ type: 'symbol', text: character, line: lineAt(index) });
      index++;
    }
  }
  return tokens;
}

/**
 * Grails URL mappings in `static mappings = { ... }`: `"/path"(controller: ..., method: 'GET')`, closure mappings
 * (`'/path' { method = 'GET' }`), `resources:` and `resource:` RESTful mappings with `excludes`, `includes`,
 * `collection { }` and nested mappings, and `group "/prefix", { }`. A path variable `$name` is a parameter, `$name?`
 * is optional. A statement of another form is a route the tool could not read.
 */
function grailsUrlMappings(file: SourceText, collector: RouteCollector): void {
  const tokens = groovyTokens(file.content);
  const is = (index: number, type: GroovyToken['type'], text?: string) => tokens[index]?.type === type && (text === undefined || tokens[index].text === text);
  const opens = (index: number) => is(index, 'symbol') && '([{'.includes(tokens[index].text);
  const unread = (line: number) => collector.unread(file.path, line);

  const closing = (index: number): number => {
    const expected: string[] = [];
    for (let position = index; position < tokens.length; position++) {
      if (opens(position)) {
        expected.push({ '(': ')', '[': ']', '{': '}' }[tokens[position].text]!);
      } else if (is(position, 'symbol', expected[expected.length - 1])) {
        expected.pop();
        if (!expected.length) return position;
      }
    }
    return tokens.length;
  };
  const skip = (index: number) => opens(index) ? closing(index) + 1 : index + 1;
  const statementEnd = (index: number): number => {
    let position = index;
    while (position < tokens.length && !(position > index && tokens[position].line > tokens[index].line) && !is(position, 'symbol', '}')) {
      if (is(position, 'symbol', ';')) return position + 1;
      position = skip(position);
    }
    return position;
  };
  const value = (index: number): { value?: string | string[]; next: number } => {
    if (is(index, 'string')) return { value: tokens[index].text, next: index + 1 };
    if (is(index, 'symbol', '[')) {
      const end = closing(index);
      const items = tokens.slice(index + 1, end).filter((_token, position) => !is(index + 1 + position, 'symbol', ','));
      return { value: items.every(token => token.type === 'string') ? items.map(token => token.text) : undefined, next: end + 1 };
    }
    let position = index;
    while (position < tokens.length && !is(position, 'symbol', ',') && !is(position, 'symbol', ')')) position = skip(position);
    return { next: position };
  };
  const add = (method: string, mappingPath: string, line: number) => {
    const paths = grailsPaths(mappingPath);
    if (!paths) unread(line);
    else for (const routePath of paths) collector.routes.push({ method, path: routePath, file: file.path, line });
  };

  const block = (index: number, prefix: string, depth: number, collectionPrefix?: string): { next: number; method?: string | string[] } => {
    if (depth > MAX_MAPPING_DEPTH) {
      unread(tokens[index - 1].line);
      return { next: closing(index - 1) + 1 };
    }
    let position = index;
    let method: string | string[] | undefined;
    while (position < tokens.length && !is(position, 'symbol', '}')) {
      if (is(position, 'string')) {
        position = mapping(position, prefix, depth);
      } else if (is(position, 'word', 'group') && is(position + 1, 'string') && is(position + 2, 'symbol', ',') && is(position + 3, 'symbol', '{')) {
        position = block(position + 4, joinPaths(prefix, tokens[position + 1].text), depth + 1).next;
      } else if (is(position, 'word', 'collection') && is(position + 1, 'symbol', '{') && collectionPrefix !== undefined) {
        position = block(position + 2, collectionPrefix, depth + 1).next;
      } else if (is(position, 'word') && is(position + 1, 'symbol', '=')) {
        if (tokens[position].text === 'method') method = is(position + 2, 'string') ? tokens[position + 2].text : [];
        position = statementEnd(position);
      } else {
        unread(tokens[position].line);
        position = statementEnd(position);
      }
    }
    return { next: position + 1, method };
  };

  const mapping = (index: number, prefix: string, depth: number): number => {
    const { text, line } = tokens[index];
    const args = new Map<string, string | string[] | undefined>();
    let position = index + 1;
    if (is(position, 'symbol', '(')) {
      const end = closing(position);
      for (position++; position < end; position++) {
        if (is(position, 'word') && is(position + 1, 'symbol', ':')) {
          const read = value(position + 2);
          args.set(tokens[position].text, read.value);
          position = read.next;
        } else {
          position = value(position).next;
        }
      }
      position = end + 1;
    }
    if (!text.startsWith('/')) {
      if (!/^\d{3}$/.test(text)) unread(line);
      return is(position, 'symbol', '{') ? closing(position) + 1 : position;
    }
    const mappingPath = joinPaths(prefix, text);
    const many = args.has('resources');
    if (many || args.has('resource')) {
      const name = args.get(many ? 'resources' : 'resource');
      const excludes = args.get('excludes');
      const includes = args.get('includes');
      if (typeof name !== 'string' || (args.has('excludes') && !Array.isArray(excludes)) || (args.has('includes') && !Array.isArray(includes))) {
        unread(line);
        return is(position, 'symbol', '{') ? closing(position) + 1 : position;
      }
      for (const [action, method, suffix] of many ? GRAILS_RESOURCES_ACTIONS : GRAILS_RESOURCE_ACTIONS) {
        if ((!excludes || !excludes.includes(action)) && (!includes || includes.includes(action))) add(method, mappingPath + suffix, line);
      }
      return is(position, 'symbol', '{') ? block(position + 1, many ? `${mappingPath}/{${name}Id}` : mappingPath, depth + 1, mappingPath).next : position;
    }
    let method = args.has('method') ? args.get('method') ?? [] : undefined;
    if (is(position, 'symbol', '{')) {
      const nested = block(position + 1, mappingPath, depth + 1);
      method ??= nested.method;
      position = nested.next;
    }
    if (method !== undefined && typeof method !== 'string') unread(line);
    else add(method ? method.toUpperCase() : '*', mappingPath, line);
    return position;
  };

  const start = tokens.findIndex((_token, index) => is(index, 'word', 'mappings') && is(index + 1, 'symbol', '=') && is(index + 2, 'symbol', '{'));
  if (start >= 0) block(start + 3, '', 0);
}

/**
 * The paths a Grails mapping path stands for, or undefined when it has a segment the tool does not read: `$controller`,
 * `$action` and `$namespace` select the code that runs, so they are not parameters.
 */
function grailsPaths(mappingPath: string): string[] | undefined {
  let paths = [''];
  for (const segment of mappingPath.split('/').slice(1)) {
    const variable = /^\$(\w+)(\?)?$/.exec(segment);
    if (variable && (['controller', 'action', 'namespace'].includes(variable[1]) || (variable[2] && paths.length >= MAX_OPTIONAL_PATHS))) return undefined;
    if (variable) {
      const withSegment = paths.map(prefix => `${prefix}/{${variable[1]}}`);
      paths = variable[2] ? [...paths, ...withSegment] : withSegment;
    } else if (/^(?:[\w.~-]*|\{\w+\})$/.test(segment)) {
      paths = paths.map(prefix => `${prefix}/${segment}`);
    } else {
      return undefined;
    }
  }
  return paths.map(routePath => routePath || '/');
}
