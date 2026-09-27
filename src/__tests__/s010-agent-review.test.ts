import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { CriterionAgentReviewConfig, EvaluationStatus, S010Analysis } from '../types';
import {
  buildS010AgentReviewRequest,
  hasS010AgentReviewMaterial,
  reviewS010WithAgent
} from '../utils/s010-agent-review';
import * as committedSource from '../utils/committed-source';
import { redactSensitiveText } from '../utils/redaction';

describe('S010 advisory agent review', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 's010-agent-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(repo);
  });

  it('builds an immutable broad snapshot and excludes unsafe or generated surfaces', async () => {
    await fs.outputJson(path.join(repo, 'package.json'), { name: 'mod-node', token: 'secret-token-value' });
    await fs.outputFile(path.join(repo, 'src/client.ts'), 'fetch(process.env.SEARCH_URL); password=secret-password-value');
    await fs.outputFile(path.join(repo, 'test/client.test.ts'), 'it("falls back", () => {})');
    await fs.outputFile(path.join(repo, 'docs/resilience.md'), 'Dependency behavior');
    await fs.outputFile(path.join(repo, 'dist/generated.js'), 'generated');
    await fs.outputFile(path.join(repo, '.env'), 'API_TOKEN=env-secret');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
    await fs.outputFile(path.join(repo, 'src/uncommitted.ts'), 'must not appear');

    const request = await buildS010AgentReviewRequest(repo, analysis());
    const paths = request.files.map(file => file.repoRelativePath);
    const material = request.files.map(file => file.content).join('\n');

    expect(paths).toEqual(expect.arrayContaining(['package.json', 'src/client.ts', 'test/client.test.ts', 'docs/resilience.md']));
    expect(paths).not.toEqual(expect.arrayContaining(['dist/generated.js', '.env', 'src/uncommitted.ts']));
    expect(material).toContain('secret-password-value');
    expect(request.instructions).toContain('advisory only');
    expect(request.instructions).toContain('Do not run commands');
    expect(request.instructions).toContain('Return at least one assessment');
    expect(request.schemaDescription).toContain('nonempty assessments');
  });

  it('prioritizes deterministic evidence before broad snapshot files', async () => {
    for (let index = 0; index < 40; index += 1) {
      await fs.outputFile(path.join(repo, `config/${String(index).padStart(2, '0')}.yml`), `setting: ${index}`);
    }
    await fs.outputFile(path.join(repo, 'src/client.ts'), 'fetch(process.env.SEARCH_URL)');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });

    const request = await buildS010AgentReviewRequest(repo, analysis());

    expect(request.files.map(file => file.repoRelativePath)).toContain('src/client.ts');
  });

  it('keeps the omission manifest valid and bounded for large repositories', async () => {
    for (let index = 0; index < 300; index += 1) {
      const longName = `${String(index).padStart(3, '0')}-${'x'.repeat(180)}.yml`;
      await fs.outputFile(path.join(repo, 'config', longName), `setting: ${index}`);
    }
    await fs.outputFile(path.join(repo, 'src/client.ts'), 'fetch(process.env.SEARCH_URL)');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });

    const request = await buildS010AgentReviewRequest(repo, analysis());
    const manifestFile = request.files.find(file => file.repoRelativePath.endsWith('snapshot-manifest.json'));
    const manifest = JSON.parse(manifestFile?.content ?? '') as Record<string, any>;

    expect(manifest.omittedCount).toBeGreaterThan(250);
    expect(manifest.omittedCounts).toEqual(expect.objectContaining({ 'file limit (32)': expect.any(Number) }));
    expect(manifest.omittedExamples['file limit (32)']).toHaveLength(3);
    expect(Buffer.byteLength(manifestFile?.content ?? '')).toBeLessThan(48 * 1024);
  }, 60_000);

  it('keeps the manifest valid under the workspace byte cap when logical paths are very long', async () => {
    const segment = 'x'.repeat(180);
    const deepDirectory = ['config', ...Array(18).fill(segment)].join('/');
    jest.spyOn(committedSource, 'readCommittedSource').mockResolvedValue({
      revision: 'a'.repeat(40),
      complete: true,
      diagnostics: [],
      files: Array.from({ length: 40 }, (_, index) => ({
        path: `${deepDirectory}/${String(index).padStart(2, '0')}.yml`,
        oid: String(index).padStart(40, '0'),
        size: 10,
        content: `setting: ${index}`
      }))
    });

    const request = await buildS010AgentReviewRequest(repo, analysis());
    const manifestFile = request.files.find(file => file.repoRelativePath.endsWith('snapshot-manifest.json'));
    expect(Buffer.byteLength(manifestFile?.content ?? '')).toBeLessThanOrEqual(48 * 1024);
    const workspaceContent = redactSensitiveText(manifestFile?.content ?? '', 96 * 1024);
    expect(() => JSON.parse(workspaceContent)).not.toThrow();
  });

  it('accepts cited repository assessments without changing deterministic status', async () => {
    await commit('src/client.ts', 'fetch(process.env.SEARCH_URL)');
    const deterministic = analysis();
    const review = await reviewS010WithAgent(repo, deterministic, fakeConfig({
      recommendation: 'needs_reviewer_judgment',
      confidence: 'medium',
      summary: 'The client path needs bounded-failure review.',
      rationale: 'The source identifies a search dependency but does not establish its fallback.',
      evidenceReferences: ['src/client.ts'],
      assessments: [{
        technologyId: 'search', type: 'evidence_gap',
        summary: 'The failure path is unresolved.', evidenceReferences: ['src/client.ts']
      }],
      reviewerActions: [{
        action: 'Determine whether the search request has a finite timeout and whether its failure preserves readiness.',
        evidenceReferences: ['src/client.ts']
      }]
    }));

    expect(deterministic.status).toBe(EvaluationStatus.MANUAL);
    expect(review).toMatchObject({ available: true, recommendation: 'needs_reviewer_judgment' });
  });

  it.each([
    ['generated-only citation', {
      recommendation: 'likely_sufficient', assessments: [{ technologyId: 'search', type: 'aligned_fact', summary: 'ok', evidenceReferences: ['.criterion-agent/S010/deterministic-summary.json'] }],
      evidenceReferences: ['.criterion-agent/S010/deterministic-summary.json']
    }, 'no validated repository'],
    ['unknown dependency', {
      recommendation: 'likely_sufficient', assessments: [{ technologyId: 'mystery', type: 'aligned_fact', summary: 'ok', evidenceReferences: ['src/client.ts'] }]
    }, 'unknown dependency'],
    ['insufficient without concern', {
      recommendation: 'likely_insufficient', assessments: [{ technologyId: 'search', type: 'evidence_gap', summary: 'gap', evidenceReferences: ['src/client.ts'] }]
    }, 'substantive concern'],
    ['judgment without action', {
      recommendation: 'needs_reviewer_judgment', assessments: [{ technologyId: 'search', type: 'evidence_gap', summary: 'gap', evidenceReferences: ['src/client.ts'] }]
    }, 'reviewer action']
  ])('rejects %s and preserves manual status', async (_name, overrides, expected) => {
    await commit('src/client.ts', 'fetch(process.env.SEARCH_URL)');
    const deterministic = analysis();
    const review = await reviewS010WithAgent(repo, deterministic, fakeConfig({
      confidence: 'medium', summary: 'Review.', rationale: 'Repository source was considered.',
      evidenceReferences: ['src/client.ts'], ...overrides
    } as any));
    expect(deterministic.status).toBe(EvaluationStatus.MANUAL);
    expect(review.available).toBe(false);
    expect(review.errors.join('\n')).toContain(expected);
  });

  it('gates review to deterministic manual non-library results', () => {
    const manual = analysis();
    expect(hasS010AgentReviewMaterial(manual)).toBe(true);
    expect(hasS010AgentReviewMaterial({ ...manual, status: EvaluationStatus.PASS })).toBe(false);
    expect(hasS010AgentReviewMaterial({
      ...manual,
      evidence: { ...manual.evidence, moduleKind: { kind: 'library', evidence: [], warnings: [] } }
    })).toBe(false);
  });

  async function commit(relativePath: string, content: string): Promise<void> {
    await fs.outputFile(path.join(repo, relativePath), content);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
  }
});

function analysis(): S010Analysis {
  return {
    criterionId: 'S010', status: EvaluationStatus.MANUAL, summary: 'manual',
    evidence: {
      moduleKind: { kind: 'backend-module', evidence: [], warnings: [] },
      runtimeKind: 'java', discoveryCoverage: 'complete', semanticCoverage: 'incomplete', diagnostics: [],
      scenarios: [{
        id: 'search/runtime-unavailable', dependencyId: 'search', requirement: 'unresolved',
        scenario: 'runtime-unavailable', proof: 'unresolved', boundedFailure: 'unknown', readiness: 'unknown',
        sourceReferences: [{ path: 'src/client.ts', detail: 'search request' }]
      }]
    },
    findings: [{
      id: 'search/runtime-unavailable', dependencyId: 'search', scenario: 'runtime-unavailable', outcome: 'unresolved',
      rationale: 'Failure behavior unresolved.', evidence: [{ path: 'src/client.ts', detail: 'search request' }], statusDetermining: true
    }],
    diagnostics: []
  };
}

function fakeConfig(overrides: Record<string, unknown>): CriterionAgentReviewConfig {
  return {
    enabled: true, enabledCriteria: ['S010'], adapter: 'fake',
    fakeResult: {
      available: true, criterionId: 'S010', warnings: [], errors: [],
      confidence: 'medium', summary: 'Review.', rationale: 'Repository source was considered.',
      evidenceReferences: ['src/client.ts'],
      ...overrides
    } as any
  };
}
