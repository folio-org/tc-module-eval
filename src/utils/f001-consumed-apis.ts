import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';
import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  F001Analysis,
  F001HandlerIndex,
  F001InterfaceUse,
  F001MappedSite,
  FrontendChecklistItem,
  S008DeclarationResult,
  UiRequestSite,
  UiRequestSites
} from '../types';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { FRONTEND_BROWSE_SCOPE, FrontendChecklistItemDraft, numberObligations } from './frontend-agent-review';
import { FrontendSource, lineOf } from './frontend-source';
import { DEFAULT_S008_CATALOG_PATHS } from './s008-catalog';
import { sha256Digest } from './repo-files';
import { count, listText, overflowLine, reportPath, reportText, unique } from './report-text';
import { escapeRegExp } from './regexp';
import { errorMessage, isRecord } from './type-guards';

const DEFAULT_F001_HANDLER_INDEX_PATH = path.resolve(__dirname, '../../config/f001-handler-index.json');
const SHOWN_SITES = 20;
const SHOWN_SITES_PER_INTERFACE = 3;

export interface F001Pattern {
  interfaceId: string;
  pathPattern: string;
  methods: string[];
  /** Matches a request path in which run-time segments are DYNAMIC: they match `{param}` and `*`, never fixed text. */
  exact: RegExp;
  /** Also lets a run-time segment stand for a fixed segment of the pattern. */
  loose: RegExp;
  /** Higher is more specific: fixed segments, then parameter segments, then fewer wildcards. */
  specificity: number[];
}

export type F001IndexLoad =
  | { loaded: true; index: F001HandlerIndex; patterns: F001Pattern[] }
  | { loaded: false; problem: string };

const DYNAMIC = '\u0001';
const loadedIndexes = new Map<string, F001IndexLoad>();

/**
 * The F001 handler index, checked against the S008 catalog it was built from: a catalog refreshed without rebuilding
 * the index would describe a different platform release, so the index then counts as not loaded.
 */
export function loadF001HandlerIndex(
  indexPath = DEFAULT_F001_HANDLER_INDEX_PATH,
  catalogPath = DEFAULT_S008_CATALOG_PATHS.official
): F001IndexLoad {
  const key = `${indexPath}\0${catalogPath}`;
  if (!loadedIndexes.has(key)) loadedIndexes.set(key, readIndex(indexPath, catalogPath));
  return loadedIndexes.get(key)!;
}

function readIndex(indexPath: string, catalogPath: string): F001IndexLoad {
  let index: F001HandlerIndex;
  let patterns: F001Pattern[];
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as F001HandlerIndex;
    if (!isRecord(index) || index.schemaVersion !== '1.0' || !Array.isArray(index.providers)) throw new Error('it is not a version 1.0 handler index');
    const digest = sha256Digest(fs.readFileSync(catalogPath, 'utf8'));
    if (index.s008Catalog?.digest !== digest) {
      throw new Error('it was built from a different S008 catalog; rebuild it with yarn build:f001-handler-index');
    }
    patterns = compilePatterns(index);
  } catch (error) {
    return { loaded: false, problem: `${path.basename(indexPath)} could not be used: ${errorMessage(error)}` };
  }
  return { loaded: true, index, patterns };
}

export function compilePatterns(index: F001HandlerIndex): F001Pattern[] {
  const seen = new Set<string>();
  return index.providers.flatMap(provider => provider.interfaces.flatMap(provided => provided.handlers.flatMap(handler => {
    const key = `${provided.id}\0${handler.pathPattern}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [compilePattern(provided.id, handler.pathPattern, handler.methods)];
  })));
}

// Okapi path patterns: `{name}` is one segment, `*` any text including slashes.
function compilePattern(interfaceId: string, pathPattern: string, methods: string[]): F001Pattern {
  const segments = pathPattern.replace(/^\//, '').split('/');
  const segmentRegex = (segment: string, loose: boolean) => {
    const exact = segment.split(/(\{[^}]*\}|\*)/).map(piece => piece === '*' ? '.*' : isParam(piece) ? '[^/]+' : escapeRegExp(piece)).join('');
    // A run-time segment could be any fixed text, including text a wildcard segment such as `settings*` accepts.
    return loose && !isParam(segment) ? `(?:${exact}|${DYNAMIC})` : exact;
  };
  const build = (loose: boolean) => new RegExp(`^${segments.map(segment => segmentRegex(segment, loose)).join('/')}$`);
  return {
    interfaceId,
    pathPattern,
    methods,
    exact: build(false),
    loose: build(true),
    specificity: [
      segments.filter(segment => !/[{*]/.test(segment)).length,
      segments.filter(isParam).length,
      -(pathPattern.match(/\*/g) ?? []).length
    ]
  };
}

function isParam(segment: string): boolean {
  return /^\{[^}]*\}$/.test(segment);
}

/**
 * The interface a request path maps to. Exact matches win, the most specific pattern first; two interfaces with
 * equally specific patterns are ambiguous. Without an exact match, the path maps to an interface only when every
 * pattern a run-time segment could complete belongs to it; otherwise it is dynamic, or not in the index. An open end
 * (`${ENDPOINT}${query}`) maps only when every pattern the path could continue into belongs to the same interface.
 */
export function mapRequestPath(requestPath: string, openEnd: boolean, patterns: F001Pattern[]): Pick<F001MappedSite, 'outcome' | 'interfaces' | 'pathPattern'> {
  const probe = requestPath.split('/').map(segment => segment === '{}' ? DYNAMIC : segment).join('/');
  const exact = patterns.filter(pattern => pattern.exact.test(probe));
  let best: F001Pattern[] = [];
  for (const pattern of exact) {
    const order = best.length ? compareSpecificity(pattern.specificity, best[0].specificity) : 1;
    if (order > 0) best = [pattern];
    else if (order === 0) best.push(pattern);
  }
  const bestInterfaces = unique(best.map(pattern => pattern.interfaceId)).sort();
  if (openEnd) {
    const prefix = new RegExp(`^/${requestPath.split('/').map(segment => segment === '{}' ? '[^/]+' : escapeRegExp(segment)).join('/')}`);
    const continuations = unique(patterns.filter(pattern => prefix.test(pattern.pathPattern)).map(pattern => pattern.interfaceId));
    const candidates = unique([...bestInterfaces, ...continuations]).sort();
    if (candidates.length === 1) return { outcome: 'interface', interfaces: candidates, ...(best[0] ? { pathPattern: best[0].pathPattern } : {}) };
    return candidates.length ? { outcome: 'dynamic', interfaces: candidates } : { outcome: 'not-in-index', interfaces: [] };
  }
  if (bestInterfaces.length === 1) return { outcome: 'interface', interfaces: bestInterfaces, pathPattern: best[0].pathPattern };
  if (bestInterfaces.length > 1) return { outcome: 'ambiguous', interfaces: bestInterfaces };
  const loose = unique(patterns.filter(pattern => pattern.loose.test(probe)).map(pattern => pattern.interfaceId)).sort();
  if (loose.length === 1) return { outcome: 'interface', interfaces: loose };
  return loose.length ? { outcome: 'dynamic', interfaces: loose } : { outcome: 'not-in-index', interfaces: [] };
}

function compareSpecificity(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Requests to Okapi's own `_/` endpoints go to the gateway, not to a module interface. */
function isGatewayPath(requestPath: string | undefined): boolean {
  return !!requestPath && requestPath.startsWith('_/');
}

export interface F001Input {
  source: FrontendSource;
  sites: UiRequestSites;
  declarations: S008DeclarationResult;
  index: F001IndexLoad;
}

/**
 * F001 (every consumed API is declared in okapiInterfaces or optionalOkapiInterfaces). Fail when a request maps to
 * exactly one interface package.json declares in neither list, for modules and libraries alike; pass when every
 * request maps to a declared interface; manual otherwise: requests the tool cannot read or map, paths not in the
 * handler index, ambiguous matches, an index that did not load, unreadable declarations or source. A proven
 * violation still fails.
 */
export function evaluateF001({ source, sites, declarations, index }: F001Input): F001Analysis {
  const required = unique(declarations.declarations.filter(item => !item.optional).map(item => item.id)).sort();
  const optional = unique(declarations.declarations.filter(item => item.optional).map(item => item.id)).sort();
  const declared = new Set([...required, ...optional]);
  // A declaration S008 cannot use (an unusual version, say) still declares its interface for F001.
  const diagnosed = new Set(declarations.diagnostics.flatMap(diagnostic => declaredIdOf(diagnostic.path)));
  const counted = sites.sites.filter(site => !isGatewayPath(site.requestPath));
  const mapped: F001MappedSite[] = counted.map(site => {
    if (site.requestPath === undefined) return { ...site, outcome: 'unresolved', interfaces: [] };
    if (!index.loaded) return { ...site, outcome: 'unresolved', interfaces: [], unresolved: 'the handler index could not be loaded' };
    return { ...site, ...mapRequestPath(site.requestPath, !!site.openEnd, index.patterns) };
  });
  const uses = (filter: (id: string) => boolean): F001InterfaceUse[] => {
    const byId = new Map<string, F001MappedSite[]>();
    for (const site of mapped.filter(item => item.outcome === 'interface' && filter(item.interfaces[0]))) {
      byId.set(site.interfaces[0], [...byId.get(site.interfaces[0]) ?? [], site]);
    }
    return [...byId.entries()].map(([id, sitesOfId]) => ({ id, sites: sitesOfId })).sort((a, b) => a.id.localeCompare(b.id));
  };
  const undeclared = uses(id => !declared.has(id) && !diagnosed.has(id));
  const declarationsKnown = declarations.diagnostics.every(diagnostic => !diagnostic.material || declaredIdOf(diagnostic.path).length > 0);
  const declaredAndUsed = uses(id => declared.has(id) || diagnosed.has(id));
  const used = new Set(declaredAndUsed.map(use => use.id));
  const unresolvedSites = mapped.filter(site => ['unresolved', 'dynamic', 'ambiguous'].includes(site.outcome));
  const notInIndexSites = mapped.filter(site => site.outcome === 'not-in-index');
  const parseErrorFiles = source.files.filter(file => file.parseError).map(file => file.path);
  const base = {
    criterionId: 'F001' as const,
    index: index.loaded
      ? { loaded: true, descriptorVersion: index.index.baseline.descriptorVersion, platformCommit: index.index.baseline.platformCommit,
        interfaceCount: unique(index.patterns.map(pattern => pattern.interfaceId)).length }
      : { loaded: false, problem: index.problem },
    declared: { required, optional },
    declarationDiagnostics: declarations.diagnostics,
    productionFileCount: source.files.length,
    siteCount: counted.length,
    gatewaySiteCount: sites.sites.length - counted.length,
    undeclared,
    declaredAndUsed,
    declaredNotSeen: [...declared].filter(id => !used.has(id)).sort(),
    unresolvedSites,
    notInIndexSites,
    libraryHooks: libraryHooks(source),
    parseErrorFiles,
    sourceDiagnostics: source.diagnostics,
    agentBrowseScope: FRONTEND_BROWSE_SCOPE
  };

  const incomplete = !sites.complete;
  const reasons: string[] = [];
  if (unresolvedSites.length) reasons.push(`${count(unresolvedSites.length, 'request')} could not be mapped to one interface`);
  if (notInIndexSites.length) reasons.push(`${count(notInIndexSites.length, 'request')} ${notInIndexSites.length === 1 ? 'goes' : 'go'} to a path that is not in the handler index`);
  if (!index.loaded) reasons.push('the handler index could not be loaded');
  if (!declarationsKnown) reasons.push('not all interface declarations in package.json could be read');
  if (incomplete) reasons.push('not all production source could be read');

  const status = undeclared.length && declarationsKnown ? EvaluationStatus.FAIL : reasons.length ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  const ids = undeclared.map(use => use.id);
  const summary = status === EvaluationStatus.FAIL
    ? `F001 fail: The module calls ${count(ids.length, 'interface')} it does not declare in package.json: ${listText(ids)}.`
      + (reasons.length ? ` Also, ${listText(reasons)}.` : '')
    : status === EvaluationStatus.MANUAL
      ? undeclared.length
        ? `F001 manual: The module calls ${count(ids.length, 'interface')} package.json does not seem to declare (${listText(ids)}), but ${listText(reasons)}.`
        : `F001 manual: Every request the tool could map goes to an interface the module declares, but ${listText(reasons)}.`
      : counted.length
        ? `F001 pass: Every request in the module's code goes to an interface it declares in package.json (${count(counted.length, 'request')} to ${count(used.size, 'interface')}).`
        : 'F001 pass: The module\'s code sends no requests to FOLIO interfaces.';
  return { ...base, status, summary, checklist: frontendChecklist(status, checklistItems(base, incomplete)) };
}

function declaredIdOf(diagnosticPath: string | undefined): string[] {
  const match = diagnosticPath && /^package\.json#\/?stripes[./](?:optionalOkapiInterfaces|okapiInterfaces)[./](.+)$/.exec(diagnosticPath);
  return match ? [match[1]] : [];
}

// Hooks from shared @folio libraries may send requests of their own, out of the tool's sight (F001-C4).
const STRIPES_PLATFORM = /^@folio\/stripes(?:-core|-components)?(?:\/(?:core|components))?$/;
function libraryHooks(source: FrontendSource): F001Analysis['libraryHooks'] {
  return source.files.flatMap(file => file.sourceFile.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const from = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!from.startsWith('@folio/') || STRIPES_PLATFORM.test(from) || !bindings || !ts.isNamedImports(bindings)) return [];
    return bindings.elements.filter(element => /^use[A-Z]/.test((element.propertyName ?? element.name).text)).map(element => ({
      path: file.path, line: lineOf(file.sourceFile, element.getStart(file.sourceFile)), name: (element.propertyName ?? element.name).text, from
    }));
  }));
}

export function siteLabel(site: UiRequestSite): string {
  const target = site.requestPath !== undefined ? `${site.requestPath}${site.openEnd ? '…' : ''}` : site.expression;
  return `${site.method ? `${site.method} ` : ''}${target}`;
}

function siteNote(site: F001MappedSite): string {
  if (site.outcome === 'unresolved') return `${site.expression}: ${site.unresolved ?? 'the path could not be read'}`;
  if (site.outcome === 'ambiguous') return `${siteLabel(site)} matches equally specific paths of ${listText(site.interfaces)}`;
  if (site.outcome === 'dynamic') return `${siteLabel(site)}: run-time parts could reach ${listText(site.interfaces)}`;
  return siteLabel(site);
}

function checklistItems(analysis: Pick<F001Analysis, 'undeclared' | 'unresolvedSites' | 'notInIndexSites' | 'libraryHooks' | 'parseErrorFiles' | 'sourceDiagnostics'>,
  incomplete: boolean): FrontendChecklistItem[] {
  const items: FrontendChecklistItemDraft[] = [];
  const at = (site: F001MappedSite) => ({ path: site.path, line: site.line });
  if (analysis.undeclared.length) {
    items.push({
      id: 'F001-C1',
      title: 'Each interface under "Used but not declared" is declared in okapiInterfaces, or in optionalOkapiInterfaces when the code checks stripes.hasInterface.',
      startingPoints: analysis.undeclared.flatMap(use => use.sites.map(site => ({ ...at(site), note: `${use.id}: ${siteLabel(site)}` }))),
      reviewerOnly: true,
      obligations: [],
      subjects: []
    });
  }
  const unread = [...analysis.sourceDiagnostics.flatMap(diagnostic => diagnostic.path ? [{ path: diagnostic.path, note: reportText(diagnostic.message) }] : []),
    ...analysis.parseErrorFiles.map(path => ({ path, note: 'does not parse cleanly' }))];
  if (analysis.unresolvedSites.length || incomplete) {
    items.push({
      id: 'F001-C2',
      title: 'Each unresolved request goes to an interface the module declares.',
      startingPoints: analysis.unresolvedSites.length ? analysis.unresolvedSites.map(site => ({ ...at(site), note: siteNote(site) })) : unread,
      reviewerOnly: false,
      obligations: [],
      subjects: analysis.unresolvedSites.map(site => ({ subject: siteLabel(site), ...at(site) }))
    });
  }
  if (analysis.notInIndexSites.length) {
    const firstUses = firstBy(analysis.notInIndexSites, site => site.requestPath!);
    items.push({
      id: 'F001-C3',
      title: 'Each path not in the handler index belongs to an interface the module declares.',
      startingPoints: analysis.notInIndexSites.map(site => ({ ...at(site), note: siteLabel(site) })),
      reviewerOnly: false,
      obligations: [],
      subjects: firstUses.map(site => ({ subject: `${site.requestPath}${site.openEnd ? '…' : ''}`, ...at(site) }))
    });
  }
  if (analysis.libraryHooks.length) {
    const firstUses = firstBy(analysis.libraryHooks, hook => `${hook.from}\0${hook.name}`);
    items.push({
      id: 'F001-C4',
      title: 'Requests made through shared-library hooks go to declared interfaces.',
      startingPoints: firstUses.map(hook => ({ path: hook.path, line: hook.line, note: `${hook.name} from ${hook.from}` })),
      reviewerOnly: true,
      obligations: [],
      subjects: []
    });
  }
  return numberObligations(items);
}

function firstBy<T>(items: T[], key: (item: T) => string): T[] {
  const first = new Map<string, T>();
  for (const item of items) if (!first.has(key(item))) first.set(key(item), item);
  return [...first.values()];
}

export function renderF001HumanDetails(analysis: F001Analysis, agentReview?: CriterionAgentReviewResult): string {
  const kinds = (['stripes-connect', 'ky', 'fetch'] as const).map(kind => [kind, [...analysis.undeclared, ...analysis.declaredAndUsed]
    .flatMap(use => use.sites).concat(analysis.unresolvedSites, analysis.notInIndexSites).filter(site => site.kind === kind).length] as const);
  const mappedCount = [...analysis.undeclared, ...analysis.declaredAndUsed].reduce((total, use) => total + use.sites.length, 0);
  const lines = [
    'What the tool found:',
    `  - Requests: ${count(analysis.siteCount, 'request')} in production code (${kinds.map(([kind, n]) => `${kind === 'stripes-connect' ? 'stripes-connect manifests' : kind} ${n}`).join(', ')}); `
      + `${mappedCount} mapped to an interface${analysis.gatewaySiteCount ? `; ${count(analysis.gatewaySiteCount, 'request')} to Okapi's own _/ endpoints not counted` : ''}`,
    `  - Declared interfaces: ${analysis.declared.required.length} in okapiInterfaces and ${analysis.declared.optional.length} in optionalOkapiInterfaces of package.json`,
    ...(analysis.declaredAndUsed.length ? [`  - Declared and used: ${analysis.declaredAndUsed.map(use => reportText(use.id)).join(', ')}`] : []),
    ...(analysis.declaredNotSeen.length ? [`  - Declared but not seen (not a problem): ${analysis.declaredNotSeen.map(reportText).join(', ')}`] : []),
    `  - Handler index: ${analysis.index.loaded
      ? `interface paths of ${reportText(analysis.index.descriptorVersion ?? '')} (platform-lsp ${(analysis.index.platformCommit ?? '').slice(0, 7)}), ${count(analysis.index.interfaceCount ?? 0, 'interface')}`
      : `not loaded: ${reportText(analysis.index.problem ?? '')}`}`,
    `  - Production source: ${count(analysis.productionFileCount, 'file')} in src/, lib/ and the repository root (tests, stories and examples excluded)`,
    ...(agentReview ? [`  - Agent review scope: ${reportText(analysis.agentBrowseScope)}`] : [])
  ];
  const siteRow = (site: F001MappedSite, note: string) => `  - ${reportPath(site.path)}:${site.line} — ${reportText(note)}`;
  if (analysis.undeclared.length) {
    lines.push('Used but not declared:');
    for (const use of analysis.undeclared) {
      lines.push(`  - ${reportText(use.id)}:`, ...use.sites.slice(0, SHOWN_SITES_PER_INTERFACE).map(site => `  ${siteRow(site, `requests ${siteLabel(site)}`)}`),
        ...overflowLine(use.sites.length, SHOWN_SITES_PER_INTERFACE, '    '));
    }
  }
  const siteRows = (heading: string, sites: F001MappedSite[]) => {
    if (!sites.length) return;
    lines.push(heading, ...sites.slice(0, SHOWN_SITES).map(site => siteRow(site, siteNote(site))), ...overflowLine(sites.length, SHOWN_SITES, '  '));
  };
  siteRows('Requests the tool could not map to one interface:', analysis.unresolvedSites);
  siteRows('Paths not in the handler index:', analysis.notInIndexSites);
  const unread = [...analysis.declarationDiagnostics.map(diagnostic => `  - ${reportText(diagnostic.message)}`),
    ...analysis.sourceDiagnostics.map(diagnostic => `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`),
    ...analysis.parseErrorFiles.map(path => `  - ${reportPath(path)} — does not parse cleanly`)];
  if (unread.length) lines.push('What the tool could not read:', ...unread);
  if (analysis.status === EvaluationStatus.FAIL) {
    lines.push('What to do:', '  - Add each interface to "okapiInterfaces" in package.json, or to "optionalOkapiInterfaces" when the code checks stripes.hasInterface first.');
  }
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}
