import * as fs from 'fs-extra';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { CriterionResult, EvaluationStatus } from '../types';

const LICENSE_FILES = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'LICENCE.txt'];
const NO_LICENSE_FILE_ROW = `License file: none (looked for ${LICENSE_FILES.join(', ')})`;
const MAX_FIRST_LINE_LENGTH = 120;

/**
 * Result of a license check operation
 */
export interface LicenseCheckResult {
  found: boolean;
  isApache2: boolean;
  source: string;
  details: string;
}

/**
 * Utility class for license detection across all FOLIO module types
 * Provides language-agnostic license checking with optional language-specific extensions
 */
export class LicenseUtils {
  /**
   * Main entry point for Apache 2.0 license evaluation
   * @param repoPath Path to the cloned repository
   * @param criterionId The criterion ID for result creation
   * @returns Promise<CriterionResult> Result of the license evaluation
   */
  static async checkApache2License(repoPath: string, criterionId: string): Promise<CriterionResult> {
    try {
      // Check for license in LICENSE files (universal)
      const licenseFileResult = await this.checkLicenseFiles(repoPath);
      if (licenseFileResult) {
        return this.createResult(criterionId, licenseFileResult);
      }

      // Check for license in Maven pom.xml (Java-specific)
      const pomLicenseResult = await this.checkMavenLicense(repoPath);
      if (pomLicenseResult) {
        return this.createResult(criterionId, pomLicenseResult);
      }

      // TODO: Add other build file checks here
      // - checkPackageJsonLicense() for Node.js modules
      // - checkGradleLicense() for Gradle projects
      // - checkSetupPyLicense() for Python modules

      // No license found
      return this.createFailResult(
        criterionId,
        'No license found: there is no top-level LICENSE file, and no license is declared in pom.xml. Add a top-level LICENSE file with the Apache License 2.0 text.',
        `${NO_LICENSE_FILE_ROW}\nAlso checked: licenses declared in pom.xml (none found)`
      );
    } catch (error) {
      return this.createErrorResult(criterionId, error);
    }
  }

  /**
   * Check for Apache 2.0 license in LICENSE files
   * This is the primary, language-agnostic license detection method
   * @param repoPath Path to the cloned repository
   * @returns Promise<LicenseCheckResult | null> Result or null if no license files found
   */
  static async checkLicenseFiles(repoPath: string): Promise<LicenseCheckResult | null> {
    for (const fileName of LICENSE_FILES) {
      const filePath = path.join(repoPath, fileName);
      if (await fs.pathExists(filePath)) {
        const content = await fs.readFile(filePath, 'utf-8');
        const isApache2 = this.isApache2License(content);

        // The first line usually names the license, which tells a reviewer what the file is instead.
        const firstLine = content.split('\n').map(line => line.trim()).find(Boolean);
        const startsWith = !firstLine
          ? '(empty file)'
          : firstLine.length > MAX_FIRST_LINE_LENGTH ? `${firstLine.slice(0, MAX_FIRST_LINE_LENGTH - 3)}...` : firstLine;

        return {
          found: true,
          isApache2,
          source: fileName,
          details: isApache2
            ? `License file: ${fileName}`
            : `License file: ${fileName}\nFile starts with: ${startsWith}`
        };
      }
    }

    return null;
  }

  /**
   * Check for Apache 2.0 license declaration in Maven pom.xml
   * Java/Maven-specific license detection
   * @param repoPath Path to the cloned repository
   * @returns Promise<LicenseCheckResult | null> Result or null if no pom.xml or license declaration
   */
  static async checkMavenLicense(repoPath: string): Promise<LicenseCheckResult | null> {
    const pomPath = path.join(repoPath, 'pom.xml');
    if (!(await fs.pathExists(pomPath))) {
      return null;
    }

    try {
      const pomContent = await fs.readFile(pomPath, 'utf-8');
      const parser = new xml2js.Parser();
      const pomData = await parser.parseStringPromise(pomContent);

      const licenses = pomData?.project?.licenses?.[0]?.license;
      if (!licenses) {
        return null;
      }

      // Check if any license is Apache 2.0
      const licenseArray = Array.isArray(licenses) ? licenses : [licenses];
      for (const license of licenseArray) {
        const name = license.name?.[0] || '';
        const url = license.url?.[0] || '';

        if (this.isApache2LicenseDeclaration(name, url)) {
          return {
            found: true,
            isApache2: true,
            source: 'pom.xml',
            details: [NO_LICENSE_FILE_ROW, `Declared license: ${name || '(no name given)'}`, ...(url ? [`License URL: ${url}`] : [])].join('\n')
          };
        }
      }

      // Found licenses but none are Apache 2.0
      const licenseNames = licenseArray.map(l => l.name?.[0]).filter(Boolean).join(', ');
      return {
        found: true,
        isApache2: false,
        source: 'pom.xml',
        details: `${NO_LICENSE_FILE_ROW}\nDeclared licenses: ${licenseNames || '(no name given)'}`
      };
    } catch (error) {
      // Unable to parse pom.xml
      return null;
    }
  }

  /**
   * Check if license content indicates Apache 2.0
   * @param content License file content
   * @returns boolean True if content appears to be Apache 2.0 license
   */
  static isApache2License(content: string): boolean {
    const normalizedContent = content.toLowerCase();
    return (
      normalizedContent.includes('apache license') &&
      normalizedContent.includes('version 2.0')
    ) || (
      normalizedContent.includes('apache software foundation') &&
      normalizedContent.includes('2.0')
    ) || (
      normalizedContent.includes('apache-2.0')
    );
  }

  /**
   * Check if Maven license declaration indicates Apache 2.0
   * @param name License name from pom.xml
   * @param url License URL from pom.xml
   * @returns boolean True if name/URL indicates Apache 2.0
   */
  static isApache2LicenseDeclaration(name: string, url: string): boolean {
    const normalizedName = name.toLowerCase();
    const normalizedUrl = url.toLowerCase();

    return (
      normalizedName.includes('apache') && normalizedName.includes('2.0')
    ) || (
      normalizedUrl.includes('apache.org/licenses/license-2.0')
    ) || (
      normalizedName.includes('apache-2.0')
    );
  }

  /**
   * Create a CriterionResult from a LicenseCheckResult
   * @param criterionId The criterion ID
   * @param licenseResult The license check result
   * @returns CriterionResult
   */
  private static createResult(criterionId: string, licenseResult: LicenseCheckResult): CriterionResult {
    const fromPom = licenseResult.source === 'pom.xml';
    if (licenseResult.isApache2) {
      return {
        criterionId,
        status: EvaluationStatus.PASS,
        evidence: fromPom
          ? 'pom.xml declares the Apache License 2.0. There is no top-level LICENSE file.'
          : `The ${licenseResult.source} file is the Apache License 2.0.`,
        details: licenseResult.details
      };
    } else {
      return {
        criterionId,
        status: EvaluationStatus.FAIL,
        evidence: fromPom
          ? 'There is no top-level LICENSE file, and pom.xml declares a license other than Apache 2.0. Add a top-level LICENSE file with the Apache License 2.0 text and declare Apache 2.0 in pom.xml.'
          : `The ${licenseResult.source} file is not the Apache License 2.0. FOLIO modules must use Apache 2.0; replace ${licenseResult.source} with the Apache License 2.0 text.`,
        details: licenseResult.details
      };
    }
  }

  /**
   * Create a FAIL result for no license found
   * @param criterionId The criterion ID
   * @param evidence Evidence message
   * @param details Additional details
   * @returns CriterionResult
   */
  private static createFailResult(criterionId: string, evidence: string, details: string): CriterionResult {
    return {
      criterionId,
      status: EvaluationStatus.FAIL,
      evidence,
      details
    };
  }

  /**
   * Create an error result when evaluation fails
   * @param criterionId The criterion ID
   * @param error The error that occurred
   * @returns CriterionResult
   */
  private static createErrorResult(criterionId: string, error: any): CriterionResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      criterionId,
      status: EvaluationStatus.MANUAL,
      evidence: 'The license check could not run, so a reviewer must check the license by hand.',
      details: `Error: ${errorMessage}\nWhat to check: the repository has a top-level LICENSE file with the Apache License 2.0 text`
    };
  }
}