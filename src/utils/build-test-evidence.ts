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
  TestTechnologyDeclaration,
  TestTechnologyKind,
  VersionDeclaration,
  VersionDeclarationSource
} from '../types';
import { decodeBoundedUtf8, isPathInside, readBoundedFileBytes } from './repo-files';
import {
  asArray,
  packageDependencyEntries,
  parseJavaProperties,
  parsePackageJson,
  parsePom,
  parseYarnLockfile,
  pomDependencies,
  pomRequiredMavenVersions,
  quotedGradleLiteral,
  scanGradleDeclarations,
  splitGradleArguments,
  stripGradleComments,
  xmlText,
  yarnLockfileFormat,
  yarnLockVersionsByName
} from './manifest-parsers';
import { errorMessage, isRecord } from './type-guards';

// Reads the build files of the checkout without running anything: build tools for S012, test technologies for S013. The repository is
// untrusted: at most MAX_FILES files of MAX_FILE_BYTES each are read, symbolic links are never followed, and a file
// whose real path is outside the repository is not read.
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 64;
const LOCKFILE_HEADER_BYTES = 4096;
const MAX_COMMANDS = 200;
const SHARED_WORKFLOW = /^folio-org\/\.github\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@([A-Za-z0-9._/-]+)$/;
// The repository root or service/, written relative or from the workspace (${{ github.workspace }}, $GITHUB_WORKSPACE).
const ROOT_DIRECTORY = /^(?:(?:\$\{\{\s*github\.workspace\s*\}\}|\$\{?GITHUB_WORKSPACE\}?)\/?|\.\/|\.)?(?:service\/?)?$/;

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
  /** Where problems go: S012's diagnostics, then S013's own while test declarations are read. */
  diagnostics: BuildEvidenceDiagnostic[];
  testTechnologies: TestTechnologyDeclaration[];
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
    testTechnologies: [],
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
  // Test declarations are read last and report their problems separately, so S013's extra reads cannot change
  // S012's evidence.
  const diagnostics = context.diagnostics;
  const filesRead = [...context.filesRead].sort();
  // A test manifest that was skipped as a symbolic link or outside the repository was not read for S013 either.
  context.diagnostics = diagnostics.filter(item => TEST_MANIFEST.test(item.path ?? '')).map(item => ({ ...item }));
  context.limitReported = false;
  await readTestTechnologies(context, gradleDirectory);
  const testDiagnostics = context.diagnostics;

  return {
    files: context.files,
    declarations: context.declarations,
    workflowFiles: context.workflowFiles,
    sharedWorkflows: context.sharedWorkflows,
    buildCommands: context.buildCommands,
    diagnostics,
    filesRead,
    complete: !diagnostics.some(item => item.material),
    testTechnologies: context.testTechnologies,
    testDiagnostics,
    testComplete: !testDiagnostics.some(item => item.material)
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
    for (const rule of pomRequiredMavenVersions(parsed.project)) {
      context.declarations.push({
        tool: 'maven',
        source: 'maven-enforcer',
        path: file.path,
        detail: 'maven-enforcer-plugin requireMavenVersion',
        text: resolvePomProperties(rule.version, parsed.project),
        activation: rule.state === 'active' ? undefined : { state: rule.state, reason: rule.reason ?? '' }
      });
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

interface TestTechnology {
  id: string;
  displayName: string;
  kind: TestTechnologyKind;
  /** The npm package whose yarn.lock version is shown (Jest and React Testing Library only; the policy advises versions for them). */
  versionPackage?: string;
}

const technology = (id: string, displayName: string, kind: TestTechnologyKind, versionPackage?: string): TestTechnology =>
  ({ id, displayName, kind, versionPackage });
const JUNIT = technology('junit', 'JUnit', 'runner');
const SPOCK = technology('spock', 'Spock', 'runner');
const JEST = technology('jest', 'Jest', 'runner', 'jest');
const RTL = technology('react-testing-library', 'React Testing Library', 'library', '@testing-library/react');

/** Maven and Gradle coordinates (group:artifact) of test technologies. */
const JAVA_TEST_TECHNOLOGIES: Array<[RegExp, TestTechnology]> = [
  [/^(?:org\.junit\.(?:jupiter|platform|vintage):.+|junit:junit|org\.springframework\.boot:spring-boot-starter-test|io\.vertx:vertx-junit5)$/, JUNIT],
  // Grails' testing support is built on Spock.
  [/^(?:org\.spockframework:.+|com\.athaydes:spock-reports|org\.grails:grails-(?:gorm-|web-)?testing-support)$/, SPOCK],
  [/^org\.testng:testng$/, technology('testng', 'TestNG', 'runner')],
  [/^io\.rest-assured:.+$/, technology('rest-assured', 'REST Assured', 'library')],
  [/^org\.testcontainers:.+$/, technology('testcontainers', 'Testcontainers', 'library')],
  [/^org\.mockito:.+$/, technology('mockito', 'Mockito', 'helper')],
  [/^org\.assertj:.+$/, technology('assertj', 'AssertJ', 'helper')],
  [/^(?:com\.github\.tomakehurst:wiremock.*|org\.wiremock:.+)$/, technology('wiremock', 'WireMock', 'helper')],
  [/^org\.awaitility:.+$/, technology('awaitility', 'Awaitility', 'helper')],
  [/^com\.intuit\.karate:.+$/, technology('karate', 'Karate', 'integration')]
];

/** npm package names of test technologies. FOLIO's shared Jest configuration brings Jest and React Testing Library. */
const JAVASCRIPT_TEST_TECHNOLOGIES: Array<[RegExp, TestTechnology[]]> = [
  [/^jest$/, [JEST]],
  [/^@folio\/jest-config-stripes$/, [JEST, RTL]],
  [/^@testing-library\/react$/, [RTL]],
  [/^karma$/, [technology('karma', 'Karma', 'runner')]],
  [/^mocha$/, [technology('mocha', 'Mocha', 'runner')]],
  [/^@bigtest\//, [technology('bigtest', 'BigTest', 'runner')]],
  [/^(?:jasmine|jasmine-core)$/, [technology('jasmine', 'Jasmine', 'runner')]],
  [/^vitest$/, [technology('vitest', 'Vitest', 'runner')]],
  [/^cypress$/, [technology('cypress', 'Cypress', 'integration')]]
];

/** Files that can declare test dependencies at the places the collector looks. */
const TEST_MANIFEST = /^(?:pom\.xml|package\.json|(?:service\/)?(?:build|settings)\.gradle(?:\.kts)?)$/;
const GRADLE_TEST_CONFIGURATIONS = ['testImplementation', 'testCompileOnly', 'testRuntimeOnly', 'testCompile', 'testRuntime'];
const POM_MODULE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Test technologies from the declarations that can bring them: dependencies of the root POM and of the modules it
 * lists, test configurations of the Gradle build, and package.json dependencies and devDependencies. Versions come
 * from yarn.lock entries looked up by package name, so no dependency tree is walked.
 */
async function readTestTechnologies(context: Context, gradleDirectory: string | undefined): Promise<void> {
  const add = (match: TestTechnology, ecosystem: TestTechnologyDeclaration['ecosystem'], dependency: string, filePath: string, scope: string) => {
    context.testTechnologies.push({ id: match.id, displayName: match.displayName, kind: match.kind, ecosystem, dependency, path: filePath, scope });
  };
  const addJava = (coordinates: string, filePath: string, scope: string) => {
    const match = JAVA_TEST_TECHNOLOGIES.find(([pattern]) => pattern.test(coordinates));
    if (match) add(match[1], 'java', coordinates, filePath, scope);
  };

  if (context.files.some(file => file.kind === 'maven-pom')) {
    // The root POM and the modules it builds, one level down. Anything this does not read (deeper modules, modules
    // in profiles, a module that cannot be found) could declare another runner, so it leaves the evidence incomplete.
    const poms = new Set(['pom.xml']);
    for (const pom of poms) {
      const root = pom === 'pom.xml';
      if (!root && !isRegularFile(context, pom)) {
        if (!context.diagnostics.some(item => item.path === pom)) {
          addDiagnostic(context, 'not_read', 'Is the POM of a module the root pom.xml lists, but it is not a file in the repository, so its test dependencies were not read.', pom);
        }
        continue;
      }
      const content = readText(context, pom);
      if (content === undefined) continue;
      const parsed = await parsePom(content);
      if (!parsed.ok) {
        malformed(context, pom, parsed.reason === 'invalid-xml' ? `Not valid XML (${parsed.message}).` : 'Has no <project> element.');
        continue;
      }
      for (const dependency of pomDependencies(parsed.project.dependencies?.dependency)) {
        addJava(`${dependency.groupId}:${dependency.artifactId}`, pom, dependency.scope || 'compile');
      }
      const modules = asArray(parsed.project.modules?.module).map(xmlText);
      if (asArray(parsed.project.profiles?.profile).some(profile => profile?.modules)) {
        addDiagnostic(context, 'not_read', 'Lists modules inside a profile, whose test dependencies were not read.', pom);
      }
      if (!root) {
        if (modules.length) addDiagnostic(context, 'not_read', 'Lists modules of its own, whose test dependencies were not read.', pom);
        continue;
      }
      for (const module of modules) {
        const directory = module.replace(/\/+$/, '');
        if (!directory || !directory.split('/').every(segment => POM_MODULE_SEGMENT.test(segment))) {
          addDiagnostic(context, 'value_unreadable', `Lists the module "${module.slice(0, 100)}", which is not a plain folder name, so its test dependencies were not read.`, pom);
        } else if (poms.size > MAX_FILES) {
          addDiagnostic(context, 'file_limit', `Lists more than ${MAX_FILES} modules; the rest were not read.`, pom);
          break;
        } else {
          poms.add(`${directory}/pom.xml`);
        }
      }
    }
  }

  if (gradleDirectory !== undefined) {
    // Subprojects have build files of their own, which are not read.
    for (const settings of ['settings.gradle', 'settings.gradle.kts'].map(file => path.posix.join(gradleDirectory, file))) {
      const content = isRegularFile(context, settings) ? readText(context, settings) : undefined;
      if (content !== undefined && /^\s*include\b/m.test(stripGradleComments(content))) {
        addDiagnostic(context, 'not_read', 'Includes Gradle subprojects, whose test dependencies were not read.', settings);
      }
    }
    for (const file of context.files.filter(item => item.kind === 'gradle-build')) {
      const content = readText(context, file.path);
      if (content === undefined) continue;
      for (const declaration of scanGradleDeclarations(stripGradleComments(content), GRADLE_TEST_CONFIGURATIONS)) {
        const coordinates = gradleCoordinates(declaration.expression);
        if (coordinates) addJava(coordinates, file.path, declaration.configuration);
      }
    }
  }

  const packageJson = context.files.find(file => file.kind === 'package-json');
  const content = packageJson && readText(context, packageJson.path);
  if (packageJson && content !== undefined) {
    const parsed = parsePackageJson(content);
    if (!parsed.ok) {
      malformed(context, packageJson.path, `Not valid JSON (${parsed.message}).`);
    } else {
      for (const entry of packageDependencyEntries(parsed.manifest, ['dependencies', 'devDependencies'])) {
        if (!('name' in entry)) {
          malformed(context, packageJson.path, `Its ${entry.field} is not an object of package names, so its test dependencies were not read.`);
          continue;
        }
        for (const match of JAVASCRIPT_TEST_TECHNOLOGIES.find(([pattern]) => pattern.test(entry.name))?.[1] ?? []) {
          add(match, 'javascript', entry.name, packageJson.path, entry.field);
        }
      }
    }
  }
  readTestVersions(context);
}

/** group:artifact of a Gradle dependency written as one 'group:artifact[:version]' literal or as group: and name: entries. */
function gradleCoordinates(expression: string): string | undefined {
  const literal = quotedGradleLiteral(splitGradleArguments(expression)[0] ?? '');
  if (literal !== undefined) {
    const [group, artifact] = literal.split(':');
    return group && artifact ? `${group}:${artifact}` : undefined;
  }
  const group = /\bgroup\s*:\s*['"]([^'"]+)['"]/.exec(expression)?.[1];
  const name = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(expression)?.[1];
  return group && name ? `${group}:${name}` : undefined;
}

/**
 * The yarn.lock versions of Jest and React Testing Library. They are advice only, so a lockfile that cannot be read
 * leaves the versions out without making the test evidence incomplete.
 */
function readTestVersions(context: Context): void {
  const wanted = context.testTechnologies.filter(item => item.ecosystem === 'javascript'
    && JAVASCRIPT_TEST_TECHNOLOGIES.some(([, matches]) => matches.some(match => match.id === item.id && match.versionPackage)));
  const lockfile = context.files.find(file => file.kind === 'yarn-lock');
  if (!wanted.length || !lockfile) return;
  const before = context.diagnostics.length;
  const content = readText(context, lockfile.path);
  const parsed = content === undefined ? undefined : parseYarnLockfile(content);
  if (parsed && parsed.format !== 'v1') {
    malformed(context, lockfile.path, parsed.format === 'berry'
      ? 'Is a Yarn 2+ lockfile, which the tool cannot read, so Jest and React Testing Library versions are not shown.'
      : 'Could not be read as a Yarn 1 lockfile, so Jest and React Testing Library versions are not shown.');
  }
  for (const diagnostic of context.diagnostics.slice(before)) diagnostic.material = false;
  if (parsed?.format !== 'v1') return;
  for (const item of wanted) {
    const versionPackage = JAVASCRIPT_TEST_TECHNOLOGIES.flatMap(([, matches]) => matches).find(match => match.id === item.id)!.versionPackage!;
    item.versions = yarnLockVersionsByName(parsed.entries, versionPackage);
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
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) continue;
    const workflowEnv = scalarMap(workflow.env);
    const workflowDirectory = workingDirectory(workflow.defaults);
    try {
      for (const [job, definition] of Object.entries(workflow.jobs)) {
        if (!isRecord(definition)) continue;
        if (!readJob(context, workflowPath, job, definition, workflowEnv, workflowDirectory)) return;
      }
    } catch (error) {
      malformed(context, workflowPath, `Could not be read as a workflow (${errorMessage(error)}).`);
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
): boolean {
  const jobEnv = { ...workflowEnv, ...scalarMap(definition.env) };
  const matrix = isRecord(definition.strategy) && isRecord(definition.strategy.matrix) ? definition.strategy.matrix : {};
  const declare = (tool: BuildToolId, source: VersionDeclarationSource, detail: string, value: unknown, env = jobEnv) => {
    for (const text of expandValue(value, env, matrix)) {
      context.declarations.push({ tool, source, path: workflowPath, detail: `job ${job}, ${detail}`, text, job });
    }
  };

  if (typeof definition.uses === 'string') {
    const shared = SHARED_WORKFLOW.exec(definition.uses.trim());
    if (shared) {
      context.sharedWorkflows.push({ path: workflowPath, job, name: shared[1], ref: shared[2], inputs: scalarMap(definition.with) });
      if (isRecord(definition.with) && definition.with['node-version'] !== undefined) {
        declare('node', 'workflow-input', `${shared[1]} node-version`, definition.with['node-version']);
      }
    }
    return true;
  }

  const jobDirectory = workingDirectory(definition.defaults) ?? workflowDirectory;
  for (const step of Array.isArray(definition.steps) ? definition.steps : []) {
    if (!isRecord(step)) continue;
    const action = typeof step.uses === 'string' ? step.uses.trim().split('@')[0] : undefined;
    const inputs = isRecord(step.with) ? step.with : {};
    // A step's env overrides the job's and the workflow's when its inputs are evaluated.
    const stepEnv = { ...jobEnv, ...scalarMap(step.env) };
    if (action === 'actions/setup-node' && inputs['node-version'] !== undefined) {
      declare('node', 'setup-node', 'actions/setup-node node-version', inputs['node-version'], stepEnv);
    }
    if ((action === 'stCarolas/setup-maven' || action === 's4u/setup-maven-action') && inputs['maven-version'] !== undefined) {
      declare('maven', 'setup-maven', `${action} maven-version`, inputs['maven-version'], stepEnv);
    }
    const stepDirectory = typeof step['working-directory'] === 'string' ? step['working-directory'] : jobDirectory;
    if (typeof step.run === 'string' && ROOT_DIRECTORY.test((stepDirectory ?? '').trim())) {
      for (const { tool, command } of buildCommandsIn(step.run)) {
        if (context.buildCommands.length >= MAX_COMMANDS) {
          addDiagnostic(context, 'command_limit', `Stopped after ${MAX_COMMANDS} build commands in workflows; the rest were not read.`, workflowPath);
          return false;
        }
        context.buildCommands.push({ path: workflowPath, job, tool, command });
      }
    }
  }
  return true;
}

/**
 * The build commands a run script starts in its working directory. Reading stops at a cd to another directory,
 * because later commands then build something else (such as a lint tool installed under ci/).
 */
export function buildCommandsIn(script: string): Array<{ tool: BuildToolId; command: string }> {
  const commands: Array<{ tool: BuildToolId; command: string }> = [];
  for (const command of shellCommands(script)) {
    const first = command.findIndex(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const words = first === -1 ? [] : command.slice(first);
    while (words[0] === 'sudo' || words[0] === 'corepack') words.shift();
    const [program, ...args] = words;
    if (!program) continue;
    if (program === 'cd') {
      if (!/^(?:\.\/?|\$\{?GITHUB_WORKSPACE\}?|\$\{\{\s*github\.workspace\s*\}\})$/.test(args.join(' '))) return commands;
      continue;
    }
    const tool = commandTool(program.replace(/^\.\//, ''), args);
    const text = words.join(' ');
    if (tool) commands.push({ tool, command: text.length > 120 ? `${text.slice(0, 117)}...` : text });
  }
  return commands;
}

/**
 * The simple commands of a shell script as word lists. Quotes, backslash escapes, comments, line continuations,
 * here-documents and command substitutions (also inside double quotes) are honoured, so "echo 'a; sbt test'",
 * "# sbt test" and here-document text are not commands, while echo "$(sbt test)" is. Command separators
 * (; & | ( ) and backquotes) and line ends start a new command. Linear in the script length.
 */
function shellCommands(script: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  // Each open $( or ` inside double quotes, with its parenthesis depth; closing it returns to the quoted text.
  const substitutions: Array<{ kind: '(' | '`'; depth: number }> = [];
  const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const openSubstitution = (kind: '(' | '`') => {
    substitutions.push({ kind, depth: 0 });
    quote = undefined;
    endCommand();
  };
  const lines = script.split(/\r?\n/);
  for (const line of lines) {
    if (!quote && heredocs.length) {
      // The body ends at a line that is exactly the delimiter (after leading tabs, for <<-).
      const heredoc = heredocs[0];
      if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) heredocs.shift();
      continue;
    }
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quote === "'") {
        if (character === "'") quote = undefined;
        else word += character;
        continue;
      }
      if (quote === '"') {
        if (character === '\\' && index + 1 < line.length) word += line[++index];
        else if (character === '"') quote = undefined;
        else if (character === '$' && line[index + 1] === '(' && line[index + 2] !== '(') {
          index += 1;
          openSubstitution('(');
        } else if (character === '`') openSubstitution('`');
        else word += character;
        continue;
      }
      const substitution = substitutions[substitutions.length - 1];
      if (substitution && ((substitution.kind === '`' && character === '`') || (substitution.kind === '(' && character === ')' && substitution.depth === 0))) {
        substitutions.pop();
        endCommand();
        quote = '"';
        inWord = true;
        continue;
      }
      if (substitution?.kind === '(' && (character === '(' || character === ')')) substitution.depth += character === '(' ? 1 : -1;
      if (character === '\\') {
        if (index + 1 < line.length) {
          word += line[++index];
          inWord = true;
        }
        // A backslash at the end of a line continues the command on the next line.
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        inWord = true;
        continue;
      }
      if (character === '#' && !inWord) break;
      if (line.startsWith('<<<', index)) {
        // A here-string: the next word is input text, not a here-document.
        endWord();
        index += 2;
        continue;
      }
      if (line.startsWith('<<', index)) {
        endWord();
        const stripTabs = line[index + 2] === '-';
        let cursor = index + (stripTabs ? 3 : 2);
        while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
        // The delimiter is one shell word; quotes around (parts of) it are removed.
        let delimiter = '';
        let delimiterQuote: string | undefined;
        for (; cursor < line.length; cursor += 1) {
          const next = line[cursor];
          if (delimiterQuote) {
            if (next === delimiterQuote) delimiterQuote = undefined;
            else delimiter += next;
          } else if (next === "'" || next === '"') {
            delimiterQuote = next;
          } else if (next === '\\' && cursor + 1 < line.length) {
            delimiter += line[++cursor];
          } else if (/[\s;&|()<>]/.test(next)) {
            break;
          } else {
            delimiter += next;
          }
        }
        if (delimiter) heredocs.push({ delimiter, stripTabs });
        index = cursor - 1;
        continue;
      }
      if (/\s/.test(character)) {
        endWord();
      } else if (character === '`' && !substitution) {
        endCommand();
      } else if (';&|()`'.includes(character)) {
        endCommand();
      } else {
        word += character;
        inWord = true;
      }
    }
    if (quote) {
      word += '\n';
    } else if (!line.endsWith('\\') || line.endsWith('\\\\')) {
      endCommand();
    }
  }
  endCommand();
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

const UNREADABLE_VALUE = '(not a plain version)';

/**
 * A workflow version input as the texts it can take. ${{ env.X }} and a plain ${{ matrix.X }} list are resolved within
 * the workflow. Anything else (another expression, a nested or cyclic YAML value, a matrix with include or exclude)
 * stays unresolved text, which cannot be compared and so cannot decide.
 */
function expandValue(value: unknown, env: Record<string, string>, matrix: Record<string, unknown>): string[] {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item.trim() : UNREADABLE_VALUE);
  if (typeof value !== 'string') return [UNREADABLE_VALUE];
  const text = value.trim();
  const reference = /^\$\{\{\s*(env|matrix)\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(text);
  if (!reference) return [text];
  const [, scope, name] = reference;
  if (scope === 'env') return [env[name] ?? text];
  // include and exclude add, change and remove combinations in ways this does not model.
  if (matrix.include !== undefined || matrix.exclude !== undefined || !Array.isArray(matrix[name])) return [text];
  return (matrix[name] as unknown[]).map(item => typeof item === 'string' ? item.trim() : UNREADABLE_VALUE);
}

function workingDirectory(defaults: unknown): string | undefined {
  if (!isRecord(defaults) || !isRecord(defaults.run)) return undefined;
  const directory = defaults.run['working-directory'];
  return typeof directory === 'string' ? directory : undefined;
}

function scalarMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function resolvePomProperties(value: string, project: Record<string, any>): string {
  return value.replace(/\$\{([^}]+)\}/g, (reference, name: string) => {
    const property = xmlText(project.properties?.[name]);
    return property && !property.includes('${') ? property : reference;
  });
}

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
    if (isPathInside(context.repoPath, real)) return true;
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
  // A file read once may be read again (S013 re-reads pom.xml) without counting against the budget.
  if (!context.filesRead.has(relativePath) && context.filesRead.size >= MAX_FILES) {
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
    addDiagnostic(context, 'read_error', `Could not be read (${errorMessage(error)}).`, relativePath);
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
