// Evaluated repositories are open source, so their content, command output and agent output are reported as
// they are. Only the evaluator's own credentials, the values of the variables it uses for remote lookups,
// agent review and the runtime UI probe, and the keys in a trusted OpenCode auth store, are masked.
const SECRET_ENV_NAMES = new Set(['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'SONAR_TOKEN', 'GITHUB_TOKEN', 'FOLIO_UI_USERNAME', 'FOLIO_UI_PASSWORD']);
// Masking a short value such as "1" or "true" would rewrite ordinary text without protecting anything.
const MIN_SECRET_LENGTH = 8;

interface EvaluatorSecret {
  name: string;
  value: string;
}

const SECRET_VALUES = new Map<string, string>();

/** Masks the values of further variables, such as those passed to OpenCode for provider or proxy access. */
export function addEvaluatorSecretEnvNames(names: string[]): void {
  names.forEach(name => SECRET_ENV_NAMES.add(name));
}

/** Masks credentials that are not held in variables, such as the keys in an OpenCode auth store, as [REDACTED_<name>]. */
export function addEvaluatorSecretValues(name: string, values: string[]): void {
  values.forEach(value => SECRET_VALUES.set(value, name));
}

function evaluatorSecrets(): EvaluatorSecret[] {
  return [...SECRET_ENV_NAMES]
    .map(name => ({ name, value: process.env[name] ?? '' }))
    .concat([...SECRET_VALUES].map(([value, name]) => ({ name, value })))
    .filter(secret => secret.value.length >= MIN_SECRET_LENGTH)
    // Longest first, so a secret that contains another is masked whole.
    .sort((left, right) => right.value.length - left.value.length);
}

function mask(text: string, secrets: EvaluatorSecret[]): string {
  return secrets.reduce((masked, { name, value }) => masked.split(value).join(`[REDACTED_${name}]`), text);
}

/**
 * Replaces each current value of the evaluator's secret variables with [REDACTED_<NAME>], then fits the text in
 * maxBytes. Pass inputCut when the text has already lost its end, so a secret's start left there is dropped too.
 */
export function redactEvaluatorSecrets(input: string, maxBytes?: number, inputCut = false): string {
  const secrets = evaluatorSecrets();
  // Whole secrets first: a whole secret at the cut can end with the start of another.
  const masked = mask(input, secrets);
  const kept = inputCut ? withoutTrailingSecretStart(masked, secrets) : masked;
  return maxBytes === undefined ? kept : truncateToByteBudget(kept, maxBytes);
}

/** Masks every string, including object keys, in a report value. */
export function redactEvaluatorSecretsInValue<T>(value: T): T {
  const secrets = evaluatorSecrets();
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return mask(item, secrets);
    if (item instanceof Date) return item;
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [mask(key, secrets), walk(entry)]));
    }
    return item;
  };
  return (secrets.length ? walk(value) : value) as T;
}

function withoutTrailingSecretStart(text: string, secrets: EvaluatorSecret[]): string {
  // A byte cut inside a multi-byte character decodes to a trailing replacement character.
  const decoded = text.replace(/\uFFFD$/, '');
  let cut = 0;
  for (const { value } of secrets) {
    for (let length = Math.min(value.length - 1, decoded.length); length > cut; length--) {
      if (decoded.endsWith(value.slice(0, length))) {
        cut = length;
        break;
      }
    }
  }
  return decoded.slice(0, decoded.length - cut);
}

export function truncateToByteBudget(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) {
    return text;
  }

  const truncated = buffer.subarray(0, maxBytes).toString('utf-8').replace(/\uFFFD$/, '');
  return `${truncated}\n[output truncated to ${maxBytes} bytes]`;
}
