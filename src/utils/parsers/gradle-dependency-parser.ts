/**
 * Gradle-specific dependency parsing utilities
 *
 * Handles extraction of third-party dependencies from Gradle projects. The evaluator applies the
 * jk1 dependency-license-report plugin through an init script (FOLIO projects do not apply it
 * themselves) and parses its JSON report.
 *
 * PARSER CONTRACT IMPLEMENTATION:
 * This parser fulfills the license-compliance.ts contract by:
 * 1. Extracting licenses as arrays from JSON license reports
 * 2. Normalizing license names via license-policy.normalizeLicenseName()
 * 3. Returning licenses as string arrays in Dependency objects
 * 4. No splitting needed - the report lists each license of a module separately
 *
 * NOTE: If Gradle license reports contain SPDX expressions with " OR " or " AND ",
 * this parser would need to split them. Currently assumes licenses are already split.
 *
 * SECURITY WARNING: This module executes Gradle build commands on untrusted repositories.
 * Security measures implemented:
 * - Path validation and sanitization via validateRepoPath()
 * - Command timeout enforcement (5 minutes)
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
import * as os from 'os';
import * as path from 'path';
import { CommandRunner, Dependency, DependencyExtractionResult, DependencyExtractionError, EvaluationRun } from '../../types';
import { isNonEmptyString, isValidDependency } from '../type-guards';
import { commandError, safeReadFile, validateRepoPath } from './common';
import { isWithinRepo } from '../repo-files';
import { isListedLicenseName, normalizeLicenseName } from '../license-policy';
import { getLogger } from '../logger';
import { defaultCommandRunner } from '../command-runner';
import { GRADLE_NETWORK_POLICY } from '../build-tool-policies';

const COMMAND_TIMEOUT = 300000; // 300 seconds (5 minutes), as for Maven: the first run downloads Gradle and all dependencies
const LICENSE_REPORT_DIR_PROPERTY = 'tcModuleEval.licenseReportDir';
// A license name combining several licenses, which normalization would cut down to its first part.
const LICENSE_EXPRESSION = /\||\s(?:OR|AND|WITH)\s/;

const GRADLE_BUILD_FILES = ['build.gradle', 'build.gradle.kts'];

// Where the Gradle build may live: the repository root, or `service/` as in FOLIO's Grails modules
// (mod-agreements, mod-licenses, mod-serials-management).
const GRADLE_PROJECT_DIRS = ['', 'service'];

// The evaluator's Gradle init script. It applies the jk1 license report plugin to the root project
// (whose report covers its subprojects) unless the build applies it already. Init scripts must apply
// plugins by class.
//
// ASF policy covers what the module distributes, so every project's license report is limited to
// the runtime classpath and test configurations are not checked. The root report is written as
// index.json, listing every license of each module and leaving out BOMs (which only manage
// versions), to the evaluator's own directory given by LICENSE_REPORT_DIR_PROPERTY.
//
// Everything is configured in projectsEvaluated, which runs after every project's own afterEvaluate
// callbacks, so it overrides what the build sets, even late. The renderer is loaded through the
// applied plugin's classloader so that it also matches a copy of the plugin the build applies itself.
const LICENSE_REPORT_INIT_SCRIPT = `initscript {
  repositories { gradlePluginPortal() }
  dependencies { classpath 'com.github.jk1:gradle-license-report:3.1.4' }
}

gradle.projectsEvaluated {
  def root = gradle.rootProject
  if (!root.plugins.hasPlugin('com.github.jk1.dependency-license-report')) {
    root.pluginManager.apply(com.github.jk1.license.LicenseReportPlugin)
  }
  root.allprojects { project ->
    project.plugins.withId('com.github.jk1.dependency-license-report') {
      project.licenseReport.configurations = ['runtimeClasspath'] as String[]
    }
  }

  def report = root.licenseReport
  def loader = report.getClass().classLoader
  def renderer = loader.loadClass('com.github.jk1.license.render.JsonReportRenderer')
    .getConstructor(String, boolean).newInstance('index.json', false)
  def renderers = java.lang.reflect.Array.newInstance(loader.loadClass('com.github.jk1.license.render.ReportRenderer'), 1)
  renderers[0] = renderer
  report.renderers = renderers
  report.outputDir = gradle.startParameter.systemPropertiesArgs['${LICENSE_REPORT_DIR_PROPERTY}']
  report.excludeBoms = true
}
`;

/**
 * Runs `command` with the init script and an empty report directory in a fresh private temp
 * directory outside the repository, so concurrent evaluations don't share them, no pre-existing
 * path is written through, and no earlier report can be read. The directory is removed afterwards.
 */
async function withLicenseReportInitScript<T>(command: (initScript: string, reportDir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-module-eval-s003-gradle-'));
  try {
    const initScript = path.join(dir, 'license-report.gradle');
    fs.writeFileSync(initScript, LICENSE_REPORT_INIT_SCRIPT, { encoding: 'utf-8', flag: 'wx' });
    return await command(initScript, path.join(dir, 'report'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Parse a single dependency from the jk1 JSON license report. Each entry has `moduleName` and
 * `moduleVersion`, and either a `moduleLicenses` list (one entry per license) or a single
 * `moduleLicense`, depending on the renderer's onlyOneLicensePerModule setting.
 * @param dep - Dependency object from license report
 * @returns Parsed dependency or null if invalid
 */
function parseGradleLicenseReportDependency(dep: any): Dependency | null {
  if (!dep || typeof dep !== 'object') {
    return null;
  }

  const name = dep.moduleName;
  const version = dep.moduleVersion;

  if (!isNonEmptyString(name) || !isNonEmptyString(version)) {
    return null;
  }

  const licenseNames: unknown[] = Array.isArray(dep.moduleLicenses)
    ? dep.moduleLicenses.map((license: any) => license?.moduleLicense)
    : [dep.moduleLicense];
  // Expressions are kept as reported so the compliance check flags them instead of passing their first license.
  const licenses = [...new Set(licenseNames.filter(isNonEmptyString).map(license => license.trim()).map(license =>
    LICENSE_EXPRESSION.test(license) && !isListedLicenseName(license) ? license : normalizeLicenseName(license)
  ))];

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
 * Check if a Gradle project exists in the repository root or its `service/` folder
 * @param repoPath - Path to repository
 * @returns Promise resolving to true if Gradle project exists
 */
export async function hasGradleProject(repoPath: string): Promise<boolean> {
  return isNonEmptyString(repoPath) && findGradleProjectDir(repoPath) !== undefined;
}

/**
 * Directory holding the Gradle build (the repository root or `service/`), or undefined if there is none.
 * A `service/` symlink that leads outside the repository is ignored.
 */
export function findGradleProjectDir(repoPath: string): string | undefined {
  return GRADLE_PROJECT_DIRS
    .map(dir => path.join(repoPath, dir))
    .find(dir => GRADLE_BUILD_FILES.some(file => fs.existsSync(path.join(dir, file))) && isWithinRepo(repoPath, dir));
}

export function getGradleCommand(repoPath: string): { command: string; argsPrefix: string[] } {
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

  const projectDir = findGradleProjectDir(validatedPath) ?? validatedPath;

  try {
    const gradle = getGradleCommand(projectDir);
    const { licenseCommand, licenseContent } = await withLicenseReportInitScript(async (initScript, reportDir) => {
      const licenseCommand = await commandRunner.run({
        command: gradle.command,
        // The init script registers the root task in projectsEvaluated, which configure-on-demand runs only
        // after selecting tasks. Only the root report (covering all projects) is the evaluator's.
        args: [
          ...gradle.argsPrefix, '--init-script', initScript, `-D${LICENSE_REPORT_DIR_PROPERTY}=${reportDir}`,
          '--no-configure-on-demand', ':generateLicenseReport'
        ],
        cwd: projectDir,
        timeoutMs: COMMAND_TIMEOUT,
        requiresIsolation: true,
        networkPolicy: GRADLE_NETWORK_POLICY
      }, evaluationRun);
      return { licenseCommand, licenseContent: safeReadFile(path.join(reportDir, 'index.json')) };
    });

    getLogger().info('Gradle license plugin output:', licenseCommand.stdout);

    if (licenseCommand.status !== 'success') {
      errors.push(commandError('gradle-parser', 'Gradle', licenseCommand));
      return { dependencies: [], errors, warnings };
    }

    if (licenseContent) {
      const dependencies = parseGradleLicenseReport(licenseContent);
      return { dependencies, errors, warnings };
    }

    errors.push({
      source: 'gradle-parser',
      message: 'Gradle ran but did not write its license report, so the dependencies could not be listed.',
      error: new Error('Gradle license report missing')
    });
    return { dependencies: [], errors, warnings };

  } catch (error) {
    errors.push({
      source: 'gradle-parser',
      message: 'Gradle could not list the dependencies',
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
