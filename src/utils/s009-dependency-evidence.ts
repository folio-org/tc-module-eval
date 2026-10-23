import fs from 'fs';
import path from 'path';
import semver from 'semver';
import { S009DependencyEvidence, S009DependencyObservation, S009EvidenceDiagnostic } from '../types';
import { findCandidateFiles, relativePosixPath, sha256Digest } from './repo-files';
import { escapeRegExp } from './regexp';
import { errorMessage } from './type-guards';
import {
  asArray,
  balancedGradleCall,
  GradleDependencyDeclaration,
  packageDependencyEntries,
  parsePackageJson,
  parsePom,
  pomDependencies,
  quotedGradleLiteral,
  scanGradleDeclarations,
  splitGradleArguments,
  stripGradleComments,
  xmlText
} from './manifest-parsers';

const MAX_MANIFESTS = 128;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'target',
  'build',
  'dist',
  'coverage'
]);
const MAVEN_SCOPES = new Set(['compile', 'runtime', 'provided']);
const NPM_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
// compile and runtime are the production configurations of Gradle 6 and older.
const GRADLE_CONFIGURATIONS = ['api', 'implementation', 'compileOnly', 'runtimeOnly', 'compile', 'runtime'] as const;

interface Context {
  repoPath: string;
  observations: S009DependencyObservation[];
  diagnostics: S009EvidenceDiagnostic[];
  projectFiles: Set<string>;
  fileHashes: Record<string, string>;
  observationKeys: Set<string>;
}

interface ParsedMavenProject {
  pomPath: string;
  sourcePath: string;
  project: any;
}

interface MavenManagementEntry {
  groupId: string;
  artifactId: string;
  type: string;
  classifier: string;
  version: string;
  scope: string;
}

interface EffectiveMavenProject {
  groupId?: string;
  artifactId?: string;
  version?: string;
  parentGroupId?: string;
  parentArtifactId?: string;
  parentVersion?: string;
  /** The local parent POM this project inherits from, when the declared parent is in the repository. */
  parentPomPath?: string;
  properties: Map<string, string>;
  management: MavenManagementEntry[];
}

export async function collectS009DependencyEvidence(repoPath: string): Promise<S009DependencyEvidence> {
  const resolvedRepo = fs.realpathSync(path.resolve(repoPath));
  const context: Context = {
    repoPath: resolvedRepo,
    observations: [],
    diagnostics: [],
    projectFiles: new Set(),
    fileHashes: {},
    observationKeys: new Set()
  };

  await collectMaven(context);
  collectGradle(context);
  collectNpm(context);

  return {
    observations: context.observations.sort(compareObservations),
    diagnostics: context.diagnostics,
    projectFiles: [...context.projectFiles].sort(),
    fileHashes: context.fileHashes,
    hasDependencyProject: context.projectFiles.size > 0,
    complete: !context.diagnostics.some(item => item.material)
  };
}

// The Maven build is the root pom.xml, the modules it lists (recursively, including profile modules), and the
// local parents they inherit from. Other pom.xml files, such as test fixtures, are never read.
async function collectMaven(context: Context): Promise<void> {
  const rootPom = path.join(context.repoPath, 'pom.xml');
  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(rootPom);
  } catch {
    return;
  }
  if (!rootStats.isFile()) {
    context.projectFiles.add('pom.xml');
    diagnostic(context, 'maven_manifest_unreadable', 'Is a symbolic link or not a regular file, so the Maven build was not checked.', 'pom.xml');
    return;
  }
  const projects = new Map<string, ParsedMavenProject | undefined>();
  const load = async (pomPath: string): Promise<ParsedMavenProject | undefined> => {
    if (projects.has(pomPath)) return projects.get(pomPath);
    if (projects.size >= MAX_MANIFESTS) {
      manifestLimit(context);
      return undefined;
    }
    const parsed = await parseMavenProject(context, pomPath);
    projects.set(pomPath, parsed);
    return parsed;
  };

  // Walk the modules; edges listed only in a profile are conditional, because the default build may not include them.
  const edges = new Map<string, Array<{ target: string; conditional: boolean }>>();
  const scheduled = new Set([rootPom]);
  const seenReferences = new Set<string>();
  const queue = [rootPom];
  while (queue.length) {
    const pomPath = queue.shift()!;
    const parsed = await load(pomPath);
    if (!parsed) continue;
    const references = [
      ...asArray(parsed.project.modules?.module).map(module => ({ name: xmlText(module), conditional: false })),
      ...asArray(parsed.project.profiles?.profile).flatMap(profile => asArray(profile?.modules?.module))
        .map(module => ({ name: xmlText(module), conditional: true }))
    ].filter(reference => reference.name);
    const pomEdges: Array<{ target: string; conditional: boolean }> = [];
    edges.set(pomPath, pomEdges);
    for (const { name, conditional } of references) {
      const referenceKey = `${conditional}\0${name}`;
      if (seenReferences.has(`${pomPath}\0${referenceKey}`)) continue;
      seenReferences.add(`${pomPath}\0${referenceKey}`);
      const resolved = resolveRepoPom(context, path.dirname(pomPath), name);
      if (resolved.kind !== 'file') {
        diagnostic(
          context,
          'maven_module_missing',
          `Module ${name} has no pom.xml inside this repository (or its path goes through a symbolic link), so its dependencies were not checked.`,
          parsed.sourcePath
        );
        continue;
      }
      pomEdges.push({ target: resolved.path, conditional });
      if (scheduled.has(resolved.path)) continue;
      if (scheduled.size >= MAX_MANIFESTS) {
        manifestLimit(context);
        continue;
      }
      scheduled.add(resolved.path);
      queue.push(resolved.path);
    }
  }
  const modules = new Set([...scheduled].filter(pomPath => projects.has(pomPath)));
  const unconditional = new Set<string>();
  for (const pending = [rootPom]; pending.length;) {
    const pomPath = pending.shift()!;
    if (unconditional.has(pomPath) || !modules.has(pomPath)) continue;
    unconditional.add(pomPath);
    for (const edge of edges.get(pomPath) ?? []) if (!edge.conditional) pending.push(edge.target);
  }

  // Load local parents named by relativePath; they count only when they are the declared parent.
  for (const pending = [...projects.values()]; pending.length;) {
    const parsed = pending.shift();
    const parent = parsed && localParent(context, parsed);
    if (parsed && parent?.kind === 'symlink') {
      diagnostic(
        context,
        'maven_parent_unreadable',
        'Its parent path goes through a symbolic link, so the parent POM and the dependencies it passes on were not checked.',
        parsed.sourcePath
      );
    }
    if (parent?.kind !== 'file' || projects.has(parent.path)) continue;
    pending.push(await load(parent.path));
  }

  const loaded = new Map([...projects].filter((entry): entry is [string, ParsedMavenProject] => Boolean(entry[1])));
  const cache = new Map<string, EffectiveMavenProject>();
  for (const parsed of loaded.values()) resolveMavenProject(context, parsed, loaded, cache, new Set());
  const localProjects = new Map<string, Set<string>>();
  const profileProjects = new Set<string>();
  for (const pomPath of modules) {
    const effective = cache.get(pomPath);
    if (!effective?.groupId || !effective.artifactId) continue;
    const key = `${effective.groupId}:${effective.artifactId}`;
    if (!unconditional.has(pomPath)) {
      profileProjects.add(key);
      continue;
    }
    const versions = localProjects.get(key) ?? new Set<string>();
    if (effective.version) versions.add(effective.version);
    localProjects.set(key, versions);
  }

  // Dependencies come from build modules and from the local parents they inherit.
  const inBuild = new Set<string>();
  for (let pomPath of modules) {
    while (pomPath && !inBuild.has(pomPath) && loaded.has(pomPath)) {
      inBuild.add(pomPath);
      pomPath = cache.get(pomPath)?.parentPomPath ?? '';
    }
  }
  const buildProjects = [...loaded.values()].filter(parsed => inBuild.has(parsed.pomPath));
  const locality = { localProjects, profileProjects };

  for (const parsed of buildProjects) {
    const effective = cache.get(parsed.pomPath);
    if (!effective) continue;
    collectMavenDependencies(context, parsed.sourcePath, parsed.project.dependencies?.dependency, effective, locality, 'dependencies');
    for (const [profileIndex, profile] of asArray(parsed.project.profiles?.profile).entries()) {
      const profileProperties = new Map(effective.properties);
      for (const [name, value] of Object.entries(profile?.properties ?? {})) {
        const text = xmlText(value);
        if (text) profileProperties.set(name, text);
      }
      const profileEffective = { ...effective, properties: profileProperties };
      if (asArray(profile?.dependencyManagement?.dependencies?.dependency).length) {
        diagnostic(
          context,
          'maven_profile_management_unresolved',
          `Profile ${profileIndex + 1} has its own <dependencyManagement>, which can change whether a dependency ships. The evaluator does not apply it.`,
          parsed.sourcePath
        );
      }
      for (const name of Object.keys(profile?.properties ?? {})) {
        if (effective.management.some(item => item.scope.includes(`\${${name}}`)
          && profileProperties.get(name) !== effective.properties.get(name))) {
          diagnostic(
            context,
            'maven_profile_scope_unresolved',
            `Profile ${profileIndex + 1} sets property ${name}, which can change whether a managed dependency ships. The evaluator does not apply it.`,
            parsed.sourcePath
          );
        }
      }
      collectMavenDependencies(
        context,
        parsed.sourcePath,
        profile?.dependencies?.dependency,
        profileEffective,
        locality,
        `profiles.profile[${profileIndex}].dependencies`
      );
    }
  }
}

async function parseMavenProject(context: Context, pomPath: string): Promise<ParsedMavenProject | undefined> {
  const sourcePath = relativePosixPath(context.repoPath, pomPath);
  context.projectFiles.add(sourcePath);
  const content = readManifest(context, pomPath);
  if (content === undefined) return undefined;
  const parsed = await parsePom(content);
  if (!parsed.ok) {
    diagnostic(context, 'maven_manifest_invalid', parsed.reason === 'invalid-xml'
      ? `Not valid XML (${parsed.message}), so its dependencies were not checked.`
      : 'Has no <project> element, so its dependencies were not checked.', sourcePath);
    return undefined;
  }
  return { pomPath, sourcePath, project: parsed.project };
}

/** Where a parent's relativePath (default ../pom.xml) points inside the repository, if it names a POM there. */
function localParent(context: Context, parsed: ParsedMavenProject): ReturnType<typeof resolveRepoPom> | undefined {
  const parent = parsed.project.parent;
  if (!parent) return undefined;
  const relativeValue = xmlText(parent.relativePath);
  if (parent.relativePath !== undefined && !relativeValue) return undefined;
  return resolveRepoPom(context, path.dirname(parsed.pomPath), relativeValue || '../pom.xml');
}

/**
 * Resolves a Maven module or parent path relative to a POM's folder, one component at a time, so that no symbolic
 * link is followed, even one a later ".." would cancel. Maven accepts "\" as a separator; a folder means its pom.xml.
 */
function resolveRepoPom(
  context: Context,
  baseDirectory: string,
  relative: string
): { kind: 'file'; path: string } | { kind: 'missing' | 'outside' | 'symlink' } {
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || /^[\\/]/.test(relative)) return { kind: 'outside' };
  const inside = (candidate: string) => {
    const fromRepo = path.relative(context.repoPath, candidate);
    return fromRepo !== '..' && !fromRepo.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRepo);
  };
  let current = baseDirectory;
  let stats = fs.lstatSync(current);
  const parts = relative.split(/[\\/]+/).filter(part => part && part !== '.');
  for (const [index, part] of [...parts, ''].entries()) {
    if (index === parts.length) {
      if (!stats.isDirectory()) break;
      current = path.join(current, 'pom.xml');
    } else if (part === '..') {
      current = path.dirname(current);
      if (!inside(current)) return { kind: 'outside' };
    } else {
      current = path.join(current, part);
    }
    try {
      stats = fs.lstatSync(current);
    } catch {
      return { kind: 'missing' };
    }
    if (stats.isSymbolicLink()) return { kind: 'symlink' };
  }
  return stats.isFile() && inside(current) ? { kind: 'file', path: current } : { kind: 'missing' };
}

function manifestLimit(context: Context): void {
  if (!context.diagnostics.some(item => item.code === 'manifest_limit')) {
    diagnostic(context, 'manifest_limit', `The Maven build has more than ${MAX_MANIFESTS} pom.xml files; only the first ${MAX_MANIFESTS} were checked.`);
  }
}

function resolveMavenProject(
  context: Context,
  parsed: ParsedMavenProject,
  projects: Map<string, ParsedMavenProject>,
  cache: Map<string, EffectiveMavenProject>,
  visiting: Set<string>
): EffectiveMavenProject | undefined {
  const cached = cache.get(parsed.pomPath);
  if (cached) return cached;
  if (visiting.has(parsed.pomPath)) {
    diagnostic(context, 'maven_parent_cycle', 'Its parent POMs in this repository form a cycle, so the properties and dependency management it inherits could not be read.', parsed.sourcePath);
    return undefined;
  }
  const nextVisiting = new Set(visiting).add(parsed.pomPath);
  let parent: EffectiveMavenProject | undefined;
  let matchedParentPath: string | undefined;
  if (parsed.project.parent) {
    const location = localParent(context, parsed);
    const parentProject = location?.kind === 'file' ? projects.get(location.path) : undefined;
    if (parentProject) {
      const candidate = resolveMavenProject(context, parentProject, projects, cache, nextVisiting);
      if (candidate && mavenParentMatches(parsed.project.parent, candidate)) {
        parent = candidate;
        matchedParentPath = parentProject.pomPath;
      } else if (candidate && mavenParentMatches(parsed.project.parent, candidate, true)) {
        // Maven uses the local POM when its version is in the range; the evaluator does not compare ranges.
        diagnostic(
          context,
          'maven_parent_unresolved',
          'Its parent version is a range, so the evaluator cannot tell whether Maven uses the parent POM in this repository and the dependencies it passes on.',
          parsed.sourcePath
        );
      }
      else if (candidate) {
        // Maven then uses the published parent, so this is the same as a parent outside the repository.
        diagnostic(
          context,
          'maven_parent_mismatch',
          'The POM at its parent path is not the parent it declares, so Maven uses the published parent. As with any parent outside this repository, its properties and dependency management are not read.',
          parsed.sourcePath,
          false
        );
      }
    }
  }

  const properties = new Map(parent?.properties ?? []);
  for (const [name, value] of Object.entries(parsed.project.properties ?? {})) {
    const text = xmlText(value);
    if (text) properties.set(name, text);
  }
  const parentGroupId = resolveMavenText(xmlText(parsed.project.parent?.groupId), properties) ?? parent?.groupId;
  const parentArtifactId = resolveMavenText(xmlText(parsed.project.parent?.artifactId), properties) ?? parent?.artifactId;
  const parentVersion = resolveMavenText(xmlText(parsed.project.parent?.version), properties) ?? parent?.version;
  const groupId = resolveMavenText(xmlText(parsed.project.groupId), properties) ?? parentGroupId;
  const artifactId = resolveMavenText(xmlText(parsed.project.artifactId), properties);
  const version = resolveMavenText(xmlText(parsed.project.version), properties) ?? parentVersion;
  setMavenAliases(properties, groupId, artifactId, version, parentGroupId, parentArtifactId, parentVersion);
  const effective: EffectiveMavenProject = {
    groupId,
    artifactId,
    version,
    parentGroupId,
    parentArtifactId,
    parentVersion,
    parentPomPath: matchedParentPath,
    properties,
    management: [...(parent?.management ?? [])]
  };
  for (const dependency of pomDependencies(parsed.project.dependencyManagement?.dependencies?.dependency)) {
    effective.management.push({ ...dependency, type: dependency.type || 'jar' });
  }
  cache.set(parsed.pomPath, effective);
  return effective;
}

/** Whether the declared parent is this POM; with versionRange, whether it names this POM with a version range instead. */
function mavenParentMatches(declared: any, candidate: EffectiveMavenProject, versionRange = false): boolean {
  const properties = new Map(candidate.properties);
  const groupId = resolveMavenText(xmlText(declared?.groupId), properties);
  const artifactId = resolveMavenText(xmlText(declared?.artifactId), properties);
  const version = resolveMavenText(xmlText(declared?.version), properties);
  return Boolean(groupId && artifactId && version
    && groupId === candidate.groupId
    && artifactId === candidate.artifactId
    && (versionRange ? /^[[(].*[\])]$/.test(version) : version === candidate.version));
}

function setMavenAliases(
  properties: Map<string, string>,
  groupId?: string,
  artifactId?: string,
  version?: string,
  parentGroupId?: string,
  parentArtifactId?: string,
  parentVersion?: string
): void {
  for (const prefix of ['project', 'pom']) {
    if (groupId) properties.set(`${prefix}.groupId`, groupId);
    if (artifactId) properties.set(`${prefix}.artifactId`, artifactId);
    if (version) properties.set(`${prefix}.version`, version);
    if (parentGroupId) properties.set(`${prefix}.parent.groupId`, parentGroupId);
    if (parentArtifactId) properties.set(`${prefix}.parent.artifactId`, parentArtifactId);
    if (parentVersion) properties.set(`${prefix}.parent.version`, parentVersion);
  }
}

function collectMavenDependencies(
  context: Context,
  sourcePath: string,
  value: unknown,
  effective: EffectiveMavenProject,
  { localProjects, profileProjects }: { localProjects: Map<string, Set<string>>; profileProjects: Set<string> },
  sourceField: string
): void {
  for (const [index, dependency] of pomDependencies(value).entries()) {
    const { scope: rawScope, groupId: rawGroupId, artifactId: rawArtifactId } = dependency;
    const field = `${sourceField}.dependency[${index}]`;
    const groupId = resolveMavenText(rawGroupId, effective.properties);
    const artifactId = resolveMavenText(rawArtifactId, effective.properties);
    const type = resolveMavenText(dependency.type || 'jar', effective.properties);
    const classifier = resolveMavenText(dependency.classifier, effective.properties) ?? '';
    const managed = groupId && artifactId && type !== undefined
      ? findMavenManagement(effective, groupId, artifactId, type, classifier)
      : undefined;
    const managedScope = managed?.scope ? resolveMavenText(managed.scope, effective.properties) : undefined;
    const scope = rawScope ? resolveMavenText(rawScope, effective.properties) : managed?.scope ? managedScope : 'compile';
    const maybeFolio = groupId ? isFolioGroup(groupId) : rawGroupId.includes('${');
    if (!scope) {
      if (maybeFolio) {
        diagnostic(context, 'maven_scope_unresolved', `The scope of dependency ${rawGroupId || '?'}:${rawArtifactId || '?'} uses a property that is not set in this repository's POMs, so the evaluator cannot tell whether it ships.`, sourcePath);
      }
      continue;
    }
    if (!MAVEN_SCOPES.has(scope)) continue;
    if (!groupId || !artifactId) {
      if (maybeFolio) {
        diagnostic(
          context,
          'maven_coordinate_unresolved',
          `Dependency ${rawGroupId || '?'}:${rawArtifactId || '?'} uses a property that is not set in this repository's POMs, so the evaluator cannot tell whether it is a FOLIO library.`,
          sourcePath
        );
      }
      continue;
    }
    if (!isFolioGroup(groupId)) continue;
    const rawVersion = dependency.version || managed?.version || '';
    const declaredVersion = resolveMavenText(rawVersion, effective.properties);
    const localVersions = localProjects.get(`${groupId}:${artifactId}`);
    if (localVersions?.size && declaredVersion && localVersions.has(declaredVersion)) continue;
    // A module listed only in a profile may not be in the build, so it cannot prove the dependency is local.
    const ambiguousLocality = profileProjects.has(`${groupId}:${artifactId}`) || Boolean(localVersions !== undefined && (
      !localVersions.size || !declaredVersion || /^[[(].*[\])]$/.test(declaredVersion)
    ));
    addObservation(context, {
      ecosystem: 'maven',
      coordinate: `${groupId}:${artifactId}`,
      locality: ambiguousLocality ? 'ambiguous' : undefined,
      declaredVersion,
      sourcePath,
      sourceField: field,
      scope
    });
  }
}

function findMavenManagement(
  effective: EffectiveMavenProject,
  groupId: string,
  artifactId: string,
  type: string,
  classifier: string
): MavenManagementEntry | undefined {
  return [...effective.management].reverse().find(item => (
    resolveMavenText(item.groupId, effective.properties) === groupId
    && resolveMavenText(item.artifactId, effective.properties) === artifactId
    && resolveMavenText(item.type, effective.properties) === type
    && (resolveMavenText(item.classifier, effective.properties) ?? '') === classifier
  ));
}

/** The FOLIO Maven namespace: org.folio and its sub-groups such as org.folio.okapi. */
function isFolioGroup(groupId: string | undefined): boolean {
  return groupId === 'org.folio' || Boolean(groupId?.startsWith('org.folio.'));
}

function collectGradle(context: Context): void {
  const buildFiles = candidateFiles(context, 'Gradle build', file => ['build.gradle', 'build.gradle.kts'].includes(path.basename(file))
    && !relativePosixPath(context.repoPath, file).startsWith('buildSrc/')
    && !relativePosixPath(context.repoPath, file).startsWith('build-logic/'));

  for (const buildPath of buildFiles) {
    const sourcePath = relativePosixPath(context.repoPath, buildPath);
    context.projectFiles.add(sourcePath);
    const content = readManifest(context, buildPath);
    if (content === undefined) continue;
    const staticContent = stripGradleComments(content);
    if (/\bapply\s*(?:\(\s*)?from\s*[:=]/.test(staticContent)) {
      diagnostic(
        context,
        'gradle_external_script',
        'Applies another Gradle script (apply from), which may declare more dependencies. The evaluator does not read applied scripts.',
        sourcePath
      );
    }

    for (const declaration of scanGradleDeclarations(staticContent, GRADLE_CONFIGURATIONS)) {
      collectGradleDeclaration(context, sourcePath, staticContent, declaration);
    }
  }
}

function collectGradleDeclaration(
  context: Context,
  sourcePath: string,
  content: string,
  declaration: GradleDependencyDeclaration
): void {
  const expression = declaration.expression.trim();
  if (expression.startsWith('{')) return;
  const namedGroup = gradleNamedLiteral(expression, 'group');
  if (namedGroup && !namedGroup.includes('$') && !isFolioGroup(namedGroup)) return;
  const map = parseGradleMap(expression);
  if (map) {
    if (map.group?.includes('$') || (isFolioGroup(map.group) && map.name?.includes('$'))) {
      diagnostic(
        context,
        'gradle_coordinate_unresolved',
        `Dependency ${map.group}:${map.name} has a variable ${map.group?.includes('$') ? 'group' : 'name'}, so the evaluator cannot tell which FOLIO library it is.`,
        sourcePath
      );
      return;
    }
    if (isFolioGroup(map.group) && map.name) {
      addObservation(context, {
        ecosystem: 'maven',
        coordinate: `${map.group}:${map.name}`,
        declaredVersion: map.version,
        sourcePath,
        sourceField: `dependencies.${declaration.configuration}[${declaration.index}]`,
        scope: declaration.configuration
      });
      return;
    }
    if (map.group && !map.group.includes('$')) return;
  }
  const argumentsList = splitGradleArguments(expression);
  if (argumentsList.length > 1) {
    for (const [argumentIndex, argument] of argumentsList.entries()) {
      collectGradleDeclaration(context, sourcePath, content, {
        ...declaration,
        expression: argument,
        index: `${declaration.index}.${argumentIndex}`
      });
    }
    return;
  }
  if (isIgnoredGradleExpression(expression)) return;
  const literal = quotedGradleLiteral(expression);
  if (literal !== undefined) {
    collectGradleCoordinate(context, sourcePath, declaration.configuration, literal, declaration.index);
    return;
  }
  const line = content.slice(0, declaration.offset).split(/\r?\n/).length;
  diagnostic(
    context,
    'gradle_dependency_unresolved',
    'A dependency is not a plain "group:name:version" string (for example, a version catalog entry or a variable), so the evaluator cannot tell whether it is a FOLIO library.',
    `${sourcePath}:${line}`
  );
}

function collectGradleCoordinate(
  context: Context,
  sourcePath: string,
  scope: string,
  rawCoordinate: string,
  declarationIndex: string
): void {
  const [groupId, artifactId, ...versionParts] = rawCoordinate.split(':');
  if (groupId.includes('$')) {
    diagnostic(context, 'gradle_coordinate_unresolved', `Dependency ${rawCoordinate} has a variable group, so the evaluator cannot tell whether it is a FOLIO library.`, sourcePath);
    return;
  }
  if (!isFolioGroup(groupId)) return;
  if (!artifactId || artifactId.includes('$')) {
    diagnostic(context, 'gradle_coordinate_unresolved', `Dependency ${rawCoordinate} has a variable name, so the evaluator cannot tell which FOLIO library it is.`, sourcePath);
    return;
  }
  addObservation(context, {
    ecosystem: 'maven',
    coordinate: `${groupId}:${artifactId}`,
    declaredVersion: versionParts.length ? versionParts.join(':') : undefined,
    sourcePath,
    sourceField: `dependencies.${scope}[${declarationIndex}]`,
    scope
  });
}









function isIgnoredGradleExpression(value: string): boolean {
  const match = /^(project|files|fileTree|platform|enforcedPlatform|kotlin)\s*\(/.exec(value);
  if (!match) return false;
  const open = value.indexOf('(', match[0].length - 1);
  const call = balancedGradleCall(value, open);
  return Boolean(call && !value.slice(call.end).trim());
}

function parseGradleMap(value: string): { group?: string; name?: string; version?: string } | undefined {
  const result: { group?: string; name?: string; version?: string } = {};
  const pattern = /\b(group|name|version)\s*[:=]\s*(["'])([^"']*)\2/g;
  let remainder = value;
  for (const match of value.matchAll(pattern)) {
    result[match[1] as keyof typeof result] = match[3];
    remainder = remainder.replace(match[0], '');
  }
  return result.group && result.name && /^[\s,]*$/.test(remainder) ? result : undefined;
}

function gradleNamedLiteral(value: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*[:=]\\s*(["'])([^"']*)\\1`).exec(value)?.[2];
}

function collectNpm(context: Context): void {
  const rootPath = path.join(context.repoPath, 'package.json');
  try {
    const rootStats = fs.lstatSync(rootPath);
    if (!rootStats.isFile() || rootStats.isSymbolicLink()) return;
  } catch {
    return;
  }
  const root = readNpmManifest(context, rootPath);
  if (!root) return;

  const selected = new Set([rootPath]);
  const patterns = workspacePatterns(root.manifest.workspaces, context).map(pattern => ({ pattern, regex: workspacePattern(pattern) }));
  if (patterns.length) {
    // Only workspace manifests count toward the limit; other package.json files (fixtures, examples) are never read.
    const workspaceFiles = candidateFiles(context, 'workspace package.json', file => {
      if (path.basename(file) !== 'package.json' || file === rootPath) return false;
      const directory = relativePosixPath(context.repoPath, path.dirname(file));
      return patterns.some(({ regex }) => regex.test(directory));
    });
    for (const packagePath of workspaceFiles) selected.add(packagePath);
    for (const { pattern, regex } of patterns) {
      if (!workspaceFiles.some(packagePath => regex.test(relativePosixPath(context.repoPath, path.dirname(packagePath))))) {
        diagnostic(context, 'npm_workspace_missing', `Workspace pattern ${pattern} matches no package folder, so the evaluator cannot tell which workspaces exist.`, 'package.json');
      }
    }
  }

  const parsedPackages = [...selected].sort().flatMap(packagePath => {
    const parsed = packagePath === rootPath ? root : readNpmManifest(context, packagePath);
    return parsed ? [{ packagePath, ...parsed }] : [];
  });
  const localWorkspaces = new Map<string, { packagePath: string; version?: string }>();
  for (const parsed of parsedPackages) {
    if (parsed.packagePath === rootPath) continue;
    const name = parsed.manifest.name;
    if (typeof name !== 'string') continue;
    if (localWorkspaces.has(name)) {
      diagnostic(context, 'npm_workspace_duplicate_name', `More than one workspace is named ${name}, so the evaluator cannot tell which one a dependency refers to.`, 'package.json');
      continue;
    }
    localWorkspaces.set(name, {
      packagePath: parsed.packagePath,
      version: typeof parsed.manifest.version === 'string' ? parsed.manifest.version : undefined
    });
  }

  for (const parsed of parsedPackages) {
    const { packagePath, sourcePath, manifest } = parsed;
    context.projectFiles.add(sourcePath);
    const seenPackages = new Set<string>();
    for (const entry of packageDependencyEntries(manifest, NPM_FIELDS)) {
      const { field } = entry;
      if ('invalid' in entry) {
        diagnostic(context, 'npm_dependencies_invalid', `"${field}" is not an object of package names and versions, so it was not checked.`, sourcePath);
        continue;
      }
      const { name: declaredName, specifier } = entry;
      if (typeof specifier !== 'string') {
        diagnostic(context, 'npm_dependency_invalid', `The version of ${declaredName} in "${field}" is not a string, so it was not checked.`, sourcePath);
        continue;
      }
      const packageName = npmTargetPackage(declaredName, specifier);
      if (!packageName.startsWith('@folio/')) continue;
      seenPackages.add(packageName);
      const locality = npmLocality(packageName, specifier, packagePath, localWorkspaces);
      if (locality === 'local') continue;
      addObservation(context, {
        ecosystem: 'npm',
        coordinate: packageName,
        locality: locality === 'ambiguous' ? 'ambiguous' : undefined,
        declaredVersion: specifier,
        sourcePath,
        sourceField: `${field}.${declaredName}`,
        scope: field
      });
    }
    collectBundledDependencies(context, manifest, sourcePath, seenPackages);
  }
}

function npmLocality(
  packageName: string,
  specifier: string,
  declaringPackagePath: string,
  localWorkspaces: Map<string, { packagePath: string; version?: string }>
): 'local' | 'external' | 'ambiguous' {
  const local = localWorkspaces.get(packageName);
  if (!local || specifier.startsWith('npm:')) return 'external';
  if (specifier.startsWith('workspace:')) return 'local';
  if (specifier.startsWith('file:') || specifier.startsWith('link:')) {
    const target = path.resolve(path.dirname(declaringPackagePath), specifier.slice(specifier.indexOf(':') + 1));
    return target === path.dirname(local.packagePath) ? 'local' : 'external';
  }
  const range = semver.validRange(specifier);
  if (range && local.version && semver.valid(local.version)) {
    return semver.satisfies(local.version, range) ? 'local' : 'external';
  }
  if (/^(?:https?:|git(?:\+|:)|github:|[\w.-]+\/[^/]+#)/.test(specifier)) return 'external';
  return 'ambiguous';
}

function collectBundledDependencies(
  context: Context,
  manifest: Record<string, unknown>,
  sourcePath: string,
  seenPackages: Set<string>
): void {
  for (const field of ['bundledDependencies', 'bundleDependencies'] as const) {
    const bundled = manifest[field];
    if (bundled === undefined) continue;
    if (typeof bundled === 'boolean') continue;
    if (!Array.isArray(bundled) || bundled.some(value => typeof value !== 'string')) {
      diagnostic(context, 'npm_bundled_dependencies_invalid', `"${field}" is not a list of package names, so it was not checked.`, sourcePath);
      continue;
    }
    for (const packageName of bundled as string[]) {
      if (!packageName.startsWith('@folio/') || seenPackages.has(packageName)) continue;
      addObservation(context, {
        ecosystem: 'npm',
        coordinate: packageName,
        sourcePath,
        sourceField: field,
        scope: field
      });
    }
  }
}

function readNpmManifest(
  context: Context,
  packagePath: string
): { sourcePath: string; manifest: Record<string, unknown> } | undefined {
  const sourcePath = relativePosixPath(context.repoPath, packagePath);
  context.projectFiles.add(sourcePath);
  const content = readManifest(context, packagePath);
  if (content === undefined) return undefined;
  const parsed = parsePackageJson(content);
  if (!parsed.ok) {
    diagnostic(context, 'npm_manifest_invalid', `Not valid JSON (${parsed.message}), so its dependencies were not checked.`, sourcePath);
    return undefined;
  }
  return { sourcePath, manifest: parsed.manifest };
}

function workspacePatterns(value: unknown, context: Context): string[] {
  if (value === undefined) return [];
  const patterns = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as any).packages)
      ? (value as any).packages
      : undefined;
  if (!patterns || patterns.some((item: unknown) => typeof item !== 'string' || item.startsWith('!'))) {
    diagnostic(context, 'npm_workspaces_invalid', '"workspaces" is not a list of folder patterns, or uses ! exclusions, which the evaluator does not support. Workspaces were not checked.', 'package.json');
    return [];
  }
  return patterns as string[];
}

function workspacePattern(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*\*/g, '::DOUBLE_STAR::').replace(/\*/g, '[^/]*').replace(/::DOUBLE_STAR::/g, '.*')}$`);
}

function npmTargetPackage(declaredName: string, specifier: string): string {
  if (!specifier.startsWith('npm:')) return declaredName;
  const target = specifier.slice(4);
  if (target.startsWith('@')) {
    const separator = target.indexOf('@', 1);
    return separator === -1 ? target : target.slice(0, separator);
  }
  const separator = target.indexOf('@');
  return separator === -1 ? target : target.slice(0, separator);
}

function candidateFiles(context: Context, label: string, include: (file: string) => boolean): string[] {
  const candidates = findCandidateFiles(context.repoPath, context.repoPath, include, SKIPPED_DIRECTORIES).sort();
  if (candidates.length > MAX_MANIFESTS) {
    diagnostic(context, 'manifest_limit', `The repository has ${candidates.length} ${label} files; only the first ${MAX_MANIFESTS} were checked.`);
  }
  return candidates.slice(0, MAX_MANIFESTS);
}

function readManifest(context: Context, filePath: string): string | undefined {
  const sourcePath = relativePosixPath(context.repoPath, filePath);
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_MANIFEST_BYTES) {
      diagnostic(context, 'manifest_too_large', 'Larger than 1 MiB, so it was not read.', sourcePath);
      return undefined;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    context.fileHashes[sourcePath] = sha256Digest(content);
    return content;
  } catch (error) {
    diagnostic(context, 'manifest_read_error', `Could not be read (${errorMessage(error)}).`, sourcePath);
    return undefined;
  }
}

function addObservation(context: Context, observation: S009DependencyObservation): void {
  const key = [observation.ecosystem, observation.coordinate, observation.sourcePath, observation.sourceField].join('\0');
  if (context.observationKeys.has(key)) return;
  context.observationKeys.add(key);
  context.observations.push(observation);
}

function diagnostic(context: Context, code: string, message: string, pathValue?: string, material = true): void {
  context.diagnostics.push({ code, message, path: pathValue, material });
}

function compareObservations(left: S009DependencyObservation, right: S009DependencyObservation): number {
  return [left.ecosystem, left.coordinate, left.sourcePath, left.sourceField].join('\0')
    .localeCompare([right.ecosystem, right.coordinate, right.sourcePath, right.sourceField].join('\0'));
}

function resolveMavenText(value: string, properties: Map<string, string>, depth = 0): string | undefined {
  if (!value || depth > 16) return undefined;
  const names = [...value.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]);
  if (!names.length) return value.includes('${') ? undefined : value;
  let resolved = value;
  for (const name of new Set(names)) {
    const replacement = properties.get(name);
    if (!replacement) return undefined;
    const nested = resolveMavenText(replacement, properties, depth + 1);
    if (!nested) return undefined;
    resolved = resolved.replace(new RegExp(`\\$\\{${escapeRegExp(name)}\\}`, 'g'), nested);
  }
  return resolved.includes('${') ? undefined : resolved;
}
