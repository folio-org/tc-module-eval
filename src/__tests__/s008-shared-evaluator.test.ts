import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { CommandRunner, EvaluationStatus } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';

class TestEvaluator extends SharedEvaluator {}

describe('S008 shared evaluator integration', () => {
  let repo: string;
  beforeEach(async () => { repo = await fs.mkdtemp(path.join(os.tmpdir(), 's008-shared-')); });
  afterEach(async () => { await fs.remove(repo); });

  it('uses official by default, reports honest policy blocker, and invokes no command runner', async () => {
    await fs.ensureDir(path.join(repo, 'descriptors'));
    await fs.writeJson(path.join(repo, 'descriptors/ModuleDescriptor-template.json'), { requires: [{ id: 'users', version: '1.0' }] });
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const result = await new TestEvaluator().evaluateCriterion('S008', repo, createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S008'], commandRunner: runner }));
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Catalog channel: official');
    expect(result.details).toContain('ledger_not_authoritative');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('selects development explicitly and reports a missing selected catalog', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { name: 'ui-example', stripes: { okapiInterfaces: {} } });
    const run = createEvaluationRun({ repositoryPath: repo, language: 'javascript', criteriaFilter: ['S008'], s008CatalogChannel: 'development' });
    const result = await new TestEvaluator('javascript').evaluateCriterion('S008', repo, run);
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Catalog channel: development');
    expect(result.details).toContain('policy_missing');
  });

  it('returns not applicable for an explicit library before policy validation', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { name: '@folio/stripes-core' });
    const result = await new TestEvaluator('javascript').evaluateCriterion('S008', repo);
    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
  });

  it('runs S008 both alone and as part of the full shared criterion set', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { name: 'ui-example', stripes: { okapiInterfaces: {} } });
    const evaluator = new TestEvaluator('javascript');
    const only = await evaluator.evaluate(repo, ['S008']);
    const full = await evaluator.evaluate(repo);
    expect(only.map(item => item.criterionId)).toEqual(['S008']);
    expect(full.map(item => item.criterionId)).toContain('S008');
  });
});
