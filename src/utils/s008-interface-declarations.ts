import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ModuleDescriptorArtifact, ModuleKind, S008Declaration, S008DeclarationDiagnostic, S008DeclarationResult } from '../types';
import { isSupportedEurekaVersionExpression } from './eureka-interface-compatibility';
import { isWithinRepo, readBoundedFileBytes, realPath, relativePosixPath } from './repo-files';

const BACKEND_CANDIDATES = [
  'descriptors/ModuleDescriptor.json',
  'descriptors/ModuleDescriptor-template.json',
  'ModuleDescriptor.json',
  'src/main/resources/descriptors/ModuleDescriptor.json',
  // FOLIO's Grails modules (mod-agreements, mod-licenses, ...) keep their Gradle build and descriptor template in service/.
  'service/src/main/okapi/ModuleDescriptor-template.json'
];
const MAX_DECLARATION_SOURCE_BYTES = 2 * 1024 * 1024;

export function collectS008Declarations(
  repoPath: string,
  kind: ModuleKind,
  existingArtifact?: ModuleDescriptorArtifact
): S008DeclarationResult {
  if (kind === 'ui-module') return collectFrontend(repoPath);
  if (kind === 'backend-module') return collectBackend(repoPath, existingArtifact);
  return result([], [{ code: 'module_kind_unsupported', message: `S008 cannot read interface declarations for a repository of kind ${kind}.`, material: true }]);
}

function collectBackend(repoPath: string, artifact?: ModuleDescriptorArtifact): S008DeclarationResult {
  const artifactPath = artifact && ['produced', 'discovered'].includes(artifact.status) && artifact.absolutePath
    && isWithinRepo(repoPath, artifact.absolutePath) ? artifact.absolutePath : undefined;
  const selected = artifactPath ?? BACKEND_CANDIDATES.map(candidate => path.join(repoPath, candidate)).find(candidate => fs.existsSync(candidate));
  if (!selected) {
    return result([], [{ code: 'declaration_source_missing', message: `No module descriptor was found. S008 looked for ${BACKEND_CANDIDATES.join(', ')}.`, material: true }]);
  }
  return parseDescriptor(repoPath, selected);
}

function parseDescriptor(repoPath: string, selected: string): S008DeclarationResult {
  const sourcePath = relativePosixPath(repoPath, selected);
  const diagnostics: S008DeclarationDiagnostic[] = [];
  const source = readDeclarationSource(repoPath, selected, sourcePath);
  if (!source.ok) return result([], [source.diagnostic]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.content);
  } catch (error) {
    return result([], [{ code: 'declaration_source_invalid', message: `${sourcePath} is not valid JSON: ${errorMessage(error)}`, path: sourcePath, material: true }]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result([], [{ code: 'unsupported_declaration_shape', message: `${sourcePath} does not contain a JSON object.`, path: sourcePath, material: true }]);
  }
  const descriptor = parsed as Record<string, unknown>;

  const declarations = [
    ...parseDescriptorList(descriptor.requires, false, 'requires', sourcePath, diagnostics),
    ...parseDescriptorList(descriptor.optional, true, 'optional', sourcePath, diagnostics)
  ];
  return finalize(declarations, diagnostics, sourcePath, source.content);
}

function parseDescriptorList(
  value: unknown,
  optional: boolean,
  field: string,
  sourcePath: string,
  diagnostics: S008DeclarationDiagnostic[]
): S008Declaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push({ code: 'unsupported_declaration_shape', message: `${sourcePath} has a "${field}" field that is not a list.`, path: `${sourcePath}#/${field}`, material: true });
    return [];
  }
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as any).id !== 'string' || typeof (entry as any).version !== 'string'
      || hasPlaceholder((entry as any).id) || hasPlaceholder((entry as any).version)) {
      diagnostics.push({ code: 'incomplete_declaration', message: `${sourcePath} has an entry ${field}[${index}] without a concrete interface id and version (one is missing, not text, or a placeholder such as \${version}).`, path: `${sourcePath}#/${field}/${index}`, material: true });
      return [];
    }
    return declaration((entry as any).id, (entry as any).version, optional, sourcePath, `${field}[${index}]`, diagnostics);
  });
}

function collectFrontend(repoPath: string): S008DeclarationResult {
  const selected = path.join(repoPath, 'package.json');
  if (!fs.existsSync(selected)) return result([], [{ code: 'declaration_source_missing', message: 'package.json is missing.', path: 'package.json', material: true }]);
  const source = readDeclarationSource(repoPath, selected, 'package.json');
  if (!source.ok) return result([], [source.diagnostic]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.content);
  } catch (error) {
    return result([], [{ code: 'declaration_source_invalid', message: `package.json is not valid JSON: ${errorMessage(error)}`, path: 'package.json', material: true }]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result([], [{ code: 'unsupported_declaration_shape', message: 'package.json does not contain a JSON object.', path: 'package.json', material: true }]);
  }
  const manifest = parsed as Record<string, unknown>;
  const diagnostics: S008DeclarationDiagnostic[] = [];
  const stripes = manifest.stripes;
  if (stripes === undefined) return finalize([], diagnostics, 'package.json', source.content);
  if (!stripes || typeof stripes !== 'object' || Array.isArray(stripes)) {
    diagnostics.push({ code: 'unsupported_declaration_shape', message: 'package.json has a "stripes" field that is not an object.', path: 'package.json#/stripes', material: true });
    return finalize([], diagnostics, 'package.json', source.content);
  }
  const record = stripes as Record<string, unknown>;
  const declarations = [
    ...parseInterfaceMap(record.okapiInterfaces, false, 'stripes.okapiInterfaces', diagnostics),
    ...parseInterfaceMap(record.optionalOkapiInterfaces, true, 'stripes.optionalOkapiInterfaces', diagnostics)
  ];
  return finalize(declarations, diagnostics, 'package.json', source.content);
}

function readDeclarationSource(
  repoPath: string,
  selected: string,
  sourcePath: string
): { ok: true; content: string } | { ok: false; diagnostic: S008DeclarationDiagnostic } {
  try {
    if (!isWithinRepo(repoPath, selected)) throw new Error('it links outside the repository');
    const resolved = realPath(selected);
    if (!resolved) throw new Error('it is a link to a file that does not exist');
    const stats = fs.statSync(resolved);
    if (!stats.isFile()) throw new Error('it is not a regular file');
    if (stats.size > MAX_DECLARATION_SOURCE_BYTES) throw new Error(`it is larger than ${MAX_DECLARATION_SOURCE_BYTES / 1024 / 1024} MB`);
    const bytes = readBoundedFileBytes(resolved, MAX_DECLARATION_SOURCE_BYTES + 1);
    if (bytes.length > MAX_DECLARATION_SOURCE_BYTES) throw new Error(`it is larger than ${MAX_DECLARATION_SOURCE_BYTES / 1024 / 1024} MB`);
    return { ok: true, content: bytes.toString('utf8') };
  } catch (error) {
    return {
      ok: false,
      diagnostic: { code: 'declaration_source_unsafe', message: `${sourcePath} was not read: ${errorMessage(error)}.`, path: sourcePath, material: true }
    };
  }
}

function parseInterfaceMap(value: unknown, optional: boolean, field: string, diagnostics: S008DeclarationDiagnostic[]): S008Declaration[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({ code: 'unsupported_declaration_shape', message: `package.json has a "${field}" field that is not a map of interface names to versions.`, path: `package.json#/${field.replace('.', '/')}`, material: true });
    return [];
  }
  return Object.entries(value).flatMap(([id, version]) => {
    if (typeof version !== 'string') {
      diagnostics.push({ code: 'incomplete_declaration', message: `package.json gives ${field}.${id} a version that is not text.`, path: `package.json#/${field.replace('.', '/')}/${id}`, material: true });
      return [];
    }
    return declaration(id, version, optional, 'package.json', `${field}.${id}`, diagnostics);
  });
}

function declaration(id: string, version: string, optional: boolean, sourcePath: string, sourceField: string, diagnostics: S008DeclarationDiagnostic[]): S008Declaration[] {
  if (!isSupportedEurekaVersionExpression(version)) {
    diagnostics.push({ code: 'unsupported_version_syntax', message: `${sourcePath} gives ${id} (${sourceField}) the version "${version}", which Eureka cannot read. Use major.minor (such as 1.2), with several versions separated by single spaces.`, path: `${sourcePath}#${sourceField}`, material: true });
    return [];
  }
  return [{ id, version, optional, sourcePath, sourceField }];
}

function finalize(declarations: S008Declaration[], diagnostics: S008DeclarationDiagnostic[], sourcePath: string, content: string): S008DeclarationResult {
  // A descriptor that lists the same interface twice (mod-orders requires orders-storage.settings 1.0 twice) declares it once.
  const key = (item: S008Declaration) => `${item.id}\0${item.version}\0${item.optional}`;
  const seen = new Set<string>();
  const sorted = declarations.filter(item => !seen.has(key(item)) && seen.add(key(item)))
    .sort((a, b) => key(a).localeCompare(key(b)));
  return { declarations: sorted, diagnostics, sourcePaths: [sourcePath], fileHashes: { [sourcePath]: hash(content) }, complete: !diagnostics.some(item => item.material) };
}

function result(declarations: S008Declaration[], diagnostics: S008DeclarationDiagnostic[]): S008DeclarationResult {
  return { declarations, diagnostics, sourcePaths: [], fileHashes: {}, complete: !diagnostics.some(item => item.material) };
}

function hash(content: string): string { return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`; }
function hasPlaceholder(value: string): boolean { return /\$\{|\{\{|@[^@]+@/.test(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
