import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  CriterionAgentReviewConfig,
  EvaluationStatus,
  S007AnalysisResult,
  S007TechnologyFinding
} from '../types';
import * as committedSource from '../utils/committed-source';
import { prepareCriterionReviewWorkspace, reviewCriterionWithAgent } from '../utils/criterion-agent-review';
import { buildS007AgentReviewRequest, reviewS007WithAgent } from '../utils/s007-agent-review';
import { loadS007Policy } from '../utils/s007-policy';

describe('S007 agent review', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 's007-agent-'));
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(repoPath);
  });

  it('browses full committed files, including source outside analyzer-selected paths', async () => {
    await commit({
      'package.json': JSON.stringify({ dependencies: { react: '^18' }, privatePolicy: 'keep source intact' }),
      'deployment/runtime.conf': 'runtime.framework=quarkus\npassword=source-password-value',
      'src/application.ts': 'export const framework = "quarkus";'
    });
    await fs.outputFile(path.join(repoPath, 'src/application.ts'), 'uncommitted replacement');
    await fs.outputFile(path.join(repoPath, 'src/uncommitted.ts'), 'must not appear');

    const request = await buildS007AgentReviewRequest(repoPath, analysis(finding('react', 'package.json')));
    const paths = request.files.map(file => file.repoRelativePath);

    expect(paths).toEqual(expect.arrayContaining(['package.json', 'deployment/runtime.conf', 'src/application.ts']));
    expect(paths).not.toContain('src/uncommitted.ts');
    expect(request.files.find(file => file.repoRelativePath === 'package.json')?.content).toContain('privatePolicy');
    expect(request.files.find(file => file.repoRelativePath === 'deployment/runtime.conf')?.content).toContain('source-password-value');
    expect(request.files.find(file => file.repoRelativePath === 'src/application.ts')?.content).toContain('framework = "quarkus"');
    expect(request.files.map(file => file.content).join('\n')).not.toContain('uncommitted replacement');
    expect(request.instructions).toContain('immutable committed-source snapshot');
    expect(request.instructions).toContain('including files absent from the summary');
  });

  it('keeps the full unmatched trusted policy separate while the summary is the analysis', async () => {
    await commit({ 'pom.xml': '<project />' });
    const policyLoad = await loadS007Policy();
    expect(policyLoad.ok).toBe(true);
    if (!policyLoad.ok) return;
    const deterministic = analysis(finding('unknown-framework', 'pom.xml', 'unlisted-framework'));

    const request = await buildS007AgentReviewRequest(repoPath, deterministic, policyLoad.policy);
    const summary = JSON.parse(request.files.find(file => file.repoRelativePath === '.criterion-agent/S007/deterministic-summary.json')!.content);
    const policy = JSON.parse(request.files.find(file => file.repoRelativePath === '.criterion-agent/S007/policy-context.json')!.content);

    expect(summary).toEqual(deterministic);
    expect(summary.policyContext).toBeUndefined();
    expect(policy).toEqual(policyLoad.policy);
    expect(policy.sections.length).toBeGreaterThan(1);
  });

  it('keeps late findings in valid workspace JSON beyond the old 24 KiB cap', async () => {
    await commit({ 'pom.xml': '<project />' });
    const deterministic = analysis(finding('java', 'pom.xml'));
    deterministic.findings = Array.from({ length: 150 }, (_, index) => finding(`technology-${index}`, 'pom.xml'));
    const request = await buildS007AgentReviewRequest(repoPath, deterministic);
    const summary = request.files.find(file => file.repoRelativePath.endsWith('deterministic-summary.json'))!;
    expect(Buffer.byteLength(summary.content)).toBeGreaterThan(24 * 1024);
    const workspace = prepareCriterionReviewWorkspace(request);
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(workspace.rootPath, 'docs', summary.repoRelativePath), 'utf8'));
      expect(parsed).toEqual(deterministic);
      expect(parsed.findings[149].technologyId).toBe('technology-149');
    } finally {
      await fs.remove(workspace.rootPath);
    }
  });

  it('accepts an empty deterministic inventory when a technology is discovered in committed source', async () => {
    await commit({ 'deployment/runtime.conf': 'runtime.framework=quarkus' });
    const deterministic = { ...analysis(finding('unused', '')), findings: [] };
    const review = await reviewS007WithAgent(repoPath, deterministic, fakeConfig({
      recommendation: 'likely_sufficient',
      evidenceReferences: ['deployment/runtime.conf'],
      assessments: [{
        technologyId: 'discovered:quarkus', type: 'aligned_fact',
        summary: 'Quarkus is configured as the runtime.', evidenceReferences: ['deployment/runtime.conf']
      }]
    }));

    expect(review).toMatchObject({ available: true, recommendation: 'likely_sufficient' });
    expect(deterministic.status).toBe(EvaluationStatus.MANUAL);
  });

  it('rejects unknown technology ids that are not normalized discoveries', async () => {
    await commit({ 'pom.xml': '<project />' });
    const review = await reviewS007WithAgent(repoPath, analysis(finding('spring-boot', 'pom.xml')), fakeConfig({
      recommendation: 'likely_sufficient', evidenceReferences: ['pom.xml'],
      assessments: [{ technologyId: 'mystery', type: 'aligned_fact', summary: 'Claim.', evidenceReferences: ['pom.xml'] }]
    }));
    expect(review.available).toBe(false);
    expect(review.errors.join('\n')).toContain('unknown technology');
  });

  it.each(['openapi', 'discovered:openapi'])('accepts trusted policy discovery %s without weakening known IDs', async id => {
    await commit({ 'api.yaml': 'openapi: 3.0.0', 'pom.xml': '<project />' });
    const loaded = await loadS007Policy();
    if (!loaded.ok) throw new Error('Policy fixture unavailable');
    const deterministic = analysis(finding('java', 'pom.xml'));
    const review = await reviewS007WithAgent(repoPath, deterministic, fakeConfig({
      evidenceReferences: ['api.yaml'], assessments: [
        { technologyId: id, type: 'aligned_fact', summary: 'OpenAPI 3 declared.', evidenceReferences: ['api.yaml'] },
        { technologyId: 'java', type: 'aligned_fact', summary: 'Java declared.', evidenceReferences: ['pom.xml'] }
      ]
    }), undefined, loaded.policy);
    expect(review.available).toBe(true);
    expect(review.assessments?.map(item => item.technologyId)).toEqual(['discovered:openapi', 'java']);
    expect(review.warnings).toHaveLength(id === 'openapi' ? 1 : 0);
    expect(deterministic.status).toBe(EvaluationStatus.MANUAL);
  });

  it('does not repair a bare ID without trusted policy', async () => {
    await commit({ 'api.yaml': 'openapi: 3.0.0' });
    const review = await reviewS007WithAgent(repoPath, analysis(finding('java', 'api.yaml')), fakeConfig({
      evidenceReferences: ['api.yaml'], assessments: [
        { technologyId: 'openapi', type: 'aligned_fact', summary: 'OpenAPI 3 declared.', evidenceReferences: ['api.yaml'] }
      ]
    }));
    expect(review.available).toBe(false);
    expect(review.errors.join(' ')).toContain('unknown technology');
  });

  it.each([
    ['top-level', ['.criterion-agent/S007/deterministic-summary.json'], [{ technologyId: 'react', type: 'aligned_fact', summary: 'Claim.', evidenceReferences: ['package.json'] }], undefined],
    ['nested assessment', ['package.json'], [{ technologyId: 'react', type: 'aligned_fact', summary: 'Claim.', evidenceReferences: ['.criterion-agent/S007/policy-context.json'] }], undefined],
    ['nested action', ['package.json'], [{ technologyId: 'react', type: 'policy_question', summary: 'Question.', evidenceReferences: ['package.json'] }], [{ action: 'Resolve policy applicability.', evidenceReferences: ['.criterion-agent/S007/policy-context.json'] }]]
  ])('rejects generated-only %s evidence', async (_name, evidenceReferences, assessments, reviewerActions) => {
    await commit({ 'package.json': '{"dependencies":{"react":"^18"}}' });
    const review = await reviewS007WithAgent(repoPath, analysis(finding('react', 'package.json')), fakeConfig({
      recommendation: reviewerActions ? 'needs_reviewer_judgment' : 'likely_sufficient',
      evidenceReferences, assessments: assessments as any, reviewerActions
    }));
    expect(review.available).toBe(false);
    expect(review.errors.join('\n')).toContain('requires repository evidence');
  });

  it('preserves status and redacts advisory output, not repository source', async () => {
    await commit({ 'package.json': '{"dependencies":{"react":"^18"},"token":"source-secret-value"}' });
    const deterministic = analysis(finding('react', 'package.json'));
    const request = await buildS007AgentReviewRequest(repoPath, deterministic);
    expect(request.files.find(file => file.repoRelativePath === 'package.json')?.content).toContain('source-secret-value');

    const review = await reviewS007WithAgent(repoPath, deterministic, fakeConfig({
      recommendation: 'likely_sufficient', summary: 'token=output-secret-value',
      rationale: 'password=output-password-value', evidenceReferences: ['package.json'],
      assessments: [{ technologyId: 'react', type: 'aligned_fact', summary: 'React is declared.', evidenceReferences: ['package.json'] }]
    }));
    expect(deterministic.status).toBe(EvaluationStatus.MANUAL);
    expect(`${review.summary}\n${review.rationale}`).not.toMatch(/output-secret-value|output-password-value/);
  });

  it.each([
    ['likely_insufficient', 'evidence_gap', 'Missing version', [], 'substantive concern'],
    ['likely_insufficient', 'substantive_concern', '   ', [], 'Invalid or uncited assessments'],
    ['needs_reviewer_judgment', 'policy_question', 'Policy uncertainty', [], 'reviewer action'],
    ['needs_reviewer_judgment', 'policy_question', 'Policy uncertainty', [{ action: '   ', evidenceReferences: ['pom.xml'] }], 'reviewer action']
  ])('rejects %s without substantive support or an actionable follow-up', async (recommendation, type, summary, reviewerActions, error) => {
    await commit({ 'pom.xml': '<project />' });
    const review = await reviewS007WithAgent(repoPath, analysis(finding('spring-boot', 'pom.xml')), fakeConfig({
      recommendation, evidenceReferences: ['pom.xml'], reviewerActions,
      assessments: [{ technologyId: 'spring-boot', type, summary, evidenceReferences: ['pom.xml'] }]
    }));
    expect(review.available).toBe(false);
    expect(review.errors.join('\n')).toContain(error);
  });

  it('throws direct preparation errors and orchestration catches them', async () => {
    jest.spyOn(committedSource, 'readCommittedSource').mockResolvedValue({
      revision: 'a'.repeat(40), complete: false,
      diagnostics: [{ code: 'git-error', message: 'fixture failure', material: true }], files: []
    });
    const deterministic = analysis(finding('react', 'package.json'));
    await expect(buildS007AgentReviewRequest(repoPath, deterministic)).rejects.toThrow('workspace is incomplete');
    await expect(reviewS007WithAgent(repoPath, deterministic, fakeConfig({}))).rejects.toThrow('workspace is incomplete');

    const result = await reviewCriterionWithAgent({
      criterionId: 'S007', status: EvaluationStatus.MANUAL, hasReviewMaterial: true,
      evaluationRun: { agentReview: fakeConfig({}) } as any,
      review: config => reviewS007WithAgent(repoPath, deterministic, config)
    });
    expect(result.agentReview?.available).toBe(false);
    expect(result.unavailableReason).toContain('Agent review failed unexpectedly');
  });

  it.each([
    ['disabled', { enabled: false, adapter: 'fake' } as CriterionAgentReviewConfig, 'disabled'],
    ['excluded', { enabled: true, enabledCriteria: ['S006'], adapter: 'fake' } as CriterionAgentReviewConfig, 'not enabled'],
    ['malformed', fakeConfig({ recommendation: 'pass' as any, confidence: 'certain' as any }), 'incomplete advisory JSON']
  ])('preserves manual status when review is %s', async (_name, config, expected) => {
    await commit({ 'package.json': '{"dependencies":{"react":"^18"}}' });
    const deterministic = analysis(finding('react', 'package.json'));
    const review = await reviewS007WithAgent(repoPath, deterministic, config);
    expect(deterministic.status).toBe(EvaluationStatus.MANUAL);
    expect(review.available).toBe(false);
    expect(review.errors.join('\n')).toContain(expected);
  });

  async function commit(files: Record<string, string>): Promise<void> {
    for (const [relativePath, content] of Object.entries(files)) {
      await fs.outputFile(path.join(repoPath, relativePath), content);
    }
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoPath });
  }
});

function analysis(item: S007TechnologyFinding): S007AnalysisResult {
  return {
    criterionId: 'S007', status: EvaluationStatus.MANUAL, summary: 'S007 manual',
    policyFormatVersion: '1.0', findings: [item], policyDiagnostics: [], evidenceDiagnostics: []
  };
}

function finding(technologyId: string, sourcePath: string, classification: S007TechnologyFinding['classification'] = 'unresolved'): S007TechnologyFinding {
  return {
    technologyId, displayName: technologyId, classification, contribution: 'manual',
    rationale: 'Reviewer judgment required.',
    evidence: sourcePath ? [{ path: sourcePath, detail: `${technologyId} declaration` }] : [],
    advisories: [], statusDetermining: true
  };
}

function fakeConfig(overrides: Record<string, any>): CriterionAgentReviewConfig {
  return {
    enabled: true, enabledCriteria: ['S007'], adapter: 'fake', modelLabel: 'fake-model',
    fakeResult: {
      available: true, criterionId: 'S007', recommendation: 'likely_sufficient', confidence: 'medium',
      summary: 'Review.', rationale: 'Repository source was considered.', evidenceReferences: [],
      assessments: [], reviewerActions: [], warnings: [], errors: [], ...overrides
    }
  };
}
