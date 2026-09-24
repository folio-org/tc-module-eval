export function parseJsonObject(output: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function parseOpenCodeReviewPayload(output: string): Record<string, unknown> | undefined {
  const parsed = parseJsonObject(output);
  if (parsed && !parsed.type) return parsed;
  const textParts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const event = parseJsonObject(line.trim());
    if (!event) continue;
    const text = extractOpenCodeEventText(event);
    if (text) textParts.push(text);
  }
  return textParts.length ? parseJsonObjectFromText(textParts.join('\n').trim()) : undefined;
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
  const candidates: Record<string, unknown>[] = [];
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const fenced = parseJsonObject(fenceMatch[1].trim());
    if (fenced) candidates.push(fenced);
  }
  for (const candidate of extractBalancedJsonObjectTexts(text)) {
    const parsed = parseJsonObject(candidate);
    if (parsed) candidates.push(parsed);
  }
  const whole = parseJsonObject(text);
  if (whole) candidates.push(whole);
  return [...candidates].reverse().find(isAdvisoryPayload) ?? candidates[candidates.length - 1];
}

function isAdvisoryPayload(candidate: Record<string, unknown>): boolean {
  return 'recommendation' in candidate && 'confidence' in candidate &&
    typeof candidate.summary === 'string' && typeof candidate.rationale === 'string' &&
    Array.isArray(candidate.evidenceReferences);
}

function extractBalancedJsonObjectTexts(text: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    const end = findBalancedObjectEnd(text, start);
    if (end > start) candidates.push(text.slice(start, end + 1));
  }
  return candidates;
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
