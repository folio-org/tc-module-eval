import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { ModuleEvaluator } from '../../module-evaluator';
import { ReportGenerator } from '../../utils/report-generator';
import { EvaluationConfig, EvaluationResult, EvaluationStatus, ReportOptions } from '../../types';

const GOLDEN_EVALUATED_AT = '<<normalized-evaluatedAt>>';
type NormalizedEvaluationReport = Omit<EvaluationResult, 'evaluatedAt'> & { evaluatedAt: string };

function normalizeEvaluationReport(report: EvaluationResult): NormalizedEvaluationReport {
  return {
    ...report,
    evaluatedAt: GOLDEN_EVALUATED_AT,
    criteria: report.criteria.map(criterion => criterion.criterionId === 'S005'
      ? normalizeS005GoldenCriterion(criterion)
      : criterion
    ),
  };
}

function normalizeS005GoldenCriterion(criterion: EvaluationResult['criteria'][number]): EvaluationResult['criteria'][number] {
  const details = criterion.criterionDetails as Record<string, any> | undefined;
  if (!details) {
    return criterion;
  }

  return {
    ...criterion,
    details: normalizeS005DetailsText(criterion.details),
    criterionDetails: {
      discovery: {
        status: details.discovery?.status,
        artifact: details.discovery?.artifact,
        attemptCount: details.discovery?.attempts?.length ?? 0,
        warningCount: details.discovery?.warnings?.length ?? 0
      },
      parseResult: details.parseResult
        ? {
            metadata: details.parseResult.metadata,
            checkedCategories: details.parseResult.checkedCategories,
            uncheckedCategories: details.parseResult.uncheckedCategories,
            completion: details.parseResult.completion,
            checklistItemCount: details.parseResult.checklistItems?.length ?? 0,
            placeholderCount: details.parseResult.placeholders?.length ?? 0,
            contradictionCount: details.parseResult.contradictions?.length ?? 0
          }
        : undefined,
      evidenceScan: details.evidenceScan
        ? {
            signalCount: details.evidenceScan.signalCount,
            scannedFileCount: details.evidenceScan.scannedFileCount,
            skippedFileCount: details.evidenceScan.skippedFiles?.length ?? 0,
            warningCount: details.evidenceScan.warnings?.length ?? 0
          }
        : undefined,
      classification: details.classification,
      agentReviewUnavailableReason: details.agentReviewUnavailableReason,
      possibleMismatchCount: details.possibleMismatches?.length ?? 0,
      matchingEvidenceCount: details.matchingEvidence?.length ?? 0,
      supportingEvidenceCount: details.supportingEvidence?.length ?? 0,
      uncheckedAnswerCount: details.uncheckedAnswerDetails?.length ?? 0,
      placeholderCount: details.placeholders?.length ?? 0,
      contradictionCount: details.contradictions?.length ?? 0,
      warningCount: details.warnings?.length ?? 0
    }
  };
}

function normalizeS005DetailsText(details: string | undefined): string | undefined {
  if (!details) {
    return details;
  }

  return details
    .split('\n')
    .filter(line =>
      line.startsWith('Artifact mechanics:') ||
      line.startsWith('Parsed disclosure fields:') ||
      line.startsWith('Deterministic evidence:') ||
      line.startsWith('Possible mismatches:') ||
      line.startsWith('Agent review:') ||
      line.includes('Repository kind:') ||
      line.includes('Required file:') ||
      line.includes('Discovery status:') ||
      line.includes('Parse state:') ||
      line.includes('Evidence files scanned:') ||
      line.includes('Evidence signals found:') ||
      line.includes('Not applied:')
    )
    .join('\n');
}

async function createLocalGitRepo(name: string, files: Record<string, string>): Promise<string> {
  const repoPath = path.join(os.tmpdir(), 'folio-eval-local-fixtures', `${name}-${Date.now()}`);
  await fs.ensureDir(repoPath);

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoPath, filePath);
    await fs.ensureDir(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, content);
  }

  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repoPath });

  return repoPath;
}

describe('CLI Integration Tests', () => {
  const testOutputDir = path.join(os.tmpdir(), 'folio-eval-integration-tests', Date.now().toString());

  beforeAll(async () => {
    // Create test output directory
    await fs.ensureDir(testOutputDir);
  });

  afterAll(async () => {
    // Clean up test output directory
    try {
      await fs.remove(testOutputDir);
    } catch (error) {
      console.warn('Failed to clean up test output directory:', error);
    }
  });

  // Extended timeout for integration tests (5 minutes per test)
  jest.setTimeout(300000);

  describe('Repository Evaluation', () => {
    test('should evaluate mod-search (Java backend module)', async () => {
      const repoUrl = 'https://github.com/folio-org/mod-search';
      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: false,
        allowLocalCommands: true,
      };

      // Create evaluator with config
      const evaluator = new ModuleEvaluator(config);

      // Run evaluation
      const result = await evaluator.evaluateModule(repoUrl);

      // Verify evaluation result structure
      expect(result).toBeDefined();
      expect(result.moduleName).toBe('mod-search');
      expect(result.repositoryUrl).toBe(repoUrl);
      expect(result.evaluatedAt).toBeDefined();
      expect(result.language).toBe('Java');
      expect(result.criteria).toBeInstanceOf(Array);
      expect(result.criteria.length).toBeGreaterThan(0);

      // Verify each result has required fields
      result.criteria.forEach((criterionResult) => {
        expect(criterionResult.criterionId).toBeDefined();
        expect(criterionResult.status).toMatch(/pass|fail|manual|not_applicable/);
        expect(criterionResult.evidence).toBeDefined();
      });

      // Generate reports
      const reportGenerator = new ReportGenerator(testOutputDir);
      const reportPaths = await reportGenerator.generateReports(result);

      // Verify reports were generated
      expect(reportPaths.htmlPath).toBeDefined();
      expect(reportPaths.jsonPath).toBeDefined();

      // Verify HTML report exists and has content
      const htmlContent = await fs.readFile(reportPaths.htmlPath!, 'utf-8');
      expect(htmlContent).toContain('mod-search');
      expect(htmlContent).toContain('Evaluation Report');

      // Verify JSON report is valid JSON
      const jsonContent = await fs.readFile(reportPaths.jsonPath!, 'utf-8');
      const jsonData = JSON.parse(jsonContent);
      expect(jsonData.moduleName).toBe('mod-search');
      expect(jsonData.criteria).toBeInstanceOf(Array);
    });

    test('should evaluate mod-source-record-storage (Java backend module)', async () => {
      const repoUrl = 'https://github.com/folio-org/mod-source-record-storage';
      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: false,
        allowLocalCommands: true,
      };

      // Create evaluator with config
      const evaluator = new ModuleEvaluator(config);

      // Run evaluation
      const result = await evaluator.evaluateModule(repoUrl);

      // Verify evaluation result structure
      expect(result).toBeDefined();
      expect(result.moduleName).toBe('mod-source-record-storage');
      expect(result.repositoryUrl).toBe(repoUrl);
      expect(result.evaluatedAt).toBeDefined();
      expect(result.language).toBe('Java');
      expect(result.criteria).toBeInstanceOf(Array);
      expect(result.criteria.length).toBeGreaterThan(0);

      // Generate reports
      const reportGenerator = new ReportGenerator(testOutputDir);
      const reportPaths = await reportGenerator.generateReports(result);

      // Verify reports were generated
      expect(reportPaths.htmlPath).toBeDefined();
      expect(reportPaths.jsonPath).toBeDefined();

      // Verify JSON structure
      const jsonContent = await fs.readFile(reportPaths.jsonPath!, 'utf-8');
      const jsonData = JSON.parse(jsonContent);
      expect(jsonData.moduleName).toBe('mod-source-record-storage');
      expect(jsonData.language).toBe('Java');
      expect(jsonData.criteria).toBeInstanceOf(Array);
    });

    test('should evaluate ui-data-import (JavaScript/UI module)', async () => {
      const repoUrl = 'https://github.com/folio-org/ui-data-import';
      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: false,
        allowLocalCommands: true,
      };

      // Create evaluator with config
      const evaluator = new ModuleEvaluator(config);

      // Run evaluation
      const result = await evaluator.evaluateModule(repoUrl);

      // Verify evaluation result structure
      expect(result).toBeDefined();
      expect(result.moduleName).toBe('ui-data-import');
      expect(result.repositoryUrl).toBe(repoUrl);
      expect(result.evaluatedAt).toBeDefined();
      expect(result.language).toBe('JavaScript');
      expect(result.criteria).toBeInstanceOf(Array);
      expect(result.criteria.length).toBeGreaterThan(0);

      // Generate reports
      const reportGenerator = new ReportGenerator(testOutputDir);
      const reportPaths = await reportGenerator.generateReports(result);

      // Verify reports were generated
      expect(reportPaths.htmlPath).toBeDefined();
      expect(reportPaths.jsonPath).toBeDefined();

      // Verify JSON structure
      const jsonContent = await fs.readFile(reportPaths.jsonPath!, 'utf-8');
      const jsonData = JSON.parse(jsonContent);
      expect(jsonData.moduleName).toBe('ui-data-import');
      expect(jsonData.language).toBe('JavaScript');
      expect(jsonData.criteria).toBeInstanceOf(Array);
    });
  });

  describe('Report Generation Options', () => {
    test('should generate only JSON report when outputHtml is false', async () => {
      const repoUrl = 'https://github.com/folio-org/mod-search';
      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: false,
        allowLocalCommands: true,
      };

      // Create evaluator with config
      const evaluator = new ModuleEvaluator(config);

      // Run evaluation
      const result = await evaluator.evaluateModule(repoUrl);
      expect(result).toBeDefined();

      // Generate only JSON report
      const reportGenerator = new ReportGenerator(testOutputDir);
      const reportOptions: ReportOptions = {
        outputHtml: false,
        outputJson: true,
        outputDir: testOutputDir
      };
      const reportPaths = await reportGenerator.generateReports(result, reportOptions);

      // Verify only JSON report was generated
      expect(reportPaths.htmlPath).toBeUndefined();
      expect(reportPaths.jsonPath).toBeDefined();

      // Verify JSON file exists
      const jsonExists = await fs.pathExists(reportPaths.jsonPath!);
      expect(jsonExists).toBe(true);
    });

    test('should generate only HTML report when outputJson is false', async () => {
      const repoUrl = 'https://github.com/folio-org/mod-search';
      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: false,
        allowLocalCommands: true,
      };

      // Create evaluator with config
      const evaluator = new ModuleEvaluator(config);

      // Run evaluation
      const result = await evaluator.evaluateModule(repoUrl);
      expect(result).toBeDefined();

      // Generate only HTML report
      const reportGenerator = new ReportGenerator(testOutputDir);
      const reportOptions: ReportOptions = {
        outputHtml: true,
        outputJson: false,
        outputDir: testOutputDir
      };
      const reportPaths = await reportGenerator.generateReports(result, reportOptions);

      // Verify only HTML report was generated
      expect(reportPaths.htmlPath).toBeDefined();
      expect(reportPaths.jsonPath).toBeUndefined();

      // Verify HTML file exists
      const htmlExists = await fs.pathExists(reportPaths.htmlPath!);
      expect(htmlExists).toBe(true);
    });
  });

  describe('Golden Report Regression', () => {
    test('should match normalized JSON report for mod-rtac-cache v1.1.1', async () => {
      const repoUrl = 'https://github.com/folio-org/mod-rtac-cache';
      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: false,
        branch: 'v1.1.1',
        allowLocalCommands: true,
      };

      const evaluator = new ModuleEvaluator(config);
      const result = await evaluator.evaluateModule(repoUrl);

      const reportGenerator = new ReportGenerator(testOutputDir);
      const reportPaths = await reportGenerator.generateReports(result, {
        outputHtml: false,
        outputJson: true,
        outputDir: testOutputDir,
      });

      expect(reportPaths.htmlPath).toBeUndefined();
      expect(reportPaths.jsonPath).toBeDefined();

      const jsonContent = await fs.readFile(reportPaths.jsonPath!, 'utf-8');
      const actualReport = normalizeEvaluationReport(JSON.parse(jsonContent));
      const goldenPath = path.join(
        __dirname,
        '..',
        'fixtures',
        'golden-reports',
        'mod-rtac-cache-v1.1.1.json'
      );
      const expectedReport = JSON.parse(await fs.readFile(goldenPath, 'utf-8'));

      expect(actualReport).toEqual(expectedReport);
    });
  });

  describe('Cleanup Functionality', () => {
    test('should clean up temporary clone directory by default', async () => {
      const repoUrl = 'https://github.com/folio-org/mod-search';
      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: false,
        allowLocalCommands: true,
      };

      // Create evaluator with config
      const evaluator = new ModuleEvaluator(config);

      // Run evaluation
      await evaluator.evaluateModule(repoUrl);

      // Check that no temporary directories remain in system temp
      const tempDir = path.join(os.tmpdir(), 'folio-eval');
      if (await fs.pathExists(tempDir)) {
        const dirs = await fs.readdir(tempDir);
        // There should be very few or no mod-search directories
        const modSearchDirs = dirs.filter(d => d.startsWith('mod-search'));
        expect(modSearchDirs.length).toBeLessThanOrEqual(1);
      }
    });

    test('should not clean up when skipCleanup is true', async () => {
      const repoUrl = 'https://github.com/folio-org/mod-search';
      const tempDir = path.join(os.tmpdir(), 'folio-eval-test-nocleanup');

      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: true,
        tempDir: tempDir,
        allowLocalCommands: true,
      };

      // Create evaluator with config
      const evaluator = new ModuleEvaluator(config);

      // Run evaluation
      await evaluator.evaluateModule(repoUrl);

      // Check that temporary directory still exists
      expect(await fs.pathExists(tempDir)).toBe(true);
      const dirs = await fs.readdir(tempDir);
      const modSearchDirs = dirs.filter(d => d.startsWith('mod-search'));
      expect(modSearchDirs.length).toBeGreaterThan(0);

      // Clean up manually
      for (const dir of modSearchDirs) {
        await fs.remove(path.join(tempDir, dir));
      }
    });
  });

  describe('Criteria Filtering', () => {
    test('should filter results when criteria filter is provided', async () => {
      const repoUrl = 'https://github.com/folio-org/mod-search';
      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: false,
        criteriaFilter: ['A001', 'S001'],
        allowLocalCommands: true,
      };

      // Create evaluator with config
      const evaluator = new ModuleEvaluator(config);

      // Run evaluation
      const result = await evaluator.evaluateModule(repoUrl);

      // Verify only specified criteria are in results
      expect(result.criteria.length).toBeLessThanOrEqual(2);
      result.criteria.forEach((r) => {
        expect(['A001', 'S001']).toContain(r.criterionId);
      });
    });
  });

  describe('Local S002 Descriptor Integration', () => {
    test('should evaluate only S002 against a local static descriptor fixture', async () => {
      const repoPath = await createLocalGitRepo('mod-static-descriptor', {
        'src/main/java/org/folio/Example.java': 'package org.folio; public class Example {}',
        'ModuleDescriptor.json': JSON.stringify({ id: 'mod-static-descriptor-1.0.0' }, null, 2)
      });
      const evaluator = new ModuleEvaluator({
        outputDir: testOutputDir,
        tempDir: path.join(os.tmpdir(), 'folio-eval-local-clones'),
        skipCleanup: false,
        criteriaFilter: ['S002'],
        allowLocalCommands: true
      });

      const result = await evaluator.evaluateModule(repoPath);

      expect(result.criteria).toHaveLength(1);
      expect(result.criteria[0].criterionId).toBe('S002');
      expect(result.criteria[0].status).toBe('pass');
      expect(result.criteria[0].evidence).toContain('ModuleDescriptor.json validates against Okapi schema baseline');
    });

    test('should include S002 evidence in JSON and escaped HTML reports', async () => {
      const result: EvaluationResult = {
        repositoryUrl: 'local-fixture',
        moduleName: 'mod-static-descriptor',
        language: 'Java',
        evaluatedAt: new Date('2026-06-08T00:00:00.000Z'),
        criteria: [{
          criterionId: 'S002',
          status: EvaluationStatus.PASS,
          evidence: 'Module descriptor ModuleDescriptor.json validates against Okapi schema baseline',
          details: 'Warnings:\n  - <script>alert("x")</script>\nCommand: mvn process-resources (success)'
        }]
      };

      const reportGenerator = new ReportGenerator(testOutputDir);
      const reportPaths = await reportGenerator.generateReports(result);

      const jsonContent = await fs.readFile(reportPaths.jsonPath!, 'utf-8');
      expect(jsonContent).toContain('Okapi schema baseline');

      const htmlContent = await fs.readFile(reportPaths.htmlPath!, 'utf-8');
      expect(htmlContent).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
      expect(htmlContent).not.toContain('<script>alert("x")</script>');
    });
  });

  describe('Local S004 Installation Documentation Integration', () => {
    test('should evaluate S004 rich evidence manual, build manual, thin manual, and library not applicable through ModuleEvaluator', async () => {
      const fixtures = [
        {
          name: 'mod-s004-rich-manual',
          files: {
            'pom.xml': '<project><modelVersion>4.0.0</modelVersion><artifactId>mod-s004-rich-manual</artifactId></project>',
            'README.md': '## Deployment\nDeploy the ModuleDescriptor through Okapi, configure the tenant, and run with docker compose.'
          },
          expected: EvaluationStatus.MANUAL
        },
        {
          name: 'mod-s004-build-manual',
          files: {
            'pom.xml': '<project><modelVersion>4.0.0</modelVersion><artifactId>mod-s004-build-manual</artifactId></project>',
            'README.md': '## Build\nmvn clean install\n\n## Tests\nmvn test'
          },
          expected: EvaluationStatus.MANUAL
        },
        {
          name: 'mod-s004-manual',
          files: {
            'pom.xml': '<project><modelVersion>4.0.0</modelVersion><artifactId>mod-s004-manual</artifactId></project>',
            'README.md': 'Configuration links and module descriptor references are available.'
          },
          expected: EvaluationStatus.MANUAL
        },
        {
          name: 'folio-spring-base',
          files: {
            'pom.xml': '<project><modelVersion>4.0.0</modelVersion><artifactId>folio-spring-base</artifactId></project>',
            'README.md': 'Shared library.'
          },
          expected: EvaluationStatus.NOT_APPLICABLE
        }
      ];

      for (const fixture of fixtures) {
        const repoPath = await createLocalGitRepo(fixture.name, fixture.files);
        const evaluator = new ModuleEvaluator({
          outputDir: testOutputDir,
          tempDir: path.join(os.tmpdir(), 'folio-eval-local-clones'),
          skipCleanup: false,
          criteriaFilter: ['S004'],
          allowLocalCommands: true
        });

        const result = await evaluator.evaluateModule(repoPath);

        expect(result.criteria).toHaveLength(1);
        expect(result.criteria[0].criterionId).toBe('S004');
        expect(result.criteria[0].status).toBe(fixture.expected);
      }
    });

    test('should include S004 evidence in JSON and escaped HTML reports', async () => {
      const result: EvaluationResult = {
        repositoryUrl: 'local-fixture',
        moduleName: 'mod-s004-manual',
        language: 'Java',
        evaluatedAt: new Date('2026-06-09T00:00:00.000Z'),
        criteria: [{
          criterionId: 'S004',
          status: EvaluationStatus.MANUAL,
          evidence: 'S004 manual: Candidate documentation exists',
          details: 'Strongest signals:\n  - README.md [env_configuration] <script>alert("x")</script> token=abc123'
        }]
      };

      const reportGenerator = new ReportGenerator(testOutputDir);
      const reportPaths = await reportGenerator.generateReports(result);

      const jsonContent = await fs.readFile(reportPaths.jsonPath!, 'utf-8');
      expect(jsonContent).toContain('S004 manual');
      expect(jsonContent).toContain('token=[REDACTED]');

      const htmlContent = await fs.readFile(reportPaths.htmlPath!, 'utf-8');
      expect(htmlContent).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
      expect(htmlContent).not.toContain('token=abc123');
    });
  });
});
