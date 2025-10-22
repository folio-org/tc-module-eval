/**
 * Gradle-specific dependency parsing utilities
 *
 * Handles extraction of third-party dependencies from Gradle projects including:
 * - Gradle license report plugin output (JSON format)
 * - Gradle dependencies task output
 * - Gradle coordinate parsing
 *
 * PARSER CONTRACT IMPLEMENTATION:
 * This parser fulfills the license-compliance.ts contract by:
 * 1. Extracting licenses as arrays from JSON license reports
 * 2. Returning licenses as string arrays in Dependency objects
 * 3. No splitting needed - Gradle license reports already provide arrays
 *
 * NOTE: If Gradle license reports contain SPDX expressions with " OR " or " AND ",
 * this parser would need to split them. Currently assumes licenses are already split.
 *
 * SECURITY WARNING: This module executes Gradle build commands on untrusted repositories.
 * Security measures implemented:
 * - Path validation and sanitization via validateRepoPath()
 * - Directory traversal attack prevention through path.resolve()
 * - Command timeout enforcement (60 seconds)
 * - Repository path is validated before command execution
 *
 * Remaining risks:
 * - Malicious build.gradle files can execute arbitrary Groovy/Kotlin code
 * - Build scripts in the repository run with the permissions of the evaluator process
 * - Network access during Gradle dependency resolution
 * - Gradle wrapper scripts (gradlew) may contain malicious code
 *
 * Production deployment should use containerization, sandboxing, or isolated environments.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { Dependency, DependencyExtractionResult, DependencyExtractionError } from '../../types';

const execAsync = promisify(exec);

// Gradle-specific constants
const COMMAND_TIMEOUT = 60000; // 60 seconds
const GRADLE_LICENSE_REPORT_PATH = path.join('build', 'reports', 'dependency-license', 'index.json');

// Gradle-specific regex patterns
const GRADLE_DEPENDENCY_PATTERN = /[+\\-]+\s*(.+?):(.+?):(.+?)(\s|$)/;

// Gradle build file patterns
const GRADLE_BUILD_FILES = ['build.gradle', 'build.gradle.kts'];

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
 * Safely read file contents
 * @param filePath - Path to file
 * @returns File contents or null if file doesn't exist or can't be read
 */
function safeReadFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.warn(`Failed to read file ${filePath}:`, error);
    return null;
  }
}

/**
 * Validate and sanitize a repository path before executing shell commands
 * SECURITY: Prevents directory traversal and validates path integrity
 * @param repoPath - Path to validate
 * @returns Validated absolute path or null if invalid
 */
function validateRepoPath(repoPath: string): string | null {
  try {
    // Check for non-empty string
    if (!isNonEmptyString(repoPath)) {
      console.warn('Repository path is empty or invalid');
      return null;
    }

    // Resolve to absolute path (prevents directory traversal attacks)
    const absolutePath = path.resolve(repoPath);

    // Verify path exists
    if (!fs.existsSync(absolutePath)) {
      console.warn(`Repository path does not exist: ${absolutePath}`);
      return null;
    }

    // Verify it's a directory
    const stats = fs.statSync(absolutePath);
    if (!stats.isDirectory()) {
      console.warn(`Repository path is not a directory: ${absolutePath}`);
      return null;
    }

    return absolutePath;
  } catch (error) {
    console.warn(`Failed to validate repository path ${repoPath}:`, error);
    return null;
  }
}

/**
 * Parse a single dependency from Gradle license report
 * @param dep - Dependency object from license report
 * @returns Parsed dependency or null if invalid
 */
function parseGradleLicenseReportDependency(dep: any): Dependency | null {
  if (!dep || typeof dep !== 'object') {
    return null;
  }

  const name = dep.moduleName || (dep.group && dep.name ? `${dep.group}:${dep.name}` : null);
  const version = dep.version;

  if (!isNonEmptyString(name) || !isNonEmptyString(version)) {
    return null;
  }

  const licenses = Array.isArray(dep.licenses)
    ? dep.licenses.map((l: any) => l?.name || l?.license).filter(isNonEmptyString)
    : [];

  return {
    name: name.trim(),
    version: version.trim(),
    licenses
  };
}

/**
 * Parse Gradle license report JSON format
 * @param content - JSON content from Gradle license report
 * @returns Array of parsed dependencies with license information
 */
function parseGradleLicenseReport(content: string): Dependency[] {
  if (!isNonEmptyString(content)) {
    return [];
  }

  try {
    const report = JSON.parse(content);
    const dependencies: Dependency[] = [];

    if (report?.dependencies && Array.isArray(report.dependencies)) {
      for (const dep of report.dependencies) {
        const dependency = parseGradleLicenseReportDependency(dep);
        if (dependency && isValidDependency(dependency)) {
          dependencies.push(dependency);
        }
      }
    }

    return dependencies;
  } catch (error) {
    console.warn('Failed to parse Gradle license report:', error);
    return [];
  }
}

/**
 * Parse Gradle dependencies output
 * @param output - Output from gradle dependencies command
 * @returns Array of parsed dependencies (without license information)
 */
function parseGradleDependencies(output: string): Dependency[] {
  if (!isNonEmptyString(output)) {
    return [];
  }

  const dependencies: Dependency[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Look for dependency lines like: "+--- org.apache.commons:commons-lang3:3.12.0"
    const match = line.match(GRADLE_DEPENDENCY_PATTERN);
    if (match && match.length >= 4) {
      const [, groupId, artifactId, version] = match;

      if (isNonEmptyString(groupId) && isNonEmptyString(artifactId) && isNonEmptyString(version)) {
        const dependency: Dependency = {
          name: `${groupId.trim()}:${artifactId.trim()}`,
          version: version.trim(),
          licenses: undefined // License info not available from dependencies task
        };

        if (isValidDependency(dependency)) {
          dependencies.push(dependency);
        }
      }
    }
  }

  return dependencies;
}

/**
 * Check if a Gradle project exists in the repository
 * @param repoPath - Path to repository
 * @returns Promise resolving to true if Gradle project exists
 */
export async function hasGradleProject(repoPath: string): Promise<boolean> {
  if (!isNonEmptyString(repoPath)) {
    return false;
  }
  return GRADLE_BUILD_FILES.some(file => fs.existsSync(path.join(repoPath, file)));
}

/**
 * Extract dependencies from Gradle project using license plugin
 * @param repoPath - Path to Gradle project
 * @returns Promise resolving to extraction result with dependencies and errors
 */
export async function getGradleDependencies(repoPath: string): Promise<DependencyExtractionResult> {
  const errors: DependencyExtractionError[] = [];
  const warnings: DependencyExtractionError[] = [];

  // SECURITY: Validate and sanitize repository path before executing commands
  const validatedPath = validateRepoPath(repoPath);
  if (!validatedPath) {
    errors.push({
      source: 'gradle-parser',
      message: `Invalid repository path: ${repoPath}`,
      error: new Error('Path validation failed')
    });
    return { dependencies: [], errors, warnings };
  }

  try {
    // Try to use Gradle license report plugin if available
    const { stdout } = await execAsync(
      './gradlew generateLicenseReport || gradle generateLicenseReport',
      {
        cwd: validatedPath,
        timeout: COMMAND_TIMEOUT
      }
    );

    console.log('Gradle license plugin output:', stdout);

    // Look for generated license report
    const licenseReport = path.join(validatedPath, GRADLE_LICENSE_REPORT_PATH);
    const licenseContent = safeReadFile(licenseReport);

    if (licenseContent) {
      const dependencies = parseGradleLicenseReport(licenseContent);
      return { dependencies, errors, warnings };
    }

    // Fallback: use dependencies task
    warnings.push({
      source: 'gradle-parser',
      message: 'Gradle license plugin did not generate license report, falling back to dependencies task'
    });

    const { stdout: depsOutput } = await execAsync(
      './gradlew dependencies --configuration runtimeClasspath || gradle dependencies',
      { cwd: validatedPath, timeout: COMMAND_TIMEOUT }
    );

    const dependencies = parseGradleDependencies(depsOutput);
    return { dependencies, errors, warnings };

  } catch (error) {
    errors.push({
      source: 'gradle-parser',
      message: 'Failed to extract Gradle dependencies',
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
