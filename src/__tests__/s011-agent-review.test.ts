import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { CriterionAgentReviewConfig, CriterionResult, EvaluationStatus } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { buildS011AgentReviewRequest } from '../utils/s011-agent-review';
import { createHtmlReport } from '../utils/report-html-template';

class TestEvaluator extends SharedEvaluator {}

const HELPER = 'src/main/java/org/folio/ProfilePictureHelper.java';
const SQL = 'src/main/java/org/folio/Repository.java';
const S5542 = `suppression:java:S5542:${HELPER}`;
const S2077 = `suppression:java:S2077:${SQL}`;
const SCOPE = 'scope:pom.xml';

describe('S011 advisory agent review', () => {
  let repo: string;
  beforeEach(async () => {
    repo = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 's011-agent-')), 'mod-users');
    await fs.outputFile(path.join(repo, HELPER), 'class ProfilePictureHelper {\n  @SuppressWarnings("java:S5542")\n  byte[] encrypt() { return null; }\n}\n');
    await fs.outputFile(path.join(repo, SQL), 'class Repository {\n  @SuppressWarnings("java:S2077")\n  void a() {}\n  @SuppressWarnings("java:S2077")\n  void b() {}\n}\n');
    await fs.outputFile(path.join(repo, 'pom.xml'), '<project><properties><sonar.exclusions>src/main/java/org/folio/model/**</sonar.exclusions></properties></project>\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'fixture'], { cwd: repo });
  });
  afterEach(async () => fs.remove(path.dirname(repo)));

  async function evaluate(review: Record<string, unknown>): Promise<CriterionResult> {
    const run = createEvaluationRun({
      repositoryPath: repo, repositoryName: 'mod-users', language: 'java', criteriaFilter: ['S011'], agentReview: fakeConfig(review)
    });
    return new TestEvaluator('java').evaluateCriterion('S011', repo, run);
  }

  const assessment = (technologyId: string, type: string, evidenceReferences: string[]) =>
    ({ technologyId, type, summary: `Assessment of ${technologyId}.`, evidenceReferences });
  const valid = {
    recommendation: 'likely_insufficient',
    assessments: [
      assessment(S2077, 'aligned_fact', [SQL]),
      assessment(S5542, 'substantive_concern', [HELPER]),
      assessment(SCOPE, 'evidence_gap', ['pom.xml'])
    ],
    reviewerActions: []
  };

  it('supplies one group per rule and file, and per scope file, to the review', async () => {
    const run = createEvaluationRun({ repositoryPath: repo, repositoryName: 'mod-users', language: 'java', criteriaFilter: ['S011'] });
    const result = await new TestEvaluator('java').evaluateCriterion('S011', repo, run);
    const request = (await prepareCriterionAgentReviewEvidence(buildS011AgentReviewRequest(repo, result.criterionDetails as any))).request;
    const groups = JSON.parse(request.files.find(file => file.repoRelativePath === '.criterion-agent/S011/review-groups.json')!.content).reviewGroups;

    expect(groups.map((group: { id: string; lines: number[] }) => [group.id, group.lines])).toEqual([
      [S5542, [2]], [S2077, [2, 4]], [SCOPE, [1]]
    ]);
    expect(groups[2].settings).toEqual([{ key: 'sonar.exclusions', value: 'src/main/java/org/folio/model/**' }]);
    expect(request.files.map(file => file.repoRelativePath)).toEqual(expect.arrayContaining([HELPER, SQL, 'pom.xml']));
    expect(request.instructions).toContain('advisory only');
  });

  it('accepts a review that judges every group and renders it under the group names', async () => {
    const result = await evaluate(valid);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.details).toContain(`    - java:S5542 suppressions in ${HELPER} — Potential problem:`);
    expect(result.details).toContain('    - Sonar analysis scope in pom.xml — Needs verification:');
    expect(result.details).toContain('  - The automated result is unchanged.');
    const html = createHtmlReport({
      repositoryUrl: 'https://github.com/folio-org/mod-users', moduleName: 'mod-users', evaluatedAt: new Date('2026-10-23T00:00:00Z'),
      language: 'java', criteria: [result]
    });
    // The HTML report names the groups the same way, not by their raw ids.
    expect(html).toContain(`java:S5542 suppressions in ${HELPER}`);
    expect(html).not.toContain(`suppression:java:S5542:${HELPER} —`);
  });

  it.each([
    ['leaves a group out', { ...valid, assessments: valid.assessments.slice(0, 2) }, 'exactly one assessment for every supplied review group'],
    ['adds an unknown group', { ...valid, assessments: [...valid.assessments, assessment('suppression:java:S1:x.java', 'aligned_fact', [SQL])] }, 'exactly one assessment'],
    ['judges a group without citing its own file', { ...valid, assessments: [assessment(S2077, 'aligned_fact', [HELPER]), ...valid.assessments.slice(1)] }, `group ${S2077} must cite its own file`],
    ['calls an unresolved group sufficient', { ...valid, recommendation: 'likely_sufficient' }, 'likely_sufficient conflicts'],
    ['uses an assessment type S011 does not define', { ...valid, assessments: [assessment(S2077, 'policy_question', [SQL]), ...valid.assessments.slice(1)] }, 'aligned_fact, substantive_concern or evidence_gap']
  ])('rejects a review that %s', async (_name, review, error) => {
    const result = await evaluate(review);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(false);
    expect(result.agentReview?.errors.join('\n')).toContain(error);
  });

  it('is not run when nothing in the repository is ignored', async () => {
    await fs.remove(path.join(repo, 'src'));
    await fs.remove(path.join(repo, 'pom.xml'));
    const result = await evaluate(valid);

    expect(result.agentReview).toBeUndefined();
    expect(result.details).toContain('  - Not applied: no candidate evidence was available for agent review');
  });
});

function fakeConfig(overrides: Record<string, unknown>): CriterionAgentReviewConfig {
  return {
    enabled: true, enabledCriteria: ['S011'], adapter: 'fake',
    fakeResult: {
      available: true, criterionId: 'S011', warnings: [], errors: [],
      confidence: 'medium', summary: 'Review.', rationale: 'Repository source was considered.',
      evidenceReferences: [SQL],
      ...overrides
    } as any
  };
}
