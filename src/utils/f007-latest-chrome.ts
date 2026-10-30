import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  F007Analysis,
  F007BrowserApi,
  F007BrowserslistOverride,
  F007Polyfill,
  F007UserAgentRead,
  UiRuntimeEvidence,
  UiRuntimePage
} from '../types';
import { CommittedSourceSnapshot, readCommittedSource } from './committed-source';
import { FRONTEND_AGENT_OBLIGATION_LIMIT, frontendChecklist, frontendReviewLines, SHOWN_STARTING_POINTS } from './frontend-checklist';
import { FRONTEND_BROWSE_SCOPE, numberObligations } from './frontend-agent-review';
import { FrontendSource, FrontendSourceFile, frontendUiPresence, lineOf, RENDERS_NO_UI } from './frontend-source';
import { count, overflowLine, reportPath, reportText } from './report-text';
import { isRecord } from './type-guards';
import { consoleErrorCount, failedRequestCount, runtimeCollected, runtimeEvidenceLines } from './ui-runtime-report';

const DEFAULT_API_LIST_PATH = path.resolve(__dirname, '../../config/f007-browser-apis.json');
const BROWSERSLIST_FILES = new Set(['.browserslistrc', 'browserslist']);
const SHIPPED_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies'];
const WRITTEN_QUERIES_LIMIT = 200;

type RemovedApiForm = 'global' | 'member' | 'event';

interface RemovedApi {
  name: string;
  forms: RemovedApiForm[];
  receivers?: string[];
  api: string;
  removedIn: string;
  source: string;
}

interface VendorPrefix {
  property: string;
  interface: string;
  browsers: string;
}

export interface F007BrowserApiList {
  retrievedAt: string;
  userAgentProperties: string[];
  vendorPrefixes: VendorPrefix[];
  removedFromChrome: RemovedApi[];
  polyfillPackages: string[];
  polyfillNamesContaining: string;
}

/** The pinned list of browser-specific JavaScript in `config/f007-browser-apis.json`. */
export function loadF007BrowserApis(file = DEFAULT_API_LIST_PATH): F007BrowserApiList {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string' && item !== '');
  const forms = new Set<unknown>(['global', 'member', 'event']);
  const isRemoved = (entry: unknown): entry is RemovedApi => isRecord(entry) && typeof entry.name === 'string' && entry.name !== ''
    && strings(entry.forms) && entry.forms.length > 0 && entry.forms.every(form => forms.has(form))
    && (entry.receivers === undefined || strings(entry.receivers))
    && ['api', 'removedIn', 'source'].every(field => typeof entry[field] === 'string');
  const isPrefix = (entry: unknown): entry is VendorPrefix => isRecord(entry) && typeof entry.browsers === 'string'
    && [entry.property, entry.interface].every(prefix => typeof prefix === 'string' && /^[A-Za-z]+$/.test(prefix));
  const userAgent = isRecord(value) && isRecord(value.userAgentProperties) ? value.userAgentProperties.names : undefined;
  const prefixes = isRecord(value) && isRecord(value.vendorPrefixes) ? value.vendorPrefixes.prefixes : undefined;
  const polyfills = isRecord(value) && isRecord(value.polyfills) ? value.polyfills : undefined;
  if (!isRecord(value) || typeof value.retrievedAt !== 'string' || !strings(userAgent)
    || !Array.isArray(prefixes) || !prefixes.every(isPrefix)
    || !Array.isArray(value.removedFromChrome) || !value.removedFromChrome.every(isRemoved)
    || !strings(polyfills?.packages) || typeof polyfills.namesContaining !== 'string' || polyfills.namesContaining === '') {
    throw new Error('f007-browser-apis.json must list user-agent properties, vendor prefixes, removed APIs and polyfills');
  }
  return {
    retrievedAt: value.retrievedAt,
    userAgentProperties: userAgent,
    vendorPrefixes: prefixes,
    removedFromChrome: value.removedFromChrome,
    polyfillPackages: polyfills.packages,
    polyfillNamesContaining: polyfills.namesContaining.toLowerCase()
  };
}

/** The committed browserslist files at the repository root. */
export function readF007Browserslist(repoPath: string): Promise<CommittedSourceSnapshot> {
  return readCommittedSource(repoPath, { include: file => BROWSERSLIST_FILES.has(file) });
}

export interface F007Input {
  source: FrontendSource;
  browserslistFiles: CommittedSourceSnapshot;
  apiList: F007BrowserApiList | { problem: string };
  runtime: UiRuntimeEvidence;
}

/**
 * F007 (works in the latest Chrome): not applicable when the package renders no UI (Q10), otherwise always manual,
 * since only a browser can show it. Layer 1 lists the browser-specific code a reviewer starts from: reads of
 * navigator properties that identify the browser, vendor-prefixed APIs and APIs Chrome removed (from the pinned
 * list), a browserslist override and the polyfills the package ships, and the runtime evidence when collected.
 */
export function evaluateF007({ source, browserslistFiles, apiList, runtime }: F007Input): F007Analysis {
  const presence = frontendUiPresence(source);
  const manifest = packageManifest(source.packageJson);
  const list = 'problem' in apiList ? undefined : apiList;
  const listProblem = 'problem' in apiList ? apiList.problem : undefined;
  const matchers = list && matchersOf(list);
  const scans = matchers ? source.files.map(file => scanFile(file, matchers)) : [];
  const parseErrorFiles = [...(manifest.parseError ? ['package.json'] : []), ...source.files.filter(file => file.parseError).map(file => file.path)];
  const analysis: F007Analysis = {
    criterionId: 'F007',
    status: EvaluationStatus.MANUAL,
    summary: '',
    rendersUi: presence.rendersUi,
    uiFileCount: presence.uiFiles.length,
    productionFileCount: source.files.length,
    ...(manifest.version !== undefined ? { packageVersion: manifest.version } : {}),
    app: manifest.app,
    userAgentReads: scans.flatMap(scan => scan.userAgentReads),
    browserApis: scans.flatMap(scan => scan.browserApis),
    browserslist: [...manifest.browserslist, ...browserslistFiles.files.map(file => ({ path: file.path, queries: fileQueries(file.content) }))],
    polyfills: list ? [...manifest.dependencies.filter(dependency => isPolyfill(dependency.name, list)),
      ...scans.flatMap(scan => scan.imports.filter(polyfill => isPolyfill(polyfill.name, list)))] : [],
    apiList: list
      ? { loaded: true, retrievedAt: list.retrievedAt, removedApiCount: list.removedFromChrome.length }
      : { loaded: false, removedApiCount: 0, problem: listProblem },
    runtime,
    parseErrorFiles,
    sourceDiagnostics: [...source.diagnostics, ...browserslistFiles.diagnostics],
    agentBrowseScope: '',
    checklist: { items: [] }
  };
  if (!presence.rendersUi) {
    return { ...analysis, status: EvaluationStatus.NOT_APPLICABLE, summary: `F007 not applicable: ${RENDERS_NO_UI}` };
  }
  const incomplete = !source.complete || !browserslistFiles.complete || parseErrorFiles.length > 0;
  return {
    ...analysis,
    summary: summaryText(analysis, incomplete),
    agentBrowseScope: [FRONTEND_BROWSE_SCOPE, ...f007BrowsePaths(analysis)].join(', '),
    checklist: frontendChecklist(EvaluationStatus.MANUAL, checklistItems(analysis, manifest.appStartingPoints))
  };
}

/** The browserslist files the agent may read besides the shared F00x scope. */
export function f007BrowsePaths(analysis: F007Analysis): string[] {
  return analysis.browserslist.map(override => override.path).filter(file => file !== 'package.json');
}

function summaryText(analysis: F007Analysis, incomplete: boolean): string {
  const apis = (kind: F007BrowserApi['kind']) => analysis.browserApis.filter(api => api.kind === kind).length;
  const findings = [
    ...(analysis.apiList.loaded ? [count(analysis.userAgentReads.length, 'read') + ' of navigator properties that identify the browser',
      count(apis('vendor-prefixed'), 'vendor-prefixed API use'), count(apis('removed'), 'use') + ' of APIs Chrome removed'] : []),
    analysis.browserslist.length ? count(analysis.browserslist.length, 'browserslist override') : 'no browserslist override',
    ...(analysis.apiList.loaded ? [count(analysis.polyfills.length, 'polyfill')] : [])
  ];
  return `F007 manual: Whether the module works in the latest Chrome must be checked in the browser. The tool found ${findings.join('; ')}.`
    + (analysis.apiList.loaded ? '' : ' The pinned browser API list could not be read, so browser-specific APIs and polyfills were not checked.')
    + runtimeSummary(analysis.runtime)
    + (incomplete ? ' Not all source files could be read.' : '');
}

function runtimeSummary(runtime: UiRuntimeEvidence): string {
  if (!runtimeCollected(runtime)) return '';
  const pages = runtime.pages.filter(page => page.axe);
  const loaded = pages.map(page => reportText(page.path));
  const errors = consoleErrorCount(pages);
  const failed = failedRequestCount(pages);
  return ` On the running UI (${reportText(runtime.uiOrigin ?? '')}), Chrome ${reportText(runtime.browserVersion ?? 'of an unknown version')} loaded `
    + `${loaded.length > 1 ? `${loaded.slice(0, -1).join(', ')} and ${loaded[loaded.length - 1]}` : loaded[0]}: `
    + `${errors ? count(errors, 'console error') : 'no console errors'}, ${failed ? count(failed, 'failed request') : 'no failed requests'}.`;
}

function pageCounts(page: UiRuntimePage): string {
  return `${count(consoleErrorCount([page]), 'console error')}, ${count(failedRequestCount([page]), 'failed request')}`;
}

function consoleErrorSubjects(runtime: UiRuntimeEvidence): Array<{ subject: string }> {
  const pagesByMessage = new Map<string, string[]>();
  for (const page of runtime.pages) {
    for (const message of page.consoleErrors) {
      const key = message.replace(/\s+/g, ' ').trim();
      const pages = pagesByMessage.get(key) ?? [];
      if (!pages.includes(page.path)) pages.push(page.path);
      pagesByMessage.set(key, pages);
    }
  }
  return [...pagesByMessage].map(([message, pages]) => ({ subject: `${pages.join(', ')}: ${message}` }));
}

function shareObligationLimit(items: ReturnType<typeof numberObligations>): ReturnType<typeof numberObligations> {
  const [consoleItem, codeItem] = items;
  const consoleGiven = Math.min(consoleItem.obligations.length,
    Math.max(Math.ceil(FRONTEND_AGENT_OBLIGATION_LIMIT / 2), FRONTEND_AGENT_OBLIGATION_LIMIT - codeItem.obligations.length));
  const given = [consoleGiven, FRONTEND_AGENT_OBLIGATION_LIMIT - consoleGiven];
  items.forEach((item, index) => item.obligations.forEach((obligation, position) => {
    if (position < given[index]) delete obligation.withheld;
    else obligation.withheld = true;
  }));
  return items;
}

function checklistItems(analysis: F007Analysis, appStartingPoints: AppStartingPoint[]): ReturnType<typeof numberObligations> {
  const runtime = analysis.runtime;
  const signals = signalRows(analysis);
  return shareObligationLimit(numberObligations([
    { id: 'F007-C1', title: 'The module\'s main screens load in the latest Chrome without console errors caused by the module.',
      startingPoints: [...appStartingPoints, ...runtime.pages.map(page => ({ path: page.path,
        note: page.problem ? `not loaded on the running UI: ${page.problem}` : `on the running UI: ${pageCounts(page)}` }))],
      reviewerOnly: false, obligations: [], subjects: consoleErrorSubjects(runtime) },
    { id: 'F007-C2', title: 'No code path depends on another browser or a removed Chrome API.',
      startingPoints: signals.map(({ name: _name, ...row }) => row), reviewerOnly: false, obligations: [],
      subjects: signals.map(row => ({ subject: `${row.path}${row.line ? `:${row.line}` : ''} ${row.name}`, path: row.path, ...(row.line ? { line: row.line } : {}) })) }
  ]));
}

interface SignalRow {
  path: string;
  line?: number;
  note: string;
}

function signalRows(analysis: F007Analysis): Array<SignalRow & { name: string }> {
  return [
    ...analysis.userAgentReads.map(read => ({ path: read.path, line: read.line, name: `navigator.${read.property}`, note: `navigator.${read.property} identifies the browser` })),
    ...analysis.browserApis.map(api => ({ path: api.path, line: api.line, name: api.name, note: `${api.name}${api.featureDetected ? ', feature-detected' : ''}; ${api.note}` })),
    ...analysis.browserslist.map(override => ({ path: override.path, ...(override.line ? { line: override.line } : {}), name: 'browserslist', note: `browserslist ${override.queries}` })),
    ...analysis.polyfills.map(polyfill => ({ path: polyfill.path, line: polyfill.line, name: polyfill.name,
      note: `${polyfill.via === 'dependency' ? 'polyfill package' : 'polyfill import'} ${polyfill.name}` }))
  ];
}

interface Matchers {
  userAgent: Set<string>;
  propertyPrefix: RegExp;
  interfacePrefix: RegExp;
  prefixes: VendorPrefix[];
  removedMember: Map<string, RemovedApi>;
  removedGlobal: Map<string, RemovedApi>;
  removedEvent: Map<string, RemovedApi>;
}

function matchersOf(list: F007BrowserApiList): Matchers {
  const removed = (form: RemovedApiForm) => new Map(list.removedFromChrome.filter(api => api.forms.includes(form)).map(api => [api.name, api]));
  return {
    userAgent: new Set(list.userAgentProperties),
    propertyPrefix: new RegExp(`^(?:${list.vendorPrefixes.map(prefix => prefix.property).join('|')})[A-Z]`),
    interfacePrefix: new RegExp(`^(?:${list.vendorPrefixes.map(prefix => prefix.interface).join('|')})[A-Z](?=.*[a-z])`),
    prefixes: list.vendorPrefixes,
    removedMember: removed('member'),
    removedGlobal: removed('global'),
    removedEvent: removed('event')
  };
}

interface FileScan {
  userAgentReads: F007UserAgentRead[];
  browserApis: F007BrowserApi[];
  imports: F007Polyfill[];
}

function scanFile(file: FrontendSourceFile, matchers: Matchers): FileScan {
  const sourceFile = file.sourceFile;
  const scan: FileScan = { userAgentReads: [], browserApis: [], imports: [] };
  const declared = new Set<string>();
  const globals: Array<{ node: ts.Identifier; api: Omit<F007BrowserApi, 'path' | 'line'> }> = [];
  const guards = new Map<string, number>();
  const line = (node: ts.Node) => lineOf(sourceFile, node.getStart(sourceFile));
  const api = (node: ts.Node, name: string, global: boolean): Omit<F007BrowserApi, 'path' | 'line'> | undefined => {
    const removed = (global ? matchers.removedGlobal : matchers.removedMember).get(name);
    const receivers = removed?.receivers;
    if (removed && (global || !receivers || receivers.includes(receiverName((node as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression) ?? ''))) {
      return { kind: 'removed', name, note: `${removed.api}; removed in ${removed.removedIn}`, featureDetected: featureDetected(node) };
    }
    const prefix = vendorPrefix(name, matchers);
    return prefix ? { kind: 'vendor-prefixed', name, note: `${prefix.prefix} prefix: ${prefix.browsers}`, featureDetected: featureDetected(node) } : undefined;
  };
  const featureDetected = (node: ts.Node) => (guards.get(guardKey(node as ts.Expression) ?? '') ?? 0) > 0
    || isExistenceTest(node) || isOptionalCallee(node);
  const guarded = (key: string | undefined, branch: ts.Node | undefined): void => {
    if (!branch) return;
    if (key) guards.set(key, (guards.get(key) ?? 0) + 1);
    visit(branch);
    if (key) guards.set(key, (guards.get(key) ?? 1) - 1);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      scan.imports.push({ path: file.path, line: line(node), name: node.moduleSpecifier.text, via: 'import' });
    }
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) scan.imports.push({ path: file.path, line: line(node), name: node.moduleSpecifier.text, via: 'import' });
      const clause = node.importClause;
      const named = clause?.namedBindings;
      for (const binding of [clause?.name, ...(named ? ts.isNamespaceImport(named) ? [named.name] : named.elements.map(element => element.name) : [])]) {
        if (binding) declared.add(binding.text);
      }
      return;
    }
    const declaration = node as ts.Node & { name?: ts.Node };
    if (declaration.name && ts.isIdentifier(declaration.name) && isBindingDeclaration(node)) declared.add(declaration.name.text);
    if (ts.isCallExpression(node)) {
      const specifier = requiredModule(node);
      if (specifier) scan.imports.push({ path: file.path, line: line(node), name: specifier, via: 'import' });
      const event = listenedEvent(node);
      const removed = event && matchers.removedEvent.get(event.text);
      if (removed) {
        scan.browserApis.push({ path: file.path, line: line(event), kind: 'removed', name: event.text,
          note: `${removed.api}; removed in ${removed.removedIn}`, featureDetected: false });
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isNavigator(node.initializer)) {
      for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        const name = ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : undefined;
        if (name && matchers.userAgent.has(name)) scan.userAgentReads.push({ path: file.path, line: line(element), property: name });
      }
    }
    const member = memberName(node);
    if (member !== undefined) {
      const receiver = (node as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
      if (matchers.userAgent.has(member) && isNavigator(receiver)) {
        if (!isExistenceTest(node)) scan.userAgentReads.push({ path: file.path, line: line(node), property: member });
      } else {
        const found = api(node, member, false);
        if (found) scan.browserApis.push({ path: file.path, line: line(node), ...found });
      }
    } else if (ts.isIdentifier(node) && isValueReference(node)) {
      const found = api(node, node.text, true);
      if (found) globals.push({ node, api: found });
    }
    if (ts.isIfStatement(node)) {
      visit(node.expression);
      const [whenTrue, whenFalse] = branchTests(node.expression);
      guarded(whenTrue, node.thenStatement);
      guarded(whenFalse, node.elseStatement);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition);
      const [whenTrue, whenFalse] = branchTests(node.condition);
      guarded(whenTrue, node.whenTrue);
      guarded(whenFalse, node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      visit(node.left);
      guarded(branchTests(node.left)[0], node.right);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const { node, api: found } of globals) {
    if (!declared.has(node.text)) scan.browserApis.push({ path: file.path, line: line(node), ...found });
  }
  scan.browserApis.sort((a, b) => a.line - b.line);
  return scan;
}

function vendorPrefix(name: string, matchers: Matchers): { prefix: string; browsers: string } | undefined {
  const form = matchers.propertyPrefix.test(name) ? 'property' : matchers.interfacePrefix.test(name) ? 'interface' : undefined;
  const prefix = form && matchers.prefixes.find(candidate => name.startsWith(candidate[form]));
  return form && prefix ? { prefix: prefix[form], browsers: prefix.browsers } : undefined;
}

/** `x.name`, or `x['name']` with a literal key. */
function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isElementAccessExpression(node) && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function withoutWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function receiverName(expression: ts.Expression): string | undefined {
  const receiver = withoutWrappers(expression);
  if (ts.isIdentifier(receiver)) return receiver.text;
  return memberName(receiver);
}

function isNavigator(expression: ts.Expression): boolean {
  return receiverName(expression) === 'navigator';
}

const BINDING_DECLARATIONS = new Set([ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.ClassExpression, ts.SyntaxKind.Parameter, ts.SyntaxKind.BindingElement, ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.ImportSpecifier, ts.SyntaxKind.NamespaceImport, ts.SyntaxKind.ImportEqualsDeclaration, ts.SyntaxKind.EnumDeclaration]);

function isBindingDeclaration(node: ts.Node): boolean {
  return BINDING_DECLARATIONS.has(node.kind);
}

/** An identifier that reads a value: not a declared name, a property name, a label or a type. */
function isValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node; label?: ts.Node };
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (parent.name === identifier || parent.propertyName === identifier || parent.label === identifier) return false;
  return !ts.isTypeNode(parent) && !ts.isQualifiedName(parent) && !ts.isImportSpecifier(parent) && !ts.isExportSpecifier(parent);
}

/**
 * The node only tests whether the API exists: `typeof x`, `!x`, `x == null`, `x && ...`, or
 * the whole condition of an `if`, loop or `?:`.
 */
function isExistenceTest(node: ts.Node): boolean {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent = current.parent;
  if (ts.isTypeOfExpression(parent)) return true;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === current) return true;
  if (ts.isForStatement(parent) && parent.condition === current) return true;
  if (ts.isConditionalExpression(parent) && parent.condition === current) return true;
  if (!ts.isBinaryExpression(parent)) return false;
  const operator = parent.operatorToken.kind;
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return parent.left === current;
  return isEqualityOperator(operator) && isNullish(parent.left === current ? parent.right : parent.left);
}

function isOptionalCallee(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node && !!node.parent.questionDotToken;
}

function isEqualityOperator(operator: ts.SyntaxKind): boolean {
  return [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator);
}

function isNullish(expression: ts.Expression): boolean {
  const value = withoutWrappers(expression);
  return value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined') || ts.isVoidExpression(value);
}

/**
 * The API a condition tests for, as a whole, when it is true and when it is false: `x.api`, `'api' in x`,
 * `typeof x.api !== 'undefined'` or `x.api != null`, or their negation. A compound condition tests nothing here.
 */
function branchTests(condition: ts.Expression): [string | undefined, string | undefined] {
  let expression = condition;
  let negated = false;
  for (;;) {
    if (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    else if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
      negated = !negated;
      expression = expression.operand;
    } else break;
  }
  let name: string | undefined;
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.InKeyword && (ts.isStringLiteral(expression.left) || ts.isNoSubstitutionTemplateLiteral(expression.left))) {
      name = `${receiverName(expression.right) ?? ''}.${expression.left.text}`;
    } else if (isEqualityOperator(operator)) {
      const tested = isNullish(expression.right) ? expression.left : isNullish(expression.left) ? expression.right
        : ts.isTypeOfExpression(withoutWrappers(expression.left)) && ts.isStringLiteral(expression.right) && expression.right.text === 'undefined'
          ? (withoutWrappers(expression.left) as ts.TypeOfExpression).expression : undefined;
      name = tested ? guardKey(tested) : undefined;
      const positive = operator === ts.SyntaxKind.ExclamationEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (!positive) negated = !negated;
    }
  } else {
    name = guardKey(expression);
  }
  return negated ? [undefined, name] : [name, undefined];
}

/** `api` for a global, `x.api` for a member of `x` or of `y.x`. */
function guardKey(expression: ts.Expression): string | undefined {
  const value = withoutWrappers(expression);
  if (ts.isIdentifier(value)) return value.text;
  const member = memberName(value);
  return member === undefined ? undefined : `${receiverName((value as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression) ?? ''}.${member}`;
}

/** `require('x')` or `import('x')`. */
function requiredModule(call: ts.CallExpression): string | undefined {
  const argument = call.arguments[0];
  const isRequire = ts.isIdentifier(call.expression) && call.expression.text === 'require';
  if (!(isRequire || call.expression.kind === ts.SyntaxKind.ImportKeyword) || !argument) return undefined;
  return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument) ? argument.text : undefined;
}

/** The event name literal of `x.addEventListener('name', ...)` or `x.removeEventListener('name', ...)`. */
function listenedEvent(call: ts.CallExpression): ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | undefined {
  const method = ts.isIdentifier(call.expression) ? call.expression.text : memberName(call.expression);
  const argument = call.arguments[0];
  if ((method !== 'addEventListener' && method !== 'removeEventListener') || !argument) return undefined;
  return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument) ? argument : undefined;
}

function isPolyfill(specifier: string, list: F007BrowserApiList): boolean {
  const segments = specifier.split('/');
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  return list.polyfillPackages.includes(packageName) || specifier.toLowerCase().includes(list.polyfillNamesContaining);
}

type AppStartingPoint = { path: string; line: number; note: string };

interface PackageManifest {
  parseError: boolean;
  version?: string;
  app: F007Analysis['app'];
  appStartingPoints: AppStartingPoint[];
  browserslist: F007BrowserslistOverride[];
  dependencies: F007Polyfill[];
}

/** What F007 reads from package.json, with the line of each key. */
function packageManifest(text: string | undefined): PackageManifest {
  const manifest: PackageManifest = { parseError: false, app: { settings: false }, appStartingPoints: [], browserslist: [], dependencies: [] };
  if (!text) return manifest;
  try {
    if (!isRecord(JSON.parse(text))) return { ...manifest, parseError: true };
    return readPackageManifest(ts.parseJsonText('package.json', text), manifest);
  } catch {
    return { ...manifest, parseError: true };
  }
}

function readPackageManifest(json: ts.JsonSourceFile, manifest: PackageManifest): PackageManifest {
  const root = json.statements[0]?.expression;
  if (!root || !ts.isObjectLiteralExpression(root)) return { ...manifest, parseError: true };
  const at = (node: ts.Node) => lineOf(json, node.getStart(json));
  const version = jsonProperty(root, 'version')?.initializer;
  if (version && ts.isStringLiteral(version)) manifest.version = version.text;
  const browserslist = jsonProperty(root, 'browserslist');
  if (browserslist) manifest.browserslist.push({ path: 'package.json', line: at(browserslist), queries: jsonQueries(browserslist.initializer, json) });
  for (const field of SHIPPED_DEPENDENCY_FIELDS) {
    const dependencies = jsonProperty(root, field)?.initializer;
    if (!dependencies || !ts.isObjectLiteralExpression(dependencies)) continue;
    for (const dependency of dependencies.properties) {
      const name = jsonKey(dependency);
      if (name !== undefined) manifest.dependencies.push({ path: 'package.json', line: at(dependency), name, via: 'dependency' });
    }
  }
  const stripes = jsonProperty(root, 'stripes')?.initializer;
  if (!stripes || !ts.isObjectLiteralExpression(stripes)) return manifest;
  const stringValue = (name: string) => {
    const property = jsonProperty(stripes, name);
    return property && ts.isStringLiteral(property.initializer) ? { value: property.initializer.text, line: at(property) } : undefined;
  };
  const route = stringValue('route');
  const home = stringValue('home');
  const actsAs = jsonProperty(stripes, 'actsAs');
  const settingsRole = actsAs && ts.isArrayLiteralExpression(actsAs.initializer)
    && actsAs.initializer.elements.some(role => ts.isStringLiteral(role) && role.text === 'settings') ? actsAs : undefined;
  const settings = !!settingsRole;
  manifest.app = { ...(route ? { route: route.value } : {}), ...(home ? { home: home.value } : {}), settings };
  if (route) manifest.appStartingPoints.push({ path: 'package.json', line: route.line, note: `route ${route.value}` });
  if (home) manifest.appStartingPoints.push({ path: 'package.json', line: home.line, note: `home ${home.value}` });
  if (settingsRole && route) manifest.appStartingPoints.push({ path: 'package.json', line: at(settingsRole), note: `settings /settings${route.value}` });
  return manifest;
}

function jsonKey(property: ts.ObjectLiteralElementLike): string | undefined {
  return ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) ? property.name.text : undefined;
}

function jsonProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.filter((property): property is ts.PropertyAssignment => jsonKey(property) === name).pop();
}

function jsonQueries(value: ts.Expression, json: ts.JsonSourceFile): string {
  const text = (node: ts.Expression): string => ts.isStringLiteral(node) ? node.text
    : ts.isArrayLiteralExpression(node) ? node.elements.map(text).join(', ')
      : ts.isObjectLiteralExpression(node) ? node.properties.map(property => ts.isPropertyAssignment(property)
        ? `${jsonKey(property) ?? '?'}: ${text(property.initializer)}` : '?').join('; ')
        : node.getText(json);
  return shortened(text(value));
}

function fileQueries(content: string): string {
  return shortened(content.split('\n').map(row => row.replace(/#.*/, '').trim()).filter(Boolean).join(', '));
}

function shortened(queries: string): string {
  return queries.length > WRITTEN_QUERIES_LIMIT ? `${queries.slice(0, WRITTEN_QUERIES_LIMIT - 3)}...` : queries || '(empty)';
}

export function renderF007HumanDetails(analysis: F007Analysis, agentReview?: CriterionAgentReviewResult): string {
  if (analysis.status === EvaluationStatus.NOT_APPLICABLE) {
    return [
      'What the tool found:',
      `  - Production source: ${count(analysis.productionFileCount, 'file')} in src/, lib/ and the repository root; none renders an HTML element or text`,
      '  - Translations: no translations/ directory'
    ].join('\n');
  }
  const app = analysis.app;
  const rows = (items: SignalRow[]) => [...items.slice(0, SHOWN_STARTING_POINTS).map(row =>
    `    - ${reportPath(row.path)}${row.line ? `:${row.line}` : ''} — ${reportText(row.note)}`), ...overflowLine(items.length, SHOWN_STARTING_POINTS, '    ')];
  const apis = (kind: F007BrowserApi['kind']) => analysis.browserApis.filter(api => api.kind === kind);
  const apiLine = (label: string, kind: F007BrowserApi['kind']) => {
    const found = apis(kind);
    const detected = found.filter(api => api.featureDetected).length;
    return [`  - ${label}: ${found.length ? `${count(found.length, 'use')}${detected ? `, ${detected} feature-detected` : ''}` : 'none found'}`,
      ...rows(found.map(item => ({ path: item.path, line: item.line, note: `${item.name}${item.featureDetected ? ', feature-detected' : ''}; ${item.note}` })))];
  };
  const list = analysis.apiList;
  const lines = [
    'What the tool found:',
    `  - App: ${app.route ? `route ${reportText(app.route)}` : 'no stripes.route in package.json'}${app.home ? `; home ${reportText(app.home)}` : ''}`
      + (app.settings && app.route ? `; settings /settings${reportText(app.route)}` : ''),
    ...(list.loaded ? [
      `  - User-agent sniffing: ${analysis.userAgentReads.length ? count(analysis.userAgentReads.length, 'read') + ' of navigator properties that identify the browser' : 'none found'}`,
      ...rows(analysis.userAgentReads.map(read => ({ path: read.path, line: read.line, note: `navigator.${read.property}` }))),
      ...apiLine('Vendor-prefixed APIs', 'vendor-prefixed'),
      ...apiLine('APIs Chrome removed', 'removed')
    ] : []),
    `  - Browserslist: ${analysis.browserslist.length ? count(analysis.browserslist.length, 'override') + ' of the platform build\'s browser targets' : 'no override; the platform build\'s browser targets apply'}`,
    ...rows(analysis.browserslist.map(override => ({ path: override.path, line: override.line, note: override.queries }))),
    ...(list.loaded ? [
      `  - Polyfills: ${analysis.polyfills.length ? count(analysis.polyfills.length, 'polyfill') : 'none'} in dependencies, peerDependencies or production imports`,
      ...rows(analysis.polyfills.map(polyfill => ({ path: polyfill.path, line: polyfill.line, note: `${polyfill.name} (${polyfill.via})` })))
    ] : []),
    `  - Production source: ${count(analysis.productionFileCount, 'file')} in src/, lib/ and the repository root (tests, stories and examples excluded); `
      + `${count(analysis.uiFileCount, 'file')} ${analysis.uiFileCount === 1 ? 'renders' : 'render'} HTML elements or text`,
    `  - Browser API list: ${list.loaded ? `config/f007-browser-apis.json, retrieved ${list.retrievedAt}, ${count(list.removedApiCount, 'removed API')}`
      : reportText(list.problem ?? 'not loaded')}`,
    ...(agentReview ? [`  - Agent review scope: ${reportText(analysis.agentBrowseScope)}`] : []),
    ...runtimeEvidenceLines(analysis.runtime, analysis.packageVersion, {
      notConfigured: '--ui-runtime-url and --ui-runtime-login-origin load the module\'s pages on a running FOLIO UI in Chrome and record its console errors',
      pageResult: page => `${pageCounts(page)}${page.source === 'about' ? '; read for the deployed version' : ''}`
    })
  ];
  const unread = [...analysis.sourceDiagnostics.map(diagnostic => `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`),
    ...analysis.parseErrorFiles.map(file => `  - ${reportPath(file)} — does not parse cleanly`)];
  if (unread.length) lines.push('What the tool could not read:', ...unread);
  lines.push('What to do:', '  - Open the module\'s main screens in the latest Chrome with the developer tools console open, and check the items below; '
    + 'F007 is always decided by a reviewer.');
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}
