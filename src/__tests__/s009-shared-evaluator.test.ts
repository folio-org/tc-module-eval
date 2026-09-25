import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { CommandRunner, EvaluationStatus } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';

class TestEvaluator extends SharedEvaluator {}

describe('S009 shared evaluator integration', () => {
  let repo: string;
  beforeEach(async () => { repo = await fs.mkdtemp(path.join(os.tmpdir(), 's009-shared-')); });
  afterEach(async () => { await fs.remove(repo); });

  it('fails an official coordinate absent from the authoritative exact allowlist and invokes no commands', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: { '@folio/example': '1.0.0' } });
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'javascript', criteriaFilter: ['S009'], commandRunner: runner });

    const result = await new TestEvaluator('javascript').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.details).toContain('@folio/example 1.0.0: unaccepted');
    expect(result.details).toMatch(/sha256:[0-9a-f]{64}/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('passes TC-reviewed Maven and npm baseline coordinates without executing repository code', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: { '@folio/stripes': '^10.1.0' } });
    await fs.outputFile(path.join(repo, 'pom.xml'), `
      <project><dependencies><dependency>
        <groupId>org.folio</groupId><artifactId>edge-common</artifactId><version>5.1.1</version>
      </dependency></dependencies></project>
    `);
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'javascript', criteriaFilter: ['S009'], commandRunner: runner });

    const result = await new TestEvaluator('javascript').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.details).toContain('@folio/stripes ^10.1.0: accepted');
    expect(result.details).toContain('org.folio:edge-common 5.1.1: accepted');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('runs S009 alone and in the full shared criterion set', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: {} });
    const evaluator = new TestEvaluator('javascript');
    expect((await evaluator.evaluate(repo, ['S009'])).map(item => item.criterionId)).toEqual(['S009']);
    expect((await evaluator.evaluate(repo)).map(item => item.criterionId)).toContain('S009');
  });
});
