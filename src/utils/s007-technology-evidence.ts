import * as fs from 'fs';
import * as path from 'path';
import {
  S007Ecosystem,
  S007EvidenceDiagnostic,
  S007TechnologyEvidenceResult,
  S007TechnologyObservation
} from '../types';
import { isDirectory, isWithinRepo, relativePosixPath } from './repo-files';
import { findGradleProjectDir } from './parsers/gradle-dependency-parser';
import {
  asArray,
  isEscapedCharacter,
  packageDependencyEntries,
  parseJavaProperties,
  parsePom,
  parseYarnLockfile,
  PomDependency,
  pomDependencies,
  stripGradleComments,
  xmlText,
  yarnLockVersion
} from './manifest-parsers';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANIFESTS = 64;
const MAX_OBSERVATIONS = 1024;
const MAX_MAVEN_PROPERTY_DEPTH = 16;
const MAVEN_VERSION_NOT_SET = 'Versions not set in the repository (probably managed by a parent POM or BOM)';
const GRADLE_JAVA_PROPERTY_MESSAGE = 'The Gradle Java version';
const GRADLE_VERSIONED_PLUGIN_PATTERN =
  /id(?:\s*\()?\s*["']([^"']+)["'](?:\s*\))?\s*version\s*((?:["'][^"']+["'])|(?:[A-Za-z][\w.]*))/g;

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
  /** The POM or one of its parents in the repository has a parent outside the repository. */
  remoteParent: boolean;
  /** The POM or one of its parents in the repository has a Spring Boot parent or declares a Spring Boot dependency. */
  springBoot?: 'parent' | 'dependency';
  /** The POM or one of its parents in the repository imports a BOM. */
  importsBom: boolean;
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

  finalizeObservations(context);
  if (context.observations.length === 0) {
    diagnostic(context, 'insufficient_evidence', 'No language or framework the tool recognizes was found in the build or package files.', true);
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
  finalizeObservations(context);
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
      diagnostic(context, 'manifest_missing', 'Not found at the repository root.', true, 'package.json');
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
      `Not valid JSON: ${errorMessage(error)}`,
      true,
      'package.json'
    );
    return;
  }

  const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
  const declarations: JavaScriptDeclaration[] = [];
  for (const entry of packageDependencyEntries(manifest, dependencyFields)) {
    if ('invalid' in entry) continue;
    const matched = JAVASCRIPT_IDENTITIES[entry.name];
    if (matched && typeof entry.specifier === 'string') {
      declarations.push({ packageName: entry.name, range: entry.specifier, field: entry.field, identity: matched });
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
    // Not material: each declared range is then checked as a whole, and a range that allows any version outside
    // the policy already needs review on its own.
    diagnostic(context, 'yarn_lock_missing', 'Not found at the repository root, so the installed versions are not known; each declared range was checked instead.', false, 'yarn.lock');
    return versions;
  }

  const content = readManifest(context, lockPath);
  if (content === undefined) {
    return versions;
  }
  const lockfile = parseYarnLockfile(content);
  if (lockfile.format === 'berry') {
    diagnostic(context, 'yarn_lock_unsupported', 'This is a Yarn 2+ lockfile, which the tool cannot read; only Yarn 1 lockfiles are supported.', true, 'yarn.lock');
    return versions;
  }
  if (lockfile.format === 'malformed') {
    diagnostic(context, 'yarn_lock_malformed', lockfile.message === undefined
      ? 'Could not be read as a Yarn 1 lockfile.'
      : `Could not be read as a Yarn 1 lockfile: ${lockfile.message}`, true, 'yarn.lock');
    return versions;
  }

  for (const declaration of installedDeclarations) {
    const selector = yarnSelector(declaration);
    const version = yarnLockVersion(lockfile.entries, selector);
    if (version !== undefined) {
      versions.set(selector, version);
    } else {
      diagnostic(
        context,
        'version_unresolved',
        `Has no entry for ${selector}.`,
        true,
        'yarn.lock',
        { subject: selector, listHeading: 'Not found in yarn.lock' }
      );
    }
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
      'No Java version was found (maven.compiler.release, java.version, or the maven-compiler-plugin settings).',
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
  const realPomPath = safeManifestPath(context, pomPath);
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
  const parsed = await parsePom(content);
  if (!parsed.ok) {
    diagnostic(context, 'manifest_malformed', parsed.reason === 'invalid-xml'
      ? `Not valid XML: ${parsed.message}`
      : 'Has no <project> element.', true, sourcePath);
    return inherited;
  }
  const project = parsed.project;

  if (asArray(project.profiles?.profile).length > 0) {
    diagnostic(
      context,
      'version_unresolved',
      'Has Maven profiles, which the tool does not evaluate; a profile can change versions or dependencies.',
      true,
      sourcePath
    );
  }

  let effective = cloneMavenContext(inherited);
  if (project.parent) {
    const relativePathValue = xmlText(project.parent.relativePath);
    const explicitlyRemote = project.parent.relativePath !== undefined && relativePathValue === '';
    const relativeParent = explicitlyRemote ? undefined : (relativePathValue || '../pom.xml');
    const parentPath = relativeParent ? mavenPomPath(path.resolve(path.dirname(realPomPath), relativeParent)) : undefined;
    if (parentPath && fs.existsSync(parentPath) && isWithinRepo(context.repoPath, parentPath)) {
      effective = await visitMavenPom(context, parentPath, effective);
    } else {
      diagnostic(context, 'maven_remote_parent', 'The parent POM is not in the repository, so the versions and settings it provides could not be read.', true, sourcePath);
      effective.remoteParent = true;
      if (xmlText(project.parent.groupId) === 'org.springframework.boot') effective.springBoot = 'parent';
    }
  }
  if (!effective.springBoot && pomDependencies(project.dependencies?.dependency)
    .some(dependency => dependency.groupId === 'org.springframework.boot')) {
    effective.springBoot = 'dependency';
  }

  for (const [name, rawValue] of Object.entries(project.properties ?? {})) {
    const value = xmlText(rawValue);
    if (value) {
      effective.properties.set(name, { value, sourcePath });
    }
  }

  for (const plugin of asArray(project.build?.plugins?.plugin)) {
    if (xmlText(plugin?.groupId) === 'org.codehaus.gmavenplus' && xmlText(plugin?.artifactId) === 'gmavenplus-plugin') {
      addGroovyObservation(context, sourcePath, 'plugin org.codehaus.gmavenplus:gmavenplus-plugin');
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

  for (const dependency of pomDependencies(project.dependencyManagement?.dependencies?.dependency)) {
    const coordinates = dependency.groupId && dependency.artifactId ? `${dependency.groupId}:${dependency.artifactId}` : undefined;
    if (!coordinates) {
      continue;
    }
    const rawVersion = dependency.version;
    const resolvedVersion = resolveMavenValue(rawVersion, effective.properties, sourcePath);
    const [groupId, artifactId] = coordinates.split(':');
    const managedKey = resolveMavenDependencyKey(dependency, groupId, artifactId, effective, sourcePath);
    // Keep a managed version whose property is not defined here too: a child POM may define it, and Maven then
    // uses the managed version rather than any other.
    if (rawVersion && managedKey) {
      effective.dependencyManagement.set(mavenManagementKey(managedKey), {
        rawValue: rawVersion,
        value: resolvedVersion?.value ?? '',
        sourcePath: resolvedVersion?.sourcePath ?? sourcePath
      });
    }
    if (dependency.type === 'pom' && dependency.scope === 'import') {
      effective.importsBom = true;
      diagnostic(
        context,
        'maven_imported_bom',
        `Imports the BOM ${coordinates} from outside the repository; the versions it manages could not be read.`,
        true,
        sourcePath,
        { subject: coordinates, listHeading: 'BOMs imported from outside the repository (the versions they manage could not be read)' }
      );
    }
  }

  collectMavenDependencies(context, sourcePath, project.dependencies?.dependency, effective);

  context.mavenContexts.set(realPomPath, subtractMavenContext(effective, inherited));

  for (const moduleName of asArray(project.modules?.module).map(xmlText).filter(Boolean)) {
    if (context.mavenModuleCandidates >= MAX_MANIFESTS) {
      diagnostic(context, 'traversal_limit', `Stopped after ${MAX_MANIFESTS} Maven modules; the rest were not read.`, true, sourcePath);
      break;
    }
    context.mavenModuleCandidates += 1;
    const modulePath = mavenPomPath(path.resolve(path.dirname(realPomPath), moduleName));
    await visitMavenPom(context, modulePath, effective);
  }

  return effective;
}

// Like Maven, a parent relativePath or a module may name a directory (read its pom.xml) or the POM file itself.
function mavenPomPath(candidate: string): string {
  return isDirectory(candidate) ? path.join(candidate, 'pom.xml') : candidate;
}

function collectMavenDependencies(
  context: EvidenceContext,
  sourcePath: string,
  rawDependencies: unknown,
  effective: MavenContext
): void {
  for (const dependency of pomDependencies(rawDependencies)) {
    const { groupId: rawGroupId, artifactId: rawArtifactId } = dependency;
    if (!rawGroupId || !rawArtifactId) {
      continue;
    }
    const testScope = dependency.scope === 'test' ? true as const : undefined;
    const resolvedGroupId = resolveMavenValue(rawGroupId, effective.properties, sourcePath);
    const resolvedArtifactId = resolveMavenValue(rawArtifactId, effective.properties, sourcePath);
    if (!resolvedGroupId || !resolvedArtifactId) {
      if (testScope) continue;
      diagnostic(
        context,
        'version_unresolved',
        `The dependency ${rawGroupId}:${rawArtifactId} uses a property that is not defined in the repository.`,
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
    if (isPresenceOnlyArtifact(groupId, artifactId)) {
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
        versionResolutionEligible: false,
        testScope
      });
      continue;
    }
    const rawVersion = dependency.version;
    const direct = rawVersion ? resolveMavenValue(rawVersion, effective.properties, sourcePath) : undefined;
    // Maven manages each type and classifier separately: a managed test-jar version is not the jar's version.
    const managed = rawVersion || !mavenDependency
      ? undefined
      : effective.dependencyManagement.get(mavenManagementKey(mavenDependency));
    const managedResolved = managed
      ? resolveMavenValue(managed.rawValue, effective.properties, managed.sourcePath)
      : undefined;
    // Only for a dependency with no version anywhere in the repository: an explicit or managed version that the
    // tool cannot resolve still wins over the Spring Boot property in Maven.
    const property = rawVersion || managed ? undefined : springBootVersionProperty(artifactId, effective);
    const resolved = direct ?? managedResolved ?? property;
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
      versionProperty: property?.name,
      confidence: resolved && !property ? 'confident' : 'partial',
      provenance: 'repository-static',
      mavenDependency,
      repositoryDeclared: true,
      unlistedFrameworkCandidate: matched.unlisted,
      testScope
    });
    if (!resolved && !testScope) {
      diagnostic(
        context,
        'version_unresolved',
        `No version for ${coordinates} is set in the repository; it probably comes from a parent POM or BOM.`,
        true,
        sourcePath,
        { subject: coordinates, listHeading: MAVEN_VERSION_NOT_SET }
      );
    }
  }
}

/**
 * Spring Boot's dependency management reads each managed version from a property such as lombok.version, so a
 * module that inherits it from a parent POM overrides that version by setting the property. An imported BOM is
 * built on its own, so the property does not change it. Without the parent POM this is an inference, used when a
 * Spring Boot parent is outside the repository, or when a module that uses Spring Boot has a parent outside the
 * repository and imports no BOM (which could be where the Spring Boot versions come from instead).
 */
function springBootVersionProperty(
  artifactId: string,
  effective: MavenContext
): { name: string; value: string; sourcePath: string } | undefined {
  const inherited = effective.springBoot === 'parent'
    || (effective.remoteParent && effective.springBoot === 'dependency' && !effective.importsBom);
  if (!inherited) return undefined;
  const name = `${artifactId}.version`;
  const defined = effective.properties.get(name);
  const value = defined ? resolveMavenValue(`\${${name}}`, effective.properties, defined.sourcePath) : undefined;
  return value ? { name, ...value } : undefined;
}

function mavenManagementKey(dependency: NonNullable<S007TechnologyObservation['mavenDependency']>): string {
  return [dependency.groupId, dependency.artifactId, dependency.type, dependency.classifier].join(':');
}

function resolveMavenDependencyKey(
  dependency: Pick<PomDependency, 'type' | 'classifier'>,
  groupId: string,
  artifactId: string,
  effective: MavenContext,
  sourcePath: string
): S007TechnologyObservation['mavenDependency'] | undefined {
  const rawType = dependency.type || 'jar';
  const rawClassifier = dependency.classifier;
  const type = resolveMavenValue(rawType, effective.properties, sourcePath)?.value;
  const classifier = rawClassifier
    ? resolveMavenValue(rawClassifier, effective.properties, sourcePath)?.value
    : '';
  return type && classifier !== undefined ? { groupId, artifactId, type, classifier } : undefined;
}

function collectGradleEvidence(context: EvidenceContext): void {
  const firstGradleObservation = context.observations.length;
  const projectDir = findGradleProjectDir(context.repoPath);
  if (!projectDir) {
    return;
  }
  const rootFiles = ['build.gradle', 'build.gradle.kts']
    .map(name => path.join(projectDir, name))
    .filter(file => fs.existsSync(file));

  const properties = readGradleProperties(context, path.join(projectDir, 'gradle.properties'));
  const pluginVersions = new Map<string, string>();

  const versionCatalog = path.join(projectDir, 'gradle', 'libs.versions.toml');
  if (fs.existsSync(versionCatalog)) {
    diagnostic(context, 'gradle_version_catalog', 'The build uses a Gradle version catalog, which the tool does not read.', true, relativePosixPath(context.repoPath, versionCatalog));
  }
  for (const directory of ['buildSrc', 'build-logic']) {
    if (fs.existsSync(path.join(projectDir, directory))) {
      diagnostic(context, 'gradle_build_logic', 'Holds Gradle build logic, which the tool does not read; it can change versions or dependencies.', true, relativePosixPath(context.repoPath, path.join(projectDir, directory)));
    }
  }

  const settingsPath = ['settings.gradle', 'settings.gradle.kts']
    .map(name => path.join(projectDir, name))
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
          diagnostic(context, 'traversal_limit', `Stopped after ${MAX_MANIFESTS} Gradle modules; the rest were not read.`, true, relativePosixPath(context.repoPath, settingsPath));
          break;
        }
        context.gradleModuleCandidates += 1;
        const normalized = moduleName.replace(/^:/, '').replace(/:/g, path.sep);
        const declaredModuleDir = path.resolve(projectDir, normalized);
        if (!isPathLexicallyInside(context.repoPath, declaredModuleDir)) {
          diagnostic(context, 'local_module_outside_repository', `Gradle module ${moduleName} points outside the repository and was not read.`, true, relativePosixPath(context.repoPath, settingsPath));
          continue;
        }
        if (!fs.existsSync(declaredModuleDir)) {
          diagnostic(context, 'local_module_missing', `Gradle module ${moduleName} is included, but its folder does not exist.`, true, relativePosixPath(context.repoPath, settingsPath));
          continue;
        }
        if (fs.lstatSync(declaredModuleDir).isSymbolicLink()) {
          diagnostic(context, 'local_module_symlink', `Gradle module ${moduleName} is a symbolic link and was not followed.`, true, relativePosixPath(context.repoPath, declaredModuleDir));
          continue;
        }
        const moduleDir = fs.realpathSync(declaredModuleDir);
        if (!isPathLexicallyInside(context.repoPath, moduleDir)) {
          diagnostic(context, 'local_module_outside_repository', `Gradle module ${moduleName} points outside the repository and was not read.`, true, relativePosixPath(context.repoPath, settingsPath));
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
      item.code === 'version_unresolved' && item.message.startsWith(GRADLE_JAVA_PROPERTY_MESSAGE)
    )
  ) {
    diagnostic(
      context,
      'version_unresolved',
      'No Java version was found (Java toolchain, sourceCompatibility, or targetCompatibility).',
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
    /(?<![\w.])([A-Za-z](?=([\w.]*))\2)\s*=\s*["']([^"']+)["']/g,
    codePositions
  )) {
    properties.set(match[1], match[3]);
  }

  // Grails applies the Groovy plugin. Avoid adjacent optional whitespace runs (see the dependency patterns below).
  const appliedPluginPattern = /(?:\bid\s*(?:\(\s*)?|\bapply\s*(?:\(\s*)?plugin\s*[:=]\s*)["']([^"']+)["']/g;
  for (const match of gradleCodeMatches(staticContent, appliedPluginPattern, codePositions)) {
    if (/^(?:groovy|org\.grails\.grails-[\w-]+|org\.apache\.grails\.gradle\.grails-[\w-]+)$/.test(match[1])) {
      addGroovyObservation(context, sourcePath, `plugin ${match[1]}`);
    }
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
      `${GRADLE_JAVA_PROPERTY_MESSAGE} (${javaVersion.expression}) uses a property that is not defined in the repository.`,
      true,
      sourcePath
    );
  }

  // Never put two optional whitespace runs next to each other ("\\s*(?:\\(\\s*)?"): on a long run of spaces the
  // engine tries every split between them, which is quadratic in the build file size.
  const configurationName =
    '(?:implementation|api|compileOnly|runtimeOnly|annotationProcessor|classpath'
    + '|(?:test|testFixtures|integrationTest)(?:Implementation|Api|CompileOnly|RuntimeOnly|AnnotationProcessor))';
  const configuration = `${configurationName}(?:\\s*\\()?\\s*`;
  // Every pattern below starts with the configuration name.
  const testScope = (match: RegExpMatchArray): true | undefined =>
    /^(?:test|integrationTest)/.test(match[0]) ? true : undefined;
  const mapDependencyPattern = new RegExp(
    `${configuration}((?:(?:group|name|version)\\s*[:=]\\s*(?:["'][^"']+["']|[A-Za-z][\\w.]*)(?:\\s*,)?\\s*){2,3})\\)?`,
    'g'
  );
  for (const match of gradleCodeMatches(staticContent, mapDependencyPattern, codePositions)) {
    collectGradleMapDependency(context, sourcePath, match[1], properties, testScope(match));
  }

  const dependencyPattern = new RegExp(`${configuration}(["'])([^"']+)\\1(?!\\s*\\+)`, 'g');
  for (const match of gradleCodeMatches(staticContent, dependencyPattern, codePositions)) {
    collectGradleCoordinate(context, sourcePath, match[2], properties, match[1] === '"', testScope(match));
  }
  const wrappedDependencyPattern = new RegExp(
    `${configuration}(?:platform|enforcedPlatform)\\s*\\(\\s*(["'])([^"']+)\\1`,
    'g'
  );
  for (const match of gradleCodeMatches(staticContent, wrappedDependencyPattern, codePositions)) {
    collectGradleCoordinate(context, sourcePath, match[2], properties, match[1] === '"', testScope(match));
  }
  const concatenatedPattern = new RegExp(`${configurationName}\\s+["']([^"']+:)["']\\s*\\+\\s*([A-Za-z][\\w.]*)`, 'g');
  for (const match of gradleCodeMatches(staticContent, concatenatedPattern, codePositions)) {
    const value = properties.get(match[2]);
    collectGradleCoordinate(context, sourcePath, value ? `${match[1]}${value}` : match[1], properties, false, testScope(match));
    if (!value && !testScope(match)) {
      diagnostic(context, 'gradle_dynamic_expression', `The Gradle property ${match[2]} is not defined in the repository.`, true, sourcePath);
    }
  }

  const variableDependencyPattern = new RegExp(
    `${configuration}(?!(?:group|name|version)\\s*[:=])(?!(?:project|files|fileTree|platform|enforcedPlatform)\\s*\\()([A-Za-z][\\w.]*)`,
    'g'
  );
  for (const match of gradleCodeMatches(staticContent, variableDependencyPattern, codePositions)) {
    const coordinate = properties.get(match[1]);
    if (coordinate) {
      collectGradleCoordinate(context, sourcePath, coordinate, properties, false, testScope(match));
    } else if (!testScope(match)) {
      diagnostic(
        context,
        'gradle_dynamic_expression',
        `The Gradle dependency ${match[1]} refers to a variable that is not defined in the repository.`,
        true,
        sourcePath
      );
    }
  }

  const pluginPattern = GRADLE_VERSIONED_PLUGIN_PATTERN;
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
          `The version of Gradle plugin ${match[1]} (${match[2]}) is not defined in the repository.`,
          true,
          sourcePath
        );
      }
    }
  }

  const pluginIdPattern = /id(?:\s*\()?\s*["']([^"']+)["'](?:\s*\))?/g;
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
        `Gradle plugin ${match[1]} has no version in the repository.`,
        true,
        sourcePath
      );
    }
  }

  if (gradleCodeMatches(staticContent, /\bapply(?:\s*\()?\s*from\s*[:=]/g, codePositions).length > 0) {
    diagnostic(
      context,
      'gradle_build_logic',
      'Applies another Gradle script (apply from), which the tool does not read.',
      true,
      sourcePath
    );
  }

  if (gradleCodeMatches(staticContent, /\blibs\.[A-Za-z]/g, codePositions).length > 0) {
    diagnostic(context, 'gradle_dynamic_expression', 'Refers to a Gradle version catalog (libs.…), which the tool does not read.', true, sourcePath);
  }
}

function collectGradlePluginVersions(
  content: string,
  properties: Map<string, string>,
  versions: Map<string, string>
): void {
  const staticContent = stripGradleComments(content);
  const codePositions = gradleCodePositions(staticContent);
  for (const match of gradleCodeMatches(staticContent, GRADLE_VERSIONED_PLUGIN_PATTERN, codePositions)) {
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
  allowInterpolation = false,
  testScope?: true
): void {
  const resolvedCoordinate = coordinate.includes('$')
    ? (allowInterpolation ? resolveGradleInterpolatedText(coordinate, properties) : undefined)
    : coordinate;
  if (!resolvedCoordinate) {
    if (testScope) return;
    diagnostic(
      context,
      'gradle_dynamic_expression',
      `The Gradle dependency ${coordinate} uses a property that is not defined in the repository.`,
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
  if (isPresenceOnlyArtifact(groupId, artifactId)) {
    addPresenceOnlyObservation(context, {
      identityCandidates: [matched.id, `${groupId}:${artifactId}`, groupId],
      displayName: matched.displayName,
      ecosystem: matched.ecosystem,
      technologyType: matched.technologyType,
      evidenceKind: 'dependency-declaration',
      sourcePath,
      sourceDetail: `${groupId}:${artifactId}`,
      confidence: 'partial',
      provenance: 'repository-static',
      versionResolutionEligible: false,
      testScope
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
    unlistedFrameworkCandidate: matched.unlisted,
    testScope
  });
  if (!version && !testScope) {
    diagnostic(
      context,
      'version_unresolved',
      `No version for ${groupId}:${artifactId} is set in the repository; it probably comes from a Gradle plugin or platform.`,
      true,
      sourcePath,
      { subject: `${groupId}:${artifactId}`, listHeading: 'Versions not set in the repository (probably managed by a Gradle plugin or platform)' }
    );
  }
}

function collectGradleMapDependency(
  context: EvidenceContext,
  sourcePath: string,
  argumentsText: string,
  properties: Map<string, string>,
  testScope?: true
): void {
  const groupToken = gradleNamedArgument(argumentsText, 'group');
  const nameToken = gradleNamedArgument(argumentsText, 'name');
  const groupId = groupToken ? quotedGradleLiteral(groupToken) : undefined;
  const artifactId = nameToken ? quotedGradleLiteral(nameToken) : undefined;
  if (!groupId || !artifactId) {
    if (testScope) return;
    diagnostic(
      context,
      'gradle_dynamic_expression',
      'A dependency written as group:/name: uses values that are not defined in the repository.',
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
    properties,
    false,
    testScope
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
  if (!fs.existsSync(propertiesPath)) {
    return new Map<string, string>();
  }
  const content = readManifest(context, propertiesPath);
  return content === undefined ? new Map<string, string>() : parseJavaProperties(content);
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
  // Modules use RMB through its domain-models-* artifacts, which all carry the RMB version.
  if (groupId === 'org.folio' && artifactId.startsWith('domain-models-')) {
    return JAVA_EXACT_IDENTITIES['org.folio:raml-module-builder'];
  }
  if (groupId === 'org.springframework.boot') return identity('spring-boot', 'Spring Boot', 'java', 'framework');
  if (groupId === 'org.springframework' || groupId.startsWith('org.springframework.')) return identity('spring-framework', 'Spring Framework', 'java', 'framework');
  if (isGrailsGroup(groupId)) return identity('grails', 'Grails', 'java', 'framework');
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
  // Grails 7 moved to the Apache Software Foundation and publishes under org.apache.grails.
  if (pluginId.startsWith('org.grails') || pluginId.startsWith('org.apache.grails.')) return identity('grails', 'Grails', 'java', 'framework');
  if (pluginId.startsWith('io.micronaut')) return identity('micronaut', 'Micronaut', 'java', 'framework', true);
  if (pluginId.startsWith('io.helidon')) return identity('helidon', 'Helidon', 'java', 'framework', true);
  return undefined;
}

function isGrailsGroup(groupId: string): boolean {
  return groupId === 'org.grails' || groupId.startsWith('org.grails.')
    || groupId === 'org.apache.grails' || groupId.startsWith('org.apache.grails.');
}

// Before Grails 7, only artifacts from the Grails core project carry the Grails version.
const GRAILS_CORE_ARTIFACT =
  /^(?!.*testing-support)grails-(?:bom|bootstrap|codecs|console|core|databinding|dependencies|docs|encoder|gradle-model|gradle-plugin|logging|shell|spring|test|plugin-[\w-]+|web(?:-[\w-]+)?)$/;

/**
 * Artifacts that show a framework is used but have their own version line, so their version is not the
 * framework's: Grails plugins, other org.grails artifacts such as GORM (grails-datastore-*) and the testing
 * support libraries, and Spring projects such as Spring Kafka, Spring Batch, Spring Data, and Spring Cloud.
 * Grails 7 (org.apache.grails) publishes all its artifacts with the Grails version.
 */
function isPresenceOnlyArtifact(groupId: string, artifactId: string): boolean {
  if (groupId.startsWith('org.grails.')) return true;
  if (groupId === 'org.grails') return !GRAILS_CORE_ARTIFACT.test(artifactId);
  return groupId.startsWith('org.springframework.') && groupId !== 'org.springframework.boot';
}

/** The build compiles Groovy code. The policy supports Groovy without a version requirement. */
function addGroovyObservation(context: EvidenceContext, sourcePath: string, sourceDetail: string): void {
  addObservation(context, {
    identityCandidates: ['groovy'],
    displayName: 'Groovy',
    ecosystem: 'java',
    technologyType: 'language',
    evidenceKind: 'plugin-declaration',
    sourcePath,
    sourceDetail,
    confidence: 'confident',
    provenance: 'repository-static'
  });
}

function addPresenceOnlyObservation(context: EvidenceContext, observation: S007TechnologyObservation): void {
  addObservation(context, observation);
  if (context.observations.includes(observation)) {
    context.presenceOnlyObservations.add(observation);
  }
}

function finalizeObservations(context: EvidenceFinalizationContext): void {
  finalizePresenceOnlyObservations(context);
  markConflicts(context);
  // An imported BOM only supplies versions for dependencies declared without one, and versions set in the
  // repository take precedence over it. Once every production Maven dependency has a version, the BOM cannot
  // change what S007 checks.
  if (!context.observations.some(observation =>
    observation.mavenDependency
    && !observation.testScope
    && observation.versionResolutionEligible !== false
    && !observation.declaredVersion
    && !observation.resolvedVersion
  )) {
    context.diagnostics = context.diagnostics.filter(diagnostic => diagnostic.code !== 'maven_imported_bom');
  }
}

function finalizePresenceOnlyObservations(context: EvidenceFinalizationContext): void {
  for (const observation of context.presenceOnlyObservations) {
    const authoritative = context.observations.some(candidate =>
      candidate !== observation
      && !candidate.testScope
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
      const message = presenceOnlyMessage(observation);
      context.diagnostics = context.diagnostics.filter(diagnostic =>
        diagnostic.code !== 'version_unresolved'
        || diagnostic.path !== observation.sourcePath
        || diagnostic.message !== message
      );
      continue;
    }
    if (observation.testScope) continue;
    diagnostic(
      context,
      'version_unresolved',
      presenceOnlyMessage(observation),
      true,
      observation.sourcePath,
      {
        subject: observation.sourceDetail,
        listHeading: `Show that ${observation.displayName} is used, but their versions are not the ${observation.displayName} version`
      }
    );
  }
}

function presenceOnlyMessage(observation: S007TechnologyObservation): string {
  return `${observation.sourceDetail} shows that ${observation.displayName} is used, but its version is not the ${observation.displayName} version.`;
}

function markConflicts(context: EvidenceFinalizationContext): void {
  const groups = new Map<string, S007TechnologyObservation[]>();
  // Test dependencies do not decide the status, so a different version used only in tests is not a conflict.
  for (const observation of context.observations.filter(candidate => !candidate.testScope)) {
    const id = observation.identityCandidates[0];
    groups.set(id, [...(groups.get(id) ?? []), observation]);
  }
  for (const observations of groups.values()) {
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
    diagnostic(
      context,
      'conflicting_versions',
      `Different ${observations[0].displayName} versions (${[...versions].join(', ')}) are declared in ${paths.join(', ')}.`,
      true
    );
  }
}

function readManifest(context: EvidenceContext, filePath: string): string | undefined {
  const requestedSourcePath = relativePosixPath(context.repoPath, filePath);
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      diagnostic(context, 'local_module_symlink', 'Is a symbolic link and was not read.', true, requestedSourcePath);
      return undefined;
    }
    if (stats.size > MAX_MANIFEST_BYTES) {
      diagnostic(context, 'manifest_too_large', `Is larger than ${MAX_MANIFEST_BYTES / 1024 / 1024} MB and was not read.`, true, requestedSourcePath);
      return undefined;
    }
    const realPath = fs.realpathSync(filePath);
    const cached = context.manifestContents.get(realPath);
    if (cached !== undefined) {
      return cached;
    }
    if (context.manifestContents.size >= MAX_MANIFESTS) {
      diagnostic(context, 'traversal_limit', `Stopped after reading ${MAX_MANIFESTS} build and package files; the rest were not read.`, true);
      return undefined;
    }
    const sourcePath = relativePosixPath(context.repoPath, realPath);
    const content = fs.readFileSync(realPath, 'utf8');
    context.manifestPaths.add(sourcePath);
    context.manifestContents.set(realPath, content);
    return content;
  } catch (error) {
    diagnostic(context, 'manifest_malformed', `Could not be read: ${errorMessage(error)}`, true, requestedSourcePath);
    return undefined;
  }
}

function safeManifestPath(context: EvidenceContext, candidatePath: string): string | undefined {
  const resolved = path.resolve(candidatePath);
  if (!isPathLexicallyInside(context.repoPath, resolved)) {
    diagnostic(context, 'local_module_outside_repository', 'A Maven module or parent POM points outside the repository and was not read.', true);
    return undefined;
  }
  if (!fs.existsSync(resolved)) {
    diagnostic(context, 'local_module_missing', 'Is listed as a Maven module or parent POM, but does not exist.', true, relativePosixPath(context.repoPath, resolved));
    return undefined;
  }
  if (fs.lstatSync(resolved).isSymbolicLink()) {
    diagnostic(context, 'local_module_symlink', 'Is a symbolic link and was not followed.', true, relativePosixPath(context.repoPath, resolved));
    return undefined;
  }
  if (!isWithinRepo(context.repoPath, resolved)) {
    diagnostic(context, 'local_module_outside_repository', 'A Maven module or parent POM points outside the repository and was not read.', true);
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
    observation.resolvedVersion ?? '',
    // A test declaration must not hide a production declaration of the same dependency.
    observation.testScope ? 'test' : ''
  ].join('\u0000');
  if (context.observationKeys.has(key)) {
    return;
  }
  if (context.observations.length >= MAX_OBSERVATIONS) {
    diagnostic(context, 'traversal_limit', `Stopped after ${MAX_OBSERVATIONS} technology declarations; the rest were not checked.`, true);
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
  pathValue?: string,
  list?: Pick<S007EvidenceDiagnostic, 'subject' | 'listHeading'>
): void {
  const item: S007EvidenceDiagnostic = { code, message, material, path: pathValue, ...list };
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
  return { properties: new Map(), dependencyManagement: new Map(), remoteParent: false, importsBom: false };
}

function cloneMavenContext(value: MavenContext): MavenContext {
  return { ...value, properties: new Map(value.properties), dependencyManagement: new Map(value.dependencyManagement) };
}

function mergeMavenContexts(inherited: MavenContext, cached: MavenContext): MavenContext {
  return {
    properties: new Map([...inherited.properties, ...cached.properties]),
    dependencyManagement: new Map([...inherited.dependencyManagement, ...cached.dependencyManagement]),
    remoteParent: inherited.remoteParent || cached.remoteParent,
    springBoot: inherited.springBoot === 'parent' ? 'parent' : cached.springBoot ?? inherited.springBoot,
    importsBom: inherited.importsBom || cached.importsBom
  };
}

function subtractMavenContext(effective: MavenContext, inherited: MavenContext): MavenContext {
  return {
    remoteParent: effective.remoteParent,
    springBoot: effective.springBoot,
    importsBom: effective.importsBom,
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
      'Sets the Java version in maven-compiler-plugin pluginManagement, which the tool does not evaluate.',
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
      'The maven-compiler-plugin settings give different Java versions (release, source, or target).',
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
    /\blanguageVersion\b\s*(?:=|\.\s*set\s*\()\s*JavaLanguageVersion\.of\(([^)]*)\)/g,
    codePositions
  ).filter(match => /^[^\r\n]+$/.test(match[1].trim()));
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
        `\\b${setting}\\b(?:\\s*=)?\\s*(JavaVersion\\.VERSION_[0-9_]+|JavaVersion\\.toVersion\\([^\\r\\n)]*\\)|["']?\\d+["']?|[A-Za-z][\\w.]*)`,
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
