import * as fs from 'fs';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import {
  CommandExecutionResult,
  CommandRunner,
  EvaluationRun,
  ModuleDescriptorArtifact
} from '../../types';
import { defaultCommandRunner } from '../command-runner';
import { validateRepoPath } from '../parsers/common';

const DESCRIPTOR_NAME = 'ModuleDescriptor.json';
const FRONTEND_DESCRIPTOR_SCRIPTS = ['build-mod-descriptor', 'build-module-descriptor', 'generate-module-descriptor'];

export async function produceModuleDescriptorArtifact(
  repoPath: string,
  evaluationRun?: EvaluationRun,
  commandRunner: CommandRunner = evaluationRun?.commandRunner ?? defaultCommandRunner
): Promise<ModuleDescriptorArtifact> {
  const validatedPath = validateRepoPath(repoPath);
  if (!validatedPath) {
    return artifact('unsafe-to-run', {
      errors: [`Invalid repository path: ${repoPath}`]
    });
  }

  if (fs.existsSync(path.join(validatedPath, 'pom.xml'))) {
    return runMavenDescriptorStrategy(validatedPath, evaluationRun, commandRunner);
  }

  const frontendScript = getFrontendDescriptorScript(validatedPath);
  if (frontendScript) {
    return runFrontendDescriptorStrategy(validatedPath, frontendScript, evaluationRun, commandRunner);
  }

  return discoverStaticRootDescriptor(validatedPath);
}

async function runMavenDescriptorStrategy(
  repoPath: string,
  evaluationRun: EvaluationRun | undefined,
  commandRunner: CommandRunner
): Promise<ModuleDescriptorArtifact> {
  const before = snapshotDescriptorPaths(repoPath);
  const command = await commandRunner.run({
    command: 'mvn',
    args: ['process-resources', '-DskipTests'],
    cwd: repoPath,
    timeoutMs: 300000,
    maxOutputBytes: 64 * 1024,
    requiresIsolation: true,
    networkPolicy: {
      default: 'deny',
      allowedHosts: ['repo.maven.apache.org', 'repository.folio.org']
    }
  }, evaluationRun);

  if (command.status === 'blocked') {
    return artifact('unsafe-to-run', {
      strategy: 'maven-generation',
      command,
      errors: [command.errorMessage ?? 'Maven descriptor generation was blocked']
    });
  }

  if (command.status !== 'success') {
    return artifact('command-failed', {
      strategy: 'maven-generation',
      command,
      errors: [command.errorMessage ?? `Maven descriptor generation ${command.status}`]
    });
  }

  const candidates = findGeneratedDescriptorCandidates(repoPath);
  const selected = await selectGeneratedCandidate(repoPath, candidates);
  if (!selected) {
    return artifact(candidates.length > 1 ? 'ambiguous-candidates' : 'missing', {
      strategy: 'maven-generation',
      command,
      errors: candidates.length > 1
        ? [`Ambiguous generated descriptors: ${candidates.map(candidate => relative(repoPath, candidate)).join(', ')}`]
        : ['Maven descriptor generation completed but no final ModuleDescriptor.json was found under a target/ directory']
    });
  }

  return selectedArtifact(repoPath, selected, 'maven-generation', command, before);
}

async function runFrontendDescriptorStrategy(
  repoPath: string,
  scriptName: string,
  evaluationRun: EvaluationRun | undefined,
  commandRunner: CommandRunner
): Promise<ModuleDescriptorArtifact> {
  const before = snapshotDescriptorPaths(repoPath);
  const command = await commandRunner.run({
    command: 'yarn',
    args: ['run', scriptName],
    cwd: repoPath,
    timeoutMs: 180000,
    maxOutputBytes: 64 * 1024,
    requiresIsolation: true,
    networkPolicy: {
      default: 'deny',
      allowedHosts: ['registry.yarnpkg.com', 'registry.npmjs.org', 'repository.folio.org']
    }
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
      errors: [`Frontend script ${scriptName} completed but did not produce ${DESCRIPTOR_NAME}`]
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
      errors: [`Only descriptor templates were found: ${templates.map(candidate => relative(repoPath, candidate)).join(', ')}`]
    });
  }

  return artifact('missing', {
    errors: [`No final ${DESCRIPTOR_NAME} was produced or discovered`]
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

async function selectGeneratedCandidate(repoPath: string, candidates: string[]): Promise<string | undefined> {
  const safeCandidates = candidates.filter(candidate => isSafeFinalDescriptor(repoPath, candidate));
  if (safeCandidates.length <= 1) {
    return safeCandidates[0];
  }

  const moduleName = await getExpectedModuleName(repoPath);
  const matching = safeCandidates.filter(candidate => descriptorMatchesModule(candidate, moduleName));
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
    return typeof descriptor.id === 'string' && descriptor.id.includes(moduleName);
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
    : [`Descriptor written during evaluation: ${relativePath}`];
  return artifact(strategy === 'static-root' ? 'discovered' : 'produced', {
    strategy,
    descriptorPath: relativePath,
    absolutePath: descriptorPath,
    command,
    warnings
  });
}

function findGeneratedDescriptorCandidates(repoPath: string): string[] {
  return findDescriptorCandidates(repoPath, repoPath)
    .filter(candidate => relative(repoPath, candidate).split('/').includes('target'));
}

function findDescriptorCandidates(repoPath: string, startPath: string): string[] {
  if (!fs.existsSync(startPath)) {
    return [];
  }

  const candidates: string[] = [];
  const walk = (current: string): void => {
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) {
      return;
    }
    if (stats.isFile() && path.basename(current) === DESCRIPTOR_NAME && !isTemplatePath(current)) {
      candidates.push(current);
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }
    for (const entry of fs.readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.git') {
        continue;
      }
      walk(path.join(current, entry));
    }
  };

  walk(startPath);
  return candidates.filter(candidate => isSafeFinalDescriptor(repoPath, candidate));
}

function findTemplateCandidates(repoPath: string): string[] {
  if (!fs.existsSync(repoPath)) {
    return [];
  }

  const candidates: string[] = [];
  const walk = (current: string): void => {
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) {
      return;
    }
    if (stats.isFile() && path.basename(current).endsWith('.json') && isTemplatePath(current)) {
      candidates.push(current);
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }
    for (const entry of fs.readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.git') {
        continue;
      }
      walk(path.join(current, entry));
    }
  };

  walk(repoPath);
  return candidates.filter(candidate => isWithinRepo(repoPath, candidate));
}

function isSafeFinalDescriptor(repoPath: string, candidatePath: string): boolean {
  if (isTemplatePath(candidatePath)) {
    return false;
  }

  return isWithinRepo(repoPath, candidatePath);
}

function isWithinRepo(repoPath: string, candidatePath: string): boolean {
  try {
    const repoRealPath = fs.realpathSync(repoPath);
    const candidateRealPath = fs.realpathSync(candidatePath);
    return candidateRealPath.startsWith(`${repoRealPath}${path.sep}`) || candidateRealPath === repoRealPath;
  } catch {
    return false;
  }
}

function isTemplatePath(candidatePath: string): boolean {
  return candidatePath.toLowerCase().includes('template');
}

function snapshotDescriptorPaths(repoPath: string): Set<string> {
  return new Set(findDescriptorCandidates(repoPath, repoPath).map(candidate => relative(repoPath, candidate)));
}

function relative(repoPath: string, candidatePath: string): string {
  return path.relative(repoPath, candidatePath).split(path.sep).join('/');
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
