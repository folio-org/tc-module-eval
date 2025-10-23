/**
 * Dependency extraction orchestration utilities
 *
 * Coordinates dependency extraction across different build tools and languages.
 * Dispatches to appropriate parsers (Maven, Gradle, npm, etc.) based on project type
 * and aggregates results with deduplication.
 *
 * SECURITY WARNING: This module executes build commands via parsers on untrusted repositories.
 * Ensure proper sandboxing and consider security implications in production use.
 */

import * as fs from 'fs';
import { Dependency, DependencyExtractionResult, DependencyExtractionError } from '../types';
import { getMavenDependencies, hasMavenProject } from './parsers/maven-dependency-parser';
import { getGradleDependencies, hasGradleProject } from './parsers/gradle-dependency-parser';

/**
 * Type guard to check if a value is a non-empty string
 * @param value - Value to check
 * @returns True if value is a non-empty string
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Type guard to check if a dependency object is valid
 * @param dep - Dependency object to validate
 * @returns True if dependency has required fields
 */
function isValidDependency(dep: Partial<Dependency>): dep is Dependency {
  return isNonEmptyString(dep.name) && isNonEmptyString(dep.version);
}

/**
 * Remove duplicate dependencies based on name and version
 * @param dependencies - Array of dependencies to deduplicate
 * @returns Array of unique dependencies
 */
function deduplicateDependencies(dependencies: Dependency[]): Dependency[] {
  if (!Array.isArray(dependencies)) {
    return [];
  }

  const uniqueMap = new Map<string, Dependency>();

  for (const dep of dependencies) {
    if (!isValidDependency(dep)) {
      continue;
    }

    const key = `${dep.name}:${dep.version}`;

    // If we haven't seen this dependency before, or if the current one has license info and the stored one doesn't
    if (!uniqueMap.has(key) ||
        (!uniqueMap.get(key)?.licenses?.length && dep.licenses?.length)) {
      uniqueMap.set(key, dep);
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Extract dependencies from a repository using available build tools
 *
 * Automatically detects project type and dispatches to appropriate parsers:
 * - Maven projects (pom.xml)
 * - Gradle projects (build.gradle, build.gradle.kts)
 * - Future: npm (package.json), Go (go.mod), etc.
 *
 * @param repoPath - Path to the cloned repository
 * @returns Promise resolving to extraction result with dependencies and errors
 */
export async function getDependencies(repoPath: string): Promise<DependencyExtractionResult> {
  const dependencies: Dependency[] = [];
  const errors: DependencyExtractionError[] = [];
  const warnings: DependencyExtractionError[] = [];

  if (!isNonEmptyString(repoPath)) {
    errors.push({
      source: 'dependency-orchestrator',
      message: 'Repository path must be a non-empty string',
      error: new Error('Invalid path parameter')
    });
    return { dependencies: [], errors, warnings };
  }

  try {
    // Check if path exists
    if (!fs.existsSync(repoPath)) {
      warnings.push({
        source: 'dependency-orchestrator',
        message: `Repository path does not exist: ${repoPath}`
      });
      return { dependencies: [], errors, warnings };
    }

    // Check for Maven and Gradle projects once
    const hasMaven = await hasMavenProject(repoPath);
    const hasGradle = await hasGradleProject(repoPath);

    if (hasMaven) {
      const mavenResult = await getMavenDependencies(repoPath);
      dependencies.push(...mavenResult.dependencies.filter(isValidDependency));
      errors.push(...mavenResult.errors);
      warnings.push(...mavenResult.warnings);
    }

    if (hasGradle) {
      const gradleResult = await getGradleDependencies(repoPath);
      dependencies.push(...gradleResult.dependencies.filter(isValidDependency));
      errors.push(...gradleResult.errors);
      warnings.push(...gradleResult.warnings);
    }

    // If no build tools found, add a warning
    if (dependencies.length === 0 && errors.length === 0 && !hasMaven && !hasGradle) {
      warnings.push({
        source: 'dependency-orchestrator',
        message: 'No supported build tools found (Maven, Gradle). Future support: npm, Go, Rust.'
      });
    }

    // Future: Add more parsers here
    // - npm/yarn (package.json)
    // - Go (go.mod)
    // - Rust (Cargo.toml)
    // etc.

    // Remove duplicates based on name and version
    const uniqueDependencies = deduplicateDependencies(dependencies);
    return { dependencies: uniqueDependencies, errors, warnings };

  } catch (error) {
    errors.push({
      source: 'dependency-orchestrator',
      message: `Error extracting dependencies from ${repoPath}`,
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
