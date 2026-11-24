import * as fs from 'fs';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  EvaluationRun,
  ModuleDescriptorArtifact
} from '../../types';
import { GRADLE_NETWORK_POLICY, MAVEN_NETWORK_POLICY, NPM_NETWORK_POLICY } from '../build-tool-policies';
import { defaultCommandRunner } from '../command-runner';
import { hasMavenProject } from '../parsers/maven-dependency-parser';
import { findGradleProjectDir, getGradleCommand } from '../parsers/gradle-dependency-parser';
import { writeFolioNpmrcIfMissing } from '../parsers/npm-dependency-parser';
import { validateRepoPath } from '../parsers/common';
import { findCandidateFiles, isWithinRepo, readBoundedFileBytes, relativePosixPath, walkDirectories } from '../repo-files';
import { errorMessage } from '../type-guards';

const DESCRIPTOR_NAME = 'ModuleDescriptor.json';
const MAX_GENERATED_DESCRIPTOR_BYTES = 8 * 1024 * 1024;
// Stripes modules usually redirect `stripes mod descriptor` output to module-descriptor.json.
const FRONTEND_DESCRIPTOR_NAMES = [DESCRIPTOR_NAME, 'module-descriptor.json'];
export const FRONTEND_DESCRIPTOR_SCRIPTS = ['build-mod-descriptor', 'build-module-descriptor', 'generate-module-descriptor'];

export async function produceModuleDescriptorArtifact(
  repoPath: string,
  evaluationRun?: EvaluationRun,
  commandRunner: CommandRunner = evaluationRun?.commandRunner ?? defaultCommandRunner
): Promise<ModuleDescriptorArtifact> {
  const validatedPath = validateRepoPath(repoPath);
  if (!validatedPath) {
    return artifact('unsafe-to-run', {
      errors: [`The repository path is not valid: ${repoPath}.`]
    });
  }

  if (await hasMavenProject(validatedPath)) {
    return runBuildDescriptorStrategy(validatedPath, {
      strategy: 'maven-generation',
      tool: 'Maven',
      outputDescription: 'a target/ directory',
      findCandidates: () => findGeneratedDescriptorCandidates(validatedPath),
      request: {
        command: 'mvn',
        args: ['-B', '-ntp', 'process-resources', '-DskipTests'],
        cwd: validatedPath,
        timeoutMs: 300000,
        maxOutputBytes: 64 * 1024,
        keepStdoutTail: true,
        requiresIsolation: true,
        networkPolicy: MAVEN_NETWORK_POLICY
      }
    }, evaluationRun, commandRunner);
  }

  // FOLIO's Gradle (Grails) modules generate ModuleDescriptor.json from its template in processResources.
  const gradleProjectDir = findGradleProjectDir(validatedPath);
  if (gradleProjectDir) {
    const gradle = getGradleCommand(gradleProjectDir);
    const resourcesDir = path.join(gradleProjectDir, 'build', 'resources', 'main');
    return runBuildDescriptorStrategy(validatedPath, {
      strategy: 'gradle-generation',
      tool: 'Gradle',
      outputDescription: `${relative(validatedPath, resourcesDir)}/`,
      findCandidates: () => findDescriptorCandidates(validatedPath, resourcesDir),
      request: {
        command: gradle.command,
        args: [...gradle.argsPrefix, 'processResources'],
        cwd: gradleProjectDir,
        timeoutMs: 300000,
        maxOutputBytes: 64 * 1024,
        requiresIsolation: true,
        networkPolicy: GRADLE_NETWORK_POLICY
      }
    }, evaluationRun, commandRunner);
  }

  const frontendScript = getFrontendDescriptorScript(validatedPath);
  if (frontendScript) {
    return runFrontendDescriptorStrategy(validatedPath, frontendScript, evaluationRun, commandRunner);
  }

  return discoverStaticRootDescriptor(validatedPath);
}

interface BuildDescriptorStrategy {
  strategy: 'maven-generation' | 'gradle-generation';
  tool: string;
  /** Where the build writes the generated descriptor, for messages. */
  outputDescription: string;
  findCandidates: () => string[];
  request: CommandExecutionRequest;
}

async function runBuildDescriptorStrategy(
  repoPath: string,
  build: BuildDescriptorStrategy,
  evaluationRun: EvaluationRun | undefined,
  commandRunner: CommandRunner
): Promise<ModuleDescriptorArtifact> {
  const { strategy, tool, findCandidates } = build;
  const before = new Set(findCandidates().map(candidate => relative(repoPath, candidate)));
  const command = await commandRunner.run(build.request, evaluationRun);

  if (command.status === 'blocked') {
    return artifact('unsafe-to-run', {
      strategy,
      command,
      errors: [command.errorMessage ?? `${tool} descriptor generation was blocked`]
    });
  }

  if (command.status !== 'success') {
    return artifact('command-failed', {
      strategy,
      command,
      errors: [command.errorMessage ?? `${tool} descriptor generation ${command.status}`]
    });
  }

  const candidates = findCandidates();
  const selected = await selectGeneratedCandidate(repoPath, candidates);
  if (!selected) {
    return artifact(candidates.length > 1 ? 'ambiguous-candidates' : 'missing', {
      strategy,
      command,
      errors: candidates.length > 1
        ? [`The ${tool} build generated several ModuleDescriptor.json files, and no single one could be matched to this module: ${candidates.map(candidate => relative(repoPath, candidate)).join(', ')}.`]
        : [`The ${tool} build ran, but it did not generate a ModuleDescriptor.json under ${build.outputDescription}.`]
    });
  }

  return selectedArtifact(repoPath, selected, strategy, command, before);
}

async function runFrontendDescriptorStrategy(
  repoPath: string,
  scriptName: string,
  evaluationRun: EvaluationRun | undefined,
  commandRunner: CommandRunner
): Promise<ModuleDescriptorArtifact> {
  // Descriptor scripts call the Stripes CLI, a devDependency, so devDependencies are installed too.
  const installRequest: CommandExecutionRequest = {
    command: 'yarn',
    args: ['install', '--ignore-scripts', '--ignore-engines', '--pure-lockfile'],
    cwd: repoPath,
    timeoutMs: 300000,
    maxOutputBytes: 64 * 1024,
    requiresIsolation: true,
    networkPolicy: NPM_NETWORK_POLICY
  };
  const before = backUpRootDescriptors(repoPath, scriptName);
  if (typeof before === 'string') {
    return artifact('unsafe-to-run', { strategy: 'frontend-script', descriptorScript: scriptName, errors: [before] });
  }

  const hadNodeModules = pathExists(path.join(repoPath, 'node_modules'));
  let wroteNpmrc = false;
  let result: ModuleDescriptorArtifact | undefined;
  try {
    if (commandRunner.canRun?.(installRequest) ?? true) {
      try {
        wroteNpmrc = writeFolioNpmrcIfMissing(repoPath);
      } catch (error) {
        result = artifact('unsafe-to-run', {
          strategy: 'frontend-script',
          descriptorScript: scriptName,
          errors: [`The evaluator could not write the .npmrc the dependency install needs: ${errorMessage(error)}`]
        });
        return result;
      }
    }
    result = await generateFrontendDescriptor(repoPath, scriptName, installRequest, before, evaluationRun, commandRunner);
    return result;
  } finally {
    const created = [
      ...(hadNodeModules ? [] : ['node_modules']),
      ...(wroteNpmrc ? ['.npmrc'] : []),
      ...FRONTEND_DESCRIPTOR_NAMES.filter(name => !before.has(name))
    ];
    const problems = [...restoreRootDescriptors(repoPath, before), ...removeCreatedPaths(repoPath, created)];
    result?.warnings.push(...problems);
  }
}

async function generateFrontendDescriptor(
  repoPath: string,
  scriptName: string,
  installRequest: CommandExecutionRequest,
  before: Map<string, RootDescriptorBackup>,
  evaluationRun: EvaluationRun | undefined,
  commandRunner: CommandRunner
): Promise<ModuleDescriptorArtifact> {
  const installCommand = await commandRunner.run(installRequest, evaluationRun);
  const source = { strategy: 'frontend-script' as const, descriptorScript: scriptName, installCommand };
  if (installCommand.status !== 'success') {
    return commandProblemArtifact(installCommand, source, `Installing the dependencies of the ${scriptName} script`);
  }

  const command = await commandRunner.run({
    command: 'yarn',
    args: ['run', scriptName],
    cwd: repoPath,
    timeoutMs: 180000,
    maxOutputBytes: 64 * 1024,
    requiresIsolation: true,
    networkPolicy: NPM_NETWORK_POLICY
  }, evaluationRun);
  if (command.status !== 'success') {
    return commandProblemArtifact(command, { ...source, command }, 'Frontend descriptor generation');
  }

  const selected = FRONTEND_DESCRIPTOR_NAMES
    .map(name => path.join(repoPath, name))
    .find(candidate => pathSignature(candidate) !== before.get(path.basename(candidate))?.signature && isSafeFinalDescriptor(repoPath, candidate));
  if (!selected) {
    return artifact('missing', {
      ...source,
      command,
      errors: [`The ${scriptName} script ran, but it did not write ${FRONTEND_DESCRIPTOR_NAMES.join(' or ')} at the repository root.`]
    });
  }

  const name = path.basename(selected);
  const produced: ModuleDescriptorArtifact = {
    ...selectedArtifact(repoPath, selected, 'frontend-script', command, new Set(before.keys())),
    // The script's output is removed or restored afterwards, so only its content is kept.
    absolutePath: undefined,
    descriptorScript: scriptName,
    installCommand
  };
  let content: string;
  try {
    content = readDescriptorText(selected);
  } catch (error) {
    return { ...produced, readError: errorMessage(error) };
  }

  if (content.trim() === '') {
    return artifact('invalid-candidate', {
      ...source,
      command,
      descriptorPath: name,
      errors: [`The ${scriptName} script exited successfully, but the ${name} it left at the repository root is empty; a command earlier in the script may have failed without failing the script.`]
    });
  }

  return { ...produced, content };
}

function readDescriptorText(descriptorPath: string): string {
  return readDescriptorBytes(descriptorPath).toString('utf-8');
}

function readDescriptorBytes(descriptorPath: string): Buffer {
  if (!fs.statSync(descriptorPath).isFile()) {
    throw new Error('it is not a regular file');
  }
  const bytes = readBoundedFileBytes(descriptorPath, MAX_GENERATED_DESCRIPTOR_BYTES + 1);
  if (bytes.length > MAX_GENERATED_DESCRIPTOR_BYTES) {
    throw new Error(`it is larger than ${MAX_GENERATED_DESCRIPTOR_BYTES / (1024 * 1024)} MiB`);
  }
  return bytes;
}

function removeCreatedPaths(repoPath: string, names: string[]): string[] {
  const problems: string[] = [];
  for (const name of names) {
    try {
      fs.rmSync(path.join(repoPath, name), { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      problems.push(`The evaluator could not remove ${name}, which it created while generating the descriptor: ${errorMessage(error)}`);
    }
  }
  return problems;
}

function commandProblemArtifact(
  command: CommandExecutionResult,
  values: Partial<ModuleDescriptorArtifact>,
  action: string
): ModuleDescriptorArtifact {
  return command.status === 'blocked'
    ? artifact('unsafe-to-run', { ...values, errors: [command.errorMessage ?? `${action} was blocked`] })
    : artifact('command-failed', { ...values, errors: [command.errorMessage ?? `${action} ${command.status}`] });
}

function discoverStaticRootDescriptor(repoPath: string): ModuleDescriptorArtifact {
  const rootDescriptor = path.join(repoPath, DESCRIPTOR_NAME);
  if (fs.existsSync(rootDescriptor) && isSafeFinalDescriptor(repoPath, rootDescriptor)) {
    return selectedArtifact(repoPath, rootDescriptor, 'static-root');
  }

  const templates = findTemplateCandidates(repoPath);
  if (templates.length > 0) {
    return artifact('invalid-candidate', {
      errors: [`Only descriptor templates were found (${templates.map(candidate => relative(repoPath, candidate)).join(', ')}), and nothing generates a ${DESCRIPTOR_NAME} from them.`]
    });
  }

  return artifact('missing', {
    errors: [`No ${DESCRIPTOR_NAME} was found at the repository root, and there is no Maven or Gradle build or package.json script to generate one.`]
  });
}

function getFrontendDescriptorScript(repoPath: string): string | undefined {
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return FRONTEND_DESCRIPTOR_SCRIPTS.find(script => typeof packageJson.scripts?.[script] === 'string');
  } catch {
    return undefined;
  }
}

// Candidates are already final descriptors inside the repository (see findDescriptorCandidates),
// so several candidates without a single match really are ambiguous.
async function selectGeneratedCandidate(repoPath: string, candidates: string[]): Promise<string | undefined> {
  if (candidates.length <= 1) {
    return candidates[0];
  }

  const moduleName = await getExpectedModuleName(repoPath);
  const matching = candidates.filter(candidate => descriptorMatchesModule(candidate, moduleName));
  return matching.length === 1 ? matching[0] : undefined;
}

async function getExpectedModuleName(repoPath: string): Promise<string | undefined> {
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      return typeof packageJson.name === 'string' ? packageJson.name.replace(/^@folio\//, '') : undefined;
    } catch {
      return undefined;
    }
  }

  const pomPath = path.join(repoPath, 'pom.xml');
  if (fs.existsSync(pomPath)) {
    try {
      const parsed = await parseStringPromise(fs.readFileSync(pomPath, 'utf-8'), { explicitArray: true });
      return parsed?.project?.artifactId?.[0];
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function descriptorMatchesModule(candidate: string, moduleName?: string): boolean {
  if (!moduleName) {
    return false;
  }

  try {
    const descriptor = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
    // Descriptor ids are "<artifactId>" or "<artifactId>-<version>"; a prefix such as mod-foo must not match mod-foo-bar.
    return typeof descriptor.id === 'string' &&
      (descriptor.id === moduleName || (descriptor.id.startsWith(`${moduleName}-`) && /^\d/.test(descriptor.id.slice(moduleName.length + 1))));
  } catch {
    return false;
  }
}

function selectedArtifact(
  repoPath: string,
  descriptorPath: string,
  strategy: NonNullable<ModuleDescriptorArtifact['strategy']>,
  command?: CommandExecutionResult,
  before: Set<string> = new Set()
): ModuleDescriptorArtifact {
  const relativePath = relative(repoPath, descriptorPath);
  const warnings = strategy === 'static-root' || before.has(relativePath)
    ? []
    : [`${relativePath} was generated during this evaluation; it is not committed to the repository.`];
  return artifact(strategy === 'static-root' ? 'discovered' : 'produced', {
    strategy,
    descriptorPath: relativePath,
    absolutePath: descriptorPath,
    command,
    warnings
  });
}

function findGeneratedDescriptorCandidates(repoPath: string): string[] {
  const candidates: string[] = [];
  walkDirectories(repoPath, directory => {
    if (path.basename(directory) === 'target') {
      candidates.push(...findDescriptorCandidates(repoPath, directory));
      return false;
    }

    return true;
  });

  return candidates;
}

function findDescriptorCandidates(repoPath: string, startPath: string): string[] {
  return findCandidateFiles(repoPath, startPath, candidate =>
    path.basename(candidate) === DESCRIPTOR_NAME && !isTemplatePath(repoPath, candidate)
  );
}

function findTemplateCandidates(repoPath: string): string[] {
  return findCandidateFiles(repoPath, repoPath, candidate =>
    isDescriptorTemplateName(path.basename(candidate)) && isTemplatePath(repoPath, candidate)
  );
}

function isSafeFinalDescriptor(repoPath: string, candidatePath: string): boolean {
  if (isTemplatePath(repoPath, candidatePath)) {
    return false;
  }

  return isWithinRepo(repoPath, candidatePath);
}

// Only the repository-relative path counts; the clone directory's own name must not make files look like templates.
function isTemplatePath(repoPath: string, candidatePath: string): boolean {
  return relative(repoPath, candidatePath).toLowerCase().includes('template');
}

function isDescriptorTemplateName(fileName: string): boolean {
  return /moduledescriptor.*\.json$/i.test(fileName);
}

interface RootDescriptorBackup {
  signature: string;
  bytes: Buffer;
}

/** Backs up the root descriptors the script may overwrite, or explains why the script cannot run safely. */
function backUpRootDescriptors(repoPath: string, scriptName: string): Map<string, RootDescriptorBackup> | string {
  const backups = new Map<string, RootDescriptorBackup>();
  for (const name of FRONTEND_DESCRIPTOR_NAMES) {
    const candidate = path.join(repoPath, name);
    const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      return `${name} at the repository root is a symbolic link, and a committed descriptor symlink cannot be safely regenerated, so the ${scriptName} script was not run.`;
    }
    try {
      backups.set(name, { signature: pathSignature(candidate) ?? '', bytes: readDescriptorBytes(candidate) });
    } catch (error) {
      return `${name} at the repository root could not be backed up (${errorMessage(error)}), so the ${scriptName} script was not run.`;
    }
  }
  return backups;
}

function restoreRootDescriptors(repoPath: string, before: Map<string, RootDescriptorBackup>): string[] {
  const problems: string[] = [];
  for (const [name, backup] of before) {
    const candidate = path.join(repoPath, name);
    try {
      if (pathSignature(candidate) === backup.signature) {
        continue;
      }
      const current = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (current?.isFile() && readBoundedFileBytes(candidate, backup.bytes.length + 1).equals(backup.bytes)) {
        continue;
      }
      fs.rmSync(candidate, { recursive: true, force: true, maxRetries: 3 });
      fs.writeFileSync(candidate, backup.bytes, { flag: 'wx' });
    } catch (error) {
      problems.push(`The evaluator could not restore ${name}, which the descriptor script changed: ${errorMessage(error)}`);
    }
  }
  return problems;
}

function pathSignature(candidatePath: string): string | undefined {
  const stats = fs.lstatSync(candidatePath, { throwIfNoEntry: false });
  return stats && `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function pathExists(candidatePath: string): boolean {
  return pathSignature(candidatePath) !== undefined;
}

function relative(repoPath: string, candidatePath: string): string {
  return relativePosixPath(repoPath, candidatePath);
}

function artifact(
  status: ModuleDescriptorArtifact['status'],
  values: Partial<ModuleDescriptorArtifact>
): ModuleDescriptorArtifact {
  return {
    status,
    strategy: values.strategy,
    descriptorPath: values.descriptorPath,
    absolutePath: values.absolutePath,
    content: values.content,
    readError: values.readError,
    descriptorScript: values.descriptorScript,
    installCommand: values.installCommand,
    command: values.command,
    warnings: values.warnings ?? [],
    errors: values.errors ?? []
  };
}
