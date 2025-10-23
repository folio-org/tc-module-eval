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
 * - Command timeout enforcement (60 seconds)
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
import { Dependency, DependencyExtractionResult, DependencyExtractionError } from '../../types';
import { normalizeLicenseName } from '../license-policy';
import { isNonEmptyString, isValidDependency } from '../type-guards';

const execAsync = promisify(exec);

// Maven-specific constants
const COMMAND_TIMEOUT = 60000; // 60 seconds
const MAVEN_THIRD_PARTY_PATH = path.join('target', 'licenses', 'THIRD-PARTY.txt');
const MAVEN_DEPENDENCIES_PATH = path.join('target', 'dependencies.txt');

// Maven-specific regex patterns
const MAVEN_DEPENDENCY_PATTERN = /\[INFO\]\s+(.+?):(.+?):(.+?):(.+?):(.+)/;
const MAVEN_COORDINATE_PATTERN = /^(.+?):(.+?):(.+?)$/;

// Maven build file patterns
const MAVEN_BUILD_FILES = ['pom.xml'];

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
          console.warn(`License normalization failed for "${l}", using original value.`);
        }
        return normalized || l; // Use original if normalization returns empty
      });
  }

  // Single license - normalize and return
  const normalized = normalizeLicenseName(license);
  if (!normalized) {
    console.warn(`License normalization failed for "${license}", using original value.`);
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
    // Execute Maven license plugin to generate third-party report
    const { stdout } = await execAsync(
      'mvn license:add-third-party -Dlicense.outputDirectory=target/licenses -Dlicense.includeTransitiveDependencies=false',
      {
        cwd: validatedPath,
        timeout: COMMAND_TIMEOUT
      }
    );

    console.log('Maven license plugin output:', stdout);

    // Parse the generated THIRD-PARTY.txt file
    const thirdPartyFile = path.join(validatedPath, MAVEN_THIRD_PARTY_PATH);
    const thirdPartyContent = safeReadFile(thirdPartyFile);

    if (thirdPartyContent) {
      const dependencies = parseMavenThirdPartyFile(thirdPartyContent);
      return { dependencies, errors, warnings };
    }

    // Fallback: try to parse dependency:list output
    warnings.push({
      source: 'maven-parser',
      message: 'Maven license plugin did not generate THIRD-PARTY.txt, falling back to dependency:list'
    });

    const { stdout: depsOutput } = await execAsync(
      `mvn dependency:list -DoutputFile=${MAVEN_DEPENDENCIES_PATH}`,
      { cwd: validatedPath, timeout: COMMAND_TIMEOUT }
    );

    const dependencies = parseMavenDependencyList(depsOutput);
    return { dependencies, errors, warnings };

  } catch (error) {
    errors.push({
      source: 'maven-parser',
      message: 'Failed to extract Maven dependencies',
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
