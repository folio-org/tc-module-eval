/**
 * Gradle-specific dependency parsing utilities
 *
 * Handles extraction of third-party dependencies from Gradle projects including:
 * - Gradle license report plugin output (JSON format)
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

import * as fs from 'fs';
import * as path from 'path';
import { CommandRunner, Dependency, DependencyExtractionResult, DependencyExtractionError, EvaluationRun } from '../../types';
import { isNonEmptyString, isValidDependency } from '../type-guards';
import { safeReadFile, validateRepoPath } from './common';
import { getLogger } from '../logger';
import { defaultCommandRunner } from '../command-runner';
import { GRADLE_NETWORK_POLICY } from '../build-tool-policies';

// Gradle-specific constants
const COMMAND_TIMEOUT = 60000; // 60 seconds
const GRADLE_LICENSE_REPORT_PATH = path.join('build', 'reports', 'dependency-license', 'index.json');

// Gradle build file patterns
const GRADLE_BUILD_FILES = ['build.gradle', 'build.gradle.kts'];

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
    getLogger().warn('Failed to parse Gradle license report:', error);
    return [];
  }
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

function getGradleCommand(repoPath: string): { command: string; argsPrefix: string[] } {
  const wrapper = path.join(repoPath, 'gradlew');
  if (fs.existsSync(wrapper)) {
    return { command: wrapper, argsPrefix: [] };
  }
  return { command: 'gradle', argsPrefix: [] };
}

/**
 * Extract dependencies from Gradle project using license plugin
 * @param repoPath - Path to Gradle project
 * @returns Promise resolving to extraction result with dependencies and errors
 */
export async function getGradleDependencies(
  repoPath: string,
  evaluationRun?: EvaluationRun,
  commandRunner: CommandRunner = evaluationRun?.commandRunner ?? defaultCommandRunner
): Promise<DependencyExtractionResult> {
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
    const gradle = getGradleCommand(validatedPath);
    const licenseCommand = await commandRunner.run({
      command: gradle.command,
      args: [...gradle.argsPrefix, 'generateLicenseReport'],
      cwd: validatedPath,
      timeoutMs: COMMAND_TIMEOUT,
      requiresIsolation: true,
      networkPolicy: GRADLE_NETWORK_POLICY
    }, evaluationRun);

    getLogger().info('Gradle license plugin output:', licenseCommand.stdout);

    if (licenseCommand.status !== 'success') {
      errors.push({
        source: 'gradle-parser',
        message: `Failed to generate Gradle license report: ${licenseCommand.errorMessage ?? licenseCommand.status}`,
        error: new Error(licenseCommand.stderr || licenseCommand.errorMessage || licenseCommand.status)
      });
      return { dependencies: [], errors, warnings };
    }

    // Look for generated license report
    const licenseReport = path.join(validatedPath, GRADLE_LICENSE_REPORT_PATH);
    const licenseContent = safeReadFile(licenseReport);

    if (licenseContent) {
      const dependencies = parseGradleLicenseReport(licenseContent);
      return { dependencies, errors, warnings };
    }

    errors.push({
      source: 'gradle-parser',
      message: `Gradle license plugin did not generate ${GRADLE_LICENSE_REPORT_PATH}; dependency evidence unavailable`,
      error: new Error('Gradle license report missing')
    });
    return { dependencies: [], errors, warnings };

  } catch (error) {
    errors.push({
      source: 'gradle-parser',
      message: 'Failed to extract Gradle dependencies',
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
