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
 * 1. Splitting SPDX expressions ("MIT OR Apache-2.0") into ["MIT", "Apache-2.0"], with licenses
 *    joined by AND kept together as one alternative ("MIT AND Zlib" → [["MIT", "Zlib"]])
 * 2. Normalizing license names via license-policy.normalizeLicenseName()
 * 3. Returning licenses as arrays in Dependency objects
 *
 * npm uses SPDX license expressions where ' OR ' separates alternatives in dual licensing
 * and ' AND ' joins licenses that all apply.
 * The splitSpdxLicenses() function handles this npm-specific format.
 *
 * FOLIO REGISTRY SUPPORT:
 * - Creates .npmrc with @folio scope pointing to repository.folio.org if not present
 * - Respects existing .npmrc configuration in the repository
 *
 * ERROR HANDLING POLICY:
 * This parser only reports automatically extracted dependency evidence when the
 * full yarn install + license-checker flow succeeds. Partial package.json-only
 * extraction is intentionally not used, because it hides missing transitive
 * dependency evidence behind a best-effort result.
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

import * as fs from 'fs';
import * as path from 'path';
import { CommandRunner, Dependency, DependencyExtractionResult, DependencyExtractionError, EvaluationRun } from '../../types';
import { normalizeLicenseName } from '../license-policy';
import { isNonEmptyString, isValidDependency } from '../type-guards';
import { commandError, validateRepoPath } from './common';
import { getLogger } from '../logger';
import { defaultCommandRunner } from '../command-runner';
import { NPM_NETWORK_POLICY } from '../build-tool-policies';

const INSTALL_TIMEOUT = 120000; // 120 seconds for yarn install
const LICENSE_CHECK_TIMEOUT = 60000; // 60 seconds for license-checker
const LICENSE_CHECK_MAX_OUTPUT = 10 * 1024 * 1024; // license-checker JSON can be large
const NPM_BUILD_FILES = ['package.json'];
const FOLIO_NPM_REGISTRY_URL = 'https://repository.folio.org/repository/npm-folio';
const MAX_SPDX_ALTERNATIVES = 64;

function createNpmToolEnv(repoPath: string): NodeJS.ProcessEnv {
  const npmToolDir = path.join(repoPath, '.folio-eval-npm');
  const npmPrefix = path.join(npmToolDir, 'prefix');
  const npmCache = path.join(npmToolDir, 'cache');

  fs.mkdirSync(path.join(npmPrefix, 'lib', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(npmPrefix, 'bin'), { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });

  return {
    PATH: process.env.PATH,
    NPM_CONFIG_PREFIX: npmPrefix,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_prefix: npmPrefix,
    npm_config_cache: npmCache
  };
}

/**
 * Split an SPDX license expression into its alternatives. SPDX ' OR ' separates alternatives and
 * ' AND ' joins licenses that all apply; AND binds tighter than OR, and parentheses group. Each
 * alternative is one license, or an array of licenses that all apply.
 * Examples:
 *   - "MIT OR Apache-2.0" → ["MIT", "Apache-2.0"]
 *   - "MIT AND Zlib" → [["MIT", "Zlib"]]
 *   - "MIT OR Apache-2.0 AND GPL-3.0" → ["MIT", ["Apache-2.0", "GPL-3.0"]]
 *   - "(MIT OR Apache-2.0) AND BSD-3-Clause" → [["MIT", "BSD-3-Clause"], ["Apache-2.0", "BSD-3-Clause"]]
 * A license with a WITH exception stays one license. An expression that does not parse, such as one
 * with unbalanced parentheses, or that multiplies out to more than MAX_SPDX_ALTERNATIVES alternatives,
 * is returned as written, so the compliance check reports it.
 *
 * @param license - SPDX license expression
 * @returns Alternatives with normalized license names
 */
function splitSpdxLicenses(license: string): Array<string | string[]> {
  if (!isNonEmptyString(license)) {
    return [];
  }

  const tokens = license.replace(/[()]/g, ' $& ').split(/\s+/).filter(Boolean);
  let position = 0;

  // Each parse step returns the alternatives (OR) of license sets that all apply (AND).
  const parseOr = (): string[][] | undefined => {
    let alternatives = parseAnd();
    while (alternatives && tokens[position] === 'OR') {
      position++;
      const right = parseAnd();
      alternatives = right && [...alternatives, ...right];
    }
    return alternatives;
  };
  const parseAnd = (): string[][] | undefined => {
    let alternatives = parseOperand();
    while (alternatives && tokens[position] === 'AND') {
      position++;
      const right = parseOperand();
      // Multiplying out ANDs of OR groups grows exponentially, so a larger expression is reported unparsed.
      alternatives = right && alternatives.length * right.length <= MAX_SPDX_ALTERNATIVES
        ? alternatives.flatMap(left => right.map(set => [...new Set([...left, ...set])]))
        : undefined;
    }
    return alternatives;
  };
  const parseOperand = (): string[][] | undefined => {
    if (tokens[position] === '(') {
      position++;
      const alternatives = parseOr();
      return tokens[position++] === ')' ? alternatives : undefined;
    }
    const words: string[] = [];
    while (position < tokens.length && !['(', ')', 'AND', 'OR'].includes(tokens[position])) {
      words.push(tokens[position++]);
    }
    if (words.length === 0) {
      return undefined;
    }
    const name = words.join(' ');
    return [[normalizeLicenseName(name) || name]];
  };

  const alternatives = parseOr();
  if (!alternatives || position < tokens.length) {
    // A single license name with parentheses, such as "Apache License (2.0)", is normalized as before.
    const trimmed = license.trim();
    return [tokens.includes('AND') || tokens.includes('OR') ? trimmed : normalizeLicenseName(trimmed) || trimmed];
  }
  return alternatives.map(set => set.length === 1 ? set[0] : set);
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
      let name: string;
      let version: string;

      if (packageKey.startsWith('@')) {
        const secondAtIndex = packageKey.indexOf('@', 1);
        if (secondAtIndex === -1) {
          continue;
        }
        name = packageKey.substring(0, secondAtIndex);
        version = packageKey.substring(secondAtIndex + 1);
      } else {
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

      const info = packageInfo as any;
      let licenses: Array<string | string[]> = [];

      if (info.licenses) {
        const licenseField = info.licenses;

        if (typeof licenseField === 'string') {
          licenses = splitSpdxLicenses(licenseField);
        } else if (Array.isArray(licenseField)) {
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
    getLogger().error('Failed to parse license-checker output:', error);
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
export async function getNpmDependencies(
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
      getLogger().info('Creating .npmrc with FOLIO registry configuration...');
      try {
        // 'wx' never follows an existing path, so a dangling symlink cannot redirect this write outside the repository.
        fs.writeFileSync(npmrcPath, `@folio:registry=${FOLIO_NPM_REGISTRY_URL}\n`, { encoding: 'utf-8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        getLogger().warn('.npmrc is a symlink to a missing file; leaving it unchanged');
      }
    }

    // SECURITY: --ignore-scripts prevents execution of preinstall/postinstall/etc scripts
    // --ignore-engines bypasses Node.js engine compatibility checks that can cause
    // failures when transitive dependencies require newer Node versions (e.g., @formatjs/cli
    // requiring Node >= 20). Engine compat is irrelevant for license extraction.
    getLogger().info('Running yarn install...');
    const installResult = await commandRunner.run({
      command: 'yarn',
      args: ['install', '--production', '--ignore-scripts', '--ignore-engines'],
      cwd: validatedPath,
      timeoutMs: INSTALL_TIMEOUT,
      requiresIsolation: true,
      networkPolicy: NPM_NETWORK_POLICY
    }, evaluationRun);

    if (installResult.status !== 'success') {
      return { dependencies: [], errors: [commandError('npm-parser', 'npm', installResult)], warnings };
    }

    // Use npx with pinned version to ensure consistency across environments
    getLogger().info('Running license-checker-rseidelsohn...');
    const checkerResult = await commandRunner.run({
      command: 'npx',
      args: ['--yes', 'license-checker-rseidelsohn@4.4.2', '--json', '--production'],
      cwd: validatedPath,
      env: createNpmToolEnv(validatedPath) as Record<string, string | undefined>,
      timeoutMs: LICENSE_CHECK_TIMEOUT,
      maxOutputBytes: LICENSE_CHECK_MAX_OUTPUT,
      requiresIsolation: true,
      networkPolicy: NPM_NETWORK_POLICY
    }, evaluationRun);

    if (checkerResult.status !== 'success') {
      return { dependencies: [], errors: [commandError('npm-parser', 'npm', checkerResult)], warnings };
    }

    const dependencies = parseLicenseCheckerOutput(checkerResult.stdout);

    return { dependencies, errors, warnings };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    getLogger().error('Failed to extract npm dependencies via license-checker:', errorMessage);
    if (error instanceof Error && error.stack) {
      getLogger().error('Stack trace:', error.stack);
    }

    errors.push({
      source: 'npm-parser',
      message: `npm could not list the dependencies: ${errorMessage}`,
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
