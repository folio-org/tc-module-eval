import { EvaluationStatus, LicenseIssueType, ComplianceResult, DependencyExtractionError, Dependency } from '../types';
import {
  formatExtractionErrors,
  determineComplianceStatus,
  ThirdPartyLicenseEvaluator,
  ThirdPartyLicenseEvaluatorAdapters
} from '../utils/license-compliance-evaluator';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';
import { createEvaluationRun } from '../utils/evaluation-run';
import { LocalCommandRunner } from '../utils/command-runner';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    expect(result).toBe('  - [maven] Build failed');
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
    // Should NOT append "Cause:" since the message is already included
    expect(result).toBe('  - [gradle] Command timed out');
    expect(result).not.toContain('Cause:');
  });

  it('should append the cause when nested error.message differs from outer message', () => {
    const errors: DependencyExtractionError[] = [
      {
        source: 'npm-parser',
        message: 'License extraction failed',
        error: new Error('ENOENT: no such file')
      }
    ];
    const result = formatExtractionErrors(errors);
    expect(result).toBe('  - [npm] License extraction failed\n    Cause: ENOENT: no such file');
  });

  it('should leave stack traces out of the report', () => {
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
    expect(result).toBe('  - [maven] Parse error\n    Cause: Something broke');
  });

  it('should format multiple errors joined by newlines', () => {
    const errors: DependencyExtractionError[] = [
      { source: 'maven-parser', message: 'Error one' },
      { source: 'gradle-parser', message: 'Error two' }
    ];
    const result = formatExtractionErrors(errors);
    const lines = result.split('\n');
    expect(lines[0]).toBe('  - [maven] Error one');
    expect(lines[1]).toBe('  - [gradle] Error two');
  });
});

describe('determineComplianceStatus', () => {
  const evidence = 'Found 5 dependencies. Licenses: foo:1.0 (MIT)';

  it('should return PASS when compliant with no fallback warning', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const result = determineComplianceStatus('S003', complianceResult, evidence, [], false);

    expect(result.criterionId).toBe('S003');
    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.details).toContain('Every dependency has a license that the ASF 3rd Party License Policy allows');
  });

  it('should return MANUAL when compliant but has fallback warning', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const result = determineComplianceStatus('S003', complianceResult, evidence, [], true);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('only direct dependencies were checked');
    expect(result.details).toContain('What to do: Check the licenses of the transitive dependencies by hand.');
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
    expect(result.details).toBe(
      'Some dependencies use licenses that the ASF 3rd Party License Policy prohibits.\n' +
      'What to do: Remove or replace prohibited dependencies.\n\n' +
      'Prohibited licenses (Category X):\n' +
      '  - bad-lib:1.0 - GPL-3.0 is Category X'
    );
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
    expect(result.details).toContain('No prohibited licenses were found, but some dependencies need a reviewer to check their licenses.');
  });

  it('should return MANUAL for mixed non-Category-X issues, grouped by problem', () => {
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
        },
        {
          dependency: { name: 'lib-c', version: '2.0' },
          reason: 'Not in the README',
          issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B
        }
      ]
    };
    const result = determineComplianceStatus('S003', complianceResult, evidence, [], false);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    // Sections follow severity order, not input order; each row keeps "name:version - reason" for the HTML report.
    expect(result.details).toBe(
      'No prohibited licenses were found, but some dependencies need a reviewer to check their licenses.\n' +
      'What to do: List LGPL and Category B dependencies or their licenses in the README. ' +
      'Check unknown licenses against the ASF policy. ' +
      'Check combined license expressions by hand.\n\n' +
      'Must be mentioned in the README:\n  - lib-c:2.0 - Not in the README\n\n' +
      'Licenses the evaluator does not know:\n  - lib-a:1.0 - Unknown license\n\n' +
      'License text that could not be read:\n  - lib-b:1.0 - Parser error'
    );
  });

  it('should append extraction warnings when present', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const warnings: DependencyExtractionError[] = [
      { source: 'gradle-parser', message: 'No Gradle wrapper found' }
    ];
    const result = determineComplianceStatus('S003', complianceResult, evidence, warnings, false);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.details).toContain('\n\nWarnings:\n  - [gradle] No Gradle wrapper found');
  });

  it('should use the provided criterionId', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const result = determineComplianceStatus('CUSTOM01', complianceResult, evidence, [], false);

    expect(result.criterionId).toBe('CUSTOM01');
  });
});

describe('ThirdPartyLicenseEvaluator', () => {
  const dependency: Dependency = {
    name: 'example-lib',
    version: '1.0.0',
    licenses: ['MIT']
  };

  function createEvaluator(
    extraction: Awaited<ReturnType<ThirdPartyLicenseEvaluatorAdapters['extractDependencies']>>,
    complianceResult: ComplianceResult = { compliant: true, issues: [] },
    readmeContent: string = 'README content'
  ): ThirdPartyLicenseEvaluator {
    return new ThirdPartyLicenseEvaluator({
      extractDependencies: jest.fn().mockResolvedValue(extraction),
      readReadmeContent: jest.fn().mockReturnValue(readmeContent),
      checkCompliance: jest.fn().mockReturnValue(complianceResult)
    });
  }

  it('should return MANUAL when dependency extraction has errors', async () => {
    const evaluator = createEvaluator({
      dependencies: [],
      errors: [{ source: 'maven-parser', message: 'Build failed' }],
      warnings: []
    });

    const result = await evaluator.evaluate('/repo');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('Dependency licenses were not checked because the dependencies could not be listed.');
    expect(result.details).toContain('What to do: Fix the problem below and rerun the evaluation, or check the dependency licenses by hand.');
    expect(result.details).toContain('Why the dependencies could not be listed:\n  - [maven] Build failed');
  });

  it('should return MANUAL when no dependencies are found', async () => {
    const evaluator = createEvaluator({
      dependencies: [],
      errors: [],
      warnings: [{ source: 'dependency-orchestrator', message: 'No supported build tools found' }]
    });

    const result = await evaluator.evaluate('/repo');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('No third-party dependencies were found.');
    expect(result.details).toContain('What to do: Confirm that the module really has no third-party dependencies.');
    expect(result.details).toContain('Warnings:\n  - No supported build tools found');
  });

  it('should return PASS when dependencies are compliant', async () => {
    const evaluator = createEvaluator({
      dependencies: [dependency],
      errors: [],
      warnings: []
    });

    const result = await evaluator.evaluate('/repo');

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('Found 1 dependencies. Licenses: example-lib:1.0.0 (MIT)');
    expect(result.details).toContain('Every dependency has a license that the ASF 3rd Party License Policy allows');
  });

  it('should return MANUAL when compliant dependencies came from fallback extraction', async () => {
    const evaluator = createEvaluator({
      dependencies: [dependency],
      errors: [],
      warnings: [{ source: 'npm-parser', message: 'Fallback mode used - ONLY DIRECT DEPENDENCIES analyzed' }]
    });

    const result = await evaluator.evaluate('/repo');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('only direct dependencies were checked');
  });

  it('should return FAIL when Category X violations are present', async () => {
    const evaluator = createEvaluator(
      {
        dependencies: [dependency],
        errors: [],
        warnings: []
      },
      {
        compliant: false,
        issues: [{
          dependency,
          reason: 'License GPL-3.0 is in Category X (prohibited)',
          issueType: LicenseIssueType.CATEGORY_X_VIOLATION
        }]
      }
    );

    const result = await evaluator.evaluate('/repo');

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.details).toContain('License GPL-3.0 is in Category X');
  });

  it('should return MANUAL when compliance issues require manual review', async () => {
    const evaluator = createEvaluator(
      {
        dependencies: [dependency],
        errors: [],
        warnings: []
      },
      {
        compliant: false,
        issues: [{
          dependency,
          reason: 'Unknown license',
          issueType: LicenseIssueType.UNKNOWN_LICENSE
        }]
      }
    );

    const result = await evaluator.evaluate('/repo');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Licenses the evaluator does not know:\n  - example-lib:1.0.0 - Unknown license');
  });

  it('should explain how to rerun when build commands are turned off', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 's003-safe-'));
    try {
      fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><packaging>jar</packaging></project>');
      const evaluationRun = createEvaluationRun({
        repositoryPath: repo,
        language: 'java',
        commandRunner: new LocalCommandRunner(false)
      });

      const result = await new ThirdPartyLicenseEvaluator().evaluate(repo, 'S003', evaluationRun);

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('Dependency licenses were not checked because build commands are turned off for this evaluation.');
      expect(result.details).toContain('What to do: Rerun the evaluation with --allow-local-commands on a trusted machine, or check the dependency licenses by hand.');
      expect(result.details).toContain('Why the dependencies could not be listed:\n  - [maven] Maven could not list the dependencies: build commands are turned off for this evaluation\n\nBuild commands:');
      expect(result.details).toContain('Build commands:\n  - Not run: mvn license:add-third-party ');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('should return MANUAL when an adapter throws during evaluation', async () => {
    const evaluator = new ThirdPartyLicenseEvaluator({
      extractDependencies: jest.fn().mockRejectedValue(new Error('Dependency tool crashed')),
      readReadmeContent: jest.fn(),
      checkCompliance: jest.fn()
    });

    const result = await evaluator.evaluate('/repo');

    expect(result).toEqual({
      criterionId: 'S003',
      status: EvaluationStatus.MANUAL,
      evidence: 'The license check stopped with an unexpected error, so dependency licenses were not checked.',
      details: 'The license check stopped with an unexpected error: Dependency tool crashed.\nWhat to do: Check the dependency licenses by hand.'
    });
  });
});
