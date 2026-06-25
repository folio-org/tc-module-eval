import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { JavaScriptSharedEvaluator } from '../evaluators/javascript/javascript-shared-evaluator';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { EvaluationStatus, S006RedactedReportDetails } from '../types';
import * as EvaluationRunUtils from '../utils/evaluation-run';

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

    const javaResult = await evaluator.evaluateCriterion('S006', tempRoot);
    const javascriptResult = await new JavaScriptSharedEvaluator().evaluateCriterion('S006', tempRoot);

    for (const result of [javaResult, javascriptResult]) {
      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toContain('S006 found no retained sensitive or environment-specific findings');
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
    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.criterionDetails).toBeDefined();
  });

  it('returns pass through SharedEvaluator when no findings are present and scan coverage is complete', async () => {
    writeRepoFile('README.md', '# Clean module\n');

    const result = await evaluator.evaluateCriterion('S006', tempRoot);
    const details = result.criterionDetails as S006RedactedReportDetails;

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(details.findingCount).toBe(0);
    expect(details.coverage.complete).toBe(true);
    expect(details.coverage.materiallyWeakened).toBe(false);
  });

  it('returns fail through SharedEvaluator for a high-confidence production secret', async () => {
    const rawKey = 'sk-proj-prod1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile('src/main/resources/application.yml', `OPENAI_API_KEY=${rawKey}\n`);

    const result = await evaluator.evaluateCriterion('S006', tempRoot);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toContain('high-confidence live-looking secret');
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
      expectedDetail: 'documentation evidence'
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
      expectedDetail: 'local-default context'
    }
  ])('returns manual through SharedEvaluator for $name', async ({ files, expectedDetail }) => {
    for (const [relativePath, content] of Object.entries(files)) {
      writeRepoFile(relativePath, content);
    }

    const result = await evaluator.evaluateCriterion('S006', tempRoot);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toContain('require reviewer judgment');
    expect(result.details).toContain(expectedDetail);
  });

  it('still scans explicit FOLIO library repositories instead of returning not applicable', async () => {
    const rawKey = 'sk-proj-library1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile('package.json', JSON.stringify({ name: '@folio/stripes-components' }));
    writeRepoFile('.env.production', `OPENAI_API_KEY=${rawKey}\n`);

    const result = await evaluator.evaluateCriterion('S006', tempRoot);
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
      criteriaFilter: ['S006']
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
});
