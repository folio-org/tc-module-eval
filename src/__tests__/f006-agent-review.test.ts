import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus, F006Analysis } from '../types';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { buildF006AgentReviewRequest, reviewF006WithAgent } from '../utils/f006-agent-review';
import { evaluateF006, loadF006Guidelines, readF006Css } from '../utils/f006-ui-patterns';
import { readFrontendSource } from '../utils/frontend-source';
import { expectLinearTime } from './helpers/linear-time';

describe('F006 agent review', () => {
  let repoPath: string;
  const guidelines = loadF006Guidelines();

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f006-agent-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    write('package.json', JSON.stringify({ name: '@folio/example', stripes: { actsAs: ['app'], route: '/example' } }));
    write('translations/ui-example/en.json', JSON.stringify({ 'delete.confirm': 'Delete record' }));
    write('translations/ui-example/de.json', JSON.stringify({ 'delete.confirm': 'Datensatz löschen' }));
    write('src/Form.js', [
      "import stripesFinalForm from '@folio/stripes/final-form';",
      "import { Pane } from '@folio/stripes/components';",
      'const Base = () => <Pane paneTitle="Edit" />;',
      'export default stripesFinalForm({})(Base);'
    ].join('\n'));
    write('src/Form.test.js', 'it("renders", () => {});\n');
    write('guides/Usage.md', '# usage\n');
    commit();
  });
  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  const ITEM_OBLIGATIONS = ['F006-C1#1', 'F006-C2#1', 'F006-C3#1', 'F006-C4#1', 'F006-C5#1', 'F006-C6#1', 'F006-C8#1'];
  const holds = (id: string, fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
    technologyId: id, type: 'aligned_fact', summary: 'Follows the guideline.', evidenceReferences: ['src/Form.js'], coverageDisposition: 'investigated', ...fields
  });
  const formConcern = (fields: Partial<CriterionAgentAssessment> = {}) => holds('F006-C3#1', {
    type: 'substantive_concern', summary: 'Leaving the edit form drops changes without the prompt ConfirmationLanguageGuidelines.mdx asks for.', ...fields
  });
  const action = { action: 'Check whether the form is reachable from a route.', evidenceReferences: ['src/Form.js'] };

  it('browses production source, package.json and en.json, with the pinned guidelines and one obligation per item and per form', async () => {
    const prepared = (await prepareCriterionAgentReviewEvidence(buildF006AgentReviewRequest(repoPath, await analyze(), guidelines))).request;
    const paths = prepared.files.map(file => file.repoRelativePath);

    expect(paths).toEqual(expect.arrayContaining(['src/Form.js', 'package.json', 'translations/ui-example/en.json',
      '.criterion-agent/F006/ux-guidelines/feedback/ConfirmationModalPattern.mdx', '.criterion-agent/F006/ux-guidelines/layout/PaneGuidelines.mdx']));
    expect(paths.filter(file => ['src/Form.test.js', 'translations/ui-example/de.json', 'guides/Usage.md'].includes(file))).toEqual([]);
    expect(paths.filter(file => file.startsWith('.criterion-agent/F006/ux-guidelines/'))).toHaveLength(guidelines.files.length);
    const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/F006/checklist.json')!.content);
    // C7 and C9 are for the reviewer only.
    expect(checklist.items.map((item: { id: string }) => item.id)).toEqual(['F006-C1', 'F006-C2', 'F006-C3', 'F006-C4', 'F006-C5', 'F006-C6', 'F006-C8']);
    expect(checklist.items.flatMap((item: { obligations: unknown[] }) => item.obligations)).toEqual([
      { id: 'F006-C1#1' }, { id: 'F006-C2#1' },
      { id: 'F006-C3#1', subject: 'src/Form.js:4', path: 'src/Form.js', line: 4 },
      { id: 'F006-C4#1' }, { id: 'F006-C5#1' }, { id: 'F006-C6#1' }, { id: 'F006-C8#1' }
    ]);
    expect(prepared.instructions).toContain('You may browse only: source files under src/, lib/ and at the root (no tests, stories, examples, fixtures or mocks), '
      + 'CSS under src/ and lib/, package.json, translations/ui-example/en.json.');
  });

  it('attaches an accepted review to the checklist items, leaves C7 and C9 to the reviewer, and keeps the status', async () => {
    const result = await evaluateWith(fakeConfig({ assessments: ITEM_OBLIGATIONS.map(id => id === 'F006-C3#1' ? formConcern() : holds(id)), reviewerActions: [action] }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    const lines = (result.details ?? '').split('\n');
    const from = (heading: string, count: number) => lines.slice(lines.indexOf(heading), lines.indexOf(heading) + count).join('\n');
    expect(from('  - F006-C3 Every form asks before discarding unsaved changes.', 8)).toBe([
      '  - F006-C3 Every form asks before discarding unsaved changes.',
      '    - Start with:',
      '      - src/Form.js:4 — stripesFinalForm with navigationCheck not set',
      '    - Agent: Potential problem — src/Form.js:4: Leaving the edit form drops changes without the prompt ConfirmationLanguageGuidelines.mdx asks for.',
      '      - Sources:',
      '        - src/Form.js',
      '      - Coverage judgment: Investigated directly',
      '  - F006-C4 Destructive actions ask for confirmation with standard wording.'
    ].join('\n'));
    expect(from('  - F006-C7 State is kept when navigating between apps and back, or the user is told it will be lost.', 2)).toBe(
      '  - F006-C7 State is kept when navigating between apps and back, or the user is told it will be lost.\n    - Checked by the reviewer only');
    expect(from('  - F006-C9 Each documentation link shown in the UI is publicly accessible.', 2)).toBe(
      '  - F006-C9 Each documentation link shown in the UI is publicly accessible.\n    - Checked by the reviewer only');
  });

  it.each([
    ['names the guideline in its summary', formConcern(), true],
    ['cites the guideline file', formConcern({ summary: 'Unsaved changes are lost.',
      evidenceReferences: ['src/Form.js', '.criterion-agent/F006/ux-guidelines/actions/ConfirmationLanguageGuidelines.mdx'] }), true],
    ['names no guideline', formConcern({ summary: 'Unsaved changes are lost without a prompt.' }), false]
  ])('accepts a substantive_concern only when it names the guideline it is measured against: %s', async (_name, concern, accepted) => {
    const review = await reviewF006WithAgent(repoPath, await analyze(), guidelines, fakeConfig({
      assessments: ITEM_OBLIGATIONS.map(id => id === 'F006-C3#1' ? concern : holds(id)), reviewerActions: [action]
    }));
    expect(review.available).toBe(accepted);
    expect(review.errors).toEqual(accepted ? [] : ['F006 substantive_concern F006-C3#1 must name the guideline file it is measured against.']);
  });

  it.each([
    ['names the Stripes color variable to use', 'src/Form.css hard-codes #900 where var(--error) belongs.', []],
    ['names neither a guideline nor a variable', 'src/Form.css hard-codes #900.',
      ['F006 substantive_concern F006-C6#1 must name the guideline file it is measured against, or the Stripes color variable to use.']]
  ])('accepts a hard-coded color concern (F006-C6) that %s', async (_name, summary, errors) => {
    const review = await reviewF006WithAgent(repoPath, await analyze(), guidelines, fakeConfig({
      assessments: ITEM_OBLIGATIONS.map(id => id === 'F006-C6#1' ? holds(id, { type: 'substantive_concern', summary }) : holds(id)), reviewerActions: [action]
    }));
    expect(review.errors).toEqual(errors);
  });

  it('does not accept a Stripes color variable in place of a guideline outside F006-C6', async () => {
    const review = await reviewF006WithAgent(repoPath, await analyze(), guidelines, fakeConfig({
      assessments: ITEM_OBLIGATIONS.map(id => id === 'F006-C3#1' ? formConcern({ summary: 'The form uses var(--error) and drops unsaved changes.' }) : holds(id)),
      reviewerActions: [action]
    }));
    expect(review.errors).toEqual(['F006 substantive_concern F006-C3#1 must name the guideline file it is measured against.']);
  });

  it('rejects a review that assesses C7 or C9, which only the reviewer checks', async () => {
    const review = await reviewF006WithAgent(repoPath, await analyze(), guidelines, fakeConfig({
      assessments: [...ITEM_OBLIGATIONS.map(id => holds(id)), holds('F006-C9#1')], reviewerActions: [action]
    }));
    expect(review.errors).toEqual(['F006 requires exactly one assessment for every obligation in checklist.json, and no other IDs except none.']);
  });

  it('runs by default when agent review is enabled without a criteria list (Q6)', async () => {
    const config = fakeConfig({ assessments: ITEM_OBLIGATIONS.map(id => holds(id)), reviewerActions: [action] });
    delete config.enabledCriteria;
    const result = await evaluateWith(config);
    expect(result.agentReview?.available).toBe(true);
  });

  it('does not run, and says why, when the guideline snapshot could not be read', async () => {
    const review = await reviewF006WithAgent(repoPath, await analyze(), { problem: 'the UX guideline snapshot could not be read: ENOENT' },
      fakeConfig({ assessments: ITEM_OBLIGATIONS.map(id => holds(id)) }));
    expect(review.available).toBe(false);
    expect(review.errors).toEqual(['Unable to prepare F006 agent review material: the UX guideline snapshot could not be read: ENOENT']);
  });

  it('checks the guideline name in agent text in linear time', async () => {
    const analysis = await analyze();
    const request = buildF006AgentReviewRequest(repoPath, analysis, guidelines);
    await expectLinearTime(50_000, size => ({
      available: true, criterionId: 'F006', evidenceReferences: ['src/Form.js'], warnings: [], errors: [], recommendation: 'needs_reviewer_judgment' as const,
      reviewerActions: [action], assessments: ITEM_OBLIGATIONS.map(id => id === 'F006-C6#1'
        ? holds(id, { type: 'substantive_concern', summary: `${'PaneGuidelin'.repeat(size)}${'--'.repeat(size)}` }) : holds(id))
    }), async review => request.validateReview!(review, new Set(['src/Form.js'])));
  });

  async function analyze(): Promise<F006Analysis> {
    return evaluateF006({ source: await readFrontendSource(repoPath), css: await readF006Css(repoPath), guidelines });
  }
  async function evaluateWith(config: CriterionAgentReviewConfig) {
    return new FrontendEvaluator().evaluateCriterion('F006', repoPath, createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', agentReview: config }));
  }
  function fakeConfig(fields: Record<string, unknown>): CriterionAgentReviewConfig {
    return { enabled: true, enabledCriteria: ['F006'], adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
      available: true, criterionId: 'F006', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
      summary: 'One form drops unsaved changes.', rationale: 'Read src/Form.js against the guidelines.', evidenceReferences: ['src/Form.js'],
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
