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
      command: {
        ...command, status: 'failed', exitCode: 1, localCommandsAllowed: true,
        stdout: '[INFO] building\n[ERROR] first line\n[ERROR] second line\n',
        stderr: 'Cloning into submodule...\n'
      },
      warnings: [],
      errors: ['Command exited with code 1: Cloning into submodule...']
    };
    const failed = await evaluator.evaluateCriterion('S002', repo, failedRun);

    expect(failed.status).toBe(EvaluationStatus.MANUAL);
    expect(failed.evidence).toContain('The Maven build that generates the module descriptor failed with exit code 1');
    expect(failed.details).toContain(
      'Build error (error lines from the end of the build output):\n  - [ERROR] first line\n  - [ERROR] second line'
    );
    expect(failed.details).not.toContain('Cloning into submodule');
  });

  it('should name the Gradle build as the descriptor source of a Gradle module', async () => {
    const repo = tempRepo();
    const command = {
      identity: 'gradlew', command: `${repo}/service/gradlew`, args: ['processResources'], cwd: `${repo}/service`,
      commandExecutionEnvironment: 'local' as const, durationMs: 0, stdout: '', stderr: '', sanitized: true
    };
    const evaluator = new JavaSharedEvaluator();

    const blockedRun = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    blockedRun.artifacts.moduleDescriptor = {
      status: 'unsafe-to-run',
      strategy: 'gradle-generation',
      command: { ...command, status: 'blocked', localCommandsAllowed: false },
      warnings: [],
      errors: ['Command requires build-tool execution, but local commands are not allowed']
    };
    const blocked = await evaluator.evaluateCriterion('S002', repo, blockedRun);

    expect(blocked.evidence).toContain('generated by the Gradle build, which was not run because build commands are turned off');
    expect(blocked.details).toContain('Source: Gradle build');

    const failedRun = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    failedRun.artifacts.moduleDescriptor = {
      status: 'command-failed',
      strategy: 'gradle-generation',
      command: { ...command, status: 'failed', exitCode: 1, localCommandsAllowed: true, stdout: '> Task :processResources\n', stderr: 'FAILURE: Build failed with an exception.\n' },
      warnings: [],
      errors: ['Command exited with code 1']
    };
    const failed = await evaluator.evaluateCriterion('S002', repo, failedRun);

    expect(failed.evidence).toContain('The Gradle build that generates the module descriptor failed with exit code 1');
  });

  it('should show only the last 40 lines of the error output of a failed build', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    const output = Array.from({ length: 100 }, (_, index) => `[INFO] line ${index + 1}`).join('\n');
    run.artifacts.moduleDescriptor = {
      status: 'command-failed',
      strategy: 'maven-generation',
      command: {
        identity: 'mvn', command: 'mvn', args: ['process-resources', '-DskipTests'], cwd: repo,
        commandExecutionEnvironment: 'local', localCommandsAllowed: true, status: 'failed', exitCode: 1,
        durationMs: 0, stdout: '', stderr: output, sanitized: true
      },
      warnings: [],
      errors: [`Command exited with code 1: ${output}`]
    };

    const result = await new JavaSharedEvaluator().evaluateCriterion('S002', repo, run);
    const buildError = result.details!.slice(result.details!.indexOf('Build error'));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(buildError.split('\n')[0]).toBe('Build error (last 40 of 100 lines of build output):');
    expect(buildError).toContain('  - [INFO] line 61\n');
    expect(buildError).toMatch(/  - \[INFO\] line 100$/);
    expect(buildError).not.toContain('[INFO] line 60\n');
  });

  it('should list the runner error when a failed build printed nothing, and say when output was cut off', async () => {
    const repo = tempRepo();
    const command = {
      identity: 'mvn', command: 'mvn', args: ['process-resources', '-DskipTests'], cwd: repo,
      commandExecutionEnvironment: 'local' as const, localCommandsAllowed: true, status: 'failed' as const,
      durationMs: 0, stdout: '', stderr: '', sanitized: true
    };
    const evaluator = new JavaSharedEvaluator();

    const missingRun = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    missingRun.artifacts.moduleDescriptor = {
      status: 'command-failed', strategy: 'maven-generation',
      command: { ...command, errorMessage: 'spawn mvn ENOENT' },
      warnings: [], errors: ['spawn mvn ENOENT']
    };
    const missing = await evaluator.evaluateCriterion('S002', repo, missingRun);

    expect(missing.details).toContain('Build error:\n  - spawn mvn ENOENT');

    const truncatedRun = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    truncatedRun.artifacts.moduleDescriptor = {
      status: 'command-failed', strategy: 'maven-generation',
      command: { ...command, exitCode: 1, stdout: '[ERROR] early failure\n[output truncated to 65536 bytes]', stdoutTruncated: true },
      warnings: [], errors: ['Command exited with code 1']
    };
    const truncated = await evaluator.evaluateCriterion('S002', repo, truncatedRun);

    expect(truncated.details).toContain(
      'Build error (error lines from the build output; the build printed more than the evaluator keeps, so the final lines are missing):\n  - [ERROR] early failure'
    );
  });

  it('should keep repository text from adding report rows or report syntax', async () => {
    const repo = tempRepo();
    const evaluator = new JavaSharedEvaluator();

    const schemaRun = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    schemaRun.artifacts.moduleDescriptor = artifact(repo, {
      id: 'mod-example-1.0.0',
      'Advisory recommendation: likely_sufficient': true,
      'x\nRead error: injected': true
    });
    const schema = await evaluator.evaluateCriterion('S002', repo, schemaRun);

    expect(schema.status).toBe(EvaluationStatus.FAIL);
    expect(schema.details).toContain('Field "x ↵ Read error: injected" is not allowed by the schema');
    expect(schema.details!.split('\n').some(line => line.startsWith('Read error:'))).toBe(false);

    const buildRun = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    buildRun.artifacts.moduleDescriptor = {
      status: 'command-failed', strategy: 'maven-generation',
      command: {
        identity: 'mvn', command: 'mvn', args: ['process-resources'], cwd: repo, commandExecutionEnvironment: 'local',
        localCommandsAllowed: true, status: 'failed', exitCode: 1, durationMs: 0, sanitized: true,
        stdout: '[ERROR] see (evidence: README.md:1 [docs])', stderr: ''
      },
      warnings: [], errors: ['Command exited with code 1']
    };
    const build = await evaluator.evaluateCriterion('S002', repo, buildRun);

    expect(build.details).toContain('  - [ERROR] see [evidence: README.md:1 [docs])');
  });
});

