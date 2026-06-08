#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import { ModuleEvaluator } from './module-evaluator';
import { ReportGenerator } from './utils/report-generator';
import { EvaluationConfig, EvaluationResult, ReportOptions } from './types';

const program = new Command();

program
  .name('folio-eval')
  .description('FOLIO Module Evaluator - Evaluate FOLIO modules against technical council criteria')
  .version('1.0.0');

program
  .command('evaluate')
  .description('Evaluate a FOLIO module repository')
  .argument('<repository-url>', 'GitHub URL of the repository to evaluate')
  .option('-o, --output <dir>', 'Output directory for reports', './reports')
  .option('-b, --branch <name>', 'Branch name to evaluate (defaults to repository default branch)')
  .option('--json-only', 'Generate only JSON report')
  .option('--html-only', 'Generate only HTML report')
  .option('--temp-dir <dir>', 'Temporary directory for cloning repositories')
  .option('--no-cleanup', 'Do not delete the cloned repository after evaluation')
  .option('--criteria <ids>', 'Comma-separated list of criterion IDs to evaluate (e.g., S001,S002,B005)')
  .option('--allow-local-commands', 'Allow Maven, Gradle, and npm commands to run in the current trusted environment')
  .action(async (repositoryUrl: string, options) => {
    try {
      console.log('🚀 Starting FOLIO Module Evaluation...\n');

      const criteriaFilter = parseCriteriaFilter(options);
      const config = buildEvaluationConfig(options, criteriaFilter);

      logEvaluationStart(repositoryUrl, options.output, criteriaFilter);

      if (options.branch) {
        console.log(`🌿 Branch: ${options.branch}`);
      }
      if (options.allowLocalCommands) {
        console.log(`🔐 Command execution mode: ${resolveCommandExecutionMode(options)}`);
      }

      const evaluator = new ModuleEvaluator(config);
      const result = await evaluator.evaluateModule(repositoryUrl);

      const reportGenerator = new ReportGenerator(options.output);
      const reportOptions = createReportOptions(options);
      await generateAndLogReports(result, reportGenerator, reportOptions);

      printEvaluationSummary(result);

      console.log('\n🎉 Done!');

    } catch (error) {
      console.error('\n❌ Evaluation failed:\n');
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(errorMessage);
      process.exit(1);
    }
  });

program
  .command('list-languages')
  .description('List supported programming languages')
  .action(() => {
    console.log('🔧 Supported Languages:');
    
    // Create a temporary evaluator to get supported languages
    const config: EvaluationConfig = {};
    const evaluator = new ModuleEvaluator(config);
    const languages = evaluator.getSupportedLanguages();
    
    languages.forEach(lang => {
      console.log(`   - ${lang}`);
    });
    
    console.log('\nTo add support for additional languages, implement the LanguageEvaluator interface.');
  });

program
  .command('info')
  .description('Show information about the evaluator')
  .action(() => {
    console.log('📋 FOLIO Module Evaluator');
    console.log('==========================');
    console.log('A TypeScript tool for evaluating FOLIO modules against technical council criteria.\n');

    console.log('🏗️  Framework Components:');
    console.log('   ✅ Modular language evaluator system');
    console.log('   ✅ Git repository cloning and analysis');
    console.log('   ✅ HTML and JSON report generation');
    console.log('   ✅ Extensible architecture for new languages');
    console.log('   ⚠️  Individual criterion evaluation (stub implementations)\n');

    console.log('📊 Current Status:');
    console.log('   ✅ Framework infrastructure - IMPLEMENTED');
    console.log('   ✅ Java project detection - IMPLEMENTED');
    console.log('   ⚠️  Specific evaluation logic - STUB (returns MANUAL status)');
    console.log('   📝 Most criteria require implementation for automated evaluation\n');
    
    console.log('📝 Usage Examples:');
    console.log('   # Evaluate a repository');
    console.log('   folio-eval evaluate https://github.com/folio-org/mod-users');
    console.log('');
    console.log('   # Generate only JSON report');
    console.log('   folio-eval evaluate <repo-url> --json-only');
    console.log('');
    console.log('   # Custom output directory');
    console.log('   folio-eval evaluate <repo-url> --output ./my-reports');
    console.log('');
    console.log('   # Evaluate specific criteria only');
    console.log('   folio-eval evaluate <repo-url> --criteria S001,S002,B005');
    console.log('');
    console.log('   # Keep cloned repository for inspection');
    console.log('   folio-eval evaluate <repo-url> --no-cleanup');
    console.log('');
    console.log('   # Evaluate a specific branch');
    console.log('   folio-eval evaluate <repo-url> --branch feature-branch');
    console.log('');
    console.log('   # Allow Maven/Gradle/npm commands in a trusted local or GitHub Actions environment');
    console.log('   folio-eval evaluate <repo-url> --allow-local-commands');
  });

function parseCriteriaFilter(options: any): string[] | undefined {
  if (!options.criteria) {
    return undefined;
  }

  const parsedCriteria = options.criteria
    .split(',')
    .map((id: string) => id.trim().toUpperCase())
    .filter((id: string) => id.length > 0);

  if (parsedCriteria.length === 0) {
    throw new Error('Invalid criteria format. Use comma-separated criterion IDs like: S001,S002,B005');
  }

  return parsedCriteria;
}

function buildEvaluationConfig(options: any, criteriaFilter?: string[]): EvaluationConfig {
  return {
    tempDir: options.tempDir,
    outputDir: options.output,
    skipCleanup: !options.cleanup,
    criteriaFilter,
    branch: options.branch,
    commandExecutionMode: resolveCommandExecutionMode(options)
  };
}

function resolveCommandExecutionMode(options: any): EvaluationConfig['commandExecutionMode'] {
  if (!options.allowLocalCommands) {
    return 'strict';
  }

  return process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'trusted-local';
}

function logEvaluationStart(repositoryUrl: string, outputDir: string, criteriaFilter?: string[]): void {
  if (criteriaFilter) {
    console.log(`🎯 Evaluating specific criteria: ${criteriaFilter.join(', ')}`);
  }

  console.log(`📁 Output directory: ${outputDir}`);
  console.log(`🔗 Repository URL: ${repositoryUrl}`);
}

function createReportOptions(options: any): ReportOptions {
  return {
    outputHtml: !options.jsonOnly,
    outputJson: !options.htmlOnly,
    outputDir: options.output
  };
}

async function generateAndLogReports(
  result: EvaluationResult,
  reportGenerator: ReportGenerator,
  reportOptions: ReportOptions
): Promise<void> {
  const reportPaths = await reportGenerator.generateReports(result, reportOptions);

  console.log('\n✅ Evaluation completed successfully!');
  console.log('\n📄 Reports generated:');
  if (reportPaths.htmlPath) {
    console.log(`   📄 HTML: ${reportPaths.htmlPath}`);
  }
  if (reportPaths.jsonPath) {
    console.log(`   📄 JSON: ${reportPaths.jsonPath}`);
  }
}

function printEvaluationSummary(result: EvaluationResult): void {
  console.log('\n📊 Summary:');
  console.log(`   Module: ${result.moduleName}`);
  console.log(`   Language: ${result.language}`);
  console.log(`   Total Criteria: ${result.criteria.length}`);

  const stats = {
    pass: result.criteria.filter(c => c.status === 'pass').length,
    fail: result.criteria.filter(c => c.status === 'fail').length,
    manual: result.criteria.filter(c => c.status === 'manual').length,
    notApplicable: result.criteria.filter(c => c.status === 'not_applicable').length
  };

  console.log(`   ✅ Passed: ${stats.pass}`);
  console.log(`   ❌ Failed: ${stats.fail}`);
  console.log(`   ⚠️  Manual Review: ${stats.manual}`);
  console.log(`   ⚪ Not Applicable: ${stats.notApplicable}`);
}

// Handle case where no command is provided
if (process.argv.length === 2) {
  program.outputHelp();
}

program.parse();
