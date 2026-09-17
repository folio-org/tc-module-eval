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
const MAX_MAVEN_PROPERTY_DEPTH = 16;

interface EvidenceContext {
  repoPath: string;
  observations: S007TechnologyObservation[];
  diagnostics: S007EvidenceDiagnostic[];
  manifestPaths: Set<string>;
  visited: Set<string>;
}

interface Identity {
  id: string;
  displayName: string;
  ecosystem: S007Ecosystem;
  technologyType: 'language' | 'framework' | 'library';
  unlisted?: true;
}

interface MavenContext {
  properties: Map<string, { value: string; sourcePath: string }>;
  dependencyManagement: Map<string, { value: string; sourcePath: string }>;
}

interface JavaScriptDeclaration {
  packageName: string;
  range: string;
  field: string;
  identity: Identity;
}

const JAVASCRIPT_IDENTITIES: Record<string, Identity> = {
  '@folio/stripes-core': identity('stripes', 'Stripes', 'javascript', 'framework'),
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
    visited: new Set<string>()
  };

  if (language === 'javascript') {
    collectJavaScriptEvidence(context);
  } else {
    await collectMavenEvidence(context);
    collectGradleEvidence(context);
  }

  markConflicts(context);
  if (context.observations.length === 0) {
    diagnostic(context, 'insufficient_evidence', 'No S007-relevant repository evidence was found.', true);
  }

  return {
    observations: context.observations,
    diagnostics: context.diagnostics,
    manifestPaths: [...context.manifestPaths].sort(),
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
  for (const declaration of declarations) {
    const selector = yarnSelector(declaration);
    const resolvedVersion = lockVersions.get(selector);
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
  if (declarations.length === 0) {
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

    for (const declaration of declarations) {
      const selector = yarnSelector(declaration);
      for (const [combinedSelectors, resolution] of Object.entries(parsed.object)) {
        const selectors = combinedSelectors.split(/,\s*/).map(value => value.replace(/^"|"$/g, ''));
        if (selectors.includes(selector) && typeof resolution.version === 'string') {
          versions.set(selector, resolution.version);
          break;
        }
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
  if (!realPomPath || context.visited.has(realPomPath) || context.visited.size >= MAX_MANIFESTS) {
    if (context.visited.size >= MAX_MANIFESTS) {
      diagnostic(context, 'traversal_limit', `Stopped after ${MAX_MANIFESTS} local manifests.`, true);
    }
    return inherited;
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

  const javaVersion = findMavenCompilerVersion(project, effective, sourcePath)
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
      effective.dependencyManagement.set(coordinates, resolvedVersion);
    }
    if (xmlText(dependency.type) === 'pom' && xmlText(dependency.scope) === 'import') {
      diagnostic(context, 'maven_imported_bom', `Imported BOM ${coordinates} requires remote model resolution.`, true, sourcePath);
    }
  }

  collectMavenDependencies(context, sourcePath, project.dependencies?.dependency, effective);

  for (const moduleName of asArray(project.modules?.module).map(xmlText).filter(Boolean)) {
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
    const groupId = xmlText(dependency?.groupId);
    const artifactId = xmlText(dependency?.artifactId);
    if (!groupId || !artifactId) {
      continue;
    }
    const matched = matchJavaIdentity(groupId, artifactId);
    if (!matched) {
      continue;
    }
    const coordinates = `${groupId}:${artifactId}`;
    const direct = resolveMavenValue(xmlText(dependency.version), effective.properties, sourcePath);
    const managed = effective.dependencyManagement.get(coordinates);
    const resolved = direct ?? managed;
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
      unlistedFrameworkCandidate: matched.unlisted
    });
    if (!resolved) {
      diagnostic(context, 'version_unresolved', `Version for ${coordinates} could not be resolved from local Maven metadata.`, true, sourcePath);
    }
  }
}

function collectGradleEvidence(context: EvidenceContext): void {
  const rootFiles = ['build.gradle', 'build.gradle.kts']
    .map(name => path.join(context.repoPath, name))
    .filter(file => fs.existsSync(file));
  if (rootFiles.length === 0) {
    return;
  }

  const properties = readGradleProperties(context, path.join(context.repoPath, 'gradle.properties'));
  for (const buildFile of rootFiles) {
    collectGradleBuildFile(context, buildFile, properties);
  }

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
  if (!settingsPath) {
    return;
  }
  const settings = readManifest(context, settingsPath);
  if (settings === undefined) {
    return;
  }
  for (const moduleName of parseGradleIncludes(settings)) {
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
        collectGradleBuildFile(context, buildFile, moduleProperties);
      }
    }
  }
}

function collectGradleBuildFile(context: EvidenceContext, buildFile: string, inheritedProperties: Map<string, string>): void {
  const content = readManifest(context, buildFile);
  if (content === undefined) {
    return;
  }
  const sourcePath = relativePosixPath(context.repoPath, buildFile);
  const staticContent = stripGradleComments(content);
  const properties = new Map(inheritedProperties);
  for (const match of staticContent.matchAll(/(?:def|val|var)?\s*([A-Za-z][\w.]*)\s*=\s*["']([^"']+)["']/g)) {
    properties.set(match[1], match[2]);
  }

  const javaVersion = findGradleJavaVersion(staticContent);
  if (javaVersion) {
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
  }

  const dependencyPattern = /(?:implementation|api|compileOnly|runtimeOnly|annotationProcessor)\s*(?:\(\s*)?["']([^"']+)["'](?!\s*\+)/g;
  for (const match of staticContent.matchAll(dependencyPattern)) {
    collectGradleCoordinate(context, sourcePath, match[1], properties);
  }
  const concatenatedPattern = /(?:implementation|api|compileOnly|runtimeOnly|annotationProcessor)\s+["']([^"']+:)["']\s*\+\s*([A-Za-z][\w.]*)/g;
  for (const match of staticContent.matchAll(concatenatedPattern)) {
    const value = properties.get(match[2]);
    collectGradleCoordinate(context, sourcePath, value ? `${match[1]}${value}` : match[1], properties);
    if (!value) {
      diagnostic(context, 'gradle_dynamic_expression', `Gradle property ${match[2]} could not be resolved locally.`, true, sourcePath);
    }
  }

  const pluginPattern = /id\s*(?:\(\s*)?["']([^"']+)["']\s*\)?\s*version\s*["']([^"']+)["']/g;
  for (const match of staticContent.matchAll(pluginPattern)) {
    const matched = matchGradlePlugin(match[1]);
    if (matched) {
      addObservation(context, {
        identityCandidates: [matched.id, match[1]],
        displayName: matched.displayName,
        ecosystem: matched.ecosystem,
        technologyType: matched.technologyType,
        evidenceKind: 'plugin-declaration',
        sourcePath,
        sourceDetail: `plugin ${match[1]}`,
        declaredVersion: match[2],
        confidence: 'confident',
        provenance: 'repository-static',
        unlistedFrameworkCandidate: matched.unlisted
      });
    }
  }

  if (/\blibs\.[A-Za-z]/.test(staticContent)) {
    diagnostic(context, 'gradle_dynamic_expression', 'Gradle version-catalog references require resolution outside the bounded static reader.', true, sourcePath);
  }
}

function collectGradleCoordinate(
  context: EvidenceContext,
  sourcePath: string,
  coordinate: string,
  properties: Map<string, string>
): void {
  const parts = coordinate.split(':');
  if (parts.length < 2) {
    return;
  }
  const [groupId, artifactId] = parts;
  const matched = matchJavaIdentity(groupId, artifactId);
  if (!matched) {
    return;
  }
  const rawVersion = parts.slice(2).join(':');
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
  return modules;
}

function matchJavaIdentity(groupId: string, artifactId: string): Identity | undefined {
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

function markConflicts(context: EvidenceContext): void {
  const groups = new Map<string, S007TechnologyObservation[]>();
  for (const observation of context.observations) {
    const id = observation.identityCandidates[0];
    groups.set(id, [...(groups.get(id) ?? []), observation]);
  }
  for (const [id, observations] of groups) {
    const versions = new Set(observations.map(item => item.resolvedVersion ?? item.declaredVersion).filter(Boolean));
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
  const sourcePath = relativePosixPath(context.repoPath, filePath);
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      diagnostic(context, 'local_module_symlink', `Symlinked manifest was not read: ${sourcePath}.`, true, sourcePath);
      return undefined;
    }
    if (stats.size > MAX_MANIFEST_BYTES) {
      diagnostic(context, 'manifest_too_large', `Manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`, true, sourcePath);
      return undefined;
    }
    context.manifestPaths.add(sourcePath);
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    diagnostic(context, 'manifest_malformed', `Unable to read ${sourcePath}: ${errorMessage(error)}`, true, sourcePath);
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
  const duplicate = context.observations.some(existing =>
    existing.identityCandidates[0] === observation.identityCandidates[0]
    && existing.sourcePath === observation.sourcePath
    && existing.sourceDetail === observation.sourceDetail
    && existing.declaredVersion === observation.declaredVersion
  );
  if (!duplicate) {
    context.observations.push(observation);
  }
}

function diagnostic(
  context: EvidenceContext,
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

function findMavenCompilerVersion(
  project: any,
  context: MavenContext,
  sourcePath: string
): { name: string; value: string; sourcePath: string } | undefined {
  for (const plugin of asArray(project.build?.plugins?.plugin)) {
    const groupId = xmlText(plugin?.groupId);
    if (
      xmlText(plugin?.artifactId) !== 'maven-compiler-plugin'
      || (groupId && groupId !== 'org.apache.maven.plugins')
    ) {
      continue;
    }
    const configurations = [plugin.configuration]
      .concat(asArray(plugin.executions?.execution).map(execution => execution?.configuration))
      .filter(Boolean);
    for (const configuration of configurations) {
      for (const name of ['release', 'source', 'target']) {
        const resolved = resolveMavenValue(xmlText(configuration[name]), context.properties, sourcePath);
        if (resolved) {
          return { name: `maven-compiler-plugin.configuration.${name}`, ...resolved };
        }
      }
    }
  }
  return undefined;
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

function findGradleJavaVersion(content: string): { value: string; sourceDetail: string } | undefined {
  const toolchain = /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(content);
  if (toolchain) {
    return { value: toolchain[1], sourceDetail: 'Gradle Java toolchain' };
  }

  for (const setting of ['sourceCompatibility', 'targetCompatibility']) {
    const declaration = new RegExp(
      `\\b${setting}\\b\\s*(?:=\\s*)?(?:JavaVersion\\.VERSION_([0-9_]+)|["']?(\\d+)["']?)`
    ).exec(content);
    if (declaration) {
      return {
        value: declaration[2] ?? normalizeGradleJavaVersion(declaration[1]),
        sourceDetail: `Gradle ${setting}`
      };
    }
  }
  return undefined;
}

function normalizeGradleJavaVersion(value: string): string {
  return value.startsWith('1_') ? value.slice(2) : value.replace(/_/g, '.');
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
      if (content.startsWith(quote, index) && content[index - 1] !== '\\') {
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
