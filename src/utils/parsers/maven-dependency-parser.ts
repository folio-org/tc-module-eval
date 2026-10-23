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
 * 3. Returning licenses as string arrays in Dependency objects
 *
 * Maven uses the pipe character '|' to separate dual/multi-licenses in THIRD-PARTY.txt.
 * The splitDualLicenses() function handles this Maven-specific format.
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
import { normalizeLicenseName } from '../license-policy';
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

function parseMavenThirdPartyLine(line: string): Dependency | null {
  const trimmedLine = line.trim();

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

  const coordStart = remaining.indexOf('(');
  const coordEnd = remaining.indexOf(')');

  if (coordStart === -1 || coordEnd === -1) {
    return null;
  }

  const coordPart = remaining.substring(coordStart + 1, coordEnd);

  const parts = coordPart.split(' - ');
  const coordinates = parts[0]?.trim();

  if (!isNonEmptyString(coordinates)) {
    return null;
  }

  const parsed = parseMavenCoordinates(coordinates);
  if (!parsed) {
    return null;
  }

  const depName = `${parsed.groupId}:${parsed.artifactId}`;

  const licenses = splitDualLicenses(licenseName);

  return {
    name: depName,
    version: parsed.version,
    licenses
  };
}

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
