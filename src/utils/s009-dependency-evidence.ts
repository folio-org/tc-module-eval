import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseStringPromise } from 'xml2js';
import semver from 'semver';
import { S009DependencyEvidence, S009DependencyObservation, S009EvidenceDiagnostic } from '../types';
import { findCandidateFiles, relativePosixPath } from './repo-files';

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
const GRADLE_CONFIGURATIONS = ['api', 'implementation', 'compileOnly', 'runtimeOnly'] as const;

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
  properties: Map<string, string>;
  management: MavenManagementEntry[];
}

interface GradleDeclaration {
  scope: typeof GRADLE_CONFIGURATIONS[number];
  expression: string;
  offset: number;
  index: number;
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

async function collectMaven(context: Context): Promise<void> {
  const pomFiles = candidateFiles(context, file => path.basename(file) === 'pom.xml');
  const projects = new Map<string, ParsedMavenProject>();
  for (const pomPath of pomFiles) {
    const sourcePath = relativePosixPath(context.repoPath, pomPath);
    context.projectFiles.add(sourcePath);
    const content = readManifest(context, pomPath);
    if (content === undefined) continue;

    let project: any;
    try {
      project = (await parseStringPromise(content, { explicitArray: false, trim: true }))?.project;
    } catch (error) {
      diagnostic(context, 'maven_manifest_invalid', `Unable to parse ${sourcePath}: ${errorMessage(error)}`, sourcePath);
      continue;
    }
    if (!project || typeof project !== 'object') {
      diagnostic(context, 'maven_manifest_invalid', `${sourcePath} has no Maven project element.`, sourcePath);
      continue;
    }
    projects.set(fs.realpathSync(pomPath), { pomPath: fs.realpathSync(pomPath), sourcePath, project });
  }

  const cache = new Map<string, EffectiveMavenProject>();
  for (const parsed of projects.values()) resolveMavenProject(context, parsed, projects, cache, new Set());
  const participating = participatingMavenProjects(context, projects);
  const localProjects = new Map<string, Set<string>>();
  for (const pomPath of participating) {
    const effective = cache.get(pomPath);
    if (!effective?.groupId || !effective.artifactId) continue;
    const versions = localProjects.get(`${effective.groupId}:${effective.artifactId}`) ?? new Set<string>();
    if (effective.version) versions.add(effective.version);
    localProjects.set(`${effective.groupId}:${effective.artifactId}`, versions);
  }

  for (const parsed of projects.values()) {
    const effective = cache.get(parsed.pomPath);
    if (!effective) continue;
    collectMavenDependencies(context, parsed.sourcePath, parsed.project.dependencies?.dependency, effective, localProjects, 'dependencies');
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
          'Profile dependency management may change production scope and is outside the bounded static Maven model.',
          `${parsed.sourcePath}#profiles.profile[${profileIndex}].dependencyManagement`
        );
      }
      for (const name of Object.keys(profile?.properties ?? {})) {
        if (effective.management.some(item => item.scope.includes(`\${${name}}`)
          && profileProperties.get(name) !== effective.properties.get(name))) {
          diagnostic(
            context,
            'maven_profile_scope_unresolved',
            `Profile property ${name} may change a managed dependency scope.`,
            `${parsed.sourcePath}#profiles.profile[${profileIndex}].properties.${name}`
          );
        }
      }
      collectMavenDependencies(
        context,
        parsed.sourcePath,
        profile?.dependencies?.dependency,
        profileEffective,
        localProjects,
        `profiles.profile[${profileIndex}].dependencies`
      );
    }
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
    diagnostic(context, 'maven_parent_cycle', `Local Maven parent cycle includes ${parsed.sourcePath}.`, parsed.sourcePath);
    return undefined;
  }
  const nextVisiting = new Set(visiting).add(parsed.pomPath);
  let parent: EffectiveMavenProject | undefined;
  if (parsed.project.parent) {
    const relativeValue = xmlText(parsed.project.parent.relativePath);
    const relativePathDisabled = parsed.project.parent.relativePath !== undefined && !relativeValue;
    const parentPath = relativePathDisabled
      ? undefined
      : path.resolve(path.dirname(parsed.pomPath), relativeValue || '../pom.xml');
    const parentProject = parentPath && projects.get(parentPath);
    if (parentProject) {
      const candidate = resolveMavenProject(context, parentProject, projects, cache, nextVisiting);
      if (candidate && mavenParentMatches(parsed.project.parent, candidate)) parent = candidate;
      else if (candidate) {
        diagnostic(context, 'maven_parent_mismatch', `Local Maven parent for ${parsed.sourcePath} does not match its declared GAV.`, parsed.sourcePath);
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
    properties,
    management: [...(parent?.management ?? [])]
  };
  for (const dependency of asArray(parsed.project.dependencyManagement?.dependencies?.dependency)) {
    effective.management.push({
      groupId: xmlText(dependency?.groupId),
      artifactId: xmlText(dependency?.artifactId),
      type: xmlText(dependency?.type) || 'jar',
      classifier: xmlText(dependency?.classifier),
      version: xmlText(dependency?.version),
      scope: xmlText(dependency?.scope)
    });
  }
  cache.set(parsed.pomPath, effective);
  return effective;
}

function mavenParentMatches(declared: any, candidate: EffectiveMavenProject): boolean {
  const properties = new Map(candidate.properties);
  const groupId = resolveMavenText(xmlText(declared?.groupId), properties);
  const artifactId = resolveMavenText(xmlText(declared?.artifactId), properties);
  const version = resolveMavenText(xmlText(declared?.version), properties);
  return Boolean(groupId && artifactId && version
    && groupId === candidate.groupId
    && artifactId === candidate.artifactId
    && version === candidate.version);
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

function participatingMavenProjects(context: Context, projects: Map<string, ParsedMavenProject>): Set<string> {
  const root = projects.get(path.join(context.repoPath, 'pom.xml'));
  if (!root) return new Set();
  const participating = new Set<string>();
  const visit = (parsed: ParsedMavenProject): void => {
    if (participating.has(parsed.pomPath)) return;
    participating.add(parsed.pomPath);
    for (const moduleName of asArray(parsed.project.modules?.module).map(xmlText).filter(Boolean)) {
      const modulePom = path.resolve(path.dirname(parsed.pomPath), moduleName, 'pom.xml');
      const module = projects.get(modulePom);
      if (module) visit(module);
    }
  };
  visit(root);
  return participating;
}

function collectMavenDependencies(
  context: Context,
  sourcePath: string,
  value: unknown,
  effective: EffectiveMavenProject,
  localProjects: Map<string, Set<string>>,
  sourceField: string
): void {
  for (const [index, dependency] of asArray(value).entries()) {
    const rawScope = xmlText(dependency?.scope);
    const rawGroupId = xmlText(dependency?.groupId);
    const rawArtifactId = xmlText(dependency?.artifactId);
    const field = `${sourceField}.dependency[${index}]`;
    const groupId = resolveMavenText(rawGroupId, effective.properties);
    const artifactId = resolveMavenText(rawArtifactId, effective.properties);
    const type = resolveMavenText(xmlText(dependency?.type) || 'jar', effective.properties);
    const classifier = resolveMavenText(xmlText(dependency?.classifier), effective.properties) ?? '';
    const managed = groupId && artifactId && type !== undefined
      ? findMavenManagement(effective, groupId, artifactId, type, classifier)
      : undefined;
    const managedScope = managed?.scope ? resolveMavenText(managed.scope, effective.properties) : undefined;
    const scope = rawScope ? resolveMavenText(rawScope, effective.properties) : managed?.scope ? managedScope : 'compile';
    if (!scope) {
      if (rawGroupId === 'org.folio' || rawGroupId.includes('${')) {
        diagnostic(context, 'maven_scope_unresolved', 'Maven dependency scope could not be resolved from local parent properties or dependency management.', `${sourcePath}#${field}`);
      }
      continue;
    }
    if (!MAVEN_SCOPES.has(scope)) continue;
    if (!groupId || !artifactId) {
      if (rawGroupId === 'org.folio' || rawGroupId.includes('${')) {
        diagnostic(
          context,
          'maven_coordinate_unresolved',
          `Maven dependency ${rawGroupId || '?'}:${rawArtifactId || '?'} could not be resolved from local properties.`,
          `${sourcePath}#${field}`
        );
      }
      continue;
    }
    if (groupId !== 'org.folio') continue;
    const rawVersion = xmlText(dependency?.version) || managed?.version || '';
    const declaredVersion = resolveMavenText(rawVersion, effective.properties);
    const localVersions = localProjects.get(`${groupId}:${artifactId}`);
    if (localVersions?.size && declaredVersion && localVersions.has(declaredVersion)) continue;
    const ambiguousLocality = Boolean(localVersions?.size && (
      !declaredVersion || /^[[(].*[\])]$/.test(declaredVersion)
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

function collectGradle(context: Context): void {
  const buildFiles = candidateFiles(context, file => ['build.gradle', 'build.gradle.kts'].includes(path.basename(file))
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
        'An applied Gradle script may contain production dependency declarations that cannot be classified statically.',
        sourcePath
      );
    }

    for (const declaration of scanGradleDeclarations(staticContent)) {
      collectGradleDeclaration(context, sourcePath, staticContent, declaration);
    }
  }
}

function collectGradleDeclaration(
  context: Context,
  sourcePath: string,
  content: string,
  declaration: GradleDeclaration
): void {
  const expression = declaration.expression.trim();
  if (isIgnoredGradleExpression(expression)) return;
  const literal = quotedLiteral(expression);
  if (literal !== undefined) {
    collectGradleCoordinate(context, sourcePath, declaration.scope, literal, declaration.index);
    return;
  }
  const namedGroup = gradleNamedLiteral(expression, 'group');
  if (namedGroup && namedGroup !== 'org.folio') return;
  const map = parseGradleMap(expression);
  if (map) {
    if (map.group === 'org.folio' && map.name && !map.name.includes('$')) {
      addObservation(context, {
        ecosystem: 'maven',
        coordinate: `${map.group}:${map.name}`,
        declaredVersion: map.version,
        sourcePath,
        sourceField: `dependencies.${declaration.scope}[${declaration.index}]`,
        scope: declaration.scope
      });
      return;
    }
    if (map.group && !map.group.includes('$')) return;
  }
  const line = content.slice(0, declaration.offset).split(/\r?\n/).length;
  diagnostic(
    context,
    'gradle_dependency_unresolved',
    `Gradle ${declaration.scope} dependency declaration could not be resolved to a literal package coordinate.`,
    `${sourcePath}:${line}`
  );
}

function collectGradleCoordinate(
  context: Context,
  sourcePath: string,
  scope: string,
  rawCoordinate: string,
  declarationIndex: number
): void {
  const [groupId, artifactId, ...versionParts] = rawCoordinate.split(':');
  if (groupId.includes('$')) {
    diagnostic(context, 'gradle_coordinate_unresolved', `Gradle coordinate ${rawCoordinate} has no concrete group.`, sourcePath);
    return;
  }
  if (groupId !== 'org.folio') return;
  if (!artifactId || artifactId.includes('$')) {
    diagnostic(context, 'gradle_coordinate_unresolved', `Gradle coordinate ${rawCoordinate} has no concrete artifact name.`, sourcePath);
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

function scanGradleDeclarations(content: string): GradleDeclaration[] {
  const declarations: GradleDeclaration[] = [];
  const counts = new Map<string, number>();
  for (let index = 0; index < content.length;) {
    if (content[index] === '"' || content[index] === "'") {
      index = skipGradleQuoted(content, index);
      continue;
    }
    if (!/[A-Za-z_]/.test(content[index])) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < content.length && /[A-Za-z0-9_]/.test(content[index])) index += 1;
    const identifier = content.slice(start, index);
    if (identifier === 'add') {
      const open = skipWhitespace(content, index);
      if (content[open] !== '(') continue;
      const call = balancedGradleCall(content, open);
      if (!call) continue;
      const args = splitGradleArguments(call.content);
      const scope = args[0] && quotedLiteral(args[0]);
      if (scope && isGradleConfiguration(scope) && args[1]) {
        const count = counts.get(scope) ?? 0;
        declarations.push({ scope, expression: args.slice(1).join(','), offset: start, index: count });
        counts.set(scope, count + 1);
      }
      index = call.end;
      continue;
    }
    if (!isGradleConfiguration(identifier) || previousNonWhitespace(content, start) === '.') continue;
    const expressionStart = skipWhitespace(content, index);
    let expression: string | undefined;
    let end = expressionStart;
    if (content[expressionStart] === '(') {
      const call = balancedGradleCall(content, expressionStart);
      if (call) {
        expression = call.content;
        end = call.end;
      }
    } else if (expressionStart > index && !['=', '.', '{'].includes(content[expressionStart] ?? '')) {
      end = expressionStart;
      while (end < content.length && content[end] !== '\n' && content[end] !== ';') end += 1;
      expression = content.slice(expressionStart, end);
    }
    if (!expression?.trim()) continue;
    const count = counts.get(identifier) ?? 0;
    declarations.push({ scope: identifier, expression, offset: start, index: count });
    counts.set(identifier, count + 1);
    index = end;
  }
  return declarations;
}

function isGradleConfiguration(value: string): value is typeof GRADLE_CONFIGURATIONS[number] {
  return (GRADLE_CONFIGURATIONS as readonly string[]).includes(value);
}

function skipWhitespace(content: string, index: number): number {
  while (index < content.length && /\s/.test(content[index])) index += 1;
  return index;
}

function previousNonWhitespace(content: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(content[cursor])) return content[cursor];
  }
  return undefined;
}

function skipGradleQuoted(content: string, start: number): number {
  const quote = content.startsWith(content[start].repeat(3), start) ? content[start].repeat(3) : content[start];
  for (let index = start + quote.length; index < content.length; index += 1) {
    if (content.startsWith(quote, index) && !isEscapedCharacter(content, index)) return index + quote.length;
  }
  return content.length;
}

function balancedGradleCall(content: string, open: number): { content: string; end: number } | undefined {
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    if (content[index] === '"' || content[index] === "'") {
      index = skipGradleQuoted(content, index) - 1;
      continue;
    }
    if (content[index] === '(') depth += 1;
    if (content[index] === ')' && --depth === 0) return { content: content.slice(open + 1, index), end: index + 1 };
  }
  return undefined;
}

function splitGradleArguments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"' || value[index] === "'") {
      index = skipGradleQuoted(value, index) - 1;
      continue;
    }
    if (value[index] === '(' || value[index] === '[' || value[index] === '{') depth += 1;
    else if (value[index] === ')' || value[index] === ']' || value[index] === '}') depth -= 1;
    else if (value[index] === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function quotedLiteral(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !['"', "'"].includes(trimmed[0]) || trimmed[trimmed.length - 1] !== trimmed[0]) return undefined;
  return trimmed.slice(1, -1);
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
  const packageFiles = candidateFiles(context, file => path.basename(file) === 'package.json');
  const rootPath = packageFiles.find(file => file === path.join(context.repoPath, 'package.json'));
  if (!rootPath) return;
  const root = readNpmManifest(context, rootPath);
  if (!root) return;

  const selected = new Set([rootPath]);
  const patterns = workspacePatterns(root.manifest.workspaces, context);
  if (patterns.length) {
    for (const packagePath of packageFiles) {
      if (packagePath === rootPath) continue;
      const directory = relativePosixPath(context.repoPath, path.dirname(packagePath));
      if (patterns.some(pattern => workspacePattern(pattern).test(directory))) selected.add(packagePath);
    }
    for (const pattern of patterns) {
      if (![...selected].some(packagePath => packagePath !== rootPath
        && workspacePattern(pattern).test(relativePosixPath(context.repoPath, path.dirname(packagePath))))) {
        diagnostic(context, 'npm_workspace_missing', `Workspace pattern ${pattern} matched no package directories.`, 'package.json#/workspaces');
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
      diagnostic(context, 'npm_workspace_duplicate_name', `Multiple declared workspaces use package name ${name}.`, 'package.json#/workspaces');
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
    for (const field of NPM_FIELDS) {
      const dependencies = manifest[field];
      if (dependencies === undefined) continue;
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        diagnostic(context, 'npm_dependencies_invalid', `${field} must be an object<string,string>.`, `${sourcePath}#/${field}`);
        continue;
      }
      for (const [declaredName, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== 'string') {
          diagnostic(context, 'npm_dependency_invalid', `${field}.${declaredName} must be a string.`, `${sourcePath}#/${field}/${declaredName}`);
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
      diagnostic(context, 'npm_bundled_dependencies_invalid', `${field} must be an array of package names.`, `${sourcePath}#/${field}`);
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
  try {
    const manifest = JSON.parse(content);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('root value must be an object');
    return { sourcePath, manifest };
  } catch (error) {
    diagnostic(context, 'npm_manifest_invalid', `Unable to parse ${sourcePath}: ${errorMessage(error)}`, sourcePath);
    return undefined;
  }
}

function workspacePatterns(value: unknown, context: Context): string[] {
  if (value === undefined) return [];
  const patterns = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as any).packages)
      ? (value as any).packages
      : undefined;
  if (!patterns || patterns.some((item: unknown) => typeof item !== 'string' || item.startsWith('!'))) {
    diagnostic(context, 'npm_workspaces_invalid', 'workspaces must contain supported non-negated path patterns.', 'package.json#/workspaces');
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

function candidateFiles(context: Context, include: (file: string) => boolean): string[] {
  const candidates = findCandidateFiles(context.repoPath, context.repoPath, include, SKIPPED_DIRECTORIES).sort();
  if (candidates.length > MAX_MANIFESTS) {
    diagnostic(context, 'manifest_limit', `Found ${candidates.length} candidate manifests; only the first ${MAX_MANIFESTS} were analyzed.`);
  }
  return candidates.slice(0, MAX_MANIFESTS);
}

function readManifest(context: Context, filePath: string): string | undefined {
  const sourcePath = relativePosixPath(context.repoPath, filePath);
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_MANIFEST_BYTES) {
      diagnostic(context, 'manifest_too_large', `${sourcePath} exceeds ${MAX_MANIFEST_BYTES} bytes.`, sourcePath);
      return undefined;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    context.fileHashes[sourcePath] = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
    return content;
  } catch (error) {
    diagnostic(context, 'manifest_read_error', `Unable to read ${sourcePath}: ${errorMessage(error)}`, sourcePath);
    return undefined;
  }
}

function addObservation(context: Context, observation: S009DependencyObservation): void {
  const key = [observation.ecosystem, observation.coordinate, observation.sourcePath, observation.sourceField].join('\0');
  if (context.observationKeys.has(key)) return;
  context.observationKeys.add(key);
  context.observations.push(observation);
}

function diagnostic(context: Context, code: string, message: string, pathValue?: string): void {
  context.diagnostics.push({ code, message, path: pathValue, material: true });
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
      result += character === '\n' ? '\n' : ' ';
      if (character === '\n') lineComment = false;
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
    if (character === "'" || character === '"') quote = character;
    result += character;
    index += 1;
  }
  return result;
}

function isEscapedCharacter(content: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function xmlText(value: any): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && typeof value._ === 'string') return value._.trim();
  return '';
}

function asArray(value: any): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
