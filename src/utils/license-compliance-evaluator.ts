import { CriterionResult, EvaluationStatus, LicenseIssueType, Dependency, ComplianceResult, DependencyExtractionError } from '../types';
import { getDependencies } from './dependency-orchestrator';
import { checkLicenseCompliance } from './license-compliance';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';

/**
 * Format extraction errors into a detailed string for inclusion in criterion results.
 */
export function formatExtractionErrors(errors: DependencyExtractionError[]): string {
  return errors
    .map(e => {
      const baseMessage = `  - [${e.source}] ${e.message}`;
      if (e.error && e.error.message && !e.message.includes(e.error.message)) {
        const stackInfo = e.error.stack ? `\n    Stack: ${e.error.stack.split('\n')[1]}` : '';
        return `${baseMessage}\n    Details: ${e.error.message}${stackInfo}`;
      }
      return baseMessage;
    })
    .join('\n');
}

/**
 * Find and read README content from a repository, checking common filename variants.
 */
export function findReadmeContent(repoPath: string): string {
  const readmeFiles = ['README.md', 'README.txt', 'README', 'readme.md', 'readme.txt'];

  for (const readmeFile of readmeFiles) {
    const readmePath = path.join(repoPath, readmeFile);
    if (fs.existsSync(readmePath)) {
      return fs.readFileSync(readmePath, 'utf-8');
    }
  }
  return '';
}

/**
 * Build an evidence summary string from a list of dependencies.
 */
export function buildEvidenceSummary(dependencies: Dependency[]): string {
  const dependencyCount = dependencies.length;
  const licenseInfo = dependencies
    .filter(d => d.licenses && d.licenses.length > 0)
    .map(d => `${d.name}:${d.version} (${d.licenses!.join(', ')})`)
    .join('; ');

  return `Found ${dependencyCount} dependencies. ` +
    (licenseInfo ? `Licenses: ${licenseInfo}` : 'No license information available for analysis.');
}

/**
 * Determine the final CriterionResult based on compliance result, evidence, and warnings.
 */
export function determineComplianceStatus(
  criterionId: string,
  complianceResult: ComplianceResult,
  evidence: string,
  warnings: DependencyExtractionError[],
  hasFallbackWarning: boolean
): CriterionResult {
  const warningInfo = warnings.length > 0
    ? `\n\nExtraction warnings:\n${warnings.map(w => `  - [${w.source}] ${w.message}`).join('\n')}`
    : '';

  if (complianceResult.compliant) {
    if (hasFallbackWarning) {
      return {
        criterionId,
        status: EvaluationStatus.MANUAL,
        evidence,
        details: `License compliance check passed for analyzed dependencies, but MANUAL REVIEW REQUIRED.\n\n⚠️  WARNING: Only direct dependencies were analyzed. Transitive dependencies are unavailable and were not included in this analysis. Full license compliance cannot be verified without analyzing all transitive dependencies.${warningInfo}`
      };
    }

    return {
      criterionId,
      status: EvaluationStatus.PASS,
      evidence,
      details: `All third-party dependencies comply with ASF 3rd Party License Policy. No Category X licenses found, and all Category B licenses are properly documented.${warningInfo}`
    };
  }

  // Generate detailed compliance issues
  const issueDetails = complianceResult.issues
    .map(issue => `• ${issue.dependency.name}:${issue.dependency.version} - ${issue.reason}`)
    .join('\n');

  const hasCategoryXViolation = complianceResult.issues.some(issue =>
    issue.issueType === LicenseIssueType.CATEGORY_X_VIOLATION
  );

  const allIssuesAreManualReview = complianceResult.issues.every(issue =>
    issue.issueType === LicenseIssueType.UNKNOWN_LICENSE ||
    issue.issueType === LicenseIssueType.UNDOCUMENTED_CATEGORY_B ||
    issue.issueType === LicenseIssueType.NO_LICENSE_INFO
  );

  if (hasCategoryXViolation) {
    return {
      criterionId,
      status: EvaluationStatus.FAIL,
      evidence,
      details: `Third-party license compliance issues found. Please resolve these issues according to ASF 3rd Party License Policy:\n${issueDetails}${warningInfo}`
    };
  }

  if (allIssuesAreManualReview) {
    return {
      criterionId,
      status: EvaluationStatus.MANUAL,
      evidence,
      details: `Third-party license compliance issues require manual review. Please verify these dependencies comply with ASF 3rd Party License Policy:\n${issueDetails}${warningInfo}`
    };
  }

  return {
    criterionId,
    status: EvaluationStatus.MANUAL,
    evidence,
    details: `Third-party license compliance issues found. Please review these issues according to ASF 3rd Party License Policy:\n${issueDetails}${warningInfo}`
  };
}

/**
 * Evaluates third-party license compliance (S003) for any project type.
 * This is a language-agnostic evaluation that works with Maven, Gradle, and npm projects
 * through the dependency-orchestrator auto-detection.
 *
 * @param repoPath Path to the repository to evaluate
 * @returns CriterionResult for S003 evaluation
 */
export async function evaluateS003ThirdPartyLicenses(repoPath: string): Promise<CriterionResult> {
  try {
    const extractionResult = await getDependencies(repoPath);
    const { dependencies, errors, warnings } = extractionResult;

    if (errors.length > 0) {
      const errorDetails = formatExtractionErrors(errors);
      return {
        criterionId: 'S003',
        status: EvaluationStatus.MANUAL,
        evidence: `Failed to extract dependencies due to ${errors.length} error(s)`,
        details: `Dependency extraction errors:\n${errorDetails}\n\nManual review required to verify third-party license compliance.`
      };
    }

    if (dependencies.length === 0) {
      const warningInfo = warnings.length > 0
        ? `\n\nWarnings:\n${warnings.map(w => `  - [${w.source}] ${w.message}`).join('\n')}`
        : '';

      return {
        criterionId: 'S003',
        status: EvaluationStatus.MANUAL,
        evidence: 'No third-party dependencies found',
        details: `Repository appears to have no third-party dependencies. This is uncommon and may indicate a library project, configuration-only project, or build tool detection issue. Manual review required to confirm compliance.${warningInfo}`
      };
    }

    const readmeContent = findReadmeContent(repoPath);
    const complianceResult = checkLicenseCompliance(dependencies, readmeContent);
    const evidence = buildEvidenceSummary(dependencies);

    const hasFallbackWarning = warnings.some(w =>
      w.message.includes('transitive dependencies unavailable') ||
      w.message.includes('fallback') ||
      w.message.includes('Fallback mode')
    );

    return determineComplianceStatus('S003', complianceResult, evidence, warnings, hasFallbackWarning);

  } catch (error) {
    getLogger().warn('Error evaluating S003:', error);
    return {
      criterionId: 'S003',
      status: EvaluationStatus.MANUAL,
      evidence: 'Error occurred during dependency analysis',
      details: `Failed to analyze third-party license compliance: ${error instanceof Error ? error.message : 'Unknown error'}. Manual review required.`
    };
  }
}
