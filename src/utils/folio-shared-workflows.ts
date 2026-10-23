import path from 'path';
import fs from 'fs-extra';
import Ajv from 'ajv';
import schema from '../schemas/folio-shared-workflows.schema.json';
import { FolioSharedWorkflowTable, FolioSharedWorkflowTableLoadResult } from '../types';

export const DEFAULT_FOLIO_SHARED_WORKFLOWS_PATH = path.resolve(__dirname, '../../config/folio-shared-workflows.json');

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

/** The maintainer-reviewed table of what FOLIO's reusable workflows supply when a repository does not. */
export async function loadFolioSharedWorkflows(
  sourcePath = DEFAULT_FOLIO_SHARED_WORKFLOWS_PATH
): Promise<FolioSharedWorkflowTableLoadResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      sourcePath,
      diagnostics: [{ code: 'policy_read_error', message: `The FOLIO shared-workflow table could not be read: ${message}`, path: sourcePath }]
    };
  }
  if (!validate(parsed)) {
    return {
      ok: false,
      sourcePath,
      diagnostics: (validate.errors ?? []).map(error => ({
        code: 'policy_schema_error' as const,
        message: `The FOLIO shared-workflow table has an invalid value at ${error.instancePath || '/'}: ${error.message ?? 'invalid value'}.`,
        path: error.instancePath || '/',
        schemaPath: error.schemaPath
      }))
    };
  }
  return { ok: true, table: parsed as unknown as FolioSharedWorkflowTable, sourcePath, diagnostics: [] };
}
