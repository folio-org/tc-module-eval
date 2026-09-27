import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { CommandRunner, EvaluationStatus, S010Analysis } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';

class TestEvaluator extends SharedEvaluator {}

describe('S010 shared evaluator integration', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 's010-shared-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  });
  afterEach(async () => { await fs.remove(repo); });

  it('evaluates committed Java fail-fast evidence, caches it, and executes no target command', async () => {
    await fs.outputFile(path.join(repo, 'pom.xml'), '<project><artifactId>mod-example</artifactId></project>');
    await fs.outputJson(path.join(repo, 'descriptors/ModuleDescriptor-template.json'), {
      id: 'mod-example-1.0.0', launchDescriptor: { env: [{ name: 'SEARCH_URL', required: true }] }
    });
    await fs.outputFile(path.join(repo, 'src/main/java/SearchConfig.java'), 'class SearchConfig { @Value("${SEARCH_URL}") String url; }');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S010'], commandRunner: runner });
    const evaluator = new TestEvaluator('java');

    const first = await evaluator.evaluateCriterion('S010', repo, run);
    await fs.outputFile(path.join(repo, 'src/main/java/SearchConfig.java'), 'dirty checkout must be ignored');
    const second = await evaluator.evaluateCriterion('S010', repo, run);

    expect(first.status).toBe(EvaluationStatus.PASS);
    expect(second.criterionDetails).toEqual(first.criterionDetails);
    expect(run.artifacts.s010ThirdPartyEvidence).toBeDefined();
    expect(run.artifacts.moduleDescriptor).toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
    expect((first.criterionDetails as S010Analysis).findings[0].evidence[0].path).toContain('ModuleDescriptor');
  });

  it('returns not applicable for an explicit committed library', async () => {
    await fs.outputFile(path.join(repo, 'pom.xml'), '<project><artifactId>folio-spring-base</artifactId></project>');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
    const result = await new TestEvaluator('java').evaluateCriterion('S010', repo);
    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
  });

  it('returns manual for unsupported general Node runtime', async () => {
    await fs.outputJson(path.join(repo, 'package.json'), { name: 'mod-node', dependencies: { express: '4.0.0' } });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
    const result = await new TestEvaluator('javascript').evaluateCriterion('S010', repo);
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Runtime kind: node');
  });
});
