import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus, F007Analysis, UiRuntimeEvidence, UiRuntimeProbe } from '../types';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { buildF007AgentReviewRequest } from '../utils/f007-agent-review';
import { evaluateF007, loadF007BrowserApis, readF007Browserslist, renderF007HumanDetails } from '../utils/f007-latest-chrome';
import { readFrontendSource } from '../utils/frontend-source';
import { expectLinearTime } from './helpers/linear-time';
import { FakeProbe, RUNTIME } from './helpers/ui-runtime';

describe('F007 agent review', () => {
  let repoPath: string;
  const CONSOLE = '.criterion-agent/F007/console.json';
  const NOT_IMPLEMENTED = 'Failed to load resource: the server responded with a status of 501 ()';
  const TYPE_ERROR = "Uncaught TypeError: Cannot read properties of undefined (reading 'map')";
  const ABOUT_ERROR = 'Warning: Each child in a list should have a unique "key" prop.';
  const CONSOLE_RUNTIME: UiRuntimeEvidence = {
    ...RUNTIME,
    pages: [
      { ...RUNTIME.pages[0], consoleErrors: [NOT_IMPLEMENTED, TYPE_ERROR, NOT_IMPLEMENTED] },
      { ...RUNTIME.pages[1], consoleErrors: [NOT_IMPLEMENTED.replace(/ /g, '\n  ')] },
      { ...RUNTIME.pages[2], consoleErrors: [ABOUT_ERROR] }
    ]
  };

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f007-agent-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    write('package.json', JSON.stringify({ name: '@folio/example', version: '2.1.0', stripes: { actsAs: ['app', 'settings'], route: '/example' } }, null, 2));
    write('.browserslistrc', 'last 2 Chrome versions\n');
    write('src/Main.js', [
      'export default ({ blob }) => {',
      '  const ua = navigator.userAgent;',
      '  navigator.msSaveBlob(blob);',
      '  return <p>{ua}</p>;',
      '};'
    ].join('\n'));
    write('src/Main.test.js', 'it("renders", () => {});\n');
    commit();
  });
  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  const holds = (id: string, fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
    technologyId: id, type: 'aligned_fact', summary: 'Holds.', evidenceReferences: ['src/Main.js'], coverageDisposition: 'investigated', ...fields
  });
  const action = { action: 'Check whether the deployed backend provides /_/env.', evidenceReferences: ['src/Main.js'] };

  it('gives the agent one obligation per distinct console error and per flagged use, the console evidence, and the source and browserslist to browse', async () => {
    const prepared = (await prepareCriterionAgentReviewEvidence(buildF007AgentReviewRequest(repoPath, await analyze(CONSOLE_RUNTIME)))).request;
    const paths = prepared.files.map(file => file.repoRelativePath);

    expect(paths).toEqual(expect.arrayContaining(['src/Main.js', 'package.json', '.browserslistrc', CONSOLE]));
    expect(paths).not.toContain('src/Main.test.js');
    const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/F007/checklist.json')!.content);
    expect(checklist.items.flatMap((item: { obligations: unknown[] }) => item.obligations)).toEqual([
      { id: 'F007-C1#1', subject: `/example, /settings/example: ${NOT_IMPLEMENTED}` },
      { id: 'F007-C1#2', subject: `/example: ${TYPE_ERROR}` },
      { id: 'F007-C1#3', subject: `/settings/about: ${ABOUT_ERROR}` },
      { id: 'F007-C2#1', subject: 'src/Main.js:2 navigator.userAgent', path: 'src/Main.js', line: 2 },
      { id: 'F007-C2#2', subject: 'src/Main.js:3 msSaveBlob', path: 'src/Main.js', line: 3 },
      { id: 'F007-C2#3', subject: '.browserslistrc browserslist', path: '.browserslistrc' }
    ]);
    const consoleEvidence = JSON.parse(prepared.files.find(file => file.repoRelativePath === CONSOLE)!.content);
    expect(consoleEvidence.browserVersion).toBe('156.0.8078.47');
    expect(consoleEvidence.deployedModule).toEqual({ id: 'folio_example', version: '2.1.1099000000000453' });
    expect(consoleEvidence.evaluatedPackageVersion).toBe('2.1.0');
    expect(consoleEvidence.pages.map((page: { path: string; consoleErrors: { items: string[] }; failedRequests: { items: Array<{ status: number }> } }) =>
      [page.path, page.consoleErrors.items.length, page.failedRequests.items.map(request => request.status)])).toEqual([
      ['/example', 3, [501]], ['/settings/example', 1, []], ['/settings/about', 1, []]]);
  });

  it('shows the runtime evidence and the agent results per item, and keeps only non-concerns that cite just the console evidence', async () => {
    const probe = new FakeProbe(CONSOLE_RUNTIME);
    const result = await evaluateWith(probe, fakeConfig({
      recommendation: 'likely_insufficient',
      assessments: [
        holds('F007-C1#1', { summary: 'The deployment answers /_/env with 501; the module does not request it.', evidenceReferences: [CONSOLE] }),
        holds('F007-C1#2', { type: 'substantive_concern', summary: 'A list renders before its data arrives.', evidenceReferences: [CONSOLE] }),
        holds('F007-C1#3', { type: 'evidence_gap', summary: 'No list in this module renders on the about page.', evidenceReferences: [CONSOLE], coverageDisposition: 'unresolved' }),
        holds('F007-C2#1', { summary: 'The user agent is only shown, not branched on.', evidenceReferences: [CONSOLE], coverageDisposition: 'immaterial' }),
        holds('F007-C2#2', { type: 'substantive_concern', summary: 'Chrome has no msSaveBlob, so the download fails.', evidenceReferences: ['package.json'] }),
        holds('F007-C2#3', { summary: 'The override targets Chrome.', evidenceReferences: ['.browserslistrc'] })
      ],
      reviewerActions: [action]
    }));

    expect(probe.calls).toHaveLength(1);
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('F007 manual: Whether the module works in the latest Chrome must be checked in the browser. The tool found '
      + '1 read of navigator properties that identify the browser; 1 vendor-prefixed API use; 0 uses of APIs Chrome removed; 1 browserslist override; 0 polyfills. '
      + 'On the running UI (https://folio-etesting-snapshot-diku.ci.folio.org), Chrome 156.0.8078.47 loaded /example and /settings/example: '
      + '4 console errors, 1 failed request.');
    const lines = (result.details ?? '').split('\n');
    const runtimeStart = lines.indexOf('Runtime evidence (informational):');
    expect(lines.slice(runtimeStart - 1, lines.indexOf('What to do:'))).toEqual([
      '  - Agent review scope: source files under src/, lib/ and at the root (no tests, stories, examples, fixtures or mocks), CSS under src/ and lib/, package.json, .browserslistrc',
      'Runtime evidence (informational):',
      '  - UI https://folio-etesting-snapshot-diku.ci.folio.org, login https://folio-etesting-snapshot-keycloak.ci.folio.org, API https://folio-etesting-snapshot-kong.ci.folio.org; '
        + 'Chrome 156.0.8078.47; took 14 s',
      '  - Deployed module: folio_example 2.1.1099000000000453 on /settings/about; package.json of this commit: 2.1.0',
      '  - /example (ended on https://folio-etesting-snapshot-diku.ci.folio.org/example?sort=name): 3 console errors, 1 failed request',
      '  - /settings/example: 1 console error, 0 failed requests',
      '  - /settings/about: 1 console error, 0 failed requests; read for the deployed version',
      `  - Console errors: 5 on 3 pages; first: "${NOT_IMPLEMENTED}"; "${TYPE_ERROR}"; "${NOT_IMPLEMENTED}"`,
      '  - Failed requests: 1; first: HTTP 501 GET https://folio-etesting-snapshot-kong.ci.folio.org/_/env',
      '  - Blocked requests: 1; first: GET https://eureka-customer-assets.s3.us-west-2.amazonaws.com/diku/logo.png (another origin)'
    ]);
    expect(lines.slice(lines.indexOf('Checklist for the reviewer:'))).toEqual([
      'Checklist for the reviewer:',
      '  - F007-C1 The module\'s main screens load in the latest Chrome without console errors caused by the module.',
      '    - Start with:',
      '      - package.json:9 — route /example',
      '      - package.json:5 — settings /settings/example',
      '      - /example — on the running UI: 3 console errors, 1 failed request',
      '      - /settings/example — on the running UI: 1 console error, 0 failed requests',
      '      - /settings/about — on the running UI: 1 console error, 0 failed requests',
      `    - Agent: Supported by evidence — /example, /settings/example: ${NOT_IMPLEMENTED}: The deployment answers /_/env with 501; the module does not request it.`,
      '      - Sources:',
      `        - ${CONSOLE}`,
      '      - Coverage judgment: Investigated directly',
      `    - Agent result dropped — /example: ${TYPE_ERROR}: It cites only generated context, not a repository file.`,
      `    - Agent: Needs verification — /settings/about: ${ABOUT_ERROR}: No list in this module renders on the about page.`,
      '      - Sources:',
      `        - ${CONSOLE}`,
      '      - Coverage judgment: Needs further verification',
      '  - F007-C2 No code path depends on another browser or a removed Chrome API.',
      '    - Start with:',
      '      - src/Main.js:2 — navigator.userAgent identifies the browser',
      '      - src/Main.js:3 — msSaveBlob; ms prefix: Internet Explorer and Edge before Chromium',
      '      - .browserslistrc — browserslist last 2 Chrome versions',
      '    - Agent result dropped — src/Main.js:2 navigator.userAgent: It cites only generated context, not a repository file.',
      '    - Agent result dropped — src/Main.js:3 msSaveBlob: It is marked as investigated directly but does not cite the file it is about.',
      '    - Agent: Supported by evidence — .browserslistrc browserslist: The override targets Chrome.',
      '      - Sources:',
      '        - .browserslistrc',
      '      - Coverage judgment: Investigated directly',
      'Agent review (advisory):',
      '  - Recommendation: Reviewer judgment needed — the agent recommended "Likely insufficient", but none of its kept results is a potential problem.',
      '  - Confidence: medium',
      '  - Summary: One console error needs a look.',
      '  - Rationale: Read src/Main.js and the console errors.',
      '  - What to verify:',
      '    - Check whether the deployed backend provides /_/env.',
      '      - Sources:',
      '        - src/Main.js',
      '  - Sources:',
      '    - src/Main.js',
      '  - Advisory only; the criterion status is unchanged.'
    ]);
  });

  it.each([
    ['listed in --criterion-agent-criteria', ['F007']],
    ['with no criteria list', undefined]
  ])('does not run without runtime evidence, %s, and says why', async (_name, enabledCriteria) => {
    const config = fakeConfig({ assessments: [holds('F007-C1#1')], reviewerActions: [action] });
    if (enabledCriteria) config.enabledCriteria = enabledCriteria;
    else delete config.enabledCriteria;

    const result = await evaluateWith(undefined, config);

    expect(result.agentReview).toBeUndefined();
    expect((result.details ?? '').split('\n').slice(-2)).toEqual(['Agent review:',
      '  - Not applied: F007 agent review needs runtime evidence from a running FOLIO UI (--ui-runtime-url and --ui-runtime-login-origin), and none was given']);
  });

  it('does not run when the probe loaded only the about page, and lists the page that did not load', async () => {
    const aboutOnly: UiRuntimeEvidence = { ...CONSOLE_RUNTIME,
      pages: [{ ...CONSOLE_RUNTIME.pages[0], axe: undefined, problem: 'the page did not finish within 30 s' }, CONSOLE_RUNTIME.pages[2]] };
    const result = await evaluateWith(new FakeProbe(aboutOnly), fakeConfig({ assessments: [], reviewerActions: [action] }));

    expect(result.agentReview).toBeUndefined();
    expect(result.evidence).toBe('F007 manual: Whether the module works in the latest Chrome must be checked in the browser. The tool found '
      + '1 read of navigator properties that identify the browser; 1 vendor-prefixed API use; 0 uses of APIs Chrome removed; 1 browserslist override; 0 polyfills.');
    const lines = (result.details ?? '').split('\n');
    expect(lines).toContain('  - /example (ended on https://folio-etesting-snapshot-diku.ci.folio.org/example?sort=name): the page did not finish within 30 s');
    expect(lines.slice(lines.indexOf('Checklist for the reviewer:') + 2, lines.indexOf('Checklist for the reviewer:') + 7)).toEqual([
      '    - Start with:',
      '      - package.json:9 — route /example',
      '      - package.json:5 — settings /settings/example',
      '      - /example — not loaded on the running UI: the page did not finish within 30 s',
      '      - /settings/about — on the running UI: 1 console error, 0 failed requests'
    ]);
    expect(lines.slice(-1)).toEqual(['  - Not applied: F007 agent review needs runtime evidence, and the probe of the running UI collected none (see "Runtime evidence")']);
  });

  it('sums up only the module pages that loaded', async () => {
    const runtime: UiRuntimeEvidence = { ...CONSOLE_RUNTIME, pages: [
      { ...CONSOLE_RUNTIME.pages[1], consoleErrors: [], failedRequests: [] },
      { ...CONSOLE_RUNTIME.pages[0], axe: undefined, problem: 'the page did not finish within 30 s' },
      CONSOLE_RUNTIME.pages[2]
    ] };

    expect((await analyze(runtime)).summary).toBe('F007 manual: Whether the module works in the latest Chrome must be checked in the browser. The tool found '
      + '1 read of navigator properties that identify the browser; 1 vendor-prefixed API use; 0 uses of APIs Chrome removed; 1 browserslist override; 0 polyfills. '
      + 'On the running UI (https://folio-etesting-snapshot-diku.ci.folio.org), Chrome 156.0.8078.47 loaded /settings/example: no console errors, no failed requests.');
  });

  it('keeps console errors apart that differ after 160 characters, and leaves the flagged code its share of the limit of 25', async () => {
    const long = `Warning: Failed prop type: ${'x'.repeat(160)}`;
    const errors = [`${long} in A`, `${long} in B`, ` ${TYPE_ERROR}\n`, TYPE_ERROR, ...Array.from({ length: 30 }, (_unused, index) => `Uncaught Error ${index}`)];
    const runtime: UiRuntimeEvidence = { ...CONSOLE_RUNTIME, pages: [{ ...CONSOLE_RUNTIME.pages[0], consoleErrors: errors }, CONSOLE_RUNTIME.pages[1]] };
    const [consoleItem, codeItem] = (await analyze(runtime)).checklist.items;

    expect(consoleItem.obligations.slice(0, 3).map(obligation => obligation.subject)).toEqual([
      `/example: ${long} in A`, `/example: ${long} in B`, `/example: ${TYPE_ERROR}`]);
    expect([consoleItem.obligations.length, consoleItem.obligations.filter(obligation => !obligation.withheld).length]).toEqual([34, 22]);
    expect(codeItem.obligations.map(obligation => [obligation.id, obligation.withheld])).toEqual([['F007-C2#1', undefined], ['F007-C2#2', undefined], ['F007-C2#3', undefined]]);

    const flagged = Array.from({ length: 20 }, () => '  navigator.msSaveBlob(blob);').join('\n');
    write('src/Save.js', `export const save = blob => {\n${flagged}\n};\n`);
    commit();
    const [crowdedConsole, crowdedCode] = (await analyze(runtime)).checklist.items;
    expect([crowdedConsole, crowdedCode].map(item => item.obligations.filter(obligation => !obligation.withheld).length)).toEqual([13, 12]);
  });

  it('runs the probe once when F004 and F007 are both evaluated', async () => {
    const probe = new FakeProbe(CONSOLE_RUNTIME);
    const run = createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', uiRuntime: probe });
    const evaluator = new FrontendEvaluator();

    const [f004, f007] = await Promise.all([evaluator.evaluateCriterion('F004', repoPath, run), evaluator.evaluateCriterion('F007', repoPath, run)]);

    expect(probe.calls).toHaveLength(1);
    expect((f004.criterionDetails as { runtime: UiRuntimeEvidence }).runtime).toBe((f007.criterionDetails as F007Analysis).runtime);
  });

  it('cuts the console evidence to 48 KB, keeping every page and counting what it left out', async () => {
    const messages = Array.from({ length: 50 }, (_unused, index) => `Uncaught Error ${index}: ${'x'.repeat(480)}`);
    const runtime: UiRuntimeEvidence = { ...CONSOLE_RUNTIME, pages: CONSOLE_RUNTIME.pages.map(page => ({ ...page, consoleErrors: messages, consoleErrorsCut: 7 })) };
    const analysis = await analyze(runtime);
    const text = buildF007AgentReviewRequest(repoPath, analysis).files.find(file => file.repoRelativePath === CONSOLE)!.content;
    const evidence = JSON.parse(text);
    const lines = renderF007HumanDetails(analysis).split('\n');

    expect(lines.slice(lines.indexOf('Runtime evidence (informational):') + 3, lines.indexOf('Runtime evidence (informational):') + 7)).toEqual([
      '  - /example (ended on https://folio-etesting-snapshot-diku.ci.folio.org/example?sort=name): 57 console errors, 1 failed request',
      '  - /settings/example: 57 console errors, 0 failed requests',
      '  - /settings/about: 57 console errors, 0 failed requests; read for the deployed version',
      `  - Console errors: 171 on 3 pages; first: "${messages[0].slice(0, 160)}"; "${messages[1].slice(0, 160)}"; "${messages[2].slice(0, 160)}"`
    ]);

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(48 * 1024);
    expect(evidence.pages.map((page: { path: string }) => page.path)).toEqual(['/example', '/settings/example', '/settings/about']);
    for (const page of evidence.pages) expect(page.consoleErrors.items.length + page.consoleErrors.notShown).toBe(57);
  });

  it('groups console errors in linear time', async () => {
    const source = await readFrontendSource(repoPath);
    const browserslistFiles = await readF007Browserslist(repoPath);
    const apiList = loadF007BrowserApis();
    await expectLinearTime(20_000, size => ({
      ...CONSOLE_RUNTIME,
      pages: CONSOLE_RUNTIME.pages.map((page, pageIndex) => ({ ...page, consoleErrors: [`Error ${pageIndex}${' \n'.repeat(size / 5)}x`,
        ...Array.from({ length: size / 10 }, (_unused, index) => `Warning: ${' '.repeat(index % 2)}${'a b\n'.repeat(70)}`)] }))
    }), runtime => Promise.resolve(evaluateF007({ source, browserslistFiles, apiList, runtime })));
  });

  async function analyze(runtime: UiRuntimeEvidence): Promise<F007Analysis> {
    return evaluateF007({ source: await readFrontendSource(repoPath), browserslistFiles: await readF007Browserslist(repoPath), apiList: loadF007BrowserApis(), runtime });
  }
  async function evaluateWith(probe: UiRuntimeProbe | undefined, config: CriterionAgentReviewConfig) {
    return new FrontendEvaluator().evaluateCriterion('F007', repoPath, createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', agentReview: config, uiRuntime: probe }));
  }
  function fakeConfig(fields: Record<string, unknown>): CriterionAgentReviewConfig {
    return { enabled: true, enabledCriteria: ['F007'], adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
      available: true, criterionId: 'F007', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
      summary: 'One console error needs a look.', rationale: 'Read src/Main.js and the console errors.', evidenceReferences: ['src/Main.js'],
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
