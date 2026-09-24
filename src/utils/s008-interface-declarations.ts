import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ModuleDescriptorArtifact, ModuleKind, S008Declaration, S008DeclarationDiagnostic, S008DeclarationResult } from '../types';
import { isSupportedEurekaVersionExpression } from './eureka-interface-compatibility';
import { isWithinRepo, relativePosixPath } from './repo-files';

const BACKEND_CANDIDATES = [
  'descriptors/ModuleDescriptor.json',
  'descriptors/ModuleDescriptor-template.json',
  'ModuleDescriptor.json'
];

export function collectS008Declarations(
  repoPath: string,
  kind: ModuleKind,
  existingArtifact?: ModuleDescriptorArtifact
): S008DeclarationResult {
  if (kind === 'ui-module') return collectFrontend(repoPath);
  if (kind === 'backend-module') return collectBackend(repoPath, existingArtifact);
  return result([], [{ code: 'module_kind_unsupported', message: `Cannot collect S008 declarations for ${kind}.`, material: true }]);
}

function collectBackend(repoPath: string, artifact?: ModuleDescriptorArtifact): S008DeclarationResult {
  const artifactPath = artifact && ['produced', 'discovered'].includes(artifact.status) && artifact.absolutePath
    && isWithinRepo(repoPath, artifact.absolutePath) ? artifact.absolutePath : undefined;
  const selected = artifactPath ?? BACKEND_CANDIDATES.map(candidate => path.join(repoPath, candidate)).find(candidate => fs.existsSync(candidate));
  if (!selected) {
    return result([], [{ code: 'declaration_source_missing', message: `No static module descriptor found (${BACKEND_CANDIDATES.join(', ')}).`, material: true }]);
  }
  return parseDescriptor(repoPath, selected);
}

function parseDescriptor(repoPath: string, selected: string): S008DeclarationResult {
  const sourcePath = relativePosixPath(repoPath, selected);
  const diagnostics: S008DeclarationDiagnostic[] = [];
  let content: string;
  let descriptor: Record<string, unknown>;
  try {
    content = fs.readFileSync(selected, 'utf8');
    descriptor = JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    return result([], [{ code: 'declaration_source_invalid', message: `Unable to read or parse ${sourcePath}: ${errorMessage(error)}`, path: sourcePath, material: true }]);
  }

  const declarations = [
    ...parseDescriptorList(descriptor.requires, false, 'requires', sourcePath, diagnostics),
    ...parseDescriptorList(descriptor.optional, true, 'optional', sourcePath, diagnostics)
  ];
  return finalize(declarations, diagnostics, sourcePath, content);
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
    diagnostics.push({ code: 'unsupported_declaration_shape', message: `${field} must be an array.`, path: `${sourcePath}#/${field}`, material: true });
    return [];
  }
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as any).id !== 'string' || typeof (entry as any).version !== 'string'
      || hasPlaceholder((entry as any).id) || hasPlaceholder((entry as any).version)) {
      diagnostics.push({ code: 'incomplete_declaration', message: `${field}[${index}] must have concrete string id and version.`, path: `${sourcePath}#/${field}/${index}`, material: true });
      return [];
    }
    return declaration((entry as any).id, (entry as any).version, optional, sourcePath, `${field}[${index}]`, diagnostics);
  });
}

function collectFrontend(repoPath: string): S008DeclarationResult {
  const selected = path.join(repoPath, 'package.json');
  if (!fs.existsSync(selected)) return result([], [{ code: 'declaration_source_missing', message: 'package.json was not found.', path: 'package.json', material: true }]);
  let content: string;
  let manifest: Record<string, unknown>;
  try {
    content = fs.readFileSync(selected, 'utf8');
    manifest = JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    return result([], [{ code: 'declaration_source_invalid', message: `Unable to read or parse package.json: ${errorMessage(error)}`, path: 'package.json', material: true }]);
  }
  const diagnostics: S008DeclarationDiagnostic[] = [];
  const stripes = manifest.stripes;
  if (stripes === undefined) return finalize([], diagnostics, 'package.json', content);
  if (!stripes || typeof stripes !== 'object' || Array.isArray(stripes)) {
    diagnostics.push({ code: 'unsupported_declaration_shape', message: 'package.json stripes must be an object.', path: 'package.json#/stripes', material: true });
    return finalize([], diagnostics, 'package.json', content);
  }
  const record = stripes as Record<string, unknown>;
  const declarations = [
    ...parseInterfaceMap(record.okapiInterfaces, false, 'stripes.okapiInterfaces', diagnostics),
    ...parseInterfaceMap(record.optionalOkapiInterfaces, true, 'stripes.optionalOkapiInterfaces', diagnostics)
  ];
  return finalize(declarations, diagnostics, 'package.json', content);
}

function parseInterfaceMap(value: unknown, optional: boolean, field: string, diagnostics: S008DeclarationDiagnostic[]): S008Declaration[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({ code: 'unsupported_declaration_shape', message: `${field} must be an object<string,string>.`, path: `package.json#/${field.replace('.', '/')}`, material: true });
    return [];
  }
  return Object.entries(value).flatMap(([id, version]) => {
    if (typeof version !== 'string') {
      diagnostics.push({ code: 'incomplete_declaration', message: `${field}.${id} must be a string.`, path: `package.json#/${field.replace('.', '/')}/${id}`, material: true });
      return [];
    }
    return declaration(id, version, optional, 'package.json', `${field}.${id}`, diagnostics);
  });
}

function declaration(id: string, version: string, optional: boolean, sourcePath: string, sourceField: string, diagnostics: S008DeclarationDiagnostic[]): S008Declaration[] {
  if (!isSupportedEurekaVersionExpression(version)) {
    diagnostics.push({ code: 'unsupported_version_syntax', message: `Unsupported Eureka interface version expression ${id} ${version}.`, path: `${sourcePath}#${sourceField}`, material: true });
    return [];
  }
  return [{ id, version, optional, sourcePath, sourceField }];
}

function finalize(declarations: S008Declaration[], diagnostics: S008DeclarationDiagnostic[], sourcePath: string, content: string): S008DeclarationResult {
  const sorted = [...declarations].sort((a, b) => `${a.id}\0${a.version}\0${a.optional}`.localeCompare(`${b.id}\0${b.version}\0${b.optional}`));
  return { declarations: sorted, diagnostics, sourcePaths: [sourcePath], fileHashes: { [sourcePath]: hash(content) }, complete: !diagnostics.some(item => item.material) };
}

function result(declarations: S008Declaration[], diagnostics: S008DeclarationDiagnostic[]): S008DeclarationResult {
  return { declarations, diagnostics, sourcePaths: [], fileHashes: {}, complete: !diagnostics.some(item => item.material) };
}

function hash(content: string): string { return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`; }
function hasPlaceholder(value: string): boolean { return /\$\{|\{\{|@[^@]+@/.test(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
