/** One remote read, as recorded for the report. Credentials are never recorded. */
export interface RemoteEvidenceRecord {
  url: string;
  /** Where the response finally came from, when a redirect changed it. */
  finalUrl?: string;
  fetchedAt: string;
  status?: number;
  sha256?: string;
  bytes?: number;
  /** HTTP requests made for this read, counting redirects and the retry; omitted when 1. */
  requests?: number;
  /** Why no usable response was returned. */
  error?: string;
}

export type RemoteFailureReason =
  | 'not-allowed'
  | 'http-status'
  | 'rate-limited'
  | 'redirect-limit'
  | 'timeout'
  | 'too-large'
  | 'invalid-json'
  | 'network'
  | 'budget-requests'
  | 'budget-bytes'
  | 'budget-time';

export type RemoteJsonResult =
  | { ok: true; json: unknown; record: RemoteEvidenceRecord }
  | { ok: false; reason: RemoteFailureReason; status?: number; record: RemoteEvidenceRecord };

/** The bounded, read-only transport every remote lookup goes through (see src/utils/remote-evidence.ts). */
export interface RemoteLookups {
  getJson(url: string): Promise<RemoteJsonResult>;
  /** Every request made in this evaluation, in the order they were started. */
  readonly records: readonly RemoteEvidenceRecord[];
}
