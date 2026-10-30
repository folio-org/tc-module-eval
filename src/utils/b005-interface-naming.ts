import {
  B005Analysis,
  B005Basis,
  B005Interface,
  B005Problem,
  BackendEvidence,
  EvaluationStatus,
  FrontendChecklistItem
} from '../types';
import { descriptorEndpoints, endpointMatcher, lookup, pathIndex } from './backend-endpoints';
import { PLACEHOLDER } from './backend-evidence';
import { HEALTH_ROUTE, sourceRoutes } from './backend-routes';
import { isSystemInterface } from './descriptor-handlers';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { count, listText, overflowLine, reportPath, reportText, unique } from './report-text';
import { isRecord } from './type-guards';

const MAX_ROWS = 20;
const MAJOR_MINOR = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const HYPHENATED_WORDS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UPPERCASE = /\p{Lu}/u;
const VIOLATIONS: B005Problem[] = ['dot', 'underscore', 'version-format'];
const MAX_WILDCARD_WORK = 50_000_000;
const MAX_LOOKUP_VISITS = 2_000_000;

/**
 * B005 (provided interfaces follow naming conventions) checks the id and version of each non-system interface in the
 * descriptor template's `provides`, and that each route the source registers is in a provided interface.
 */
export function evaluateB005(evidence: BackendEvidence, existingModule: boolean): B005Analysis {
  const { kind, template } = evidence;
  const sourceDiagnostics = evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const base = {
    criterionId: 'B005' as const, kind, existingModule, interfaces: [], systemInterfaces: [], unreadableEntries: [], routesChecked: false, routeCount: 0,
    unprovidedRoutes: [], unreadRoutes: [], unreadRouteCount: 0, unmatchedRoutes: [], sourceDiagnostics
  };
  const result = (status: EvaluationStatus, basis: B005Basis, summary: string, items: FrontendChecklistItem[], extra: Partial<B005Analysis> = {}): B005Analysis =>
    ({ ...base, ...extra, status, basis, summary: `B005 ${status}: ${summary}`, checklist: frontendChecklist(status, items) });
  const namingItem = (startingPoints: FrontendChecklistItem['startingPoints']): FrontendChecklistItem => ({
    id: 'B005-C2',
    title: 'Each interface listed for review has a name of words joined by hyphens and a major.minor version, or a reason to keep the ones it has.',
    startingPoints,
    reviewerOnly: true,
    obligations: []
  });

  if (kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'library', 'The repository is a shared library, which provides no interfaces of its own.', []);
  }
  if (!template?.descriptor) {
    return result(EvaluationStatus.MANUAL, 'no-descriptor',
      `${kind === 'ambiguous' ? 'No module descriptor template was found' : 'The module descriptor template could not be read'}, so the interfaces the module provides are not known (see B001).`,
      [namingItem([])]);
  }

  const descriptor = template.descriptor;
  const declared = isRecord(descriptor) ? descriptor.provides : undefined;
  const provides = Array.isArray(declared) ? declared : [];
  const unreadableEntries = declared === undefined || Array.isArray(declared) ? [] : ['/provides'];
  const rawProvides = rawTemplateProvides(evidence.snapshot.files.find(file => file.path === template.path)?.content);
  const unresolvedByPointer = new Map<string, string[]>();
  for (const placeholder of template.placeholders) {
    if (placeholder.value !== undefined) continue;
    for (const pointer of placeholder.pointers) {
      const texts = unresolvedByPointer.get(pointer) ?? [];
      unresolvedByPointer.set(pointer, texts);
      texts.push(placeholder.text);
    }
  }
  const resolvedByText = new Map(template.placeholders.flatMap(placeholder =>
    placeholder.value !== undefined && placeholder.source !== undefined ? [[placeholder.text, { value: placeholder.value, source: placeholder.source }] as const] : []));
  const systemInterfaces: string[] = [];
  const interfaces: B005Interface[] = [];
  provides.forEach((provided, index) => {
    if (!isRecord(provided)) {
      unreadableEntries.push(`/provides/${index}`);
      return;
    }
    if (isSystemInterface(provided)) {
      systemInterfaces.push(typeof provided.id === 'string' ? provided.id : `/provides/${index}`);
      return;
    }
    const pointer = `/provides/${index}`;
    const problems: B005Problem[] = [];
    const unresolved: string[] = [];
    const resolved: B005Interface['resolved'] = [];
    const seen = new Set<string>();
    const field = (name: 'id' | 'version'): string | undefined => {
      const value = provided[name];
      if (typeof value !== 'string') {
        problems.push(`${name}-missing`);
        return undefined;
      }
      const inField = unresolvedByPointer.get(`${pointer}/${name}`) ?? [];
      if (inField.length) {
        problems.push(`${name}-placeholder`);
        unresolved.push(...inField);
        return undefined;
      }
      const raw = rawProvides?.[index]?.[name];
      if (typeof raw === 'string') {
        for (const [text] of raw.matchAll(PLACEHOLDER)) {
          const property = resolvedByText.get(text);
          if (property && !seen.has(`${name}\n${text}`)) {
            seen.add(`${name}\n${text}`);
            resolved.push({ field: name, text, ...property });
          }
        }
      }
      return value;
    };
    const id = field('id');
    const version = field('version');
    if (id !== undefined) {
      if (id.includes('.')) problems.push('dot');
      if (id.includes('_')) problems.push('underscore');
      if (UPPERCASE.test(id)) problems.push('uppercase');
      if (!HYPHENATED_WORDS.test(id.replace(/[._]/g, '-').toLowerCase())) problems.push('other-characters');
    }
    if (version !== undefined && !MAJOR_MINOR.test(version)) problems.push('version-format');
    const firstSegments = unique((Array.isArray(provided.handlers) ? provided.handlers : []).filter(isRecord)
      .flatMap(handler => [handler.pathPattern, handler.path].filter((value): value is string => typeof value === 'string').slice(0, 1))
      .map(handlerPath => handlerPath.split('/').filter(Boolean)[0] ?? ''));
    interfaces.push({
      id: typeof provided.id === 'string' ? provided.id : '',
      version: typeof provided.version === 'string' ? provided.version : '',
      pointer,
      problems,
      placeholders: unique(unresolved),
      resolved,
      ...(id !== undefined && firstSegments.length && !firstSegments.includes(id) ? { otherFirstSegments: firstSegments } : {})
    });
  });

  const routesChecked = kind !== 'edge-module';
  const scan = routesChecked ? sourceRoutes(evidence.snapshot.files) : { routes: [], unreadRoutes: [], unreadRouteCount: 0 };
  const routes = scan.routes.filter(route => !route.path.includes('*') && route.path !== HEALTH_ROUTE);
  const handlers = descriptorEndpoints(descriptor, true);
  const handlerIndex = pathIndex(handlers.filter(handler => !handler.path.includes('*')));
  const routeIndex = pathIndex(routes);
  const wildcardHandlers = handlers.filter(handler => handler.path.includes('*'));
  const length = (items: Array<{ path: string }>) => items.reduce((total, item) => total + item.path.length, 0);
  const wildcardsMatched = length(wildcardHandlers) * length(routes) <= MAX_WILDCARD_WORK;
  const coveredByWildcards = new Set(wildcardsMatched ? wildcardHandlers.flatMap(handler => lookup(routeIndex, endpointMatcher(handler)).documented) : []);
  const budget = { visits: MAX_LOOKUP_VISITS };
  const notCovered = routes.filter(route => {
    if (coveredByWildcards.has(route)) return false;
    const { documented, partial } = lookup(handlerIndex, endpointMatcher(route), budget);
    return !documented.length && !partial.length;
  }).map(({ method, path: routePath, file, line }) => ({ method, path: routePath, file, line }));
  const limited = budget.visits < 0 || (!wildcardsMatched && wildcardHandlers.length > 0);
  const unprovidedRoutes = limited ? [] : notCovered;
  const unmatchedRoutes = limited ? notCovered : [];
  const routeFacts = {
    templatePath: template.path, systemInterfaces, interfaces, unreadableEntries, routesChecked, routeCount: routes.length, unprovidedRoutes,
    unreadRoutes: scan.unreadRoutes, unreadRouteCount: scan.unreadRouteCount, unmatchedRoutes
  };
  const sourceIncomplete = routesChecked && sourceDiagnostics.length > 0;

  const routeSentences: string[] = [];
  if (unprovidedRoutes.length) {
    routeSentences.push(`${count(unprovidedRoutes.length, 'route')} registered in the source ${unprovidedRoutes.length === 1 ? 'is' : 'are'} in no interface the module provides: ${listText(unprovidedRoutes.map(routeLabel))}.`);
  }
  if (scan.unreadRouteCount) {
    routeSentences.push(`The tool could not read ${count(scan.unreadRouteCount, 'route')} in the source, so it could not check that ${scan.unreadRouteCount === 1 ? 'it is' : 'they are'} in a provided interface.`);
  }
  if (unmatchedRoutes.length) {
    routeSentences.push(`The descriptor's handlers and the source's routes are too many to match within the tool's limit, so it could not check whether ${count(unmatchedRoutes.length, 'route')} ${unmatchedRoutes.length === 1 ? 'is' : 'are'} in a provided interface: ${listText(unmatchedRoutes.map(routeLabel))}.`);
  }
  if (sourceIncomplete) routeSentences.push('The committed source was not read completely, so the tool may have missed routes.');
  const routeItems: FrontendChecklistItem[] = unprovidedRoutes.length || scan.unreadRouteCount || unmatchedRoutes.length ? [{
    id: 'B005-C1',
    title: 'Each route the module implements for other modules is in an interface in provides.',
    startingPoints: [
      ...unprovidedRoutes.map(route => ({ path: route.file, line: route.line, note: `${route.method} ${route.path}: in no provided interface` })),
      ...scan.unreadRoutes.map(route => ({ path: route.file, line: route.line, note: 'route whose path the tool could not read' })),
      ...unmatchedRoutes.map(route => ({ path: route.file, line: route.line, note: `${route.method} ${route.path}: not matched against every handler (limit)` }))
    ],
    reviewerOnly: true,
    obligations: []
  }] : [];
  const routesToReview = unprovidedRoutes.length + scan.unreadRouteCount + unmatchedRoutes.length + (sourceIncomplete ? 1 : 0);
  const routesPass = routes.length
    ? [routes.length === 1 ? 'The route registered in the source is in a provided interface.' : `Each of the ${routes.length} routes registered in the source is in a provided interface.`]
    : [];

  if (!interfaces.length && !unreadableEntries.length) {
    const none = `${reportPath(template.path)} provides no interfaces other than system interfaces.`;
    if (!routesToReview) {
      return result(EvaluationStatus.NOT_APPLICABLE, 'no-interfaces', [none, ...routesPass].join(' '), [], routeFacts);
    }
    return result(EvaluationStatus.MANUAL, 'no-interfaces', [none, ...routeSentences, `A reviewer must check ${routesToReview === 1 ? 'it' : 'them'}.`].join(' '), routeItems, routeFacts);
  }

  const having = (...problems: B005Problem[]) => interfaces.filter(provided => problems.some(problem => provided.problems.includes(problem)));
  const separators = having('dot', 'underscore');
  const versions = having('version-format');
  const uppercase = having('uppercase');
  const otherCharacters = having('other-characters');
  const withPlaceholders = having('id-placeholder', 'version-placeholder');
  const missing = having('id-missing', 'version-missing');
  const subject = (list: B005Interface[], singular: string, plural: string) =>
    list.length === 1 ? `The interface ${quoted(list[0])} ${singular}` : `${list.length} interfaces ${plural}`;

  const sentences: string[] = [];
  if (separators.length) {
    const what = (provided: B005Interface) => listText([
      ...(provided.problems.includes('dot') ? ['a dot'] : []),
      ...(provided.problems.includes('underscore') ? ['an underscore'] : [])
    ]);
    sentences.push(`${separators.length === 1
      ? `The interface ${quoted(separators[0])} uses ${what(separators[0])}`
      : `${separators.length} interfaces use dots or underscores: ${listText(separators.map(provided => `${quoted(provided)} (${what(provided)})`))}`}; interface names are words joined by hyphens.`);
  }
  if (versions.length) {
    sentences.push(versions.length === 1
      ? `The interface ${quoted(versions[0])} has version ${versionText(versions[0])}, which is not major.minor (the first two parts of a semantic version).`
      : `${versions.length} interfaces have versions that are not major.minor (the first two parts of a semantic version): ${listText(versions.map(provided => `${quoted(provided)} ${versionText(provided)}`))}.`);
  }
  const violations = having(...VIOLATIONS);
  if (violations.length && existingModule) {
    sentences.push('In an existing-module evaluation (--existing-module) this is not a fail, because renaming an interface or changing its version breaks the modules that use it.');
  }
  if (uppercase.length) {
    sentences.push(`${subject(uppercase, 'has uppercase letters', 'have uppercase letters')}${uppercase.length === 1 ? '' : `: ${listText(uppercase.map(quoted))}`}; the naming guide does not say whether interface names must be lowercase.`);
  }
  if (otherCharacters.length) {
    sentences.push(`${subject(otherCharacters, 'is not', 'are not')} made of letters and digits joined by single hyphens${otherCharacters.length === 1 ? '' : `: ${listText(otherCharacters.map(quoted))}`}.`);
  }
  if (withPlaceholders.length) {
    const fields = (provided: B005Interface) => listText([
      ...(provided.problems.includes('id-placeholder') ? [`the id ${quoted(provided)}`] : []),
      ...(provided.problems.includes('version-placeholder') ? [`the version of ${quoted(provided)} (${reportText(provided.version)})`] : [])
    ]);
    const texts = unique(withPlaceholders.flatMap(provided => provided.placeholders));
    sentences.push(`The tool could not check ${listText(withPlaceholders.map(fields))}, because the build properties do not define ${texts.length > 1 ? 'the build placeholders' : 'the build placeholder'} ${listText(texts.map(reportText))}.`);
  }
  if (missing.length) {
    const fields = (provided: B005Interface) => listText([
      ...(provided.problems.includes('id-missing') ? [`the id at ${provided.pointer}`] : []),
      ...(provided.problems.includes('version-missing') ? [provided.id ? `the version of ${quoted(provided)}` : `the version at ${provided.pointer}`] : [])
    ]);
    sentences.push(`The tool could not check ${listText(missing.map(fields))}, because ${missing.length === 1 && missing[0].problems.filter(problem => problem.endsWith('-missing')).length === 1 ? 'it is' : 'they are'} missing or not a string in the template (see B001).`);
  }
  if (unreadableEntries[0] === '/provides') {
    sentences.push('The template\'s provides is not a list, so the tool could not read the interfaces (see B001).');
  } else if (unreadableEntries.length) {
    sentences.push(`The template's provides has ${unreadableEntries.length === 1 ? 'an entry that is' : `${unreadableEntries.length} entries that are`} not an interface object (${listText(unreadableEntries)}), as when a build placeholder outside a JSON string has no value, so the tool could not check ${unreadableEntries.length === 1 ? 'it' : 'them'} (see B001).`);
  }
  sentences.push(...routeSentences);

  const fails = !existingModule && violations.length > 0;
  const forReview = unique([...(existingModule ? violations : []), ...uppercase, ...otherCharacters, ...withPlaceholders, ...missing]);
  const toReview = forReview.length + unreadableEntries.length + routesToReview;
  const status = fails ? EvaluationStatus.FAIL : toReview ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  if (status === EvaluationStatus.MANUAL) sentences.push(`A reviewer must check ${toReview === 1 ? 'it' : 'them'}.`);
  if (status === EvaluationStatus.PASS) {
    sentences.push(interfaces.length === 1
      ? `The interface ${quoted(interfaces[0])} in the module descriptor has a name of words joined by hyphens and a major.minor version.`
      : `All ${interfaces.length} interfaces in the module descriptor, other than system interfaces, have names of words joined by hyphens and major.minor versions.`,
    ...routesPass);
  }

  const items: FrontendChecklistItem[] = [...routeItems];
  if (forReview.length || unreadableEntries.length) {
    items.push(namingItem([
      ...forReview.map(provided => ({
        path: template.path,
        note: `${provided.id ? reportText(provided.id) : provided.pointer}: ${listText(provided.problems.map(problem => PROBLEM_NOTES[problem]))}`
      })),
      ...unreadableEntries.map(pointer => ({ path: template.path, note: `${pointer}: ${pointer === '/provides' ? 'not a list' : 'not an interface object'}` }))
    ]));
  }

  return result(status, 'interfaces-checked', sentences.join(' '), items, routeFacts);
}

export function renderB005HumanDetails(analysis: B005Analysis): string {
  const lines = [`Evaluated as: ${analysis.existingModule ? 'an existing module (--existing-module)' : 'a new module (the default)'}`];
  if (analysis.templatePath) {
    lines.push(`Interfaces: ${analysis.interfaces.length} in ${reportPath(analysis.templatePath)}${analysis.systemInterfaces.length
      ? `, without the system ${analysis.systemInterfaces.length === 1 ? 'interface' : 'interfaces'} ${listText(analysis.systemInterfaces.map(reportText))}`
      : ''}`);
  }
  const section = (heading: string, problems: B005Problem[], describe: (provided: B005Interface) => string) => {
    const list = analysis.interfaces.filter(provided => problems.some(problem => provided.problems.includes(problem)));
    if (!list.length) return;
    lines.push(`${heading}:`, ...list.slice(0, MAX_ROWS).map(provided => `  - ${describe(provided)}`), ...overflowLine(list.length, MAX_ROWS, '  '));
  };
  const name = (provided: B005Interface) => provided.id ? reportText(provided.id) : `(no id at ${provided.pointer})`;
  section('Names with a dot or underscore', ['dot', 'underscore'], provided =>
    `${name(provided)} — ${listText(provided.problems.filter(problem => problem === 'dot' || problem === 'underscore').map(problem => PROBLEM_NOTES[problem]))}`);
  section('Versions that are not major.minor', ['version-format'], provided => `${name(provided)} ${versionText(provided)}`);
  section('Names with uppercase letters', ['uppercase'], name);
  section('Names not made of letters and digits joined by single hyphens', ['other-characters'], name);
  section('Build placeholders the build properties do not define', ['id-placeholder', 'version-placeholder'], provided => `${name(provided)} — ${listText([
    ...(provided.problems.includes('id-placeholder') ? ['in the id'] : []),
    ...(provided.problems.includes('version-placeholder') ? [`in the version ${reportText(provided.version)}`] : [])
  ])}`);
  section('Missing or not a string', ['id-missing', 'version-missing'], provided =>
    `${name(provided)} — ${listText(provided.problems.filter(problem => problem.endsWith('-missing')).map(problem => problem === 'id-missing' ? 'id' : 'version'))}`);
  if (analysis.unreadableEntries.length) {
    lines.push('Not read from provides:', ...analysis.unreadableEntries.slice(0, MAX_ROWS).map(pointer =>
      `  - ${pointer} — ${pointer === '/provides' ? 'not a list' : 'not an interface object'}`), ...overflowLine(analysis.unreadableEntries.length, MAX_ROWS, '  '));
  }
  const resolved = analysis.interfaces.flatMap(provided => provided.resolved.map(placeholder => ({ provided, placeholder })));
  if (resolved.length) {
    lines.push('Resolved from build properties:', ...resolved.slice(0, MAX_ROWS).map(({ provided, placeholder }) =>
      `  - ${name(provided)} ${placeholder.field} ${reportText(placeholder.value)} from ${reportText(placeholder.text)} (${reportText(placeholder.source)})`),
    ...overflowLine(resolved.length, MAX_ROWS, '  '));
  }
  if (analysis.routesChecked) {
    lines.push(`Routes found in the source: ${analysis.routeCount}`);
    if (analysis.unprovidedRoutes.length) {
      lines.push('Routes in no provided interface:', ...analysis.unprovidedRoutes.slice(0, MAX_ROWS).map(route =>
        `  - ${routeLabel(route)} — ${reportPath(route.file)}:${route.line}`), ...overflowLine(analysis.unprovidedRoutes.length, MAX_ROWS, '  '));
    }
    if (analysis.unmatchedRoutes.length) {
      lines.push('Routes not matched against every handler (too many to match):', ...analysis.unmatchedRoutes.slice(0, MAX_ROWS).map(route =>
        `  - ${routeLabel(route)} — ${reportPath(route.file)}:${route.line}`), ...overflowLine(analysis.unmatchedRoutes.length, MAX_ROWS, '  '));
    }
    if (analysis.unreadRouteCount) {
      lines.push('Routes the tool could not read:', ...analysis.unreadRoutes.slice(0, MAX_ROWS).map(route => `  - ${reportPath(route.file)}:${route.line}`),
        ...overflowLine(analysis.unreadRouteCount, MAX_ROWS, '  '));
    }
    if (analysis.sourceDiagnostics.length) {
      lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
        `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
    }
  } else if (analysis.kind === 'edge-module' && analysis.templatePath) {
    lines.push('Routes: not checked, because an edge module\'s routes serve clients outside FOLIO');
  }
  const differing = analysis.interfaces.filter(provided => provided.otherFirstSegments);
  if (differing.length) {
    lines.push('Names that differ from the first segment of their handler paths (information only):', ...differing.slice(0, MAX_ROWS).map(provided =>
      `  - ${name(provided)} — ${listText(provided.otherFirstSegments!.map(segment => `/${reportText(segment)}`))}`), ...overflowLine(differing.length, MAX_ROWS, '  '));
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    const separators = analysis.interfaces.some(provided => provided.problems.includes('dot') || provided.problems.includes('underscore'));
    const versions = analysis.interfaces.some(provided => provided.problems.includes('version-format'));
    lines.push('What to do:', `  - ${[
      ...(separators ? ['Rename each interface listed under "Names with a dot or underscore" to words joined by hyphens'] : []),
      ...(versions ? [`${separators ? 'give' : 'Give'} each interface listed under "Versions that are not major.minor" a major.minor version`] : [])
    ].join(', and ')}.`);
  }
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  return lines.join('\n');
}

const PROBLEM_NOTES: Record<B005Problem, string> = {
  dot: 'a dot',
  underscore: 'an underscore',
  'version-format': 'version not major.minor',
  uppercase: 'uppercase letters',
  'other-characters': 'not letters and digits joined by single hyphens',
  'id-placeholder': 'id has an undefined build placeholder',
  'version-placeholder': 'version has an undefined build placeholder',
  'id-missing': 'id missing or not a string',
  'version-missing': 'version missing or not a string'
};

function versionText(provided: B005Interface): string {
  return provided.version ? reportText(provided.version) : '""';
}

function quoted(provided: B005Interface): string {
  return provided.id ? `"${reportText(provided.id)}"` : `at ${provided.pointer}`;
}

function routeLabel(route: { method: string; path: string }): string {
  return `${reportText(route.method)} ${reportText(route.path)}`;
}

function rawTemplateProvides(content: string | undefined): Array<Record<string, unknown> | undefined> | undefined {
  if (content === undefined) return undefined;
  try {
    const raw: unknown = JSON.parse(content);
    return isRecord(raw) && Array.isArray(raw.provides) ? raw.provides.map(provided => isRecord(provided) ? provided : undefined) : undefined;
  } catch {
    return undefined;
  }
}
