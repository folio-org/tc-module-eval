/**
 * Maven-specific dependency parsing utilities
 *
 * Handles extraction of third-party dependencies from Maven projects including:
 * - Maven license plugin output (THIRD-PARTY.txt)
 * - Maven coordinate parsing
 * - Maven-specific dual license format (pipe-separated: "Apache-2.0|MIT")
 *
 * PARSER CONTRACT IMPLEMENTATION:
 * This parser fulfills the license-compliance.ts contract by:
 * 1. Splitting pipe-separated licenses ("Apache-2.0|MIT") into ["Apache-2.0", "MIT"]
 * 2. Normalizing license names via license-policy.normalizeLicenseName()
 * 3. Returning licenses as string arrays in Dependency objects; several licenses on one
 *    THIRD-PARTY.txt line form one set that all apply, unless config/license-dual-licensed.json
 *    lists the dependency as offering a choice of them
 *
 * A license name containing '|' is split by splitDualLicenses(); the plugin writes each license
 * in its own parenthesised group, so such names are not expected in practice.
 *
 * SECURITY WARNING: This module executes Maven build commands on untrusted repositories.
 * Security measures implemented:
 * - Path validation and sanitization via validateRepoPath()
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

import * as fs from 'fs';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import { CommandRunner, Dependency, DependencyExtractionResult, DependencyExtractionError, EvaluationRun } from '../../types';
import { isDualLicensed, normalizeLicenseName } from '../license-policy';
import { errorMessage, isNonEmptyString, isValidDependency } from '../type-guards';
import { commandError, readRepoTextFile, safeReadFile, validateRepoPath } from './common';
import { getLogger } from '../logger';
import { defaultCommandRunner } from '../command-runner';
import { MAVEN_NETWORK_POLICY } from '../build-tool-policies';

const COMMAND_TIMEOUT = 300000;
const MAX_BUFFER = 50 * 1024 * 1024; // 50MB for Maven verbose output
const MAX_POM_BYTES = 4 * 1024 * 1024;
const MAVEN_THIRD_PARTY_PATH = path.join('target', 'licenses', 'THIRD-PARTY.txt');

const MAVEN_COORDINATE_PATTERN = /^(.+?):(.+?):(.+?)$/;
// Licenses and name, then the last " (groupId:artifactId:version - URL)" group on the line.
// The coordinate parts exclude ':' so that a long run of colons cannot cause cubic backtracking.
const MAVEN_THIRD_PARTY_LINE_PATTERN = /^(.*) \(([^\s():]+:[^\s():]+:[^\s():]+) - .*\)$/;

const MAVEN_BUILD_FILES = ['pom.xml'];

const VALID_PACKAGING_TYPES = ['pom', 'jar', 'war', 'ear', 'maven-plugin', 'ejb', 'rar', 'bundle'];

async function getMavenPackaging(repoPath: string): Promise<string> {
  try {
    const pomContent = readRepoTextFile(repoPath, 'pom.xml', MAX_POM_BYTES);
    if (pomContent === null) {
      getLogger().warn('pom.xml not found in the repository, defaulting to jar packaging');
      return 'jar';
    }

    const parsed = await parseStringPromise(pomContent, {
      trim: true,
      explicitArray: true,
      mergeAttrs: false
    });

    const packaging = parsed?.project?.packaging?.[0];

    if (packaging && isNonEmptyString(packaging)) {
      const trimmedPackaging = packaging.trim();

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

  if (license.includes('|')) {
    return license
      .split('|')
      .map(l => l.trim())
      .filter(isNonEmptyString)
      .map(l => {
        const normalized = normalizeLicenseName(l);
        if (!normalized) {
          getLogger().warn(`License normalization failed for "${l}", using original value.`);
        }
        return normalized || l;
      });
  }

  const normalized = normalizeLicenseName(license);
  if (!normalized) {
    getLogger().warn(`License normalization failed for "${license}", using original value.`);
  }
  return [normalized || license];
}

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
 * Parses a dependency line from license-maven-plugin's default third-party-file.ftl template:
 * `(License A) (License B) Name (groupId:artifactId:version - URL)`. Each license is one
 * parenthesised group, written as-is, so a license name can contain balanced parentheses.
 * The name can contain parentheses too, so the coordinates are read from the end of the line.
 * A name that itself starts with a parenthesised group cannot be told apart from a license.
 * @returns the dependency, or null when the line does not have this form
 */
function parseMavenThirdPartyLine(line: string): Dependency | null {
  const match = line.trim().match(MAVEN_THIRD_PARTY_LINE_PATTERN);
  if (!match) {
    return null;
  }
  const [, licensesAndName, coordinates] = match;

  const licenseNames: string[] = [];
  let position = 0;
  while (licensesAndName[position] === '(') {
    let depth = 0;
    let end = position;
    for (; end < licensesAndName.length; end++) {
      if (licensesAndName[end] === '(') depth++;
      if (licensesAndName[end] === ')' && --depth === 0) break;
    }
    if (depth !== 0) {
      return null;
    }
    licenseNames.push(licensesAndName.substring(position + 1, end).trim());
    position = end + 1;
    while (licensesAndName[position] === ' ') position++;
  }

  const parsed = parseMavenCoordinates(coordinates);
  if (licenseNames.length === 0 || !parsed) {
    return null;
  }

  const name = `${parsed.groupId}:${parsed.artifactId}`;
  const licenses = licenseNames.flatMap(splitDualLicenses);
  return {
    name,
    version: parsed.version,
    // The plugin lists every license the POM declares. A POM can declare one license per bundled
    // component (Jersey lists Apache-2.0 for its bundled Guava), so the licenses all apply unless
    // the dependency is known to offer a choice of them.
    licenses: licenses.length > 1 && !isDualLicensed(name) ? [licenses] : licenses
  };
}

/**
 * @throws Error with a plain-language reason when a dependency line cannot be read, so the
 * dependency is reported instead of being left out of the license check
 */
function parseMavenThirdPartyFile(content: string): Dependency[] {
  if (!isNonEmptyString(content)) {
    return [];
  }

  const dependencies: Dependency[] = [];
  const unreadable: string[] = [];

  for (const line of content.split('\n')) {
    // Dependency lines start with a license group; the header and blank lines do not.
    if (!line.trim().startsWith('(')) {
      continue;
    }
    const dependency = parseMavenThirdPartyLine(line);
    if (dependency && isValidDependency(dependency)) {
      dependencies.push(dependency);
    } else {
      unreadable.push(line.trim());
    }
  }

  if (unreadable.length > 0) {
    throw new Error(
      `${MAVEN_THIRD_PARTY_PATH} has ${unreadable.length === 1 ? '1 dependency line' : `${unreadable.length} dependency lines`} ` +
      `that could not be read, so the dependency list is incomplete. First unreadable line: ${unreadable[0]}`
    );
  }

  return dependencies;
}

export async function hasMavenProject(repoPath: string): Promise<boolean> {
  if (!isNonEmptyString(repoPath)) {
    return false;
  }
  return MAVEN_BUILD_FILES.some(file => fs.existsSync(path.join(repoPath, file)));
}

export async function getMavenDependencies(
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
      source: 'maven-parser',
      message: `Invalid repository path: ${repoPath}`,
      error: new Error('Path validation failed')
    });
    return { dependencies: [], errors, warnings };
  }

  try {
    const packaging = await getMavenPackaging(validatedPath);

    // Choose appropriate goal based on packaging:
    // - 'pom' packaging: use aggregate-add-third-party (for parent POMs in multi-module projects)
    // - Other packaging ('jar', 'war', etc.): use add-third-party (for regular modules)
    const mavenGoal = packaging === 'pom'
      ? 'license:aggregate-add-third-party'
      : 'license:add-third-party';

    getLogger().info(`Using Maven goal: ${mavenGoal} (packaging: ${packaging})`);

    const commandResult = await commandRunner.run({
      command: 'mvn',
      args: [
        mavenGoal,
        '-Dlicense.outputDirectory=target/licenses',
        '-Dlicense.includeTransitiveDependencies=true',
        // ASF policy covers what the module distributes; test-scoped libraries are not shipped.
        // `system` is the plugin's default exclusion and is kept.
        '-Dlicense.excludedScopes=test,system'
      ],
      cwd: validatedPath,
      timeoutMs: COMMAND_TIMEOUT,
      maxOutputBytes: MAX_BUFFER,
      requiresIsolation: true,
      networkPolicy: MAVEN_NETWORK_POLICY
    }, evaluationRun);

    getLogger().info('Maven license plugin output:', commandResult.stdout);

    if (commandResult.status !== 'success') {
      errors.push(commandError('maven-parser', 'Maven', commandResult));
      return { dependencies: [], errors, warnings };
    }

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
      message: `Maven ran but did not write a third-party license list (${MAVEN_THIRD_PARTY_PATH}). ` +
               'This usually means the module has no third-party dependencies.'
    });

    return { dependencies: [], errors, warnings };

  } catch (error) {
    const message = errorMessage(error);
    getLogger().error('Maven dependency extraction failed:');
    getLogger().error('  Message:', message);

    errors.push({
      source: 'maven-parser',
      message: `Maven could not list the dependencies: ${message}`,
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
