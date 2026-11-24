import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JavaSharedEvaluator } from '../evaluators/java/java-shared-evaluator';
import { JavaScriptSharedEvaluator } from '../evaluators/javascript/javascript-shared-evaluator';
import { OKAPI_MODULE_DESCRIPTOR_SCHEMA_BASELINE } from '../schemas/okapi/module-descriptor';
import { CommandExecutionRequest, CommandExecutionResult, CommandRunner, EvaluationStatus, ModuleDescriptorArtifact } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { classifyModuleKind } from '../utils/module-kind';
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
    expect(result.details!.split('\n').slice(0, 3)).toEqual([
      'What to do: Nothing; the module descriptor matches the Okapi ModuleDescriptor schema.',
      'Descriptor: ModuleDescriptor.json',
      'Source: committed file at the repository root'
    ]);
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

  it('should generate the descriptor once when one run evaluates S002 twice', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><artifactId>mod-example</artifactId></project>');
    // Counts every generation and caches nothing itself, so a second run of the build means the artifact was not reused.
    const generations: CommandExecutionRequest[] = [];
    const commandRunner: CommandRunner = {
      normalize: request => JSON.stringify(request),
      async run(request) {
        generations.push(request);
        fs.mkdirSync(path.join(repo, 'target'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
        return {
          identity: JSON.stringify(request), command: request.command, args: request.args ?? [], cwd: request.cwd,
          commandExecutionEnvironment: 'local', localCommandsAllowed: true, status: 'success', exitCode: 0,
          durationMs: 1, stdout: '', stderr: '', sanitized: true
        };
      }
    };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'], commandRunner });
    const evaluator = new JavaSharedEvaluator();

    const first = await evaluator.evaluateCriterion('S002', repo, run);
    const second = await evaluator.evaluateCriterion('S002', repo, run);

    expect(first.status).toBe(EvaluationStatus.PASS);
    expect(second.status).toBe(EvaluationStatus.PASS);
    expect(generations).toHaveLength(1);
    expect(generations[0].command).toBe('mvn');
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
    expect(blocked.details!.split('\n')).toEqual([
      'What to do: Rerun the evaluation with --allow-local-commands on a trusted machine, or check the module descriptor against the Okapi ModuleDescriptor schema by hand.',
      'Source: Maven build',
      'Build command: mvn process-resources -DskipTests (not run: build commands are turned off)'
    ]);

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
      status: 'command-failed', strategy: 'gradle-generation',
      command: { ...command, exitCode: 1, stderr: 'error: early failure\n[output truncated to 65536 bytes]', stderrTruncated: true },
      warnings: [], errors: ['Command exited with code 1']
    };
    const truncated = await evaluator.evaluateCriterion('S002', repo, truncatedRun);

    expect(truncated.details).toContain(
      'Build error (error lines from the build output; the build printed more than the evaluator keeps, so the final lines are missing):\n  - error: early failure'
    );
  });

  it('should list the end of Maven output that the runner cut at its start, without a cut-off note', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    run.artifacts.moduleDescriptor = {
      status: 'command-failed', strategy: 'maven-generation',
      command: {
        identity: 'mvn', command: 'mvn', args: ['-B', '-ntp', 'process-resources', '-DskipTests'], cwd: repo,
        commandExecutionEnvironment: 'local', localCommandsAllowed: true, status: 'failed', exitCode: 1, durationMs: 0,
        stdout: '[output truncated: kept the last 60 of 900000 bytes]\n[INFO] BUILD FAILURE\n[ERROR] Failed to execute goal\n',
        stdoutTruncated: true, stderr: '', sanitized: true
      },
      warnings: [], errors: ['Command exited with code 1']
    };

    const result = await new JavaSharedEvaluator().evaluateCriterion('S002', repo, run);

    expect(result.details!.split('\n').slice(-2)).toEqual(['Build error (error lines from the end of the build output):', '  - [ERROR] Failed to execute goal']);
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

  describe('Stripes packages', () => {
    const install = 'Install command: yarn install --ignore-scripts --ignore-engines --pure-lockfile';
    const checkedAgainst = `Checked against: Okapi ModuleDescriptor schema (${OKAPI_MODULE_DESCRIPTOR_SCHEMA_BASELINE})`;

    function stripesRepo(packageJson: object = {}): string {
      const repo = tempRepo();
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
        name: '@folio/ui-example',
        stripes: { actsAs: ['app'] },
        scripts: { 'build-mod-descriptor': 'stripes mod descriptor --full | jq \'.[]\' > module-descriptor.json' },
        ...packageJson
      }));
      return repo;
    }

    function scriptRunner(
      writeOutput: () => void,
      install: Partial<CommandExecutionResult> = {}
    ): CommandRunner & { calls: CommandExecutionRequest[] } {
      const calls: CommandExecutionRequest[] = [];
      return {
        calls,
        normalize: request => JSON.stringify(request),
        async run(request) {
          calls.push(request);
          const isInstall = request.args?.[0] === 'install';
          if (!isInstall) {
            writeOutput();
          }
          return {
            identity: JSON.stringify(request), command: request.command, args: request.args ?? [], cwd: request.cwd,
            commandExecutionEnvironment: 'local', localCommandsAllowed: true, status: 'success', exitCode: 0,
            durationMs: 1, stdout: '', stderr: '', sanitized: true,
            ...(isInstall ? install : {})
          };
        }
      };
    }

    async function evaluate(repo: string, runner: CommandRunner) {
      const run = createEvaluationRun({ repositoryPath: repo, language: 'javascript', criteriaFilter: ['S002'], commandRunner: runner });
      return new JavaScriptSharedEvaluator().evaluateCriterion('S002', repo, run);
    }

    it('should not apply to a Stripes library and run nothing', async () => {
      const repo = stripesRepo({ name: '@folio/stripes-acq-components', stripes: { actsAs: [''] } });
      const runner = scriptRunner(() => undefined);

      const result = await evaluate(repo, runner);

      expect(runner.calls).toEqual([]);
      expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
      expect(result.evidence).toBe('S002 does not apply to explicit FOLIO library repositories');
      expect(result.details!.split('\n')).toEqual([
        'What to do: Nothing; S002 does not apply to FOLIO libraries.',
        'Repository kind: library',
        'Module-kind evidence:',
        '  - Stripes metadata in package.json declares no actsAs role'
      ]);
    });

    it('should pass a valid module-descriptor.json written after the dependency install', async () => {
      const repo = stripesRepo();
      const runner = scriptRunner(() => fs.writeFileSync(path.join(repo, 'module-descriptor.json'), JSON.stringify({ id: 'folio_example-1.0.0' })));

      const result = await evaluate(repo, runner);

      expect(runner.calls.map(call => call.args)).toEqual([['install', '--ignore-scripts', '--ignore-engines', '--pure-lockfile'], ['run', 'build-mod-descriptor']]);
      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toBe('The module descriptor module-descriptor.json (generated by the build-mod-descriptor script) matches the Okapi ModuleDescriptor schema.');
      expect(result.details!.split('\n')).toEqual([
        'What to do: Nothing; the module descriptor matches the Okapi ModuleDescriptor schema.',
        'Descriptor: module-descriptor.json',
        'Source: build-mod-descriptor script in package.json',
        `${install} (ran locally and succeeded)`,
        'Build command: yarn run build-mod-descriptor (ran locally and succeeded)',
        checkedAgainst,
        'Notes:',
        '  - module-descriptor.json was generated during this evaluation; it is not committed to the repository.'
      ]);
    });

    it('should keep a UI module a UI module when its script writes ModuleDescriptor.json at the root', async () => {
      const repo = stripesRepo();
      const run = createEvaluationRun({
        repositoryPath: repo, language: 'javascript', criteriaFilter: ['S002'],
        commandRunner: scriptRunner(() => fs.writeFileSync(path.join(repo, 'ModuleDescriptor.json'), JSON.stringify({ id: 'folio_example-1.0.0' })))
      });

      const result = await new JavaScriptSharedEvaluator().evaluateCriterion('S002', repo, run);

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(run.artifacts.moduleKind?.kind).toBe('ui-module');
      expect(classifyModuleKind(repo).kind).toBe('ui-module');
    });

    it('should report a generated descriptor that cannot be read', async () => {
      const repo = stripesRepo();
      const runner = scriptRunner(() => fs.mkdirSync(path.join(repo, 'module-descriptor.json')));

      const result = await evaluate(repo, runner);

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe('The module descriptor module-descriptor.json (generated by the build-mod-descriptor script) could not be read, so it could not be checked against the Okapi schema.');
      expect(result.details!.split('\n')).toEqual([
        'What to do: Make the module descriptor a readable file inside the repository and rerun the evaluation, or check it against the Okapi ModuleDescriptor schema by hand.',
        'Descriptor: module-descriptor.json',
        'Source: build-mod-descriptor script in package.json',
        `${install} (ran locally and succeeded)`,
        'Build command: yarn run build-mod-descriptor (ran locally and succeeded)',
        'Read error: it is not a regular file',
        'Notes:',
        '  - module-descriptor.json was generated during this evaluation; it is not committed to the repository.'
      ]);
    });

    it('should fail when the script exits successfully but leaves an empty descriptor', async () => {
      const repo = stripesRepo();
      const runner = scriptRunner(() => fs.writeFileSync(path.join(repo, 'module-descriptor.json'), ''));

      const result = await evaluate(repo, runner);

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe(
        'The build-mod-descriptor script exited successfully, but the module-descriptor.json it left at the repository root is empty; a command earlier in the script may have failed without failing the script. '
        + 'Fix the build-mod-descriptor script so it writes the module descriptor to ModuleDescriptor.json or module-descriptor.json at the repository root.'
      );
      expect(result.details!.split('\n')).toEqual([
        'What to do: Fix the build-mod-descriptor script so it writes the module descriptor to ModuleDescriptor.json or module-descriptor.json at the repository root.',
        'Descriptor: module-descriptor.json',
        'Source: build-mod-descriptor script in package.json',
        `${install} (ran locally and succeeded)`,
        'Build command: yarn run build-mod-descriptor (ran locally and succeeded)'
      ]);
    });

    it('should fail when the script exits successfully but leaves a descriptor that is not JSON', async () => {
      const repo = stripesRepo();
      const runner = scriptRunner(() => fs.writeFileSync(path.join(repo, 'module-descriptor.json'), 'stripes: command not found\n'));

      const result = await evaluate(repo, runner);

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe(
        'The module descriptor module-descriptor.json (generated by the build-mod-descriptor script) is not valid JSON, so it could not be checked against the Okapi schema. '
        + 'Fix the syntax error under "JSON error" in the package.json settings the build-mod-descriptor script generates it from.'
      );
    });

    it('should need manual review when the dependency install fails or is turned off', async () => {
      const failedRepo = stripesRepo();
      const failed = await evaluate(failedRepo, scriptRunner(() => undefined, {
        status: 'failed', exitCode: 1, stderr: 'error An unexpected error occurred: "https://registry.yarnpkg.com/@folio%2fstripes-cli: ETIMEDOUT".\n'
      }));

      expect(failed.status).toBe(EvaluationStatus.MANUAL);
      expect(failed.evidence).toBe(
        'Installing the dependencies of the build-mod-descriptor script failed with exit code 1, so the module descriptor could not be generated or checked. '
        + 'A reviewer needs to check whether the build works and its descriptor is valid.'
      );
      expect(failed.details!.split('\n')).toEqual([
        'What to do: Check by hand whether the build-mod-descriptor script works and whether the descriptor it generates matches the Okapi ModuleDescriptor schema.',
        'Source: build-mod-descriptor script in package.json',
        `${install} (ran locally and failed with exit code 1)`,
        'Build error (error lines from the end of the build output):',
        '  - error An unexpected error occurred: "https://registry.yarnpkg.com/@folio%2fstripes-cli: ETIMEDOUT".'
      ]);

      const blockedRepo = stripesRepo();
      const blocked = await evaluate(blockedRepo, scriptRunner(() => undefined, {
        status: 'blocked', exitCode: undefined, localCommandsAllowed: false, errorMessage: 'Command requires build-tool execution, but local commands are not allowed'
      }));

      expect(blocked.status).toBe(EvaluationStatus.MANUAL);
      expect(blocked.evidence).toBe(
        'The module descriptor is generated by the build-mod-descriptor script, which was not run because build commands are turned off for this evaluation. '
        + 'Rerun with --allow-local-commands on a trusted machine, or check the descriptor by hand.'
      );
      expect(blocked.details!.split('\n')).toEqual([
        'What to do: Rerun the evaluation with --allow-local-commands on a trusted machine, or check the module descriptor against the Okapi ModuleDescriptor schema by hand.',
        'Source: build-mod-descriptor script in package.json',
        `${install} (not run: build commands are turned off)`
      ]);
    });
  });
});

