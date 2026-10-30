import {
  B002Analysis,
  B002Basis,
  B002InterfaceUse,
  B002MappedSite,
  BackendEvidence,
  BackendPlaceholder,
  BackendRequestSite,
  CriterionAgentReviewResult,
  EvaluationStatus,
  FrontendChecklistItem,
  S008DeclarationResult
} from '../types';
import { backendBrowse, numberBackendObligations } from './backend-agent-review';
import { outboundRequests } from './backend-outbound-calls';
import { HEALTH_ROUTE } from './backend-routes';
import { F001IndexLoad, F001Pattern, mapRequestPath } from './f001-consumed-apis';
import { FrontendChecklistItemDraft } from './frontend-agent-review';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { count, listText, overflowLine, reportPath, reportText, unique } from './report-text';
import { isRecord } from './type-guards';

const SHOWN_SITES = 20;
const SHOWN_SITES_PER_INTERFACE = 3;
const MAX_OWN_HANDLERS = 1_000;

/**
 * FOLIO libraries that send requests of their own: folio-spring-system-user (authn, users, perms/users) and
 * folio-spring-kafka (entitlements) in https://github.com/folio-org/folio-spring-base, and edge-common and
 * edge-common-spring, which log in for the edge module.
 */
const REQUESTING_LIBRARIES = ['folio-spring-system-user', 'folio-spring-kafka', 'edge-common', 'edge-common-spring'];
const BUILD_FILE = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/;

export interface B002Input {
  evidence: BackendEvidence;
  index: F001IndexLoad;
  /** S008's declarations, which come from the generated descriptor when S002 built one; absent for a repository without a descriptor. */
  s008?: S008DeclarationResult;
}

/**
 * B002 (consumed APIs declared in requires or optional). Manual, never fail, when a request maps to an interface the
 * descriptor template declares in neither list (Q3); pass when every request maps to a declared interface or to the
 * module's own paths; manual otherwise: requests the tool cannot read or map, paths not in the handler index, an
 * index that did not load, declarations or source it could not read. Not applicable to shared libraries.
 */
export function evaluateB002({ evidence, index, s008 }: B002Input): B002Analysis {
  const { kind, template } = evidence;
  const sourceDiagnostics = evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const base = {
    criterionId: 'B002' as const, kind, index: indexSummary(index), declared: { required: [], optional: [] }, unreadDeclarations: [],
    productionFileCount: 0, siteCount: 0, gatewaySiteCount: 0, ownSiteCount: 0, undeclared: [], declaredAndUsed: [], declaredNotSeen: [],
    unresolvedSites: [], notInIndexSites: [], libraries: [], kotlinFiles: [], sourceDiagnostics
  };
  const result = (status: EvaluationStatus, basis: B002Basis, summary: string, items: FrontendChecklistItem[], extra: Partial<B002Analysis> = {}): B002Analysis =>
    ({ ...base, ...extra, status, basis, summary: `B002 ${status}: ${summary}`, checklist: frontendChecklist(status, items) });

  if (kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'library', 'The repository is a shared library, which has no module descriptor to declare the interfaces it calls.', []);
  }
  if (!template?.descriptor) {
    return result(EvaluationStatus.MANUAL, 'no-descriptor',
      `${kind === 'ambiguous' ? 'No module descriptor template was found' : 'The module descriptor template could not be read'}, so the interfaces the module declares are not known (see B001).`,
      numberBackendObligations([declarationsItem([])]));
  }

  const { required, optional, unreadDeclarations } = templateDeclarations(template.descriptor, template.placeholders);
  const declared = new Set([...required, ...optional]);
  const isOwn = ownPaths(template.descriptor);
  const isInterfacePath = (requestPath: string) => !isOwn(requestPath) && index.loaded && mapPath(requestPath, false, index.patterns).outcome !== 'not-in-index';
  const { sites, fileCount, kotlinFiles } = outboundRequests(evidence.snapshot.files, isInterfacePath);
  const gateway = new Set(sites.filter(site => site.requestPath?.startsWith('_/')));
  const own = new Set(sites.filter(site => site.requestPath !== undefined && !gateway.has(site) && isOwn(site.requestPath)));
  const counted = sites.filter(site => !gateway.has(site) && !own.has(site));
  const mapped = counted.map(site => mapSite(site, index));
  const uses = (filter: (id: string) => boolean): B002InterfaceUse[] => {
    const byId = new Map<string, B002MappedSite[]>();
    for (const site of mapped.filter(item => item.outcome === 'interface' && filter(item.interfaces[0]))) {
      byId.set(site.interfaces[0], [...byId.get(site.interfaces[0]) ?? [], site]);
    }
    return [...byId.entries()].map(([id, sitesOfId]) => ({ id, sites: sitesOfId })).sort((a, b) => a.id.localeCompare(b.id));
  };
  const undeclared = uses(id => !declared.has(id));
  const declaredAndUsed = uses(id => declared.has(id));
  const used = new Set(declaredAndUsed.map(use => use.id));
  const unresolvedSites = mapped.filter(site => ['unresolved', 'dynamic', 'ambiguous'].includes(site.outcome));
  const notInIndexSites = mapped.filter(site => site.outcome === 'not-in-index');
  const libraries = requestingLibraries(evidence);
  const facts: Partial<B002Analysis> = {
    templatePath: template.path,
    declared: { required, optional },
    unreadDeclarations,
    ...(s008 ? { s008: s008Difference(s008, declared) } : {}),
    productionFileCount: fileCount,
    siteCount: counted.length,
    gatewaySiteCount: gateway.size,
    ownSiteCount: own.size,
    undeclared,
    declaredAndUsed,
    declaredNotSeen: [...declared].filter(id => !used.has(id)).sort(),
    unresolvedSites,
    notInIndexSites,
    libraries,
    kotlinFiles
  };

  const reasons: string[] = [];
  if (unresolvedSites.length) reasons.push(`${count(unresolvedSites.length, 'request')} could not be mapped to one interface`);
  if (notInIndexSites.length) reasons.push(`${count(notInIndexSites.length, 'request')} ${notInIndexSites.length === 1 ? 'goes' : 'go'} to a path that is not in the handler index`);
  if (!index.loaded) reasons.push('the handler index could not be loaded');
  if (unreadDeclarations.length) reasons.push(`${entries(unreadDeclarations.length)} of requires or optional could not be read`);
  if (sourceDiagnostics.length) reasons.push('not all production source could be read');
  if (kotlinFiles.length) reasons.push(`${count(kotlinFiles.length, 'source file')} ${kotlinFiles.length === 1 ? 'is' : 'are'} Kotlin, which the tool does not read`);
  if (libraries.length) {
    const names = unique(libraries.map(library => library.artifactId));
    reasons.push(`the module uses ${listText(names)}, which ${names.length === 1 ? 'sends' : 'send'} requests of ${names.length === 1 ? 'its' : 'their'} own the tool does not see`);
  }

  const status = undeclared.length || reasons.length ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  const firstSite = (use: B002InterfaceUse) => `${reportText(use.id)} (${siteLabel(use.sites[0])} at ${reportPath(use.sites[0].path)}:${use.sites[0].line})`;
  const summary = undeclared.length
    ? `The module sends requests to ${count(undeclared.length, 'interface')} its descriptor declares in neither requires nor optional: ${listText(undeclared.map(firstSite))}.`
      + `${reasons.length ? ` Also, ${listText(reasons)}.` : ''} This is not a fail: a reviewer must check that each request is made, and if so declare its interface.`
    : reasons.length
      ? `Every request the tool could map goes to an interface the module's descriptor declares, but ${listText(reasons)}.`
      : counted.length
        ? `Every request the tool found in the module's code goes to an interface its descriptor declares in requires or optional (${count(counted.length, 'request')} to ${count(used.size, 'interface')}).`
        : 'The tool found no requests to other modules\' interfaces in the module\'s code.';
  return result(status, 'requests-checked', summary, checklistItems({ ...base, ...facts } as B002Analysis), facts);
}

function indexSummary(index: F001IndexLoad): B002Analysis['index'] {
  return index.loaded
    ? { loaded: true, descriptorVersion: index.index.baseline.descriptorVersion, platformCommit: index.index.baseline.platformCommit,
      interfaceCount: unique(index.patterns.map(pattern => pattern.interfaceId)).length }
    : { loaded: false, problem: index.problem };
}

/**
 * A path that is not a handler itself is a client's base path, which the client extends, as mod-circulation's
 * collection clients do (`/automated-patron-blocks` for `/automated-patron-blocks/{id}`): it maps as the path with one
 * more parameter segment, or else as a path the code continues.
 */
function mapSite(site: BackendRequestSite, index: F001IndexLoad): B002MappedSite {
  if (site.requestPath === undefined) return { ...site, outcome: 'unresolved', interfaces: [] };
  if (!index.loaded) return { ...site, outcome: 'unresolved', interfaces: [], unresolved: 'the handler index could not be loaded' };
  return { ...site, ...mapPath(site.requestPath, !!site.openEnd, index.patterns) };
}

function mapPath(requestPath: string, openEnd: boolean, patterns: F001Pattern[]): ReturnType<typeof mapRequestPath> {
  const mapped = mapRequestPath(requestPath, openEnd, patterns);
  if (mapped.outcome !== 'not-in-index' || openEnd) return mapped;
  const withId = mapRequestPath(`${requestPath}/{}`, false, patterns);
  return withId.outcome === 'interface' ? withId : mapRequestPath(`${requestPath}/`, true, patterns);
}

/** The interface ids in the template's requires and optional, and the entries whose id is not known. */
function templateDeclarations(descriptor: unknown, placeholders: BackendPlaceholder[]) {
  const unresolvedPointers = new Set(placeholders.filter(placeholder => placeholder.value === undefined).flatMap(placeholder => placeholder.pointers));
  const unreadDeclarations: string[] = [];
  const ids = (field: 'requires' | 'optional') => {
    const list = isRecord(descriptor) ? descriptor[field] : undefined;
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
      unreadDeclarations.push(`/${field}`);
      return [];
    }
    return list.flatMap((entry, position) => {
      const pointer = `/${field}/${position}`;
      if (!isRecord(entry) || typeof entry.id !== 'string' || unresolvedPointers.has(`${pointer}/id`)) {
        unreadDeclarations.push(pointer);
        return [];
      }
      return [entry.id];
    });
  };
  return { required: unique(ids('requires')).sort(), optional: unique(ids('optional')).sort(), unreadDeclarations };
}

/**
 * Matchers for the paths the module serves, which it may also call through Okapi: its descriptor's handlers, system
 * interfaces included, and /admin/health. A handler that starts with a parameter or a wildcard would cover any path
 * and is left out; a handler with Okapi's `*` covers every path that starts with the text before it. A request whose
 * first segment is unknown, or whose first segment more than MAX_OWN_HANDLERS handlers share, is not own.
 */
function ownPaths(descriptor: unknown): (requestPath: string) => boolean {
  const provides = isRecord(descriptor) && Array.isArray(descriptor.provides) ? descriptor.provides.filter(isRecord) : [];
  const handlerPaths = provides.flatMap(provided => (Array.isArray(provided.handlers) ? provided.handlers.filter(isRecord) : [])
    .flatMap(handler => typeof handler.pathPattern === 'string' ? [handler.pathPattern] : typeof handler.path === 'string' ? [`${handler.path}*`] : []));
  const byFirstSegment = new Map<string, Array<(requestPath: string) => boolean>>();
  const firstSegmentPrefixes = new Set<string>();
  for (const path of unique([...handlerPaths, HEALTH_ROUTE]).filter(path => /^\/[^/{*][^/{]*(?:\/|$)/.test(path))) {
    const first = path.slice(1).split('/')[0];
    if (first.includes('*')) firstSegmentPrefixes.add(first.slice(0, first.indexOf('*')));
    else if (byFirstSegment.has(first)) byFirstSegment.get(first)!.push(ownMatcher(path));
    else byFirstSegment.set(first, [ownMatcher(path)]);
  }
  const prefixLengths = [...new Set([...firstSegmentPrefixes].map(prefix => prefix.length))];
  return requestPath => {
    const first = requestPath.split('/', 1)[0];
    if (first === '{}') return false;
    return prefixLengths.some(length => length <= first.length && firstSegmentPrefixes.has(first.slice(0, length)))
      || (byFirstSegment.get(first)?.length ?? 0) <= MAX_OWN_HANDLERS && (byFirstSegment.get(first) ?? []).some(matches => matches(requestPath));
  };
}

function ownMatcher(pattern: string): (requestPath: string) => boolean {
  const star = pattern.indexOf('*');
  const segments = (star < 0 ? pattern : pattern.slice(0, star)).slice(1).split('/');
  const partial = star < 0 ? undefined : segments.pop()!;
  const segmentMatches = (expected: string, actual: string) => actual === '{}' || expected.includes('{') || expected === actual;
  return requestPath => {
    const actual = requestPath.split('/');
    if (partial === undefined ? actual.length !== segments.length : actual.length <= segments.length) return false;
    if (!segments.every((expected, position) => segmentMatches(expected, actual[position]))) return false;
    if (partial === undefined) return true;
    const next = actual[segments.length];
    return next === '{}' || next.startsWith(partial);
  };
}

function requestingLibraries(evidence: BackendEvidence): B002Analysis['libraries'] {
  return evidence.snapshot.files.filter(file => BUILD_FILE.test(file.path)).flatMap(file => REQUESTING_LIBRARIES
    .filter(artifactId => new RegExp(`<artifactId>\\s*${artifactId}\\s*</artifactId>|['"]org\\.folio:${artifactId}:`).test(file.content))
    .map(artifactId => ({ artifactId, path: file.path })));
}

function s008Difference(s008: S008DeclarationResult, declared: Set<string>): NonNullable<B002Analysis['s008']> {
  const ids = new Set(s008.declarations.map(declaration => declaration.id));
  return {
    sourcePaths: s008.sourcePaths,
    onlyInS008: [...ids].filter(id => !declared.has(id)).sort(),
    onlyInTemplate: [...declared].filter(id => !ids.has(id)).sort(),
    unusableEntryCount: s008.diagnostics.filter(diagnostic => /#\/?(?:requires|optional)/.test(diagnostic.path ?? '')).length
  };
}

function siteLabel(site: BackendRequestSite): string {
  const target = site.requestPath !== undefined ? `/${site.requestPath}${site.openEnd ? '…' : ''}` : site.expression;
  return reportText(`${site.method ? `${site.method} ` : ''}${target}`);
}

function siteNote(site: B002MappedSite): string {
  if (site.outcome === 'unresolved') return `${reportText(site.expression)}: ${reportText(site.unresolved ?? 'the path could not be read')}`;
  if (site.outcome === 'ambiguous') return `${siteLabel(site)} matches equally specific paths of ${listText(site.interfaces.map(reportText))}`;
  if (site.outcome === 'dynamic') return `${siteLabel(site)}: run-time parts could reach ${listText(site.interfaces.map(reportText))}`;
  return siteLabel(site);
}

function declarationsItem(startingPoints: FrontendChecklistItem['startingPoints']): FrontendChecklistItemDraft {
  return {
    id: 'B002-C4',
    title: 'The module descriptor declares each interface the module calls in requires, or in optional when the module works without it.',
    startingPoints,
    reviewerOnly: true,
    obligations: [],
    subjects: []
  };
}

function checklistItems(analysis: B002Analysis): FrontendChecklistItem[] {
  const items: FrontendChecklistItemDraft[] = [];
  const at = (site: B002MappedSite) => ({ path: site.path, line: site.line });
  if (analysis.undeclared.length) {
    items.push({
      id: 'B002-C1',
      title: 'Each interface under "Used but not declared" is called from code that runs, and is declared in requires, or in optional when the module works without it.',
      startingPoints: analysis.undeclared.flatMap(use => use.sites.map(site => ({ ...at(site), note: `${reportText(use.id)}: ${siteLabel(site)}` }))),
      reviewerOnly: false,
      obligations: [],
      subjects: analysis.undeclared.map(use => ({ subject: `interface ${use.id}`, ...at(use.sites[0]), flag: 'manual' as const }))
    });
  }
  const unread = [
    ...analysis.sourceDiagnostics.flatMap(diagnostic => diagnostic.path ? [{ path: diagnostic.path, note: reportText(diagnostic.message) }] : []),
    ...analysis.kotlinFiles.map(path => ({ path, note: 'Kotlin, which the tool does not read' }))
  ];
  if (analysis.unresolvedSites.length || analysis.notInIndexSites.length || analysis.sourceDiagnostics.length || analysis.kotlinFiles.length) {
    const firstPaths = firstBy(analysis.notInIndexSites, site => site.requestPath!);
    items.push({
      id: 'B002-C2',
      title: 'Each request the tool could not map to one interface, or whose path is not in the handler index, goes to an interface the descriptor declares, or to a service outside FOLIO.',
      startingPoints: [
        ...analysis.unresolvedSites.map(site => ({ ...at(site), note: siteNote(site) })),
        ...analysis.notInIndexSites.map(site => ({ ...at(site), note: `${siteLabel(site)}: not in the handler index` })),
        ...unread
      ],
      reviewerOnly: false,
      obligations: [],
      subjects: [
        ...analysis.unresolvedSites.map(site => ({ subject: `${site.requestPath !== undefined ? `/${site.requestPath}` : site.expression}`, ...at(site) })),
        ...firstPaths.map(site => ({ subject: `/${site.requestPath}${site.openEnd ? '…' : ''}`, ...at(site) }))
      ]
    });
  }
  if (analysis.libraries.length) {
    items.push({
      id: 'B002-C3',
      title: 'Requests made through FOLIO libraries go to interfaces the descriptor declares.',
      startingPoints: analysis.libraries.map(library => ({ path: library.path, note: `${library.artifactId} sends requests of its own` })),
      reviewerOnly: true,
      obligations: [],
      subjects: []
    });
  }
  if (analysis.unreadDeclarations.length) {
    items.push(declarationsItem(analysis.unreadDeclarations.map(pointer => ({ path: analysis.templatePath!, note: `${pointer}: no interface id the tool can read` }))));
  }
  return numberBackendObligations(items);
}

function entries(value: number): string {
  return `${value} ${value === 1 ? 'entry' : 'entries'}`;
}

function firstBy<T>(items: T[], key: (item: T) => string): T[] {
  const first = new Map<string, T>();
  for (const item of items) if (!first.has(key(item))) first.set(key(item), item);
  return [...first.values()];
}

export function renderB002HumanDetails(analysis: B002Analysis, agentReview?: CriterionAgentReviewResult): string {
  const reviewLines = frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason);
  if (analysis.basis === 'library') return '';
  if (analysis.basis === 'no-descriptor') {
    return ['What to do:', '  - Commit the module descriptor template, with the interfaces the module calls in requires or optional (see B001).',
      ...reviewLines].join('\n');
  }
  const mappedCount = [...analysis.undeclared, ...analysis.declaredAndUsed].reduce((total, use) => total + use.sites.length, 0);
  const all = [...analysis.undeclared, ...analysis.declaredAndUsed].flatMap(use => use.sites).concat(analysis.unresolvedSites, analysis.notInIndexSites);
  const springCount = all.filter(site => site.kind === 'spring-client').length;
  const notCounted = [
    ...(analysis.ownSiteCount ? [`${count(analysis.ownSiteCount, 'request')} to the module's own paths`] : []),
    ...(analysis.gatewaySiteCount ? [`${count(analysis.gatewaySiteCount, 'request')} to Okapi's own _/ endpoints`] : [])
  ];
  const s008 = analysis.s008;
  const lines = [
    'What the tool found:',
    `  - Requests: ${count(analysis.siteCount, 'request')} in production code (Spring HTTP clients ${springCount}, paths in code ${analysis.siteCount - springCount}); `
      + `${mappedCount} mapped to an interface${notCounted.length ? `; ${listText(notCounted)} not counted` : ''}`,
    `  - Declared interfaces: ${analysis.declared.required.length} in requires and ${analysis.declared.optional.length} in optional of ${reportPath(analysis.templatePath!)}`,
    ...(analysis.declaredAndUsed.length ? [`  - Declared and used: ${analysis.declaredAndUsed.map(use => reportText(use.id)).join(', ')}`] : []),
    ...(analysis.declaredNotSeen.length ? [`  - Declared but not seen (not a problem): ${analysis.declaredNotSeen.map(reportText).join(', ')}`] : []),
    ...(s008 && (s008.onlyInS008.length || s008.onlyInTemplate.length) ? [`  - S008 reads ${listText(s008.sourcePaths.map(reportPath))}, whose declared interfaces differ (information only): `
      + `${listText([...(s008.onlyInS008.length ? [`only S008 has ${listText(s008.onlyInS008.map(reportText))}`] : []),
        ...(s008.onlyInTemplate.length ? [`only the template has ${listText(s008.onlyInTemplate.map(reportText))}${s008.unusableEntryCount ? ` (S008 could not use ${entries(s008.unusableEntryCount)})` : ''}`] : [])])}`] : []),
    `  - Handler index: ${analysis.index.loaded
      ? `interface paths of ${reportText(analysis.index.descriptorVersion ?? '')} (platform-lsp ${(analysis.index.platformCommit ?? '').slice(0, 7)}), ${count(analysis.index.interfaceCount ?? 0, 'interface')}`
      : `not loaded: ${reportText(analysis.index.problem ?? '')}`}`,
    `  - Production source: ${count(analysis.productionFileCount, 'Java or Groovy file')} under src/main and grails-app`,
    ...(agentReview ? [`  - Agent review scope: ${backendBrowse().scope}`] : [])
  ];
  const siteRow = (site: B002MappedSite, note: string) => `  - ${reportPath(site.path)}:${site.line} — ${note}`;
  if (analysis.undeclared.length) {
    lines.push('Used but not declared:');
    for (const use of analysis.undeclared) {
      lines.push(`  - ${reportText(use.id)}:`, ...use.sites.slice(0, SHOWN_SITES_PER_INTERFACE).map(site => `  ${siteRow(site, `requests ${siteLabel(site)}`)}`),
        ...overflowLine(use.sites.length, SHOWN_SITES_PER_INTERFACE, '    '));
    }
  }
  const siteRows = (heading: string, sites: B002MappedSite[]) => {
    if (!sites.length) return;
    lines.push(heading, ...sites.slice(0, SHOWN_SITES).map(site => siteRow(site, siteNote(site))), ...overflowLine(sites.length, SHOWN_SITES, '  '));
  };
  siteRows('Requests the tool could not map to one interface:', analysis.unresolvedSites);
  siteRows('Paths not in the handler index:', analysis.notInIndexSites);
  const unread = [
    ...analysis.unreadDeclarations.map(pointer => `  - ${reportPath(analysis.templatePath!)} — ${pointer}: no interface id the tool can read`),
    ...analysis.sourceDiagnostics.map(diagnostic => `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`),
    ...analysis.kotlinFiles.slice(0, SHOWN_SITES).map(path => `  - ${reportPath(path)} — Kotlin, which the tool does not read`),
    ...overflowLine(analysis.kotlinFiles.length, SHOWN_SITES, '  ')
  ];
  if (unread.length) lines.push('What the tool could not read:', ...unread);
  if (analysis.status === EvaluationStatus.MANUAL) {
    lines.push('What to do:', analysis.undeclared.length
      ? '  - Add each interface under "Used but not declared" to requires, or to optional when the module works without it, unless the code that sends the request never runs.'
      : '  - Check that each request listed above goes to an interface in requires or optional, starting with the checklist below.');
  }
  lines.push(...reviewLines);
  return lines.join('\n');
}
