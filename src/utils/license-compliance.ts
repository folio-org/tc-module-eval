/**
 * Language-agnostic license compliance checking utilities
 *
 * Provides compliance checking logic that can be used by any language evaluator.
 * Checks dependencies against Apache Software Foundation (ASF) license policy categories:
 * - Category A: Approved licenses (Apache, MIT, BSD, etc.)
 * - Category B: Licenses requiring documentation (LGPL, MPL, EPL, CDDL)
 * - Category X: Prohibited licenses (GPL, etc.)
 *
 * PARSER CONTRACT:
 * Build tool-specific parsers (Maven, Gradle, npm, Go, etc.) MUST:
 * 1. Split dual/multi-licenses into separate array entries
 *    - Example: "Apache-2.0|MIT" → ["Apache-2.0", "MIT"]
 *    - Each ecosystem may use different separators (Maven: "|", npm: " OR ", etc.)
 * 2. Normalize license names where possible
 * 3. Return licenses as a string array in the Dependency object
 *
 * This module validates the contract and will report parser violations as compliance errors.
 * Dependencies with unsplit licenses (containing '|', 'OR', 'AND') will fail compliance.
 */

import { Dependency, ComplianceResult, ComplianceIssue, EvaluationStatus, LicenseIssueType } from '../types';
import {
  LicenseCategory,
  getLicenseCategoryNormalized,
  isSpecialException
} from './license-policy';
import { isNonEmptyString, isValidDependency } from './type-guards';
import { getLogger } from './logger';

/**
 * Evaluation result for a single license
 */
interface LicenseEvaluation {
  license: string;
  category?: LicenseCategory;
  status: EvaluationStatus;
  reason: string;
  issueType?: LicenseIssueType;
}

/**
 * Default evaluation when no specific result can be determined
 */
const DEFAULT_EVALUATION_FAILURE = {
  status: EvaluationStatus.MANUAL,
  reason: 'Unable to evaluate licenses',
  issueType: LicenseIssueType.UNKNOWN_LICENSE
} as const;

/**
 * Check if a license string represents an LGPL license
 * @param license - License name to check
 * @returns True if license is LGPL variant
 */
function isLGPLLicense(license: string): boolean {
  if (!isNonEmptyString(license)) {
    return false;
  }
  const lower = license.toLowerCase();
  return lower.includes('lgpl') || lower.includes('lesser general public');
}

/**
 * Get documentation keywords for a license name
 * @param licenseName - License name to get keywords for
 * @returns Array of keywords that indicate this license is documented
 */
function getLicenseDocumentationKeywords(licenseName: string): string[] {
  if (!isNonEmptyString(licenseName)) {
    return [];
  }

  const lowerLicense = licenseName.toLowerCase();
  const keywords: string[] = [];

  // LGPL family
  if (lowerLicense.includes('lgpl') || lowerLicense.includes('lesser general public')) {
    keywords.push('lgpl', 'lesser general public license');
  }

  // MPL family (Mozilla Public License)
  if (lowerLicense.includes('mpl') || lowerLicense.includes('mozilla')) {
    keywords.push('mpl', 'mozilla public license', 'mozilla');
  }

  // EPL family (Eclipse Public License)
  if (lowerLicense.includes('epl') || lowerLicense.includes('eclipse')) {
    keywords.push('epl', 'eclipse public license', 'eclipse');
  }

  // CDDL family (Common Development and Distribution License)
  if (lowerLicense.includes('cddl') || lowerLicense.includes('common development')) {
    keywords.push('cddl', 'common development', 'common development and distribution license');
  }

  return keywords;
}

/**
 * Check if any of the dependency's licenses are Category B and documented in README
 * @param dependency - Dependency to check
 * @param readmeContent - README content to search
 * @returns True if any Category B licenses are documented
 */
function isCategoryBLicenseDocumented(dependency: Dependency, readmeContent: string): boolean {
  if (!dependency.licenses || !Array.isArray(dependency.licenses) || !isNonEmptyString(readmeContent)) {
    return false;
  }

  const content = readmeContent.toLowerCase();

  // Check each of the dependency's licenses
  for (const license of dependency.licenses) {
    if (!isNonEmptyString(license)) {
      continue;
    }

    // Check if this license is Category B or B_WCL
    const normalizedLicense = getLicenseCategoryNormalized(license);
    if (normalizedLicense === LicenseCategory.B || normalizedLicense === LicenseCategory.B_WCL) {
      // Get documentation keywords for this license
      const keywords = getLicenseDocumentationKeywords(license);

      // Check if any keywords are documented in README
      if (keywords.some(keyword => content.includes(keyword.toLowerCase()))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a dependency is documented in the README file
 * Looks for mentions of Category B license families or the specific dependency name
 * @param dependency - Dependency to check
 * @param readmeContent - Content of README file
 * @returns True if dependency is documented
 */
function isDocumentedInReadme(dependency: Dependency, readmeContent: string): boolean {
  if (!isValidDependency(dependency) || typeof readmeContent !== 'string') {
    return false;
  }

  const content = readmeContent.toLowerCase();
  const depName = dependency.name.toLowerCase();

  // Check for specific dependency name mention
  if (content.includes(depName)) {
    return true;
  }

  // Check for Category B license documentation using dynamic detection
  return isCategoryBLicenseDocumented(dependency, readmeContent);
}

/**
 * Evaluate multiple licenses using OR logic:
 * - If ANY license is Category A -> PASS
 * - If ANY Category B is documented -> PASS
 * - If ANY is unknown but another is Category A -> PASS (known license wins)
 * - Otherwise follow standard rules
 *
 * @param licenses - Array of license names to evaluate
 * @param dependency - The dependency being evaluated
 * @param readmeContent - README content for Category B documentation check
 * @returns Best evaluation result based on OR logic
 */
function evaluateMultipleLicenses(
  licenses: string[],
  dependency: Dependency,
  readmeContent: string
): LicenseEvaluation {
  if (!Array.isArray(licenses) || licenses.length === 0) {
    return {
      license: 'Unknown',
      status: EvaluationStatus.MANUAL,
      reason: 'No license information available',
      issueType: LicenseIssueType.NO_LICENSE_INFO
    };
  }

  const evaluations: LicenseEvaluation[] = [];

  // Evaluate each license
  for (const license of licenses) {
    const category = getLicenseCategoryNormalized(license);

    if (!category) {
      // Unknown license
      evaluations.push({
        license,
        status: EvaluationStatus.MANUAL,
        reason: `Unknown license '${license}'`,
        issueType: LicenseIssueType.UNKNOWN_LICENSE
      });
    } else if (category === LicenseCategory.A) {
      // Category A - automatically passes and wins in OR logic, so return immediately
      return {
        license,
        category,
        status: EvaluationStatus.PASS,
        reason: `Category A license '${license}' is approved`
      };
    } else if (category === LicenseCategory.B || category === LicenseCategory.B_WCL) {
      // Category B - check documentation
      // Create a temporary dependency with just this single license for documentation check
      const singleLicenseDep: Dependency = {
        ...dependency,
        licenses: [license]
      };

      if (isDocumentedInReadme(singleLicenseDep, readmeContent)) {
        evaluations.push({
          license,
          category,
          status: EvaluationStatus.PASS,
          reason: `Category B license '${license}' is documented in README`
        });
      } else {
        evaluations.push({
          license,
          category,
          status: EvaluationStatus.FAIL,
          reason: `Category B license '${license}' not documented in README`,
          issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B
        });
      }
    } else if (category === LicenseCategory.X) {
      // Category X - check for LGPL special exceptions
      if (isLGPLLicense(license) && isSpecialException(dependency.name)) {
        // Create a temporary dependency with just this single license for documentation check
        const singleLicenseDep: Dependency = {
          ...dependency,
          licenses: [license]
        };

        if (isDocumentedInReadme(singleLicenseDep, readmeContent)) {
          evaluations.push({
            license,
            category,
            status: EvaluationStatus.PASS,
            reason: `LGPL license '${license}' with special exception is documented`
          });
        } else {
          evaluations.push({
            license,
            category,
            status: EvaluationStatus.FAIL,
            reason: `LGPL license '${license}' requires documentation (special exception: ${dependency.name})`,
            issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B
          });
        }
      } else {
        evaluations.push({
          license,
          category,
          status: EvaluationStatus.FAIL,
          reason: `License '${license}' is in Category X (prohibited)`,
          issueType: LicenseIssueType.CATEGORY_X_VIOLATION
        });
      }
    }
  }

  // Apply OR logic: find the best outcome
  // Priority: PASS > MANUAL > FAIL

  // If ANY license passes, the dependency passes
  const passed = evaluations.find(e => e.status === EvaluationStatus.PASS);
  if (passed) {
    return passed;
  }

  // If we have manual review needed and no failures, return manual
  const hasUnknown = evaluations.some(e => e.status === EvaluationStatus.MANUAL);
  if (hasUnknown) {
    return {
      license: licenses.join(' | '),
      status: EvaluationStatus.MANUAL,
      reason: `Unknown licenses require manual review: ${evaluations.filter(e => e.status === EvaluationStatus.MANUAL).map(e => e.license).join(', ')}`,
      issueType: LicenseIssueType.UNKNOWN_LICENSE
    };
  }

  // Return the first failure
  const failed = evaluations.find(e => e.status === EvaluationStatus.FAIL);
  if (failed) {
    return failed;
  }

  // Fallback (shouldn't reach here)
  return evaluations[0] || {
    license: licenses.join(' | '),
    ...DEFAULT_EVALUATION_FAILURE
  };
}

/**
 * Check license compliance for dependencies according to ASF policy
 *
 * NOTE: This function expects dependencies to have normalized, pre-split licenses.
 * Build tool-specific parsers (Maven, Gradle, npm, etc.) should handle their own
 * license format quirks before calling this function.
 *
 * @param dependencies - Array of dependencies to check (with already-parsed licenses)
 * @param readmeContent - Content of the README file for Category B validation
 * @returns ComplianceResult with compliance status and any issues found
 */
export function checkLicenseCompliance(
  dependencies: Dependency[],
  readmeContent: string
): ComplianceResult {
  if (!Array.isArray(dependencies)) {
    getLogger().warn('Dependencies must be an array');
    return { compliant: false, issues: [] };
  }

  if (typeof readmeContent !== 'string') {
    getLogger().warn('README content must be a string');
    readmeContent = '';
  }

  const issues: ComplianceIssue[] = [];

  for (const dependency of dependencies) {
    // Validate dependency object
    if (!isValidDependency(dependency)) {
      continue;
    }

    // Skip dependencies without license information
    if (!dependency.licenses || !Array.isArray(dependency.licenses) || dependency.licenses.length === 0) {
      issues.push({
        dependency,
        reason: 'No license information available',
        issueType: LicenseIssueType.NO_LICENSE_INFO
      });
      continue;
    }

    const allLicenses = dependency.licenses.filter(isNonEmptyString);

    // Check if we have any valid licenses
    if (allLicenses.length === 0) {
      issues.push({
        dependency,
        reason: 'No valid license information available',
        issueType: LicenseIssueType.NO_LICENSE_INFO
      });
      continue;
    }

    // VALIDATION: Detect if parser failed to split dual licenses
    // Parsers MUST split licenses like "Apache-2.0|MIT" into ["Apache-2.0", "MIT"]
    // Check for common separators: | (Maven), OR (npm/SPDX), AND (SPDX)
    // Note: Only check uppercase OR/AND to avoid false positives with license names like
    // "Common Development and Distribution License" that contain lowercase "and"
    const unsplitLicenses = allLicenses.filter(license =>
      license.includes('|') ||
      license.includes(' OR ') ||
      license.includes(' AND ') ||
      (license.includes('(') && license.includes(')')) || // Unsplit complex expressions
      license.includes(' WITH ') // SPDX exceptions
    );
    if (unsplitLicenses.length > 0) {
      getLogger().error(
        `Parser contract violation for ${dependency.name}: ` +
        `Licenses contain separators ('|', 'OR', 'AND', parentheses, 'WITH') but should be pre-split. ` +
        `Found: ${unsplitLicenses.join(', ')}. ` +
        `Parsers must split dual/multi-licenses and normalize expressions before passing to compliance checker.`
      );
      issues.push({
        dependency,
        reason: `Parser error: Licenses not properly split (found separators in: ${unsplitLicenses.join(', ')})`,
        issueType: LicenseIssueType.PARSER_ERROR
      });
      continue;
    }

    // If we have multiple licenses (dual-licensed), use OR logic evaluation
    if (allLicenses.length > 1) {
      const evaluation = evaluateMultipleLicenses(allLicenses, dependency, readmeContent);

      // Add an issue if the evaluation failed or requires manual review
      if (evaluation.status === EvaluationStatus.FAIL ||
          evaluation.status === EvaluationStatus.MANUAL) {
        issues.push({
          dependency,
          reason: evaluation.reason,
          issueType: evaluation.issueType!
        });
      }
      // If PASS, no issue added
    } else {
      // Single license
      const license = allLicenses[0];

      // Try normalized license lookup first for better matching
      const category = getLicenseCategoryNormalized(license);

      if (!category) {
        // Unknown license even after normalization
        issues.push({
          dependency,
          reason: `Unknown license '${license}' - requires manual review`,
          issueType: LicenseIssueType.UNKNOWN_LICENSE
        });
      } else if (category === LicenseCategory.X) {
        // Category X - prohibited, but check for LGPL special exceptions
        if (isLGPLLicense(license) && isSpecialException(dependency.name)) {
          // LGPL with special exception - must be documented in README
          if (!isDocumentedInReadme(dependency, readmeContent)) {
            issues.push({
              dependency,
              reason: `LGPL license '${license}' requires documentation in README (special exception: ${dependency.name})`,
              issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B
            });
          }
          // If documented, it passes - no issue added
        } else {
          // All other Category X licenses are prohibited
          issues.push({
            dependency,
            reason: `License '${license}' is in Category X (prohibited)`,
            issueType: LicenseIssueType.CATEGORY_X_VIOLATION
          });
        }
      } else if (category === LicenseCategory.B || category === LicenseCategory.B_WCL) {
        // Category B - requires documentation
        if (!isDocumentedInReadme(dependency, readmeContent)) {
          // Check for special exceptions
          if (isSpecialException(dependency.name)) {
            // Special exception but still needs documentation
            issues.push({
              dependency,
              reason: `Category B license '${license}' not documented in README (special exception: ${dependency.name})`,
              issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B
            });
          } else {
            issues.push({
              dependency,
              reason: `Category B license '${license}' not documented in README`,
              issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B
            });
          }
        }
      }
      // Category A licenses are automatically compliant
    }
  }

  return {
    compliant: issues.length === 0,
    issues
  };
}
