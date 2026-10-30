#!/usr/bin/env node

import { Command } from 'commander';
import { ModuleEvaluator } from './module-evaluator';
import { ReportGenerator } from './utils/report-generator';
import { EvaluationConfig, EvaluationResult, EvaluationStatus, ReportOptions } from './types';
import { buildCriterionAgentReviewConfig } from './utils/agent-review-config';
import { DEFAULT_PLATFORM_REF, isValidPlatformRef, isValidRemoteName } from './utils/s014-application-assignment';
import { errorMessage } from './utils/type-guards';
import { redactEvaluatorSecrets } from './utils/redaction';
import { parseUiRuntimeOrigin } from './utils/ui-runtime-probe';

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
  .option('--s008-catalog <channel>', 'Checked-in S008 provider catalog (official or development)', 'official')
  .option('--allow-remote-lookups', 'Allow read-only lookups of SonarCloud (S011, S013), folio-org/platform-lsp and FAR (S014)')
  .option('--application <name>', 'Application named in the evaluation\'s Jira task (S014)')
  .option('--platform-ref <ref>', 'folio-org/platform-lsp branch, tag or commit S014 reads', DEFAULT_PLATFORM_REF)
  .option('--ui-runtime-url <origin>', 'Origin of a running FOLIO UI in a test or reference environment, never production, whose module pages F004 measures with axe-core; needs --ui-runtime-login-origin and a test account in FOLIO_UI_USERNAME and FOLIO_UI_PASSWORD')
  .option('--ui-runtime-login-origin <origin>', 'Origin of that UI\'s login page (Keycloak); the test account is typed only into a page there')
  .option('--ui-runtime-chrome <path>', 'Chrome or Chromium executable for --ui-runtime-url (default: the installed Google Chrome)')
  .option('--existing-module', 'Evaluate as an existing module, not a new one (the default); B006 then accepts RAML from RMB modules, B005 leaves interface naming violations to the reviewer, and B004, once implemented, relaxes some new-module rules for it')
  .option('--criterion-agent-opencode', 'Enable reusable OpenCode criterion-agent advisory review')
  .option('--criterion-agent-criteria <ids>', 'Comma-separated criterion IDs allowed to use criterion-agent review')
  .option('--criterion-agent-model <label>', 'Provider-neutral OpenCode model label')
  .option('--criterion-agent-read-only-agent <name>', 'OpenCode read-only agent name', 'reviewer')
  .option('--criterion-agent-timeout-ms <ms>', 'Criterion-agent command timeout in milliseconds')
  .option('--criterion-agent-trusted-config <path>', 'Trusted OpenCode config path outside the evaluated repository')
  .option('--criterion-agent-auth-store <path>', 'Trusted OpenCode auth-store path outside the evaluated repository')
  .option('--criterion-agent-provider-env <names>', 'Comma-separated provider credential env vars to pass to OpenCode')
  .option('--criterion-agent-proxy-env <names>', 'Comma-separated proxy env vars to pass to OpenCode')
  .option('--criterion-agent-endpoint <url>', 'OpenCode provider endpoint URL')
  .option('--criterion-agent-endpoint-family <name>', 'Provider-neutral endpoint family metadata')
  .option('--criterion-agent-endpoint-allowlist <prefixes>', 'Comma-separated endpoint URL prefixes allowed for non-HTTPS endpoints')
  .option('--criterion-agent-debug-retain-workspace', 'Retain local criterion-agent scratch workspace for debugging')
  .action(async (repositoryUrl: string, options) => {
    try {
      console.log('🚀 Starting FOLIO Module Evaluation...\n');

      const criteriaFilter = parseCriteriaFilter(options);
      const config = buildEvaluationConfig(options, criteriaFilter);

      logEvaluationStart(repositoryUrl, options.output, criteriaFilter);

      if (options.branch) {
        console.log(`🌿 Branch: ${options.branch}`);
      }
      if (options.allowRemoteLookups) {
        console.log(`🌐 Remote lookups allowed (SonarCloud, folio-org/platform-lsp ${options.platformRef}, FAR)`);
      }
      if (options.existingModule) {
        console.log('🏷️  Evaluating as an existing module');
      }
      if (config.uiRuntime) {
        console.log(`🖥️  Runtime UI probe: ${config.uiRuntime.url} (login ${config.uiRuntime.loginOrigin})`);
      }
      if (options.allowLocalCommands) {
        console.log(`🔐 Local command execution allowed (${resolveCommandExecutionEnvironment()})`);
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
      console.error(redactEvaluatorSecrets(errorMessage(error)));
      process.exit(1);
    }
  });

program
  .command('list-languages')
  .description('List supported programming languages')
  .action(() => {
    console.log('🔧 Supported Languages:');
    
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
    console.log('   ✅ Java and JavaScript language evaluators');
    console.log('   ✅ Git repository cloning and analysis');
    console.log('   ✅ HTML and JSON report generation\n');

    console.log('📊 Current Status:');
    console.log('   ✅ Shared/Common criteria S001-S014, B001, B003, B005 and B006 (Java), and F001-F007 (JavaScript) - IMPLEMENTED');
    console.log('   ⚠️  A001 - MANUAL REVIEW by design');
    console.log('   ⚠️  B002, B004, B007-B016 (Java) - NOT IMPLEMENTED (return MANUAL)');
    console.log('   📝 13 of the 38 criteria always return MANUAL (13 of 31 for Java, 1 of 22 for JavaScript);');
    console.log('      S001-S014, B001, B003, B005, B006, F001-F003 and F005 return MANUAL when the evidence is inconclusive,');
    console.log('      and F004, F006 and F007 whenever the package renders a user interface\n');
    
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
  if (!['official', 'development'].includes(options.s008Catalog)) {
    throw new Error('Invalid S008 catalog. Use official or development.');
  }
  if (options.application !== undefined && !isValidRemoteName(options.application)) {
    throw new Error('Invalid --application. Use an application name such as app-search.');
  }
  if (!isValidPlatformRef(options.platformRef)) {
    throw new Error('Invalid --platform-ref. Use a platform-lsp branch, tag or commit such as snapshot or R1-2026.');
  }
  if (Boolean(options.uiRuntimeUrl) !== Boolean(options.uiRuntimeLoginOrigin)) {
    throw new Error('Use --ui-runtime-url and --ui-runtime-login-origin together.');
  }
  return {
    tempDir: options.tempDir,
    outputDir: options.output,
    skipCleanup: !options.cleanup,
    criteriaFilter,
    branch: options.branch,
    allowLocalCommands: options.allowLocalCommands === true,
    commandExecutionEnvironment: resolveCommandExecutionEnvironment(),
    agentReview: buildCriterionAgentReviewConfig(options),
    s008CatalogChannel: options.s008Catalog,
    allowRemoteLookups: options.allowRemoteLookups === true,
    s014Application: options.application,
    s014PlatformRef: options.platformRef,
    existingModule: options.existingModule === true,
    ...(options.uiRuntimeUrl ? {
      uiRuntime: {
        url: parseUiRuntimeOrigin(options.uiRuntimeUrl, '--ui-runtime-url'),
        loginOrigin: parseUiRuntimeOrigin(options.uiRuntimeLoginOrigin, '--ui-runtime-login-origin'),
        ...(options.uiRuntimeChrome ? { chromePath: options.uiRuntimeChrome } : {})
      }
    } : {})
  };
}

function resolveCommandExecutionEnvironment(): EvaluationConfig['commandExecutionEnvironment'] {
  return process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local';
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
    pass: result.criteria.filter(c => c.status === EvaluationStatus.PASS).length,
    fail: result.criteria.filter(c => c.status === EvaluationStatus.FAIL).length,
    manual: result.criteria.filter(c => c.status === EvaluationStatus.MANUAL).length,
    notApplicable: result.criteria.filter(c => c.status === EvaluationStatus.NOT_APPLICABLE).length
  };

  console.log(`   ✅ Passed: ${stats.pass}`);
  console.log(`   ❌ Failed: ${stats.fail}`);
  console.log(`   ⚠️  Manual Review: ${stats.manual}`);
  console.log(`   ⚪ Not Applicable: ${stats.notApplicable}`);
}

if (process.argv.length === 2) {
  program.outputHelp();
}

program.parse();
