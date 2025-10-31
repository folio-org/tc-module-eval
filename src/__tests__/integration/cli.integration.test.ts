import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { ModuleEvaluator } from '../../module-evaluator';
import { ReportGenerator } from '../../utils/report-generator';
import { EvaluationConfig, ReportOptions } from '../../types';

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

  describe('Cleanup Functionality', () => {
    test('should clean up temporary clone directory by default', async () => {
      const repoUrl = 'https://github.com/folio-org/mod-search';
      const config: EvaluationConfig = {
        outputDir: testOutputDir,
        skipCleanup: false,
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
});
