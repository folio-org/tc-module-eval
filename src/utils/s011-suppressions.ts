import * as fs from 'fs';
import * as path from 'path';
import {
  BuildTestEvidence,
  FolioSharedWorkflowTable,
  S011AnnotationTarget,
  S011ReviewGroup,
  S011ScanDiagnostic,
  S011ScopeSetting,
  S011Suppression,
  S011SuppressionScan,
  SharedWorkflowUse,
  SonarRule
} from '../types';
import { findCandidateFiles, isBinaryBuffer, readBoundedFileBytes, relativePosixPath } from './repo-files';
import { isSonarTestPath } from './sonarcloud-snapshot';

// Finds where the repository and its CI tell Sonar to ignore something: @SuppressWarnings naming a Sonar
// rule or "all", NOSONAR comments, and analysis-scope settings (exclusions, inclusions, source roots,
// sonar.issue.ignore.*). eslint-disable is ESLint, not Sonar, and is only counted for context. Reads the
// checkout without running anything; a file it could not read makes the scan incomplete, never empty.

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ANNOTATION_CHARS = 2_000;
const MAX_COMMENT_CHARS = 200;
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', 'coverage', 'artifacts']);
const ANNOTATED_SOURCE = /\.(java|groovy|kt|kts|scala)$/;
/** Build files that can set the Sonar analysis scope; pom.xml has its own reader. */
const SCOPE_FILES: ReadonlySet<string> = new Set(['pom.xml', 'sonar-project.properties', '.sonarcloud.properties', 'gradle.properties']);
const SCRIPT_SOURCE = /\.(js|jsx|mjs|cjs|ts|tsx|vue)$/;
const OTHER_SOURCE = /\.(py|go|rb|php|cs|html?|xml|css|scss|less|sql|sh|ya?ml|properties|gradle)$/;
/** Rule prefixes of the Sonar analysers FOLIO's JVM code uses; other @SuppressWarnings values belong to javac or IDEs. */
const SONAR_RULE = /^(?:java|squid|javabugs|javasecurity|kotlin|groovy):S\d{1,5}$/;
const SCOPE_KEY = /^sonar\.(?:sources|inclusions|exclusions|test\.exclusions|test\.inclusions|coverage\.exclusions|cpd\.exclusions|issue\.ignore\.[A-Za-z0-9_.-]+)$/;

/**
 * `ci` is S012's build evidence (FOLIO shared-workflow calls with their inputs, read as YAML); `workflows` is the
 * shared-workflow table, which says what each shared workflow already passes to the scanner.
 */
export function scanS011Suppressions(
  repoPath: string,
  ci: Pick<BuildTestEvidence, 'sharedWorkflows' | 'diagnostics'>,
  workflows?: FolioSharedWorkflowTable
): S011SuppressionScan {
  const scan: S011SuppressionScan = {
    complete: true, suppressions: [], scope: [], eslintDisableCount: 0, filesScanned: 0, sharedWorkflows: [], diagnostics: []
  };
  const fail = (diagnostic: S011ScanDiagnostic, material = true) => {
    if (material) scan.complete = false;
    if (scan.diagnostics.length < 20) scan.diagnostics.push(material ? diagnostic : { ...diagnostic, message: `${diagnostic.message} It is not code, so the scan still counts as complete.` });
  };
  let files: string[];
  try {
    files = findCandidateFiles(repoPath, repoPath, file => isScanned(relativePosixPath(repoPath, file)), SKIPPED_DIRS)
      .map(file => relativePosixPath(repoPath, file)).sort();
  } catch (error) {
    fail({ message: `The repository could not be listed: ${error instanceof Error ? error.message : String(error)}` });
    return scan;
  }
  if (files.length > MAX_FILES) {
    fail({ message: `The repository has ${files.length} source and build files; only the first ${MAX_FILES} were scanned.` });
    files = files.slice(0, MAX_FILES);
  }
  for (const diagnostic of ci.diagnostics) {
    if (diagnostic.material && diagnostic.path?.startsWith('.github/workflows/')) fail({ path: diagnostic.path, message: diagnostic.message });
  }
  for (const relative of files) {
    let bytes: Buffer;
    try {
      bytes = readBoundedFileBytes(path.join(repoPath, relative), MAX_FILE_BYTES + 1);
    } catch {
      fail({ path: relative, message: 'The file could not be read.' });
      continue;
    }
    if (isBinaryBuffer(bytes)) continue;
    if (bytes.length > MAX_FILE_BYTES) {
      // A large data file (test XML, SQL dumps) is very unlikely to carry a suppression; code and build files are not.
      const name = path.posix.basename(relative);
      const material = ANNOTATED_SOURCE.test(name) || SCRIPT_SOURCE.test(name) || SCOPE_FILES.has(name) || /^build\.gradle/.test(name)
        || relative === '.mvn/maven.config' || relative.startsWith('.github/workflows/');
      fail({ path: relative, message: `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB and was not scanned.` }, material);
      continue;
    }
    scan.filesScanned++;
    const text = bytes.toString('utf8');
    const lines = text.split(/\r\n|\r|\n/);
    const name = path.posix.basename(relative);
    if (ANNOTATED_SOURCE.test(name)) scanAnnotations(relative, text, lines, scan.suppressions);
    if (!/\.(properties|ya?ml|gradle)$/.test(name)) scanNoSonar(relative, lines, scan.suppressions);
    if (SCRIPT_SOURCE.test(name)) scan.eslintDisableCount += lines.filter(line => /eslint-disable/.test(line)).length;
    if (name === 'pom.xml') scanPom(relative, text, scan.scope);
    else if (/^build\.gradle(\.kts)?$/.test(name)) scanGradle(relative, text, scan.scope);
    else if (SCOPE_FILES.has(name)) scanProperties(relative, lines, scan.scope);
    else if (relative === '.mvn/maven.config') scanCommandLine(relative, lines, scan.scope);
    else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(relative)) scanCommandLine(relative, lines, scan.scope);
  }
  scan.sharedWorkflows = [...new Set(ci.sharedWorkflows.map(use => use.name))].sort();
  scanWorkflowInputs(repoPath, ci.sharedWorkflows, workflows, scan.scope);
  return scan;
}

function isScanned(relative: string): boolean {
  const name = path.posix.basename(relative);
  return ANNOTATED_SOURCE.test(name) || SCRIPT_SOURCE.test(name) || OTHER_SOURCE.test(name)
    || SCOPE_FILES.has(name) || relative === '.mvn/maven.config';
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) line++;
  return line;
}

// The comment that explains a suppression: on its own line, or ending on one of the two lines above. Javadoc
// describes the method, not the suppression, so it does not count.
function adjacentComment(lines: string[], index: number, sameLineFrom: number): string | undefined {
  const parts = [lines[index].slice(sameLineFrom).match(/(?:\/\/|\/\*(?!\*)|#)(.*)$/)?.[1]];
  for (const above of [index - 1, index - 2]) {
    const line = lines[above]?.trim();
    if (!line) continue;
    if (/^(\/\/|#)/.test(line)) parts.push(line.replace(/^(\/\/+|#+)/, ''));
    else if (line.endsWith('*/')) {
      let start = above;
      while (start > 0 && start > above - 30 && !lines[start].includes('/*')) start--;
      if (!/\/\*\*(?!\/)/.test(lines[start])) parts.push(lines.slice(start, above + 1).join(' ').replace(/\/\*+|\*\/|^\s*\*|\s\*\s/g, ' '));
      break;
    } else if (!line.startsWith('@')) break;
  }
  const comment = parts.map(item => item?.replace(/\bNOSONAR\b/g, '').replace(/\s+/g, ' ').replace(/^[\s:,.()-]+|[\s*/]+$/g, '').trim())
    .filter(Boolean).join(' / ');
  return comment ? comment.slice(0, MAX_COMMENT_CHARS) : undefined;
}

function scanAnnotations(relative: string, text: string, lines: string[], out: S011Suppression[]): void {
  const pattern = /@(?:java\.lang\.)?Suppress(?:Warnings)?\s*\(/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const line = lineAt(text, match.index);
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const before = text.slice(lineStart, match.index);
    // Commented-out code is not a suppression.
    if (/\/\/|^\s*\*/.test(before)) continue;
    const close = closingParen(text, pattern.lastIndex);
    if (close < 0) continue;
    const values = [...text.slice(pattern.lastIndex, close).matchAll(/"([^"\\]{1,100})"|'([^'\\]{1,100})'/g)].map(item => item[1] ?? item[2]);
    const sonar = values.filter(value => value === 'all' || SONAR_RULE.test(value));
    if (!sonar.length) continue;
    const target = annotationTarget(text, close + 1);
    const comment = adjacentComment(lines, line - 1, close + 1 - lineStart > lines[line - 1].length ? lines[line - 1].length : close + 1 - lineStart);
    for (const value of new Set(sonar)) {
      out.push({
        kind: value === 'all' ? 'all' : 'annotation',
        ...(value === 'all' ? {} : { rule: value }),
        path: relative, line, target, ...(comment ? { comment } : {}), test: isSonarTestPath(relative)
      });
    }
  }
}

function closingParen(text: string, from: number): number {
  let depth = 1;
  for (let index = from; index < text.length && index < from + MAX_ANNOTATION_CHARS; index++) {
    const character = text[index];
    if (character === '"' || character === '\'') {
      const end = text.indexOf(character, index + 1);
      if (end < 0) return -1;
      index = end;
    } else if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

// What the annotation is on: skip whitespace, comments and other annotations, then read the declaration
// up to its body, initializer or end.
function annotationTarget(text: string, from: number): S011AnnotationTarget {
  let index = from;
  for (let steps = 0; steps < 20; steps++) {
    const rest = text.slice(index, index + 400);
    const skip = /^\s+/.exec(rest)?.[0].length
      ?? /^\/\/[^\n]*/.exec(rest)?.[0].length
      ?? /^\/\*[\s\S]*?\*\//.exec(rest)?.[0].length;
    if (skip) {
      index += skip;
      continue;
    }
    const annotation = /^@(?!interface\b)[\w.]+/.exec(rest);
    if (annotation) {
      index += annotation[0].length;
      const open = /^\s*\(/.exec(text.slice(index, index + 50));
      if (open) {
        const close = closingParen(text, index + open[0].length);
        if (close < 0) return 'unknown';
        index = close + 1;
      }
      continue;
    }
    const declaration = rest.split(/[{;=]/)[0];
    if (/@interface\b|\b(class|interface|enum|record|object|trait)\s+\w/.test(declaration)) return 'class';
    if (declaration.includes('(')) return 'method';
    return declaration.trim() ? 'field' : 'unknown';
  }
  return 'unknown';
}

function scanNoSonar(relative: string, lines: string[], out: S011Suppression[]): void {
  lines.forEach((text, index) => {
    const at = text.search(/\bNOSONAR\b/);
    if (at < 0 || !/(\/\/|\/\*|#|<!--|^\s*\*|\{\s*\/\*)/.test(text.slice(0, at))) return;
    const comment = adjacentComment(lines, index, 0);
    out.push({ kind: 'nosonar', path: relative, line: index + 1, ...(comment ? { comment } : {}), test: isSonarTestPath(relative) });
  });
}

function scopeSetting(key: string, value: string, relative: string, line: number, source: S011ScopeSetting['source'], note?: string): S011ScopeSetting {
  return {
    key, value: value.replace(/\s+/g, ' ').trim().slice(0, 1_000), path: relative, line, source,
    affectsS011: key !== 'sonar.coverage.exclusions', ...(note ? { note } : {})
  };
}

// Comments become spaces so offsets and line numbers stay those of the file.
function blankComments(text: string, pattern: RegExp): string {
  return text.replace(pattern, comment => comment.replace(/[^\n]/g, ' '));
}

function scanPom(relative: string, text: string, out: S011ScopeSetting[]): void {
  const code = blankComments(text, /<!--[\s\S]*?-->/g);
  for (const match of code.matchAll(/<(sonar\.[A-Za-z0-9_.-]+)>([\s\S]{0,5000}?)<\/\1>/g)) {
    if (!SCOPE_KEY.test(match[1]) || !match[2].trim()) continue;
    out.push(scopeSetting(match[1], match[2], relative, lineAt(code, match.index!), 'pom'));
  }
}

function scanGradle(relative: string, text: string, out: S011ScopeSetting[]): void {
  const code = blankComments(text, /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g);
  for (const match of code.matchAll(/property\s*\(?\s*["'](sonar\.[A-Za-z0-9_.-]+)["']\s*,\s*([^\n]{1,1000})/g)) {
    if (!SCOPE_KEY.test(match[1])) continue;
    out.push(scopeSetting(match[1], match[2].replace(/\)\s*$/, ''), relative, lineAt(code, match.index!), 'gradle'));
  }
}

function scanProperties(relative: string, lines: string[], out: S011ScopeSetting[]): void {
  for (let index = 0; index < lines.length; index++) {
    const start = index;
    let text = lines[index];
    if (/^\s*[#!]/.test(text)) continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(text) && index + 1 < lines.length) text = text.slice(0, -1) + lines[++index].trim();
    const match = /^\s*(?:systemProp\.)?(sonar\.[A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/.exec(text);
    if (match && SCOPE_KEY.test(match[1]) && match[2].trim()) out.push(scopeSetting(match[1], match[2], relative, start + 1, 'properties'));
  }
}

function scanCommandLine(relative: string, lines: string[], out: S011ScopeSetting[]): void {
  lines.forEach((text, index) => {
    if (/^\s*#/.test(text)) return;
    for (const match of text.matchAll(/-D(sonar\.[A-Za-z0-9_.-]+)=("[^"]*"|'[^']*'|\S+)/g)) {
      if (SCOPE_KEY.test(match[1])) out.push(scopeSetting(match[1], match[2].replace(/^["']|["']$/g, ''), relative, index + 1, 'command-line'));
    }
  });
}

function patterns(value: string): string[] {
  return value.split(',').map(item => item.trim().replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean);
}

// sonar-exclusions and sonar-sources inputs to FOLIO's shared workflows, compared with what the workflow
// passes by default. Without the table, every input counts.
function scanWorkflowInputs(
  repoPath: string,
  uses: SharedWorkflowUse[],
  table: FolioSharedWorkflowTable | undefined,
  out: S011ScopeSetting[]
): void {
  for (const use of uses) {
    const defaults = table?.workflows[use.name];
    for (const [input, key, expected] of [
      ['sonar-exclusions', 'sonar.exclusions', defaults?.sonarExclusions],
      ['sonar-sources', 'sonar.sources', defaults?.sonarSources]
    ] as const) {
      const value = use.inputs[input];
      if (value === undefined) continue;
      const given = patterns(value);
      const known = expected?.map(item => item.replace(/^\.\//, '').replace(/\/$/, ''));
      // Fewer exclusions than the defaults analyses more; only the module's own additions count.
      const own = key === 'sonar.sources'
        ? (known && given.length === known.length && given.every(item => known.includes(item)) ? [] : given)
        : given.filter(item => !known?.includes(item));
      if (!own.length) continue;
      out.push(scopeSetting(key, own.join(', '), use.path, inputLine(repoPath, use, input), 'workflow-input',
        known ? `${key === 'sonar.sources' ? 'instead of' : 'in addition to'} the defaults of FOLIO's ${use.name}` : undefined));
    }
  }
}

// The input's line: the first one named so after the job's own key.
function inputLine(repoPath: string, use: SharedWorkflowUse, input: string): number {
  let lines: string[];
  try {
    lines = readBoundedFileBytes(path.join(repoPath, use.path), MAX_FILE_BYTES).toString('utf8').split(/\r\n|\r|\n/);
  } catch {
    return 1;
  }
  const job = lines.findIndex(line => new RegExp(`^\\s*["']?${use.job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*:\\s*$`).test(line));
  const at = lines.findIndex((line, index) => index > job && new RegExp(`^\\s*${input}\\s*:`).test(line));
  return at < 0 ? 1 : at + 1;
}

/** The reviewer's groups: suppressions by rule and file, scope settings by file. IDs are stable across runs. */
export function groupS011ReviewItems(scan: S011SuppressionScan, rules: Record<string, SonarRule>): S011ReviewGroup[] {
  const groups = new Map<string, S011ReviewGroup>();
  for (const item of scan.suppressions) {
    const kind = item.kind === 'annotation' ? 'suppression' : item.kind;
    const id = item.kind === 'annotation' ? `suppression:${item.rule}:${item.path}` : `${kind}:${item.path}`;
    const group = groups.get(id) ?? {
      id, kind, path: item.path, lines: [], flags: [], comments: [],
      ...(item.rule ? { rule: item.rule, ...(rules[item.rule] ? { ruleName: rules[item.rule].name } : {}) } : {})
    };
    group.lines.push(item.line);
    if (item.comment && !group.comments.includes(item.comment)) group.comments.push(item.comment);
    for (const flag of suppressionFlags(item, rules)) if (!group.flags.includes(flag)) group.flags.push(flag);
    groups.set(id, group);
  }
  for (const setting of scan.scope.filter(item => item.affectsS011)) {
    const id = `scope:${setting.path}`;
    const group = groups.get(id) ?? { id, kind: 'scope' as const, path: setting.path, lines: [], flags: [], comments: [], settings: [] };
    group.lines.push(setting.line);
    group.settings!.push({ key: setting.key, value: setting.value });
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** Where a suppression departs from FOLIO's guidance (dev.folio.org: comment every suppression, method or variable level, never NOSONAR or "all"). */
export function suppressionFlags(item: S011Suppression, rules: Record<string, SonarRule>): string[] {
  const flags: string[] = [];
  if (item.kind === 'nosonar') flags.push('NOSONAR');
  if (item.kind === 'all') flags.push('suppresses all rules');
  if (item.target === 'class') flags.push('class level');
  if (item.rule && rules[item.rule]?.security) flags.push('security rule');
  if (!item.comment) flags.push('no comment');
  return flags;
}

/** Whether a path names a file in the checkout; used before citing it. */
export function isRepositoryFile(repoPath: string, relative: string): boolean {
  try {
    return fs.lstatSync(path.join(repoPath, relative)).isFile();
  } catch {
    return false;
  }
}
