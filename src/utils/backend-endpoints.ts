import { BackendEvidence } from '../types';
import { providedInterfaces } from './descriptor-handlers';
import { escapeRegExp } from './regexp';

/** Libraries that serve endpoints for the module; the library's own spec documents them. */
const ENDPOINT_LIBRARIES = [
  // https://github.com/folio-org/folio-custom-fields/tree/master/ramls
  { artifactId: 'folio-custom-fields', path: /^\/custom-fields(?:\/|$)/ }
];

/** A method on a path; method `*` stands for every method. */
export interface PathItem {
  method: string;
  path: string;
}

/** A provided endpoint from a descriptor handler. */
export interface HandlerEndpoint extends PathItem {
  interfaceId: string;
}

export interface EndpointMatcher<T extends PathItem = PathItem> {
  endpoint: T;
  /** The normalized path's segments, or for a path with Okapi's `*`, a matcher of normalized paths. */
  segments: string[];
  wildcard?: (normalizedPath: string) => boolean;
}

interface TrieNode<T> {
  literal: Map<string, TrieNode<T>>;
  param?: TrieNode<T>;
  /** Method → the items that end here. */
  items: Map<string, T[]>;
}

/** Items indexed by normalized path, for looking up the items that serve or document an endpoint. */
export interface PathIndex<T extends PathItem> {
  root: TrieNode<T>;
  entries: Array<{ item: T; path: string }>;
}

/** The libraries in the repository's build files that serve endpoints for the module, with the build file naming each. */
export function endpointLibraries(evidence: BackendEvidence): Array<{ artifactId: string; path: RegExp; buildFile: string }> {
  return ENDPOINT_LIBRARIES.flatMap(library => {
    const buildFile = evidence.snapshot.files.find(file => /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(file.path)
      && new RegExp(`\\b${escapeRegExp(library.artifactId)}\\b`).test(file.content));
    return buildFile ? [{ ...library, buildFile: buildFile.path }] : [];
  });
}

/** Each method and path of the descriptor's handlers, once each; system interfaces' only when asked for. */
export function descriptorEndpoints(descriptor: unknown, includeSystem = false): HandlerEndpoint[] {
  return uniqueEndpoints(providedInterfaces(descriptor, includeSystem).flatMap(provided => provided.handlers.flatMap(handler => {
    // Okapi matches a legacy `path` as a prefix.
    const pathPattern = handler.pathPattern ?? (typeof handler.path === 'string' ? `${handler.path}*` : undefined);
    return pathPattern ? handler.methods.map(method => ({ method: method.toUpperCase(), path: pathPattern, interfaceId: provided.id })) : [];
  })));
}

export function uniqueEndpoints<T extends PathItem>(endpoints: T[]): T[] {
  const seen = new Set<string>();
  return endpoints.filter(endpoint => {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Parameters match whatever their names: `{id}` and `{noteId}` are both `{}`.
function normalize(apiPath: string): string {
  return apiPath.replace(/\{[^{}/]*\}/g, '{}').replace(/(.)\/+$/, '$1');
}

export function endpointMatcher<T extends PathItem>(endpoint: T): EndpointMatcher<T> {
  const segments = normalize(endpoint.path).split('/');
  return endpoint.path.includes('*') ? { endpoint, segments, wildcard: wildcardMatcher(endpoint.path) } : { endpoint, segments };
}

export function pathIndex<T extends PathItem>(items: T[]): PathIndex<T> {
  const node = (): TrieNode<T> => ({ literal: new Map(), items: new Map() });
  const root = node();
  const entries: PathIndex<T>['entries'] = [];
  for (const item of items) {
    const itemPath = normalize(item.path);
    let current = root;
    for (const segment of itemPath.split('/')) {
      if (segment === '{}') {
        current = current.param ??= node();
      } else {
        const child = current.literal.get(segment) ?? node();
        current.literal.set(segment, child);
        current = child;
      }
    }
    const atNode = current.items.get(item.method) ?? [];
    current.items.set(item.method, atNode);
    atNode.push(item);
    entries.push({ item, path: itemPath });
  }
  return { root, entries };
}

/**
 * The items that serve or document an endpoint, and, when none does, those that cover its path only with fixed values
 * where the endpoint has a parameter (`/erm/jobs/packageImport` for `/erm/jobs/{type}`). An item's parameter covers
 * any value of its segment. A wildcard endpoint is matched by any item path it covers. Each lookup visits each index
 * node at most once; with a budget, each visit spends one, and a lookup that finds it spent returns what it has found.
 */
export function lookup<T extends PathItem>(index: PathIndex<T>, matcher: EndpointMatcher, budget?: { visits: number }): { documented: T[]; partial: T[] } {
  const { method } = matcher.endpoint;
  const methodMatches = (candidate: string) => method === '*' || candidate === '*' || candidate === method;
  if (matcher.wildcard) {
    return { documented: index.entries.filter(entry => methodMatches(entry.item.method) && matcher.wildcard!(entry.path)).map(entry => entry.item), partial: [] };
  }
  const segments = matcher.segments;
  const collect = (node: TrieNode<T>, position: number, fixedValues: boolean, found: T[]): T[] => {
    if (budget && --budget.visits < 0) return found;
    if (position === segments.length) {
      for (const [candidate, items] of node.items) if (methodMatches(candidate)) found.push(...items);
      return found;
    }
    if (node.param) collect(node.param, position + 1, fixedValues, found);
    if (segments[position] !== '{}') {
      const child = node.literal.get(segments[position]);
      if (child) collect(child, position + 1, fixedValues, found);
    } else if (fixedValues) {
      for (const child of node.literal.values()) collect(child, position + 1, fixedValues, found);
    }
    return found;
  };
  const documented = collect(index.root, 0, false, []);
  return { documented, partial: documented.length ? [] : collect(index.root, 0, true, []) };
}

/** Whether a path the tool could not fully read may be the endpoint's path. */
export function gapCovers(matcher: EndpointMatcher, apiPath: string): boolean {
  const specPath = normalize(apiPath);
  if (matcher.wildcard) return matcher.wildcard(specPath);
  const specSegments = specPath.split('/');
  return specSegments.length === matcher.segments.length
    && specSegments.every((segment, index) => segment === matcher.segments[index] || segment === '{}' || matcher.segments[index] === '{}');
}

/**
 * Okapi's `*` matches any text, slashes included, and `{name}` one or more characters other than `/`. Matches a
 * normalized path in time proportional to the pattern's length times the path's, without backtracking.
 */
function wildcardMatcher(pattern: string): (normalizedPath: string) => boolean {
  const tokens = pattern.split(/(\*|\{[^{}/]*\})/).flatMap((part): Array<'*' | '{}' | { character: string }> =>
    part === '*' ? ['*'] : /^\{.*\}$/.test(part) ? ['{}'] : [...part].map(character => ({ character })));
  const literalPrefix = pattern.split(/[*{]/)[0];
  return specPath => {
    if (!specPath.startsWith(literalPrefix)) return false;
    let reachable = new Uint8Array(specPath.length + 1);
    let next = new Uint8Array(specPath.length + 1);
    reachable[0] = 1;
    for (const token of tokens) {
      next.fill(0);
      if (token === '*') {
        for (let position = 0, open = false; position <= specPath.length; position++) {
          open ||= reachable[position] === 1;
          if (open) next[position] = 1;
        }
      } else if (token === '{}') {
        for (let position = 1, open = false; position <= specPath.length; position++) {
          if (specPath[position - 1] === '/') {
            open = false;
            continue;
          }
          open ||= reachable[position - 1] === 1;
          if (open) next[position] = 1;
        }
      } else {
        for (let position = 0; position < specPath.length; position++) {
          if (reachable[position] && specPath[position] === token.character) next[position + 1] = 1;
        }
      }
      [reachable, next] = [next, reachable];
    }
    return reachable[specPath.length] === 1;
  };
}
