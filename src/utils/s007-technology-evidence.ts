import * as fs from 'fs';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import { parse as parseYarnLock } from '@yarnpkg/lockfile';
import {
  S007Ecosystem,
  S007EvidenceDiagnostic,
  S007TechnologyEvidenceResult,
  S007TechnologyObservation
} from '../types';
import { isWithinRepo, relativePosixPath } from './repo-files';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANIFESTS = 64;
const MAX_OBSERVATIONS = 1024;
const MAX_MAVEN_PROPERTY_DEPTH = 16;

interface EvidenceFinalizationContext {
  observations: S007TechnologyObservation[];
  diagnostics: S007EvidenceDiagnostic[];
  presenceOnlyObservations: Set<S007TechnologyObservation>;
  suppressedMavenDependencies: NonNullable<S007TechnologyEvidenceResult['suppressedMavenDependencies']>;
}

interface EvidenceContext extends EvidenceFinalizationContext {
  repoPath: string;
  manifestPaths: Set<string>;
  manifestContents: Map<string, string>;
  visited: Set<string>;
  mavenModuleCandidates: number;
  gradleModuleCandidates: number;
  mavenContexts: Map<string, MavenContext>;
  observationKeys: Set<string>;
}

export interface S007JavaIdentity {
  id: string;
  displayName: string;
  ecosystem: S007Ecosystem;
  technologyType: 'language' | 'framework' | 'library';
  unlisted?: true;
}

type Identity = S007JavaIdentity;

interface MavenContext {
  properties: Map<string, { value: string; sourcePath: string }>;
  dependencyManagement: Map<string, { rawValue: string; value: string; sourcePath: string }>;
}

interface JavaScriptDeclaration {
  packageName: string;
  range: string;
  field: string;
  identity: Identity;
}

const JAVASCRIPT_IDENTITIES: Record<string, Identity> = {
  '@folio/stripes': identity('stripes', 'Stripes', 'javascript', 'framework'),
  react: identity('react', 'React', 'javascript', 'framework'),
  'react-dom': identity('react', 'React', 'javascript', 'framework'),
  '@angular/core': identity('angular', 'Angular', 'javascript', 'framework', true),
  vue: identity('vue', 'Vue', 'javascript', 'framework', true),
  svelte: identity('svelte', 'Svelte', 'javascript', 'framework', true),
  express: identity('express', 'Express', 'javascript', 'framework', true),
  '@nestjs/core': identity('nestjs', 'NestJS', 'javascript', 'framework', true)
};

const JAVA_EXACT_IDENTITIES: Record<string, Identity> = {
  'org.folio:folio-spring-base': identity('folio-spring-base', 'folio-spring-base', 'java', 'framework'),
  'org.folio:folio-vertx-lib': identity('folio-vertx-lib', 'folio-vertx-lib', 'java', 'framework'),
  'org.folio:raml-module-builder': identity('raml-module-builder', 'raml-module-builder', 'java', 'framework'),
  'org.folio:edge-common': identity('edge-common', 'edge-common', 'java', 'framework'),
  'org.folio:edge-common-spring': identity('edge-common-spring', 'edge-common-spring', 'java', 'framework'),
  'org.folio:folio-s3-client': identity('folio-s3-client', 'folio-s3-client', 'java', 'library'),
  'org.projectlombok:lombok': identity('lombok', 'Lombok', 'java', 'library'),
  'io.minio:minio': identity('minio-java', 'MinIO Java Client', 'java', 'library'),
  'org.keycloak:keycloak-admin-client': identity('keycloak-admin-client', 'Keycloak Admin Client', 'java', 'library')
};

export async function collectS007TechnologyEvidence(
  repoPath: string,
  language: 'java' | 'javascript'
): Promise<S007TechnologyEvidenceResult> {
  const context: EvidenceContext = {
    repoPath: fs.realpathSync(path.resolve(repoPath)),
    observations: [],
    diagnostics: [],
    manifestPaths: new Set<string>(),
    manifestContents: new Map<string, string>(),
    visited: new Set<string>(),
    mavenModuleCandidates: 0,
    gradleModuleCandidates: 0,
    mavenContexts: new Map<string, MavenContext>(),
    observationKeys: new Set<string>(),
    presenceOnlyObservations: new Set<S007TechnologyObservation>(),
    suppressedMavenDependencies: []
  };

  if (language === 'javascript') {
    collectJavaScriptEvidence(context);
  } else {
    await collectMavenEvidence(context);
    collectGradleEvidence(context);
  }

  finalizePresenceOnlyObservations(context);
  markConflicts(context);
  if (context.observations.length === 0) {
    diagnostic(context, 'insufficient_evidence', 'No S007-relevant repository evidence was found.', true);
  }

  return {
    observations: context.observations,
    diagnostics: context.diagnostics,
    manifestPaths: [...context.manifestPaths].sort(),
    suppressedMavenDependencies: context.suppressedMavenDependencies,
    complete: !context.diagnostics.some(item => item.material)
  };
}

export function finalizeS007TechnologyEvidence(
  evidence: S007TechnologyEvidenceResult
): S007TechnologyEvidenceResult {
  const context: EvidenceFinalizationContext = {
    observations: evidence.observations.map(observation => ({
      ...observation,
      conflictPaths: observation.conflictPaths ? [...observation.conflictPaths] : undefined
    })),
    diagnostics: [...evidence.diagnostics],
    presenceOnlyObservations: new Set(),
    suppressedMavenDependencies: [...(evidence.suppressedMavenDependencies ?? [])]
  };
  context.presenceOnlyObservations = new Set(
    context.observations.filter(observation => observation.versionResolutionEligible === false)
  );
  finalizePresenceOnlyObservations(context);
  markConflicts(context);
  return {
    ...evidence,
    observations: context.observations,
    diagnostics: context.diagnostics,
    suppressedMavenDependencies: context.suppressedMavenDependencies,
    complete: !context.diagnostics.some(item => item.material)
  };
}

function collectJavaScriptEvidence(context: EvidenceContext): void {
  const packagePath = path.join(context.repoPath, 'package.json');
  const content = readManifest(context, packagePath);
  if (content === undefined) {
    if (!fs.existsSync(packagePath)) {
      diagnostic(context, 'manifest_missing', 'package.json was not found.', true, 'package.json');
    }
    return;
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    diagnostic(
      context,
      'manifest_malformed',
      `Unable to parse package.json: ${errorMessage(error)}`,
      true,
      'package.json'
    );
    return;
  }

  const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
  const declarations: JavaScriptDeclaration[] = [];
  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      continue;
    }
    for (const [packageName, range] of Object.entries(dependencies)) {
      const matched = JAVASCRIPT_IDENTITIES[packageName];
      if (matched && typeof range === 'string') {
        declarations.push({ packageName, range, field, identity: matched });
      }
    }
  }

  const hasTypeScript = Boolean(
    (manifest.dependencies as Record<string, unknown> | undefined)?.typescript
    || (manifest.devDependencies as Record<string, unknown> | undefined)?.typescript
    || fs.existsSync(path.join(context.repoPath, 'tsconfig.json'))
  );
  addObservation(context, {
    identityCandidates: [hasTypeScript ? 'typescript' : 'javascript'],
    displayName: hasTypeScript ? 'TypeScript' : 'JavaScript',
    ecosystem: 'javascript',
    technologyType: 'language',
    evidenceKind: 'language-indicator',
    sourcePath: 'package.json',
    sourceDetail: hasTypeScript ? 'TypeScript project indicator' : 'JavaScript package manifest',
    confidence: 'confident',
    provenance: 'repository-static'
  });

  const lockVersions = collectYarnClassicVersions(context, declarations);
  const installedIdentities = new Set(
    declarations
      .filter(declaration => declaration.field !== 'peerDependencies')
      .map(declaration => declaration.identity.id)
  );
  for (const declaration of declarations) {
    if (declaration.field === 'peerDependencies' && installedIdentities.has(declaration.identity.id)) {
      continue;
    }
    const selector = yarnSelector(declaration);
    const resolvedVersion = declaration.field === 'peerDependencies' ? undefined : lockVersions.get(selector);
    addObservation(context, {
      identityCandidates: [declaration.identity.id, declaration.packageName],
      displayName: declaration.identity.displayName,
      ecosystem: declaration.identity.ecosystem,
      technologyType: declaration.identity.technologyType,
      evidenceKind: 'dependency-declaration',
      sourcePath: 'package.json',
      sourceDetail: `${declaration.field}.${declaration.packageName}`,
      declaredVersion: declaration.range,
      resolvedVersion,
      versionSourcePath: resolvedVersion ? 'yarn.lock' : undefined,
      confidence: resolvedVersion || isExactVersion(declaration.range) ? 'confident' : 'partial',
      provenance: 'repository-static',
      unlistedFrameworkCandidate: declaration.identity.unlisted
    });
  }
}

function collectYarnClassicVersions(
  context: EvidenceContext,
  declarations: JavaScriptDeclaration[]
): Map<string, string> {
  const versions = new Map<string, string>();
  const installedDeclarations = declarations.filter(declaration => declaration.field !== 'peerDependencies');
  if (installedDeclarations.length === 0) {
    return versions;
  }

  const lockPath = path.join(context.repoPath, 'yarn.lock');
  if (!fs.existsSync(lockPath)) {
    diagnostic(context, 'yarn_lock_missing', 'Top-level Yarn Classic lockfile was not found.', true, 'yarn.lock');
    return versions;
  }

  const content = readManifest(context, lockPath);
  if (content === undefined) {
    return versions;
  }
  if (/^__metadata:/m.test(content)) {
    diagnostic(context, 'yarn_lock_unsupported', 'Yarn Berry lockfiles are not supported for S007 resolution.', true, 'yarn.lock');
    return versions;
  }

  try {
    const parsed = parseYarnLock(content) as { type: string; object?: Record<string, { version?: string }> };
    if (parsed.type !== 'success' || !parsed.object) {
      diagnostic(context, 'yarn_lock_malformed', 'Yarn Classic lockfile could not be parsed.', true, 'yarn.lock');
      return versions;
    }

    for (const declaration of installedDeclarations) {
      const selector = yarnSelector(declaration);
      let resolved = false;
      for (const [combinedSelectors, resolution] of Object.entries(parsed.object)) {
        const selectors = combinedSelectors.split(/,\s*/).map(value => value.replace(/^"|"$/g, ''));
        if (selectors.includes(selector) && typeof resolution.version === 'string') {
          versions.set(selector, resolution.version);
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        diagnostic(
          context,
          'version_unresolved',
          `No Yarn Classic resolution was found for ${selector}.`,
          true,
          'yarn.lock'
        );
      }
    }
  } catch (error) {
    diagnostic(context, 'yarn_lock_malformed', `Yarn Classic lockfile could not be parsed: ${errorMessage(error)}`, true, 'yarn.lock');
  }

  return versions;
}

async function collectMavenEvidence(context: EvidenceContext): Promise<void> {
  const pomPath = path.join(context.repoPath, 'pom.xml');
  if (!fs.existsSync(pomPath)) {
    return;
  }
  const firstMavenObservation = context.observations.length;
  await visitMavenPom(context, pomPath, emptyMavenContext());
  const mavenObservations = context.observations.slice(firstMavenObservation);
  if (
    mavenObservations.some(observation => observation.identityCandidates[0] !== 'java')
    && !mavenObservations.some(observation => observation.identityCandidates[0] === 'java')
  ) {
    diagnostic(
      context,
      'version_unresolved',
      'The Maven Java version could not be established from local properties or maven-compiler-plugin configuration.',
      true,
      'pom.xml'
    );
  }
}

async function visitMavenPom(
  context: EvidenceContext,
  pomPath: string,
  inherited: MavenContext
): Promise<MavenContext> {
  const realPomPath = safeManifestPath(context, pomPath, 'local_module');
  if (!realPomPath) {
    return inherited;
  }
  if (context.visited.has(realPomPath)) {
    const cached = context.mavenContexts.get(realPomPath);
    return cached ? mergeMavenContexts(inherited, cached) : inherited;
  }
  context.visited.add(realPomPath);

  const content = readManifest(context, realPomPath);
  if (content === undefined) {
    return inherited;
  }
  const sourcePath = relativePosixPath(context.repoPath, realPomPath);
  let project: any;
  try {
    const parsed = await parseStringPromise(content, { explicitArray: false, trim: true });
    project = parsed?.project;
  } catch (error) {
    diagnostic(context, 'manifest_malformed', `Unable to parse ${sourcePath}: ${errorMessage(error)}`, true, sourcePath);
    return inherited;
  }
  if (!project || typeof project !== 'object') {
    diagnostic(context, 'manifest_malformed', `Maven manifest ${sourcePath} has no project element.`, true, sourcePath);
    return inherited;
  }

  if (asArray(project.profiles?.profile).length > 0) {
    diagnostic(
      context,
      'version_unresolved',
      `Maven profiles in ${sourcePath} are outside the bounded static model and may change S007-relevant evidence.`,
      true,
      sourcePath
    );
  }

  let effective = cloneMavenContext(inherited);
  if (project.parent) {
    const relativePathValue = xmlText(project.parent.relativePath);
    const explicitlyRemote = project.parent.relativePath !== undefined && relativePathValue === '';
    const relativeParent = explicitlyRemote ? undefined : (relativePathValue || '../pom.xml');
    const parentPath = relativeParent ? path.resolve(path.dirname(realPomPath), relativeParent) : undefined;
    if (parentPath && fs.existsSync(parentPath) && isWithinRepo(context.repoPath, parentPath)) {
      effective = await visitMavenPom(context, parentPath, effective);
    } else {
      diagnostic(context, 'maven_remote_parent', `Maven parent for ${sourcePath} is not available inside the repository.`, true, sourcePath);
    }
  }

  for (const [name, rawValue] of Object.entries(project.properties ?? {})) {
    const value = xmlText(rawValue);
    if (value) {
      effective.properties.set(name, { value, sourcePath });
    }
  }

  const javaVersion = findMavenCompilerVersion(context, project, effective, sourcePath)
    ?? firstResolvedValue(
      effective,
      ['maven.compiler.release', 'java.version', 'maven.compiler.source', 'maven.compiler.target']
    );
  if (javaVersion) {
    addObservation(context, {
      identityCandidates: ['java'],
      displayName: 'Java',
      ecosystem: 'java',
      technologyType: 'language',
      evidenceKind: 'build-setting',
      sourcePath,
      sourceDetail: javaVersion.name,
      declaredVersion: javaVersion.value,
      versionSourcePath: javaVersion.sourcePath,
      confidence: 'confident',
      provenance: 'repository-static'
    });
  }

  for (const dependency of asArray(project.dependencyManagement?.dependencies?.dependency)) {
    const coordinates = mavenCoordinates(dependency);
    if (!coordinates) {
      continue;
    }
    const rawVersion = xmlText(dependency.version);
    const resolvedVersion = resolveMavenValue(rawVersion, effective.properties, sourcePath);
    if (resolvedVersion) {
      effective.dependencyManagement.set(coordinates, { rawValue: rawVersion, ...resolvedVersion });
    }
    if (xmlText(dependency.type) === 'pom' && xmlText(dependency.scope) === 'import') {
      diagnostic(context, 'maven_imported_bom', `Imported BOM ${coordinates} requires remote model resolution.`, true, sourcePath);
    }
  }

  collectMavenDependencies(context, sourcePath, project.dependencies?.dependency, effective);

  context.mavenContexts.set(realPomPath, subtractMavenContext(effective, inherited));

  for (const moduleName of asArray(project.modules?.module).map(xmlText).filter(Boolean)) {
    if (context.mavenModuleCandidates >= MAX_MANIFESTS) {
      diagnostic(context, 'traversal_limit', `Stopped after ${MAX_MANIFESTS} declared Maven module candidates.`, true, sourcePath);
      break;
    }
    context.mavenModuleCandidates += 1;
    const modulePath = path.resolve(path.dirname(realPomPath), moduleName, 'pom.xml');
    await visitMavenPom(context, modulePath, effective);
  }

  return effective;
}

function collectMavenDependencies(
  context: EvidenceContext,
  sourcePath: string,
  rawDependencies: unknown,
  effective: MavenContext
): void {
  for (const dependency of asArray(rawDependencies)) {
    const rawGroupId = xmlText(dependency?.groupId);
    const rawArtifactId = xmlText(dependency?.artifactId);
    if (!rawGroupId || !rawArtifactId) {
      continue;
    }
    const resolvedGroupId = resolveMavenValue(rawGroupId, effective.properties, sourcePath);
    const resolvedArtifactId = resolveMavenValue(rawArtifactId, effective.properties, sourcePath);
    if (!resolvedGroupId || !resolvedArtifactId) {
      diagnostic(
        context,
        'version_unresolved',
        `Maven dependency coordinates ${rawGroupId}:${rawArtifactId} could not be resolved from local properties.`,
        true,
        sourcePath
      );
      continue;
    }
    const groupId = resolvedGroupId.value;
    const artifactId = resolvedArtifactId.value;
    const matched = matchJavaIdentity(groupId, artifactId);
    if (!matched) {
      continue;
    }
    const coordinates = `${groupId}:${artifactId}`;
    const mavenDependency = resolveMavenDependencyKey(dependency, groupId, artifactId, effective, sourcePath);
    if (isGrailsPluginArtifact(groupId)) {
      addPresenceOnlyObservation(context, {
        identityCandidates: [matched.id, coordinates, groupId],
        displayName: matched.displayName,
        ecosystem: matched.ecosystem,
        technologyType: matched.technologyType,
        evidenceKind: 'dependency-declaration',
        sourcePath,
        sourceDetail: coordinates,
        confidence: 'partial',
        provenance: 'repository-static',
        mavenDependency,
        repositoryDeclared: true,
        versionResolutionEligible: false
      });
      continue;
    }
    const rawVersion = xmlText(dependency.version);
    const direct = rawVersion ? resolveMavenValue(rawVersion, effective.properties, sourcePath) : undefined;
    const managed = rawVersion ? undefined : effective.dependencyManagement.get(coordinates);
    const managedResolved = managed
      ? resolveMavenValue(managed.rawValue, effective.properties, managed.sourcePath)
      : undefined;
    const resolved = direct ?? managedResolved;
    addObservation(context, {
      identityCandidates: [matched.id, coordinates, groupId],
      displayName: matched.displayName,
      ecosystem: matched.ecosystem,
      technologyType: matched.technologyType,
      evidenceKind: 'dependency-declaration',
      sourcePath,
      sourceDetail: coordinates,
      declaredVersion: resolved?.value,
      versionSourcePath: resolved?.sourcePath,
      confidence: resolved ? 'confident' : 'partial',
      provenance: 'repository-static',
      mavenDependency,
      repositoryDeclared: true,
      unlistedFrameworkCandidate: matched.unlisted
    });
    if (!resolved) {
      diagnostic(context, 'version_unresolved', `Version for ${coordinates} could not be resolved from local Maven metadata.`, true, sourcePath);
    }
  }
}

function resolveMavenDependencyKey(
  dependency: any,
  groupId: string,
  artifactId: string,
  effective: MavenContext,
  sourcePath: string
): S007TechnologyObservation['mavenDependency'] | undefined {
  const rawType = xmlText(dependency.type) || 'jar';
  const rawClassifier = xmlText(dependency.classifier);
  const type = resolveMavenValue(rawType, effective.properties, sourcePath)?.value;
  const classifier = rawClassifier
    ? resolveMavenValue(rawClassifier, effective.properties, sourcePath)?.value
    : '';
  return type && classifier !== undefined ? { groupId, artifactId, type, classifier } : undefined;
}

function collectGradleEvidence(context: EvidenceContext): void {
  const firstGradleObservation = context.observations.length;
  const rootFiles = ['build.gradle', 'build.gradle.kts']
    .map(name => path.join(context.repoPath, name))
    .filter(file => fs.existsSync(file));
  if (rootFiles.length === 0) {
    return;
  }

  const properties = readGradleProperties(context, path.join(context.repoPath, 'gradle.properties'));
  const pluginVersions = new Map<string, string>();

  if (fs.existsSync(path.join(context.repoPath, 'gradle', 'libs.versions.toml'))) {
    diagnostic(context, 'gradle_version_catalog', 'Gradle version catalogs are not statically resolved for S007.', true, 'gradle/libs.versions.toml');
  }
  for (const directory of ['buildSrc', 'build-logic']) {
    if (fs.existsSync(path.join(context.repoPath, directory))) {
      diagnostic(context, 'gradle_build_logic', `Gradle ${directory} build logic is outside bounded S007 resolution.`, true, directory);
    }
  }

  const settingsPath = ['settings.gradle', 'settings.gradle.kts']
    .map(name => path.join(context.repoPath, name))
    .find(file => fs.existsSync(file));
  const settings = settingsPath ? readManifest(context, settingsPath) : undefined;
  if (settings !== undefined) {
    collectGradlePluginVersions(settings, properties, pluginVersions);
  }

  for (const buildFile of rootFiles) {
    collectGradleBuildFile(context, buildFile, properties, pluginVersions);
  }

  if (settingsPath) {
    if (settings !== undefined) {
      for (const moduleName of parseGradleIncludes(settings)) {
        if (context.gradleModuleCandidates >= MAX_MANIFESTS) {
          diagnostic(context, 'traversal_limit', `Stopped after ${MAX_MANIFESTS} declared Gradle module candidates.`, true, relativePosixPath(context.repoPath, settingsPath));
          break;
        }
        context.gradleModuleCandidates += 1;
        const normalized = moduleName.replace(/^:/, '').replace(/:/g, path.sep);
        const declaredModuleDir = path.resolve(context.repoPath, normalized);
        if (!isPathLexicallyInside(context.repoPath, declaredModuleDir)) {
          diagnostic(context, 'local_module_outside_repository', `Gradle module ${moduleName} resolves outside the repository.`, true, relativePosixPath(context.repoPath, settingsPath));
          continue;
        }
        if (!fs.existsSync(declaredModuleDir)) {
          diagnostic(context, 'local_module_missing', `Gradle module ${moduleName} was declared but not found.`, true, relativePosixPath(context.repoPath, settingsPath));
          continue;
        }
        if (fs.lstatSync(declaredModuleDir).isSymbolicLink()) {
          diagnostic(context, 'local_module_symlink', `Gradle module ${moduleName} is a symlink and was not followed.`, true, normalized);
          continue;
        }
        const moduleDir = fs.realpathSync(declaredModuleDir);
        if (!isPathLexicallyInside(context.repoPath, moduleDir)) {
          diagnostic(context, 'local_module_outside_repository', `Gradle module ${moduleName} resolves outside the repository.`, true, relativePosixPath(context.repoPath, settingsPath));
          continue;
        }
        const moduleProperties = new Map([...properties, ...readGradleProperties(context, path.join(moduleDir, 'gradle.properties'))]);
        for (const name of ['build.gradle', 'build.gradle.kts']) {
          const buildFile = path.join(moduleDir, name);
          if (fs.existsSync(buildFile)) {
            collectGradleBuildFile(context, buildFile, moduleProperties, pluginVersions);
          }
        }
      }
    }
  }

  const gradleObservations = context.observations.slice(firstGradleObservation);
  if (
    gradleObservations.some(observation => observation.identityCandidates[0] !== 'java')
    && !gradleObservations.some(observation => observation.identityCandidates[0] === 'java')
    && !context.diagnostics.some(item =>
      item.code === 'version_unresolved' && item.message.startsWith('Gradle Java version')
    )
  ) {
    diagnostic(
      context,
      'version_unresolved',
      'The Gradle Java version could not be established from local properties, toolchain, or compatibility settings.',
      true,
      relativePosixPath(context.repoPath, rootFiles[0])
    );
  }
}

function collectGradleBuildFile(
  context: EvidenceContext,
  buildFile: string,
  inheritedProperties: Map<string, string>,
  pluginVersions: Map<string, string>
): void {
  const content = readManifest(context, buildFile);
  if (content === undefined) {
    return;
  }
  const sourcePath = relativePosixPath(context.repoPath, buildFile);
  const staticContent = stripGradleComments(content);
  const codePositions = gradleCodePositions(staticContent);
  const properties = new Map(inheritedProperties);
  for (const match of gradleCodeMatches(
    staticContent,
    /(?:def|val|var)?\s*([A-Za-z][\w.]*)\s*=\s*["']([^"']+)["']/g,
    codePositions
  )) {
    properties.set(match[1], match[2]);
  }

  const javaVersion = findGradleJavaVersion(staticContent, properties, codePositions);
  if (javaVersion?.value) {
    addObservation(context, {
      identityCandidates: ['java'],
      displayName: 'Java',
      ecosystem: 'java',
      technologyType: 'language',
      evidenceKind: 'build-setting',
      sourcePath,
      sourceDetail: javaVersion.sourceDetail,
      declaredVersion: javaVersion.value,
      confidence: 'confident',
      provenance: 'repository-static'
    });
  } else if (javaVersion) {
    diagnostic(
      context,
      'version_unresolved',
      `Gradle Java version expression ${javaVersion.expression} could not be resolved from local properties.`,
      true,
      sourcePath
    );
  }

  const configuration = '(?:implementation|api|compileOnly|runtimeOnly|annotationProcessor|classpath)';
  const mapDependencyPattern = new RegExp(
    `${configuration}\\s*(?:\\(\\s*)?((?:(?:group|name|version)\\s*[:=]\\s*(?:["'][^"']+["']|[A-Za-z][\\w.]*)\\s*,?\\s*){2,3})\\)?`,
    'g'
  );
  for (const match of gradleCodeMatches(staticContent, mapDependencyPattern, codePositions)) {
    collectGradleMapDependency(context, sourcePath, match[1], properties);
  }

  const dependencyPattern = new RegExp(`${configuration}\\s*(?:\\(\\s*)?(["'])([^"']+)\\1(?!\\s*\\+)`, 'g');
  for (const match of gradleCodeMatches(staticContent, dependencyPattern, codePositions)) {
    collectGradleCoordinate(context, sourcePath, match[2], properties, match[1] === '"');
  }
  const wrappedDependencyPattern = new RegExp(
    `${configuration}\\s*(?:\\(\\s*)?(?:platform|enforcedPlatform)\\s*\\(\\s*(["'])([^"']+)\\1`,
    'g'
  );
  for (const match of gradleCodeMatches(staticContent, wrappedDependencyPattern, codePositions)) {
    collectGradleCoordinate(context, sourcePath, match[2], properties, match[1] === '"');
  }
  const concatenatedPattern = new RegExp(`${configuration}\\s+["']([^"']+:)["']\\s*\\+\\s*([A-Za-z][\\w.]*)`, 'g');
  for (const match of gradleCodeMatches(staticContent, concatenatedPattern, codePositions)) {
    const value = properties.get(match[2]);
    collectGradleCoordinate(context, sourcePath, value ? `${match[1]}${value}` : match[1], properties);
    if (!value) {
      diagnostic(context, 'gradle_dynamic_expression', `Gradle property ${match[2]} could not be resolved locally.`, true, sourcePath);
    }
  }

  const variableDependencyPattern = new RegExp(
    `${configuration}\\s*(?:\\(\\s*)?(?!(?:group|name|version)\\s*[:=])(?!(?:project|files|fileTree|platform|enforcedPlatform)\\s*\\()([A-Za-z][\\w.]*)`,
    'g'
  );
  for (const match of gradleCodeMatches(staticContent, variableDependencyPattern, codePositions)) {
    const coordinate = properties.get(match[1]);
    if (coordinate) {
      collectGradleCoordinate(context, sourcePath, coordinate, properties);
    } else {
      diagnostic(
        context,
        'gradle_dynamic_expression',
        `Gradle dependency expression ${match[1]} could not be resolved locally.`,
        true,
        sourcePath
      );
    }
  }

  const pluginPattern = /id\s*(?:\(\s*)?["']([^"']+)["']\s*\)?\s*version\s*((?:["'][^"']+["'])|(?:[A-Za-z][\w.]*))/g;
  const versionedPluginIndexes = new Set<number>();
  for (const match of gradleCodeMatches(staticContent, pluginPattern, codePositions)) {
    versionedPluginIndexes.add(match.index ?? -1);
    const matched = matchGradlePlugin(match[1]);
    if (matched) {
      const version = resolveGradleVersionExpression(match[2], properties);
      addObservation(context, {
        identityCandidates: [matched.id, match[1]],
        displayName: matched.displayName,
        ecosystem: matched.ecosystem,
        technologyType: matched.technologyType,
        evidenceKind: 'plugin-declaration',
        sourcePath,
        sourceDetail: `plugin ${match[1]}`,
        declaredVersion: version,
        confidence: version ? 'confident' : 'partial',
        provenance: 'repository-static',
        unlistedFrameworkCandidate: matched.unlisted
      });
      if (!version) {
        diagnostic(
          context,
          'gradle_dynamic_expression',
          `Gradle plugin ${match[1]} version expression ${match[2]} could not be resolved locally.`,
          true,
          sourcePath
        );
      }
    }
  }

  const pluginIdPattern = /id\s*(?:\(\s*)?["']([^"']+)["']\s*\)?/g;
  for (const match of gradleCodeMatches(staticContent, pluginIdPattern, codePositions)) {
    if (versionedPluginIndexes.has(match.index ?? -1)) {
      continue;
    }
    const matched = matchGradlePlugin(match[1]);
    if (!matched) {
      continue;
    }
    const version = pluginVersions.get(match[1]);
    addObservation(context, {
      identityCandidates: [matched.id, match[1]],
      displayName: matched.displayName,
      ecosystem: matched.ecosystem,
      technologyType: matched.technologyType,
      evidenceKind: 'plugin-declaration',
      sourcePath,
      sourceDetail: `plugin ${match[1]}`,
      declaredVersion: version,
      confidence: version ? 'confident' : 'partial',
      provenance: 'repository-static',
      unlistedFrameworkCandidate: matched.unlisted
    });
    if (!version) {
      diagnostic(
        context,
        'gradle_dynamic_expression',
        `Gradle plugin ${match[1]} has no locally resolved version.`,
        true,
        sourcePath
      );
    }
  }

  if (gradleCodeMatches(staticContent, /\bapply\s*(?:\(\s*)?from\s*[:=]/g, codePositions).length > 0) {
    diagnostic(
      context,
      'gradle_build_logic',
      'Applied Gradle scripts are outside the bounded S007 static model.',
      true,
      sourcePath
    );
  }

  if (gradleCodeMatches(staticContent, /\blibs\.[A-Za-z]/g, codePositions).length > 0) {
    diagnostic(context, 'gradle_dynamic_expression', 'Gradle version-catalog references require resolution outside the bounded static reader.', true, sourcePath);
  }
}

function collectGradlePluginVersions(
  content: string,
  properties: Map<string, string>,
  versions: Map<string, string>
): void {
  const staticContent = stripGradleComments(content);
  const codePositions = gradleCodePositions(staticContent);
  const pattern = /id\s*(?:\(\s*)?["']([^"']+)["']\s*\)?\s*version\s*((?:["'][^"']+["'])|(?:[A-Za-z][\w.]*))/g;
  for (const match of gradleCodeMatches(staticContent, pattern, codePositions)) {
    const version = resolveGradleVersionExpression(match[2], properties);
    if (version) {
      versions.set(match[1], version);
    }
  }
}

function collectGradleCoordinate(
  context: EvidenceContext,
  sourcePath: string,
  coordinate: string,
  properties: Map<string, string>,
  allowInterpolation = false
): void {
  const resolvedCoordinate = coordinate.includes('$')
    ? (allowInterpolation ? resolveGradleInterpolatedText(coordinate, properties) : undefined)
    : coordinate;
  if (!resolvedCoordinate) {
    diagnostic(
      context,
      'gradle_dynamic_expression',
      `Gradle dependency coordinate ${coordinate} could not be resolved locally.`,
      true,
      sourcePath
    );
    return;
  }
  const parts = resolvedCoordinate.split(':');
  if (parts.length < 2) {
    return;
  }
  const [groupId, artifactId] = parts;
  const matched = matchJavaIdentity(groupId, artifactId);
  if (!matched) {
    return;
  }
  const rawVersion = parts.slice(2).join(':');
  if (isGrailsPluginArtifact(groupId)) {
    addPresenceOnlyObservation(context, {
      identityCandidates: [matched.id, `${groupId}:${artifactId}`, groupId],
      displayName: matched.displayName,
      ecosystem: matched.ecosystem,
      technologyType: matched.technologyType,
      evidenceKind: 'dependency-declaration',
      sourcePath,
      sourceDetail: `${groupId}:${artifactId}`,
      confidence: 'partial',
      provenance: 'repository-static'
    });
    return;
  }
  const propertyMatch = /^\$\{?([A-Za-z][\w.]*)\}?$/.exec(rawVersion);
  const version = propertyMatch ? properties.get(propertyMatch[1]) : rawVersion || undefined;
  addObservation(context, {
    identityCandidates: [matched.id, `${groupId}:${artifactId}`, groupId],
    displayName: matched.displayName,
    ecosystem: matched.ecosystem,
    technologyType: matched.technologyType,
    evidenceKind: 'dependency-declaration',
    sourcePath,
    sourceDetail: `${groupId}:${artifactId}`,
    declaredVersion: version,
    confidence: version ? 'confident' : 'partial',
    provenance: 'repository-static',
    unlistedFrameworkCandidate: matched.unlisted
  });
  if (!version) {
    diagnostic(context, 'version_unresolved', `Version for ${groupId}:${artifactId} could not be resolved from local Gradle metadata.`, true, sourcePath);
  }
}

function collectGradleMapDependency(
  context: EvidenceContext,
  sourcePath: string,
  argumentsText: string,
  properties: Map<string, string>
): void {
  const groupToken = gradleNamedArgument(argumentsText, 'group');
  const nameToken = gradleNamedArgument(argumentsText, 'name');
  const groupId = groupToken ? quotedGradleLiteral(groupToken) : undefined;
  const artifactId = nameToken ? quotedGradleLiteral(nameToken) : undefined;
  if (!groupId || !artifactId) {
    diagnostic(
      context,
      'gradle_dynamic_expression',
      'Gradle map-style dependency coordinates could not be resolved locally.',
      true,
      sourcePath
    );
    return;
  }

  const versionToken = gradleNamedArgument(argumentsText, 'version');
  const version = versionToken ? resolveGradleVersionExpression(versionToken, properties) : undefined;
  collectGradleCoordinate(
    context,
    sourcePath,
    `${groupId}:${artifactId}${version ? `:${version}` : ''}`,
    properties
  );
}

function gradleNamedArgument(argumentsText: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*[:=]\\s*((?:["'][^"']+["'])|(?:[A-Za-z][\\w.]*))`).exec(argumentsText);
  return match?.[1];
}

function quotedGradleLiteral(value: string): string | undefined {
  const match = /^(["'])([^"']+)\1$/.exec(value.trim());
  return match?.[2];
}

function resolveGradleVersionExpression(expression: string, properties: Map<string, string>): string | undefined {
  const value = expression.trim();
  const quoted = quotedGradleLiteral(value);
  if (quoted !== undefined) {
    const propertyReference = /^\$\{?([A-Za-z][\w.]*)\}?$/.exec(quoted);
    if (propertyReference) {
      return properties.get(propertyReference[1]);
    }
    return quoted.includes('$') ? undefined : quoted;
  }
  return /^[A-Za-z][\w.]*$/.test(value) ? properties.get(value) : undefined;
}

function resolveGradleInterpolatedText(
  rawValue: string,
  properties: Map<string, string>,
  resolving: Set<string> = new Set(),
  depth = 0
): string | undefined {
  if (depth > MAX_MAVEN_PROPERTY_DEPTH) return undefined;
  const references = [...rawValue.matchAll(/\$\{([A-Za-z][\w.]*)\}|\$([A-Za-z][\w.]*)/g)]
    .map(match => match[1] ?? match[2]);
  if (references.length === 0) return rawValue.includes('$') ? undefined : rawValue;

  let value = rawValue;
  for (const name of new Set(references)) {
    if (resolving.has(name)) return undefined;
    const property = properties.get(name);
    if (property === undefined) return undefined;
    const resolved = resolveGradleInterpolatedText(
      property,
      properties,
      new Set(resolving).add(name),
      depth + 1
    );
    if (resolved === undefined) return undefined;
    value = value.replace(new RegExp(`\\$\\{${escapeRegExp(name)}\\}|\\$${escapeRegExp(name)}\\b`, 'g'), resolved);
  }
  return value.includes('$') ? undefined : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readGradleProperties(context: EvidenceContext, propertiesPath: string): Map<string, string> {
  const properties = new Map<string, string>();
  if (!fs.existsSync(propertiesPath)) {
    return properties;
  }
  const content = readManifest(context, propertiesPath);
  if (content === undefined) {
    return properties;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([^#!\s][^=]*)=(.*)$/.exec(line);
    if (match) {
      properties.set(match[1].trim(), match[2].trim());
    }
  }
  return properties;
}

function parseGradleIncludes(content: string): string[] {
  const modules: string[] = [];
  const staticContent = stripGradleComments(content);
  for (const match of staticContent.matchAll(/\binclude\b\s*(?:\(([^)]*)\)|([^\n]+))/g)) {
    const argumentsText = match[1] ?? match[2] ?? '';
    for (const quoted of argumentsText.matchAll(/["']([^"']+)["']/g)) {
      modules.push(quoted[1]);
    }
  }
  return [...new Set(modules)];
}

export function matchJavaIdentity(groupId: string, artifactId: string): S007JavaIdentity | undefined {
  const coordinate = `${groupId}:${artifactId}`;
  if (JAVA_EXACT_IDENTITIES[coordinate]) {
    return JAVA_EXACT_IDENTITIES[coordinate];
  }
  if (groupId === 'org.springframework.boot') return identity('spring-boot', 'Spring Boot', 'java', 'framework');
  if (groupId === 'org.springframework' || groupId.startsWith('org.springframework.')) return identity('spring-framework', 'Spring Framework', 'java', 'framework');
  if (groupId === 'org.grails' || groupId.startsWith('org.grails.')) return identity('grails', 'Grails', 'java', 'framework');
  if (groupId === 'io.vertx' || groupId.startsWith('io.vertx.')) return identity('vertx', 'Eclipse Vert.x', 'java', 'framework');
  if (groupId === 'software.amazon.awssdk') return identity('aws-sdk-java', 'AWS SDK for Java', 'java', 'library');
  if (groupId === 'io.quarkus' || groupId.startsWith('io.quarkus.')) return identity('quarkus', 'Quarkus', 'java', 'framework');
  if (groupId === 'io.micronaut' || groupId.startsWith('io.micronaut.')) return identity('micronaut', 'Micronaut', 'java', 'framework', true);
  if (groupId === 'io.helidon' || groupId.startsWith('io.helidon.')) return identity('helidon', 'Helidon', 'java', 'framework', true);
  return undefined;
}

function matchGradlePlugin(pluginId: string): Identity | undefined {
  if (pluginId === 'org.springframework.boot') return identity('spring-boot', 'Spring Boot', 'java', 'framework');
  if (pluginId === 'io.quarkus') return identity('quarkus', 'Quarkus', 'java', 'framework');
  if (pluginId.startsWith('org.grails')) return identity('grails', 'Grails', 'java', 'framework');
  if (pluginId.startsWith('io.micronaut')) return identity('micronaut', 'Micronaut', 'java', 'framework', true);
  if (pluginId.startsWith('io.helidon')) return identity('helidon', 'Helidon', 'java', 'framework', true);
  return undefined;
}

function isGrailsPluginArtifact(groupId: string): boolean {
  return groupId === 'org.grails.plugins' || groupId.startsWith('org.grails.plugins.');
}

function addPresenceOnlyObservation(context: EvidenceContext, observation: S007TechnologyObservation): void {
  addObservation(context, observation);
  if (context.observations.includes(observation)) {
    context.presenceOnlyObservations.add(observation);
  }
}

function finalizePresenceOnlyObservations(context: EvidenceFinalizationContext): void {
  for (const observation of context.presenceOnlyObservations) {
    const authoritative = context.observations.some(candidate =>
      candidate !== observation
      && candidate.identityCandidates[0] === observation.identityCandidates[0]
      && Boolean(candidate.resolvedVersion ?? candidate.declaredVersion)
    );
    if (authoritative) {
      if (observation.mavenDependency) {
        if (!context.suppressedMavenDependencies.some(suppressed =>
          suppressed.sourcePath === observation.sourcePath
          && suppressed.dependency.groupId === observation.mavenDependency!.groupId
          && suppressed.dependency.artifactId === observation.mavenDependency!.artifactId
          && suppressed.dependency.type === observation.mavenDependency!.type
          && suppressed.dependency.classifier === observation.mavenDependency!.classifier
        )) {
          context.suppressedMavenDependencies.push({
            sourcePath: observation.sourcePath,
            dependency: observation.mavenDependency
          });
        }
      }
      context.observations = context.observations.filter(candidate => candidate !== observation);
      const message = `The ${observation.sourceDetail} artifact proves Grails presence but not the Grails framework version.`;
      context.diagnostics = context.diagnostics.filter(diagnostic =>
        diagnostic.code !== 'version_unresolved'
        || diagnostic.path !== observation.sourcePath
        || diagnostic.message !== message
      );
      continue;
    }
    diagnostic(
      context,
      'version_unresolved',
      `The ${observation.sourceDetail} artifact proves Grails presence but not the Grails framework version.`,
      true,
      observation.sourcePath
    );
  }
}

function markConflicts(context: EvidenceFinalizationContext): void {
  const groups = new Map<string, S007TechnologyObservation[]>();
  for (const observation of context.observations) {
    const id = observation.identityCandidates[0];
    groups.set(id, [...(groups.get(id) ?? []), observation]);
  }
  for (const [id, observations] of groups) {
    const installed = observations.filter(item => !item.sourceDetail.startsWith('peerDependencies.'));
    const comparable = installed.length > 0 ? installed : observations;
    const versions = new Set(comparable.map(item => item.resolvedVersion ?? item.declaredVersion).filter(Boolean));
    if (versions.size <= 1) {
      continue;
    }
    const paths = [...new Set(observations.map(item => item.sourcePath))].sort();
    for (const observation of observations) {
      observation.conflictPaths = paths;
      observation.confidence = 'partial';
    }
    diagnostic(context, 'conflicting_versions', `Conflicting ${id} versions were found in ${paths.join(', ')}.`, true);
  }
}

function readManifest(context: EvidenceContext, filePath: string): string | undefined {
  const requestedSourcePath = relativePosixPath(context.repoPath, filePath);
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      diagnostic(context, 'local_module_symlink', `Symlinked manifest was not read: ${requestedSourcePath}.`, true, requestedSourcePath);
      return undefined;
    }
    if (stats.size > MAX_MANIFEST_BYTES) {
      diagnostic(context, 'manifest_too_large', `Manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`, true, requestedSourcePath);
      return undefined;
    }
    const realPath = fs.realpathSync(filePath);
    const cached = context.manifestContents.get(realPath);
    if (cached !== undefined) {
      return cached;
    }
    if (context.manifestContents.size >= MAX_MANIFESTS) {
      diagnostic(context, 'traversal_limit', `Stopped after ${MAX_MANIFESTS} unique local manifests.`, true);
      return undefined;
    }
    const sourcePath = relativePosixPath(context.repoPath, realPath);
    const content = fs.readFileSync(realPath, 'utf8');
    context.manifestPaths.add(sourcePath);
    context.manifestContents.set(realPath, content);
    return content;
  } catch (error) {
    diagnostic(context, 'manifest_malformed', `Unable to read ${requestedSourcePath}: ${errorMessage(error)}`, true, requestedSourcePath);
    return undefined;
  }
}

function safeManifestPath(context: EvidenceContext, candidatePath: string, label: string): string | undefined {
  const resolved = path.resolve(candidatePath);
  if (!isPathLexicallyInside(context.repoPath, resolved)) {
    diagnostic(context, 'local_module_outside_repository', `${label} resolves outside the repository.`, true);
    return undefined;
  }
  if (!fs.existsSync(resolved)) {
    diagnostic(context, 'local_module_missing', `${label} was declared but not found: ${relativePosixPath(context.repoPath, resolved)}.`, true);
    return undefined;
  }
  if (fs.lstatSync(resolved).isSymbolicLink()) {
    diagnostic(context, 'local_module_symlink', `${label} is a symlink and was not followed.`, true, relativePosixPath(context.repoPath, resolved));
    return undefined;
  }
  if (!isWithinRepo(context.repoPath, resolved)) {
    diagnostic(context, 'local_module_outside_repository', `${label} resolves outside the repository.`, true);
    return undefined;
  }
  return fs.realpathSync(resolved);
}

function addObservation(context: EvidenceContext, observation: S007TechnologyObservation): void {
  const key = [
    observation.identityCandidates[0],
    observation.sourcePath,
    observation.sourceDetail,
    observation.declaredVersion ?? '',
    observation.resolvedVersion ?? ''
  ].join('\u0000');
  if (context.observationKeys.has(key)) {
    return;
  }
  if (context.observations.length >= MAX_OBSERVATIONS) {
    diagnostic(context, 'traversal_limit', `Stopped after ${MAX_OBSERVATIONS} S007 technology observations.`, true);
    return;
  }
  context.observationKeys.add(key);
  context.observations.push(observation);
}

function diagnostic(
  context: Pick<EvidenceContext, 'diagnostics'>,
  code: S007EvidenceDiagnostic['code'],
  message: string,
  material: boolean,
  pathValue?: string
): void {
  const item: S007EvidenceDiagnostic = { code, message, material, path: pathValue };
  if (!context.diagnostics.some(existing => existing.code === code && existing.message === message && existing.path === pathValue)) {
    context.diagnostics.push(item);
  }
}

function identity(
  id: string,
  displayName: string,
  ecosystem: S007Ecosystem,
  technologyType: 'language' | 'framework' | 'library',
  unlisted = false
): Identity {
  return { id, displayName, ecosystem, technologyType, unlisted: unlisted ? true : undefined };
}

function emptyMavenContext(): MavenContext {
  return { properties: new Map(), dependencyManagement: new Map() };
}

function cloneMavenContext(value: MavenContext): MavenContext {
  return { properties: new Map(value.properties), dependencyManagement: new Map(value.dependencyManagement) };
}

function mergeMavenContexts(inherited: MavenContext, cached: MavenContext): MavenContext {
  return {
    properties: new Map([...inherited.properties, ...cached.properties]),
    dependencyManagement: new Map([...inherited.dependencyManagement, ...cached.dependencyManagement])
  };
}

function subtractMavenContext(effective: MavenContext, inherited: MavenContext): MavenContext {
  return {
    properties: new Map([...effective.properties].filter(([name, value]) => {
      const previous = inherited.properties.get(name);
      return !previous || previous.value !== value.value || previous.sourcePath !== value.sourcePath;
    })),
    dependencyManagement: new Map([...effective.dependencyManagement].filter(([name, value]) => {
      const previous = inherited.dependencyManagement.get(name);
      return !previous
        || previous.rawValue !== value.rawValue
        || previous.value !== value.value
        || previous.sourcePath !== value.sourcePath;
    }))
  };
}

function findMavenCompilerVersion(
  evidenceContext: EvidenceContext,
  project: any,
  context: MavenContext,
  sourcePath: string
): { name: string; value: string; sourcePath: string } | undefined {
  const appliedPlugins = asArray(project.build?.plugins?.plugin).filter(isMavenCompilerPlugin);
  const managedPlugins = asArray(project.build?.pluginManagement?.plugins?.plugin).filter(isMavenCompilerPlugin);
  if (managedPlugins.some(plugin => mavenCompilerConfigurations(plugin).length > 0)) {
    diagnostic(
      evidenceContext,
      'version_unresolved',
      `Maven compiler pluginManagement in ${sourcePath} requires effective-model resolution.`,
      true,
      sourcePath
    );
  }

  const candidates: Array<{ name: string; value: string; sourcePath: string }> = [];
  for (const plugin of [...appliedPlugins, ...managedPlugins]) {
    for (const configuration of mavenCompilerConfigurations(plugin)) {
      for (const name of ['release', 'source', 'target']) {
        const resolved = resolveMavenValue(xmlText(configuration[name]), context.properties, sourcePath);
        if (resolved) {
          candidates.push({ name: `maven-compiler-plugin.configuration.${name}`, ...resolved });
        }
      }
    }
  }
  if (new Set(candidates.map(candidate => candidate.value)).size > 1) {
    diagnostic(
      evidenceContext,
      'version_unresolved',
      `Conflicting Maven compiler settings in ${sourcePath} require effective-model resolution.`,
      true,
      sourcePath
    );
  }
  return candidates[0];
}

function isMavenCompilerPlugin(plugin: any): boolean {
  const groupId = xmlText(plugin?.groupId);
  return xmlText(plugin?.artifactId) === 'maven-compiler-plugin'
    && (!groupId || groupId === 'org.apache.maven.plugins');
}

function mavenCompilerConfigurations(plugin: any): any[] {
  const executions = asArray(plugin.executions?.execution);
  return executions
    .filter(execution => xmlText(execution?.id) === 'default-compile')
    .map(execution => execution?.configuration)
    .concat(
      executions
        .filter(execution => xmlText(execution?.id) !== 'default-compile')
        .map(execution => execution?.configuration),
      plugin.configuration
    )
    .filter(Boolean);
}

function yarnSelector(declaration: Pick<JavaScriptDeclaration, 'packageName' | 'range'>): string {
  return `${declaration.packageName}@${declaration.range}`;
}

function firstResolvedValue(
  context: MavenContext,
  names: string[]
): { name: string; value: string; sourcePath: string } | undefined {
  for (const name of names) {
    const property = context.properties.get(name);
    if (!property) continue;
    const value = resolveMavenValue(`\${${name}}`, context.properties, property.sourcePath);
    if (value) return { name, ...value };
  }
  return undefined;
}

function resolveMavenValue(
  rawValue: string,
  properties: Map<string, { value: string; sourcePath: string }>,
  declarationSourcePath: string
): { value: string; sourcePath: string } | undefined {
  return resolveMavenText(rawValue, properties, declarationSourcePath, new Set(), 0);
}

function resolveMavenText(
  rawValue: string,
  properties: Map<string, { value: string; sourcePath: string }>,
  sourcePath: string,
  resolving: Set<string>,
  depth: number
): { value: string; sourcePath: string } | undefined {
  if (!rawValue || depth > MAX_MAVEN_PROPERTY_DEPTH) return undefined;
  const propertyNames = [...rawValue.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]);
  if (propertyNames.length === 0) {
    return { value: rawValue, sourcePath };
  }

  let value = rawValue;
  let resolvedSourcePath = sourcePath;
  for (const name of new Set(propertyNames)) {
    if (resolving.has(name)) return undefined;
    const property = properties.get(name);
    if (!property) return undefined;
    const nextResolving = new Set(resolving).add(name);
    const resolved = resolveMavenText(
      property.value,
      properties,
      property.sourcePath,
      nextResolving,
      depth + 1
    );
    if (!resolved) return undefined;
    value = value.split(`\${${name}}`).join(resolved.value);
    resolvedSourcePath = resolved.sourcePath;
  }

  if (value.includes('${')) return undefined;
  return { value, sourcePath: resolvedSourcePath };
}

function findGradleJavaVersion(
  content: string,
  properties: Map<string, string>,
  codePositions: Uint8Array
): { value?: string; sourceDetail: string; expression: string } | undefined {
  const toolchains = gradleCodeMatches(
    content,
    /\blanguageVersion\b\s*(?:=\s*|\.\s*set\s*\(\s*)JavaLanguageVersion\.of\(\s*([^)\r\n]+)\s*\)/g,
    codePositions
  );
  const toolchainPositions = gradleJavaToolchainPositions(content, codePositions);
  const projectToolchains = toolchains.filter(match => toolchainPositions[match.index ?? 0] === 1);
  if (projectToolchains.length > 0) {
    const values = projectToolchains.map(match => resolveGradleJavaVersionExpression(match[1], properties));
    const resolvedValues = new Set(values.filter((value): value is string => Boolean(value)));
    return {
      value: values.every(Boolean) && resolvedValues.size === 1 ? values[0] : undefined,
      sourceDetail: 'Gradle Java toolchain',
      expression: projectToolchains.map(match => match[1].trim()).join(', ')
    };
  }

  for (const setting of ['sourceCompatibility', 'targetCompatibility']) {
    const declaration = firstGradleCodeMatch(
      content,
      new RegExp(
        `\\b${setting}\\b\\s*(?:=\\s*)?(JavaVersion\\.VERSION_[0-9_]+|JavaVersion\\.toVersion\\([^\\r\\n)]*\\)|["']?\\d+["']?|[A-Za-z][\\w.]*)`,
        'g'
      ),
      codePositions
    );
    if (declaration) {
      return {
        value: resolveGradleJavaVersionExpression(declaration[1], properties),
        sourceDetail: `Gradle ${setting}`,
        expression: declaration[1].trim()
      };
    }
  }
  return undefined;
}

function gradleJavaToolchainPositions(
  content: string,
  codePositions: Uint8Array
): Uint8Array {
  const blocks: Array<{ name: string; isJavaToolchain: boolean }> = [];
  const positions = new Uint8Array(content.length);
  let targetDepth = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (targetDepth > 0) {
      positions[index] = 1;
    }
    if (codePositions[index] !== 1) {
      continue;
    }
    if (content[index] === '{') {
      const prefix = content.slice(Math.max(0, index - 80), index);
      const name = /([A-Za-z][\w.]*)\s*(?:\([^{}]*\))?\s*$/.exec(prefix)?.[1] ?? '';
      const parentName = blocks[blocks.length - 1]?.name;
      const isJavaToolchain = name === 'java.toolchain' || (name === 'toolchain' && parentName === 'java');
      blocks.push({ name, isJavaToolchain });
      if (isJavaToolchain) {
        targetDepth += 1;
      }
    } else if (content[index] === '}') {
      if (blocks.pop()?.isJavaToolchain) {
        targetDepth -= 1;
      }
    }
  }
  return positions;
}

function resolveGradleJavaVersionExpression(
  expression: string,
  properties: Map<string, string>,
  resolving = new Set<string>()
): string | undefined {
  const value = expression.trim();
  const constant = /^JavaVersion\.VERSION_([0-9_]+)$/.exec(value);
  if (constant) return normalizeGradleJavaVersion(constant[1]);

  const literal = /^["']?(\d+)["']?$/.exec(value);
  if (literal) return literal[1];

  const toVersion = /^JavaVersion\.toVersion\(\s*([A-Za-z][\w.]*)\s*\)$/.exec(value);
  const propertyName = toVersion?.[1] ?? (/^[A-Za-z][\w.]*$/.test(value) ? value : undefined);
  if (!propertyName || resolving.has(propertyName)) return undefined;
  const property = properties.get(propertyName);
  if (!property) return undefined;
  return resolveGradleJavaVersionExpression(property, properties, new Set(resolving).add(propertyName));
}

function normalizeGradleJavaVersion(value: string): string {
  return value.startsWith('1_') ? value.slice(2) : value.replace(/_/g, '.');
}

function gradleCodeMatches(content: string, pattern: RegExp, codePositions: Uint8Array): RegExpMatchArray[] {
  return [...content.matchAll(pattern)].filter(match => codePositions[match.index ?? 0] === 1);
}

function firstGradleCodeMatch(
  content: string,
  pattern: RegExp,
  codePositions: Uint8Array
): RegExpMatchArray | undefined {
  return gradleCodeMatches(content, pattern, codePositions)[0];
}

function gradleCodePositions(content: string): Uint8Array {
  const positions = new Uint8Array(content.length);
  let quote: "'" | '"' | "'''" | '\"\"\"' | undefined;

  for (let index = 0; index < content.length;) {
    if (quote) {
      if (content.startsWith(quote, index) && !isEscapedCharacter(content, index)) {
        index += quote.length;
        quote = undefined;
      } else {
        index += 1;
      }
      continue;
    }

    positions[index] = 1;
    const triple = content.slice(index, index + 3);
    if (triple === "'''" || triple === '\"\"\"') {
      quote = triple;
      index += 3;
      continue;
    }
    if (content[index] === "'" || content[index] === '"') {
      quote = content[index] as "'" | '"';
    }
    index += 1;
  }
  return positions;
}

function stripGradleComments(content: string): string {
  let result = '';
  let quote: "'" | '"' | "'''" | '\"\"\"' | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < content.length;) {
    const character = content[index];
    const pair = content.slice(index, index + 2);
    const triple = content.slice(index, index + 3);

    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += character;
      } else {
        result += ' ';
      }
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
    if (triple === "'''" || triple === '\"\"\"') {
      quote = triple;
      result += triple;
      index += 3;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    }
    result += character;
    index += 1;
  }
  return result;
}

function isEscapedCharacter(content: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function mavenCoordinates(dependency: any): string | undefined {
  const groupId = xmlText(dependency?.groupId);
  const artifactId = xmlText(dependency?.artifactId);
  return groupId && artifactId ? `${groupId}:${artifactId}` : undefined;
}

function asArray(value: any): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlText(value: any): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && typeof value._ === 'string') return value._.trim();
  return '';
}

function isExactVersion(value: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:[-+].+)?$/.test(value.trim());
}

function isPathLexicallyInside(repoPath: string, candidatePath: string): boolean {
  const relative = path.relative(repoPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
