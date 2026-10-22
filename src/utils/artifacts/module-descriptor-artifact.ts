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
import { validateRepoPath } from '../parsers/common';
import { findCandidateFiles, isWithinRepo, relativePosixPath, walkDirectories } from '../repo-files';

const DESCRIPTOR_NAME = 'ModuleDescriptor.json';
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
        args: ['process-resources', '-DskipTests'],
        cwd: validatedPath,
        timeoutMs: 300000,
        maxOutputBytes: 64 * 1024,
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
  const before = snapshotRootDescriptorPath(repoPath);
  const command = await commandRunner.run({
    command: 'yarn',
    args: ['run', scriptName],
    cwd: repoPath,
    timeoutMs: 180000,
    maxOutputBytes: 64 * 1024,
    requiresIsolation: true,
    networkPolicy: NPM_NETWORK_POLICY
  }, evaluationRun);

  if (command.status === 'blocked') {
    return artifact('unsafe-to-run', {
      strategy: 'frontend-script',
      command,
      errors: [command.errorMessage ?? 'Frontend descriptor generation was blocked']
    });
  }

  if (command.status !== 'success') {
    return artifact('command-failed', {
      strategy: 'frontend-script',
      command,
      errors: [command.errorMessage ?? `Frontend descriptor generation ${command.status}`]
    });
  }

  const rootDescriptor = path.join(repoPath, DESCRIPTOR_NAME);
  if (!isSafeFinalDescriptor(repoPath, rootDescriptor) || !fs.existsSync(rootDescriptor)) {
    return artifact('missing', {
      strategy: 'frontend-script',
      command,
      errors: [`The ${scriptName} script ran, but it did not create ${DESCRIPTOR_NAME} at the repository root.`]
    });
  }

  return selectedArtifact(repoPath, rootDescriptor, 'frontend-script', command, before);
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

function snapshotRootDescriptorPath(repoPath: string): Set<string> {
  const rootDescriptor = path.join(repoPath, DESCRIPTOR_NAME);
  return fs.existsSync(rootDescriptor) && isSafeFinalDescriptor(repoPath, rootDescriptor)
    ? new Set([DESCRIPTOR_NAME])
    : new Set();
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
    command: values.command,
    warnings: values.warnings ?? [],
    errors: values.errors ?? []
  };
}
