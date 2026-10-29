import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  CriterionAgentAssessment,
  CriterionAgentReviewConfig,
  EvaluationStatus,
  F003Analysis
} from '../types';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { buildF003AgentReviewRequest, reviewF003WithAgent } from '../utils/f003-agent-review';
import { evaluateF003 } from '../utils/f003-internationalization';
import { readFrontendSource } from '../utils/frontend-source';
import { createEvaluationRun } from '../utils/evaluation-run';

describe('F003 agent review', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f003-agent-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    write('package.json', JSON.stringify({ name: '@folio/checkin', stripes: { actsAs: ['app'] }, peerDependencies: { 'react-intl': '^7.1.5' } }));
    write('translations/ui-checkin/en.json', JSON.stringify({ present: 'Present' }));
    write('translations/ui-checkin/de.json', JSON.stringify({ present: 'Vorhanden' }));
    write('src/Modal.js', [
      "import { FormattedMessage } from 'react-intl';",
      'export default () => (',
      '  <div aria-label="Check in modal">',
      '    <FormattedMessage id="ui-checkin.present" />',
      '    <FormattedMessage id="ui-checkin.statusModal.cancel" />',
      '  </div>',
      ');'
    ].join('\n'));
    write('src/Modal.test.js', 'it("renders", () => {});\n');
    write('guides/Usage.md', '# usage\n');
    commit();
  });
  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  // F003-C1#1 is the missing id in src/Modal.js, F003-C2#1 the hard-coded aria-label in the same file.
  const missingId = (fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
    technologyId: 'F003-C1#1', type: 'substantive_concern', summary: 'Users see the raw id; there is no defaultMessage.',
    evidenceReferences: ['src/Modal.js', 'translations/ui-checkin/en.json'], coverageDisposition: 'investigated', ...fields
  });
  const hardCoded = (fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
    technologyId: 'F003-C2#1', type: 'substantive_concern', summary: 'Screen readers announce untranslated English.',
    evidenceReferences: ['src/Modal.js'], coverageDisposition: 'investigated', ...fields
  });
  const action = { action: 'Add statusModal.cancel to en.json.', evidenceReferences: ['translations/ui-checkin/en.json'] };

  it('browses production source and the module\'s own en.json only, and gives the agent the numbered obligations', async () => {
    const analysis = await analyze();
    const prepared = (await prepareCriterionAgentReviewEvidence(buildF003AgentReviewRequest(repoPath, analysis))).request;
    const paths = prepared.files.map(file => file.repoRelativePath);

    expect(paths).toEqual(expect.arrayContaining(['src/Modal.js', 'package.json', 'translations/ui-checkin/en.json']));
    expect(paths.filter(file => ['src/Modal.test.js', 'translations/ui-checkin/de.json', 'guides/Usage.md'].includes(file))).toEqual([]);
    const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/F003/checklist.json')!.content);
    expect(checklist.items.flatMap((item: any) => item.obligations)).toEqual([
      { id: 'F003-C1#1', subject: 'ui-checkin.statusModal.cancel', path: 'src/Modal.js', line: 5 },
      { id: 'F003-C2#1', subject: 'aria-label "Check in modal"', path: 'src/Modal.js', line: 3 }
    ]);
    expect(prepared.instructions).toContain('You may browse only: source files under src/, lib/ and at the root (no tests, stories, examples, fixtures or mocks), CSS under src/ and lib/, package.json, translations/ui-checkin/en.json.');
    expect(prepared.files.some(file => file.repoRelativePath === '.criterion-agent/F003/response-shape.json')).toBe(true);
  });

  it('lets the agent read every candidate en.json when the namespace is unclear', async () => {
    write('translations/ui-legacy/en.json', JSON.stringify({ present: 'Present' }));
    write('package.json', JSON.stringify({ name: '@folio/renamed', peerDependencies: { 'react-intl': '^7.1.5' } }));
    commit();
    const analysis = await analyze();
    expect(analysis.namespaceBasis).toBe('ambiguous');
    const prepared = await prepareCriterionAgentReviewEvidence(buildF003AgentReviewRequest(repoPath, analysis));
    expect([...prepared.availableSourcePaths].filter(file => file.startsWith('translations/')).sort())
      .toEqual(['translations/ui-checkin/en.json', 'translations/ui-legacy/en.json']);
  });

  it('filters only its own view of the run\'s shared snapshot', async () => {
    const run = createEvaluationRun({ repositoryPath: repoPath, language: 'javascript',
      agentReview: fakeConfig({ assessments: [missingId(), hardCoded()], reviewerActions: [action] }) });
    await new FrontendEvaluator().evaluateCriterion('F003', repoPath, run);
    // A later review in the same run (S006, say) still browses tests and guides.
    expect(run.artifacts.agentReviewSnapshot?.files.map(file => file.path)).toEqual(expect.arrayContaining(['src/Modal.test.js', 'guides/Usage.md']));
  });

  it('attaches an accepted review to the checklist items and leaves the status unchanged', async () => {
    const result = await evaluateWith(fakeConfig({
      assessments: [missingId(), hardCoded({ type: 'aligned_fact', summary: 'Hidden helper text.' }),
        { technologyId: 'discovered:text:1', type: 'substantive_concern', summary: 'A tooltip is hard-coded too.',
          evidenceReferences: ['src/Modal.js'], coverageDisposition: 'investigated' }],
      reviewerActions: [action]
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.details).toContain([
      '  - F003-C1 Each listed id exists in en.json, or the code supplies English fallback text (defaultMessage or a label prop).',
      '    - Start with:',
      '      - src/Modal.js:5 — ui-checkin.statusModal.cancel',
      '    - Agent: Potential problem — ui-checkin.statusModal.cancel: Users see the raw id; there is no defaultMessage.'
    ].join('\n'));
    expect(result.details).toContain('    - Agent: Supported by evidence — aria-label "Check in modal": Hidden helper text.');
    // A discovered finding answers no checklist item, so it stays in the review's own section.
    expect(result.details).toContain('    - Hard-coded text found by the agent (1) — Potential problem:');
    expect(result.details).toContain('  - Agent review scope: source files under src/, lib/ and at the root (no tests, stories, examples, fixtures or mocks), CSS under src/ and lib/, package.json, translations/ui-checkin/en.json');
  });

  it('accepts likely_sufficient when every obligation was investigated and holds', async () => {
    const review = await review_(fakeConfig({
      recommendation: 'likely_sufficient',
      assessments: [missingId({ type: 'aligned_fact', summary: 'defaultMessage supplies the English text.' }),
        hardCoded({ type: 'analyzer_limitation', summary: 'The label is a test id, not shown.' })],
      reviewerActions: []
    }));
    expect(review.errors).toEqual([]);
    expect(review.available).toBe(true);
  });

  // Rows of the checklist with a fake review: each item's starting point, then its rows from the review.
  const C1 = ['  - F003-C1 Each listed id exists in en.json, or the code supplies English fallback text (defaultMessage or a label prop).',
    '    - Start with:', '      - src/Modal.js:5 — ui-checkin.statusModal.cancel'];
  const C2 = ['  - F003-C2 No user-visible text is hard-coded: each listed string is either not shown to users or comes from en.json.',
    '    - Start with:', '      - src/Modal.js:3 — aria-label "Check in modal"'];
  const missingIdRows = ['    - Agent: Potential problem — ui-checkin.statusModal.cancel: Users see the raw id; there is no defaultMessage.',
    '      - Sources:', '        - src/Modal.js', '        - translations/ui-checkin/en.json', '      - Coverage judgment: Investigated directly'];
  const hardCodedRows = ['    - Agent: Potential problem — aria-label "Check in modal": Screen readers announce untranslated English.',
    '      - Sources:', '        - src/Modal.js', '      - Coverage judgment: Investigated directly'];
  const droppedC1 = (reason: string) => [`    - Agent result dropped — ui-checkin.statusModal.cancel: ${reason}`];
  const droppedC2 = (reason: string) => [`    - Agent result dropped — aria-label "Check in modal": ${reason}`];
  const tail = (dropped: string[]) => dropped.length ? ['  - Dropped from this review:', ...dropped] : [];

  it.each([
    ['a repeated obligation', [missingId(), hardCoded(), hardCoded({ summary: 'Shown.' })], [],
      [...C1, ...missingIdRows, ...C2, ...droppedC2('The agent returned 2 results for it, so none is used.')], []],
    ['a repeated obligation whose other copy cites no file', [missingId(), hardCoded(), hardCoded({ evidenceReferences: ['src/Elsewhere.js'] })], [],
      [...C1, ...missingIdRows, ...C2, ...droppedC2('It cites no repository file.'), ...droppedC2('The agent returned 2 results for it, so none is used.')], []],
    ['an unknown ID', [missingId(), hardCoded(), hardCoded({ technologyId: 'F003-C9#1' })], [],
      [...C1, ...missingIdRows, ...C2, ...hardCodedRows], ['    - A result for F003-C9#1: It answers nothing the agent was asked to check.']],
    ['a discovered kind F003 does not accept', [missingId(), hardCoded(), hardCoded({ technologyId: 'discovered:interface:1' })], [],
      [...C1, ...missingIdRows, ...C2, ...hardCodedRows], ['    - A result for discovered:interface:1: It answers nothing the agent was asked to check.']],
    ['a missing coverage disposition', [missingId({ coverageDisposition: undefined }), hardCoded()], [],
      [...C1, ...droppedC1('It gives no coverage judgment.'), ...C2, ...hardCodedRows], []],
    ['an invalid coverage disposition', [missingId(), hardCoded({ coverageDisposition: 'skimmed' as any })], [],
      [...C1, ...missingIdRows, ...C2, ...droppedC2('Its coverage judgment is not one the evaluator accepts.')], []],
    ['an investigated subject that does not cite its file', [missingId({ evidenceReferences: ['translations/ui-checkin/en.json'] }), hardCoded()], [],
      [...C1, ...droppedC1('It is marked as investigated directly but does not cite the file it is about.'), ...C2, ...hardCodedRows], []],
    ['an unresolved aligned fact', [missingId(), hardCoded({ type: 'aligned_fact', coverageDisposition: 'unresolved' })], [],
      [...C1, ...missingIdRows, ...C2, ...droppedC2('It says the desired state holds but leaves it open.')], []],
    ['an investigated evidence gap', [missingId({ type: 'evidence_gap' }), hardCoded()], [],
      [...C1, ...droppedC1('It says the evidence is missing but is marked as investigated directly.'), ...C2, ...hardCodedRows], []],
    ['a discovered aligned fact', [missingId(), hardCoded(), hardCoded({ technologyId: 'discovered:text:1', type: 'aligned_fact' })], [],
      [...C1, ...missingIdRows, ...C2, ...hardCodedRows], ['    - A result for discovered:text:1: A finding beyond the checklist must be a potential problem or need verification.']],
    ['an assessment that cites only generated context', [missingId(), hardCoded({ evidenceReferences: ['.criterion-agent/F003/checklist.json'] })], [],
      [...C1, ...missingIdRows, ...C2, ...droppedC2('It cites only generated context, not a repository file.')], []],
    ['an assessment that cites no file at all', [missingId({ evidenceReferences: ['src/Elsewhere.js'] }), hardCoded()], [],
      [...C1, ...droppedC1('It cites no repository file.'), ...C2, ...hardCodedRows], []],
    ['an assessment without a summary', [missingId(), hardCoded({ summary: ' ' })], [],
      [...C1, ...missingIdRows, ...C2, ...droppedC2('It has no ID, no recognised result type or no summary.')], []],
    ['an uncited reviewer action', [missingId(), hardCoded()], [{ action: 'Check the modal.', evidenceReferences: ['.criterion-agent/F003/checklist.json'] }],
      [...C1, ...missingIdRows, ...C2, ...hardCodedRows], ['    - A reviewer action: It cites only generated context, not a repository file.']]
  ] as const)('drops %s on its own and keeps the rest of the review', async (_name, assessments, actions, checklistRows, droppedRows) => {
    const result = await evaluateWith(fakeConfig({ assessments, reviewerActions: [action, ...actions] }));

    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.recommendation).toBe('needs_reviewer_judgment');
    expect(result.agentReview?.reviewerActions).toEqual([action]);
    expect(checklistLines(result.details)).toEqual(['Checklist for the reviewer:', ...checklistRows]);
    expect(droppedLines(result.details)).toEqual(tail([...droppedRows]));
  });

  it('shows an obligation the agent did not answer as having no agent result', async () => {
    const result = await evaluateWith(fakeConfig({ assessments: [missingId()], reviewerActions: [action] }));
    expect(result.agentReview?.available).toBe(true);
    expect(checklistLines(result.details)).toEqual(['Checklist for the reviewer:', ...C1, ...missingIdRows, ...C2, '    - No agent result: aria-label "Check in modal"']);
  });

  it.each([
    ['likely_sufficient with a concern', 'likely_sufficient', [missingId({ type: 'aligned_fact' }), hardCoded()], [],
      'its results include an open question or a problem'],
    ['likely_sufficient with an unresolved limitation', 'likely_sufficient', [missingId({ type: 'aligned_fact' }), hardCoded({ type: 'analyzer_limitation', coverageDisposition: 'unresolved' })], [],
      'its results include an open question or a problem'],
    ['likely_sufficient with a discovered problem', 'likely_sufficient', [missingId({ type: 'aligned_fact' }), hardCoded({ type: 'aligned_fact' }),
      hardCoded({ technologyId: 'discovered:id:1', type: 'evidence_gap', coverageDisposition: 'unresolved' })], [], 'its results include an open question or a problem'],
    ['likely_sufficient with a dropped result', 'likely_sufficient', [missingId({ type: 'aligned_fact' }), hardCoded({ type: 'aligned_fact', coverageDisposition: undefined })], [],
      'some of its results were dropped'],
    ['likely_sufficient with an unanswered obligation', 'likely_sufficient', [missingId({ type: 'aligned_fact' })], [],
      'it returned no result for some checklist subjects'],
    ['likely_insufficient without a concern', 'likely_insufficient', [missingId({ type: 'aligned_fact' }), hardCoded({ type: 'aligned_fact' })], [action],
      'none of its kept results is a potential problem'],
    ['likely_insufficient whose only concern was dropped', 'likely_insufficient', [missingId({ type: 'aligned_fact' }), hardCoded({ coverageDisposition: undefined })], [action],
      'none of its kept results is a potential problem']
  ] as const)('replaces a recommendation the kept results do not support: %s', async (_name, recommendation, assessments, actions, reason) => {
    const result = await evaluateWith(fakeConfig({ recommendation, assessments, reviewerActions: actions }));
    const labels = { likely_sufficient: 'Likely sufficient', likely_insufficient: 'Likely insufficient' };

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.recommendation).toBe('needs_reviewer_judgment');
    expect(result.agentReview?.replacedRecommendation).toEqual({ recommendation, reason });
    expect(reviewLines(result.details).slice(0, 3)).toEqual(['Agent review (advisory):',
      `  - Recommendation: Reviewer judgment needed — the agent recommended "${labels[recommendation]}", but ${reason}.`, '  - Confidence: medium']);
  });

  it.each([
    ['likely_insufficient with a kept concern', 'likely_insufficient', [missingId(), hardCoded({ type: 'aligned_fact' })], [action]],
    ['needs_reviewer_judgment without an action', 'needs_reviewer_judgment', [missingId(), hardCoded()], []]
  ] as const)('keeps a recommendation the kept results support: %s', async (_name, recommendation, assessments, actions) => {
    const result = await evaluateWith(fakeConfig({ recommendation, assessments, reviewerActions: actions }));
    expect(result.agentReview?.recommendation).toBe(recommendation);
    expect(result.agentReview?.replacedRecommendation).toBeUndefined();
    expect(reviewLines(result.details)[1]).toBe(`  - Recommendation: ${{ likely_insufficient: 'Likely insufficient', needs_reviewer_judgment: 'Reviewer judgment needed' }[recommendation]}`);
  });

  it('keeps a subject outside the review snapshot unresolved', async () => {
    const analysis = await analyze();
    analysis.checklist.items[0].obligations[0].path = 'src/NotCommitted.js';
    const investigated = await reviewF003WithAgent(repoPath, analysis, fakeConfig({ assessments: [missingId(), hardCoded()], reviewerActions: [action] }));
    expect(investigated.available).toBe(true);
    expect(investigated.assessments).toEqual([hardCoded()]);
    expect(investigated.droppedItems).toEqual([{ kind: 'assessment', technologyId: 'F003-C1#1', reason: 'Its file was not available to the agent, so it must stay open.' }]);
    const unresolved = await reviewF003WithAgent(repoPath, analysis, fakeConfig({
      assessments: [missingId({ type: 'evidence_gap', coverageDisposition: 'unresolved' }), hardCoded()], reviewerActions: [action]
    }));
    expect(unresolved.available).toBe(true);
    expect(unresolved.droppedItems).toBeUndefined();
  });

  it.each([
    ['review citations', { evidenceReferences: ['.criterion-agent/F003/checklist.json'] }, 'Agent review requires repository evidence for the review and every assessment and action; generated context alone is not evidence.'],
    ['a recommendation', { recommendation: 'maybe' }, 'recommendation must be a supported advisory recommendation'],
    ['an assessments array', { assessments: { 'F003-C1#1': missingId() } }, 'Invalid or uncited assessments; the complete review was rejected.']
  ])('still rejects a review without %s, since there is no item to drop', async (_name, fields, error) => {
    const review = await review_(fakeConfig({ assessments: [missingId(), hardCoded()], reviewerActions: [action], ...fields }));
    expect(review.available).toBe(false);
    expect(review.errors).toContain(error);
  });

  it('gives at most 25 obligations, subjects before whole items, and then replaces likely_sufficient', async () => {
    write('translations/ui-checkin/en.json', JSON.stringify({ present: 'Present', broken: '{count, plural, one {# item}' }));
    write('src/Many.js', ["import { FormattedMessage } from 'react-intl';", 'export default ({ status }) => <>',
      ...Array.from({ length: 22 }, (_, index) => `  <FormattedMessage id="ui-checkin.missing${index}" />`),
      '  <FormattedMessage id={`ui-checkin.status.${status}`} />', '</>;'].join('\n'));
    commit();
    const analysis = await analyze();
    const obligations = analysis.checklist.items.flatMap(item => item.obligations);
    // 23 missing ids, the hard-coded text and the invalid text (C4) are subjects; computed ids (C3) are one whole-item
    // obligation, so it is the one withheld although C3 comes before C4 in the checklist.
    expect(obligations.filter(obligation => !obligation.withheld).map(obligation => obligation.id)).toEqual([
      ...Array.from({ length: 23 }, (_, index) => `F003-C1#${index + 1}`), 'F003-C2#1', 'F003-C4#1']);
    expect(obligations.filter(obligation => obligation.withheld)).toEqual([{ id: 'F003-C3#1', withheld: true }]);

    const allHold = obligations.filter(obligation => !obligation.withheld).map(obligation => ({
      technologyId: obligation.id, type: 'aligned_fact' as const, summary: 'Holds.', evidenceReferences: [obligation.path!], coverageDisposition: 'investigated' as const
    }));
    const review = await reviewF003WithAgent(repoPath, analysis, fakeConfig({ recommendation: 'likely_sufficient', assessments: allHold, reviewerActions: [] }));
    expect(review.recommendation).toBe('needs_reviewer_judgment');
    expect(review.replacedRecommendation).toEqual({ recommendation: 'likely_sufficient', reason: '1 checklist subject was not given to it' });
    const result = await new FrontendEvaluator().evaluateCriterion('F003', repoPath, createEvaluationRun({
      repositoryPath: repoPath, language: 'javascript', agentReview: fakeConfig({ assessments: allHold, reviewerActions: [action] })
    }));
    expect(result.agentReview?.available).toBe(true);
    expect(result.details).toContain('  - F003-C3 Computed message ids resolve to keys in en.json.\n    - Start with:\n'
      + '      - src/Many.js:25 — `ui-checkin.status.${status}`\n    - Not given to the agent (limit of 25)');
  });

  it('runs by default when agent review is enabled without a criteria list (Q6)', async () => {
    const config = fakeConfig({ assessments: [missingId(), hardCoded()], reviewerActions: [action] });
    delete config.enabledCriteria;
    const result = await evaluateWith(config);
    expect(result.agentReview?.available).toBe(true);
  });

  it('drops an invalid item on its own in a review returned by OpenCode too', async () => {
    const response = { recommendation: 'needs_reviewer_judgment', confidence: 'medium', summary: 'A message id is missing.', rationale: 'Read src/Modal.js.',
      evidenceReferences: ['src/Modal.js'], assessments: [missingId(), hardCoded({ evidenceReferences: ['src/Elsewhere.js'] })], reviewerActions: [action] };
    const review = await reviewF003WithAgent(repoPath, await analyze(), {
      enabled: true, adapter: 'opencode', modelLabel: 'test-model', readOnlyAgentName: 'reviewer',
      endpoint: 'https://api.example.test', endpointFamily: 'openai-compatible'
    }, new AnsweringRunner(JSON.stringify(response)));

    expect(review.errors).toEqual([]);
    expect(review.available).toBe(true);
    expect(review.assessments).toEqual([missingId()]);
    expect(review.droppedItems).toEqual([{ kind: 'assessment', technologyId: 'F003-C2#1', reason: 'It cites no repository file.' }]);
  });

  it.each([
    [undefined, 420_000],
    [90_000, 90_000]
  ])('times each OpenCode command out after the F00x default unless a timeout is given (%s)', async (timeoutMs, expected) => {
    const runner = new TimedOutRunner();
    const review = await reviewF003WithAgent(repoPath, await analyze(), {
      enabled: true, adapter: 'opencode', modelLabel: 'test-model', readOnlyAgentName: 'reviewer',
      endpoint: 'https://api.example.test', endpointFamily: 'openai-compatible', ...(timeoutMs ? { timeoutMs } : {})
    }, runner);
    expect(review.available).toBe(false);
    expect(runner.timeouts).toEqual([expected]);
  });

  class TimedOutRunner implements CommandRunner {
    timeouts: Array<number | undefined> = [];
    normalize(request: CommandExecutionRequest): string {
      return JSON.stringify(request);
    }
    async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
      this.timeouts.push(request.timeoutMs);
      return { identity: '', command: request.command, args: request.args ?? [], cwd: request.cwd, commandExecutionEnvironment: 'local',
        localCommandsAllowed: false, status: 'timed_out', durationMs: 1, stdout: '', stderr: '', sanitized: true };
    }
  }

  function checklistLines(details: string | undefined): string[] {
    const lines = (details ?? '').split('\n');
    return lines.slice(lines.indexOf('Checklist for the reviewer:'), lines.indexOf('Agent review (advisory):'));
  }
  function reviewLines(details: string | undefined): string[] {
    const lines = (details ?? '').split('\n');
    return lines.slice(lines.indexOf('Agent review (advisory):'));
  }
  function droppedLines(details: string | undefined): string[] {
    const lines = reviewLines(details);
    const start = lines.indexOf('  - Dropped from this review:');
    return start < 0 ? [] : lines.slice(start, lines.indexOf('  - Sources:'));
  }
  class AnsweringRunner implements CommandRunner {
    constructor(private readonly answer: string) {}
    normalize(request: CommandExecutionRequest): string {
      return JSON.stringify(request);
    }
    async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
      const command = (request.args ?? []).join(' ');
      const provenance = request.env?.OPENCODE_CONFIG_DIR ?? request.cwd;
      const stdout = command.includes('debug config') ? JSON.stringify({ plugin: [], mcp: {}, provenance })
        : command.includes('debug agent') ? JSON.stringify({ provenance, tools: { read: true, glob: true, grep: true, edit: false, write: false, bash: false,
          task: false, webfetch: false, websearch: false, skill: false, todowrite: false } })
          : this.answer;
      return { identity: '', command: request.command, args: request.args ?? [], cwd: request.cwd, commandExecutionEnvironment: 'local',
        localCommandsAllowed: false, status: 'success', exitCode: 0, signal: null, durationMs: 1, stdout, stderr: '', sanitized: true };
    }
  }

  async function analyze(): Promise<F003Analysis> {
    return evaluateF003(await readFrontendSource(repoPath));
  }
  async function review_(config: CriterionAgentReviewConfig) {
    return reviewF003WithAgent(repoPath, await analyze(), config);
  }
  async function evaluateWith(config: CriterionAgentReviewConfig) {
    return new FrontendEvaluator().evaluateCriterion('F003', repoPath, createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', agentReview: config }));
  }
  function fakeConfig(fields: Record<string, unknown>): CriterionAgentReviewConfig {
    return { enabled: true, enabledCriteria: ['F003'], adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
      available: true, criterionId: 'F003', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
      summary: 'A message id is missing.', rationale: 'Read src/Modal.js and en.json.', evidenceReferences: ['src/Modal.js'],
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
