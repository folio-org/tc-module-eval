import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvaluationStatus } from '../types';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { createEvaluationRun } from '../utils/evaluation-run';

class TestSharedEvaluator extends SharedEvaluator {}

describe('S004 shared evaluator', () => {
  let tempRoot: string;
  let evaluator: TestSharedEvaluator;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's004-shared-'));
    evaluator = new TestSharedEvaluator();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('evaluates S004 instead of returning the catalog fallback', async () => {
    writeFile('README.md', `
# module
## Installation
Install the module by posting the ModuleDescriptor to Okapi and enabling it for the tenant.
`);

    const result = await evaluator.evaluateCriterion('S004', tempRoot);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).not.toContain('evaluation logic not yet implemented');
    expect(result.evidence).toContain('reviewer judgment');
  });

  it('keeps S004 in the canonical shared criteria position', () => {
    expect(evaluator.criteriaIds.slice(0, 5)).toEqual(['S001', 'S002', 'S003', 'S004', 'S005']);
  });

  it('returns not applicable for explicit library repositories', async () => {
    writeFile('package.json', JSON.stringify({ name: '@folio/stripes-components' }));

    const result = await evaluator.evaluateCriterion('S004', tempRoot);

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.evidence).toContain('library');
  });

  it('does not invoke agent review for explicit library repositories', async () => {
    writeFile('package.json', JSON.stringify({ name: '@folio/stripes-components' }));
    const run = createRunWithFakeAgent(['S004']);

    const result = await evaluator.evaluateCriterion('S004', tempRoot, run);

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.agentReview).toBeUndefined();
  });

  it('direct S004 evaluation creates a run when one is not supplied', async () => {
    writeFile('README.md', '## Build\nmvn test');

    const result = await evaluator.evaluateCriterion('S004', tempRoot);

    expect(result.status).toBe(EvaluationStatus.FAIL);
  });

  it('does not invoke agent review for deterministic S004 failures', async () => {
    writeFile('README.md', '## Build\nmvn test');
    const run = createRunWithFakeAgent(['S004']);

    const result = await evaluator.evaluateCriterion('S004', tempRoot, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.agentReview).toBeUndefined();
    expect(result.details).not.toContain('Agent review');
  });

  it('uses fake criterion-agent review only for ambiguous S004 cases', async () => {
    writeFile('README.md', 'Configuration values are documented for the module.');
    const run = createRunWithFakeAgent(['S004']);

    const result = await evaluator.evaluateCriterion('S004', tempRoot, run);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.details).toContain('Agent review');
    expect(result.details).toContain('Advisory recommendation');
    expect(result.details).not.toContain('Available: true');
  });

  it('does not invoke agent review when S004 is excluded from enabled criteria', async () => {
    writeFile('README.md', 'Configuration values are documented for the module.');
    const run = createRunWithFakeAgent(['S003']);

    const result = await evaluator.evaluateCriterion('S004', tempRoot, run);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toBeUndefined();
    expect(result.details).toContain('agent review is not enabled for S004');
  });

  it('records disabled agent review without invoking a reviewer', async () => {
    writeFile('README.md', 'Configuration values are documented for the module.');

    const result = await evaluator.evaluateCriterion('S004', tempRoot);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toBeUndefined();
    expect(result.details).toContain('agent review is disabled or unconfigured');
  });

  function createRunWithFakeAgent(enabledCriteria: string[]) {
    return createEvaluationRun({
      repositoryPath: tempRoot,
      language: 'java',
      criteriaFilter: ['S004'],
      agentReview: {
        enabled: true,
        enabledCriteria,
        adapter: 'fake',
        modelLabel: 'fake-model'
      }
    });
  }

  function writeFile(relativePath: string, content: string): void {
    const absolutePath = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content.trim());
  }
});
