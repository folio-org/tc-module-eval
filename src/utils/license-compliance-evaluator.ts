import { CriterionResult, EvaluationStatus, LicenseIssueType } from '../types';
import { getDependencies } from './dependency-orchestrator';
import { checkLicenseCompliance } from './license-compliance';
import * as fs from 'fs';
import * as path from 'path';

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
    // Extract dependencies from the repository (auto-detects Maven, Gradle, npm)
    const extractionResult = await getDependencies(repoPath);
    const { dependencies, errors, warnings } = extractionResult;

    // Check if there were fatal errors during extraction
    if (errors.length > 0) {
      const errorDetails = errors
        .map(e => {
          const baseMessage = `  - [${e.source}] ${e.message}`;
          // Include the underlying error details if available and different from the main message
          if (e.error && e.error.message && !e.message.includes(e.error.message)) {
            return `${baseMessage}\n    Details: ${e.error.message}`;
          }
          return baseMessage;
        })
        .join('\n');

      return {
        criterionId: 'S003',
        status: EvaluationStatus.MANUAL,
        evidence: `Failed to extract dependencies due to ${errors.length} error(s)`,
        details: `Dependency extraction errors:\n${errorDetails}\n\nManual review required to verify third-party license compliance.`
      };
    }

    // If no dependencies found but no errors, could be valid (project has no dependencies)
    if (dependencies.length === 0) {
      // Include warnings if present
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

    // Read README content for Category B license validation
    let readmeContent = '';
    const readmeFiles = ['README.md', 'README.txt', 'README', 'readme.md', 'readme.txt'];

    for (const readmeFile of readmeFiles) {
      const readmePath = path.join(repoPath, readmeFile);
      if (fs.existsSync(readmePath)) {
        readmeContent = fs.readFileSync(readmePath, 'utf-8');
        break;
      }
    }

    // Check license compliance according to ASF policy
    const complianceResult = checkLicenseCompliance(dependencies, readmeContent);

    // Generate evidence summary
    const dependencyCount = dependencies.length;
    const licenseInfo = dependencies
      .filter(d => d.licenses && d.licenses.length > 0)
      .map(d => `${d.name}:${d.version} (${d.licenses!.join(', ')})`)
      .join('; ');

    const evidence = `Found ${dependencyCount} dependencies. ` +
      (licenseInfo ? `Licenses: ${licenseInfo}` : 'No license information available for analysis.');

    // Include warnings in details if present
    const warningInfo = warnings.length > 0
      ? `\n\nExtraction warnings:\n${warnings.map(w => `  - [${w.source}] ${w.message}`).join('\n')}`
      : '';

    if (complianceResult.compliant) {
      return {
        criterionId: 'S003',
        status: EvaluationStatus.PASS,
        evidence: evidence,
        details: `All third-party dependencies comply with ASF 3rd Party License Policy. No Category X licenses found, and all Category B licenses are properly documented.${warningInfo}`
      };
    } else {
      // Generate detailed compliance issues
      const issueDetails = complianceResult.issues
        .map(issue => `• ${issue.dependency.name}:${issue.dependency.version} - ${issue.reason}`)
        .join('\n');

      // Determine if issues are failures or require manual review
      // Category X (prohibited) licenses should FAIL
      // Unknown licenses and undocumented Category B should be MANUAL
      const hasCategoryXViolation = complianceResult.issues.some(issue =>
        issue.issueType === LicenseIssueType.CATEGORY_X_VIOLATION
      );

      const allIssuesAreManualReview = complianceResult.issues.every(issue =>
        issue.issueType === LicenseIssueType.UNKNOWN_LICENSE ||
        issue.issueType === LicenseIssueType.UNDOCUMENTED_CATEGORY_B ||
        issue.issueType === LicenseIssueType.NO_LICENSE_INFO
      );

      // If there's a Category X violation, it's an automatic FAIL
      if (hasCategoryXViolation) {
        return {
          criterionId: 'S003',
          status: EvaluationStatus.FAIL,
          evidence: evidence,
          details: `Third-party license compliance issues found. Please resolve these issues according to ASF 3rd Party License Policy:\n${issueDetails}${warningInfo}`
        };
      }

      // If all issues are manual review items (unknown licenses, undocumented Category B)
      if (allIssuesAreManualReview) {
        return {
          criterionId: 'S003',
          status: EvaluationStatus.MANUAL,
          evidence: evidence,
          details: `Third-party license compliance issues require manual review. Please verify these dependencies comply with ASF 3rd Party License Policy:\n${issueDetails}${warningInfo}`
        };
      }

      // Default to MANUAL for safety (mixed issues or unexpected patterns)
      return {
        criterionId: 'S003',
        status: EvaluationStatus.MANUAL,
        evidence: evidence,
        details: `Third-party license compliance issues found. Please review these issues according to ASF 3rd Party License Policy:\n${issueDetails}${warningInfo}`
      };
    }

  } catch (error) {
    console.warn('Error evaluating S003:', error);
    return {
      criterionId: 'S003',
      status: EvaluationStatus.MANUAL,
      evidence: 'Error occurred during dependency analysis',
      details: `Failed to analyze third-party license compliance: ${error instanceof Error ? error.message : 'Unknown error'}. Manual review required.`
    };
  }
}
