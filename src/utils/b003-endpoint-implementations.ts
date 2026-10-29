import {
  B003Analysis,
  B003Basis,
  B003Endpoint,
  B003Implementation,
  BackendApiOperation,
  BackendApiSpec,
  BackendApiSpecs,
  BackendEvidence,
  EvaluationStatus,
  FrontendChecklistItem
} from '../types';
import { FRAMEWORK_LABELS } from './b001-descriptor-template';
import { descriptorEndpoints, endpointLibraries, endpointMatcher, gapCovers, lookup, pathIndex, PathItem, uniqueEndpoints } from './backend-endpoints';
import { SOURCE_FILE } from './backend-evidence';
import { lineCounter, sourceRoutes, withoutComments } from './backend-routes';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { count, listText, overflowLine, reportPath, reportText, unique } from './report-text';

const MAX_ROWS = 20;
const IMPLEMENTS = /\bimplements\b([^{;]{0,2000})/g;
const BUILD_FILE = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/;
// openapi-generator's `useTags` option, in a Maven <configOptions> or a Gradle configOptions map.
const USE_TAGS = /<useTags>\s*true\s*<\/useTags>|["']?useTags["']?\s*[:=]\s*["']?true\b/;
// Without it, openapi-generator gives every operation a default method that answers 501 Not Implemented.
const SKIP_DEFAULT_INTERFACE = /<skipDefaultInterface>\s*true\s*<\/skipDefaultInterface>|["']?skipDefaultInterface["']?\s*[:=]\s*["']?true\b/;
// RMB looks for the classes that implement its generated interfaces in this package only:
// https://github.com/folio-org/raml-module-builder#implement-the-interfaces
const RMB_IMPLEMENTATION = /(?:^|\/)org\/folio\/rest\/impl\//;
const CALLABLE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

type Entry = { method: string; path: string; file: string; operation: BackendApiOperation; format: BackendApiSpec['format'] };
type Endpoint = PathItem & { interfaceId?: string; specFile?: string };

/**
 * B003 (executable implementations of all provided endpoints) looks for the implementation of every endpoint in the
 * descriptor template's handlers, without system interfaces. An RMB or Spring module's endpoints come from its API
 * spec: the build generates an interface for each RAML top-level resource or OpenAPI tag, so an endpoint is
 * implemented when it is in the spec and a committed class implements that interface. Any module's endpoint is also
 * implemented when a route registered in the source serves it. An edge module's endpoints also include the
 * operations of its own API specs.
 */
export function evaluateB003(evidence: BackendEvidence, apiSpecs: BackendApiSpecs): B003Analysis {
  const { kind, framework, template } = evidence;
  const sourceDiagnostics = evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const gaps = [...apiSpecs.specs.flatMap(spec => spec.gaps), ...apiSpecs.unreadSources];
  const base = { criterionId: 'B003' as const, kind, framework, endpoints: [], routeCount: 0, unreadRoutes: [], unreadRouteCount: 0, gaps, sourceDiagnostics };
  const result = (status: EvaluationStatus, basis: B003Basis, summary: string, items: FrontendChecklistItem[], extra: Partial<B003Analysis> = {}): B003Analysis =>
    ({ ...base, ...extra, status, basis, summary: `B003 ${status}: ${summary}`, checklist: frontendChecklist(status, items) });
  const checklistItem = (startingPoints: FrontendChecklistItem['startingPoints']): FrontendChecklistItem => ({
    id: 'B003-C1',
    title: 'Each endpoint the tool could not match has an implementation that serves its methods.',
    startingPoints,
    reviewerOnly: true,
    obligations: []
  });

  if (kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'library', 'The repository is a shared library, which provides no endpoints of its own.', []);
  }
  if (!template?.descriptor) {
    return result(EvaluationStatus.MANUAL, 'no-descriptor',
      `${kind === 'ambiguous' ? 'No module descriptor template was found' : 'The module descriptor template could not be read'}, so the module's endpoints are not known (see B001).`,
      [checklistItem([])]);
  }

  const handlers: Endpoint[] = descriptorEndpoints(template.descriptor);
  const specEndpoints: Endpoint[] = kind === 'edge-module'
    ? apiSpecs.specs.flatMap(spec => spec.operations.map(operation => ({ method: operation.method, path: operation.path, specFile: spec.file })))
    : [];
  const matchers = uniqueEndpoints([...handlers, ...specEndpoints]).map(endpointMatcher);
  const endpointSource = kind === 'edge-module'
    ? `handlers in ${template.path}, without system interfaces, and the operations of the edge module's API specs`
    : `handlers in ${template.path}, without system interfaces`;
  if (!matchers.length) {
    return result(EvaluationStatus.NOT_APPLICABLE, 'no-endpoints', kind === 'edge-module'
      ? `${reportPath(template.path)} provides no endpoints other than system interfaces, and no API spec documents any.`
      : `${reportPath(template.path)} provides no endpoints other than system interfaces.`, [], { endpointSource });
  }

  const sources = new Map(evidence.snapshot.files.filter(file => SOURCE_FILE.test(file.path)).map(file => [file.path, withoutComments(file.content)]));
  const scan = sourceRoutes(evidence.snapshot.files);
  const routeIndex = pathIndex(scan.routes.filter(route => !route.path.includes('*')));
  const specIndex = pathIndex(apiSpecs.specs.flatMap(spec => spec.operations.map((operation): Entry =>
    ({ method: operation.method, path: operation.path, file: spec.file, operation, format: spec.format }))));
  const implementations = implementedInterfaces(sources);
  const buildSets = (option: RegExp) => evidence.snapshot.files.some(file => BUILD_FILE.test(file.path) && option.test(file.content));
  const useTags = buildSets(USE_TAGS);
  const defaultMethods = framework.name === 'spring' && !buildSets(SKIP_DEFAULT_INTERFACE);
  const generated = generatedInterfaces(framework.name, useTags);
  const callables = new Map<string, Set<string>>();
  const declares = (file: string, name: string) => {
    if (!callables.has(file)) callables.set(file, new Set([...sources.get(file)!.matchAll(CALLABLE)].map(match => match[1])));
    return callables.get(file)!.has(name);
  };
  const implementing = (entry: Entry) => generated(entry).flatMap(name => (implementations.get(name) ?? []).filter(implementation =>
    (framework.name !== 'rmb' || RMB_IMPLEMENTATION.test(implementation.file))
    && (!defaultMethods || (entry.operation.operationId !== undefined && declares(implementation.file, entry.operation.operationId)))));
  const reasons = new Map<B003Endpoint, string[]>();
  const libraries = endpointLibraries(evidence);
  const unreadSpecFiles = apiSpecs.unreadSources.map(gap => gap.file);

  const endpoints = matchers.map((matcher): B003Endpoint => {
    const { method, path: endpointPath, interfaceId, specFile } = matcher.endpoint;
    const found = (implementation: B003Implementation, specFiles: string[], extra: Partial<B003Endpoint> = {}): B003Endpoint =>
      ({ method, path: endpointPath, ...(interfaceId ? { interfaceId } : {}), implementation, specFiles, ...extra });
    const location = (item: { file: string; line: number }) => ({ file: item.file, line: item.line });

    if (matcher.wildcard) return found('wildcard', []);
    const spec = lookup(specIndex, matcher);
    const specFiles = unique([...(specFile ? [specFile] : []), ...spec.documented.map(entry => entry.file)]);
    const names = unique(spec.documented.flatMap(generated));
    const classes = [...new Map(spec.documented.flatMap(implementing).map(implementation => [`${implementation.file}:${implementation.line}`, implementation])).values()];
    if (classes.length) return found('interface', specFiles, { generatedInterfaces: names, implementedBy: classes });
    const routes = lookup(routeIndex, matcher);
    if (routes.documented.length) return found('route', specFiles, { implementedBy: routes.documented.map(location) });
    if (names.length) return found('no-implementing-class', specFiles, { generatedInterfaces: names });
    const library = libraries.find(candidate => candidate.path.test(endpointPath));
    if (library) return found('library', specFiles, { library: library.artifactId });
    if (spec.partial.length || (routes.partial.length && !scan.unreadRouteCount)) {
      return found('partial', unique(spec.partial.map(entry => entry.file)), routes.partial.length ? { implementedBy: routes.partial.map(location) } : {});
    }
    const withGaps = apiSpecs.specs.filter(candidate => candidate.gaps.some(gap => gap.apiPath === undefined || gapCovers(matcher, gap.apiPath))).map(candidate => candidate.file);
    const why = [
      ...(withGaps.length ? ['part of an API spec could not be read'] : []),
      ...(unreadSpecFiles.length ? ['the build reads API specs from a git submodule the tool does not read'] : []),
      ...(scan.unreadRouteCount ? [`the tool could not read ${count(scan.unreadRouteCount, 'route')} in the source`] : []),
      ...(sourceDiagnostics.length ? ['the committed source was not read completely'] : [])
    ];
    if (!why.length) return found('not-found', specFiles);
    const unconfirmed = found('unconfirmed', unique([...withGaps, ...unreadSpecFiles]));
    reasons.set(unconfirmed, why);
    return unconfirmed;
  });

  const of = (implementation: B003Implementation) => endpoints.filter(endpoint => endpoint.implementation === implementation);
  const [viaInterface, viaRoute, noClass, wildcards, fromLibrary, partial, unconfirmed, notFound] =
    (['interface', 'route', 'no-implementing-class', 'wildcard', 'library', 'partial', 'unconfirmed', 'not-found'] as const).map(of);
  const unspecified = notFound.filter(endpoint => !endpoint.specFiles.length);
  const unrouted = notFound.filter(endpoint => endpoint.specFiles.length);
  const specDriven = framework.name === 'rmb' || framework.name === 'spring';
  const total = endpoints.length;
  const where = kind === 'edge-module' ? 'the edge module provides or documents' : 'in the module descriptor';
  const share = (part: number) => part === total ? (total === 1 ? `The endpoint ${where}` : `All ${total} endpoints ${where}`) : `${part} of the ${total} endpoints ${where}`;
  const verb = (part: number) => part === 1 ? 'is' : 'are';
  const labels = (list: B003Endpoint[]) => listText(list.map(endpointLabel));

  const sentences: string[] = [];
  if (unspecified.length) {
    sentences.push(`${share(unspecified.length)} ${verb(unspecified.length)} in no API spec, and no route in the source serves ${unspecified.length === 1 ? 'it' : 'them'}: ${labels(unspecified)}.`);
    if (specDriven) sentences.push(`A ${FRAMEWORK_LABELS[framework.name]} module serves only the endpoints its API spec generates${framework.name === 'spring' ? ' or its mapping annotations declare' : ''}, so ${unspecified.length === 1 ? 'it has' : 'they have'} no implementation.`);
  }
  if (noClass.length) {
    sentences.push(`${share(noClass.length)} ${verb(noClass.length)} in an API spec, but the tool found no committed class that implements ${noClass.length === 1 ? 'it' : 'them'} through the interface the build generates: ${labels(noClass)}.`);
  }
  if (unrouted.length) {
    sentences.push(`${share(unrouted.length)} ${verb(unrouted.length)} in an API spec, but no route in the source serves ${unrouted.length === 1 ? 'it' : 'them'}: ${labels(unrouted)}.`);
  }
  if (wildcards.length) {
    sentences.push(`${share(wildcards.length)} ${wildcards.length === 1 ? 'has a wildcard path' : 'have wildcard paths'}, which the tool cannot match to an implementation: ${labels(wildcards)}.`);
  }
  if (fromLibrary.length) {
    const names = unique(fromLibrary.map(endpoint => endpoint.library!));
    sentences.push(`${share(fromLibrary.length)} ${fromLibrary.length === 1 ? 'comes' : 'come'} from ${listText(names)}, which implements ${fromLibrary.length === 1 ? 'it' : 'them'}: ${labels(fromLibrary)}.`);
  }
  if (partial.length) {
    sentences.push(`${share(partial.length)} ${verb(partial.length)} found only for fixed values of a path parameter: ${labels(partial)}.`);
  }
  if (unconfirmed.length) {
    const why = unique(unconfirmed.flatMap(endpoint => reasons.get(endpoint)!));
    sentences.push(`${share(unconfirmed.length)} could not be checked, because ${listText(why)}: ${labels(unconfirmed)}.`);
  }

  const fails = specDriven && unspecified.length > 0;
  const toReview = total - viaInterface.length - viaRoute.length;
  const status = fails ? EvaluationStatus.FAIL : toReview ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  if (status === EvaluationStatus.MANUAL) sentences.push(`A reviewer must check ${toReview === 1 ? 'it' : 'them'}.`);
  if (status === EvaluationStatus.PASS) {
    const generator = framework.name === 'rmb' ? 'RMB generates from the RAML' : 'openapi-generator generates from the OpenAPI spec';
    sentences.push(!viaRoute.length
      ? `${share(total)} ${verb(total)} in the API spec, and a committed class implements the interface ${generator} for ${total === 1 ? 'it' : 'each'}.`
      : !viaInterface.length
        ? `${share(total)} ${verb(total)} served by routes registered in the source.`
        : `${share(total)} ${verb(total)} implemented: ${viaInterface.length} by committed classes that implement the interfaces ${generator}, and ${viaRoute.length} by routes registered in the source.`);
  }

  const startingPoints: FrontendChecklistItem['startingPoints'] = [];
  const point = (endpoint: B003Endpoint, path: string, note: string, line?: number) =>
    startingPoints.push({ path, ...(line ? { line } : {}), note: `${endpoint.method} ${endpoint.path}: ${note}` });
  for (const endpoint of unspecified) point(endpoint, template.path, 'in no API spec and no route');
  for (const endpoint of noClass) point(endpoint, endpoint.specFiles[0], `no committed class implements it through ${listText(endpoint.generatedInterfaces!)}`);
  for (const endpoint of unrouted) point(endpoint, endpoint.specFiles[0], 'no route in the source serves it');
  for (const endpoint of wildcards) point(endpoint, template.path, 'a wildcard path');
  for (const endpoint of fromLibrary) point(endpoint, libraries.find(library => library.artifactId === endpoint.library)!.buildFile, `served by ${endpoint.library}`);
  for (const endpoint of partial) {
    const at = endpoint.implementedBy?.[0];
    point(endpoint, endpoint.specFiles[0] ?? at!.file, 'found only for fixed values of a path parameter', endpoint.specFiles.length ? undefined : at!.line);
  }
  for (const endpoint of unconfirmed) point(endpoint, endpoint.specFiles[0] ?? template.path, 'could not be checked');
  if (unconfirmed.length) startingPoints.push(...scan.unreadRoutes.map(route => ({ path: route.file, line: route.line, note: 'route whose path the tool could not read' })));

  return result(status, 'endpoints-checked', sentences.join(' '), startingPoints.length ? [checklistItem(startingPoints)] : [], {
    endpointSource,
    implementationSource: implementationSource(framework.name, useTags, defaultMethods),
    endpoints,
    routeCount: scan.routes.length,
    unreadRoutes: scan.unreadRoutes,
    unreadRouteCount: scan.unreadRouteCount
  });
}

export function renderB003HumanDetails(analysis: B003Analysis): string {
  const lines = [`Framework: ${FRAMEWORK_LABELS[analysis.framework.name]}`];
  if (analysis.endpointSource) lines.push(`Endpoints: ${analysis.endpoints.length} methods and paths from ${reportText(analysis.endpointSource)}`);
  if (analysis.implementationSource) lines.push(`Implementations: ${reportText(analysis.implementationSource)}`, `Routes found in the source: ${analysis.routeCount}`);
  const section = (heading: string, list: B003Endpoint[], describe: (endpoint: B003Endpoint) => string = () => '') => {
    if (!list.length) return;
    lines.push(`${heading}:`, ...list.slice(0, MAX_ROWS).map(endpoint => `  - ${endpointLabel(endpoint)}${endpoint.interfaceId ? ` (interface ${reportText(endpoint.interfaceId)})` : ''}${describe(endpoint)}`),
      ...overflowLine(list.length, MAX_ROWS, '  '));
  };
  const of = (implementation: B003Implementation) => analysis.endpoints.filter(endpoint => endpoint.implementation === implementation);
  const files = (endpoint: B003Endpoint) => listText(endpoint.specFiles.map(reportPath));
  const notFound = of('not-found');
  section('In no API spec and served by no route', notFound.filter(endpoint => !endpoint.specFiles.length));
  section('In an API spec, but no committed class implements it through its generated interface', of('no-implementing-class'),
    endpoint => ` — ${listText(endpoint.generatedInterfaces!.map(reportText))} in ${files(endpoint)}`);
  section('In an API spec, but served by no route', notFound.filter(endpoint => endpoint.specFiles.length), endpoint => ` — ${files(endpoint)}`);
  section('Wildcard paths', of('wildcard'));
  section('From a library', of('library'), endpoint => ` — ${reportText(endpoint.library ?? '')}`);
  section('Found only for fixed values of a path parameter', of('partial'), endpoint => endpoint.specFiles.length
    ? ` — ${files(endpoint)}`
    : ` — ${listText(endpoint.implementedBy!.map(route => `${reportPath(route.file)}:${route.line}`))}`);
  section('Could not be checked', of('unconfirmed'), endpoint => endpoint.specFiles.length ? ` — ${files(endpoint)} may have it` : '');
  const viaInterface = of('interface').length;
  const viaRoute = of('route').length;
  if (viaInterface + viaRoute) {
    lines.push(`Implemented: ${viaInterface + viaRoute}${viaInterface && viaRoute
      ? ` (${viaInterface} by classes implementing generated interfaces, ${viaRoute} by routes)`
      : viaInterface ? ' by classes implementing generated interfaces' : ' by routes'}`);
  }
  if (analysis.gaps.length) {
    lines.push('API spec parts the tool could not read:', ...analysis.gaps.slice(0, MAX_ROWS).map(gap =>
      `  - ${reportPath(gap.file)}${gap.apiPath ? ` ${reportText(gap.apiPath)}` : ''}${gap.reference ? ` (${reportText(gap.reference)})` : ''} — ${reportText(gap.message)}`),
    ...overflowLine(analysis.gaps.length, MAX_ROWS, '  '));
  }
  if (analysis.unreadRouteCount) {
    lines.push('Routes the tool could not read:', ...analysis.unreadRoutes.slice(0, MAX_ROWS).map(route => `  - ${reportPath(route.file)}:${route.line}`),
      ...overflowLine(analysis.unreadRouteCount, MAX_ROWS, '  '));
  }
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    lines.push('What to do:', '  - Implement each endpoint listed under "In no API spec and served by no route", or remove its handler from the module descriptor.');
  }
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  return lines.join('\n');
}

function endpointLabel(endpoint: B003Endpoint): string {
  return `${reportText(endpoint.method)} ${reportText(endpoint.path)}`;
}

function implementationSource(framework: BackendEvidence['framework']['name'], useTags: boolean, defaultMethods: boolean): string {
  const routes = 'routes registered in the source (Vert.x router, RouteRegistration, Spring mapping annotations, Grails URL mappings)';
  if (framework === 'rmb') {
    return `committed classes in org.folio.rest.impl that implement the interface RMB generates for each top-level RAML resource (for example, LoanStorage for /loan-storage), or ${routes}`;
  }
  if (framework === 'spring') {
    return `committed classes that implement the interface openapi-generator generates for each OpenAPI ${useTags
      ? 'tag, as a build file sets useTags (for example, NotesApi for the tag notes)'
      : 'first path segment (for example, NotesApi for /notes/{id})'}${defaultMethods
      ? ' and declare the operation\'s method, as its default method answers 501 (skipDefaultInterface is not set)'
      : ''}, or ${routes}`;
  }
  return routes;
}

/** The names of the interfaces the framework's build generates for a spec operation; none when it generates none. */
function generatedInterfaces(framework: BackendEvidence['framework']['name'], useTags: boolean): (entry: Entry) => string[] {
  if (framework === 'rmb') return entry => entry.format === 'raml' ? [rmbInterfaceName(entry.operation.resource)] : [];
  if (framework === 'spring') {
    return entry => entry.format !== 'openapi' ? [] : useTags
      ? (entry.operation.tags?.length ? entry.operation.tags : ['default']).map(springInterfaceName)
      : [springInterfaceName(entry.operation.resource.replace(/^\//, '').split('/')[0] || 'default')];
  }
  return () => [];
}

/**
 * The interface RMB generates for a RAML top-level resource: raml-for-jax-rs 3.0.7, which RMB's
 * domain-models-maven-plugin runs, names it with Names.typeName (`/check-in-storage/check-ins`: CheckInStorageCheckIns).
 * https://github.com/mulesoft-labs/raml-for-jax-rs/blob/3.0.7/raml-to-jaxrs/jaxrs-code-generator/src/main/java/org/raml/jaxrs/generator/Names.java
 */
function rmbInterfaceName(resource: string): string {
  const parts = resource.replace(/\W+/g, '_').split('_').filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1));
  if (/^\d/.test(parts[0] ?? '')) parts[0] = `_${parts[0]}`;
  return parts.join('');
}

/**
 * The interface openapi-generator's Spring generator generates for a group of operations, named by toApiName
 * (`index-management`: IndexManagementApi).
 * https://github.com/OpenAPITools/openapi-generator/blob/v7.10.0/modules/openapi-generator/src/main/java/org/openapitools/codegen/languages/SpringCodegen.java
 */
function springInterfaceName(group: string): string {
  return `${group.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('')}Api`;
}

/** The simple names of the interfaces committed classes implement, with where each is implemented. */
function implementedInterfaces(sources: Map<string, string>): Map<string, Array<{ file: string; line: number }>> {
  const implementations = new Map<string, Array<{ file: string; line: number }>>();
  for (const [file, content] of sources) {
    const lineAt = lineCounter(content);
    for (const match of content.matchAll(IMPLEMENTS)) {
      const line = lineAt(match.index!);
      let depth = 0;
      let names = '';
      for (const character of match[1]) {
        if (character === '<') depth++;
        else if (character === '>') depth = Math.max(0, depth - 1);
        else if (depth === 0) names += character;
      }
      for (const item of names.split(',')) {
        const name = /^\s*([\w.]+)/.exec(item)?.[1].split('.').pop();
        if (!name) continue;
        const classes = implementations.get(name) ?? [];
        implementations.set(name, classes);
        classes.push({ file, line });
      }
    }
  }
  return implementations;
}
