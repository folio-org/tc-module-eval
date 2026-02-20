/**
 * Maven-specific dependency parsing utilities
 *
 * Handles extraction of third-party dependencies from Maven projects including:
 * - Maven license plugin output (THIRD-PARTY.txt)
 * - Maven dependency:list command output
 * - Maven coordinate parsing
 * - Maven-specific dual license format (pipe-separated: "Apache-2.0|MIT")
 *
 * PARSER CONTRACT IMPLEMENTATION:
 * This parser fulfills the license-compliance.ts contract by:
 * 1. Splitting pipe-separated licenses ("Apache-2.0|MIT") into ["Apache-2.0", "MIT"]
 * 2. Normalizing license names via license-policy.normalizeLicenseName()
 * 3. Returning licenses as string arrays in Dependency objects
 *
 * Maven uses the pipe character '|' to separate dual/multi-licenses in THIRD-PARTY.txt.
 * The splitDualLicenses() function handles this Maven-specific format.
 *
 * SECURITY WARNING: This module executes Maven build commands on untrusted repositories.
 * Security measures implemented:
 * - Path validation and sanitization via validateRepoPath()
 * - Directory traversal attack prevention through path.resolve()
 * - Command timeout enforcement (300 seconds / 5 minutes)
 * - Repository path is validated before command execution
 *
 * Remaining risks:
 * - Malicious pom.xml files can execute arbitrary code via Maven plugins
 * - Build scripts in the repository run with the permissions of the evaluator process
 * - Network access during Maven dependency resolution
 *
 * Production deployment should use containerization, sandboxing, or isolated environments.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import { Dependency, DependencyExtractionResult, DependencyExtractionError } from '../../types';
import { normalizeLicenseName } from '../license-policy';
import { isNonEmptyString, isValidDependency } from '../type-guards';
import { safeReadFile, validateRepoPath } from './common';
import { getLogger } from '../logger';

const execAsync = promisify(exec);

// Maven-specific constants
const COMMAND_TIMEOUT = 300000; // 300 seconds (5 minutes)
const MAX_BUFFER = 50 * 1024 * 1024; // 50MB for Maven verbose output
const MAVEN_THIRD_PARTY_PATH = path.join('target', 'licenses', 'THIRD-PARTY.txt');
const MAVEN_DEPENDENCIES_PATH = path.join('target', 'dependencies.txt');

// Maven-specific regex patterns
const MAVEN_DEPENDENCY_PATTERN = /\[INFO\]\s+(.+?):(.+?):(.+?):(.+?):(.+)/;
const MAVEN_COORDINATE_PATTERN = /^(.+?):(.+?):(.+?)$/;

// Maven build file patterns
const MAVEN_BUILD_FILES = ['pom.xml'];

// Valid Maven packaging types
const VALID_PACKAGING_TYPES = ['pom', 'jar', 'war', 'ear', 'maven-plugin', 'ejb', 'rar', 'bundle'];

/**
 * Determine the Maven packaging type from pom.xml using proper XML parsing
 * @param repoPath - Path to Maven project
 * @returns Promise resolving to packaging type ('pom', 'jar', 'war', etc.) or 'jar' as default
 */
async function getMavenPackaging(repoPath: string): Promise<string> {
  try {
    const pomPath = path.join(repoPath, 'pom.xml');
    if (!fs.existsSync(pomPath)) {
      getLogger().warn('pom.xml not found, defaulting to jar packaging');
      return 'jar';
    }

    const pomContent = fs.readFileSync(pomPath, 'utf-8');

    // Parse XML using xml2js for robust handling of XML variations
    const parsed = await parseStringPromise(pomContent, {
      trim: true,
      explicitArray: true,
      mergeAttrs: false
    });

    // Extract packaging from parsed XML
    // Structure: parsed.project.packaging[0]
    const packaging = parsed?.project?.packaging?.[0];

    if (packaging && isNonEmptyString(packaging)) {
      const trimmedPackaging = packaging.trim();

      // Validate against known packaging types
      if (!VALID_PACKAGING_TYPES.includes(trimmedPackaging)) {
        getLogger().warn(`Unknown Maven packaging type: ${trimmedPackaging}, defaulting to jar`);
        return 'jar';
      }

      getLogger().info(`Detected Maven packaging type: ${trimmedPackaging}`);
      return trimmedPackaging;
    }

    // Maven defaults to 'jar' when packaging is not specified
    getLogger().info('No packaging specified in pom.xml, defaulting to jar');
    return 'jar';
  } catch (error) {
    getLogger().warn('Failed to parse pom.xml packaging, defaulting to jar:', error);
    return 'jar';
  }
}

/**
 * Split a Maven license string that may contain multiple licenses separated by pipe character
 * This is Maven-specific format for dual licensing: "Apache-2.0|MIT"
 * Also normalizes each individual license
 * @param license - License string that may contain pipe-separated licenses
 * @returns Array of normalized individual licenses
 */
function splitDualLicenses(license: string): string[] {
  if (!isNonEmptyString(license)) {
    return [];
  }

  // Check if license contains pipe separator
  if (license.includes('|')) {
    // Split on pipe and normalize each license
    return license
      .split('|')
      .map(l => l.trim())
      .filter(isNonEmptyString)
      .map(l => {
        const normalized = normalizeLicenseName(l);
        if (!normalized) {
          getLogger().warn(`License normalization failed for "${l}", using original value.`);
        }
        return normalized || l; // Use original if normalization returns empty
      });
  }

  // Single license - normalize and return
  const normalized = normalizeLicenseName(license);
  if (!normalized) {
    getLogger().warn(`License normalization failed for "${license}", using original value.`);
  }
  return [normalized || license];
}

/**
 * Parse Maven coordinates (groupId:artifactId:version)
 * @param coordinates - Coordinate string to parse
 * @returns Parsed coordinate parts or null if invalid
 */
function parseMavenCoordinates(coordinates: string): { groupId: string; artifactId: string; version: string } | null {
  if (!isNonEmptyString(coordinates)) {
    return null;
  }

  const match = coordinates.match(MAVEN_COORDINATE_PATTERN);
  if (!match || match.length < 4) {
    return null;
  }

  const [, groupId, artifactId, version] = match;
  if (!isNonEmptyString(groupId) || !isNonEmptyString(artifactId) || !isNonEmptyString(version)) {
    return null;
  }

  return { groupId: groupId.trim(), artifactId: artifactId.trim(), version: version.trim() };
}

/**
 * Parse a single line from Maven THIRD-PARTY.txt file
 * @param line - Line to parse
 * @returns Parsed dependency or null if invalid
 */
function parseMavenThirdPartyLine(line: string): Dependency | null {
  const trimmedLine = line.trim();

  // Skip empty lines and headers
  if (!trimmedLine || trimmedLine.startsWith('Lists of') || !trimmedLine.startsWith('(')) {
    return null;
  }

  // Parse format: (License Name) Artifact Name (groupId:artifactId:version - URL)
  const licenseEnd = trimmedLine.indexOf(')');
  if (licenseEnd === -1) {
    return null;
  }

  const licenseName = trimmedLine.substring(1, licenseEnd).trim();
  if (!isNonEmptyString(licenseName)) {
    return null;
  }

  const remaining = trimmedLine.substring(licenseEnd + 1).trim();

  // Find the coordinates in parentheses
  const coordStart = remaining.indexOf('(');
  const coordEnd = remaining.indexOf(')');

  if (coordStart === -1 || coordEnd === -1) {
    return null;
  }

  const coordPart = remaining.substring(coordStart + 1, coordEnd);

  // Split coordinates and URL
  const parts = coordPart.split(' - ');
  const coordinates = parts[0]?.trim();

  if (!isNonEmptyString(coordinates)) {
    return null;
  }

  // Parse coordinates using helper function
  const parsed = parseMavenCoordinates(coordinates);
  if (!parsed) {
    return null;
  }

  const depName = `${parsed.groupId}:${parsed.artifactId}`;

  // Split and normalize dual licenses using centralized function
  // Example: "Apache-2.0|MIT" becomes ["Apache-2.0", "MIT"]
  const licenses = splitDualLicenses(licenseName);

  return {
    name: depName,
    version: parsed.version,
    licenses
  };
}

/**
 * Parse Maven THIRD-PARTY.txt file format
 * Expected format: (License Name) Artifact Name (groupId:artifactId:version - URL)
 * @param content - Content of the THIRD-PARTY.txt file
 * @returns Array of parsed dependencies
 */
function parseMavenThirdPartyFile(content: string): Dependency[] {
  if (!isNonEmptyString(content)) {
    return [];
  }

  const dependencies: Dependency[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const dependency = parseMavenThirdPartyLine(line);
    if (dependency && isValidDependency(dependency)) {
      dependencies.push(dependency);
    }
  }

  return dependencies;
}

/**
 * Check if an error is caused by command timeout
 * @param error - Error object to check
 * @returns True if error was caused by timeout
 */
function isTimeoutError(error: any): boolean {
  return error.killed === true ||
         error.signal === 'SIGTERM' ||
         (error.message && error.message.toLowerCase().includes('timeout'));
}

/**
 * Check if an error is caused by maxBuffer overflow
 * @param error - Error object to check
 * @returns True if error was caused by buffer overflow
 */
function isMaxBufferError(error: any): boolean {
  return error.message && error.message.toLowerCase().includes('maxbuffer');
}

/**
 * Parse Maven dependency:list output
 * @param output - Output from mvn dependency:list command
 * @returns Array of parsed dependencies (without license information)
 */
function parseMavenDependencyList(output: string): Dependency[] {
  if (!isNonEmptyString(output)) {
    return [];
  }

  const dependencies: Dependency[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Look for dependency lines like: "[INFO]    org.apache.commons:commons-lang3:jar:3.12.0:compile"
    const match = line.match(MAVEN_DEPENDENCY_PATTERN);
    if (match && match.length >= 5) {
      const [, groupId, artifactId, , version] = match;

      if (isNonEmptyString(groupId) && isNonEmptyString(artifactId) && isNonEmptyString(version)) {
        const dependency: Dependency = {
          name: `${groupId.trim()}:${artifactId.trim()}`,
          version: version.trim(),
          licenses: undefined // License info not available from dependency:list
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
 * Check if a Maven project exists in the repository
 * @param repoPath - Path to repository
 * @returns Promise resolving to true if Maven project exists
 */
export async function hasMavenProject(repoPath: string): Promise<boolean> {
  if (!isNonEmptyString(repoPath)) {
    return false;
  }
  return MAVEN_BUILD_FILES.some(file => fs.existsSync(path.join(repoPath, file)));
}

/**
 * Extract dependencies from Maven project using license plugin
 * @param repoPath - Path to Maven project
 * @returns Promise resolving to extraction result with dependencies and errors
 */
export async function getMavenDependencies(repoPath: string): Promise<DependencyExtractionResult> {
  const errors: DependencyExtractionError[] = [];
  const warnings: DependencyExtractionError[] = [];

  // SECURITY: Validate and sanitize repository path before executing commands
  const validatedPath = validateRepoPath(repoPath);
  if (!validatedPath) {
    errors.push({
      source: 'maven-parser',
      message: `Invalid repository path: ${repoPath}`,
      error: new Error('Path validation failed')
    });
    return { dependencies: [], errors, warnings };
  }

  try {
    // Determine packaging type to use correct Maven goal
    const packaging = await getMavenPackaging(validatedPath);

    // Choose appropriate goal based on packaging:
    // - 'pom' packaging: use aggregate-add-third-party (for parent POMs in multi-module projects)
    // - Other packaging ('jar', 'war', etc.): use add-third-party (for regular modules)
    const mavenGoal = packaging === 'pom'
      ? 'license:aggregate-add-third-party'
      : 'license:add-third-party';

    getLogger().info(`Using Maven goal: ${mavenGoal} (packaging: ${packaging})`);

    // Execute Maven license plugin to generate third-party report
    const { stdout } = await execAsync(
      `mvn ${mavenGoal} -Dlicense.outputDirectory=target/licenses -Dlicense.includeTransitiveDependencies=true`,
      {
        cwd: validatedPath,
        timeout: COMMAND_TIMEOUT,
        maxBuffer: MAX_BUFFER
      }
    );

    getLogger().info('Maven license plugin output:', stdout);

    // Parse the generated THIRD-PARTY.txt file
    const thirdPartyFile = path.join(validatedPath, MAVEN_THIRD_PARTY_PATH);
    const thirdPartyContent = safeReadFile(thirdPartyFile);

    if (thirdPartyContent) {
      const dependencies = parseMavenThirdPartyFile(thirdPartyContent);
      return { dependencies, errors, warnings };
    }

    // THIRD-PARTY.txt was not generated despite successful Maven execution
    // This is typically not an error - it just means there are no third-party dependencies
    getLogger().warn('Maven license plugin did not generate THIRD-PARTY.txt file');
    getLogger().warn(`Expected file location: ${thirdPartyFile}`);
    getLogger().warn('This may indicate: no third-party dependencies, or all dependencies are first-party');

    warnings.push({
      source: 'maven-parser',
      message: 'Maven license plugin did not generate THIRD-PARTY.txt file. ' +
               'This typically means the project has no third-party dependencies. ' +
               `Expected location: ${MAVEN_THIRD_PARTY_PATH}`
    });

    return { dependencies: [], errors, warnings };

  } catch (error) {
    // Check if this is a maxBuffer error
    if (isMaxBufferError(error)) {
      const bufferSizeMB = MAX_BUFFER / (1024 * 1024);
      const bufferMessage =
        `Maven build output exceeded buffer size (${bufferSizeMB}MB). This indicates:\n` +
        `- Very large project with extensive dependency tree\n` +
        `- Highly verbose Maven output during dependency downloads\n` +
        `Note: The build may have completed successfully, but output was truncated. ` +
        `Check the generated THIRD-PARTY.txt file manually if needed.`;

      getLogger().error('Maven dependency extraction exceeded buffer:');
      getLogger().error(`  Buffer size: ${bufferSizeMB}MB`);

      errors.push({
        source: 'maven-parser',
        message: bufferMessage,
        error: error instanceof Error ? error : new Error(String(error))
      });
      return { dependencies: [], errors, warnings };
    }

    // Check if this is a timeout error
    if (isTimeoutError(error)) {
      const timeoutMinutes = COMMAND_TIMEOUT / 60000;
      const timeoutMessage =
        `Maven build timed out after ${timeoutMinutes} minutes. This usually indicates:\n` +
        `- Large project with many dependencies requiring longer build time\n` +
        `- Slow network connection for dependency downloads\n` +
        `- Maven repository connectivity issues\n` +
        `Suggestion: The timeout is currently set to ${timeoutMinutes} minutes. ` +
        `Consider reviewing project size, network connectivity, or Maven repository configuration.`;

      getLogger().error('Maven dependency extraction timed out:');
      getLogger().error(`  Timeout: ${timeoutMinutes} minutes`);

      errors.push({
        source: 'maven-parser',
        message: timeoutMessage,
        error: error instanceof Error ? error : new Error(String(error))
      });
      return { dependencies: [], errors, warnings };
    }

    // Non-timeout error - provide detailed error information
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    // Extract stdout and stderr from execAsync error
    const execError = error as any; // execAsync errors have stdout/stderr properties
    const stdout = execError.stdout || '';
    const stderr = execError.stderr || '';

    getLogger().error('Maven dependency extraction failed:');
    getLogger().error('  Message:', errorMessage);

    if (stdout) {
      getLogger().error('  Maven stdout:', stdout.substring(0, 500)); // Show first 500 chars
    }

    if (stderr) {
      getLogger().error('  Maven stderr:', stderr.substring(0, 500)); // Show first 500 chars
    }

    if (errorStack && !stdout && !stderr) {
      getLogger().error('  Stack:', errorStack);
    }

    // Build detailed error message including Maven output
    let detailedMessage = `Failed to extract Maven dependencies: ${errorMessage}`;
    if (stderr) {
      detailedMessage += `\nMaven stderr: ${stderr.substring(0, 200)}`;
    } else if (stdout) {
      detailedMessage += `\nMaven output: ${stdout.substring(0, 200)}`;
    }

    errors.push({
      source: 'maven-parser',
      message: detailedMessage,
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
