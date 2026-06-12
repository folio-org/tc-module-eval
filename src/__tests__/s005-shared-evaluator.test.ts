import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvaluationStatus, S005PersonalDataDisclosureAnalysisResult } from '../types';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { createEvaluationRun } from '../utils/evaluation-run';

class TestSharedEvaluator extends SharedEvaluator {}

describe('S005 shared evaluator', () => {
  let tempRoot: string;
  let evaluator: TestSharedEvaluator;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's005-shared-'));
    evaluator = new TestSharedEvaluator();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps S005 in canonical shared criteria order after S004', () => {
    expect(evaluator.criteriaIds.slice(0, 6)).toEqual(['S001', 'S002', 'S003', 'S004', 'S005', 'S006']);
  });

  it('evaluates S005 instead of returning the catalog fallback', async () => {
    const result = await evaluator.evaluateCriterion('S005', tempRoot);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toContain('Required top-level PERSONAL_DATA_DISCLOSURE.md was not found');
    expect(result.evidence).not.toContain('evaluation logic not yet implemented');
    expect(result.evidence).not.toContain('Version control and branching strategy');
  });

  it('returns not applicable for explicit FOLIO library repositories without agent review', async () => {
    writeFile('package.json', JSON.stringify({ name: '@folio/stripes-components' }));
    writeFile('PERSONAL_DATA_DISCLOSURE.md', 'this would be unparseable without the library short-circuit');
    const run = createRunWithFakeAgent();

    const result = await evaluator.evaluateCriterion('S005', tempRoot, run);

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.evidence).toContain('library');
    expect(result.agentReview).toBeUndefined();
    expect(result.details).toContain('Explicit allowlisted library marker');
  });

  it('direct S005 evaluation creates an EvaluationRun when one is not supplied', async () => {
    writeCompletedDisclosure();

    const result = await evaluator.evaluateCriterion('S005', tempRoot);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.criterionDetails).toBeDefined();
  });

  it('returns fail through SharedEvaluator when the exact disclosure file is missing', async () => {
    writeFile('PERSONAL_DATA_DISCOSURE.md', completedDisclosure());

    const result = await evaluator.evaluateCriterion('S005', tempRoot);
    const details = result.criterionDetails as S005PersonalDataDisclosureAnalysisResult;

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toContain('Required top-level PERSONAL_DATA_DISCLOSURE.md was not found');
    expect(details.discovery.status).toBe('missing');
    expect(details.discovery.attempts).toEqual([
      { path: 'PERSONAL_DATA_DISCOSURE.md', reason: 'root-near-match' }
    ]);
  });

  it('returns manual for completed forms with structured criterionDetails', async () => {
    writeCompletedDisclosure();
    writeFile('schemas/user.json', JSON.stringify({ email: 'string', firstName: 'string' }));

    const result = await evaluator.evaluateCriterion('S005', tempRoot);
    const details = result.criterionDetails as S005PersonalDataDisclosureAnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(details.classification.parseState).toBe('completed');
    expect(details.parseResult?.checkedCategories).toContain('no_personal_data');
    expect(details.evidenceScan?.signals.some(signal => signal.category === 'email')).toBe(true);
    expect(details.possibleMismatches.length).toBeGreaterThan(0);
  });

  it('preserves module-kind warnings in S005 details', async () => {
    writeFile('package.json', '{ invalid json');
    writeCompletedDisclosure();

    const result = await evaluator.evaluateCriterion('S005', tempRoot);
    const details = result.criterionDetails as S005PersonalDataDisclosureAnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Unable to parse package.json');
    expect(details.warnings).toContainEqual(expect.stringContaining('Unable to parse package.json'));
    expect(details.classification.warnings).toContainEqual(expect.stringContaining('Unable to parse package.json'));
  });

  it('records an agent-not-applied reason for completed deterministic manual results', async () => {
    writeCompletedDisclosure();

    const result = await evaluator.evaluateCriterion('S005', tempRoot, createRunWithFakeAgent());
    const details = result.criterionDetails as S005PersonalDataDisclosureAnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toBeUndefined();
    expect(details.agentReviewUnavailableReason).toContain('not applied');
    expect(result.details).toContain('Agent review: S005 agent review is not applied');
  });

  function createRunWithFakeAgent() {
    return createEvaluationRun({
      repositoryPath: tempRoot,
      language: 'java',
      criteriaFilter: ['S005'],
      agentReview: {
        enabled: true,
        enabledCriteria: ['S005'],
        adapter: 'fake',
        modelLabel: 'fake-model'
      }
    });
  }

  function writeCompletedDisclosure(): void {
    writeFile('PERSONAL_DATA_DISCLOSURE.md', completedDisclosure());
  }

  function completedDisclosure(): string {
    return `
# Personal Data Disclosure
Form Version: v1.1
Last Updated: 2026-06-12
Last Reviewed: 2026-06-12

## Personal Data
- [x] Does not store personal data
- [ ] Email address
- [ ] First name
`;
  }

  function writeFile(relativePath: string, content: string): void {
    const absolutePath = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content.trim());
  }
});
