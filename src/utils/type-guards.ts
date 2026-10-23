import { Dependency } from '../types';

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidDependency(dep: Partial<Dependency>): dep is Dependency {
  return isNonEmptyString(dep.name) && isNonEmptyString(dep.version);
}

/** The message of a caught value: an Error's message, or the value as a string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A non-null object that is not an array, such as a parsed JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
