/**
 * npm-specific dependency parsing utilities
 *
 * Handles extraction of third-party dependencies from Node.js/npm projects including:
 * - package.json parsing
 * - npm registry license lookup
 * - SPDX license expression parsing (dual/multi-licenses)
 * - npm-specific dual license format (SPDX: "MIT OR Apache-2.0")
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
 * SECURITY NOTES:
 * - No shell command execution (unlike Maven/Gradle parsers)
 * - Path validation and sanitization via validateRepoPath()
 * - HTTP request timeout enforcement (10 seconds)
 * - Graceful handling of network failures
 * - npm registry API calls use HTTPS by default
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { Dependency, DependencyExtractionResult, DependencyExtractionError } from '../../types';
import { normalizeLicenseName } from '../license-policy';
import { isNonEmptyString, isValidDependency } from '../type-guards';

// npm-specific constants
const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const HTTP_TIMEOUT = 10000; // 10 seconds
const MAX_CONCURRENT_REQUESTS = 10; // Limit concurrent HTTP requests to avoid overwhelming registry
const NPM_BUILD_FILES = ['package.json'];

// Directories to exclude when scanning for package.json files in subdirectories
// These are common directories that should not be scanned for dependencies
const EXCLUDED_SUBDIRS = [
  'node_modules',  // npm dependencies
  '.git',          // git metadata
  'test',          // test directories
  'tests',
  '__tests__',
  'dist',          // build artifacts
  'build',
  'coverage',      // test coverage reports
  '.next',         // Next.js build cache
  '.cache',        // various caches
  'target',        // Maven build directory
  'bin',           // binaries
  'obj',           // object files
  '.idea',         // IDE directories
  '.vscode'
];

// Cache for npm license lookups to avoid repeated API calls
const licenseCache = new Map<string, { licenses: string[] }>();

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
 * Clean npm version specifier to get actual version number
 * Removes common npm version prefixes like ^, ~, >, <, =, >=, <=
 * @param versionSpec - npm version specifier (e.g., "^1.2.3", "~2.0.0")
 * @returns Cleaned version number
 */
function cleanVersionSpec(versionSpec: string): string {
  if (!isNonEmptyString(versionSpec)) {
    return '';
  }

  // Remove version range operators
  return versionSpec
    .replace(/^[\^~>=<]+/, '')
    .trim();
}

/**
 * Process an array of async tasks with concurrency control
 * Prevents overwhelming the npm registry or system resources with too many parallel requests
 * @param tasks - Array of async functions to execute
 * @param concurrencyLimit - Maximum number of tasks to run concurrently
 * @returns Promise resolving to array of results
 */
async function processBatched<T>(
  tasks: Array<() => Promise<T>>,
  concurrencyLimit: number
): Promise<T[]> {
  const results: T[] = [];

  // Process tasks in batches
  for (let i = 0; i < tasks.length; i += concurrencyLimit) {
    const batch = tasks.slice(i, i + concurrencyLimit);
    const batchResults = await Promise.all(batch.map(task => task()));
    results.push(...batchResults);
  }

  return results;
}

/**
 * Fetch raw package data from npm registry
 * Handles HTTP request/response details and returns raw JSON string
 * @param packageName - Name of the npm package
 * @returns Promise resolving to raw JSON string from npm registry
 * @throws Error if HTTP request fails or times out
 */
function fetchNpmPackageData(packageName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `${NPM_REGISTRY_URL}/${encodeURIComponent(packageName)}`;

    const request = https.get(url, { timeout: HTTP_TIMEOUT }, (response) => {
      let data = '';

      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`npm registry returned ${response.statusCode} for ${packageName}`));
          return;
        }
        resolve(data);
      });
    });

    request.on('error', (error) => {
      reject(new Error(`Error fetching npm data for ${packageName}: ${error.message}`));
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Timeout fetching npm data for ${packageName}`));
    });
  });
}

/**
 * Fetch license information for an npm package from npm registry
 * Uses https://registry.npmjs.org/{package} API
 * @param packageName - Name of the npm package
 * @param versionSpec - Version specifier from package.json
 * @returns Promise resolving to license information (always as an array)
 */
async function fetchNpmLicense(
  packageName: string,
  versionSpec: string
): Promise<{ licenses: string[] }> {
  // Check cache first
  const cacheKey = `${packageName}:${versionSpec}`;
  if (licenseCache.has(cacheKey)) {
    return licenseCache.get(cacheKey)!;
  }

  try {
    // Fetch package data from npm registry
    const data = await fetchNpmPackageData(packageName);

    // Parse JSON response
    const packageData = JSON.parse(data);

    // Clean the version specifier to match against registry data
    const cleanVersion = cleanVersionSpec(versionSpec);

    // Try to get specific version info
    let versionData = packageData.versions?.[cleanVersion];

    // Fallback to latest version if specific version not found
    if (!versionData) {
      const latestVersion = packageData['dist-tags']?.latest;
      if (latestVersion) {
        versionData = packageData.versions?.[latestVersion];
      }
    }

    if (!versionData) {
      const result = { licenses: ['Unknown'] };
      licenseCache.set(cacheKey, result);
      return result;
    }

    // Handle different license field formats
    const licenseField = versionData.license;

    if (!licenseField) {
      const result = { licenses: ['Unknown'] };
      licenseCache.set(cacheKey, result);
      return result;
    }

    // License can be a string or an object
    let licenseString: string;

    if (typeof licenseField === 'string') {
      licenseString = licenseField;
    } else if (typeof licenseField === 'object' && licenseField.type) {
      // Handle object format: { type: "MIT", url: "..." }
      licenseString = licenseField.type;
    } else {
      const result = { licenses: ['Unknown'] };
      licenseCache.set(cacheKey, result);
      return result;
    }

    // Split SPDX expressions into individual licenses
    const licenses = splitSpdxLicenses(licenseString);

    const result = { licenses };
    licenseCache.set(cacheKey, result);
    return result;

  } catch (error) {
    // Handle all errors (HTTP, parsing, etc.)
    console.warn(`Error fetching/parsing npm license for ${packageName}:`, error);
    const result = { licenses: ['Unknown'] };
    licenseCache.set(cacheKey, result);
    return result;
  }
}

/**
 * Parse package.json file and extract dependency information
 * @param packageJsonPath - Path to package.json file
 * @returns Object containing dependencies and devDependencies
 */
function parsePackageJson(packageJsonPath: string): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} | null {
  const content = safeReadFile(packageJsonPath);
  if (!content) {
    return null;
  }

  try {
    const packageData = JSON.parse(content);

    return {
      dependencies: packageData.dependencies || {},
      devDependencies: packageData.devDependencies || {}
    };
  } catch (error) {
    console.warn(`Failed to parse package.json at ${packageJsonPath}:`, error);
    return null;
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
 * Extract dependencies from npm/Node.js project
 * Reads package.json and fetches license information from npm registry
 * @param repoPath - Path to npm project
 * @returns Promise resolving to extraction result with dependencies and errors
 */
export async function getNpmDependencies(repoPath: string): Promise<DependencyExtractionResult> {
  const errors: DependencyExtractionError[] = [];
  const warnings: DependencyExtractionError[] = [];
  const dependencies: Dependency[] = [];

  // Validate repository path
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
    // Look for package.json files
    const packageJsonPaths: string[] = [];

    // Check root directory
    const rootPackageJson = path.join(validatedPath, 'package.json');
    if (fs.existsSync(rootPackageJson)) {
      packageJsonPaths.push(rootPackageJson);
    }

    // Also check subdirectories for plugin projects (similar to Python script)
    // Exclude common directories like node_modules, test directories, build artifacts, etc.
    try {
      const entries = fs.readdirSync(validatedPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Skip excluded directories and hidden directories (starting with .)
          const dirName = entry.name;
          if (EXCLUDED_SUBDIRS.includes(dirName) || dirName.startsWith('.')) {
            continue;
          }

          const subPackageJson = path.join(validatedPath, dirName, 'package.json');
          if (fs.existsSync(subPackageJson)) {
            packageJsonPaths.push(subPackageJson);
          }
        }
      }
    } catch (error) {
      // Ignore errors reading subdirectories
    }

    if (packageJsonPaths.length === 0) {
      warnings.push({
        source: 'npm-parser',
        message: 'No package.json files found in repository'
      });
      return { dependencies: [], errors, warnings };
    }

    // Track unique dependencies (by name:version)
    const uniqueDeps = new Map<string, Dependency>();

    // Process all package.json files found
    for (const packageJsonPath of packageJsonPaths) {
      const packageData = parsePackageJson(packageJsonPath);

      if (!packageData) {
        warnings.push({
          source: 'npm-parser',
          message: `Failed to parse ${packageJsonPath}`
        });
        continue;
      }

      // Combine dependencies and devDependencies
      const allDeps = {
        ...packageData.dependencies,
        ...packageData.devDependencies
      };

      // Collect dependencies to fetch (skip duplicates)
      const depsToFetch: Array<{ name: string; version: string; key: string }> = [];
      for (const [depName, versionSpec] of Object.entries(allDeps)) {
        if (!isNonEmptyString(depName) || !isNonEmptyString(versionSpec)) {
          continue;
        }

        const depKey = `${depName}:${versionSpec}`;
        if (uniqueDeps.has(depKey)) {
          continue;
        }

        depsToFetch.push({ name: depName, version: versionSpec, key: depKey });
      }

      // Fetch all licenses with controlled concurrency
      // This is much faster than sequential fetches while preventing overwhelming the npm registry
      // Maximum of MAX_CONCURRENT_REQUESTS parallel requests at a time
      const licenseTasks = depsToFetch.map(({ name, version, key }) => {
        return async () => {
          try {
            const licenseInfo = await fetchNpmLicense(name, version);
            return {
              key,
              name,
              version,
              licenseInfo,
              error: null
            };
          } catch (error) {
            return {
              key,
              name,
              version,
              licenseInfo: null,
              error: error instanceof Error ? error : new Error(String(error))
            };
          }
        };
      });

      // Process license fetches in batches with concurrency control
      const fetchResults = await processBatched(licenseTasks, MAX_CONCURRENT_REQUESTS);

      // Process results and add to uniqueDeps map
      for (const result of fetchResults) {
        if (result.error) {
          warnings.push({
            source: 'npm-parser',
            message: `Failed to fetch license for ${result.name}@${result.version}`,
            error: result.error
          });

          // Add dependency without license info
          const dependency: Dependency = {
            name: result.name,
            version: result.version,
            licenses: undefined
          };

          if (isValidDependency(dependency)) {
            uniqueDeps.set(result.key, dependency);
          }
        } else if (result.licenseInfo) {
          const dependency: Dependency = {
            name: result.name,
            version: result.version,
            licenses: result.licenseInfo.licenses
          };

          if (isValidDependency(dependency)) {
            uniqueDeps.set(result.key, dependency);
          }
        }
      }
    }

    // Convert map to array
    dependencies.push(...Array.from(uniqueDeps.values()));

    return { dependencies, errors, warnings };

  } catch (error) {
    errors.push({
      source: 'npm-parser',
      message: 'Failed to extract npm dependencies',
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
