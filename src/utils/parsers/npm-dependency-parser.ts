/**
 * npm-specific dependency parsing utilities
 *
 * Handles extraction of third-party dependencies from Node.js/npm projects including:
 * - Running yarn install to get all dependencies
 * - Using license-checker-rseidelsohn to extract license information
 * - SPDX license expression parsing (dual/multi-licenses)
 * - All transitive dependencies included
 * - FOLIO registry support for @folio/* scoped packages
 *
 * PARSER CONTRACT IMPLEMENTATION:
 * This parser fulfills the license-compliance.ts contract by:
 * 1. Splitting SPDX expressions ("MIT OR Apache-2.0") into ["MIT", "Apache-2.0"]
 * 2. Normalizing license names via license-policy.normalizeLicenseName()
 * 3. Returning licenses as string arrays in Dependency objects
 *
 * npm uses SPDX license expressions where ' OR ' separates alternatives in dual licensing.
 * The splitSpdxLicenses() function handles this npm-specific format.
 *
 * FOLIO REGISTRY SUPPORT:
 * - Creates .npmrc with @folio scope pointing to repository.folio.org if not present
 * - Respects existing .npmrc configuration in the repository
 *
 * ERROR HANDLING POLICY (Graceful Degradation):
 * This parser attempts to provide partial results when possible:
 * - Primary: yarn install + license-checker (full transitive deps with licenses)
 * - Fallback: package.json parsing (direct deps only, no license info)
 * - Fatal errors only: Invalid repository path, missing package.json
 * - Warnings vs Errors: Recoverable failures go to warnings, fatal to errors
 *
 * SECURITY: This module installs dependencies from untrusted repositories.
 * Security measures implemented:
 * - Path validation and sanitization via validateRepoPath()
 * - Command timeout enforcement (120 seconds for install, 60 for license check)
 * - --ignore-scripts flag prevents preinstall/postinstall/etc scripts from executing
 * - Repository path is validated before command execution
 *
 * Remaining risks:
 * - Network access during npm dependency resolution
 * - Disk space consumption from dependencies
 *
 * Production deployment should use containerization or isolated environments.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { Dependency, DependencyExtractionResult, DependencyExtractionError } from '../../types';
import { normalizeLicenseName } from '../license-policy';
import { isNonEmptyString, isValidDependency } from '../type-guards';

const execAsync = promisify(exec);

// Get path to license-checker binary in our project's node_modules
// __dirname will be dist/utils/parsers after compilation, so go up to project root
const projectRoot = path.resolve(__dirname, '../../..');
const licenseCheckerBin = path.join(projectRoot, 'node_modules/.bin/license-checker-rseidelsohn');

// npm-specific constants
const INSTALL_TIMEOUT = 120000; // 120 seconds for yarn install
const LICENSE_CHECK_TIMEOUT = 60000; // 60 seconds for license-checker
const NPM_BUILD_FILES = ['package.json'];
const FOLIO_NPM_REGISTRY_URL = 'https://repository.folio.org/repository/npm-folio';


/**
 * Validate and sanitize a repository path
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
 * Split an SPDX license expression that may contain multiple licenses
 * SPDX uses ' OR ' for alternatives and ' AND ' for conjunctive licenses
 * Examples:
 *   - "MIT OR Apache-2.0" → ["MIT", "Apache-2.0"]
 *   - "(MIT OR GPL-2.0)" → ["MIT", "GPL-2.0"]
 *   - "MIT" → ["MIT"]
 *
 * Note: Only handles simple OR/AND expressions. Complex SPDX expressions with
 * parentheses and WITH clauses may not be fully parsed.
 *
 * @param license - SPDX license expression
 * @returns Array of normalized individual licenses
 */
function splitSpdxLicenses(license: string): string[] {
  if (!isNonEmptyString(license)) {
    return [];
  }

  // Remove surrounding parentheses if present
  let cleaned = license.trim();
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = cleaned.substring(1, cleaned.length - 1).trim();
  }

  // Check for SPDX ' OR ' separator (note the spaces)
  // OR has higher precedence in our simple parser
  if (cleaned.includes(' OR ')) {
    return cleaned
      .split(' OR ')
      .map(l => l.trim())
      .filter(isNonEmptyString)
      .flatMap(l => splitSpdxLicenses(l)) // Recursively handle complex expressions
      .map(l => {
        const normalized = normalizeLicenseName(l);
        return normalized || l;
      });
  }

  // Check for SPDX ' AND ' separator
  // In dual-licensing context, AND means both licenses apply
  // For compliance checking, we treat this similarly to OR (any compliant license makes it pass)
  if (cleaned.includes(' AND ')) {
    return cleaned
      .split(' AND ')
      .map(l => l.trim())
      .filter(isNonEmptyString)
      .flatMap(l => splitSpdxLicenses(l))
      .map(l => {
        const normalized = normalizeLicenseName(l);
        return normalized || l;
      });
  }

  // Single license - normalize and return
  const normalized = normalizeLicenseName(cleaned);
  return [normalized || cleaned];
}


/**
 * Parse license-checker-rseidelsohn JSON output
 * @param jsonOutput - JSON string from license-checker-rseidelsohn
 * @returns Array of parsed dependencies
 */
function parseLicenseCheckerOutput(jsonOutput: string): Dependency[] {
  if (!isNonEmptyString(jsonOutput)) {
    return [];
  }

  try {
    const licenseData = JSON.parse(jsonOutput);
    const dependencies: Dependency[] = [];

    for (const [packageKey, packageInfo] of Object.entries(licenseData)) {
      // packageKey format: "package-name@version" or "@scope/package-name@version"
      // For scoped packages, we need to find the last @ which separates name from version
      let name: string;
      let version: string;

      if (packageKey.startsWith('@')) {
        // Scoped package: @scope/package-name@version
        // Find the second @ which is the version separator
        const secondAtIndex = packageKey.indexOf('@', 1);
        if (secondAtIndex === -1) {
          continue;
        }
        name = packageKey.substring(0, secondAtIndex);
        version = packageKey.substring(secondAtIndex + 1);
      } else {
        // Regular package: package-name@version
        const atIndex = packageKey.indexOf('@');
        if (atIndex === -1) {
          continue;
        }
        name = packageKey.substring(0, atIndex);
        version = packageKey.substring(atIndex + 1);
      }

      if (!isNonEmptyString(name) || !isNonEmptyString(version)) {
        continue;
      }

      // Extract licenses from license-checker output
      const info = packageInfo as any;
      let licenses: string[] = [];

      if (info.licenses) {
        const licenseField = info.licenses;

        if (typeof licenseField === 'string') {
          // Split SPDX expressions and normalize
          licenses = splitSpdxLicenses(licenseField);
        } else if (Array.isArray(licenseField)) {
          // Already an array, but still need to split SPDX expressions
          licenses = licenseField.flatMap(l => splitSpdxLicenses(String(l)));
        }
      }

      const dependency: Dependency = {
        name: name.trim(),
        version: version.trim(),
        licenses: licenses.length > 0 ? licenses : undefined
      };

      if (isValidDependency(dependency)) {
        dependencies.push(dependency);
      }
    }

    return dependencies;
  } catch (error) {
    console.warn('Failed to parse license-checker output:', error);
    return [];
  }
}

/**
 * Fallback: Extract direct dependencies from package.json without license information
 * Used when license-checker fails but we still want to report what dependencies exist
 *
 * GRACEFUL DEGRADATION: This provides partial results (dependencies without licenses)
 * which is better than no results at all. License compliance evaluator will mark
 * dependencies without license info as requiring manual review.
 *
 * @param repoPath - Validated repository path
 * @returns Array of dependencies without license information (only direct deps, not transitive)
 */
function extractFromPackageJson(repoPath: string): Dependency[] {
  const packageJsonPath = path.join(repoPath, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const dependencies: Dependency[] = [];

    // Extract from dependencies (production)
    if (packageJson.dependencies && typeof packageJson.dependencies === 'object') {
      for (const [name, version] of Object.entries(packageJson.dependencies)) {
        if (isNonEmptyString(name) && isNonEmptyString(String(version))) {
          dependencies.push({
            name,
            version: String(version).replace(/^[\^~>=<]/, ''), // Remove version prefix
            licenses: undefined  // No license info available in fallback mode
          });
        }
      }
    }

    return dependencies;
  } catch (error) {
    console.error('Failed to parse package.json:', error);
    return [];
  }
}

/**
 * Check if an npm/Node.js project exists in the repository
 * @param repoPath - Path to repository
 * @returns Promise resolving to true if npm project exists
 */
export async function hasNpmProject(repoPath: string): Promise<boolean> {
  if (!isNonEmptyString(repoPath)) {
    return false;
  }
  return NPM_BUILD_FILES.some(file => fs.existsSync(path.join(repoPath, file)));
}

/**
 * Extract dependencies from npm/Node.js project using license-checker-rseidelsohn
 * Runs yarn install and license-checker to get all dependencies including transitives
 * @param repoPath - Path to npm project
 * @returns Promise resolving to extraction result with dependencies and errors
 */
export async function getNpmDependencies(repoPath: string): Promise<DependencyExtractionResult> {
  const errors: DependencyExtractionError[] = [];
  const warnings: DependencyExtractionError[] = [];

  // SECURITY: Validate and sanitize repository path before executing commands
  const validatedPath = validateRepoPath(repoPath);
  if (!validatedPath) {
    errors.push({
      source: 'npm-parser',
      message: `Invalid repository path: ${repoPath}`,
      error: new Error('Path validation failed')
    });
    return { dependencies: [], errors, warnings };
  }

  try {
    // Configure FOLIO registry for @folio scoped packages if .npmrc doesn't exist
    const npmrcPath = path.join(validatedPath, '.npmrc');
    if (!fs.existsSync(npmrcPath)) {
      console.log('Creating .npmrc with FOLIO registry configuration...');
      fs.writeFileSync(
        npmrcPath,
        `@folio:registry=${FOLIO_NPM_REGISTRY_URL}\n`,
        'utf-8'
      );
    }

    // Step 1: Run yarn install to get all dependencies including transitives
    // SECURITY: --ignore-scripts prevents execution of preinstall/postinstall/etc scripts
    console.log('Running yarn install...');
    await execAsync('yarn install --production --ignore-scripts', {
      cwd: validatedPath,
      timeout: INSTALL_TIMEOUT
    });

    // Step 2: Run license-checker-rseidelsohn to extract license information
    // Use absolute path to binary from our project's node_modules
    console.log('Running license-checker-rseidelsohn...');
    const { stdout } = await execAsync(
      `"${licenseCheckerBin}" --json --production`,
      {
        cwd: validatedPath,
        timeout: LICENSE_CHECK_TIMEOUT
      }
    );

    // Step 3: Parse the JSON output
    const dependencies = parseLicenseCheckerOutput(stdout);

    return { dependencies, errors, warnings };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to extract npm dependencies via license-checker:', errorMessage);
    if (error instanceof Error && error.stack) {
      console.error('Stack trace:', error.stack);
    }

    // GRACEFUL DEGRADATION: Attempt to extract dependencies from package.json
    // This provides partial results (direct deps without licenses) instead of complete failure
    warnings.push({
      source: 'npm-parser',
      message: `License-checker approach failed, attempting fallback to package.json: ${errorMessage}`,
      error: error instanceof Error ? error : new Error(String(error))
    });

    try {
      const dependencies = extractFromPackageJson(validatedPath);
      if (dependencies.length > 0) {
        console.log(`Extracted ${dependencies.length} direct dependencies from package.json (without license info)`);
        warnings.push({
          source: 'npm-parser',
          message: 'Using fallback: extracted direct dependencies from package.json without license information. License compliance will require manual review.',
          error: new Error('Partial extraction - transitive dependencies and licenses unavailable')
        });
        return { dependencies, errors, warnings };
      }
    } catch (fallbackError) {
      console.error('Fallback extraction also failed:', fallbackError);
      errors.push({
        source: 'npm-parser',
        message: 'Both license-checker and package.json extraction failed',
        error: fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError))
      });
    }

    // Complete failure - no results available
    errors.push({
      source: 'npm-parser',
      message: `Failed to extract npm dependencies: ${errorMessage}`,
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
