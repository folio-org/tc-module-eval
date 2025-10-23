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
