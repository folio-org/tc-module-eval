// Side-effect-free parsers for the FOLIO LSP platform descriptor (folio-org/platform-lsp) and the
// application descriptors FAR serves. Shared by the S008 catalog acquisition and S014. Malformed input
// is reported as diagnostics, never thrown, and each consumer chooses which application tiers it reads.

import { isRecord } from './type-guards';

export type PlatformApplicationTier = 'required' | 'optional' | 'experimental';

export interface PlatformPin {
  name: string;
  version: string;
}

export interface PlatformApplicationPin extends PlatformPin {
  tier: PlatformApplicationTier;
}

export interface PlatformParseDiagnostic {
  code: string;
  material: boolean;
  message: string;
  source?: string;
}

export interface ApplicationModuleReference {
  id: string;
  identity: string;
  version: string;
}

/** Application pins of the given tiers, each tier sorted by name and version. */
export function parsePlatformApplicationPins(
  platform: Record<string, unknown>,
  tiers: readonly PlatformApplicationTier[],
  diagnostics: PlatformParseDiagnostic[]
): PlatformApplicationPin[] {
  const applications = asOptionalRecord(platform.applications);
  if (platform.applications !== undefined && !applications) {
    diagnostics.push({ code: 'invalid_application_container', material: true, message: 'Platform applications must be an object.' });
  }
  return tiers.flatMap(tier => parsePlatformPins(applications?.[tier], 'application', diagnostics)
    .map(pin => ({ ...pin, tier })));
}

/** Concrete name/version pins from one platform list (applications of one tier, or eureka-components). */
export function parsePlatformPins(values: unknown, kind: string, diagnostics: PlatformParseDiagnostic[]): PlatformPin[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    diagnostics.push({ code: `invalid_${kind}_pins`, material: true, message: `Platform ${kind} pins must be an array.` });
    return [];
  }
  return values.flatMap((value, index) => {
    const record = asOptionalRecord(value);
    if (!record || typeof record.name !== 'string' || typeof record.version !== 'string' || !record.name || !record.version) {
      diagnostics.push({ code: `invalid_${kind}_pin`, material: true, message: `Platform ${kind} pin ${index} lacks concrete name/version.` });
      return [];
    }
    return [{ name: record.name, version: record.version }];
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/**
 * The single application descriptor in a FAR `applications?query=id==<name>-<version>` response.
 * Anything other than exactly one record with exactly the pinned identity is a diagnostic.
 */
export function parseFarApplication(
  parsed: unknown,
  pin: PlatformPin,
  source: string,
  diagnostics: PlatformParseDiagnostic[]
): Record<string, any> | undefined {
  const exactId = `${pin.name}-${pin.version}`;
  const envelope = asOptionalRecord(parsed);
  const records = Array.isArray(envelope?.applicationDescriptors) ? envelope!.applicationDescriptors : [];
  const totalRecords = typeof envelope?.totalRecords === 'number' ? envelope.totalRecords : records.length;
  if (records.length !== 1 || totalRecords !== 1) {
    diagnostics.push({ code: 'far_cardinality', material: true, message: `Expected exactly one FAR result for ${exactId}; received ${totalRecords}.`, source });
    return undefined;
  }
  const application = asOptionalRecord(records[0]);
  if (!application || application.id !== exactId || application.name !== pin.name || application.version !== pin.version) {
    diagnostics.push({ code: 'far_identity_mismatch', material: true, message: `FAR result did not exactly match ${exactId}.`, source });
    return undefined;
  }
  return application;
}

/** One `modules` or `uiModules` entry of an application descriptor, with its module name and exact version. */
export function parseApplicationModuleReference(
  reference: unknown,
  applicationId: string,
  diagnostics: PlatformParseDiagnostic[]
): ApplicationModuleReference | undefined {
  const record = asOptionalRecord(reference);
  if (!record || typeof record.id !== 'string') {
    diagnostics.push({ code: 'invalid_module_reference', material: true, message: `${applicationId} contains a module reference without an exact ID.` });
    return undefined;
  }
  const identity = moduleIdentity(record);
  if (!identity) {
    diagnostics.push({ code: 'unresolved_module_identity', material: true, message: `Unable to derive module identity for ${record.id}.`, source: applicationId });
    return undefined;
  }
  const version = typeof record.version === 'string' && record.version
    ? record.version
    : record.id.slice(identity.length + 1);
  if (!version || record.id !== `${identity}-${version}`) {
    diagnostics.push({ code: 'unresolved_module_version', material: true, message: `Unable to derive exact module version for ${record.id}.`, source: applicationId });
    return undefined;
  }
  return { id: record.id, identity, version };
}

function moduleIdentity(reference: Record<string, unknown>): string | undefined {
  if (typeof reference.name === 'string' && reference.name) return reference.name;
  const id = reference.id as string;
  if (typeof reference.version === 'string' && id.endsWith(`-${reference.version}`)) {
    return id.slice(0, -reference.version.length - 1);
  }
  return undefined;
}

function asOptionalRecord(value: unknown): Record<string, any> | undefined {
  return isRecord(value) ? value : undefined;
}
