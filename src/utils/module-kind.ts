import * as fs from 'fs';
import * as path from 'path';
import { ModuleKindResult } from '../types';
import { isDirectory, readJsonFile, readTextFile } from './repo-files';

const EXPLICIT_LIBRARY_NAMES = new Set([
  'folio-spring-base',
  'folio-spring-support',
  'folio-kafka-wrapper',
  'stripes-components',
  'stripes-core',
  'stripes-connect',
  'stripes-smart-components',
  'stripes-testing'
]);

export function classifyModuleKind(repoPath: string): ModuleKindResult {
  const evidence: string[] = [];
  const warnings: string[] = [];
  const basename = path.basename(repoPath);
  const packageJson = readJsonFile(path.join(repoPath, 'package.json'), warnings);
  const pomXml = readTextFile(path.join(repoPath, 'pom.xml'), warnings);

  if (hasBackendModuleMarker(repoPath, evidence)) {
    return { kind: 'backend-module', evidence, warnings };
  }

  if (hasUiModuleMarker(basename, packageJson, evidence)) {
    return { kind: 'ui-module', evidence, warnings };
  }

  if (hasExplicitLibraryMarker(basename, packageJson, pomXml, evidence)) {
    return { kind: 'library', evidence, warnings };
  }

  return { kind: 'ambiguous', evidence: ['No explicit deployable module or allowlisted library marker found'], warnings };
}

function hasBackendModuleMarker(repoPath: string, evidence: string[]): boolean {
  const descriptorDirs = [path.join(repoPath, 'descriptors'), repoPath];
  for (const descriptorDir of descriptorDirs) {
    if (!isDirectory(descriptorDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(descriptorDir)) {
      if (/^ModuleDescriptor.*\.json$/i.test(entry)) {
        evidence.push(`Backend module descriptor found at ${path.relative(repoPath, path.join(descriptorDir, entry))}`);
        return true;
      }
    }
  }

  return false;
}

function hasUiModuleMarker(
  basename: string,
  packageJson: Record<string, unknown> | undefined,
  evidence: string[]
): boolean {
  const packageName = typeof packageJson?.name === 'string' ? packageJson.name : undefined;
  if (basename.startsWith('ui-') || packageName?.startsWith('ui-') || packageName?.startsWith('@folio/ui-')) {
    evidence.push(`UI module marker found from repository or package name (${packageName ?? basename})`);
    return true;
  }

  const stripes = packageJson?.stripes;
  if (stripes && typeof stripes === 'object') {
    evidence.push('Stripes metadata found in package.json');
    return true;
  }

  return false;
}

function hasExplicitLibraryMarker(
  basename: string,
  packageJson: Record<string, unknown> | undefined,
  pomXml: string | undefined,
  evidence: string[]
): boolean {
  const packageName = typeof packageJson?.name === 'string' ? packageJson.name.replace(/^@folio\//, '') : undefined;
  const names = [basename, packageName].filter((name): name is string => Boolean(name));

  for (const name of names) {
    if (EXPLICIT_LIBRARY_NAMES.has(name)) {
      evidence.push(`Explicit allowlisted library marker: ${name}`);
      return true;
    }
  }

  const artifactMatch = pomXml?.match(/<artifactId>([^<]+)<\/artifactId>/);
  if (artifactMatch && EXPLICIT_LIBRARY_NAMES.has(artifactMatch[1])) {
    evidence.push(`Explicit allowlisted Maven library artifact: ${artifactMatch[1]}`);
    return true;
  }

  return false;
}
