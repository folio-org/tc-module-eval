import path from 'path';
import fs from 'fs-extra';
import Ajv, { ErrorObject } from 'ajv';
import policySchema from '../schemas/officially-supported-technologies.schema.json';
import {
  S007OfficiallySupportedTechnologiesPolicy,
  S007PolicyArea,
  S007PolicyConsumer,
  S007PolicyDiagnostic,
  S007PolicyLoadResult,
  S007PolicySection
} from '../types';
import { errorMessage } from './type-guards';

export const DEFAULT_S007_POLICY_PATH = path.resolve(
  __dirname,
  '../../config/officially-supported-technologies.json'
);

const ajv = new Ajv({ allErrors: true, strict: false });
const validatePolicy = ajv.compile(policySchema);

export async function loadS007Policy(policyPath = DEFAULT_S007_POLICY_PATH): Promise<S007PolicyLoadResult> {
  let content: string;

  try {
    content = await fs.readFile(policyPath, 'utf8');
  } catch (error) {
    const missing = isMissingFileError(error);
    return failure(policyPath, {
      code: missing ? 'policy_missing' : 'policy_read_error',
      message: missing
        ? `The officially supported technologies list was not found at ${policyPath}.`
        : `The officially supported technologies list could not be read: ${errorMessage(error)}`,
      path: policyPath
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return failure(policyPath, {
      code: 'policy_parse_error',
      message: `The officially supported technologies list is not valid JSON: ${errorMessage(error)}`,
      path: policyPath
    });
  }

  if (!validatePolicy(parsed)) {
    return {
      ok: false,
      sourcePath: policyPath,
      diagnostics: (validatePolicy.errors ?? []).map(toSchemaDiagnostic)
    };
  }

  return {
    ok: true,
    policy: parsed as unknown as S007OfficiallySupportedTechnologiesPolicy,
    sourcePath: policyPath,
    diagnostics: []
  };
}

/** The policy sections one criterion applies to one kind of module (frontend for JavaScript, backend for Java). */
export function policySections(
  policy: S007OfficiallySupportedTechnologiesPolicy,
  consumer: S007PolicyConsumer,
  area: S007PolicyArea
): S007PolicySection[] {
  return policy.sections.filter(section => section.consumer === consumer && section.area === area);
}

export function normalizeS007PolicyVersionExpression(expression: string): string {
  const trimmed = expression.trim();
  const majorLine = /^(\d+)(?:\.x)?$/i.exec(trimmed);
  if (majorLine) {
    const major = Number(majorLine[1]);
    return `>=${major}.0.0 <${major + 1}.0.0-0`;
  }

  const minorLine = /^(\d+)\.(\d+)(?:\.x)?$/i.exec(trimmed);
  if (minorLine) {
    const major = Number(minorLine[1]);
    const minor = Number(minorLine[2]);
    return `>=${major}.${minor}.0 <${major}.${minor + 1}.0-0`;
  }

  return trimmed;
}

function failure(sourcePath: string, diagnostic: S007PolicyDiagnostic): S007PolicyLoadResult {
  return { ok: false, sourcePath, diagnostics: [diagnostic] };
}

function toSchemaDiagnostic(error: ErrorObject): S007PolicyDiagnostic {
  const instancePath = error.instancePath || '/';
  return {
    code: 'policy_schema_error',
    message: `The officially supported technologies list has an invalid value at ${instancePath}: ${error.message ?? 'invalid value'}.`,
    path: instancePath,
    schemaPath: error.schemaPath
  };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
