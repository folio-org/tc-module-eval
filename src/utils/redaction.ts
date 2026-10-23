const SECRET_KEYWORD = '(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|refresh[_-]?token)';
const SECRET_KEY_PATTERN = new RegExp(`^(?:[A-Za-z0-9_-]*${SECRET_KEYWORD}[A-Za-z0-9_-]*|authorization)$`, 'i');

export function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

// An assigned key is a whole run of [A-Za-z0-9_-] from its first letter, digit, or underscore to its end, and contains a
// keyword: whitespace, a separator, or a quote follows it, so it always ends where the run ends. The lookbehind starts it
// once per run and the lookahead finds a keyword in one scan, because a key that could start at every word boundary and
// split around every keyword backtracks quadratically on long runs (cubically when keywords repeat). Giving back the run
// char by char afterwards is cheap: what follows a key fails at once on a run char.
const SECRET_KEY = `(?<![A-Za-z0-9_]-*)(?=[A-Za-z0-9_-]*?${SECRET_KEYWORD})[A-Za-z0-9_-]*`;
const QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(`(["']?)\\b(${SECRET_KEY})\\b\\1\\s*([:=])\\s*(["'])((?:\\\\.|(?!\\4)[^\\\\])+)\\4`, 'gi');
// `(?<!\s)` tries the next-assignment lookahead only where whitespace starts: it holds at every position of a whitespace
// run or none, and trying it at each one costs quadratic time on long runs. The value never starts inside a whitespace run,
// except when `\s*` gives one back before a delimiter or the end, where this alternative fails anyway.
const SECRET_ASSIGNMENT_PATTERN = new RegExp(`\\b(${SECRET_KEY})\\b\\s*([:=])\\s*([^\\r\\n"'\\\`,;]+?)(?=(?<!\\s)\\s+\\b(?:${SECRET_KEY}|Authorization)\\b\\s*[:=]|[\\r\\n"'\\\`,;]|$)`, 'gi');
const PROVIDER_TOKEN_PATTERN = /\b(?:sk-(?:proj-)?[A-Za-z0-9][A-Za-z0-9._-]{2,}|sk-or-v1-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|ya29\.[A-Za-z0-9_-]{8,})\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const OKAPI_TOKEN_PATTERN = /\b(?:X-Okapi-Token|Okapi-Token)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi;
export const URL_CREDENTIAL_PATTERN = /\bhttps?:\/\/[^:\s/@]+(?::[^@\s/]+)?@[^\s"'`<>)]*/gi;
export const PRIVATE_URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|(?:[A-Za-z0-9-]+\.)+(?:internal|local|corp|lan))(?::\d+)?(?=[/?#\s"'`<>)]|$)(?:[/?#][^\s"'`<>)]*)?/gi;
export const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]+?-----END \1-----/g;

export function redactSensitiveText(input: string, maxBytes?: number): string {
  let redacted = input
    .replace(PRIVATE_KEY_BLOCK_PATTERN, '[REDACTED_PRIVATE_KEY_BLOCK]')
    .replace(OKAPI_TOKEN_PATTERN, match => match.replace(/^((?:X-Okapi-Token|Okapi-Token)\s*[:=]\s*)[A-Za-z0-9._~+/=-]+$/i, '$1[REDACTED]'))
    .replace(QUOTED_SECRET_ASSIGNMENT_PATTERN, (_match, quote, key, separator, valueQuote) => `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, (match, key, _separator, value) => value === '[REDACTED]' ? match : `${key}=[REDACTED]`)
    .replace(PROVIDER_TOKEN_PATTERN, '[REDACTED_PROVIDER_TOKEN]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_TOKEN]')
    .replace(URL_CREDENTIAL_PATTERN, '[REDACTED_CREDENTIAL_URL]')
    .replace(PRIVATE_URL_PATTERN, '[REDACTED_PRIVATE_URL]');

  if (maxBytes === undefined) {
    return redacted;
  }

  return truncateToByteBudget(redacted, maxBytes);
}

export function truncateToByteBudget(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) {
    return text;
  }

  const truncated = buffer.subarray(0, maxBytes).toString('utf-8').replace(/\uFFFD$/, '');
  return `${truncated}\n[output truncated to ${maxBytes} bytes]`;
}
