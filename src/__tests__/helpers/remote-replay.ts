import fs from 'fs';
import path from 'path';
import { RemoteEvidenceTransport } from '../../utils/remote-evidence';

export type RecordedResponses = Record<string, { status: number; body: unknown }>;

/** Responses recorded by `yarn capture:remote-fixtures` (see src/tools/capture-remote-fixtures.ts). */
export function loadRemoteFixture(name: string): RecordedResponses {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'remote', `${name}.json`), 'utf8')).responses;
}

/**
 * A real transport whose fetch serves recorded responses by exact URL. The transport turns fetch errors
 * into failed lookups, so tests must also check `unrecorded` is empty: a URL nobody recorded is a bug.
 */
export function replayTransport(responses: RecordedResponses): { transport: RemoteEvidenceTransport; requested: string[]; unrecorded: string[] } {
  const requested: string[] = [];
  const unrecorded: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    const recorded = responses[url];
    if (!recorded) {
      unrecorded.push(url);
      throw new Error(`No recorded response for ${url}`);
    }
    const body = typeof recorded.body === 'string' ? recorded.body : JSON.stringify(recorded.body);
    return new Response(body, { status: recorded.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { transport: new RemoteEvidenceTransport({ fetchImpl, sleep: async () => undefined }), requested, unrecorded };
}

export interface SyntheticApplication {
  name: string;
  version?: string;
  tier?: 'required' | 'optional' | 'experimental';
  modules?: string[];
  uiModules?: string[];
  /** Replaces the FAR response for this application. */
  far?: { status: number; body: unknown };
}

export const SYNTHETIC_COMMIT = 'c'.repeat(40);

/** Responses for a platform-lsp `snapshot` commit and FAR, in the shape the real services return. */
export function syntheticPlatform(applications: SyntheticApplication[], platform?: unknown): RecordedResponses {
  const responses: RecordedResponses = {
    'https://api.github.com/repos/folio-org/platform-lsp/commits?sha=snapshot&per_page=1': { status: 200, body: [{ sha: SYNTHETIC_COMMIT }] }
  };
  const pins: Record<string, Array<{ name: string; version: string }>> = {};
  for (const application of applications) {
    const version = application.version ?? '1.0.0';
    (pins[application.tier ?? 'optional'] ??= []).push({ name: application.name, version });
    const id = `${application.name}-${version}`;
    const reference = (name: string) => ({ id: `${name}-2.0.0`, name, version: '2.0.0' });
    responses[`https://far.ci.folio.org/applications?query=id%3D%3D${encodeURIComponent(id)}&full=false&limit=2`] = application.far ?? {
      status: 200,
      body: {
        applicationDescriptors: [{
          id, name: application.name, version,
          modules: (application.modules ?? []).map(reference),
          uiModules: (application.uiModules ?? []).map(reference)
        }],
        totalRecords: 1
      }
    };
  }
  responses[`https://raw.githubusercontent.com/folio-org/platform-lsp/${SYNTHETIC_COMMIT}/platform-descriptor.json`] = {
    status: 200,
    body: platform ?? { name: 'platform-lsp', version: 'R1-2027-SNAPSHOT.1', applications: pins }
  };
  return responses;
}
