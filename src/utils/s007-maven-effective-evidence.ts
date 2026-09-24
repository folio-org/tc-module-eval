import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import {
  CommandRunner,
  EvaluationRun,
  S007TechnologyEvidenceResult,
  S007TechnologyObservation
} from '../types';
import { MAVEN_NETWORK_POLICY } from './build-tool-policies';
import { isWithinRepo } from './repo-files';
import { finalizeS007TechnologyEvidence, matchJavaIdentity } from './s007-technology-evidence';

const EFFECTIVE_POM_GOAL = 'org.apache.maven.plugins:maven-help-plugin:3.5.2:effective-pom';
const MAX_EFFECTIVE_POM_BYTES = 2 * 1024 * 1024;
const MAX_EFFECTIVE_POMS = 12;

interface MavenProjectIdentity {
  groupId: string;
  artifactId: string;
  version: string;
}

interface EffectiveMavenDependency {
  key: string;
  coordinates: string;
  version: string;
}

export async function enrichS007WithMavenEffectivePom(
  repoPath: string,
  evidence: S007TechnologyEvidenceResult,
  evaluationRun: EvaluationRun,
  commandRunner: CommandRunner
): Promise<S007TechnologyEvidenceResult> {
  const unresolvedByPom = unresolvedMavenObservations(evidence);
  if (unresolvedByPom.size === 0) return evidence;

  let observations = evidence.observations;
  let diagnostics = evidence.diagnostics;
  let changed = false;

  for (const [sourcePath, unresolved] of [...unresolvedByPom].slice(0, MAX_EFFECTIVE_POMS)) {
    const effective = await produceEffectivePom(repoPath, sourcePath, evaluationRun, commandRunner);
    if (!effective) continue;

    const resolvedCoordinates = new Set<string>();
    observations = observations.map(observation => {
      if (!unresolved.includes(observation)) return observation;
      const versions = effective.versions.get(mavenDependencyKey(observation.mavenDependency!));
      if (!versions || versions.size !== 1) return observation;
      const resolvedVersion = [...versions][0];
      if (!isConcreteVersion(resolvedVersion)) return observation;
      resolvedCoordinates.add(observation.sourceDetail);
      changed = true;
      return {
        ...observation,
        resolvedVersion,
        versionSourcePath: sourcePath,
        resolutionSource: 'maven-effective-pom',
        confidence: 'confident',
        provenance: 'shared-remote-resolution',
        repositoryDeclared: true
      };
    });

    const representedKeys = new Set(observations
      .filter(observation => observation.sourcePath === sourcePath && observation.mavenDependency)
      .map(observation => mavenDependencyKey(observation.mavenDependency!)));
    for (const suppressed of evidence.suppressedMavenDependencies ?? []) {
      if (suppressed.sourcePath === sourcePath) {
        representedKeys.add(mavenDependencyKey(suppressed.dependency));
      }
    }
    for (const dependency of effective.dependencies) {
      const [groupId, artifactId] = dependency.coordinates.split(':');
      if (!matchJavaIdentity(groupId, artifactId)) continue;
      if (representedKeys.has(dependency.key)) continue;
      const message = `Effective Maven model for ${sourcePath} includes inherited S007-relevant dependency ${dependency.coordinates} (${dependency.key}) that was not represented by static repository evidence.`;
      if (!diagnostics.some(diagnostic => diagnostic.code === 'effective_model_unrepresented' && diagnostic.message === message)) {
        diagnostics = [...diagnostics, { code: 'effective_model_unrepresented', message, material: true, path: sourcePath }];
        changed = true;
      }
    }

    diagnostics = diagnostics.filter(diagnostic => {
      if (diagnostic.path !== sourcePath) return true;
      if (diagnostic.code === 'maven_remote_parent' || diagnostic.code === 'maven_imported_bom') {
        changed = true;
        return false;
      }
      if (
        diagnostic.code === 'version_unresolved' &&
        [...resolvedCoordinates].some(coordinates =>
          diagnostic.message === `Version for ${coordinates} could not be resolved from local Maven metadata.`
        )
      ) {
        return false;
      }
      return true;
    });
  }

  if (!changed) return evidence;
  return finalizeS007TechnologyEvidence({
    ...evidence,
    observations,
    diagnostics,
    complete: !diagnostics.some(diagnostic => diagnostic.material)
  });
}

function unresolvedMavenObservations(
  evidence: S007TechnologyEvidenceResult
): Map<string, S007TechnologyObservation[]> {
  const byPom = new Map<string, S007TechnologyObservation[]>();
  for (const observation of evidence.observations) {
    if (
      observation.ecosystem !== 'java' ||
      observation.evidenceKind !== 'dependency-declaration' ||
      !observation.sourcePath.endsWith('pom.xml') ||
      observation.declaredVersion ||
      observation.resolvedVersion ||
      observation.versionResolutionEligible === false ||
      !observation.mavenDependency
    ) continue;
    byPom.set(observation.sourcePath, [...(byPom.get(observation.sourcePath) ?? []), observation]);
  }
  return byPom;
}

async function produceEffectivePom(
  repoPath: string,
  sourcePath: string,
  evaluationRun: EvaluationRun,
  commandRunner: CommandRunner
): Promise<{ versions: Map<string, Set<string>>; dependencies: EffectiveMavenDependency[] } | undefined> {
  const pomPath = path.resolve(repoPath, sourcePath);
  if (!pomPath.startsWith(`${path.resolve(repoPath)}${path.sep}`) && pomPath !== path.resolve(repoPath)) return undefined;
  if (
    !fs.existsSync(pomPath) ||
    fs.lstatSync(pomPath).isSymbolicLink() ||
    !fs.statSync(pomPath).isFile() ||
    !isWithinRepo(repoPath, pomPath)
  ) return undefined;

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 's007-effective-pom-'));
  const outputPath = path.join(workspace, 'effective-pom.xml');
  try {
    const command = await commandRunner.run({
      command: 'mvn',
      args: [
        '-q',
        '-N',
        '-f',
        pomPath,
        EFFECTIVE_POM_GOAL,
        `-Doutput=${outputPath}`,
        '-Dstyle.color=never'
      ],
      cwd: repoPath,
      timeoutMs: 180000,
      maxOutputBytes: 64 * 1024,
      requiresIsolation: true,
      networkPolicy: MAVEN_NETWORK_POLICY
    }, evaluationRun);
    if (command.status !== 'success') return undefined;

    const stat = fs.lstatSync(outputPath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_EFFECTIVE_POM_BYTES) return undefined;
    const [sourceProject, effectiveProject] = await Promise.all([
      parseMavenProject(fs.readFileSync(pomPath, 'utf-8'), true),
      parseMavenProject(fs.readFileSync(outputPath, 'utf-8'), false)
    ]);
    if (!sourceProject || !effectiveProject || !sameProject(sourceProject.identity, effectiveProject.identity)) {
      return undefined;
    }
    return { versions: effectiveProject.versions, dependencies: effectiveProject.dependencies };
  } catch {
    return undefined;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function parseMavenProject(
  content: string,
  allowInheritedIdentity: boolean
): Promise<{
  identity: MavenProjectIdentity;
  versions: Map<string, Set<string>>;
  dependencies: EffectiveMavenDependency[];
} | undefined> {
  const parsed = await parseStringPromise(content, { explicitArray: false, trim: true });
  const project = parsed?.project;
  if (!project || typeof project !== 'object') return undefined;
  const identity = {
    groupId: xmlText(project.groupId) || (allowInheritedIdentity ? xmlText(project.parent?.groupId) : ''),
    artifactId: xmlText(project.artifactId),
    version: xmlText(project.version) || (allowInheritedIdentity ? xmlText(project.parent?.version) : '')
  };
  if (!identity.groupId || !identity.artifactId || !identity.version) return undefined;

  const versions = new Map<string, Set<string>>();
  const dependencies: EffectiveMavenDependency[] = [];
  for (const dependency of asArray(project.dependencies?.dependency)) {
    const coordinates = mavenCoordinatesFromDependency(dependency);
    const version = xmlText(dependency?.version);
    if (!coordinates || !version) {
      if (!allowInheritedIdentity) return undefined;
      continue;
    }
    const [groupId, artifactId] = coordinates.split(':');
    const key = mavenDependencyKey({
      groupId,
      artifactId,
      type: xmlText(dependency?.type) || 'jar',
      classifier: xmlText(dependency?.classifier)
    });
    versions.set(key, new Set([...(versions.get(key) ?? []), version]));
    dependencies.push({ key, coordinates, version });
  }
  return { identity, versions, dependencies };
}

function sameProject(source: MavenProjectIdentity, effective: MavenProjectIdentity): boolean {
  return source.groupId === effective.groupId &&
    source.artifactId === effective.artifactId &&
    source.version === effective.version;
}

function mavenDependencyKey(dependency: NonNullable<S007TechnologyObservation['mavenDependency']>): string {
  return [dependency.groupId, dependency.artifactId, dependency.type, dependency.classifier].join(':');
}

function mavenCoordinatesFromDependency(dependency: any): string | undefined {
  const groupId = xmlText(dependency?.groupId);
  const artifactId = xmlText(dependency?.artifactId);
  return groupId && artifactId ? `${groupId}:${artifactId}` : undefined;
}

function isConcreteVersion(value: string): boolean {
  return value.length > 0 && !value.includes('${') && !value.includes('[') && !value.includes('(');
}

function xmlText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && '_' in value && typeof (value as { _: unknown })._ === 'string') {
    return (value as { _: string })._.trim();
  }
  return '';
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
