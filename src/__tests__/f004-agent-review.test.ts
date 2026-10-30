import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus, F004Analysis, UiRuntimeEvidence, UiRuntimeProbe } from '../types';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { buildF004AgentReviewRequest } from '../utils/f004-agent-review';
import { evaluateF004, F004_GUIDES_DIRECTORY, readF004Files } from '../utils/f004-accessibility';
import { loadF006Guidelines } from '../utils/f006-ui-patterns';
import { readFrontendSource } from '../utils/frontend-source';
import { FakeProbe, RUNTIME } from './helpers/ui-runtime';

describe('F004 agent review', () => {
  let repoPath: string;
  const guides = loadF006Guidelines(F004_GUIDES_DIRECTORY);
  const AXE = '.criterion-agent/F004/axe-results.json';

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f004-agent-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    write('package.json', JSON.stringify({ name: '@folio/example', version: '2.1.0', stripes: { actsAs: ['app'], route: '/example' } }));
    write('.eslintrc', '{ "extends": "@folio/eslint-config-stripes" }\n');
    write('src/Main.js', [
      'export default ({ open }) => (',
      '  <main>',
      '    <div onClick={open}>Open</div> {/* eslint-disable-line jsx-a11y/click-events-have-key-events */}',
      '  </main>',
      ');'
    ].join('\n'));
    write('src/Main.test.js', "import { runAxeTest } from '@folio/stripes-testing';\n");
    write('src/Other.test.js', "it('renders', () => {});\n");
    commit();
  });
  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  const OBLIGATIONS = ['F004-C1#1', 'F004-C1#2', 'F004-C2#1', 'F004-C3#1', 'F004-C4#1', 'F004-C5#1'];
  const holds = (id: string, fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
    technologyId: id, type: 'aligned_fact', summary: 'Holds.', evidenceReferences: ['src/Main.js'], coverageDisposition: 'investigated', ...fields
  });
  const action = { action: 'Check the contrast of the empty results message in the deployed theme.', evidenceReferences: ['src/Main.js'] };

  it('gives the agent the axe results, the accessibility guides, and the source and axe tests to browse', async () => {
    const prepared = (await prepareCriterionAgentReviewEvidence(buildF004AgentReviewRequest(repoPath, await analyze(RUNTIME), guides))).request;
    const paths = prepared.files.map(file => file.repoRelativePath);

    expect(paths).toEqual(expect.arrayContaining(['src/Main.js', 'package.json', '.eslintrc', 'src/Main.test.js', AXE,
      '.criterion-agent/F004/accessibility-guides/AccessibilityTestingWithAxe.mdx']));
    expect(paths).not.toContain('src/Other.test.js');
    const axe = JSON.parse(prepared.files.find(file => file.repoRelativePath === AXE)!.content);
    expect(axe.deployedModule).toEqual({ id: 'folio_example', version: '2.1.1099000000000453' });
    expect(axe.evaluatedPackageVersion).toBe('2.1.0');
    expect(axe.pages.map((page: { path: string; violations?: Array<{ id: string; nodeCount: number }> }) =>
      [page.path, page.violations?.map(violation => [violation.id, violation.nodeCount])])).toEqual([
      ['/example', [['color-contrast', 2], ['aria-allowed-attr', 1]]], ['/settings/example', []], ['/settings/about', undefined]]);
    const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/F004/checklist.json')!.content);
    expect(checklist.items.flatMap((item: { obligations: unknown[] }) => item.obligations)).toEqual([
      { id: 'F004-C1#1', subject: '/example: color-contrast' },
      { id: 'F004-C1#2', subject: '/example: aria-allowed-attr' },
      { id: 'F004-C2#1', subject: 'src/Main.js:3 jsx-a11y/click-events-have-key-events', path: 'src/Main.js', line: 3 },
      { id: 'F004-C3#1' }, { id: 'F004-C4#1' }, { id: 'F004-C5#1' }
    ]);
  });

  it('keeps a runtime finding that cites only the axe results, but drops a source finding that does', async () => {
    const result = await evaluateWith(new FakeProbe(RUNTIME), fakeConfig({
      assessments: OBLIGATIONS.map(id => id === 'F004-C1#1'
        ? holds(id, { type: 'substantive_concern', summary: 'The empty results message is grey on white.', evidenceReferences: [AXE] })
        : id === 'F004-C2#1' ? holds(id, { evidenceReferences: [AXE] }) : holds(id)),
      reviewerActions: [action]
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.droppedItems).toEqual([{ kind: 'assessment', technologyId: 'F004-C2#1', reason: 'It cites only generated context, not a repository file.' }]);
    const lines = (result.details ?? '').split('\n');
    const start = lines.indexOf('  - F004-C1 axe DevTools (current major version) finds no WCAG 2.1 AA violations caused by the module on its main screens.');
    expect(lines.slice(start, start + 18)).toEqual([
      '  - F004-C1 axe DevTools (current major version) finds no WCAG 2.1 AA violations caused by the module on its main screens.',
      '    - Start with:',
      '      - package.json — stripes.route /example',
      '      - /example — on the running UI: color-contrast (serious, 2 elements), aria-allowed-attr (critical, 1 element)',
      '      - /settings/example — no violations on the running UI',
      '    - Agent: Potential problem — /example: color-contrast: The empty results message is grey on white.',
      '      - Sources:',
      `        - ${AXE}`,
      '      - Coverage judgment: Investigated directly',
      '    - Agent: Supported by evidence — /example: aria-allowed-attr: Holds.',
      '      - Sources:',
      '        - src/Main.js',
      '      - Coverage judgment: Investigated directly',
      '  - F004-C2 Interactive elements have accessible names and keyboard support; each disabled jsx-a11y rule is justified.',
      '    - Start with:',
      '      - src/Main.js:3 — jsx-a11y/click-events-have-key-events disabled',
      '      - src/Main.js:3 — <div> with onClick, no role',
      '    - Agent result dropped — src/Main.js:3 jsx-a11y/click-events-have-key-events: It cites only generated context, not a repository file.'
    ]);
  });

  it.each([
    ['listed in --criterion-agent-criteria', ['F004']],
    ['with no criteria list', undefined]
  ])('does not run without runtime evidence, %s, and says why', async (_name, enabledCriteria) => {
    const config = fakeConfig({ assessments: OBLIGATIONS.map(id => holds(id)), reviewerActions: [action] });
    if (enabledCriteria) config.enabledCriteria = enabledCriteria;
    else delete config.enabledCriteria;

    const result = await evaluateWith(undefined, config);

    expect(result.agentReview).toBeUndefined();
    expect((result.details ?? '').split('\n').slice(-2)).toEqual(['Agent review:',
      '  - Not applied: F004 agent review needs runtime evidence from a running FOLIO UI (--ui-runtime-url and --ui-runtime-login-origin), and none was given']);
  });

  it('does not run when the probe ran axe on no page', async () => {
    const stopped: UiRuntimeEvidence = { ...RUNTIME, outcome: 'stopped', problem: 'logging in did not finish within 30 s',
      pages: [{ ...RUNTIME.pages[0], axe: undefined, problem: 'the page did not finish within 30 s' }, RUNTIME.pages[2]] };
    const result = await evaluateWith(new FakeProbe(stopped), fakeConfig({ assessments: [], reviewerActions: [action] }));

    expect(result.agentReview).toBeUndefined();
    const lines = (result.details ?? '').split('\n');
    expect(lines).toContain('  - Stopped: logging in did not finish within 30 s');
    expect(lines.slice(-1)).toEqual(['  - Not applied: F004 agent review needs runtime evidence, and the probe of the running UI collected none (see "Runtime evidence")']);
  });

  it('cuts the axe results to 48 KB, keeping every page and counting what it left out', async () => {
    const node = { target: '#x', html: `<div>${'x'.repeat(290)}</div>` };
    const violations = Array.from({ length: 40 }, (_unused, index) => ({ id: `rule-${index}`, impact: 'serious', help: 'Help', nodeCount: 25, nodes: Array(10).fill(node) }));
    const runtime: UiRuntimeEvidence = { ...RUNTIME, pages: RUNTIME.pages.map(page => page.axe ? { ...page, axe: { ...page.axe, violations } } : page) };
    const prepared = buildF004AgentReviewRequest(repoPath, await analyze(runtime), guides);
    const text = prepared.files.find(file => file.repoRelativePath === AXE)!.content;
    const axe = JSON.parse(text);

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(48 * 1024);
    expect(axe.pages.map((page: { path: string }) => page.path)).toEqual(['/example', '/settings/example', '/settings/about']);
    const first = axe.pages[0];
    expect(first.violations.length + (first.violationsNotShown ?? 0)).toBe(40);
    expect(first.violations[0].nodes.length + first.violations[0].nodesNotShown).toBe(25);
  });

  async function analyze(runtime: UiRuntimeEvidence): Promise<F004Analysis> {
    return evaluateF004({ source: await readFrontendSource(repoPath), files: await readF004Files(repoPath), runtime, guides });
  }
  async function evaluateWith(probe: UiRuntimeProbe | undefined, config: CriterionAgentReviewConfig) {
    return new FrontendEvaluator().evaluateCriterion('F004', repoPath, createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', agentReview: config, uiRuntime: probe }));
  }
  function fakeConfig(fields: Record<string, unknown>): CriterionAgentReviewConfig {
    return { enabled: true, enabledCriteria: ['F004'], adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
      available: true, criterionId: 'F004', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
      summary: 'One contrast problem.', rationale: 'Read src/Main.js and the axe results.', evidenceReferences: ['src/Main.js'],
      warnings: [], errors: [], ...fields
    } as CriterionAgentReviewConfig['fakeResult'] };
  }
  function write(relativePath: string, content: string): void {
    const absolutePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repoPath });
  }
  function commit(): void {
    git('add', '.');
    git('commit', '-qm', 'fixture');
  }
});
