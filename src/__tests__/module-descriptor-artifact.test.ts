import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  EvaluationRun
} from '../types';
import { produceModuleDescriptorArtifact } from '../utils/artifacts/module-descriptor-artifact';
import { createEvaluationRun } from '../utils/evaluation-run';

class FakeRunner implements CommandRunner {
  calls: CommandExecutionRequest[] = [];

  constructor(private readonly handler: (request: CommandExecutionRequest) => CommandExecutionResult) {}

  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify({ command: request.command, args: request.args, cwd: request.cwd });
  }

  async run(request: CommandExecutionRequest, evaluationRun?: EvaluationRun): Promise<CommandExecutionResult> {
    this.calls.push(request);
    const identity = this.normalize(request);
    const cached = evaluationRun?.commandObservations.get(identity);
    if (cached) {
      return cached;
    }
    const result = this.handler(request);
    evaluationRun?.commandObservations.set(identity, result);
    return result;
  }
}

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'module-descriptor-artifact-'));
}

function commandResult(request: CommandExecutionRequest, status: CommandExecutionResult['status'] = 'success'): CommandExecutionResult {
  return {
    identity: JSON.stringify(request),
    command: request.command,
    args: request.args ?? [],
    cwd: request.cwd,
    executionMode: 'trusted-local',
    status,
    exitCode: status === 'success' ? 0 : 1,
    durationMs: 1,
    stdout: '',
    stderr: '',
    sanitized: true,
    errorMessage: status === 'success' ? undefined : status
  };
}

describe('module-descriptor-artifact', () => {
  it('should select a static root descriptor', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-static-1.0.0' }));

    const result = await produceModuleDescriptorArtifact(repo);

    expect(result.status).toBe('discovered');
    expect(result.strategy).toBe('static-root');
    expect(result.descriptorPath).toBe('ModuleDescriptor.json');
    expect(result.warnings).toEqual([]);
  });

  it('should reject template-only repositories', async () => {
    const repo = tempRepo();
    fs.mkdirSync(path.join(repo, 'descriptors'));
    fs.writeFileSync(path.join(repo, 'descriptors', 'ModuleDescriptor-template.json'), JSON.stringify({ id: 'template' }));

    const result = await produceModuleDescriptorArtifact(repo);

    expect(result.status).toBe('invalid-candidate');
    expect(result.errors.join('\n')).toContain('templates');
  });

  it('should not fall through to static descriptor after Maven command failure', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><artifactId>mod-example</artifactId></project>');
    fs.writeFileSync(path.join(repo, 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
    const runner = new FakeRunner(request => commandResult(request, 'failed'));

    const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

    expect(result.status).toBe('command-failed');
    expect(result.strategy).toBe('maven-generation');
    expect(result.descriptorPath).toBeUndefined();
  });

  it('should select a generated Maven descriptor and record command evidence', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><artifactId>mod-example</artifactId></project>');
    fs.mkdirSync(path.join(repo, 'target'));
    const runner = new FakeRunner(request => {
      fs.writeFileSync(path.join(repo, 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
      return commandResult(request);
    });

    const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

    expect(result.status).toBe('produced');
    expect(result.strategy).toBe('maven-generation');
    expect(result.descriptorPath).toBe('target/ModuleDescriptor.json');
    expect(result.command?.command).toBe('mvn');
    expect(result.warnings.join('\n')).toContain('Descriptor written during evaluation');
  });

  it('should select a nested Maven module descriptor generated under target', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><artifactId>mod-example</artifactId></project>');
    fs.mkdirSync(path.join(repo, 'submodule', 'target'), { recursive: true });
    const runner = new FakeRunner(request => {
      fs.writeFileSync(path.join(repo, 'submodule', 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
      return commandResult(request);
    });

    const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

    expect(result.status).toBe('produced');
    expect(result.descriptorPath).toBe('submodule/target/ModuleDescriptor.json');
  });

  it('should return ambiguous candidates when multiple generated descriptors cannot be matched', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><artifactId>mod-example</artifactId></project>');
    fs.mkdirSync(path.join(repo, 'a', 'target'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'b', 'target'), { recursive: true });
    const runner = new FakeRunner(request => {
      fs.writeFileSync(path.join(repo, 'a', 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-one-1.0.0' }));
      fs.writeFileSync(path.join(repo, 'b', 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-two-1.0.0' }));
      return commandResult(request);
    });

    const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

    expect(result.status).toBe('ambiguous-candidates');
    expect(result.errors.join('\n')).toContain('Ambiguous generated descriptors');
  });

  it('should match the generated descriptor whose id contains the Maven artifactId', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><artifactId>mod-example</artifactId></project>');
    fs.mkdirSync(path.join(repo, 'a', 'target'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'b', 'target'), { recursive: true });
    const runner = new FakeRunner(request => {
      fs.writeFileSync(path.join(repo, 'a', 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-other-1.0.0' }));
      fs.writeFileSync(path.join(repo, 'b', 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
      return commandResult(request);
    });

    const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

    expect(result.status).toBe('produced');
    expect(result.descriptorPath).toBe('b/target/ModuleDescriptor.json');
  });

  it('should reuse an existing normalized command observation from EvaluationRun', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><artifactId>mod-example</artifactId></project>');
    fs.mkdirSync(path.join(repo, 'target'));
    fs.writeFileSync(path.join(repo, 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
    const runner = new FakeRunner(request => commandResult(request));
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', commandRunner: runner });

    const first = await produceModuleDescriptorArtifact(repo, run, runner);
    const second = await produceModuleDescriptorArtifact(repo, run, runner);

    expect(first.status).toBe('produced');
    expect(second.status).toBe('produced');
    expect(runner.calls).toHaveLength(2);
    expect(run.commandObservations.size).toBe(1);
  });
});
