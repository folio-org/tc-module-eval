import {
  B006Analysis,
  B006Basis,
  B006Documentation,
  B006Endpoint,
  BackendApiSpec,
  BackendApiSpecs,
  BackendEvidence,
  EvaluationStatus,
  FrontendChecklistItem
} from '../types';
import { FRAMEWORK_LABELS } from './b001-descriptor-template';
import { descriptorEndpoints, EndpointMatcher, endpointLibraries, endpointMatcher, gapCovers, lookup, pathIndex, uniqueEndpoints } from './backend-endpoints';
import { HEALTH_ROUTE, routerRoutes } from './backend-routes';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { count, listText, overflowLine, reportPath, reportText, unique } from './report-text';

const MAX_ROWS = 20;

/**
 * B006 (all API endpoints documented in OpenAPI) looks up every endpoint the module serves in the repository's API
 * specs: the descriptor template's handlers, without system interfaces, or for an edge module its router routes.
 * RAML counts only for an RMB module in an existing-module evaluation.
 */
export function evaluateB006(evidence: BackendEvidence, apiSpecs: BackendApiSpecs, existingModule: boolean): B006Analysis {
  const { kind, framework, template } = evidence;
  const ramlAccepted = existingModule && framework.name === 'rmb';
  const sourceDiagnostics = evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const specs = apiSpecs.specs.map(spec => ({ file: spec.file, format: spec.format, ...(spec.version ? { version: spec.version } : {}), operationCount: spec.operations.length }));
  const gaps = [...apiSpecs.specs.flatMap(spec => spec.gaps), ...apiSpecs.unreadSources];
  const base = { criterionId: 'B006' as const, kind, framework, existingModule, ramlAccepted, specs, gaps, endpoints: [], unreadRoutes: [], unreadRouteCount: 0, sourceDiagnostics };
  const result = (status: EvaluationStatus, basis: B006Basis, summary: string, items: FrontendChecklistItem[], extra: Partial<B006Analysis> = {}): B006Analysis =>
    ({ ...base, ...extra, status, basis, summary: `B006 ${status}: ${summary}`, checklist: frontendChecklist(status, items) });
  const unchecked = (startingPoints: FrontendChecklistItem['startingPoints']): FrontendChecklistItem => ({
    id: 'B006-C2',
    title: `Each endpoint the tool could not check is documented in an OpenAPI spec${ramlAccepted ? ' or, for this existing RMB module, in RAML' : ''}.`,
    startingPoints,
    reviewerOnly: true,
    obligations: []
  });

  if (kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'library', 'The repository is a shared library, which serves no endpoints of its own.', []);
  }

  let matchers: EndpointMatcher<Omit<B006Endpoint, 'documentation' | 'specFiles'>>[];
  let unreadRoutes: B006Analysis['unreadRoutes'] = [];
  let unreadRouteCount = 0;
  let endpointSource: string;
  if (kind === 'edge-module') {
    const scan = routerRoutes(evidence.snapshot.files);
    ({ unreadRoutes, unreadRouteCount } = scan);
    matchers = uniqueEndpoints(scan.routes.filter(route => route.path !== HEALTH_ROUTE)).map(endpointMatcher);
    endpointSource = 'router routes in src/main';
    if (!matchers.length) {
      return result(EvaluationStatus.MANUAL, 'no-routes',
        'The repository is an edge module, but no router route with a readable path was found, so its endpoints are not known.',
        [unchecked(unreadRoutes.map(route => ({ path: route.file, line: route.line, note: 'router route whose path the tool could not read' })))],
        { unreadRoutes, unreadRouteCount, endpointSource });
    }
  } else {
    if (!template?.descriptor) {
      return result(EvaluationStatus.MANUAL, 'no-descriptor',
        `${kind === 'ambiguous' ? 'No module descriptor template was found' : 'The module descriptor template could not be read'}, so the module's endpoints are not known (see B001).`,
        [unchecked([])]);
    }
    matchers = descriptorEndpoints(template.descriptor).map(endpointMatcher);
    endpointSource = `handlers in ${template.path}, without system interfaces`;
    if (!matchers.length) {
      return result(EvaluationStatus.NOT_APPLICABLE, 'no-endpoints',
        `${reportPath(template.path)} provides no endpoints other than system interfaces.`, [], { endpointSource });
    }
  }

  const libraries = endpointLibraries(evidence);
  const openapiIndex = specIndex(apiSpecs.specs.filter(spec => spec.format === 'openapi'));
  const ramlIndex = specIndex(apiSpecs.specs.filter(spec => spec.format === 'raml'));
  const endpoints = matchers.map((matcher): B006Endpoint => {
    const found = (documentation: B006Documentation, specFiles: string[], library?: string) =>
      ({ ...matcher.endpoint, documentation, specFiles, ...(library ? { library } : {}) });
    const mayDocument = (format: BackendApiSpec['format']) => apiSpecs.specs.filter(spec => spec.format === format
      && spec.gaps.some(gap => gap.apiPath === undefined || gapCovers(matcher, gap.apiPath))).map(spec => spec.file);

    const openapi = specLookup(openapiIndex, matcher);
    if (openapi.documented.length) return found('openapi', openapi.documented);
    const raml = specLookup(ramlIndex, matcher);
    if (raml.documented.length && ramlAccepted) return found('raml', raml.documented);
    const library = libraries.find(candidate => candidate.path.test(matcher.endpoint.path));
    if (library) return found('library', [], library.artifactId);
    const partial = [...openapi.partial, ...(ramlAccepted ? raml.partial : [])];
    if (partial.length) return found('partial', partial);
    const unconfirmed = [...mayDocument('openapi'), ...(ramlAccepted ? mayDocument('raml') : []), ...apiSpecs.unreadSources.map(gap => gap.file)];
    if (unconfirmed.length || sourceDiagnostics.length) return found('unconfirmed', unique(unconfirmed));
    const inRaml = raml.documented.length ? raml.documented : raml.partial.length ? raml.partial : mayDocument('raml');
    if (inRaml.length) return found('raml', inRaml);
    return found('undocumented', []);
  });

  const of = (documentation: B006Documentation) => endpoints.filter(endpoint => endpoint.documentation === documentation);
  const [undocumented, ramlOnly, fromLibrary, partial, unconfirmed] = (['undocumented', 'raml', 'library', 'partial', 'unconfirmed'] as const).map(of);
  const total = endpoints.length;
  const where = kind === 'edge-module' ? 'routed by the edge module' : 'in the module descriptor';
  const share = (part: number) => part === total ? (total === 1 ? `The endpoint ${where}` : `All ${total} endpoints ${where}`) : `${part} of the ${total} endpoints ${where}`;
  const verb = (part: number) => part === 1 ? 'is' : 'are';
  const labels = (list: B006Endpoint[]) => listText(list.map(endpointLabel));

  const sentences: string[] = [];
  if (!apiSpecs.specs.length && undocumented.length === total) {
    sentences.push(`No OpenAPI or RAML spec was found, so ${total === 1 ? 'the endpoint' : `none of the ${total} endpoints`} ${where} is documented.`);
  } else if (undocumented.length) {
    sentences.push(`${undocumented.length === total && total > 1 ? `None of the ${total} endpoints ${where} is` : `${share(undocumented.length)} ${verb(undocumented.length)} not`} documented in any API spec: ${labels(undocumented)}.`);
  }
  if (!ramlAccepted && ramlOnly.length) {
    sentences.push(`${undocumented.length ? `${ramlOnly.length} more ${verb(ramlOnly.length)}` : `${share(ramlOnly.length)} ${verb(ramlOnly.length)}`} documented only in RAML. ${existingModule
      ? `Only an RMB module may keep RAML, and ${framework.name === 'edge' ? 'this is an edge module' : `the framework is ${FRAMEWORK_LABELS[framework.name]}`}.`
      : 'A new module must document its endpoints in OpenAPI; an RMB module may keep RAML only when evaluated as an existing module (--existing-module).'}`);
  }
  if (fromLibrary.length) {
    const names = unique(fromLibrary.map(endpoint => endpoint.library!));
    sentences.push(`${share(fromLibrary.length)} ${fromLibrary.length === 1 ? 'comes' : 'come'} from ${listText(names)}, whose own spec documents ${fromLibrary.length === 1 ? 'it' : 'them'}: ${labels(fromLibrary)}.`);
  }
  if (partial.length) {
    sentences.push(`${share(partial.length)} ${verb(partial.length)} documented only for fixed values of a path parameter: ${labels(partial)}.`);
  }
  if (unconfirmed.length) {
    const reasons = [
      ...(apiSpecs.specs.some(spec => spec.gaps.length) ? ['part of an API spec could not be read'] : []),
      ...(apiSpecs.unreadSources.length ? ['the build reads API specs from a git submodule the tool does not read'] : []),
      ...(sourceDiagnostics.length ? ['the committed source was not read completely'] : [])
    ];
    sentences.push(`${share(unconfirmed.length)} could not be checked, because ${listText(reasons)}: ${labels(unconfirmed)}.`);
  }
  if (unreadRouteCount) {
    sentences.push(`${count(unreadRouteCount, 'router route')} ${unreadRouteCount === 1 ? 'has' : 'have'} a path the tool could not read.`);
  }

  const fails = undocumented.length > 0 || (!ramlAccepted && ramlOnly.length > 0);
  const toReview = fromLibrary.length + partial.length + unconfirmed.length + unreadRouteCount;
  const status = fails ? EvaluationStatus.FAIL : toReview ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  if (status === EvaluationStatus.MANUAL) sentences.push(`A reviewer must check ${toReview === 1 ? 'it' : 'them'}.`);
  if (status === EvaluationStatus.PASS) {
    const openapiCount = of('openapi').length;
    const files = (list: B006Endpoint[]) => listText(unique(list.flatMap(endpoint => endpoint.specFiles)).map(reportPath));
    sentences.push(ramlOnly.length === 0
      ? `${share(total)} ${verb(total)} documented in OpenAPI (${files(endpoints)}).`
      : `${share(total)} ${verb(total)} documented${openapiCount ? `, ${openapiCount} in OpenAPI and ${ramlOnly.length} in RAML` : ` in RAML (${files(ramlOnly)})`}. An RMB module may keep RAML when evaluated as an existing module.`);
  }

  const items: FrontendChecklistItem[] = [];
  if (fromLibrary.length) {
    items.push({
      id: 'B006-C1',
      title: 'Each endpoint listed as coming from a library is documented in that library\'s published spec.',
      startingPoints: libraries.filter(library => fromLibrary.some(endpoint => endpoint.library === library.artifactId))
        .map(library => ({ path: library.buildFile, note: `depends on ${library.artifactId}` })),
      reviewerOnly: true,
      obligations: []
    });
  }
  if (partial.length || unconfirmed.length || unreadRouteCount) {
    const unconfirmedFiles = new Set(unconfirmed.flatMap(endpoint => endpoint.specFiles));
    items.push(unchecked([
      ...unique(partial.flatMap(endpoint => endpoint.specFiles)).map(file => ({ path: file, note: 'documents some paths only for fixed values of a parameter' })),
      ...unique(apiSpecs.specs.filter(spec => unconfirmedFiles.has(spec.file)).flatMap(spec => spec.gaps.map(gap => gap.file)))
        .map(file => ({ path: file, note: 'part of an API spec the tool could not read' })),
      ...apiSpecs.unreadSources.map(gap => ({ path: gap.file, note: `reads API specs from the git submodule ${gap.reference}` })),
      ...unreadRoutes.map(route => ({ path: route.file, line: route.line, note: 'router route whose path the tool could not read' }))
    ]));
  }

  return result(status, 'endpoints-checked', sentences.join(' '), items, { endpointSource, endpoints, unreadRoutes, unreadRouteCount });
}

export function renderB006HumanDetails(analysis: B006Analysis): string {
  const lines = [
    `Evaluated as: ${analysis.existingModule ? 'an existing module (--existing-module)' : 'a new module (the default)'}`,
    `Framework: ${FRAMEWORK_LABELS[analysis.framework.name]}; RAML ${analysis.ramlAccepted ? 'counts' : 'does not count'} as documentation`
  ];
  if (analysis.endpointSource) lines.push(`Endpoints: ${analysis.endpoints.length} methods and paths from ${reportText(analysis.endpointSource)}`);
  if (analysis.basis !== 'library') {
    lines.push(analysis.specs.length ? 'API specs:' : 'API specs: none found (OpenAPI or Swagger files with an openapi or swagger key, RAML root files)',
      ...analysis.specs.slice(0, MAX_ROWS).map(spec => `  - ${reportPath(spec.file)} — ${spec.format === 'raml' ? 'RAML' : 'OpenAPI'}${spec.version ? ` ${reportText(spec.version)}` : ''}, ${count(spec.operationCount, 'operation')}`),
      ...overflowLine(analysis.specs.length, MAX_ROWS, '  '));
  }
  const files = (endpoint: B006Endpoint) => listText(endpoint.specFiles.map(reportPath));
  const section = (heading: string, documentation: B006Documentation, describe: (endpoint: B006Endpoint) => string = () => '') => {
    const list = analysis.endpoints.filter(endpoint => endpoint.documentation === documentation);
    if (!list.length) return;
    lines.push(`${heading}:`, ...list.slice(0, MAX_ROWS).map(endpoint => `  - ${endpointLabel(endpoint)}${endpointOrigin(endpoint)}${describe(endpoint)}`),
      ...overflowLine(list.length, MAX_ROWS, '  '));
  };
  section('Not documented in any API spec', 'undocumented');
  if (!analysis.ramlAccepted) section('Documented only in RAML', 'raml', endpoint => ` — ${files(endpoint)}`);
  section('From a library', 'library', endpoint => ` — ${reportText(endpoint.library ?? '')}`);
  section('Documented only for fixed values of a path parameter', 'partial', endpoint => ` — ${files(endpoint)}`);
  section('Could not be checked', 'unconfirmed', endpoint => endpoint.specFiles.length ? ` — ${files(endpoint)} may document it` : '');
  const documented = analysis.endpoints.filter(endpoint => endpoint.documentation === 'openapi' || (analysis.ramlAccepted && endpoint.documentation === 'raml'));
  if (documented.length) {
    const inRaml = documented.filter(endpoint => endpoint.documentation === 'raml').length;
    lines.push(`Documented: ${documented.length}${inRaml ? ` (${documented.length - inRaml} in OpenAPI, ${inRaml} in RAML)` : ' in OpenAPI'}`);
  }
  if (analysis.gaps.length) {
    lines.push('API spec parts the tool could not read:', ...analysis.gaps.slice(0, MAX_ROWS).map(gap =>
      `  - ${reportPath(gap.file)}${gap.apiPath ? ` ${reportText(gap.apiPath)}` : ''}${gap.reference ? ` (${reportText(gap.reference)})` : ''} — ${reportText(gap.message)}`),
    ...overflowLine(analysis.gaps.length, MAX_ROWS, '  '));
  }
  if (analysis.unreadRouteCount) {
    lines.push('Router routes the tool could not read:', ...analysis.unreadRoutes.slice(0, MAX_ROWS).map(route => `  - ${reportPath(route.file)}:${route.line}`),
      ...overflowLine(analysis.unreadRouteCount, MAX_ROWS, '  '));
  }
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    const raml = !analysis.ramlAccepted && analysis.endpoints.some(endpoint => endpoint.documentation === 'raml');
    lines.push('What to do:', `  - Document ${raml ? 'every endpoint' : 'each endpoint listed above'} in an OpenAPI spec in the repository${raml
      ? (analysis.existingModule ? ' (only an RMB module may keep RAML)' : ' (an RMB module evaluated as an existing module may keep RAML)')
      : ''}.`);
  }
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  return lines.join('\n');
}

function endpointLabel(endpoint: B006Endpoint): string {
  return `${reportText(endpoint.method)} ${reportText(endpoint.path)}`;
}

function endpointOrigin(endpoint: B006Endpoint): string {
  if (endpoint.interfaceId) return ` (interface ${reportText(endpoint.interfaceId)})`;
  return endpoint.file ? ` (${reportPath(endpoint.file)}:${endpoint.line})` : '';
}

function specIndex(specs: BackendApiSpec[]) {
  return pathIndex(specs.flatMap(spec => spec.operations.map(operation => ({ method: operation.method, path: operation.path, file: spec.file }))));
}

/** The spec files that document an endpoint, and, when none does, those that document its path only with fixed values. */
function specLookup(index: ReturnType<typeof specIndex>, matcher: EndpointMatcher): { documented: string[]; partial: string[] } {
  const { documented, partial } = lookup(index, matcher);
  return { documented: unique(documented.map(operation => operation.file)), partial: unique(partial.map(operation => operation.file)) };
}
