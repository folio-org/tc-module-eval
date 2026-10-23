import * as fs from 'fs';
import * as path from 'path';
import { Parser } from 'xml2js';
import { ModuleKindResult } from '../types';
import { xmlText } from './manifest-parsers';
import { isDirectory, readBoundedFileBytes, readJsonFile } from './repo-files';
import { errorMessage } from './type-guards';

const MAX_POM_BYTES = 1024 * 1024;

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
  const pomArtifactId = readPomArtifactId(path.join(repoPath, 'pom.xml'), warnings);

  if (hasBackendModuleMarker(repoPath, evidence)) {
    return { kind: 'backend-module', evidence, warnings };
  }

  // Checked before the UI markers: stripes-components and similar libraries carry Stripes metadata.
  if (hasExplicitLibraryMarker(packageJson, pomArtifactId, evidence) || hasStripesLibraryMarker(packageJson, evidence)) {
    return { kind: 'library', evidence, warnings };
  }

  if (hasUiModuleMarker(basename, packageJson, evidence)) {
    return { kind: 'ui-module', evidence, warnings };
  }

  return { kind: 'ambiguous', evidence: ['No explicit deployable module or allowlisted library marker found'], warnings };
}

function hasBackendModuleMarker(repoPath: string, evidence: string[]): boolean {
  const descriptorDirs = [
    path.join(repoPath, 'descriptors'),
    repoPath,
    path.join(repoPath, 'src/main/resources/descriptors'),
    // FOLIO's Gradle (Grails) modules keep their descriptor templates here
    path.join(repoPath, 'service/src/main/okapi')
  ];
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

// A Stripes package without an actsAs role is a library whatever its name, e.g. stripes-acq-components' `"actsAs": [""]`.
function hasStripesLibraryMarker(packageJson: Record<string, unknown> | undefined, evidence: string[]): boolean {
  const stripes = packageJson?.stripes;
  if (!stripes || typeof stripes !== 'object') {
    return false;
  }
  const actsAs = ([] as unknown[]).concat((stripes as Record<string, unknown>).actsAs ?? []);
  if (actsAs.some(role => typeof role === 'string' && role.trim() !== '')) {
    return false;
  }
  evidence.push('Stripes metadata in package.json declares no actsAs role');
  return true;
}

// Matches package names only: real runs clone into `<repo>/<timestamp>`, so the directory name says nothing.
function hasExplicitLibraryMarker(
  packageJson: Record<string, unknown> | undefined,
  pomArtifactId: string | undefined,
  evidence: string[]
): boolean {
  const packageName = typeof packageJson?.name === 'string' ? packageJson.name.replace(/^@folio\//, '') : undefined;
  if (packageName && EXPLICIT_LIBRARY_NAMES.has(packageName)) {
    evidence.push(`Explicit allowlisted library marker: ${packageName}`);
    return true;
  }

  if (pomArtifactId && EXPLICIT_LIBRARY_NAMES.has(pomArtifactId)) {
    evidence.push(`Explicit allowlisted Maven library artifact: ${pomArtifactId}`);
    return true;
  }

  return false;
}

function readPomArtifactId(pomPath: string, warnings: string[]): string | undefined {
  if (!fs.existsSync(pomPath)) {
    return undefined;
  }
  let bytes: Buffer;
  try {
    bytes = readBoundedFileBytes(pomPath, MAX_POM_BYTES + 1);
  } catch (error) {
    warnings.push(`Unable to read pom.xml: ${errorMessage(error)}`);
    return undefined;
  }
  if (bytes.length > MAX_POM_BYTES) {
    warnings.push(`pom.xml is larger than ${MAX_POM_BYTES} bytes and was not read`);
    return undefined;
  }
  return pomArtifactId(bytes.toString('utf-8'), warnings);
}

/**
 * The project's own <artifactId> in pom.xml text, not the <parent>'s or a dependency's or plugin's, as written:
 * properties are not resolved. Synchronous: xml2js calls back before parseString returns unless its async option
 * is set.
 */
export function pomArtifactId(content: string, warnings: string[]): string | undefined {
  let done = false;
  let project: unknown;
  let parseError: unknown;
  try {
    new Parser({ explicitArray: false, trim: true }).parseString(content, (error, result) => {
      done = true;
      if (error) {
        parseError = error;
      } else {
        project = result?.project;
      }
    });
  } catch (error) {
    // xml2js can throw on content after the root element once it has already called back; keep that result.
    if (!done) {
      parseError = error;
    }
  }
  if (parseError) {
    warnings.push(`Unable to parse pom.xml: ${errorMessage(parseError)}`);
    return undefined;
  }
  return xmlText((project as Record<string, unknown> | undefined)?.artifactId) || undefined;
}
