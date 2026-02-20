import { EvaluationStatus, LicenseIssueType, ComplianceResult, DependencyExtractionError, Dependency } from '../types';
import { formatExtractionErrors, determineComplianceStatus } from '../utils/license-compliance-evaluator';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';

beforeEach(() => {
  setLogger(new NoopLogger());
});

afterEach(() => {
  resetLogger();
});

describe('formatExtractionErrors', () => {
  it('should format a basic error with no nested error', () => {
    const errors: DependencyExtractionError[] = [
      { source: 'maven-parser', message: 'Build failed' }
    ];
    const result = formatExtractionErrors(errors);
    expect(result).toBe('  - [maven-parser] Build failed');
  });

  it('should not duplicate message when nested error.message matches outer message', () => {
    const errors: DependencyExtractionError[] = [
      {
        source: 'gradle-parser',
        message: 'Command timed out',
        error: new Error('Command timed out')
      }
    ];
    const result = formatExtractionErrors(errors);
    // Should NOT append "Details:" since the message is already included
    expect(result).toBe('  - [gradle-parser] Command timed out');
    expect(result).not.toContain('Details:');
  });

  it('should append Details when nested error.message differs from outer message', () => {
    const errors: DependencyExtractionError[] = [
      {
        source: 'npm-parser',
        message: 'License extraction failed',
        error: new Error('ENOENT: no such file')
      }
    ];
    const result = formatExtractionErrors(errors);
    expect(result).toContain('  - [npm-parser] License extraction failed');
    expect(result).toContain('Details: ENOENT: no such file');
  });

  it('should include stack trace first line when present', () => {
    const err = new Error('Something broke');
    // Error stack includes the message line + call frames
    const errors: DependencyExtractionError[] = [
      {
        source: 'maven-parser',
        message: 'Parse error',
        error: err
      }
    ];
    const result = formatExtractionErrors(errors);
    expect(result).toContain('Details: Something broke');
    expect(result).toContain('Stack:');
  });

  it('should format multiple errors joined by newlines', () => {
    const errors: DependencyExtractionError[] = [
      { source: 'maven-parser', message: 'Error one' },
      { source: 'gradle-parser', message: 'Error two' }
    ];
    const result = formatExtractionErrors(errors);
    const lines = result.split('\n');
    expect(lines[0]).toBe('  - [maven-parser] Error one');
    expect(lines[1]).toBe('  - [gradle-parser] Error two');
  });
});

describe('determineComplianceStatus', () => {
  const evidence = 'Found 5 dependencies. Licenses: foo:1.0 (MIT)';

  it('should return PASS when compliant with no fallback warning', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const result = determineComplianceStatus('S003', complianceResult, evidence, [], false);

    expect(result.criterionId).toBe('S003');
    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.details).toContain('All third-party dependencies comply');
  });

  it('should return MANUAL when compliant but has fallback warning', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const result = determineComplianceStatus('S003', complianceResult, evidence, [], true);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('MANUAL REVIEW REQUIRED');
    expect(result.details).toContain('Transitive dependencies are unavailable');
  });

  it('should return FAIL when Category X violation is present', () => {
    const complianceResult: ComplianceResult = {
      compliant: false,
      issues: [{
        dependency: { name: 'bad-lib', version: '1.0' },
        reason: 'GPL-3.0 is Category X',
        issueType: LicenseIssueType.CATEGORY_X_VIOLATION
      }]
    };
    const result = determineComplianceStatus('S003', complianceResult, evidence, [], false);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.details).toContain('bad-lib:1.0');
    expect(result.details).toContain('GPL-3.0 is Category X');
  });

  it('should return MANUAL when all issues are manual-review types', () => {
    const complianceResult: ComplianceResult = {
      compliant: false,
      issues: [
        {
          dependency: { name: 'unknown-lib', version: '2.0' },
          reason: 'Unknown license: CustomLicense',
          issueType: LicenseIssueType.UNKNOWN_LICENSE
        },
        {
          dependency: { name: 'no-license-lib', version: '3.0' },
          reason: 'No license info',
          issueType: LicenseIssueType.NO_LICENSE_INFO
        }
      ]
    };
    const result = determineComplianceStatus('S003', complianceResult, evidence, [], false);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('require manual review');
  });

  it('should return MANUAL for mixed non-Category-X issues', () => {
    const complianceResult: ComplianceResult = {
      compliant: false,
      issues: [
        {
          dependency: { name: 'lib-a', version: '1.0' },
          reason: 'Unknown license',
          issueType: LicenseIssueType.UNKNOWN_LICENSE
        },
        {
          dependency: { name: 'lib-b', version: '1.0' },
          reason: 'Parser error',
          issueType: LicenseIssueType.PARSER_ERROR
        }
      ]
    };
    const result = determineComplianceStatus('S003', complianceResult, evidence, [], false);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Please review these issues');
  });

  it('should append extraction warnings when present', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const warnings: DependencyExtractionError[] = [
      { source: 'gradle-parser', message: 'No Gradle wrapper found' }
    ];
    const result = determineComplianceStatus('S003', complianceResult, evidence, warnings, false);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.details).toContain('Extraction warnings:');
    expect(result.details).toContain('[gradle-parser] No Gradle wrapper found');
  });

  it('should use the provided criterionId', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const result = determineComplianceStatus('CUSTOM01', complianceResult, evidence, [], false);

    expect(result.criterionId).toBe('CUSTOM01');
  });
});
