import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JavaSharedEvaluator } from '../evaluators/java/java-shared-evaluator';
import { EvaluationStatus, ModuleDescriptorArtifact } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 's002-module-descriptor-'));
}

function artifact(repo: string, descriptor: object): ModuleDescriptorArtifact {
  const descriptorPath = path.join(repo, 'ModuleDescriptor.json');
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
  return {
    status: 'discovered',
    strategy: 'static-root',
    descriptorPath: 'ModuleDescriptor.json',
    absolutePath: descriptorPath,
    warnings: [],
    errors: []
  };
}

describe('S002 module descriptor evaluator', () => {
  beforeEach(() => {
    setLogger(new NoopLogger());
  });

  afterEach(() => {
    resetLogger();
  });

  it('should pass for a staged valid static descriptor', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    run.artifacts.moduleDescriptor = artifact(repo, { id: 'mod-example-1.0.0' });
    const evaluator = new JavaSharedEvaluator();

    const result = await evaluator.evaluateCriterion('S002', repo, run);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe(
      'The module descriptor ModuleDescriptor.json (committed at the repository root) matches the Okapi ModuleDescriptor schema.'
    );
    expect(result.details).toContain('Source: committed file at the repository root');
  });

  it('should fail for schema-invalid descriptors with validation details', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    run.artifacts.moduleDescriptor = artifact(repo, {
      name: 'missing id',
      provides: [{ id: 'example', version: '1.0', handlers: [{ methods: 'GET', pathPattern: '/x', foo: 1 }] }]
    });
    const evaluator = new JavaSharedEvaluator();

    const result = await evaluator.evaluateCriterion('S002', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toContain('does not match the Okapi ModuleDescriptor schema: 3 problems');
    expect(result.details).toContain([
      'Schema problems:',
      '  - Missing required field "id"',
      '  - Field "provides[0].handlers[0].foo" is not allowed by the schema',
      '  - Field "provides[0].handlers[0].methods" must be an array'
    ].join('\n'));
  });

  it('should not pass when the artifact stage rejected templates', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    run.artifacts.moduleDescriptor = {
      status: 'invalid-candidate',
      warnings: [],
      errors: ['Only descriptor templates were found (descriptors/ModuleDescriptor-template.json), and nothing generates a ModuleDescriptor.json from them.']
    };
    const evaluator = new JavaSharedEvaluator();

    const result = await evaluator.evaluateCriterion('S002', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toContain('Only descriptor templates were found');
    expect(result.evidence).toContain('Commit a ModuleDescriptor.json at the repository root, or add a build step that generates it.');
  });

  it('should reuse the same lazy artifact slot for repeated direct evaluation', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    const originalGetOrCreate = run.getOrCreateArtifact.bind(run);
    const getOrCreateSpy = jest.fn(originalGetOrCreate);
    run.getOrCreateArtifact = getOrCreateSpy;
    const evaluator = new JavaSharedEvaluator();

    const first = await evaluator.evaluateCriterion('S002', repo, run);
    const second = await evaluator.evaluateCriterion('S002', repo, run);

    expect(first.status).toBe(EvaluationStatus.PASS);
    expect(second.status).toBe(EvaluationStatus.PASS);
    expect(getOrCreateSpy).toHaveBeenCalledTimes(2);
    expect(run.artifacts.moduleDescriptor?.descriptorPath).toBe('ModuleDescriptor.json');
  });

  it('should fail with artifact context when selected descriptor cannot be read', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    run.artifacts.moduleDescriptor = {
      status: 'discovered',
      strategy: 'static-root',
      descriptorPath: 'ModuleDescriptor.json',
      absolutePath: path.join(repo, 'ModuleDescriptor.json'),
      warnings: [],
      errors: []
    };
    const evaluator = new JavaSharedEvaluator();

    const result = await evaluator.evaluateCriterion('S002', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toContain('ModuleDescriptor.json (committed at the repository root) could not be read');
    expect(result.details).toContain('Descriptor: ModuleDescriptor.json');
    expect(result.details).toContain('Read error:');
  });

  it('should explain a skipped descriptor build and list the error output of a failed build', async () => {
    const repo = tempRepo();
    const command = {
      identity: 'mvn', command: 'mvn', args: ['process-resources', '-DskipTests'], cwd: repo,
      commandExecutionEnvironment: 'local' as const, durationMs: 0, stdout: '', stderr: '', sanitized: true
    };
    const evaluator = new JavaSharedEvaluator();

    const blockedRun = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    blockedRun.artifacts.moduleDescriptor = {
      status: 'unsafe-to-run',
      strategy: 'maven-generation',
      command: { ...command, status: 'blocked', localCommandsAllowed: false },
      warnings: [],
      errors: ['Command requires build-tool execution, but local commands are not allowed']
    };
    const blocked = await evaluator.evaluateCriterion('S002', repo, blockedRun);

    expect(blocked.status).toBe(EvaluationStatus.MANUAL);
    expect(blocked.evidence).toContain('generated by the Maven build, which was not run because build commands are turned off');
    expect(blocked.details).toContain('Build command: mvn process-resources -DskipTests (not run: build commands are turned off)');

    const failedRun = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    failedRun.artifacts.moduleDescriptor = {
      status: 'command-failed',
      strategy: 'maven-generation',
      command: { ...command, status: 'failed', exitCode: 1, localCommandsAllowed: true },
      warnings: [],
      errors: ['Command exited with code 1: [ERROR] first line\n[ERROR] second line']
    };
    const failed = await evaluator.evaluateCriterion('S002', repo, failedRun);

    expect(failed.status).toBe(EvaluationStatus.MANUAL);
    expect(failed.evidence).toContain('The Maven build that generates the module descriptor failed with exit code 1');
    expect(failed.details).toContain('Build error:\n  - [ERROR] first line\n  - [ERROR] second line');
  });
});
