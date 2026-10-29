import path from 'path';
import YAML from 'yaml';
import { BackendApiOperation, BackendApiSpec, BackendApiSpecGap, BackendApiSpecs, EvaluationRun } from '../types';
import { getBackendEvidence } from './backend-evidence';
import { CommittedSourceSnapshot } from './committed-source';
import { errorMessage, isRecord } from './type-guards';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_REFERENCE_HOPS = 32;
const MAX_SERVER_PATHS = 8;
const MAX_RESOURCE_DEPTH = 64;
// Per spec: references, includes and server paths can multiply a small file into many operations.
const MAX_OPERATIONS = 20_000;
const MAX_RAML_RESOURCES = 20_000;
// A top-level `openapi` or `swagger` key in YAML, or the key anywhere in JSON; parsing decides whether it is top level.
const OPENAPI_HINT = /^["']?(?:openapi|swagger)["']?[ \t]*:|"(?:openapi|swagger)"[ \t]*:/m;
// A RAML root file; fragments such as resource types start with `#%RAML 1.0 ResourceType`.
const RAML_ROOT = /^#%RAML (1\.0|0\.8)[ \t]*(?:\r?\n|$)/;
const RAML_UTIL = /(?:^|\/)raml-util\//;
const RAML_UTIL_RESOURCE_TYPE = /(?:^|\/)raml-util\/rtypes\/([\w-]+)\.raml$/;
const BUILD_FILE = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/;
// Build settings that name API spec inputs: RMB's RAML folders and openapi-generator's input spec.
const SPEC_INPUT = /ramlfiles_path|ramlDirs|inputSpec/;

/**
 * The methods of the resource types in https://github.com/folio-org/raml/tree/f48a63f/rtypes, which FOLIO modules
 * include as the `raml-util` git submodule. The committed source does not contain submodules.
 */
const RAML_UTIL_RESOURCE_TYPES = new Map<string, string[]>([
  ['attachments', ['get', 'post']],
  ['collection', ['get', 'post']],
  ['collection-get', ['get']],
  ['collection-get-with-json-response', ['get']],
  ['collection-stream', ['get']],
  ['collection-with-json-response', ['get', 'post']],
  ['get-delete', ['get', 'delete']],
  ['get-delete-with-json-response', ['get', 'delete']],
  ['get-only', ['get']],
  ['get-only-with-json-response', ['get']],
  ['item-collection', ['get', 'delete', 'put']],
  ['item-collection-get', ['get']],
  ['item-collection-get-with-json-response', ['get']],
  ['item-collection-with-json-response', ['get', 'delete', 'put']],
  ['post-empty-body', ['post']]
])

class RamlInclude {
  constructor(readonly target: string) {}
}

const YAML_OPTIONS = {
  customTags: [{ tag: '!include', resolve: (target: string) => new RamlInclude(target) }],
  uniqueKeys: false,
  maxAliasCount: 100,
  logLevel: 'error' as const
};

interface Node {
  file: string;
  pointer: string;
  value: unknown;
}

type Loaded = { value: unknown } | { error: string };
type Load = (file: string) => Loaded;

/** The API specs in backendEvidence's committed source, parsed once per run. */
export function getBackendApiSpecs(run: EvaluationRun, repoPath: string): Promise<BackendApiSpecs> {
  return run.getOrCreateArtifact('backendApiSpecs', async () => collectBackendApiSpecs((await getBackendEvidence(run, repoPath)).snapshot));
}

function collectBackendApiSpecs(snapshot: CommittedSourceSnapshot): BackendApiSpecs {
  return { specs: specFiles(snapshot), unreadSources: submoduleSpecInputs(snapshot) };
}

function specFiles(snapshot: CommittedSourceSnapshot): BackendApiSpec[] {
  const load = loader(snapshot);
  const specs: BackendApiSpec[] = [];
  for (const file of snapshot.files) {
    if (/\.raml$/i.test(file.path)) {
      const root = RAML_ROOT.exec(file.content.replace(/^\uFEFF/, ''));
      if (root && !RAML_UTIL.test(file.path)) specs.push(ramlSpec(file.path, root[1], load));
      continue;
    }
    if (!/\.(?:ya?ml|json)$/i.test(file.path) || !OPENAPI_HINT.test(file.content)) continue;
    const document = load(file.path);
    if ('error' in document) {
      specs.push({ file: file.path, format: 'openapi', operations: [], gaps: [{ file: file.path, message: `It could not be parsed: ${document.error}` }] });
      continue;
    }
    const value = document.value;
    const version = isRecord(value) ? value.openapi ?? value.swagger : undefined;
    if (typeof version === 'string' || typeof version === 'number') specs.push(openApiSpec(file.path, value as Record<string, unknown>, String(version), load));
  }
  return specs;
}

/**
 * Git submodules the build reads API specs from, such as mod-codex-mux's RAML in `ramls/raml-util/ramls/codex`. The
 * committed source does not contain submodules, so specs there are not read.
 */
function submoduleSpecInputs(snapshot: CommittedSourceSnapshot): BackendApiSpecGap[] {
  const submodules = snapshot.diagnostics.filter(diagnostic => diagnostic.code === 'unsafe-entry' && !diagnostic.material && diagnostic.path)
    .map(diagnostic => diagnostic.path!);
  return snapshot.files.filter(file => BUILD_FILE.test(file.path)).flatMap(file => file.content.split('\n').flatMap((line, index) => {
    const submodule = SPEC_INPUT.test(line) ? submodules.find(candidate => line.includes(candidate)) : undefined;
    return submodule ? [{ file: file.path, reference: submodule, message: `line ${index + 1} reads API specs from the git submodule ${submodule}, which the tool does not read` }] : [];
  }));
}

function loader(snapshot: CommittedSourceSnapshot): Load {
  const files = new Map(snapshot.files.map(file => [file.path, file.content]));
  const cache = new Map<string, Loaded>();
  return file => {
    const cached = cache.get(file);
    if (cached) return cached;
    const content = files.get(file);
    let loaded: Loaded;
    if (content === undefined) {
      const diagnostic = snapshot.diagnostics.find(candidate => candidate.path && (file === candidate.path || file.startsWith(`${candidate.path}/`)));
      loaded = { error: diagnostic ? `${diagnostic.message} (${diagnostic.path})` : 'it is not in the committed source the tool reads' };
    } else {
      try {
        loaded = { value: /\.json$/i.test(file) ? JSON.parse(content) : YAML.parse(content.replace(/^\uFEFF/, ''), YAML_OPTIONS) };
      } catch (error) {
        loaded = { error: errorMessage(error).split('\n')[0] };
      }
    }
    cache.set(file, loaded);
    return loaded;
  };
}

function openApiSpec(file: string, document: Record<string, unknown>, version: string, load: Load): BackendApiSpec {
  const allPrefixes = pathPrefixes(document);
  const prefixes = allPrefixes.slice(0, MAX_SERVER_PATHS);
  const operations: BackendApiOperation[] = [];
  const gaps: BackendApiSpecGap[] = allPrefixes.length > MAX_SERVER_PATHS
    ? [{ file, message: `It has ${allPrefixes.length} server paths; only the first ${MAX_SERVER_PATHS} were read` }]
    : [];
  let paths: Node | undefined;
  const followed = follow({ file, pointer: '/paths', value: document.paths }, load, node => { paths = node; });
  if (followed) {
    gaps.push({ file, ...followed, message: `The paths could not be read: ${followed.message}` });
  } else if (paths && isRecord(paths.value)) {
    const { file: pathsFile, pointer, value } = paths;
    for (const [apiPath, item] of Object.entries(value)) {
      if (!apiPath.startsWith('/')) continue;
      // A method defined at several hops of a $ref chain counts once, as the first definition.
      const defined = new Map<string, Omit<BackendApiOperation, 'path' | 'resource'>>();
      const gap = follow({ file: pathsFile, pointer: `${pointer}/${apiPath.replace(/~/g, '~0').replace(/\//g, '~1')}`, value: item }, load, node => {
        if (!isRecord(node.value)) return;
        for (const method of METHODS) {
          const operation = node.value[method];
          if (operation === undefined || defined.has(method)) continue;
          const tags = isRecord(operation) && Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === 'string') : undefined;
          const operationId = isRecord(operation) && typeof operation.operationId === 'string' ? operation.operationId : undefined;
          defined.set(method, { method: method.toUpperCase(), file: node.file, ...(tags ? { tags } : {}), ...(operationId ? { operationId } : {}) });
        }
      });
      if (operations.length + defined.size * prefixes.length > MAX_OPERATIONS) {
        gaps.push({ file, message: `It has more than ${MAX_OPERATIONS} operations; the rest were not read` });
        break;
      }
      for (const prefix of prefixes) for (const operation of defined.values()) operations.push({ ...operation, path: prefix + apiPath, resource: apiPath });
      if (gap) gaps.push(...prefixes.map(prefix => ({ file: pathsFile, apiPath: prefix + apiPath, ...gap })));
    }
  }
  return { file, format: 'openapi', version, operations, gaps };
}

/**
 * The path prefixes a spec's paths are relative to: Swagger 2.0's `basePath`, or the path of each OpenAPI 3 server URL,
 * such as `/data-export` for `url: /data-export/`. A server URL that is only a host adds no prefix.
 */
function pathPrefixes(document: Record<string, unknown>): string[] {
  const trim = (value: string) => value.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (document.swagger !== undefined) return [typeof document.basePath === 'string' ? trim(document.basePath) : ''];
  const servers = Array.isArray(document.servers) ? document.servers.filter(isRecord).map(server => server.url).filter((url): url is string => typeof url === 'string') : [];
  const prefixes = servers.map(url => trim(url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''))).map(prefix => prefix.startsWith('/') ? prefix : '');
  return prefixes.length ? [...new Set(prefixes)] : [''];
}

/**
 * Visits a value and each value its `$ref` chain leads to, inside the snapshot. Returns why the chain stops early:
 * a reference that cannot be followed, a cycle, or more than MAX_REFERENCE_HOPS references in a row.
 */
function follow(start: Node, load: Load, visit: (node: Node) => void): { reference: string; message: string } | undefined {
  const seen = new Set<string>();
  let node = start;
  for (let hop = 0; ; hop++) {
    visit(node);
    const reference = isRecord(node.value) ? node.value.$ref : undefined;
    if (typeof reference !== 'string') return undefined;
    if (hop === MAX_REFERENCE_HOPS) return { reference, message: `more than ${MAX_REFERENCE_HOPS} references in a row` };
    seen.add(`${node.file}#${node.pointer}`);
    const next = resolve(reference, node.file, load);
    if (typeof next === 'string') return { reference, message: next };
    if (seen.has(`${next.file}#${next.pointer}`)) return { reference, message: 'the references form a cycle' };
    node = next;
  }
}

/** A `$ref` or RAML `!include` target, relative to the file it is in; a URL or a path outside the repository is not followed. */
function resolve(reference: string, from: string, load: Load): Node | string {
  const hash = reference.indexOf('#');
  const target = hash < 0 ? reference : reference.slice(0, hash);
  const fragment = hash < 0 ? '' : decode(reference.slice(hash + 1));
  let file = from;
  if (target) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) return 'it points outside the repository';
    file = path.posix.normalize(path.posix.join(path.posix.dirname(from), decode(target)));
    if (file === '..' || file.startsWith('../')) return 'it points outside the repository';
  }
  const document = load(file);
  if ('error' in document) return `${file} could not be read: ${document.error}`;
  if (fragment && !fragment.startsWith('/')) return `${fragment} is not a JSON pointer`;
  let value = document.value;
  for (const token of fragment ? fragment.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')) : []) {
    if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, token)) {
      value = value[token];
    } else if (Array.isArray(value) && /^\d+$/.test(token) && Number(token) < value.length) {
      value = value[Number(token)];
    } else {
      return `${file} has nothing at ${fragment}`;
    }
  }
  return { file, pointer: fragment, value };
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function ramlSpec(file: string, version: string, load: Load): BackendApiSpec {
  const document = load(file);
  if ('error' in document) return { file, format: 'raml', version, operations: [], gaps: [{ file, message: `It could not be parsed: ${document.error}` }] };
  const root = isRecord(document.value) ? document.value : {};
  const declared = new Map<string, unknown>((Array.isArray(root.resourceTypes) ? root.resourceTypes.filter(isRecord) : isRecord(root.resourceTypes) ? [root.resourceTypes] : [])
    .flatMap(types => Object.entries(types)));
  const operations: BackendApiOperation[] = [];
  const gaps: BackendApiSpecGap[] = [];
  const typeMethods = new Map<string, string[] | { reference?: string; message: string }>();

  const resourceTypeMethods = (name: string) => {
    if (!typeMethods.has(name)) typeMethods.set(name, readResourceType(name, declared.get(name), file, load));
    return typeMethods.get(name)!;
  };

  // YAML aliases can make a resource contain itself, and includes can repeat a file at every level.
  const ancestors = new Set<unknown>();
  let resources = 0;
  let truncated = false;
  const walk = (node: Record<string, unknown>, nodeFile: string, prefix: string, depth: number, topResource?: string) => {
    for (const [key, raw] of Object.entries(node)) {
      if (!key.startsWith('/') || truncated) continue;
      if (++resources > MAX_RAML_RESOURCES || operations.length > MAX_OPERATIONS) {
        truncated = true;
        gaps.push({ file, message: `It has more than ${MAX_RAML_RESOURCES} resources or ${MAX_OPERATIONS} operations; the rest were not read` });
        continue;
      }
      const apiPath = prefix + key;
      let resource = raw;
      let resourceFile = nodeFile;
      if (raw instanceof RamlInclude) {
        const included = resolve(raw.target, nodeFile, load);
        if (typeof included === 'string') {
          gaps.push({ file: nodeFile, apiPath, reference: raw.target, message: included });
          continue;
        }
        resource = included.value;
        resourceFile = included.file;
      }
      if (!isRecord(resource) || resource instanceof RamlInclude) continue;
      if (ancestors.has(resource) || depth === MAX_RESOURCE_DEPTH) {
        // Either way the resources below are endless or unread, so any path may be documented there.
        gaps.push({ file: resourceFile, message: ancestors.has(resource) ? `the resource ${apiPath} contains itself` : `resources are nested more than ${MAX_RESOURCE_DEPTH} deep at ${apiPath}` });
        continue;
      }
      ancestors.add(resource);
      const methods = new Set(METHODS.filter(method => resource[method] !== undefined));
      if (resource.type !== undefined) {
        const typeName = typeof resource.type === 'string' ? resource.type : isRecord(resource.type) ? Object.keys(resource.type)[0] : undefined;
        const fromType = typeName === undefined ? { message: 'its resource type is not named' } : resourceTypeMethods(typeName);
        if (Array.isArray(fromType)) fromType.forEach(method => methods.add(method));
        else gaps.push({ file: resourceFile, apiPath, reference: fromType.reference ?? typeName, message: fromType.message });
      }
      for (const method of methods) operations.push({ method: method.toUpperCase(), path: apiPath, file: resourceFile, resource: topResource ?? key });
      walk(resource, resourceFile, apiPath, depth + 1, topResource ?? key);
      ancestors.delete(resource);
    }
  };
  walk(root, file, '', 0);
  return { file, format: 'raml', version, operations, gaps };
}

/** The methods a RAML resource type defines; optional ones (`get?`) apply only where the resource defines them itself. */
function readResourceType(name: string, declared: unknown, file: string, load: Load): string[] | { reference?: string; message: string } {
  if (declared === undefined) return { message: `the resource type ${name} is not declared in ${file}` };
  let value: unknown = declared;
  if (declared instanceof RamlInclude) {
    const included = resolve(declared.target, file, load);
    if (typeof included === 'string') {
      const shared = RAML_UTIL_RESOURCE_TYPE.exec(path.posix.join(path.posix.dirname(file), declared.target));
      const methods = shared ? RAML_UTIL_RESOURCE_TYPES.get(shared[1]) : undefined;
      if (methods) return methods;
      return { reference: declared.target, message: included };
    }
    value = included.value;
  }
  const type = value;
  if (!isRecord(type) || type instanceof RamlInclude) return { message: `the resource type ${name} could not be read` };
  return METHODS.filter(method => type[method] !== undefined);
}
