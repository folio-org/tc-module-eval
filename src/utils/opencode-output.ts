import { isSensitiveKey, redactSensitiveText } from './redaction';

const UNSAFE_OUTPUT = '{"type":"unsafe_output"}';

export function sanitizeStructuredOutput(
  output: string,
  format: 'json' | 'opencode-json',
  maxBytes: number
): { text: string; truncated: boolean } {
  const records: string[] = [];
  let bytes = 0;
  const whole = parseJsonObject(output);
  const inputs = whole ? [output] : format === 'json' ? [output] : output.split(/\r?\n/).filter(line => line.trim());
  const parsedInputs = inputs.map(parseJsonObject);
  if (format === 'opencode-json') combineNativeTextParts(parsedInputs);
  for (const parsed of parsedInputs) {
    let record: string;
    try {
      if (!parsed) throw new Error('Invalid framing');
      record = JSON.stringify(sanitizeValue(parsed));
    } catch {
      // No fragment of unparseable structured data is safe to publish/cache.
      record = UNSAFE_OUTPUT;
    }
    const size = Buffer.byteLength(record) + (records.length ? 1 : 0);
    if (bytes + size > maxBytes) return { text: records.join('\n'), truncated: true };
    records.push(record);
    bytes += size;
  }
  return { text: records.join('\n'), truncated: false };
}

// Capture is already byte-bounded by the runner. Assemble decoded text before
// redaction so neither JSON strings nor secret assignments lose their context.
function combineNativeTextParts(events: Array<Record<string, unknown> | undefined>): void {
  let pending: Record<string, unknown> | undefined;
  let messageID: unknown;
  let native = false;
  for (const event of events) {
    const part = asObject(event?.part);
    const currentID = part.messageID;
    if (!event || event.type === 'step_start' || event.type === 'step_finish' ||
        event.type === 'tool_use' || event.type === 'error' || (currentID && currentID !== messageID)) {
      pending = undefined;
      messageID = currentID;
      native = event?.type === 'step_start' || Boolean(currentID);
    }
    if (native && event?.type === 'text' && part.type === 'text' && typeof part.text === 'string') {
      if (pending) {
        part.text = String(pending.text) + part.text;
        pending.text = '';
      }
      pending = part;
    }
  }
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error('Structured output nesting limit');
  if (typeof value === 'string') {
    // Recognize embedded JSON at every encoding boundary, including tool output.
    const trimmed = value.trim();
    if (/^[\["{]/.test(trimmed)) {
      try {
        return JSON.stringify(sanitizeValue(JSON.parse(trimmed), depth + 1));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    // This is decoded prose, not serialized JSON. Preserve enclosing assignment
    // and private-key context before separating any inline JSON objects.
    const prose = redactSensitiveText(value);
    const assignments = prose.matchAll(/\b[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*["']?\s*[:=]\s*(["'])/gi);
    for (const assignment of assignments) {
      let closed = false;
      for (let index = assignment.index! + assignment[0].length; index < prose.length; index += 1) {
        if (prose[index] === '\\') index += 1;
        else if (prose[index] === assignment[1]) { closed = true; break; }
      }
      if (!closed) throw new Error('Incomplete secret assignment');
    }
    const spans = objectSpans(prose);
    let result = '';
    let offset = 0;
    for (const span of spans) {
      if (!span.value) throw new Error('Malformed embedded JSON');
      result += prose.slice(offset, span.start);
      result += JSON.stringify(sanitizeValue(span.value, depth + 1));
      offset = span.end;
    }
    return result + prose.slice(offset);
  }
  if (Array.isArray(value)) return value.map(entry => sanitizeValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      const safeKey = sanitizeValue(key, depth + 1) as string;
      return [safeKey, isSensitiveKey(key) || safeKey !== key ? '[REDACTED]' : sanitizeValue(entry, depth + 1)];
    }));
  }
  return value;
}

// JSON-like object spans, not ordinary prose braces such as {timeout}.
// A malformed later span must remain observable; never search inside it for advice.
function objectSpans(text: string): Array<{ start: number; end: number; value?: Record<string, unknown> }> {
  const spans: Array<{ start: number; end: number; value?: Record<string, unknown> }> = [];
  const opening = /\{\s*(?=["'}]|[A-Za-z_$][\w$]*\s*:|$)/g;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text))) {
    const end = findBalancedObjectEnd(text, match.index);
    const stop = end < 0 ? text.length : end + 1;
    spans.push({ start: match.index, end: stop, value: end < 0 ? undefined : parseJsonObject(text.slice(match.index, stop)) });
    opening.lastIndex = stop;
    if (end < 0) break;
  }
  return spans;
}

export function parseJsonObject(output: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function parseOpenCodeReviewPayload(output: string): Record<string, unknown> | undefined {
  return decodeOpenCodeOutput(output).payload;
}

export interface OpenCodeOutput {
  payload?: Record<string, unknown>;
  failure?: 'provider_error' | 'incomplete_response' | 'no_assistant_text' | 'malformed_json';
  finishReason?: string;
  providerError?: { name?: string; message?: string; statusCode?: number };
}

export function decodeOpenCodeOutput(output: string): OpenCodeOutput {
  const parsed = parseJsonObject(output);
  if (parsed && !parsed.type) return { payload: parsed };
  let textParts: string[] = [];
  let messageID: unknown;
  let lifecycle = false;
  let finishReason: string | undefined;
  const lines = output.split(/\r?\n/).filter(line => line.trim());
  for (const line of lines) {
    const event = parseJsonObject(line.trim());
    if (!event || event.type === 'unsafe_output') return { failure: 'malformed_json' };
    if (event.type === 'error') {
      const error = asObject(event.error);
      const data = asObject(error.data);
      return { failure: 'provider_error', providerError: {
        name: typeof error.name === 'string' ? redactSensitiveText(error.name, 100) : undefined,
        message: typeof data.message === 'string' ? redactSensitiveText(data.message, 500) :
          typeof error.message === 'string' ? redactSensitiveText(error.message, 500) : undefined,
        statusCode: typeof data.statusCode === 'number' ? data.statusCode : undefined
      } };
    }
    const part = asObject(event.part);
    const currentID = part.messageID ?? asObject(event.message).id;
    if (event.type === 'step_start' || (currentID && currentID !== messageID)) {
      textParts = [];
      finishReason = undefined;
      messageID = currentID;
      lifecycle = true;
    }
    if (event.type === 'step_finish') {
      lifecycle = true;
      finishReason = typeof part.reason === 'string' ? part.reason : undefined;
    }
    if (event.type === 'tool_use' && lifecycle) finishReason = undefined;
    if (!lifecycle && (event.message || event.parts || event.type === 'text')) textParts = [];
    const text = extractOpenCodeEventText(event);
    if (text !== undefined) {
      if (!lifecycle) textParts = [];
      else if (finishReason !== undefined) finishReason = undefined;
      textParts.push(text);
    }
  }
  if (lifecycle && finishReason !== 'stop') return { failure: 'incomplete_response', finishReason };
  if (!textParts.join('').trim()) return { failure: 'no_assistant_text', finishReason };
  const payload = parseJsonObjectFromText(textParts.join('').trim());
  return payload ? { payload, finishReason } : { failure: 'malformed_json', finishReason };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function extractOpenCodeEventText(event: Record<string, unknown>): string | undefined {
  const part = event.part;
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const candidate = part as Record<string, unknown>;
    if (candidate.type === 'text') return firstString(candidate.text, candidate.content);
  }
  const partsText = extractTextParts(event.parts);
  if (partsText) return partsText;
  if (event.type === 'text') return firstString(event.text, event.content);
  const message = event.message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const candidate = message as Record<string, unknown>;
    return extractTextParts(candidate.content) || extractTextParts(candidate.parts);
  }
  return undefined;
}

function extractTextParts(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap(entry => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const text = firstString((entry as Record<string, unknown>).text, (entry as Record<string, unknown>).content);
      return text ? [text] : [];
    }
    return [];
  });
  return parts.length ? parts.join('\n') : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function parseJsonObjectFromText(text: string): Record<string, unknown> | undefined {
  const whole = parseJsonObject(text);
  if (whole) return whole;
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)(?:```|$)/gi)];
  const finalFence = fences[fences.length - 1];
  if (finalFence && !parseJsonObject(finalFence[1].trim())) return undefined;
  const spans = objectSpans(text);
  return spans[spans.length - 1]?.value;
}

function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
