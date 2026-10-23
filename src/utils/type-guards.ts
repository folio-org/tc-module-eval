/**
 * Shared type guard utilities for dependency validation
 */

import { Dependency } from '../types';

/**
 * Type guard to check if a value is a non-empty string
 * @param value - The value to check
 * @returns true if the value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Type guard to check if a dependency object is valid
 * @param dep - The dependency object to validate
 * @returns true if the dependency has valid name and version
 */
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
