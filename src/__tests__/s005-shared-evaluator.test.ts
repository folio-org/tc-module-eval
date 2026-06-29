import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CriterionAgentReviewResult, EvaluationStatus, S005PersonalDataDisclosureAnalysisResult } from '../types';
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
    const run = createRunWithFakeAgent(['S005']);

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
    expect(result.details).toContain('Missing exact file: PERSONAL_DATA_DISCLOSURE.md');
    expect(result.details).toContain('PERSONAL_DATA_DISCOSURE.md (root-near-match)');
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
    expect(result.details).toContain('Parsed disclosure fields:');
    expect(result.details).toContain('Deterministic evidence:');
    expect(result.details).toContain('Possible mismatches:');
    expect(result.details).toContain('Supporting deterministic evidence:');
    expect(JSON.stringify(result.criterionDetails)).not.toContain('# Personal Data Disclosure');
    expect(JSON.stringify(result.criterionDetails)).not.toContain(tempRoot);
    expect(JSON.stringify(result.criterionDetails)).toContain('"sizeBytes"');
  });

  it('reports blank-template placeholders and unchecked answers without dumping the whole file', async () => {
    writeFile('PERSONAL_DATA_DISCLOSURE.md', `
# Personal Data Disclosure
Form Version: v1.1
Last Updated: YYYY-MM-DD
Last Reviewed: YYYY-MM-DD

## Personal Data
- [ ] Does not store personal data
- [ ] Email address

This long template instruction should not be dumped as whole-file report content.
`);

    const result = await evaluator.evaluateCriterion('S005', tempRoot);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.details).toContain('Placeholder/incomplete evidence:');
    expect(result.details).toContain('Unchecked answer evidence:');
    expect(result.details).toContain('Last updated: YYYY-MM-DD');
    expect(result.details).not.toContain('This long template instruction should not be dumped as whole-file report content.');
  });

  it('shows contradiction details before advisory agent output', async () => {
    writeFile('PERSONAL_DATA_DISCLOSURE.md', `
# Personal Data Disclosure
Form Version: v1.1
Last Updated: 2026-06-12
Last Reviewed: 2026-06-12

## Personal Data
- [x] Does not store personal data
- [x] Email address
`);
    writeFile('schemas/user.json', JSON.stringify({ email: 'string' }));

    const result = await evaluator.evaluateCriterion('S005', tempRoot, createRunWithFakeAgent(['S005']));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    const renderedDetails = result.details ?? '';
    expect(renderedDetails).toContain('Contradictions:');
    expect(renderedDetails.indexOf('Contradictions:')).toBeLessThan(renderedDetails.indexOf('Agent review:'));
    expect(renderedDetails).toContain('Advisory recommendation: likely_insufficient');
  });

  it('preserves module-kind warnings in S005 details', async () => {
    writeFile('package.json', '{ invalid json');
    writeCompletedDisclosure();

    const result = await evaluator.evaluateCriterion('S005', tempRoot);
    const details = result.criterionDetails as S005PersonalDataDisclosureAnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Unable to parse package.json');
    expect(details.warnings).toContainEqual(expect.stringContaining('Unable to parse package.json'));
    expect(details.classification).not.toHaveProperty('warnings');
  });

  it('invokes fake agent review for completed forms with candidate evidence when S005 is enabled', async () => {
    writeCompletedDisclosure();
    writeFile('schemas/user.json', JSON.stringify({ email: 'string', firstName: 'string' }));

    const result = await evaluator.evaluateCriterion('S005', tempRoot, createRunWithFakeAgent(['S005']));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.recommendation).toBe('likely_insufficient');
    expect(result.agentReview?.evidenceReferences).toEqual(['.criterion-agent/S005/evidence/evidence-001.txt']);
    expect(result.details).toContain('Agent review');
    expect(result.details).toContain('Advisory recommendation: likely_insufficient');
    expect(result.details).not.toContain('Evidence references:');
    expect(result.details).not.toContain('.criterion-agent/S005/evidence/evidence-001.txt');
  });

  it('records disabled agent review for completed forms with candidate evidence when unconfigured', async () => {
    writeCompletedDisclosure();
    writeFile('schemas/user.json', JSON.stringify({ email: 'string' }));

    const result = await evaluator.evaluateCriterion('S005', tempRoot);
    const details = result.criterionDetails as S005PersonalDataDisclosureAnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toBeUndefined();
    expect(details.agentReviewUnavailableReason).toContain('agent review is disabled or unconfigured');
    expect(result.details).toContain('agent review is disabled or unconfigured');
  });

  it('records S005 exclusion when agent review is enabled for other criteria only', async () => {
    writeCompletedDisclosure();
    writeFile('schemas/user.json', JSON.stringify({ email: 'string' }));

    const result = await evaluator.evaluateCriterion('S005', tempRoot, createRunWithFakeAgent(['S004']));
    const details = result.criterionDetails as S005PersonalDataDisclosureAnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toBeUndefined();
    expect(details.agentReviewUnavailableReason).toContain('agent review is not enabled for S005');
    expect(result.details).toContain('agent review is not enabled for S005');
  });

  it('records a no-candidate-material reason for completed form-only manual results', async () => {
    writeCompletedDisclosure();

    const result = await evaluator.evaluateCriterion('S005', tempRoot, createRunWithFakeAgent(['S005']));
    const details = result.criterionDetails as S005PersonalDataDisclosureAnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toBeUndefined();
    expect(details.agentReviewUnavailableReason).toContain('no candidate evidence');
    expect(result.details).toContain('no candidate evidence was available for agent review');
  });

  it.each([
    {
      name: 'unavailable',
      fakeResult: {
        available: false,
        criterionId: 'S005',
        evidenceReferences: [],
        warnings: [],
        errors: []
      },
      expected: 'Fake criterion-agent review was unavailable'
    },
    {
      name: 'malformed',
      fakeResult: {
        available: true,
        criterionId: 'S005',
        recommendation: 'likely_insufficient',
        confidence: 'medium',
        evidenceReferences: [],
        warnings: [],
        errors: []
      } as unknown as CriterionAgentReviewResult,
      expected: 'Fake criterion-agent review returned incomplete advisory JSON'
    },
    {
      name: 'config-unavailable',
      config: {
        endpoint: 'http://agent.example.test'
      },
      expected: 'OpenCode endpoint must use HTTPS unless it is local or explicitly allowlisted'
    }
  ])('reports $name agent review as not applied with the reason', async ({ fakeResult, config, expected }) => {
    writeCompletedDisclosure();
    writeFile('schemas/user.json', JSON.stringify({ email: 'string' }));

    const result = await evaluator.evaluateCriterion('S005', tempRoot, createRunWithFakeAgent(['S005'], fakeResult, config));
    const details = result.criterionDetails as S005PersonalDataDisclosureAnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(false);
    expect(details.agentReviewUnavailableReason).toContain(expected);
    expect(result.details).toContain(`Not applied: ${expected}`);
  });

  it('does not invoke agent review for deterministic S005 failures', async () => {
    writeFile('PERSONAL_DATA_DISCLOSURE.md', `
# Personal Data Disclosure
Last Updated: YYYY-MM-DD
Last Reviewed: YYYY-MM-DD
- [ ] Does not store personal data
- [ ] Email address
`);

    const result = await evaluator.evaluateCriterion('S005', tempRoot, createRunWithFakeAgent(['S005']));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.agentReview).toBeUndefined();
    expect(result.details).not.toContain('Agent review');
  });

  function createRunWithFakeAgent(
    enabledCriteria: string[],
    fakeResult?: CriterionAgentReviewResult,
    config?: { endpoint?: string }
  ) {
    return createEvaluationRun({
      repositoryPath: tempRoot,
      language: 'java',
      criteriaFilter: ['S005'],
      agentReview: {
        enabled: true,
        enabledCriteria,
        adapter: 'fake',
        modelLabel: 'fake-model',
        endpoint: config?.endpoint,
        fakeResult: fakeResult ?? {
          available: true,
          criterionId: 'S005',
          recommendation: 'likely_insufficient',
          confidence: 'medium',
          summary: 'S005 fake review summary.',
          rationale: 'S005 fake review rationale.',
          evidenceReferences: ['.criterion-agent/S005/evidence/evidence-001.txt'],
          warnings: [],
          errors: []
        }
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
