import { BaseSectionEvaluator } from '../base/section-evaluator';
import { CriterionResult, EvaluationStatus, CriterionFunction } from '../../types';
import { LicenseUtils } from '../../utils/license-utils';
import { getDependencies } from '../../utils/dependency-orchestrator';
import { checkLicenseCompliance } from '../../utils/license-compliance';
import { SHARED_CRITERIA } from '../../criteria-definitions';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Evaluator for Shared/Common criteria (S001-S014)
 * Handles shared requirements that apply to all FOLIO modules
 */
export class SharedEvaluator extends BaseSectionEvaluator {
  readonly sectionName = 'Shared/Common';
  readonly criteriaIds = Array.from(SHARED_CRITERIA);

  private evaluationMap: Map<string, CriterionFunction>;

  constructor() {
    super();
    this.evaluationMap = new Map<string, CriterionFunction>([
      ['S001', this.evaluateS001.bind(this)],
      ['S002', this.evaluateS002.bind(this)],
      ['S003', this.evaluateS003.bind(this)],
      ['S004', this.evaluateS004.bind(this)],
      ['S005', this.evaluateS005.bind(this)],
      ['S006', this.evaluateS006.bind(this)],
      ['S007', this.evaluateS007.bind(this)],
      ['S008', this.evaluateS008.bind(this)],
      ['S009', this.evaluateS009.bind(this)],
      ['S010', this.evaluateS010.bind(this)],
      ['S011', this.evaluateS011.bind(this)],
      ['S012', this.evaluateS012.bind(this)],
      ['S013', this.evaluateS013.bind(this)],
      ['S014', this.evaluateS014.bind(this)]
    ]);
  }

  /**
   * Evaluate specific shared criterion
   * @param criterionId The ID of the criterion to evaluate
   * @param repoPath Path to the cloned repository
   * @returns Promise<CriterionResult> Result of the specific criterion
   */
  protected async evaluateSpecificCriterion(criterionId: string, repoPath: string): Promise<CriterionResult> {
    const evaluator = this.evaluationMap.get(criterionId);
    if (!evaluator) {
      throw new Error(`Unknown shared criterion: ${criterionId}`);
    }
    return await evaluator(repoPath);
  }

  // STUB IMPLEMENTATIONS - Framework provides structure but evaluation logic not yet implemented
  // All methods below currently return MANUAL status and require detailed implementation
  // Future implementation will analyze repository files to determine PASS/FAIL status

  private async evaluateS001(repoPath: string): Promise<CriterionResult> {
    return await LicenseUtils.checkApache2License(repoPath, 'S001');
  }

  private async evaluateS002(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S002', 'Module descriptor validation');
  }

  private async evaluateS003(repoPath: string): Promise<CriterionResult> {
    try {
      // Extract dependencies from the repository
      const extractionResult = await getDependencies(repoPath);
      const { dependencies, errors, warnings } = extractionResult;

      // Check if there were fatal errors during extraction
      if (errors.length > 0) {
        const errorDetails = errors
          .map(e => `  - [${e.source}] ${e.message}`)
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

        return {
          criterionId: 'S003',
          status: EvaluationStatus.FAIL,
          evidence: evidence,
          details: `Third-party license compliance issues found. Please resolve these issues according to ASF 3rd Party License Policy:\n${issueDetails}${warningInfo}`
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

  private async evaluateS004(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S004', 'README file evaluation');
  }

  private async evaluateS005(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S005', 'Version control and branching strategy');
  }

  private async evaluateS006(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S006', 'Code quality and static analysis');
  }

  private async evaluateS007(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S007', 'Testing requirements');
  }

  private async evaluateS008(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S008', 'Documentation requirements');
  }

  private async evaluateS009(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S009', 'Security requirements');
  }

  private async evaluateS010(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S010', 'Performance requirements');
  }

  private async evaluateS011(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S011', 'Accessibility requirements');
  }

  private async evaluateS012(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S012', 'Internationalization requirements');
  }

  private async evaluateS013(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S013', 'Configuration management');
  }

  private async evaluateS014(_repoPath: string): Promise<CriterionResult> {
    return this.createNotApplicableResult('S014', 'Monitoring and logging');
  }
}
