const SECRET_KEY = '[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|refresh[_-]?token)[A-Za-z0-9_-]*';
const QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(`(["']?)\\b(${SECRET_KEY})\\b\\1\\s*([:=])\\s*(["'])([^"']+)\\4`, 'gi');
const SECRET_ASSIGNMENT_PATTERN = new RegExp(`\\b(${SECRET_KEY})\\b\\s*([:=])\\s*([^\\s"'\\\`,;]+)`, 'gi');
const PROVIDER_TOKEN_PATTERN = /\b(?:sk-(?:proj-)?[A-Za-z0-9][A-Za-z0-9._-]{2,}|sk-or-v1-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|ya29\.[A-Za-z0-9_-]{8,})\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const OKAPI_TOKEN_PATTERN = /\b(?:X-Okapi-Token|Okapi-Token)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIAL_PATTERN = /\bhttps?:\/\/[^:\s/@]+:[^@\s/]+@[^\s"'`<>)]*/gi;
const PRIVATE_URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|[^/\s"'`<>)]*\.(?:internal|local|corp|lan))[^\s"'`<>)]*/gi;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]+?-----END \1-----/g;

export function redactSensitiveText(input: string, maxBytes?: number): string {
  let redacted = input
    .replace(PRIVATE_KEY_BLOCK_PATTERN, '[REDACTED_PRIVATE_KEY_BLOCK]')
    .replace(OKAPI_TOKEN_PATTERN, match => match.replace(/^((?:X-Okapi-Token|Okapi-Token)\s*[:=]\s*)[A-Za-z0-9._~+/=-]+$/i, '$1[REDACTED]'))
    .replace(QUOTED_SECRET_ASSIGNMENT_PATTERN, (_match, quote, key, separator, valueQuote) => `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, (match, key, _separator, value) => value === '[REDACTED]' ? match : `${key}=[REDACTED]`)
    .replace(PROVIDER_TOKEN_PATTERN, '[REDACTED_PROVIDER_TOKEN]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(URL_CREDENTIAL_PATTERN, '[REDACTED_CREDENTIAL_URL]')
    .replace(PRIVATE_URL_PATTERN, '[REDACTED_PRIVATE_URL]');

  if (maxBytes === undefined) {
    return redacted;
  }

  const buffer = Buffer.from(redacted);
  if (buffer.length <= maxBytes) {
    return redacted;
  }

  redacted = buffer.subarray(0, maxBytes).toString('utf-8').replace(/\uFFFD$/, '');
  return `${redacted}\n[output truncated to ${maxBytes} bytes]`;
}

export function redactLocalUserPaths(input: string): string {
  return input
    .replace(/\/Users\/[^/\s]+/g, '/Users/[REDACTED_USER]')
    .replace(/\/home\/[^/\s]+/g, '/home/[REDACTED_USER]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, 'C:\\Users\\[REDACTED_USER]');
}

export function redactJsonValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSensitiveText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactJsonValue(item)) as T;
  }
  if (value instanceof Date) {
    return value as T;
  }
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = redactJsonValue(entry);
    }
    return copy as T;
  }
  return value;
}
