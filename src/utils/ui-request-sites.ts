import * as ts from 'typescript';
import { posix } from 'path';
import { EvaluationRun, UiRequestSite, UiRequestSiteKind, UiRequestSites } from '../types';
import { FrontendSource, FrontendSourceFile, getFrontendSource, lineOf } from './frontend-source';

/** The run's request sites, read once from the frontend source and shared by F001 and, later, S010. */
export function getUiRequestSites(run: EvaluationRun, repoPath: string): Promise<UiRequestSites> {
  return run.getOrCreateArtifact('uiRequestSites', async () => extractUiRequestSites(await getFrontendSource(run, repoPath)));
}

const KY_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);
const MANIFEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
// Constants are followed through at most this many declarations, imports and re-exports.
const MAX_DEPTH = 8;
// A segment the code fills in at run time, and one whose value comes from somewhere the tool cannot read.
const DYNAMIC = '\u0001';
const UNRESOLVED = '\u0002';

/**
 * Part of a path value: fixed text, or something only known at run time. `unresolved` says why a value that is
 * probably part of the path (an imported constant) could not be read; `okapiUrl` marks the Okapi URL prefix of a fetch.
 */
type Part = string | { dynamic: true; unresolved?: string; okapiUrl?: true };

type Resolved =
  | { kind: 'value'; node: ts.Expression; file: FrontendSourceFile }
  | { kind: 'function'; node: ts.FunctionLikeDeclaration; file: FrontendSourceFile }
  /** A namespace import (`import * as api from './api'`): property access looks inside the module. */
  | { kind: 'module'; file: FrontendSourceFile }
  | { kind: 'dynamic' }
  | { kind: 'unresolved'; reason: string };

/**
 * Every request a UI package's production code sends to the backend: stripes-connect manifest resources of type
 * `okapi` (`path` and per-method `path`), calls on a ky instance (`useOkapiKy()`, a variable named `ky`, and
 * `.extend({ prefixUrl })` of one), and `fetch` on the Okapi URL. A path may be a string or template literal, a
 * concatenation, or a constant, object property or one-expression function from the same file or a relative import
 * inside the production source; segments the code fills in at run time become `{}`, and the query string is dropped.
 */
export function extractUiRequestSites(source: FrontendSource): UiRequestSites {
  const resolver = new PathResolver(new Map(source.files.map(file => [file.path, file])));
  const sites = source.files.flatMap(file => resolver.sitesOf(file));
  return { sites, complete: source.complete && !source.files.some(file => file.parseError) };
}

class PathResolver {
  constructor(private readonly files: Map<string, FrontendSourceFile>) {}

  sitesOf(file: FrontendSourceFile): UiRequestSite[] {
    const sites: UiRequestSite[] = [];
    const add = (node: ts.Node, kind: UiRequestSiteKind, method: string | undefined, expression: ts.Expression | undefined, prefix: Part[] = [], hops = 0): void => {
      // `id ? \`${API}/${id}\` : API` sends one of two requests; a null or undefined branch sends none.
      const value = expression && hops <= MAX_DEPTH ? unwrap(expression) : undefined;
      if (value && ts.isConditionalExpression(value)) {
        for (const branch of [value.whenTrue, value.whenFalse]) {
          if (!isNothing(branch)) add(node, kind, method, branch, prefix, hops + 1);
        }
        return;
      }
      // A stripes-connect path function sends the request each of its return statements names, if any.
      const fn = value && this.functionOf(value, file);
      const returned = fn ? returnedExpressions(fn).filter(item => !isNothing(item) && !ts.isObjectLiteralExpression(unwrap(item))) : [];
      if (returned.length) return returned.forEach(item => add(node, kind, method, item, prefix, hops + 1));
      const site: UiRequestSite = {
        path: file.path,
        line: lineOf(file.sourceFile, node.getStart(file.sourceFile)),
        kind,
        ...(method ? { method } : {}),
        expression: expression ? oneLine(expression.getText(file.sourceFile)) : '(none)'
      };
      const built = !expression ? { unresolved: 'the request names no path' }
        : fn ? { unresolved: 'the path is computed by a function that returns no path the tool can read' }
          : requestPath([...prefix, ...(prefix.length ? ['/'] : []), ...this.evaluate(expression, file, 0)]);
      if (built.external) return;
      sites.push({ ...site, ...(built.requestPath !== undefined ? { requestPath: built.requestPath } : {}),
        ...(built.openEnd ? { openEnd: true } : {}), ...(built.unresolved ? { unresolved: built.unresolved } : {}) });
    };
    const visit = (node: ts.Node): void => {
      // A manifest resource is a property of the manifest: `items: { type: 'okapi', path: ... }`.
      if (ts.isObjectLiteralExpression(node) && ts.isPropertyAssignment(node.parent) && isOkapiResource(node)) {
        const path = property(node, 'path');
        const overrides = MANIFEST_METHODS.flatMap(method => {
          const value = property(node, method);
          const override = value && ts.isObjectLiteralExpression(value) ? property(value, 'path') : undefined;
          return override ? [{ method, override }] : [];
        });
        if (path || !overrides.length) add(path ?? node, 'stripes-connect', undefined, path);
        for (const { method, override } of overrides) add(override, 'stripes-connect', method, override);
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const [first, options] = node.arguments;
        if (ts.isPropertyAccessExpression(callee) && KY_METHODS.has(callee.name.text)) {
          const prefix = this.kyPrefix(callee.expression, file, 0);
          if (prefix) add(node, 'ky', callee.name.text.toUpperCase(), first, prefix);
        } else if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'extend') {
          const prefix = this.kyPrefix(callee, file, 0);
          if (prefix) {
            add(node, 'ky', optionMethod(options), first, prefix);
          } else if (ts.isIdentifier(callee) && callee.text === 'fetch' && first) {
            const parts = this.evaluate(first, file, 0);
            if (typeof parts[0] === 'object' && parts[0].okapiUrl) add(node, 'fetch', optionMethod(options) ?? 'GET', first);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);
    return sites;
  }

  /** The prefix of the ky instance an expression is, or undefined when it is not one. */
  private kyPrefix(expression: ts.Expression, file: FrontendSourceFile, depth: number): Part[] | undefined {
    const node = unwrap(expression);
    if (depth > MAX_DEPTH) return undefined;
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'useOkapiKy') return [];
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'extend') {
        const base = this.kyPrefix(node.expression.expression, file, depth + 1);
        if (!base) return undefined;
        const [options] = node.arguments;
        const prefixUrl = options && ts.isObjectLiteralExpression(options) ? property(options, 'prefixUrl') : undefined;
        return prefixUrl ? [...base, ...(base.length ? ['/'] : []), ...this.evaluate(prefixUrl, file, depth + 1)] : base;
      }
      return undefined;
    }
    if (!ts.isIdentifier(node)) return undefined;
    const declaration = findDeclaration(node);
    if (declaration?.kind === 'variable' && declaration.node.initializer) {
      const prefix = this.kyPrefix(declaration.node.initializer, file, depth + 1);
      if (prefix) return prefix;
    }
    // By convention a ky instance is called ky, whether it comes from useOkapiKy, a hook of the module or a parameter.
    return ['ky', 'okapiKy'].includes(node.text) ? [] : undefined;
  }

  // A stripes-connect path given as a function, inline or as a constant.
  private functionOf(node: ts.Expression, file: FrontendSourceFile): ts.FunctionLikeDeclaration | undefined {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    const resolved = ts.isIdentifier(node) ? this.resolveIdentifier(node, file, 0) : undefined;
    return resolved?.kind === 'function' ? resolved.node : undefined;
  }

  evaluate(expression: ts.Expression, file: FrontendSourceFile, depth: number): Part[] {
    const node = unwrap(expression);
    const dynamic: Part = { dynamic: true };
    if (depth > MAX_DEPTH) return [{ dynamic: true, unresolved: 'its constants refer to each other too deeply' }];
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.flatMap(span => [...this.evaluate(span.expression, file, depth), span.literal.text])]
        .filter(part => part !== '');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return [...this.evaluate(node.left, file, depth), ...this.evaluate(node.right, file, depth)];
    }
    if (ts.isIdentifier(node)) {
      if (node.text === 'okapiUrl') return [{ dynamic: true, okapiUrl: true }];
      return this.valueOf(this.resolveIdentifier(node, file, depth), depth);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'url' && /okapi$/i.test(node.expression.getText(file.sourceFile))) return [{ dynamic: true, okapiUrl: true }];
      if (!ts.isIdentifier(node.expression)) return [dynamic];
      const object = this.resolveIdentifier(node.expression, file, depth);
      if (object.kind === 'unresolved') return [{ dynamic: true, unresolved: object.reason }];
      if (object.kind === 'module') return this.valueOf(this.exported(object.file, node.name.text, depth + 1), depth);
      if (object.kind !== 'value') return [dynamic];
      const objectNode = unwrap(object.node);
      const value = ts.isObjectLiteralExpression(objectNode) ? property(objectNode, node.name.text) : undefined;
      return value ? this.evaluate(value, object.file, depth + 1) : [dynamic];
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      // A function from a package (useMemo, encodeURIComponent, a library helper) returns a run-time value.
      const callee = this.resolveIdentifier(node.expression, file, depth);
      const body = callee.kind === 'function' ? returnedExpression(callee.node) : undefined;
      // Inside the function its parameters resolve to run-time values.
      return body && callee.kind === 'function' ? this.evaluate(body, callee.file, depth + 1) : [dynamic];
    }
    return [dynamic];
  }

  private valueOf(resolved: Resolved, depth: number): Part[] {
    if (resolved.kind === 'value') return this.evaluate(resolved.node, resolved.file, depth + 1);
    if (resolved.kind === 'unresolved') return [{ dynamic: true, unresolved: resolved.reason }];
    return [{ dynamic: true }];
  }

  private resolveIdentifier(identifier: ts.Identifier, file: FrontendSourceFile, depth: number): Resolved {
    const declaration = findDeclaration(identifier);
    if (!declaration || declaration.kind === 'other') return { kind: 'dynamic' };
    if (declaration.kind === 'function') return { kind: 'function', node: declaration.node, file };
    if (declaration.kind === 'variable') {
      const initializer = declaration.node.initializer && unwrap(declaration.node.initializer);
      if (!initializer || !declaration.isConst) return { kind: 'dynamic' };
      return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
        ? { kind: 'function', node: initializer, file } : { kind: 'value', node: initializer, file };
    }
    const target = this.module(file, declaration.specifier);
    if (typeof target === 'string') return { kind: 'unresolved', reason: target };
    if (declaration.name === '*') return { kind: 'module', file: target };
    return this.exported(target, declaration.name, depth + 1);
  }

  /** What a module exports under a name, following `export { x } from` and `export * from` inside the source. */
  private exported(file: FrontendSourceFile, name: string, depth: number): Resolved {
    if (depth > MAX_DEPTH) return { kind: 'unresolved', reason: `${name} is re-exported too many times` };
    for (const statement of file.sourceFile.statements) {
      if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
        if (declaration) return this.resolveIdentifier(declaration.name as ts.Identifier, file, depth);
      }
      if (ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
        && (statement.name?.text === name || (name === 'default' && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)))) {
        return { kind: 'function', node: statement, file };
      }
      if (ts.isExportAssignment(statement) && name === 'default') {
        const value = unwrap(statement.expression);
        if (ts.isIdentifier(value)) return this.resolveIdentifier(value, file, depth + 1);
        return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? { kind: 'function', node: value, file } : { kind: 'value', node: value, file };
      }
      if (ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const element = statement.exportClause.elements.find(item => item.name.text === name);
          if (!element) continue;
          const local = (element.propertyName ?? element.name).text;
          if (!specifier) return this.topLevel(file, local, depth + 1);
          const target = this.module(file, specifier);
          return typeof target === 'string' ? { kind: 'unresolved', reason: target } : this.exported(target, local, depth + 1);
        }
        if (!statement.exportClause && specifier) {
          const target = this.module(file, specifier);
          if (typeof target === 'string') continue;
          const found = this.exported(target, name, depth + 1);
          if (found.kind !== 'unresolved' || !found.reason.startsWith('nothing named')) return found;
        }
      }
    }
    return { kind: 'unresolved', reason: `nothing named ${name} is exported by ${file.path}` };
  }

  private topLevel(file: FrontendSourceFile, name: string, depth: number): Resolved {
    for (const statement of file.sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
        if (declaration) return this.resolveIdentifier(declaration.name as ts.Identifier, file, depth);
      }
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { kind: 'function', node: statement, file };
      if (ts.isImportDeclaration(statement) && importedName(statement, name)) {
        const identifier = importBinding(statement, name)!;
        return this.resolveIdentifier(identifier, file, depth);
      }
    }
    return { kind: 'unresolved', reason: `${name} is not declared in ${file.path}` };
  }

  /** The production file a relative import names, or why it cannot be followed. */
  private module(file: FrontendSourceFile, specifier: string): FrontendSourceFile | string {
    if (!specifier.startsWith('.')) return `it is imported from ${specifier}`;
    const base = posix.normalize(posix.join(posix.dirname(file.path), specifier));
    if (base.startsWith('../') || base === '..') return `it is imported from ${specifier}, outside the repository`;
    for (const candidate of [base, ...['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].flatMap(extension => [`${base}${extension}`, `${base}/index${extension}`])]) {
      const target = this.files.get(candidate);
      if (target) return target;
    }
    return `it is imported from ${specifier}, which is not in the production source that was read`;
  }
}

type Declaration =
  | { kind: 'variable'; node: ts.VariableDeclaration; isConst: boolean }
  | { kind: 'function'; node: ts.FunctionDeclaration }
  | { kind: 'import'; specifier: string; name: string }
  | { kind: 'other' };

/** The declaration an identifier refers to, looked up through its enclosing scopes; undefined for globals. */
function findDeclaration(identifier: ts.Identifier): Declaration | undefined {
  const name = identifier.text;
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && (scope.parameters.some(parameter => bindsName(parameter.name, name)) || declaresVar(scope, name))) return { kind: 'other' };
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer
      && ts.isVariableDeclarationList(scope.initializer) && scope.initializer.declarations.some(item => bindsName(item.name, name))) return { kind: 'other' };
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindsName(scope.variableDeclaration.name, name)) return { kind: 'other' };
    const statements = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)
      ? scope.statements : undefined;
    for (const statement of statements ?? []) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return { kind: 'variable', node: declaration, isConst: (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 };
          }
          if (bindsName(declaration.name, name)) return { kind: 'other' };
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { kind: 'function', node: statement };
      if (ts.isClassDeclaration(statement) && statement.name?.text === name) return { kind: 'other' };
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const imported = importedName(statement, name);
        if (imported) return { kind: 'import', specifier: statement.moduleSpecifier.text, name: imported };
      }
    }
  }
  return undefined;
}

// The exported name a local import binding stands for: `default`, `*` for a namespace, or the named export.
function importedName(statement: ts.ImportDeclaration, local: string): string | undefined {
  const clause = statement.importClause;
  if (!clause) return undefined;
  if (clause.name?.text === local) return 'default';
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === local) return '*';
  if (bindings && ts.isNamedImports(bindings)) {
    const element = bindings.elements.find(item => item.name.text === local);
    if (element) return (element.propertyName ?? element.name).text;
  }
  return undefined;
}

function importBinding(statement: ts.ImportDeclaration, local: string): ts.Identifier | undefined {
  const clause = statement.importClause;
  if (clause?.name?.text === local) return clause.name;
  const bindings = clause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) return bindings.name;
  return bindings && ts.isNamedImports(bindings) ? bindings.elements.find(item => item.name.text === local)?.name : undefined;
}

// A `var` anywhere in a function body, even in a nested block, belongs to the whole function.
function declaresVar(fn: ts.SignatureDeclaration, name: string): boolean {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return false;
  const visit = (node: ts.Node): boolean => {
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
      if (node.declarations.some(declaration => bindsName(declaration.name, name))) return true;
    }
    return !ts.isFunctionLike(node) && (ts.forEachChild(node, visit) ?? false);
  };
  return visit(body);
}

function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(element => !ts.isOmittedExpression(element) && bindsName(element.name, name));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === kind);
}

// Every value a function returns, from return statements outside its nested functions.
function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return values;
}

// The expression a function returns when that is all it does: `id => \`users/${id}\`` or `{ return 'x'; }`.
function returnedExpression(fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  if (!fn.body) return undefined;
  if (!ts.isBlock(fn.body)) return fn.body;
  const [statement] = fn.body.statements;
  return fn.body.statements.length === 1 && ts.isReturnStatement(statement) ? statement.expression : undefined;
}

function isNothing(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined');
}

function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
  return node;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const item of object.properties) {
    const key = item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) ? item.name.text : undefined;
    if (key !== name) continue;
    if (ts.isPropertyAssignment(item)) return item.initializer;
    if (ts.isShorthandPropertyAssignment(item)) return item.name;
  }
  return undefined;
}

function isOkapiResource(object: ts.ObjectLiteralExpression): boolean {
  const type = property(object, 'type');
  return !!type && (ts.isStringLiteral(type) || ts.isNoSubstitutionTemplateLiteral(type)) && type.text === 'okapi';
}

function optionMethod(options: ts.Expression | undefined): string | undefined {
  const method = options && ts.isObjectLiteralExpression(options) ? property(options, 'method') : undefined;
  return method && (ts.isStringLiteral(method) || ts.isNoSubstitutionTemplateLiteral(method)) ? method.text.toUpperCase() : undefined;
}

/**
 * The request path from its parts: stripes-connect tokens (`%{}`, `!{}`, `?{}`, `:{}`) and run-time values become one
 * segment each (`{}`), the query string and the Okapi URL prefix are dropped, and absolute URLs to other hosts are
 * not FOLIO requests (`external`).
 */
export function requestPath(parts: Part[]): { requestPath?: string; openEnd?: boolean; unresolved?: string; external?: boolean } {
  const reasons: string[] = [];
  let text = '';
  parts.forEach((part, index) => {
    if (typeof part === 'string') text += part;
    else if (part.okapiUrl && index === 0) text += '';
    else if (part.unresolved) {
      text += UNRESOLVED;
      reasons.push(part.unresolved);
    } else text += DYNAMIC;
  });
  text = text.replace(/[%!?:]\{[^{}]*\}/g, DYNAMIC).split(/[?#]/)[0];
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text) || text.startsWith('//')) return { external: true };
  const kept = (text.match(new RegExp(UNRESOLVED, 'g')) ?? []).length;
  if (kept) return { unresolved: `part of the path could not be read: ${[...new Set(reasons.slice(0, kept))].join('; ')}` };
  const segments = text.replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '').split('/');
  if (!segments.join('').replace(new RegExp(DYNAMIC, 'g'), '')) return { unresolved: 'the whole path is computed at run time' };
  let openEnd = false;
  const shaped = segments.map((segment, index) => {
    if (!segment.includes(DYNAMIC)) return segment;
    const fixed = segment.replace(new RegExp(`${DYNAMIC}+$`), '');
    // `${ENDPOINT}${query}`: fixed text followed by a run-time value at the very end, most often a query string.
    if (index === segments.length - 1 && fixed && !fixed.includes(DYNAMIC)) {
      openEnd = true;
      return fixed;
    }
    return '{}';
  });
  return { requestPath: shaped.join('/'), ...(openEnd ? { openEnd } : {}) };
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}
