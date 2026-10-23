import { parseStringPromise } from 'xml2js';
import { parse as parseYarnLock } from '@yarnpkg/lockfile';

// Pure parsers for build and package files: text in, declarations out. They read no files and run no commands,
// so the S007, S009 and S012 collectors decide what to read, how much, and what a parse failure means for them.

// ---- Maven POM ----

export type PomParseResult =
  | { ok: true; project: Record<string, any> }
  | { ok: false; reason: 'invalid-xml'; message: string }
  | { ok: false; reason: 'no-project' };

export async function parsePom(content: string): Promise<PomParseResult> {
  let project: unknown;
  try {
    project = (await parseStringPromise(content, { explicitArray: false, trim: true }))?.project;
  } catch (error) {
    return { ok: false, reason: 'invalid-xml', message: error instanceof Error ? error.message : String(error) };
  }
  return project && typeof project === 'object'
    ? { ok: true, project: project as Record<string, any> }
    : { ok: false, reason: 'no-project' };
}

/** The trimmed text of an xml2js value: a string, a number, or an element with attributes ({ _: text }). */
export function xmlText(value: any): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && typeof value._ === 'string') return value._.trim();
  return '';
}

export function asArray(value: any): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** One <dependency> as written: each field is its trimmed text, or '' when absent. Properties are not resolved. */
export interface PomDependency {
  groupId: string;
  artifactId: string;
  version: string;
  scope: string;
  type: string;
  classifier: string;
}

/** The <dependency> elements of a <dependencies> value (for example project.dependencies?.dependency). */
export function pomDependencies(value: unknown): PomDependency[] {
  return asArray(value).map(dependency => ({
    groupId: xmlText(dependency?.groupId),
    artifactId: xmlText(dependency?.artifactId),
    version: xmlText(dependency?.version),
    scope: xmlText(dependency?.scope),
    type: xmlText(dependency?.type),
    classifier: xmlText(dependency?.classifier)
  }));
}

export interface RequiredMavenVersion {
  /** The <version> as written (properties are not resolved). */
  version: string;
  /**
   * Whether the rule runs in a normal build, as far as this POM shows. "active": an execution of the declared plugin
   * runs the enforce goal in a lifecycle phase and is not skipped. "inactive": this POM shows it does not run (no
   * enforce goal, phase none, skip true). "uncertain": something outside this POM decides, such as a rule only in
   * <pluginManagement> (a parent or module POM may declare the plugin) or a skip set by a property.
   */
  state: 'active' | 'inactive' | 'uncertain';
  reason?: string;
}

const MAX_ENFORCER_RULES = 64;

/**
 * The maven-enforcer-plugin requireMavenVersion rules of the POM's <build>, one per effective execution, after the
 * merges Maven does: a managed plugin's executions join the declared plugin's by id, and execution configuration
 * wins over plugin configuration (declared over managed at each level).
 */
export function pomRequiredMavenVersions(project: Record<string, any>): RequiredMavenVersion[] {
  const isEnforcer = (plugin: any) => xmlText(plugin?.artifactId) === 'maven-enforcer-plugin'
    && ['', 'org.apache.maven.plugins'].includes(xmlText(plugin?.groupId));
  const declared = asArray(project.build?.plugins?.plugin).filter(isEnforcer)[0];
  const managed = asArray(project.build?.pluginManagement?.plugins?.plugin).filter(isEnforcer)[0];
  if (!declared && !managed) return [];
  const rules = (configuration: any): string[] | undefined => {
    const versions = asArray(configuration?.rules?.requireMavenVersion).map(rule => xmlText(rule?.version)).filter(Boolean);
    return versions.length ? versions : undefined;
  };
  const skipText = (configuration: any): string | undefined => configuration?.skip === undefined ? undefined : xmlText(configuration.skip);
  const executionsById = (plugin: any) => new Map(asArray(plugin?.executions?.execution)
    .map(execution => [xmlText(execution?.id) || 'default', execution] as [string, any]));
  const declaredExecutions = executionsById(declared);
  const managedExecutions = executionsById(managed);
  const pluginRules = rules(declared?.configuration) ?? rules(managed?.configuration);
  const pluginSkip = skipText(declared?.configuration) ?? skipText(managed?.configuration)
    ?? (xmlText(project.properties?.['enforcer.skip']) || undefined);

  const result: RequiredMavenVersion[] = [];
  const add = (versions: string[], state: RequiredMavenVersion['state'], reason?: string) => {
    for (const version of versions) {
      if (result.length >= MAX_ENFORCER_RULES) return;
      result.push({ version, state, reason });
    }
  };
  const ids = [...new Set([...declaredExecutions.keys(), ...(declared || !managed ? managedExecutions.keys() : [])])];
  for (const id of ids) {
    const own = declaredExecutions.get(id);
    const inherited = managedExecutions.get(id);
    const versions = rules(own?.configuration) ?? rules(inherited?.configuration) ?? pluginRules;
    if (!versions) continue;
    const goals = [...asArray(own?.goals?.goal), ...asArray(inherited?.goals?.goal)].map(xmlText);
    const phase = xmlText(own?.phase) || xmlText(inherited?.phase);
    const skip = skipText(own?.configuration) ?? skipText(inherited?.configuration) ?? pluginSkip;
    if (!goals.includes('enforce')) add(versions, 'inactive', 'its execution does not run the enforce goal');
    else if (phase === 'none') add(versions, 'inactive', 'its execution is bound to phase none');
    else if (skip === 'true') add(versions, 'inactive', 'skip is true');
    else if (skip !== undefined && skip !== 'false') add(versions, 'uncertain', `skip is set by ${skip}`);
    else add(versions, 'active');
  }
  if (!declared) {
    // Only managed: it runs if a parent or module POM declares the plugin, which this POM does not show.
    for (const execution of managedExecutions.values()) {
      add(rules(execution?.configuration) ?? pluginRules ?? [], 'uncertain', 'set in <pluginManagement>; this POM does not declare the plugin');
    }
    if (!managedExecutions.size && pluginRules) add(pluginRules, 'uncertain', 'set in <pluginManagement>; this POM does not declare the plugin');
  } else if (!ids.length && pluginRules) {
    add(pluginRules, 'inactive', 'no execution runs the enforce goal');
  }
  return result;
}

// ---- Java .properties (gradle.properties, wrapper properties) ----

/** key=value lines; comments (# or !) and lines without "=" are skipped. Escapes are not interpreted. */
export function parseJavaProperties(content: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([^#!\s][^=]*)=(.*)$/.exec(line);
    if (match) {
      properties.set(match[1].trim(), match[2].trim());
    }
  }
  return properties;
}

// ---- package.json ----

export type PackageJsonParseResult =
  | { ok: true; manifest: Record<string, unknown> }
  | { ok: false; message: string };

/** A package.json whose root is a JSON object. */
export function parsePackageJson(content: string): PackageJsonParseResult {
  try {
    const manifest = JSON.parse(content);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('root value must be an object');
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export type PackageDependencyEntry =
  | { field: string; name: string; specifier: unknown }
  | { field: string; invalid: true };

/**
 * The entries of the given dependency fields, in field order. A present field that is not an object of names
 * yields one { invalid: true } entry. Specifiers are returned as found; callers decide what a non-string means.
 */
export function packageDependencyEntries(manifest: Record<string, unknown>, fields: readonly string[]): PackageDependencyEntry[] {
  const entries: PackageDependencyEntry[] = [];
  for (const field of fields) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      entries.push({ field, invalid: true });
      continue;
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      entries.push({ field, name, specifier });
    }
  }
  return entries;
}

// ---- yarn.lock ----

export type YarnLockfile =
  | { format: 'v1'; entries: Record<string, { version?: unknown }> }
  | { format: 'berry' }
  | { format: 'malformed'; message?: string };

/** A Yarn 1 lockfile, or the marker of a Yarn 2+ (Berry) lockfile, which has a __metadata entry. */
export function parseYarnLockfile(content: string): YarnLockfile {
  if (yarnLockfileFormat(content) === 'berry') {
    return { format: 'berry' };
  }
  try {
    const parsed = parseYarnLock(content) as { type: string; object?: Record<string, { version?: unknown }> };
    return parsed.type === 'success' && parsed.object
      ? { format: 'v1', entries: parsed.object }
      : { format: 'malformed' };
  } catch (error) {
    return { format: 'malformed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Which Yarn wrote a lockfile, from its start: Yarn 1 writes "# yarn lockfile v1", Yarn 2+ a __metadata entry. */
export function yarnLockfileFormat(content: string): 'v1' | 'berry' | undefined {
  if (/^__metadata:/m.test(content)) return 'berry';
  return /^# yarn lockfile v1\s*$/m.test(content) ? 'v1' : undefined;
}

/** The version a Yarn 1 lockfile resolves for a selector such as "react@^18.2.0". */
export function yarnLockVersion(entries: Record<string, { version?: unknown }>, selector: string): string | undefined {
  for (const [combinedSelectors, resolution] of Object.entries(entries)) {
    const selectors = combinedSelectors.split(/,\s*/).map(value => value.replace(/^"|"$/g, ''));
    if (selectors.includes(selector) && typeof resolution.version === 'string') {
      return resolution.version;
    }
  }
  return undefined;
}

// ---- Gradle build scripts ----

/** The script with comments replaced by spaces, keeping line breaks and string literals, so offsets still match. */
export function stripGradleComments(content: string): string {
  let result = '';
  let quote: "'" | '"' | "'''" | '"""' | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length;) {
    const character = content[index];
    const pair = content.slice(index, index + 2);
    const triple = content.slice(index, index + 3);
    if (lineComment) {
      result += character === '\n' ? '\n' : ' ';
      if (character === '\n') lineComment = false;
      index += 1;
      continue;
    }
    if (blockComment) {
      if (pair === '*/') {
        result += '  ';
        blockComment = false;
        index += 2;
      } else {
        result += character === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (content.startsWith(quote, index) && !isEscapedCharacter(content, index)) {
        result += quote;
        index += quote.length;
        quote = undefined;
      } else {
        result += character;
        index += 1;
      }
      continue;
    }
    if (pair === '//') {
      result += '  ';
      lineComment = true;
      index += 2;
      continue;
    }
    if (pair === '/*') {
      result += '  ';
      blockComment = true;
      index += 2;
      continue;
    }
    if (triple === "'''" || triple === '"""') {
      quote = triple;
      result += triple;
      index += 3;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    result += character;
    index += 1;
  }
  return result;
}

export function isEscapedCharacter(content: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** One dependency declaration: `configuration(expression)`, `configuration expression` or `add('configuration', expression)`. */
export interface GradleDependencyDeclaration {
  configuration: string;
  /** The argument text, unparsed. */
  expression: string;
  /** Offset of the declaration in the scanned text. */
  offset: number;
  /** Its position among the declarations of the same configuration, counting from 0. */
  index: string;
}

/** Dependency declarations for the given configurations in a build script that has had its comments stripped. */
export function scanGradleDeclarations(content: string, configurations: readonly string[]): GradleDependencyDeclaration[] {
  const declarations: GradleDependencyDeclaration[] = [];
  const counts = new Map<string, number>();
  for (let index = 0; index < content.length;) {
    if (content[index] === '"' || content[index] === "'") {
      index = skipGradleQuoted(content, index);
      continue;
    }
    if (!/[A-Za-z_]/.test(content[index])) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < content.length && /[A-Za-z0-9_]/.test(content[index])) index += 1;
    const identifier = content.slice(start, index);
    if (identifier === 'add') {
      const open = skipWhitespace(content, index);
      if (content[open] !== '(') continue;
      const call = balancedGradleCall(content, open);
      if (!call) continue;
      const args = splitGradleArguments(call.content);
      const configuration = args[0] && quotedGradleLiteral(args[0]);
      if (configuration && configurations.includes(configuration) && args[1]) {
        const count = counts.get(configuration) ?? 0;
        declarations.push({ configuration, expression: args.slice(1).join(','), offset: start, index: String(count) });
        counts.set(configuration, count + 1);
      }
      index = call.end;
      continue;
    }
    if (!configurations.includes(identifier) || previousNonWhitespace(content, start) === '.') continue;
    const expressionStart = skipWhitespace(content, index);
    let expression: string | undefined;
    let end = expressionStart;
    if (content[expressionStart] === '(') {
      const call = balancedGradleCall(content, expressionStart);
      if (call) {
        expression = call.content;
        end = call.end;
      }
    } else if (expressionStart > index && !['=', '.', '{'].includes(content[expressionStart] ?? '')) {
      // A call without parentheses ends at the line end, a semicolon, or a brace that closes an enclosing block.
      end = expressionStart;
      let depth = 0;
      while (end < content.length && content[end] !== '\n' && content[end] !== ';') {
        if (content[end] === '"' || content[end] === "'") {
          end = skipGradleQuoted(content, end);
          continue;
        }
        if ('([{'.includes(content[end])) depth += 1;
        else if (')]}'.includes(content[end]) && --depth < 0) break;
        end += 1;
      }
      expression = content.slice(expressionStart, end);
    }
    if (!expression?.trim()) continue;
    const count = counts.get(identifier) ?? 0;
    declarations.push({ configuration: identifier, expression, offset: start, index: String(count) });
    counts.set(identifier, count + 1);
    index = end;
  }
  return declarations;
}

function skipWhitespace(content: string, index: number): number {
  while (index < content.length && /\s/.test(content[index])) index += 1;
  return index;
}

function previousNonWhitespace(content: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(content[cursor])) return content[cursor];
  }
  return undefined;
}

function skipGradleQuoted(content: string, start: number): number {
  const quote = content.startsWith(content[start].repeat(3), start) ? content[start].repeat(3) : content[start];
  for (let index = start + quote.length; index < content.length; index += 1) {
    if (content.startsWith(quote, index) && !isEscapedCharacter(content, index)) return index + quote.length;
  }
  return content.length;
}

/** The text between the parenthesis at `open` and its match, and the offset after the match. */
export function balancedGradleCall(content: string, open: number): { content: string; end: number } | undefined {
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    if (content[index] === '"' || content[index] === "'") {
      index = skipGradleQuoted(content, index) - 1;
      continue;
    }
    if (content[index] === '(') depth += 1;
    if (content[index] === ')' && --depth === 0) return { content: content.slice(open + 1, index), end: index + 1 };
  }
  return undefined;
}

/** Top-level comma-separated arguments, trimmed. */
export function splitGradleArguments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"' || value[index] === "'") {
      index = skipGradleQuoted(value, index) - 1;
      continue;
    }
    if (value[index] === '(' || value[index] === '[' || value[index] === '{') depth += 1;
    else if (value[index] === ')' || value[index] === ']' || value[index] === '}') depth -= 1;
    else if (value[index] === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

/** The content of a value that is exactly one string literal: 'a' + 'b' or an unterminated quote is not a literal. */
export function quotedGradleLiteral(value: string): string | undefined {
  const trimmed = value.trim();
  if (!['"', "'"].includes(trimmed[0])) return undefined;
  const quote = trimmed.startsWith(trimmed[0].repeat(3)) ? trimmed[0].repeat(3) : trimmed[0];
  if (trimmed.length < quote.length * 2 || !trimmed.endsWith(quote)
    || isEscapedCharacter(trimmed, trimmed.length - quote.length)
    || skipGradleQuoted(trimmed, 0) !== trimmed.length) return undefined;
  return trimmed.slice(quote.length, -quote.length);
}
