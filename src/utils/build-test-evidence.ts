import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import {
  BuildCommand,
  BuildEvidenceDiagnostic,
  BuildFile,
  BuildFileKind,
  BuildTestEvidence,
  BuildToolId,
  SharedWorkflowUse,
  VersionDeclaration,
  VersionDeclarationSource
} from '../types';
import { decodeBoundedUtf8, readBoundedFileBytes } from './repo-files';
import { parseJavaProperties, parsePackageJson, parsePom, pomRequiredMavenVersions, xmlText, yarnLockfileFormat } from './manifest-parsers';

// Reads the build files of the checkout without running anything (S012; S013 adds test runners). The repository is
// untrusted: at most MAX_FILES files of MAX_FILE_BYTES each are read, symbolic links are never followed, and a file
// whose real path is outside the repository is not read.
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 64;
const LOCKFILE_HEADER_BYTES = 4096;
const MAX_COMMANDS = 200;
const SHARED_WORKFLOW = /^folio-org\/\.github\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@([A-Za-z0-9._/-]+)$/;
const ROOT_DIRECTORIES = new Set(['', '.', './', 'service', './service']);

const PRESENCE_FILES: Array<[string, BuildFileKind]> = [
  ['pom.xml', 'maven-pom'],
  ['package.json', 'package-json'],
  ['yarn.lock', 'yarn-lock'],
  ['package-lock.json', 'package-lock'],
  ['npm-shrinkwrap.json', 'package-lock'],
  ['pnpm-lock.yaml', 'pnpm-lock'],
  ['.yarnrc.yml', 'yarnrc-yml'],
  ['.nvmrc', 'nvmrc'],
  ['.node-version', 'node-version-file'],
  ['Makefile', 'makefile'],
  ['makefile', 'makefile'],
  ['GNUmakefile', 'makefile'],
  ['go.mod', 'go-mod'],
  ['Dockerfile', 'dockerfile'],
  ['build.sbt', 'sbt'],
  ['WORKSPACE', 'bazel'],
  ['WORKSPACE.bazel', 'bazel'],
  ['MODULE.bazel', 'bazel'],
  ['.mvn/wrapper/maven-wrapper.properties', 'maven-wrapper']
];

interface Context {
  repoPath: string;
  files: BuildFile[];
  declarations: VersionDeclaration[];
  workflowFiles: string[];
  sharedWorkflows: SharedWorkflowUse[];
  buildCommands: BuildCommand[];
  diagnostics: BuildEvidenceDiagnostic[];
  filesRead: Set<string>;
  limitReported: boolean;
}

export async function collectBuildTestEvidence(repoPath: string): Promise<BuildTestEvidence> {
  const context: Context = {
    repoPath: fs.realpathSync(path.resolve(repoPath)),
    files: [],
    declarations: [],
    workflowFiles: [],
    sharedWorkflows: [],
    buildCommands: [],
    diagnostics: [],
    filesRead: new Set(),
    limitReported: false
  };

  for (const [file, kind] of PRESENCE_FILES) {
    if (isRegularFile(context, file)) context.files.push({ kind, path: file });
  }
  for (const name of safeReaddir(context, '').filter(entry => entry.startsWith('Jenkinsfile')).sort()) {
    if (isRegularFile(context, name)) {
      context.files.push({ kind: name === 'Jenkinsfile' ? 'jenkinsfile' : 'jenkinsfile-inactive', path: name });
    }
  }
  // The Gradle build is at the root or, for FOLIO's Grails modules, in service/ (as findGradleProjectDir decides).
  const gradleDirectory = ['', 'service'].find(directory =>
    ['build.gradle', 'build.gradle.kts'].some(file => isRegularFile(context, path.posix.join(directory, file))));
  if (gradleDirectory !== undefined) {
    for (const file of ['build.gradle', 'build.gradle.kts', 'gradle/wrapper/gradle-wrapper.properties']) {
      const filePath = path.posix.join(gradleDirectory, file);
      if (isRegularFile(context, filePath)) {
        context.files.push({ kind: file.endsWith('.properties') ? 'gradle-wrapper' : 'gradle-build', path: filePath });
      }
    }
  }

  await readDeclarations(context);
  readWorkflows(context);

  return {
    files: context.files,
    declarations: context.declarations,
    workflowFiles: context.workflowFiles,
    sharedWorkflows: context.sharedWorkflows,
    buildCommands: context.buildCommands,
    diagnostics: context.diagnostics,
    filesRead: [...context.filesRead].sort(),
    complete: !context.diagnostics.some(item => item.material)
  };
}

async function readDeclarations(context: Context): Promise<void> {
  const has = (kind: BuildFileKind) => context.files.filter(file => file.kind === kind);
  const declare = (tool: BuildToolId, source: VersionDeclarationSource, filePath: string, detail: string, text: string) =>
    context.declarations.push({ tool, source, path: filePath, detail, text });

  for (const file of has('maven-wrapper')) {
    const content = readText(context, file.path);
    if (content !== undefined) declare('maven', 'maven-wrapper', file.path, 'distributionUrl', parseJavaProperties(content).get('distributionUrl') ?? '');
  }
  for (const file of has('gradle-wrapper')) {
    const content = readText(context, file.path);
    if (content !== undefined) declare('gradle', 'gradle-wrapper', file.path, 'distributionUrl', parseJavaProperties(content).get('distributionUrl') ?? '');
  }
  for (const file of has('maven-pom')) {
    const content = readText(context, file.path);
    if (content === undefined) continue;
    const parsed = await parsePom(content);
    if (!parsed.ok) {
      malformed(context, file.path, parsed.reason === 'invalid-xml' ? `Not valid XML (${parsed.message}).` : 'Has no <project> element.');
      continue;
    }
    for (const version of pomRequiredMavenVersions(parsed.project)) {
      declare('maven', 'maven-enforcer', file.path, 'maven-enforcer-plugin requireMavenVersion', resolvePomProperties(version, parsed.project));
    }
  }
  for (const file of has('package-json')) {
    const content = readText(context, file.path);
    if (content === undefined) continue;
    const parsed = parsePackageJson(content);
    if (!parsed.ok) {
      malformed(context, file.path, `Not valid JSON (${parsed.message}).`);
      continue;
    }
    const { packageManager, engines } = parsed.manifest as { packageManager?: unknown; engines?: { node?: unknown } };
    const manager = typeof packageManager === 'string' ? /^(yarn|npm|pnpm)@(.+)$/.exec(packageManager.trim()) : null;
    if (manager) declare(manager[1] as BuildToolId, 'package-manager-field', file.path, 'packageManager', manager[2]);
    if (engines && typeof engines === 'object' && typeof engines.node === 'string') {
      declare('node', 'engines-node', file.path, 'engines.node', engines.node);
    }
  }
  for (const file of has('yarn-lock')) {
    // Only the start of the lockfile says which Yarn wrote it, so a large lockfile is not a problem here.
    const header = readText(context, file.path, LOCKFILE_HEADER_BYTES);
    if (header !== undefined) declare('yarn', 'yarn-lock', file.path, 'lockfile format', yarnLockfileFormat(header) ?? 'unknown');
  }
  for (const file of has('yarnrc-yml')) {
    const content = readText(context, file.path);
    const yarnPath = content === undefined ? undefined : /^yarnPath:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(content)?.[1];
    if (yarnPath) declare('yarn', 'yarnrc-yarn-path', file.path, 'yarnPath', yarnPath);
  }
  for (const kind of ['nvmrc', 'node-version-file'] as const) {
    for (const file of has(kind)) {
      const content = readText(context, file.path);
      const version = content?.split(/\r?\n/).map(line => line.replace(/#.*$/, '').trim()).find(Boolean);
      if (content !== undefined) declare('node', kind, file.path, 'Node.js version', version ?? '');
    }
  }
}

function readWorkflows(context: Context): void {
  const directory = '.github/workflows';
  if (!isDirectory(context, '.github') || !isDirectory(context, directory)) return;
  for (const name of safeReaddir(context, directory).filter(entry => /\.ya?ml$/i.test(entry)).sort()) {
    const workflowPath = `${directory}/${name}`;
    if (!isRegularFile(context, workflowPath)) continue;
    context.workflowFiles.push(workflowPath);
    const content = readText(context, workflowPath);
    if (content === undefined) continue;
    let workflow: unknown;
    try {
      // The failsafe schema keeps every value as written: node-version 22.10 stays "22.10", not the number 22.1.
      workflow = YAML.parse(content, { schema: 'failsafe', maxAliasCount: 100 });
    } catch (error) {
      malformed(context, workflowPath, `Not valid YAML (${error instanceof Error ? error.message.split('\n')[0] : String(error)}).`);
      continue;
    }
    if (!isObject(workflow) || !isObject(workflow.jobs)) continue;
    const workflowEnv = scalarMap(workflow.env);
    const workflowDirectory = workingDirectory(workflow.defaults);
    for (const [job, definition] of Object.entries(workflow.jobs)) {
      if (!isObject(definition)) continue;
      readJob(context, workflowPath, job, definition, workflowEnv, workflowDirectory);
    }
  }
}

function readJob(
  context: Context,
  workflowPath: string,
  job: string,
  definition: Record<string, unknown>,
  workflowEnv: Record<string, string>,
  workflowDirectory: string | undefined
): void {
  const env = { ...workflowEnv, ...scalarMap(definition.env) };
  const matrix = isObject(definition.strategy) && isObject(definition.strategy.matrix) ? definition.strategy.matrix : {};
  const declare = (tool: BuildToolId, source: VersionDeclarationSource, detail: string, value: unknown) => {
    for (const text of expandValue(value, env, matrix)) {
      context.declarations.push({ tool, source, path: workflowPath, detail: `job ${job}, ${detail}`, text });
    }
  };

  if (typeof definition.uses === 'string') {
    const shared = SHARED_WORKFLOW.exec(definition.uses.trim());
    if (shared) {
      context.sharedWorkflows.push({ path: workflowPath, job, name: shared[1], ref: shared[2], inputs: scalarMap(definition.with) });
      if (isObject(definition.with) && definition.with['node-version'] !== undefined) {
        declare('node', 'workflow-input', `${shared[1]} node-version`, definition.with['node-version']);
      }
    }
    return;
  }

  const jobDirectory = workingDirectory(definition.defaults) ?? workflowDirectory;
  for (const step of Array.isArray(definition.steps) ? definition.steps : []) {
    if (!isObject(step)) continue;
    const action = typeof step.uses === 'string' ? step.uses.trim().split('@')[0] : undefined;
    const inputs = isObject(step.with) ? step.with : {};
    if (action === 'actions/setup-node' && inputs['node-version'] !== undefined) {
      declare('node', 'setup-node', 'actions/setup-node node-version', inputs['node-version']);
    }
    if ((action === 'stCarolas/setup-maven' || action === 's4u/setup-maven-action') && inputs['maven-version'] !== undefined) {
      declare('maven', 'setup-maven', `${action} maven-version`, inputs['maven-version']);
    }
    const stepDirectory = typeof step['working-directory'] === 'string' ? step['working-directory'] : jobDirectory;
    if (typeof step.run === 'string' && ROOT_DIRECTORIES.has((stepDirectory ?? '').trim())) {
      for (const { tool, command } of buildCommandsIn(step.run)) {
        if (context.buildCommands.length >= MAX_COMMANDS) return;
        context.buildCommands.push({ path: workflowPath, job, tool, command });
      }
    }
  }
}

/**
 * The build commands a run script starts in its working directory. Reading stops at a cd to another directory,
 * because later commands then build something else (such as a lint tool installed under ci/).
 */
export function buildCommandsIn(script: string): Array<{ tool: BuildToolId; command: string }> {
  const commands: Array<{ tool: BuildToolId; command: string }> = [];
  const lines = script.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    for (const segment of line.split(/&&|\|\||[;|]/)) {
      const text = segment.trim()
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
        .replace(/^sudo\s+/, '');
      if (!text || text.startsWith('#')) continue;
      const [program, ...args] = text.split(/\s+/);
      if (program === 'cd') {
        if (!/^(?:\.\/?|"?\$\{?GITHUB_WORKSPACE\}?"?|"?\$\{\{\s*github\.workspace\s*\}\}"?)$/.test(args[0] ?? '')) return commands;
        continue;
      }
      const tool = commandTool(program.replace(/^\.\//, ''), args);
      if (tool) commands.push({ tool, command: text.length > 120 ? `${text.slice(0, 117)}...` : text });
    }
  }
  return commands;
}

function commandTool(program: string, args: string[]): BuildToolId | undefined {
  switch (program) {
    case 'mvn':
    case 'mvnw':
      return 'maven';
    case 'gradle':
    case 'gradlew':
      return 'gradle';
    case 'yarn':
      return args[0] === 'global' ? undefined : 'yarn';
    case 'npm':
      // Only an install chooses the package manager; npm run or a global tool install does not.
      return ['ci', 'install', 'i'].includes(args[0] ?? '') && !args.some(arg => arg === '-g' || arg === '--global') ? 'npm' : undefined;
    case 'pnpm':
      return 'pnpm';
    case 'make':
      return 'make';
    case 'sbt':
      return 'sbt';
    case 'bazel':
    case 'bazelisk':
      return 'bazel';
    default:
      return undefined;
  }
}

/** A workflow value as the texts it can take: ${{ env.X }} and ${{ matrix.X }} are resolved within the workflow. */
function expandValue(value: unknown, env: Record<string, string>, matrix: Record<string, unknown>): string[] {
  if (Array.isArray(value)) return value.flatMap(item => expandValue(item, env, matrix));
  if (typeof value !== 'string') return [];
  const reference = /^\$\{\{\s*(env|matrix)\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(value.trim());
  if (!reference) return [value.trim()];
  const resolved = reference[1] === 'env' ? env[reference[2]] : matrix[reference[2]];
  if (resolved === undefined) return [value.trim()];
  return Array.isArray(resolved) ? resolved.filter((item): item is string => typeof item === 'string') : expandValue(resolved, {}, {});
}

function workingDirectory(defaults: unknown): string | undefined {
  if (!isObject(defaults) || !isObject(defaults.run)) return undefined;
  const directory = defaults.run['working-directory'];
  return typeof directory === 'string' ? directory : undefined;
}

function scalarMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function resolvePomProperties(value: string, project: Record<string, any>): string {
  return value.replace(/\$\{([^}]+)\}/g, (reference, name: string) => {
    const property = xmlText(project.properties?.[name]);
    return property && !property.includes('${') ? property : reference;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ---- Bounded, symlink-safe reads ----

function isRegularFile(context: Context, relativePath: string): boolean {
  const stats = lstat(context, relativePath);
  if (!stats) return false;
  if (stats.isSymbolicLink()) {
    addDiagnostic(context, 'symlink_not_followed', 'Is a symbolic link, so it was not read.', relativePath);
    return false;
  }
  return stats.isFile() && insideRepository(context, relativePath);
}

function isDirectory(context: Context, relativePath: string): boolean {
  const stats = lstat(context, relativePath);
  if (!stats) return false;
  if (stats.isSymbolicLink()) {
    addDiagnostic(context, 'symlink_not_followed', 'Is a symbolic link, so the files in it were not read.', relativePath);
    return false;
  }
  return stats.isDirectory() && insideRepository(context, relativePath);
}

function lstat(context: Context, relativePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(path.join(context.repoPath, relativePath));
  } catch {
    return undefined;
  }
}

/** A parent folder such as service/ may be a symbolic link; the file's real path must still be in the repository. */
function insideRepository(context: Context, relativePath: string): boolean {
  try {
    const real = fs.realpathSync(path.join(context.repoPath, relativePath));
    const relative = path.relative(context.repoPath, real);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return true;
  } catch {
    // Reported below.
  }
  addDiagnostic(context, 'outside_repository', 'Leads outside the repository, so it was not read.', relativePath);
  return false;
}

function safeReaddir(context: Context, relativePath: string): string[] {
  try {
    return fs.readdirSync(path.join(context.repoPath, relativePath));
  } catch {
    return [];
  }
}

/** The file's text, or only its first prefixBytes when given. Call only after isRegularFile accepted the path. */
function readText(context: Context, relativePath: string, prefixBytes?: number): string | undefined {
  if (context.filesRead.size >= MAX_FILES) {
    if (!context.limitReported) {
      addDiagnostic(context, 'file_limit', `Stopped after reading ${MAX_FILES} build and workflow files; the rest were not read.`);
      context.limitReported = true;
    }
    return undefined;
  }
  const absolutePath = path.join(context.repoPath, relativePath);
  try {
    const size = fs.lstatSync(absolutePath).size;
    if (prefixBytes === undefined && size > MAX_FILE_BYTES) {
      addDiagnostic(context, 'file_too_large', `Is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, so it was not read.`, relativePath);
      return undefined;
    }
    const limit = Math.min(size, prefixBytes ?? MAX_FILE_BYTES);
    const text = decodeBoundedUtf8(readBoundedFileBytes(absolutePath, limit), limit < size);
    context.filesRead.add(relativePath);
    return text;
  } catch (error) {
    addDiagnostic(context, 'read_error', `Could not be read (${error instanceof Error ? error.message : String(error)}).`, relativePath);
    return undefined;
  }
}

function malformed(context: Context, relativePath: string, message: string): void {
  addDiagnostic(context, 'malformed', message, relativePath);
}

function addDiagnostic(context: Context, code: BuildEvidenceDiagnostic['code'], message: string, relativePath?: string): void {
  if (context.diagnostics.some(item => item.code === code && item.path === relativePath)) return;
  context.diagnostics.push({ code, message, path: relativePath, material: true });
}
