import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseStringPromise } from 'xml2js';
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

    const properties = new Map<string, string>();
    for (const [name, value] of Object.entries(project.properties ?? {})) {
      const text = xmlText(value);
      if (text) properties.set(name, text);
    }
    collectMavenDependencies(context, sourcePath, project.dependencies?.dependency, properties, 'dependencies');
    for (const [profileIndex, profile] of asArray(project.profiles?.profile).entries()) {
      const profileProperties = new Map(properties);
      for (const [name, value] of Object.entries(profile?.properties ?? {})) {
        const text = xmlText(value);
        if (text) profileProperties.set(name, text);
      }
      collectMavenDependencies(
        context,
        sourcePath,
        profile?.dependencies?.dependency,
        profileProperties,
        `profiles.profile[${profileIndex}].dependencies`
      );
    }
  }
}

function collectMavenDependencies(
  context: Context,
  sourcePath: string,
  value: unknown,
  properties: Map<string, string>,
  sourceField: string
): void {
  for (const [index, dependency] of asArray(value).entries()) {
    const rawScope = xmlText(dependency?.scope);
    const scope = rawScope ? resolveMavenText(rawScope, properties) : 'compile';
    const rawGroupId = xmlText(dependency?.groupId);
    const rawArtifactId = xmlText(dependency?.artifactId);
    const field = `${sourceField}.dependency[${index}]`;
    if (!scope) {
      if (rawGroupId === 'org.folio' || rawGroupId.includes('${')) {
        diagnostic(context, 'maven_scope_unresolved', `Maven dependency scope ${rawScope} could not be resolved from local properties.`, `${sourcePath}#${field}`);
      }
      continue;
    }
    if (!MAVEN_SCOPES.has(scope)) continue;
    const groupId = resolveMavenText(rawGroupId, properties);
    const artifactId = resolveMavenText(rawArtifactId, properties);
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
    addObservation(context, {
      ecosystem: 'maven',
      coordinate: `${groupId}:${artifactId}`,
      declaredVersion: resolveMavenText(xmlText(dependency?.version), properties),
      sourcePath,
      sourceField: field,
      scope
    });
  }
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

    const configuration = `(${GRADLE_CONFIGURATIONS.join('|')})`;
    const literalPattern = new RegExp(`\\b${configuration}\\s*(?:\\(\\s*)?(["'])([^"']+)\\2`, 'g');
    for (const match of staticContent.matchAll(literalPattern)) {
      collectGradleCoordinate(context, sourcePath, match[1], match[3]);
    }

    const mapPattern = new RegExp(
      `\\b${configuration}\\s*(?:\\(\\s*)?((?:(?:group|name|version)\\s*[:=]\\s*["'][^"']+["']\\s*,?\\s*){2,3})\\)?`,
      'g'
    );
    for (const match of staticContent.matchAll(mapPattern)) {
      const groupId = namedGradleLiteral(match[2], 'group');
      const artifactId = namedGradleLiteral(match[2], 'name');
      if (groupId === 'org.folio' && artifactId) {
        addObservation(context, {
          ecosystem: 'maven',
          coordinate: `${groupId}:${artifactId}`,
          declaredVersion: namedGradleLiteral(match[2], 'version'),
          sourcePath,
          sourceField: `dependencies.${match[1]}`,
          scope: match[1]
        });
      }
    }

    const ignoredPattern = new RegExp(
      `\\b${configuration}\\s*(?:\\(\\s*)?(?:project|files|fileTree|platform|enforcedPlatform)\\s*\\(`,
      'g'
    );
    const unresolvedContent = staticContent
      .replace(literalPattern, preserveNewlines)
      .replace(mapPattern, preserveNewlines)
      .replace(ignoredPattern, preserveNewlines);
    for (const [index, line] of unresolvedContent.split(/\r?\n/).entries()) {
      const declaration = new RegExp(`\\b(${GRADLE_CONFIGURATIONS.join('|')})\\b`).exec(line);
      if (!declaration) continue;
      diagnostic(
        context,
        'gradle_dependency_unresolved',
        `Gradle ${declaration[1]} dependency declaration could not be resolved to a literal package coordinate.`,
        `${sourcePath}:${index + 1}`
      );
    }
  }
}

function collectGradleCoordinate(context: Context, sourcePath: string, scope: string, rawCoordinate: string): void {
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
    sourceField: `dependencies.${scope}`,
    scope
  });
}

function collectNpm(context: Context): void {
  const rootPath = path.join(context.repoPath, 'package.json');
  if (!fs.existsSync(rootPath)) return;
  const root = readNpmManifest(context, rootPath);
  if (!root) return;

  const selected = new Set([rootPath]);
  const patterns = workspacePatterns(root.manifest.workspaces, context);
  if (patterns.length) {
    const allPackages = candidateFiles(context, file => path.basename(file) === 'package.json');
    for (const packagePath of allPackages) {
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

  for (const packagePath of [...selected].sort()) {
    const parsed = packagePath === rootPath ? root : readNpmManifest(context, packagePath);
    if (!parsed) continue;
    const { sourcePath, manifest } = parsed;
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
        addObservation(context, {
          ecosystem: 'npm',
          coordinate: packageName,
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

function namedGradleLiteral(value: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*[:=]\\s*(["'])([^"']+)\\1`).exec(value)?.[2];
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

function preserveNewlines(value: string): string {
  return value.replace(/[^\n]/g, ' ');
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
