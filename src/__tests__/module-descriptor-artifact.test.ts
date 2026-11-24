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
import { NPM_NETWORK_POLICY } from '../utils/build-tool-policies';
import { createEvaluationRun } from '../utils/evaluation-run';
import { NoopLogger, resetLogger, setLogger } from '../utils/logger';

class FakeRunner implements CommandRunner {
  calls: CommandExecutionRequest[] = [];
  canRun?: (request: CommandExecutionRequest) => boolean;

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
    commandExecutionEnvironment: 'local',
    localCommandsAllowed: true,
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

  it('should not treat descriptors as templates because the clone directory name contains template', async () => {
    const staticRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'template-clone-'));
    fs.writeFileSync(path.join(staticRepo, 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-static-1.0.0' }));
    const mavenRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'template-clone-'));
    fs.writeFileSync(path.join(mavenRepo, 'pom.xml'), '<project><artifactId>mod-example</artifactId></project>');
    fs.mkdirSync(path.join(mavenRepo, 'target'));
    const runner = new FakeRunner(request => {
      fs.writeFileSync(path.join(mavenRepo, 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
      return commandResult(request);
    });

    const staticResult = await produceModuleDescriptorArtifact(staticRepo);
    const mavenResult = await produceModuleDescriptorArtifact(mavenRepo, undefined, runner);

    expect(staticResult.status).toBe('discovered');
    expect(staticResult.descriptorPath).toBe('ModuleDescriptor.json');
    expect(mavenResult.status).toBe('produced');
    expect(mavenResult.descriptorPath).toBe('target/ModuleDescriptor.json');
  });

  it('should not report unrelated template JSON files as descriptor templates', async () => {
    const repo = tempRepo();
    fs.mkdirSync(path.join(repo, 'src', 'main', 'resources', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'main', 'resources', 'templates', 'email.json'), '{}');

    const result = await produceModuleDescriptorArtifact(repo);

    expect(result.status).toBe('missing');
    expect(result.errors.join('\n')).not.toContain('templates');
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
    expect(runner.calls).toEqual([expect.objectContaining({
      command: 'mvn', args: ['-B', '-ntp', 'process-resources', '-DskipTests'], cwd: repo, maxOutputBytes: 64 * 1024, keepStdoutTail: true
    })]);
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
    expect(result.warnings.join('\n')).toContain('target/ModuleDescriptor.json was generated during this evaluation');
  });

  it('should generate the descriptor with Gradle in service/, as in FOLIO Grails modules', async () => {
    const repo = tempRepo();
    const service = path.join(repo, 'service');
    fs.mkdirSync(path.join(service, 'src', 'main', 'okapi'), { recursive: true });
    fs.writeFileSync(path.join(service, 'build.gradle'), '');
    fs.writeFileSync(path.join(service, 'gradlew'), '');
    fs.writeFileSync(path.join(service, 'src', 'main', 'okapi', 'ModuleDescriptor-template.json'), JSON.stringify({ id: '${info.app.name}-${info.app.version}' }));
    // A descriptor elsewhere in a build/ directory is not the one Gradle generates.
    fs.mkdirSync(path.join(repo, 'fixtures', 'example', 'build'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'fixtures', 'example', 'build', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-other-1.0.0' }));
    const runner = new FakeRunner(request => {
      const output = path.join(request.cwd, 'build', 'resources', 'main', 'okapi');
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
      return commandResult(request);
    });

    const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

    expect(runner.calls).toEqual([expect.objectContaining({ command: path.join(service, 'gradlew'), args: ['processResources'], cwd: service })]);
    expect(result.status).toBe('produced');
    expect(result.strategy).toBe('gradle-generation');
    expect(result.descriptorPath).toBe('service/build/resources/main/okapi/ModuleDescriptor.json');
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
    expect(result.errors.join('\n')).toContain('no single one could be matched to this module: a/target/ModuleDescriptor.json, b/target/ModuleDescriptor.json');
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

  it('should not match a generated descriptor whose id only starts with the artifactId', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><artifactId>mod-foo</artifactId></project>');
    fs.mkdirSync(path.join(repo, 'a', 'target'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'b', 'target'), { recursive: true });
    const runner = new FakeRunner(request => {
      fs.writeFileSync(path.join(repo, 'a', 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-foo-bar-1.0.0' }));
      fs.writeFileSync(path.join(repo, 'b', 'target', 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-foo-2.3.0-SNAPSHOT' }));
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

  describe('Stripes descriptor script', () => {
    const installArgs = ['install', '--ignore-scripts', '--ignore-engines', '--pure-lockfile'];

    beforeEach(() => setLogger(new NoopLogger()));
    afterEach(() => resetLogger());

    function stripesRepo(): string {
      const repo = tempRepo();
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
        name: '@folio/ui-example',
        scripts: { 'build-mod-descriptor': 'stripes mod descriptor --full | jq \'.[]\' > module-descriptor.json' },
        devDependencies: { '@folio/stripes-cli': '^3.0.0' }
      }));
      return repo;
    }

    function scriptRunner(repo: string, writeOutput: () => void, installStatus: CommandExecutionResult['status'] = 'success'): FakeRunner {
      return new FakeRunner(request => {
        if (request.args?.[0] === 'install') {
          if (installStatus === 'success') {
            fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
            fs.writeFileSync(path.join(repo, 'node_modules', '.bin', 'stripes'), '');
          }
          return commandResult(request, installStatus);
        }
        writeOutput();
        return commandResult(request);
      });
    }

    it('should install dependencies, devDependencies included and lifecycle scripts off, before the script and remove the install afterwards', async () => {
      const repo = stripesRepo();
      const seenByScript: string[] = [];
      const runner = scriptRunner(repo, () => {
        seenByScript.push(fs.readFileSync(path.join(repo, '.npmrc'), 'utf-8'));
        seenByScript.push(`stripes installed: ${fs.existsSync(path.join(repo, 'node_modules', '.bin', 'stripes'))}`);
        fs.writeFileSync(path.join(repo, 'module-descriptor.json'), JSON.stringify({ id: 'folio_example-1.0.0' }));
      });

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(runner.calls).toEqual([
        { command: 'yarn', args: installArgs, cwd: repo, timeoutMs: 300000, maxOutputBytes: 65536, requiresIsolation: true, networkPolicy: NPM_NETWORK_POLICY },
        { command: 'yarn', args: ['run', 'build-mod-descriptor'], cwd: repo, timeoutMs: 180000, maxOutputBytes: 65536, requiresIsolation: true, networkPolicy: NPM_NETWORK_POLICY }
      ]);
      expect(seenByScript).toEqual(['@folio:registry=https://repository.folio.org/repository/npm-folio\n', 'stripes installed: true']);
      expect(result.status).toBe('produced');
      expect(result.descriptorScript).toBe('build-mod-descriptor');
      expect(result.installCommand?.args).toEqual(installArgs);
      expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(repo, '.npmrc'))).toBe(false);
    });

    it('should keep a node_modules directory and .npmrc that were there before', async () => {
      const repo = stripesRepo();
      fs.mkdirSync(path.join(repo, 'node_modules'));
      fs.writeFileSync(path.join(repo, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
      const runner = scriptRunner(repo, () => fs.writeFileSync(path.join(repo, 'module-descriptor.json'), JSON.stringify({ id: 'folio_example-1.0.0' })));

      await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(fs.existsSync(path.join(repo, 'node_modules', '.bin', 'stripes'))).toBe(true);
      expect(fs.readFileSync(path.join(repo, '.npmrc'), 'utf-8')).toBe('registry=https://registry.npmjs.org/\n');
    });

    it('should accept module-descriptor.json and prefer the file the script wrote over a committed ModuleDescriptor.json', async () => {
      const repo = stripesRepo();
      fs.writeFileSync(path.join(repo, 'ModuleDescriptor.json'), JSON.stringify({ id: 'folio_stale-0.1.0' }));
      const runner = scriptRunner(repo, () => fs.writeFileSync(path.join(repo, 'module-descriptor.json'), JSON.stringify({ id: 'folio_example-1.0.0' })));

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(result.status).toBe('produced');
      expect(result.descriptorPath).toBe('module-descriptor.json');
      expect(result.absolutePath).toBeUndefined();
      expect(result.content).toBe(JSON.stringify({ id: 'folio_example-1.0.0' }));
      expect(result.warnings).toEqual(['module-descriptor.json was generated during this evaluation; it is not committed to the repository.']);
      expect(fs.readdirSync(repo).sort()).toEqual(['ModuleDescriptor.json', 'package.json']);
    });

    it('should prefer a committed ModuleDescriptor.json the script rewrote over a stale module-descriptor.json', async () => {
      const repo = stripesRepo();
      const descriptor = path.join(repo, 'ModuleDescriptor.json');
      fs.writeFileSync(descriptor, JSON.stringify({ id: 'folio_old-0.1.0' }));
      fs.writeFileSync(path.join(repo, 'module-descriptor.json'), JSON.stringify({ id: 'folio_stale-0.1.0' }));
      const past = new Date('2020-01-01T00:00:00Z');
      fs.utimesSync(descriptor, past, past);
      fs.utimesSync(path.join(repo, 'module-descriptor.json'), past, past);
      const runner = scriptRunner(repo, () => fs.writeFileSync(descriptor, JSON.stringify({ id: 'folio_example-1.0.0' })));

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(result.status).toBe('produced');
      expect(result.descriptorPath).toBe('ModuleDescriptor.json');
      expect(result.absolutePath).toBeUndefined();
      expect(result.content).toBe(JSON.stringify({ id: 'folio_example-1.0.0' }));
      expect(result.warnings).toEqual([]);
      expect(fs.readFileSync(descriptor, 'utf-8')).toBe(JSON.stringify({ id: 'folio_old-0.1.0' }));
    });

    it('should restore the exact bytes of a committed descriptor the script truncated', async () => {
      const repo = stripesRepo();
      const descriptor = path.join(repo, 'module-descriptor.json');
      const committed = Buffer.from('{\n  "id": "folio_example-0.9.0"\n}\n');
      fs.writeFileSync(descriptor, committed);
      const runner = scriptRunner(repo, () => fs.writeFileSync(descriptor, ''));

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(result.status).toBe('invalid-candidate');
      expect(result.warnings).toEqual([]);
      expect(fs.readFileSync(descriptor).equals(committed)).toBe(true);
      expect(fs.readdirSync(repo).sort()).toEqual(['module-descriptor.json', 'package.json']);
    });

    it('should not run anything when a root descriptor is a committed symlink, dangling or not', async () => {
      for (const linkTarget of [path.join('descriptors', 'generated.json'), 'missing.json']) {
        const repo = stripesRepo();
        fs.mkdirSync(path.join(repo, 'descriptors'));
        fs.writeFileSync(path.join(repo, 'descriptors', 'generated.json'), JSON.stringify({ id: 'folio_example-0.9.0' }));
        fs.symlinkSync(linkTarget, path.join(repo, 'module-descriptor.json'));
        const runner = scriptRunner(repo, () => fs.writeFileSync(path.join(repo, 'missing.json'), '{}'));

        const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

        expect(runner.calls).toEqual([]);
        expect(result.status).toBe('unsafe-to-run');
        expect(result.errors).toEqual([
          'module-descriptor.json at the repository root is a symbolic link, and a committed descriptor symlink cannot be safely regenerated, so the build-mod-descriptor script was not run.'
        ]);
        expect(fs.readdirSync(repo).sort()).toEqual(['descriptors', 'module-descriptor.json', 'package.json']);
      }
    });

    it('should not run anything when a root descriptor cannot be fully backed up', async () => {
      const cases: Array<[(repo: string) => void, string]> = [
        [repo => fs.writeFileSync(path.join(repo, 'ModuleDescriptor.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 32)), 'it is larger than 8 MiB'],
        [repo => fs.mkdirSync(path.join(repo, 'ModuleDescriptor.json')), 'it is not a regular file']
      ];
      for (const [arrange, reason] of cases) {
        const repo = stripesRepo();
        arrange(repo);
        const runner = scriptRunner(repo, () => undefined);

        const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

        expect(runner.calls).toEqual([]);
        expect(result.status).toBe('unsafe-to-run');
        expect(result.errors).toEqual([`ModuleDescriptor.json at the repository root could not be backed up (${reason}), so the build-mod-descriptor script was not run.`]);
        expect(fs.existsSync(path.join(repo, '.npmrc'))).toBe(false);
      }
    });

    it('should clean up and restore even when the runner rejects after the install', async () => {
      const repo = stripesRepo();
      const descriptor = path.join(repo, 'module-descriptor.json');
      const committed = Buffer.from(JSON.stringify({ id: 'folio_example-0.9.0' }));
      fs.writeFileSync(descriptor, committed);
      const runner = new FakeRunner(request => {
        if (request.args?.[0] === 'install') {
          fs.mkdirSync(path.join(repo, 'node_modules'));
          return commandResult(request);
        }
        fs.writeFileSync(descriptor, '');
        fs.writeFileSync(path.join(repo, 'ModuleDescriptor.json'), '{}');
        throw new Error('runner crashed');
      });

      await expect(produceModuleDescriptorArtifact(repo, undefined, runner)).rejects.toThrow('runner crashed');

      expect(fs.readdirSync(repo).sort()).toEqual(['module-descriptor.json', 'package.json']);
      expect(fs.readFileSync(descriptor).equals(committed)).toBe(true);
    });

    it('should need manual review when .npmrc cannot be written', async () => {
      const repo = stripesRepo();
      const realFs: typeof fs = jest.requireActual('fs');
      const writeFileSync = realFs.writeFileSync;
      const spy = jest.spyOn(realFs, 'writeFileSync').mockImplementation((target, data, options) => {
        if (path.basename(String(target)) === '.npmrc') {
          throw Object.assign(new Error('EACCES: permission denied, open \'.npmrc\''), { code: 'EACCES' });
        }
        writeFileSync(target, data, options);
      });
      const runner = scriptRunner(repo, () => undefined);

      try {
        const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

        expect(runner.calls).toEqual([]);
        expect(result.status).toBe('unsafe-to-run');
        expect(result.errors).toEqual(['The evaluator could not write the .npmrc the dependency install needs: EACCES: permission denied, open \'.npmrc\'']);
      } finally {
        spy.mockRestore();
      }
    });

    it('should not use a committed descriptor when the script wrote nothing', async () => {
      const repo = stripesRepo();
      fs.writeFileSync(path.join(repo, 'ModuleDescriptor.json'), JSON.stringify({ id: 'folio_stale-0.1.0' }));
      const runner = scriptRunner(repo, () => undefined);

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(result.status).toBe('missing');
      expect(result.errors).toEqual(['The build-mod-descriptor script ran, but it did not write ModuleDescriptor.json or module-descriptor.json at the repository root.']);
    });

    it('should reject a module-descriptor.json symlinked outside the repository and remove the link', async () => {
      const repo = stripesRepo();
      const outside = path.join(tempRepo(), 'descriptor.json');
      fs.writeFileSync(outside, JSON.stringify({ id: 'folio_outside-1.0.0' }));
      const runner = scriptRunner(repo, () => fs.symlinkSync(outside, path.join(repo, 'module-descriptor.json')));

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(result.status).toBe('missing');
      expect(fs.readdirSync(repo)).toEqual(['package.json']);
      expect(fs.readFileSync(outside, 'utf-8')).toBe(JSON.stringify({ id: 'folio_outside-1.0.0' }));
    });

    it('should record a read error when the script leaves something other than a file', async () => {
      const repo = stripesRepo();
      const runner = scriptRunner(repo, () => fs.mkdirSync(path.join(repo, 'module-descriptor.json')));

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(result.status).toBe('produced');
      expect(result.descriptorPath).toBe('module-descriptor.json');
      expect(result.readError).toBe('it is not a regular file');
      expect(result.content).toBeUndefined();
      expect(fs.readdirSync(repo)).toEqual(['package.json']);
    });

    it('should not write .npmrc when the runner would block the install', async () => {
      const repo = stripesRepo();
      const npmrcAtInstall: boolean[] = [];
      const runner = new FakeRunner(request => {
        npmrcAtInstall.push(fs.existsSync(path.join(repo, '.npmrc')));
        return commandResult(request, 'blocked');
      });
      runner.canRun = () => false;

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(result.status).toBe('unsafe-to-run');
      expect(npmrcAtInstall).toEqual([false]);
    });

    it('should keep the result and remove the rest when one removal fails', async () => {
      const repo = stripesRepo();
      const realFs: typeof fs = jest.requireActual('fs');
      const rmSync = realFs.rmSync;
      const spy = jest.spyOn(realFs, 'rmSync').mockImplementation((target, options) => {
        if (path.basename(String(target)) === 'node_modules') {
          throw Object.assign(new Error('ENOTEMPTY: directory not empty, rmdir \'node_modules/.bin\''), { code: 'ENOTEMPTY' });
        }
        rmSync(target, options);
      });
      const runner = scriptRunner(repo, () => fs.writeFileSync(path.join(repo, 'module-descriptor.json'), JSON.stringify({ id: 'folio_example-1.0.0' })));

      try {
        const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

        expect(result.status).toBe('produced');
        expect(result.warnings).toEqual([
          'module-descriptor.json was generated during this evaluation; it is not committed to the repository.',
          'The evaluator could not remove node_modules, which it created while generating the descriptor: ENOTEMPTY: directory not empty, rmdir \'node_modules/.bin\''
        ]);
        expect(spy).toHaveBeenCalledWith(path.join(repo, 'node_modules'), { recursive: true, force: true, maxRetries: 3 });
        expect(fs.readdirSync(repo).sort()).toEqual(['node_modules', 'package.json']);
      } finally {
        spy.mockRestore();
      }
    });

    it('should reject an empty descriptor left by a script that exited successfully', async () => {
      const repo = stripesRepo();
      const runner = scriptRunner(repo, () => fs.writeFileSync(path.join(repo, 'module-descriptor.json'), '\n'));

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(result.status).toBe('invalid-candidate');
      expect(result.descriptorPath).toBe('module-descriptor.json');
      expect(result.absolutePath).toBeUndefined();
      expect(result.errors).toEqual([
        'The build-mod-descriptor script exited successfully, but the module-descriptor.json it left at the repository root is empty; a command earlier in the script may have failed without failing the script.'
      ]);
    });

    it('should report a missing descriptor under both accepted names', async () => {
      const repo = stripesRepo();
      const runner = scriptRunner(repo, () => undefined);

      const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

      expect(result.status).toBe('missing');
      expect(result.errors).toEqual(['The build-mod-descriptor script ran, but it did not write ModuleDescriptor.json or module-descriptor.json at the repository root.']);
    });

    it('should not run the script when the install was blocked or failed', async () => {
      for (const [installStatus, artifactStatus] of [['blocked', 'unsafe-to-run'], ['failed', 'command-failed']] as const) {
        const repo = stripesRepo();
        const runner = scriptRunner(repo, () => undefined, installStatus);

        const result = await produceModuleDescriptorArtifact(repo, undefined, runner);

        expect(runner.calls.map(call => call.args)).toEqual([installArgs]);
        expect(result.status).toBe(artifactStatus);
        expect(result.installCommand?.status).toBe(installStatus);
        expect(result.command).toBeUndefined();
        expect(result.errors).toEqual([installStatus]);
        expect(fs.existsSync(path.join(repo, '.npmrc'))).toBe(false);
      }
    });
  });
});
