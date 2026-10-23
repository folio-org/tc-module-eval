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

  it.each([
    ['a missing obligation', { assessments: [missingId()] }, 'F003 requires exactly one assessment for every obligation in checklist.json, and no other IDs except discovered:text:<n> or discovered:id:<n>.'],
    ['a repeated obligation', { assessments: [missingId(), hardCoded(), hardCoded()] }, 'F003 requires exactly one assessment for every obligation in checklist.json, and no other IDs except discovered:text:<n> or discovered:id:<n>.'],
    ['an unknown ID', { assessments: [missingId(), hardCoded(), hardCoded({ technologyId: 'F003-C9#1' })] }, 'F003 requires exactly one assessment for every obligation in checklist.json, and no other IDs except discovered:text:<n> or discovered:id:<n>.'],
    ['a discovered kind F003 does not accept', { assessments: [missingId(), hardCoded(), hardCoded({ technologyId: 'discovered:interface:1' })] }, 'F003 requires exactly one assessment for every obligation in checklist.json, and no other IDs except discovered:text:<n> or discovered:id:<n>.'],
    ['a missing coverage disposition', { assessments: [missingId({ coverageDisposition: undefined }), hardCoded()] }, 'F003 requires a coverageDisposition on every assessment.'],
    ['an investigated subject that does not cite its file', { assessments: [missingId({ evidenceReferences: ['translations/ui-checkin/en.json'] }), hardCoded()] }, 'F003 obligation F003-C1#1 is marked investigated but does not cite its own file.'],
    ['an unresolved aligned fact', { assessments: [missingId({ type: 'aligned_fact', coverageDisposition: 'unresolved' }), hardCoded()] }, 'F003 does not accept an unresolved aligned_fact or an investigated evidence_gap.'],
    ['an investigated evidence gap', { assessments: [missingId({ type: 'evidence_gap' }), hardCoded()] }, 'F003 does not accept an unresolved aligned_fact or an investigated evidence_gap.'],
    ['a discovered aligned fact', { assessments: [missingId(), hardCoded(), hardCoded({ technologyId: 'discovered:text:1', type: 'aligned_fact' })] }, 'F003 discovered assessments must be substantive_concern or evidence_gap.'],
    ['an assessment of an obligation not given to the agent', { assessments: [missingId(), hardCoded(), hardCoded({ technologyId: 'F003-C3#1' })] }, 'F003 requires exactly one assessment for every obligation in checklist.json, and no other IDs except discovered:text:<n> or discovered:id:<n>.'],
    ['likely_sufficient with a concern', { recommendation: 'likely_sufficient', assessments: [missingId({ type: 'aligned_fact' }), hardCoded()] }, 'F003 likely_sufficient conflicts with an open assessment, a discovered problem or obligations not given to the agent.'],
    ['likely_sufficient with an unresolved limitation', { recommendation: 'likely_sufficient', assessments: [missingId({ type: 'aligned_fact' }), hardCoded({ type: 'analyzer_limitation', coverageDisposition: 'unresolved' })] }, 'F003 likely_sufficient conflicts with an open assessment, a discovered problem or obligations not given to the agent.'],
    ['likely_sufficient with a discovered problem', { recommendation: 'likely_sufficient', assessments: [missingId({ type: 'aligned_fact' }), hardCoded({ type: 'aligned_fact' }), hardCoded({ technologyId: 'discovered:id:1', type: 'evidence_gap', coverageDisposition: 'unresolved' })] }, 'F003 likely_sufficient conflicts with an open assessment, a discovered problem or obligations not given to the agent.'],
    ['likely_insufficient without a concern', { recommendation: 'likely_insufficient', assessments: [missingId({ type: 'aligned_fact' }), hardCoded({ type: 'aligned_fact' })] }, 'F003 likely_insufficient requires a cited substantive_concern.'],
    ['needs_reviewer_judgment without an action', { assessments: [missingId(), hardCoded()], reviewerActions: [] }, 'F003 needs_reviewer_judgment requires a cited reviewer action.']
  ] as const)('rejects %s', async (_name, variant: any, message) => {
    const review = await review_(fakeConfig({ reviewerActions: [action], ...variant }));
    expect(review.available).toBe(false);
    expect(review.errors).toContain(message);
  });

  it('keeps a subject outside the review snapshot unresolved', async () => {
    const analysis = await analyze();
    analysis.checklist.items[0].obligations[0].path = 'src/NotCommitted.js';
    const investigated = await reviewF003WithAgent(repoPath, analysis, fakeConfig({ assessments: [missingId(), hardCoded()], reviewerActions: [action] }));
    expect(investigated.errors).toContain('F003 obligation F003-C1#1 is about a file outside the review snapshot, so it must stay unresolved.');
    const unresolved = await reviewF003WithAgent(repoPath, analysis, fakeConfig({
      assessments: [missingId({ type: 'evidence_gap', coverageDisposition: 'unresolved' }), hardCoded()], reviewerActions: [action]
    }));
    expect(unresolved.available).toBe(true);
  });

  it('rejects an assessment that cites only generated context', async () => {
    const review = await review_(fakeConfig({
      assessments: [missingId({ evidenceReferences: ['.criterion-agent/F003/checklist.json'], coverageDisposition: 'unresolved', type: 'evidence_gap' }), hardCoded()],
      reviewerActions: [action]
    }));
    expect(review.available).toBe(false);
    expect(review.errors.join(' ')).toContain('requires repository evidence');
  });

  it('gives at most 25 obligations, subjects before whole items, and then forbids likely_sufficient', async () => {
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
    expect(review.errors).toContain('F003 likely_sufficient conflicts with an open assessment, a discovered problem or obligations not given to the agent.');
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
