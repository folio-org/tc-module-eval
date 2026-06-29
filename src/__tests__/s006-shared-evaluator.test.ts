import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { JavaScriptSharedEvaluator } from '../evaluators/javascript/javascript-shared-evaluator';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  CriterionAgentReviewConfig,
  CriterionAgentReviewResult,
  EvaluationStatus,
  S006RedactedReportDetails
} from '../types';
import * as EvaluationRunUtils from '../utils/evaluation-run';
import { FakeS006GitleaksRunner } from './helpers/fake-s006-gitleaks-runner';

class TestSharedEvaluator extends SharedEvaluator {}

describe('S006 shared evaluator', () => {
  let tempRoot: string;
  let evaluator: TestSharedEvaluator;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's006-shared-'));
    evaluator = new TestSharedEvaluator();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('keeps S006 in canonical shared criteria order after S005', () => {
    expect(evaluator.criteriaIds.slice(0, 7)).toEqual(['S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007']);
  });

  it('evaluates S006 instead of returning the catalog fallback for Java and JavaScript repositories', async () => {
    writeRepoFile('README.md', '# Clean module\n');

    const javaResult = await evaluator.evaluateCriterion('S006', tempRoot, createRun());
    const javascriptResult = await new JavaScriptSharedEvaluator().evaluateCriterion('S006', tempRoot, createRun());

    for (const result of [javaResult, javascriptResult]) {
      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toContain('S006 pass: no retained sensitive/environment-specific findings');
      expect(result.evidence).not.toContain('evaluation logic not yet implemented');
      expect(result.evidence).not.toContain('Sensitive information repository scan');
      expect(result.agentReview).toBeUndefined();
    }
  });

  it('direct S006 evaluation creates an EvaluationRun when one is not supplied', async () => {
    writeRepoFile('README.md', '# Clean module\n');
    const createRunSpy = jest.spyOn(EvaluationRunUtils, 'createEvaluationRun');

    const result = await evaluator.evaluateCriterion('S006', tempRoot);

    expect(createRunSpy).toHaveBeenCalledWith({
      repositoryPath: tempRoot,
      language: 'java',
      criteriaFilter: ['S006']
    });
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Secret scanner: Gitleaks unavailable');
    expect(result.details).toContain('scanner-unavailable');
    expect(result.criterionDetails).toMatchObject({
      scanner: {
        name: 'Gitleaks',
        status: 'unavailable',
        findingCount: 0,
        warning: expect.objectContaining({ kind: 'scanner-unavailable' })
      }
    });
  });

  it('returns pass through SharedEvaluator when no findings are present and scan coverage is complete', async () => {
    writeRepoFile('README.md', '# Clean module\n');

    const result = await evaluator.evaluateCriterion('S006', tempRoot, createRun());
    const details = result.criterionDetails as S006RedactedReportDetails;

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(details.findingCount).toBe(0);
    expect(details.scanner).toMatchObject({
      name: 'Gitleaks',
      status: 'completed',
      findingCount: 0
    });
    expect(details.coverage.complete).toBe(true);
    expect(details.coverage.materiallyWeakened).toBe(false);
  });

  it('returns fail through SharedEvaluator for a high-confidence production secret', async () => {
    const rawKey = 'sk-proj-prod1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile('src/main/resources/application.yml', `OPENAI_API_KEY=${rawKey}\n`);

    const result = await evaluator.evaluateCriterion('S006', tempRoot, createRun());

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toContain('S006 fail: 1 deterministic failure finding');
    expect(result.details).toContain('src/main/resources/application.yml:1');
    expect(result.details).toContain('[REDACTED_PROVIDER_API_KEY]');
    expect(JSON.stringify(result)).not.toContain(rawKey);
  });

  it.each([
    {
      name: 'ambiguous documentation token',
      files: {
        'README.md': 'Example: curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"\n'
      },
      expectedDetail: 'Confirm documentation, sample, and test findings are examples'
    },
    {
      name: 'local Docker default password',
      files: {
        'docker-compose.yml': [
          'services:',
          '  postgres:',
          '    environment:',
          '      POSTGRES_PASSWORD: postgres'
        ].join('\n')
      },
      expectedDetail: 'Confirm local Docker defaults are not reused outside local development'
    }
  ])('returns manual through SharedEvaluator for $name', async ({ files, expectedDetail }) => {
    for (const [relativePath, content] of Object.entries(files)) {
      writeRepoFile(relativePath, content);
    }

    const result = await evaluator.evaluateCriterion('S006', tempRoot, createRun());

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toContain('S006 manual: 1 retained finding');
    expect(result.details).toContain(expectedDetail);
  });

  it.each([
    {
      name: 'local Docker defaults',
      files: {
        'docker-compose.yml': [
          'services:',
          '  postgres:',
          '    environment:',
          '      POSTGRES_PASSWORD: postgres'
        ].join('\n')
      },
      expectedReference: '.criterion-agent/S006/excerpts/local_docker_defaults.txt'
    },
    {
      name: 'documentation token snippets',
      files: {
        'docs/secrets.md': 'Example: Bearer abcdefghijklmnopqrstuvwxyz123456\n'
      },
      expectedReference: '.criterion-agent/S006/excerpts/documentation.txt'
    }
  ])('invokes fake agent review for $name when S006 is enabled', async ({ files, expectedReference }) => {
    for (const [relativePath, content] of Object.entries(files)) {
      writeRepoFile(relativePath, content);
    }

    const result = await evaluator.evaluateCriterion('S006', tempRoot, createRunWithAgent(fakeAgentConfig({
      available: true,
      criterionId: 'S006',
      recommendation: 'needs_reviewer_judgment',
      confidence: 'medium',
      summary: 'S006 fake review summary.',
      rationale: 'S006 fake review rationale.',
      evidenceReferences: [expectedReference],
      warnings: [],
      errors: []
    })));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.evidenceReferences).toEqual([expectedReference]);
    expect(result.details).toContain('Agent review:');
    expect(result.details).toContain('Advisory recommendation: needs_reviewer_judgment');
    expect(result.details).not.toContain('Evidence references:');
    expect(result.details).not.toContain(expectedReference);
  });

  it.each([
    {
      name: 'disabled',
      run: () => createRun(),
      expected: 'agent review is disabled or unconfigured'
    },
    {
      name: 'not enabled for S006',
      run: () => createRunWithAgent({ ...fakeAgentConfig(), enabledCriteria: ['S005'] }),
      expected: 'agent review is not enabled for S006'
    }
  ])('records unavailable reason while preserving deterministic evidence when agent review is $name', async ({ run, expected }) => {
    writeRepoFile('docs/secrets.md', 'Example: Bearer abcdefghijklmnopqrstuvwxyz123456\n');

    const result = await evaluator.evaluateCriterion('S006', tempRoot, run());
    const details = result.criterionDetails as S006RedactedReportDetails;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toBeUndefined();
    expect(result.evidence).toContain('S006 manual');
    expect(result.details).toContain('Top redacted examples:');
    expect(details.agentReviewUnavailableReason).toContain(expected);
    expect(result.details).toContain(expected);
  });

  it('does not invoke agent review for deterministic S006 failures', async () => {
    const rawKey = 'sk-proj-prod1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile('src/main/resources/application.yml', `OPENAI_API_KEY=${rawKey}\n`);

    const result = await evaluator.evaluateCriterion('S006', tempRoot, createRunWithAgent(fakeAgentConfig()));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.agentReview).toBeUndefined();
    expect(result.details).not.toContain('Agent review');
  });

  it('does not invoke agent review for deterministic S006 passes', async () => {
    writeRepoFile('README.md', '# Clean module\n');

    const result = await evaluator.evaluateCriterion('S006', tempRoot, createRunWithAgent(fakeAgentConfig()));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.agentReview).toBeUndefined();
    expect(result.details).not.toContain('Agent review');
  });

  it.each([
    {
      name: 'unavailable fake adapter',
      config: () => fakeAgentConfig({
        available: false,
        criterionId: 'S006',
        evidenceReferences: [],
        warnings: [],
        errors: []
      }),
      expected: 'Fake criterion-agent review was unavailable'
    },
    {
      name: 'malformed advisory JSON',
      config: () => fakeAgentConfig({
        available: true,
        criterionId: 'S006',
        recommendation: 'credential_is_live',
        confidence: 'certain',
        summary: 'Bad enum output.',
        rationale: 'Bad enum rationale.',
        evidenceReferences: ['.criterion-agent/S006/excerpts/documentation.txt'],
        warnings: [],
        errors: []
      } as unknown as CriterionAgentReviewResult),
      expected: 'Fake criterion-agent review returned incomplete advisory JSON'
    },
    {
      name: 'invalid endpoint config',
      config: () => ({
        ...fakeAgentConfig(),
        adapter: 'opencode' as const,
        modelLabel: 'test-model',
        readOnlyAgentName: 'reviewer',
        endpoint: 'http://agent.example.test'
      }),
      expected: 'OpenCode endpoint must use HTTPS unless it is local or explicitly allowlisted'
    }
  ])('preserves manual S006 status when agent review has $name', async ({ config, expected }) => {
    writeRepoFile('docs/secrets.md', 'Example: Bearer abcdefghijklmnopqrstuvwxyz123456\n');

    const result = await evaluator.evaluateCriterion('S006', tempRoot, createRunWithAgent(config()));
    const details = result.criterionDetails as S006RedactedReportDetails;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(false);
    expect(details.agentReviewUnavailableReason).toContain(expected);
    expect(result.details).toContain(`Not applied: ${expected}`);
  });

  it('drops unknown advisory evidence references while preserving fake advisory details', async () => {
    writeRepoFile('docs/secrets.md', 'Example: Bearer abcdefghijklmnopqrstuvwxyz123456\n');

    const result = await evaluator.evaluateCriterion('S006', tempRoot, createRunWithAgent(fakeAgentConfig({
      available: true,
      criterionId: 'S006',
      recommendation: 'needs_reviewer_judgment',
      confidence: 'medium',
      summary: 'S006 fake review summary.',
      rationale: 'S006 fake review rationale.',
      evidenceReferences: ['.criterion-agent/S006/excerpts/documentation.txt', 'docs/secrets.md'],
      warnings: [],
      errors: []
    })));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.evidenceReferences).toEqual(['.criterion-agent/S006/excerpts/documentation.txt']);
    expect(result.agentReview?.warnings.join('\n')).toContain('Dropped');
    expect(result.details).toContain('Dropped');
  });

  it('preserves manual S006 status when OpenCode review command fails', async () => {
    writeRepoFile('docs/secrets.md', 'Example: Bearer abcdefghijklmnopqrstuvwxyz123456\n');
    const run = createRunWithAgent({
      enabled: true,
      enabledCriteria: ['S006'],
      adapter: 'opencode',
      modelLabel: 'test-model',
      readOnlyAgentName: 'reviewer',
      endpoint: 'https://api.example.test',
      endpointFamily: 'openai-compatible'
    }, new CompositeS006Runner(new FakeS006GitleaksRunner(), new FailingOpenCodeRunner()));

    const result = await evaluator.evaluateCriterion('S006', tempRoot, run);
    const details = result.criterionDetails as S006RedactedReportDetails;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(false);
    expect(details.agentReviewUnavailableReason).toContain('OpenCode review failed');
    expect(result.details).toContain('OpenCode review failed');
  });

  it('still scans explicit FOLIO library repositories instead of returning not applicable', async () => {
    const rawKey = 'sk-proj-library1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile('package.json', JSON.stringify({ name: '@folio/stripes-components' }));
    writeRepoFile('.env.production', `OPENAI_API_KEY=${rawKey}\n`);

    const result = await evaluator.evaluateCriterion('S006', tempRoot, createRun());
    const details = result.criterionDetails as S006RedactedReportDetails;

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.status).not.toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(details.findings.some(finding => finding.path === '.env.production')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(rawKey);
  });

  it('criteria filtering to S006 evaluates only S006 and does not create unrelated shared artifacts', async () => {
    writeRepoFile('README.md', '# Clean module\n');
    const run = EvaluationRunUtils.createEvaluationRun({
      repositoryPath: tempRoot,
      language: 'java',
      criteriaFilter: ['S006'],
      commandRunner: new FakeS006GitleaksRunner()
    });

    const results = await evaluator.evaluate(tempRoot, ['S006'], run);

    expect(results).toHaveLength(1);
    expect(results[0].criterionId).toBe('S006');
    expect(results[0].status).toBe(EvaluationStatus.PASS);
    expect(run.artifacts.moduleDescriptor).toBeUndefined();
    expect(run.artifacts.moduleKind).toBeUndefined();
  });

  function writeRepoFile(relativePath: string, content: string): void {
    const absolutePath = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }

  function createRunWithAgent(agentReview: CriterionAgentReviewConfig, commandRunner?: CommandRunner) {
    return EvaluationRunUtils.createEvaluationRun({
      repositoryPath: tempRoot,
      language: 'java',
      criteriaFilter: ['S006'],
      agentReview,
      commandRunner: commandRunner ?? new FakeS006GitleaksRunner()
    });
  }

  function createRun(commandRunner: CommandRunner = new FakeS006GitleaksRunner()) {
    return EvaluationRunUtils.createEvaluationRun({
      repositoryPath: tempRoot,
      language: 'java',
      criteriaFilter: ['S006'],
      commandRunner
    });
  }

  function fakeAgentConfig(fakeResult?: CriterionAgentReviewResult): CriterionAgentReviewConfig {
    return {
      enabled: true,
      enabledCriteria: ['S006'],
      adapter: 'fake',
      modelLabel: 'fake-model',
      fakeResult: fakeResult ?? {
        available: true,
        criterionId: 'S006',
        recommendation: 'needs_reviewer_judgment',
        confidence: 'medium',
        summary: 'S006 fake review summary.',
        rationale: 'S006 fake review rationale.',
        evidenceReferences: ['.criterion-agent/S006/excerpts/documentation.txt'],
        warnings: [],
        errors: []
      }
    };
  }
});

class FailingOpenCodeRunner implements CommandRunner {
  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify(request);
  }

  async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    const isRun = request.args?.[0] === 'run';
    return {
      identity: this.normalize(request),
      command: request.command,
      args: request.args ?? [],
      cwd: request.cwd,
      commandExecutionEnvironment: 'local',
      localCommandsAllowed: false,
      status: isRun ? 'failed' : 'success',
      exitCode: isRun ? 1 : 0,
      signal: null,
      durationMs: 1,
      stdout: isRun ? '' : this.debugStdout(request),
      stderr: isRun ? 'review crashed with token=abc123' : '',
      sanitized: true
    };
  }

  private debugStdout(request: CommandExecutionRequest): string {
    if (request.args?.[1] === 'config') {
      return JSON.stringify({ plugin: [], mcp: {}, provenance: request.env?.OPENCODE_CONFIG_DIR ?? request.cwd });
    }
    return JSON.stringify({
      provenance: request.env?.OPENCODE_CONFIG_DIR ?? request.cwd,
      tools: {
        read: true,
        glob: true,
        grep: true,
        edit: false,
        write: false,
        bash: false,
        task: false,
        webfetch: false,
        websearch: false,
        skill: false,
        todowrite: false
      }
    });
  }
}

class CompositeS006Runner implements CommandRunner {
  constructor(
    private readonly gitleaksRunner: CommandRunner,
    private readonly fallbackRunner: CommandRunner
  ) {}

  normalize(request: CommandExecutionRequest): string {
    return this.selectRunner(request).normalize(request);
  }

  async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    return await this.selectRunner(request).run(request);
  }

  private selectRunner(request: CommandExecutionRequest): CommandRunner {
    return request.command.includes('gitleaks') ? this.gitleaksRunner : this.fallbackRunner;
  }
}
