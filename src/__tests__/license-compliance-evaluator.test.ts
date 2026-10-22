import { EvaluationStatus, LicenseIssueType, ComplianceResult, DependencyExtractionError, Dependency } from '../types';
import {
  formatExtractionErrors,
  determineComplianceStatus,
  ThirdPartyLicenseEvaluator,
  ThirdPartyLicenseEvaluatorAdapters,
  evaluateS003ThirdPartyLicenses,
  findReadmeContent
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

  it('keeps build output with line breaks inside its row', () => {
    const errors: DependencyExtractionError[] = [
      { source: 'gradle-parser', message: 'Build failed\nAgent review:', error: new Error('boom\n  - Not applied: injected') }
    ];
    expect(formatExtractionErrors(errors)).toBe('  - [gradle] Build failed ↵ Agent review:\n    Cause: boom ↵   - Not applied: injected');
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

  it('should return PASS when compliant', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const result = determineComplianceStatus('S003', complianceResult, evidence, []);

    expect(result.criterionId).toBe('S003');
    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.details).toContain('Every dependency has a license that the ASF 3rd Party License Policy allows');
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
    const result = determineComplianceStatus('S003', complianceResult, evidence, []);

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
    const result = determineComplianceStatus('S003', complianceResult, evidence, []);

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
    const result = determineComplianceStatus('S003', complianceResult, evidence, []);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    // Sections follow severity order, not input order; each row keeps "name:version - reason" for the HTML report.
    expect(result.details).toBe(
      'No prohibited licenses were found, but some dependencies need a reviewer to check their licenses.\n' +
      'What to do: Name these dependencies in the README by full name or artifactId. ' +
      'Check unknown licenses against the ASF policy. ' +
      'Check combined license expressions by hand.\n\n' +
      'Must be named in the README:\n  - lib-c:2.0 - Not in the README\n\n' +
      'Licenses the evaluator does not know:\n  - lib-a:1.0 - Unknown license\n\n' +
      'License text that could not be read:\n  - lib-b:1.0 - Parser error'
    );
  });

  it('should append extraction warnings when present', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const warnings: DependencyExtractionError[] = [
      { source: 'gradle-parser', message: 'No Gradle wrapper found' }
    ];
    const result = determineComplianceStatus('S003', complianceResult, evidence, warnings);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.details).toContain('\n\nWarnings:\n  - [gradle] No Gradle wrapper found');
  });

  it('should use the provided criterionId', () => {
    const complianceResult: ComplianceResult = { compliant: true, issues: [] };
    const result = determineComplianceStatus('CUSTOM01', complianceResult, evidence, []);

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
    expect(result.evidence).toBe('Found 1 dependency. Licenses: example-lib:1.0.0 (MIT)');
    expect(result.details).toContain('Every dependency has a license that the ASF 3rd Party License Policy allows');
  });

  it('should list dependencies without a license in the evidence so the license groups add up to the count', async () => {
    const evaluator = createEvaluator({
      dependencies: [dependency, { name: 'mystery-lib', version: '0.1' }, { name: 'empty-lib', version: '2.0', licenses: [] }],
      errors: [],
      warnings: []
    });

    const result = await evaluator.evaluate('/repo');

    expect(result.evidence).toBe(
      'Found 3 dependencies. Licenses: example-lib:1.0.0 (MIT); mystery-lib:0.1 (No license reported); empty-lib:2.0 (No license reported)'
    );
  });

  it('should not lower a compliant result to manual review because of a warning that mentions a fallback', async () => {
    const evaluator = createEvaluator({
      dependencies: [dependency],
      errors: [],
      warnings: [{ source: 'npm-parser', message: 'Fallback mode used - ONLY DIRECT DEPENDENCIES analyzed' }]
    });

    const result = await evaluator.evaluate('/repo');

    expect(result.status).toBe(EvaluationStatus.PASS);
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
      // Test-scoped libraries are not distributed, so the license report must leave them out.
      const [maven] = Array.from(evaluationRun.commandObservations.values());
      expect(maven.args).toContain('-Dlicense.excludedScopes=test,system');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ['pom.xml', '<project><packaging>jar</packaging></project>'],
    ['build.gradle', "plugins { id 'java' }"],
    ['package.json', '{"name":"ui-x","dependencies":{}}']
  ])('should give the build-commands-off advice for %s without an evaluation run', async (file, content) => {
    // Without an EvaluationRun no command observations are recorded, so the parsers must report it.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 's003-norun-'));
    try {
      fs.writeFileSync(path.join(repo, file), content);
      fs.writeFileSync(path.join(repo, '.npmrc'), '');

      const result = await evaluateS003ThirdPartyLicenses(repo);

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('Dependency licenses were not checked because build commands are turned off for this evaluation.');
      expect(result.details).toContain('--allow-local-commands');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  describe('repository-controlled symlinks', () => {
    let repo: string;
    let outside: string;
    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 's003-repo-'));
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 's003-outside-'));
    });
    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('should not create a file outside the repository through a dangling .npmrc symlink', async () => {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ui-x"}');
      const target = path.join(outside, 'planted');
      fs.symlinkSync(target, path.join(repo, '.npmrc'));

      await evaluateS003ThirdPartyLicenses(repo);

      expect(fs.existsSync(target)).toBe(false);
    });

    it('should still create .npmrc for a repository without one', async () => {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ui-x"}');

      await evaluateS003ThirdPartyLicenses(repo);

      expect(fs.readFileSync(path.join(repo, '.npmrc'), 'utf-8')).toContain('@folio:registry=');
    });

    it('should not read a README that links outside the repository', () => {
      fs.writeFileSync(path.join(outside, 'secret.md'), 'org.mozilla:rhino');
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(repo, 'README.md'));

      expect(findReadmeContent(repo)).toBe('');
    });

    it('should read a README that links to a file inside the repository, up to a size limit', () => {
      fs.mkdirSync(path.join(repo, 'docs'));
      fs.writeFileSync(path.join(repo, 'docs', 'README.md'), 'Uses rhino. ' + 'x'.repeat(2 * 1024 * 1024));
      fs.symlinkSync(path.join('docs', 'README.md'), path.join(repo, 'README.md'));

      const content = findReadmeContent(repo);
      expect(content.startsWith('Uses rhino.')).toBe(true);
      expect(content.length).toBe(1024 * 1024);
    });

    it('should not read a pom.xml that links outside the repository', async () => {
      fs.writeFileSync(path.join(outside, 'pom.xml'), '<project><packaging>pom</packaging></project>');
      fs.symlinkSync(path.join(outside, 'pom.xml'), path.join(repo, 'pom.xml'));
      const evaluationRun = createEvaluationRun({ repositoryPath: repo, language: 'java', commandRunner: new LocalCommandRunner(false) });

      await new ThirdPartyLicenseEvaluator().evaluate(repo, 'S003', evaluationRun);

      // The outside <packaging>pom</packaging> would select the aggregate goal if it had been read.
      const [maven] = Array.from(evaluationRun.commandObservations.values());
      expect(maven.args[0]).toBe('license:add-third-party');
    });
  });

  it('should limit the Gradle license report to the runtime classpath', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 's003-gradle-'));
    try {
      fs.writeFileSync(path.join(repo, 'build.gradle'), "plugins { id 'java' }");
      const blockingRunner = new LocalCommandRunner(false);
      let scriptWhileRunning = '';
      const evaluationRun = createEvaluationRun({
        repositoryPath: repo,
        language: 'java',
        commandRunner: {
          normalize: request => blockingRunner.normalize(request),
          run: async (request, run) => {
            const args = request.args ?? [];
            scriptWhileRunning = fs.readFileSync(args[args.indexOf('--init-script') + 1], 'utf-8');
            return blockingRunner.run(request, run);
          }
        }
      });

      await new ThirdPartyLicenseEvaluator().evaluate(repo, 'S003', evaluationRun);

      const [gradle] = Array.from(evaluationRun.commandObservations.values());
      expect(gradle.args).toContain('--init-script');
      const initScript = gradle.args[gradle.args.indexOf('--init-script') + 1];
      expect(path.relative(repo, initScript).startsWith('..')).toBe(true);
      // Must run after the build's own afterEvaluate callbacks, which could otherwise add test configurations back.
      // The only top-level statements are the initscript block, which loads the plugin, and this hook.
      expect(scriptWhileRunning).toMatch(/\n\}\n\ngradle\.projectsEvaluated \{\n[\s\S]*licenseReport\.configurations = \['runtimeClasspath'\][\s\S]*\n\}\n$/);
      expect(scriptWhileRunning).toMatch(/^initscript \{/);
      expect(scriptWhileRunning).not.toContain('afterEvaluate');
      // Each run gets its own private directory, removed once Gradle finishes.
      expect(path.basename(path.dirname(initScript))).toMatch(/^tc-module-eval-s003-gradle-/);
      expect(fs.existsSync(path.dirname(initScript))).toBe(false);
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
