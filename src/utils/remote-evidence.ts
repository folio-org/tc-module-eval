import crypto from 'crypto';
import { RemoteEvidenceRecord, RemoteFailureReason, RemoteJsonResult, RemoteLookups } from '../types/remote-evidence';

// The only way evaluation code reads the network, and only with --allow-remote-lookups. Every request is
// an HTTPS GET to an allowlisted host and path (checked again on every redirect), bounded per request and
// per evaluation, and recorded. Exceeding a bound returns a failure; it never returns partial or empty data.

const MiB = 1024 * 1024;

export interface RemoteEvidenceLimits {
  maxRequests: number;
  maxTotalBytes: number;
  maxDurationMs: number;
  maxConcurrent: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  maxRedirects: number;
  maxRetryWaitMs: number;
}

export const REMOTE_EVIDENCE_LIMITS: Readonly<RemoteEvidenceLimits> = {
  maxRequests: 150,
  maxTotalBytes: 32 * MiB,
  maxDurationMs: 120_000,
  maxConcurrent: 4,
  maxResponseBytes: 4 * MiB,
  requestTimeoutMs: 15_000,
  maxRedirects: 3,
  maxRetryWaitMs: 10_000
};

/** Optional tokens. Each is sent only to its own host, so a redirect to another host drops it. */
export interface RemoteEvidenceCredentials {
  sonarToken?: string;
  githubToken?: string;
}

export interface RemoteEvidenceTransportOptions {
  fetchImpl?: typeof fetch;
  credentials?: RemoteEvidenceCredentials;
  limits?: Partial<RemoteEvidenceLimits>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const REPOSITORY = '(?:platform-lsp|app-[a-z0-9._-]+)';
const ALLOWED_PATHS: Readonly<Record<string, RegExp>> = {
  'sonarcloud.io': /^\/api\//,
  'far.ci.folio.org': /^\/applications$/,
  'raw.githubusercontent.com': new RegExp(`^/folio-org/${REPOSITORY}/`),
  'api.github.com': new RegExp(`^/repos/folio-org/${REPOSITORY}(?:/|$)`)
};
const DEFAULT_RETRY_WAIT_MS = 1_000;
const MAX_MESSAGE_URL_CHARS = 200;

/** Whether a URL is one the transport may request: HTTPS, default port, no credentials, an allowlisted host and path. */
export function isAllowedRemoteUrl(url: URL): boolean {
  const pathPattern = ALLOWED_PATHS[url.hostname];
  return url.protocol === 'https:' && url.port === '' && !url.username && !url.password
    // A percent-encoded "/", "\" or "." could step out of the allowed path on the server.
    && Boolean(pathPattern) && !url.pathname.includes('%') && !url.pathname.includes('\\')
    && pathPattern.test(url.pathname);
}

class RemoteFailure extends Error {
  constructor(readonly reason: RemoteFailureReason, message: string, readonly status?: number) {
    super(message);
  }
}

export class RemoteEvidenceTransport implements RemoteLookups {
  readonly records: RemoteEvidenceRecord[] = [];
  private readonly limits: RemoteEvidenceLimits;
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: RemoteEvidenceCredentials;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private requestCount = 0;
  private byteCount = 0;
  private deadline?: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: RemoteEvidenceTransportOptions = {}) {
    this.limits = { ...REMOTE_EVIDENCE_LIMITS, ...options.limits };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.credentials = options.credentials ?? {};
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async getJson(url: string): Promise<RemoteJsonResult> {
    const record: RemoteEvidenceRecord = { url, fetchedAt: new Date(this.now()).toISOString() };
    this.records.push(record);
    this.deadline ??= this.now() + this.limits.maxDurationMs;
    await this.acquireSlot();
    const attempts = { count: 0 };
    try {
      const { json, status, bytes, finalUrl } = await this.fetchJson(url, attempts);
      record.fetchedAt = new Date(this.now()).toISOString();
      record.status = status;
      record.bytes = bytes.length;
      record.sha256 = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      if (finalUrl !== url) record.finalUrl = finalUrl;
      return { ok: true, json, record };
    } catch (error) {
      const failure = error instanceof RemoteFailure ? error : new RemoteFailure('network', `The request failed: ${errorMessage(error)}`);
      record.fetchedAt = new Date(this.now()).toISOString();
      if (failure.status !== undefined) record.status = failure.status;
      record.error = failure.message;
      return { ok: false, reason: failure.reason, status: failure.status, record };
    } finally {
      if (attempts.count > 1) record.requests = attempts.count;
      this.releaseSlot();
    }
  }

  private async fetchJson(url: string, attempts: { count: number }): Promise<{ json: unknown; status: number; bytes: Buffer; finalUrl: string }> {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new RemoteFailure('not-allowed', `Not a valid URL: ${shortUrl(url)}`);
    }
    let redirects = 0;
    let retried = false;
    for (;;) {
      if (!isAllowedRemoteUrl(current)) {
        throw new RemoteFailure('not-allowed', `${redirects ? 'Redirected to' : 'Requested'} a host or path the tool may not read: ${shortUrl(current.toString())}`);
      }
      const attempt = await this.send(current, attempts);
      try {
        const { response } = attempt;
        const { status } = response;
        if (status >= 300 && status < 400 && response.headers.get('location') !== null) {
          await discard(response);
          if (++redirects > this.limits.maxRedirects) {
            throw new RemoteFailure('redirect-limit', `More than ${this.limits.maxRedirects} redirects.`, status);
          }
          try {
            current = new URL(response.headers.get('location')!, current);
          } catch {
            throw new RemoteFailure('not-allowed', 'Redirected to an invalid address.', status);
          }
          continue;
        }
        if ((status === 429 || status >= 500) && !retried) {
          await discard(response);
          const wait = retryWaitMs(response.headers.get('retry-after'), this.now());
          if (wait > this.limits.maxRetryWaitMs) {
            throw new RemoteFailure(status === 429 ? 'rate-limited' : 'http-status',
              `HTTP ${status}, and the server asked to wait ${Math.ceil(wait / 1000)} s before retrying, longer than the ${this.limits.maxRetryWaitMs / 1000} s the tool waits.`, status);
          }
          if (this.now() + wait >= this.deadline!) throw this.timeBudgetFailure();
          attempt.clear();
          await this.sleep(wait);
          retried = true;
          continue;
        }
        if (status < 200 || status >= 300) {
          await discard(response);
          throw new RemoteFailure(status === 429 ? 'rate-limited' : 'http-status', `HTTP ${status}.`, status);
        }
        const bytes = await this.readBody(response);
        try {
          return { json: JSON.parse(bytes.toString('utf8')), status, bytes, finalUrl: current.toString() };
        } catch {
          throw new RemoteFailure('invalid-json', 'The response is not valid JSON.', status);
        }
      } catch (error) {
        // A body read cut off by the timer surfaces as an abort error; report the limit instead.
        if (!(error instanceof RemoteFailure) && attempt.signal.aborted) throw attempt.abortFailure();
        throw error;
      } finally {
        attempt.clear();
      }
    }
  }

  // One HTTP request, after checking the evaluation's request, byte and time budgets. The returned timer also
  // covers reading the body; the caller clears it.
  private async send(url: URL, attempts: { count: number }): Promise<{ response: Response; signal: AbortSignal; clear: () => void; abortFailure: () => RemoteFailure }> {
    if (this.requestCount >= this.limits.maxRequests) {
      throw new RemoteFailure('budget-requests', `The evaluation's limit of ${this.limits.maxRequests} remote requests was reached.`);
    }
    if (this.byteCount >= this.limits.maxTotalBytes) throw this.byteBudgetFailure();
    const remaining = this.deadline! - this.now();
    if (remaining <= 0) throw this.timeBudgetFailure();
    this.requestCount++;
    attempts.count++;

    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'folio-module-evaluator' };
    const authorization = this.authorizationFor(url.hostname);
    if (authorization) headers.authorization = authorization;
    const byDeadline = remaining < this.limits.requestTimeoutMs;
    const abortFailure = () => byDeadline ? this.timeBudgetFailure() : this.timeoutFailure();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), byDeadline ? remaining : this.limits.requestTimeoutMs);
    const clear = () => clearTimeout(timer);
    try {
      const response = await this.fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers });
      return { response, signal: controller.signal, clear, abortFailure };
    } catch (error) {
      clear();
      if (controller.signal.aborted) throw abortFailure();
      throw new RemoteFailure('network', `The request failed: ${errorMessage(error)}`);
    }
  }

  private async readBody(response: Response): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length'));
    if (response.headers.get('content-length') !== null && Number.isFinite(declared)) {
      if (declared > this.limits.maxResponseBytes) {
        await discard(response);
        throw this.tooLargeFailure(response.status);
      }
      if (this.byteCount + declared > this.limits.maxTotalBytes) {
        await discard(response);
        throw this.byteBudgetFailure();
      }
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      this.byteCount += value.byteLength;
      if (received > this.limits.maxResponseBytes || this.byteCount > this.limits.maxTotalBytes) {
        await reader.cancel().catch(() => undefined);
        throw received > this.limits.maxResponseBytes ? this.tooLargeFailure(response.status) : this.byteBudgetFailure();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, received);
  }

  private authorizationFor(hostname: string): string | undefined {
    if (hostname === 'sonarcloud.io' && this.credentials.sonarToken) return `Bearer ${this.credentials.sonarToken}`;
    if (hostname === 'api.github.com' && this.credentials.githubToken) return `Bearer ${this.credentials.githubToken}`;
    return undefined;
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.limits.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private timeoutFailure(): RemoteFailure {
    return new RemoteFailure('timeout', `No complete response within ${this.limits.requestTimeoutMs / 1000} s.`);
  }

  private timeBudgetFailure(): RemoteFailure {
    return new RemoteFailure('budget-time', `The evaluation's ${this.limits.maxDurationMs / 1000} s limit for remote lookups was reached.`);
  }

  private byteBudgetFailure(): RemoteFailure {
    return new RemoteFailure('budget-bytes', `The evaluation's limit of ${formatBytes(this.limits.maxTotalBytes)} of remote responses was reached.`);
  }

  private tooLargeFailure(status: number): RemoteFailure {
    return new RemoteFailure('too-large', `The response is larger than ${formatBytes(this.limits.maxResponseBytes)}.`, status);
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Retry-After in milliseconds: delta seconds or an HTTP date; a short default when absent or unreadable. */
function retryWaitMs(header: string | null, now: number): number {
  if (header === null) return DEFAULT_RETRY_WAIT_MS;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? DEFAULT_RETRY_WAIT_MS : Math.max(0, date - now);
}

function formatBytes(bytes: number): string {
  return bytes % MiB === 0 ? `${bytes / MiB} MiB` : `${bytes} bytes`;
}

function shortUrl(url: string): string {
  return url.length > MAX_MESSAGE_URL_CHARS ? `${url.slice(0, MAX_MESSAGE_URL_CHARS - 1)}…` : url;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
