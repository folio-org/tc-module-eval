import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import Ajv, { ErrorObject } from 'ajv';
import schema from '../schemas/acceptance-ledger.schema.json';
import { AcceptanceLedger, S008PolicyDiagnostic, S008PolicyLoadResult } from '../types';

export const DEFAULT_ACCEPTANCE_LEDGER_PATH = path.resolve(__dirname, '../../config/acceptance-ledger.json');
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

export async function loadAcceptanceLedger(
  sourcePath = DEFAULT_ACCEPTANCE_LEDGER_PATH
): Promise<S008PolicyLoadResult<AcceptanceLedger>> {
  const loaded = await readJson(sourcePath);
  if (!loaded.ok) return loaded;
  if (!validate(loaded.parsed)) {
    return failure(sourcePath, (validate.errors ?? []).map(schemaDiagnostic));
  }

  const ledger = loaded.parsed as unknown as AcceptanceLedger;
  const diagnostics = validateSemantics(ledger);
  if (!ledger.authoritative) {
    diagnostics.push({ code: 'ledger_not_authoritative', message: 'Acceptance ledger has not been marked TC-reviewed.', path: '/authoritative' });
  }
  if (diagnostics.length) return failure(sourcePath, diagnostics);

  return success(sourcePath, loaded.content, ledger);
}

function validateSemantics(ledger: AcceptanceLedger): S008PolicyDiagnostic[] {
  const diagnostics: S008PolicyDiagnostic[] = [];
  duplicateDiagnostics(ledger.families.map(item => item.id), 'family ID', '/families', diagnostics);
  duplicateDiagnostics(ledger.moduleIdentities.map(item => item.identity), 'module identity', '/moduleIdentities', diagnostics);
  duplicateDiagnostics(ledger.libraryCoordinates.map(coordinateKey), 'library coordinate', '/libraryCoordinates', diagnostics);
  const familyIds = new Set(ledger.families.map(item => item.id));
  for (const [index, mapping] of [...ledger.moduleIdentities, ...ledger.libraryCoordinates].entries()) {
    if (!familyIds.has(mapping.familyId)) {
      diagnostics.push({ code: 'dangling_family_reference', message: `Unknown family ID: ${mapping.familyId}`, path: `/identities/${index}/familyId` });
    }
  }
  return diagnostics;
}

function coordinateKey(value: AcceptanceLedger['libraryCoordinates'][number]): string {
  return value.ecosystem === 'maven'
    ? `maven:${value.groupId}:${value.artifactId}`
    : `npm:${value.packageName}`;
}

function duplicateDiagnostics(values: string[], label: string, pathValue: string, diagnostics: S008PolicyDiagnostic[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) diagnostics.push({ code: 'duplicate_entry', message: `Duplicate ${label}: ${value}`, path: pathValue });
    seen.add(value);
  }
}

export async function readJson(sourcePath: string): Promise<
  { ok: true; content: string; parsed: unknown }
  | { ok: false; sourcePath: string; diagnostics: S008PolicyDiagnostic[] }
> {
  let content: string;
  try {
    content = await fs.readFile(sourcePath, 'utf8');
  } catch (error) {
    const missing = Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
    return { ok: false, sourcePath, diagnostics: [{
      code: missing ? 'policy_missing' : 'policy_read_error',
      message: missing ? `Trusted policy file not found: ${sourcePath}` : `Unable to read trusted policy file: ${errorMessage(error)}`,
      path: sourcePath
    }] };
  }
  try {
    return { ok: true, content, parsed: JSON.parse(content) };
  } catch (error) {
    return { ok: false, sourcePath, diagnostics: [{ code: 'policy_parse_error', message: `Trusted policy file is not valid JSON: ${errorMessage(error)}`, path: sourcePath }] };
  }
}

export function success<T>(sourcePath: string, content: string, value: T): S008PolicyLoadResult<T> {
  deepFreeze(value);
  return { ok: true, value, sourcePath, digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`, diagnostics: [] };
}

export function failure<T>(sourcePath: string, diagnostics: S008PolicyDiagnostic[]): S008PolicyLoadResult<T> {
  return { ok: false, sourcePath, diagnostics };
}

export function schemaDiagnostic(error: ErrorObject): S008PolicyDiagnostic {
  return { code: 'policy_schema_error', message: `Schema validation failed at ${error.instancePath || '/'}: ${error.message ?? 'invalid value'}`, path: error.instancePath || '/' };
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
