/**
 * ASF (Apache Software Foundation) License Policy Implementation
 *
 * This module implements the ASF 3rd Party License Policy for determining
 * license compliance categories and special exceptions.
 *
 * Configuration is loaded from external JSON files to allow non-developers
 * to update license policies without code changes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DualLicensedConfig, LicenseCategoriesConfig, SpecialExceptionsConfig, LicenseVariationsConfig } from '../types';
import { getLogger } from './logger';

export enum LicenseCategory {
  A = 'A', // Compatible licenses
  B = 'B', // Conditional licenses (require labeling)
  B_WCL = 'B-WCL', // Conditional licenses with weak copyleft (require labeling)
  X = 'X'  // Prohibited licenses
}

let licensePolicy: Map<string, LicenseCategory> | null = null;
let licenseVariations: Map<string, string> | null = null;
let specialExceptionsConfig: SpecialExceptionsConfig | null = null;
let dualLicensed: DualLicensedConfig['projects'] | null = null;

function getConfigPath(): string {
  const currentDir = __dirname;

  // Try multiple possible paths to handle different execution contexts
  const possiblePaths = [
    // From built JS files: dist/utils -> project root
    path.join(currentDir, '..', '..', 'config'),
    // From source TS files: src/utils -> project root
    path.join(currentDir, '..', '..', 'config'),
    // From test context
    path.join(process.cwd(), 'config'),
    path.join(__dirname, '..', '..', '..', 'config'),
    path.join(__dirname, '..', 'config')
  ];

  for (const configPath of possiblePaths) {
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }

  return path.join(process.cwd(), 'config');
}

function loadLicenseCategories(): Map<string, LicenseCategory> {
  if (licensePolicy !== null) {
    return licensePolicy;
  }

  try {
    const configPath = path.join(getConfigPath(), 'license-categories.json');
    const configData = fs.readFileSync(configPath, 'utf-8');
    const config: LicenseCategoriesConfig = JSON.parse(configData);

    const policy = new Map<string, LicenseCategory>();
    for (const [licenseName, category] of Object.entries(config.categories)) {
      if (Object.values(LicenseCategory).includes(category as LicenseCategory)) {
        policy.set(licenseName, category as LicenseCategory);
      } else {
        getLogger().warn(`Invalid license category '${category}' for license '${licenseName}'`);
      }
    }

    licensePolicy = policy;
    return policy;
  } catch (error) {
    getLogger().error('Failed to load license categories configuration:', error);
    return new Map<string, LicenseCategory>();
  }
}


function loadSpecialExceptionsConfig(): SpecialExceptionsConfig {
  if (specialExceptionsConfig !== null) {
    return specialExceptionsConfig;
  }

  try {
    const configPath = path.join(getConfigPath(), 'special-exceptions.json');
    const configData = fs.readFileSync(configPath, 'utf-8');
    const config: SpecialExceptionsConfig = JSON.parse(configData);

    specialExceptionsConfig = config;
    return config;
  } catch (error) {
    getLogger().error('Failed to load special exceptions configuration:', error);
    return {
      exceptions: [
        { name: 'org.hibernate', description: 'Hibernate ORM libraries', matchType: 'prefix' }
      ]
    };
  }
}

/**
 * Check if a dependency name matches any special exception
 * @param dependencyName The full dependency name (e.g., "org.hibernate:hibernate-core")
 * @returns true if the dependency is in the special exceptions list
 */
export function isSpecialException(dependencyName: string): boolean {
  return matchesAny(dependencyName, loadSpecialExceptionsConfig().exceptions);
}

function matchesAny(dependencyName: string, entries: Array<{ name: string; matchType: 'exact' | 'prefix' }>): boolean {
  return entries.some(entry => entry.matchType === 'exact'
    ? dependencyName === entry.name
    : entry.matchType === 'prefix' && dependencyName.startsWith(entry.name));
}

/**
 * Whether the dependency (groupId:artifactId) is listed in license-dual-licensed.json, so that the
 * licenses reported for it are a choice rather than licenses that all apply.
 */
export function isDualLicensed(dependencyName: string): boolean {
  if (dualLicensed === null) {
    try {
      const configPath = path.join(getConfigPath(), 'license-dual-licensed.json');
      dualLicensed = (JSON.parse(fs.readFileSync(configPath, 'utf-8')) as DualLicensedConfig).projects ?? [];
    } catch (error) {
      // Without the list every license applies, which can only make the check stricter.
      getLogger().error('Failed to load dual-licensed dependencies configuration:', error);
      dualLicensed = [];
    }
  }
  return matchesAny(dependencyName, dualLicensed);
}

/**
 * Whether the name is exactly a license listed in license-categories.json or a spelling listed in
 * license-variations.json, without any cleanup. Such a name is one license even if it contains
 * words like " AND " or " WITH ".
 */
export function isListedLicenseName(licenseName: string): boolean {
  return loadLicenseCategories().has(licenseName) || loadLicenseVariations().has(licenseName);
}

function loadLicenseVariations(): Map<string, string> {
  if (licenseVariations !== null) {
    return licenseVariations;
  }

  try {
    const configPath = path.join(getConfigPath(), 'license-variations.json');
    const configData = fs.readFileSync(configPath, 'utf-8');
    const config: LicenseVariationsConfig = JSON.parse(configData);

    const variations = new Map<string, string>();
    for (const [variation, canonical] of Object.entries(config.variations)) {
      variations.set(variation, canonical);
    }

    licenseVariations = variations;
    return variations;
  } catch (error) {
    getLogger().error('Failed to load license variations configuration:', error);
    return new Map<string, string>();
  }
}

export function normalizeLicenseName(licenseName: string): string {
  if (!licenseName) {
    return licenseName;
  }

  let cleanName = licenseName.trim();

  // Extract from (license-name) format if present (common in Maven output)
  const parenthesesMatch = cleanName.match(/^\((.*?)\)/);
  if (parenthesesMatch) {
    cleanName = parenthesesMatch[1].trim();
  }

  // Versioned names such as "Eclipse Public License - v 2.0" are variations themselves;
  // match them before the trailing-text cleanup below strips their " - v 2.0" suffix.
  const variations = loadLicenseVariations();
  if (variations.has(cleanName)) {
    return variations.get(cleanName)!;
  }

  // Trailing artifact text, such as "license name (artifact-info" or "license name - url".
  const trailingPatterns = [
    /\s+\([^)]*$/,  // Remove trailing (...
    /\s+-\s+.*$/,   // Remove trailing - ...
    /\s+\([\w\.-]+:[\w\.-]+.*$/  // Remove (groupId:artifactId...
  ];

  for (const pattern of trailingPatterns) {
    cleanName = cleanName.replace(pattern, '');
  }

  cleanName = cleanName.trim();

  if (variations.has(cleanName)) {
    return variations.get(cleanName)!;
  }

  return cleanName;
}

export function getLicenseCategoryNormalized(licenseName: string): LicenseCategory | undefined {
  const policy = loadLicenseCategories();

  const exactMatch = policy.get(licenseName);
  if (exactMatch) {
    return exactMatch;
  }

  const normalizedName = normalizeLicenseName(licenseName);
  return policy.get(normalizedName);
}
