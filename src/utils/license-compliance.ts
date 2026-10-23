/**
 * Language-agnostic license compliance checking utilities
 *
 * Provides compliance checking logic that can be used by any language evaluator.
 * Checks dependencies against Apache Software Foundation (ASF) license policy categories.
 *
 * PARSER CONTRACT:
 * Build tool-specific parsers (Maven, Gradle, npm, Go, etc.) MUST:
 * 1. Split dual/multi-licenses into separate array entries
 *    - Example: "Apache-2.0|MIT" → ["Apache-2.0", "MIT"]
 *    - Each ecosystem may use different separators (Maven: "|", npm: " OR ", etc.)
 *    - Licenses that all apply (SPDX " AND ") form one entry as a nested array, which passes
 *      only when every license in it passes. Example: "MIT AND Zlib" → [["MIT", "Zlib"]]
 * 2. Normalize license names where possible
 * 3. Return licenses as an array in the Dependency object
 *
 * This module validates the contract and will report parser violations as compliance errors.
 * Dependencies with unsplit licenses (containing '|', 'OR', 'AND') will fail compliance.
 */

import { Dependency, ComplianceResult, ComplianceIssue, EvaluationStatus, LicenseIssueType } from '../types';
import {
  LicenseCategory,
  getLicenseCategoryNormalized,
  isListedLicenseName,
  isSpecialException
} from './license-policy';
import { isNonEmptyString, isValidDependency } from './type-guards';
import { escapeRegExp } from './regexp';
import { getLogger } from './logger';

interface LicenseEvaluation {
  license: string;
  category?: LicenseCategory;
  status: EvaluationStatus;
  reason: string;
  issueType?: LicenseIssueType;
}

function isLGPLLicense(license: string): boolean {
  if (!isNonEmptyString(license)) {
    return false;
  }
  const lower = license.toLowerCase();
  return lower.includes('lgpl') || lower.includes('lesser general public');
}

/**
 * Check if the README names a dependency. Per the ASF policy, a README label must identify the
 * product, so the README has to name the dependency itself: its full name or, for Maven and
 * Gradle coordinates, its artifactId. A license family keyword alone does not count.
 * @param dependency - Dependency to check
 * @param readmeContent - Content of README file
 * @returns True if the README names the dependency
 */
function isDocumentedInReadme(dependency: Dependency, readmeContent: string): boolean {
  if (!isValidDependency(dependency) || typeof readmeContent !== 'string') {
    return false;
  }

  const names = new Set([dependency.name, dependency.name.split(':').pop()!].filter(isNonEmptyString));
  return [...names].some(name =>
    new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w-]|\\.\\w)`, 'i').test(readmeContent)
  );
}

function evaluateLicense(license: string, dependency: Dependency, readmeContent: string): LicenseEvaluation {
  const category = getLicenseCategoryNormalized(license);

  if (!category) {
    return {
      license,
      status: EvaluationStatus.MANUAL,
      reason: `'${license}' is not in the evaluator's list of known licenses.`,
      issueType: LicenseIssueType.UNKNOWN_LICENSE
    };
  }
  if (category === LicenseCategory.A) {
    return {
      license,
      category,
      status: EvaluationStatus.PASS,
      reason: `'${license}' is allowed (Category A).`
    };
  }
  if (category === LicenseCategory.B || category === LicenseCategory.B_WCL) {
    if (isDocumentedInReadme(dependency, readmeContent)) {
      return {
        license,
        category,
        status: EvaluationStatus.PASS,
        reason: `'${license}' (Category B) and the README names this dependency.`
      };
    }
    return {
      license,
      category,
      status: EvaluationStatus.FAIL,
      reason: `'${license}' is a Category B license, and the README does not name this dependency.`,
      issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B
    };
  }
  // Category X - prohibited, but LGPL special exceptions pass when the README names them
  if (isLGPLLicense(license) && isSpecialException(dependency.name)) {
    if (isDocumentedInReadme(dependency, readmeContent)) {
      return {
        license,
        category,
        status: EvaluationStatus.PASS,
        reason: `'${license}' is allowed for this library because the README names it.`
      };
    }
    return {
      license,
      category,
      status: EvaluationStatus.FAIL,
      reason: `'${license}' is allowed for this library only if the README names it, and it does not.`,
      issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B
    };
  }
  return {
    license,
    category,
    status: EvaluationStatus.FAIL,
    reason: `'${license}' is prohibited (Category X).`,
    issueType: LicenseIssueType.CATEGORY_X_VIOLATION
  };
}

/**
 * Evaluate one alternative: a single license, or licenses that all apply (SPDX AND), which pass
 * only when every one of them passes.
 */
function evaluateAlternative(alternative: string | string[], dependency: Dependency, readmeContent: string): LicenseEvaluation {
  if (!Array.isArray(alternative)) {
    return evaluateLicense(alternative, dependency, readmeContent);
  }
  const evaluations = alternative.map(license => evaluateLicense(license, dependency, readmeContent));
  return evaluations.find(e => e.issueType === LicenseIssueType.CATEGORY_X_VIOLATION) ??
    evaluations.find(e => e.status === EvaluationStatus.FAIL) ??
    evaluations.find(e => e.status === EvaluationStatus.MANUAL) ?? {
      license: licenseText(alternative),
      status: EvaluationStatus.PASS,
      reason: `Every license in '${licenseText(alternative)}' is allowed.`
    };
}

/** The display text of an alternative, with licenses that all apply joined by AND. */
export function licenseText(alternative: string | string[]): string {
  return Array.isArray(alternative) ? alternative.join(' AND ') : alternative;
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
  licenses: Array<string | string[]>,
  dependency: Dependency,
  readmeContent: string
): LicenseEvaluation {
  if (!Array.isArray(licenses) || licenses.length === 0) {
    return {
      license: 'Unknown',
      status: EvaluationStatus.MANUAL,
      reason: 'No license was reported.',
      issueType: LicenseIssueType.NO_LICENSE_INFO
    };
  }

  const evaluations: LicenseEvaluation[] = [];

  for (const license of licenses) {
    const evaluation = evaluateAlternative(license, dependency, readmeContent);
    if (evaluation.category === LicenseCategory.A) {
      return evaluation;
    }
    evaluations.push(evaluation);
  }

  const passed = evaluations.find(e => e.status === EvaluationStatus.PASS);
  if (passed) {
    return passed;
  }

  const hasUnknown = evaluations.some(e => e.status === EvaluationStatus.MANUAL);
  if (hasUnknown) {
    return {
      license: licenses.map(licenseText).join(' | '),
      status: EvaluationStatus.MANUAL,
      reason: `These licenses are not in the evaluator's list of known licenses: ${evaluations.filter(e => e.status === EvaluationStatus.MANUAL).map(e => `'${e.license}'`).join(', ')}.`,
      issueType: LicenseIssueType.UNKNOWN_LICENSE
    };
  }

  // Every alternative fails. Report an undocumented Category B one, which naming the dependency in
  // the README addresses, before Category X (an AND group reports Category X if it has one).
  return evaluations.find(e => e.issueType === LicenseIssueType.UNDOCUMENTED_CATEGORY_B) ??
    evaluations.find(e => e.status === EvaluationStatus.FAIL)!;
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
    if (!isValidDependency(dependency)) {
      continue;
    }

    if (!dependency.licenses || !Array.isArray(dependency.licenses) || dependency.licenses.length === 0) {
      issues.push({
        dependency,
        reason: 'No license was reported.',
        issueType: LicenseIssueType.NO_LICENSE_INFO
      });
      continue;
    }

    const allLicenses = dependency.licenses.filter(license => Array.isArray(license) || isNonEmptyString(license));

    if (allLicenses.length === 0) {
      issues.push({
        dependency,
        reason: 'No license was reported.',
        issueType: LicenseIssueType.NO_LICENSE_INFO
      });
      continue;
    }

    // Only uppercase OR/AND count as separators, to avoid false positives with license names like
    // "Common Development and Distribution License" that contain lowercase "and".
    // A name the policy lists exactly, such as "GPL-2.0-only WITH Classpath-exception-2.0", is a single license.
    const unsplitLicenses = allLicenses.flat().filter(license => !isListedLicenseName(license) && (
      license.includes('|') ||
      license.includes(' OR ') ||
      license.includes(' AND ') ||
      (license.includes('(') && license.includes(')')) || // Unsplit complex expressions
      license.includes(' WITH ') // SPDX exceptions
    ));
    if (unsplitLicenses.length > 0) {
      getLogger().error(
        `Parser contract violation for ${dependency.name}: ` +
        `Licenses contain separators ('|', 'OR', 'AND', parentheses, 'WITH') but should be pre-split. ` +
        `Found: ${unsplitLicenses.join(', ')}. ` +
        `Parsers must split dual/multi-licenses and normalize expressions before passing to compliance checker.`
      );
      issues.push({
        dependency,
        reason: `The license text combines several licenses and could not be checked: ${unsplitLicenses.map(license => `'${license}'`).join(', ')}.`,
        issueType: LicenseIssueType.PARSER_ERROR
      });
      continue;
    }

    const evaluation = allLicenses.length > 1
      ? evaluateMultipleLicenses(allLicenses, dependency, readmeContent)
      : evaluateAlternative(allLicenses[0], dependency, readmeContent);

    if (evaluation.status === EvaluationStatus.FAIL ||
        evaluation.status === EvaluationStatus.MANUAL) {
      issues.push({
        dependency,
        reason: evaluation.reason,
        issueType: evaluation.issueType!
      });
    }
  }

  return {
    compliant: issues.length === 0,
    issues
  };
}
