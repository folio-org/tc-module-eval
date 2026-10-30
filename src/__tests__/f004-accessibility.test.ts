import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as ts from 'typescript';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionResult, EvaluationStatus, F004Analysis, UiRuntimeProbe } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { evaluateF004 } from '../utils/f004-accessibility';
import { FrontendSource } from '../utils/frontend-source';
import { NO_RUNTIME_EVIDENCE, PlaywrightUiRuntimeProbe } from '../utils/ui-runtime-probe';
import { expectLinearTime } from './helpers/linear-time';
import { FakeProbe, RUNTIME } from './helpers/ui-runtime';

describe('F004 WCAG 2.1 AA accessibility', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f004-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
  });
  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  function writeApp(): void {
    writePackage();
    write('.eslintrc', JSON.stringify({ extends: '@folio/eslint-config-stripes', rules: { 'jsx-a11y/no-autofocus': 'off', 'jsx-a11y/anchor-is-valid': 'error' } }, null, 2));
    write('src/Main.js', [
      "import { Button } from '@folio/stripes/components';",
      'export default ({ props, open }) => (',
      '  <main>',
      '    <img src="logo.png" />',
      '    <img alt="" src="spacer.png" />',
      '    <img {...props} />',
      '    {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}',
      '    <div onClick={open}>Open</div>',
      '    <span onClick={open} onKeyDown={open}>Open</span>',
      '    <div role="button" onClick={open} tabIndex={0}>Open</div>',
      '    <button type="button" onClick={open}>Open</button>',
      '    <Button onClick={open}>Open</Button>',
      '    <input aria-label="Search all records" />',
      '    <li onClick={open}>Item</li> {/* eslint-disable-line jsx-a11y/no-noninteractive-element-interactions */}',
      '    {/* eslint-disable-next-line no-console */}',
      '    {/* eslint-disable-next-line react/prop-types',
      '        jsx-a11y/no-autofocus */}',
      '  </main>',
      ');'
    ].join('\n'));
    write('src/Main.test.js', "import { runAxeTest } from '@folio/stripes-testing';\nit('has no axe errors', () => runAxeTest({ rootNode: document.body }));\n");
    write('lib/Pane/tests/Pane-test.js', "const { axe } = require('jest-axe');\n");
    write('src/Other.test.js', "it('adds taxes to maxed-out fines', () => {});\n");
    write('src/stories/Main.stories.js', "import { runAxeTest } from '@folio/stripes-testing';\n");
    write('docs/axe.md', 'runAxeTest\n');
  }

  it('lists the static accessibility signals and says runtime evidence was not collected', async () => {
    writeApp();
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.axeTests).toEqual({ files: ['lib/Pane/tests/Pane-test.js', 'src/Main.test.js'], testFileCount: 3 });
    expect(analysis.disabledRules).toEqual([
      { path: 'src/Main.js', line: 7, rule: 'click-events-have-key-events' },
      { path: 'src/Main.js', line: 7, rule: 'no-static-element-interactions' },
      { path: 'src/Main.js', line: 14, rule: 'no-noninteractive-element-interactions' },
      { path: '.eslintrc', line: 4, rule: 'no-autofocus' }
    ]);
    expect(analysis.imagesWithoutAlt).toEqual([{ path: 'src/Main.js', line: 4 }]);
    expect(analysis.clickHandlers).toEqual([
      { path: 'src/Main.js', line: 8, element: 'div', keyboardHandler: false },
      { path: 'src/Main.js', line: 9, element: 'span', keyboardHandler: true },
      { path: 'src/Main.js', line: 14, element: 'li', keyboardHandler: false }
    ]);
    expect(result.evidence).toBe('F004 manual: Accessibility must be measured with axe DevTools on the running module; the repository alone cannot show WCAG 2.1 AA conformance. '
      + 'The tool found 2 test files using axe; 4 disabled jsx-a11y rules; 1 image without alt text; 3 click handlers on non-interactive elements; 1 hard-coded aria-label.');
    expect(result.details).toBe([
      'What the tool found:',
      '  - Accessibility tests: 2 of 3 test files use axe (runAxeTest, jest-axe or axe-core)',
      '  - Lint: .eslintrc uses @folio/eslint-config-stripes (^9.0.0)',
      '  - Disabled jsx-a11y rules: 4 (click-events-have-key-events 1, no-static-element-interactions 1, no-noninteractive-element-interactions 1, no-autofocus 1)',
      '  - Images without alt: 1 <img> element',
      '  - Click handlers without a role: 3',
      '  - Hard-coded aria-label text: 1 (also listed by F003)',
      '  - Production source: 1 file in src/, lib/ and the repository root (tests, stories and examples excluded); 1 file renders HTML elements or text',
      '  - Accessibility guides: stripes-components guides/accessibility at ae9e5d7 (2026-10-28), 3 files',
      'Runtime evidence:',
      '  - Not collected; --ui-runtime-url and --ui-runtime-login-origin measure a running FOLIO UI with axe-core',
      'What to do:',
      '  - Run axe DevTools (current major version) on the module\'s main screens in a test or reference environment and check each item below; F004 is always decided by a reviewer.',
      'Checklist for the reviewer:',
      '  - F004-C1 axe DevTools (current major version) finds no WCAG 2.1 AA violations caused by the module on its main screens.',
      '    - Start with:',
      '      - package.json — stripes.route /example',
      '  - F004-C2 Interactive elements have accessible names and keyboard support; each disabled jsx-a11y rule is justified.',
      '    - Start with:',
      '      - src/Main.js:7 — jsx-a11y/click-events-have-key-events disabled',
      '      - src/Main.js:7 — jsx-a11y/no-static-element-interactions disabled',
      '      - src/Main.js:14 — jsx-a11y/no-noninteractive-element-interactions disabled',
      '      - .eslintrc:4 — jsx-a11y/no-autofocus disabled',
      '      - src/Main.js:8 — <div> with onClick, no role',
      '      - src/Main.js:9 — <span> with onClick and a key handler, no role',
      '      - src/Main.js:14 — <li> with onClick, no role',
      '      - src/Main.js:13 — aria-label "Search all records"',
      '  - F004-C3 Images and icons have text alternatives; status is not shown by color alone.',
      '    - Start with:',
      '      - src/Main.js:4 — <img> without alt',
      '  - F004-C4 Modals and panes manage focus.',
      '  - F004-C5 Accessibility tests (axe) cover the main components.',
      '    - Start with:',
      '      - lib/Pane/tests/Pane-test.js — uses axe',
      '      - src/Main.test.js — uses axe',
      'Agent review:',
      '  - Not applied: F004 agent review needs runtime evidence from a running FOLIO UI (--ui-runtime-url and --ui-runtime-login-origin), and none was given'
    ].join('\n'));
  });

  it('shows the runtime evidence per page, and gives the agent one obligation per page and rule', async () => {
    writeApp();
    commit();
    const probe = new FakeProbe(RUNTIME);

    const { result, analysis } = await evaluate(probe);
    const lines = (result.details ?? '').split('\n');
    const from = (heading: string, count: number) => lines.slice(lines.indexOf(heading), lines.indexOf(heading) + count);

    expect(probe.calls).toEqual([{ moduleId: 'folio_example', targets: [
      { path: '/example', source: 'route' }, { path: '/settings/example', source: 'settings' }, { path: '/settings/about', source: 'about' }] }]);
    expect(result.evidence).toBe('F004 manual: Accessibility must be measured with axe DevTools on the running module; the repository alone cannot show WCAG 2.1 AA conformance. '
      + 'The tool found 2 test files using axe; 4 disabled jsx-a11y rules; 1 image without alt text; 3 click handlers on non-interactive elements; 1 hard-coded aria-label. '
      + 'On the running UI (https://folio-etesting-snapshot-diku.ci.folio.org), axe-core found 2 violations of 2 rules on 2 pages.');
    expect(from('Runtime evidence (informational):', 11)).toEqual([
      'Runtime evidence (informational):',
      '  - UI https://folio-etesting-snapshot-diku.ci.folio.org, login https://folio-etesting-snapshot-keycloak.ci.folio.org, API https://folio-etesting-snapshot-kong.ci.folio.org; '
        + 'Chrome 156.0.8078.47, axe-core 4.14.0 (wcag2a, wcag2aa, wcag21a, wcag21aa); took 14 s',
      '  - Deployed module: folio_example 2.1.1099000000000453 on /settings/about; package.json of this commit: 2.1.0',
      '  - /example (ended on https://folio-etesting-snapshot-diku.ci.folio.org/example?sort=name): color-contrast (serious, 2 elements), aria-allowed-attr (critical, 1 element)',
      '  - /settings/example: no violations',
      '  - /settings/about: read for the deployed version',
      '  - /example?sort=name (stripes.home): not visited — not a plain path such as /users',
      '  - Console errors: 1 on 1 page; first: "Failed to load resource: the server responded with a status of 501 ()"',
      '  - Failed requests: 1; first: HTTP 501 GET https://folio-etesting-snapshot-kong.ci.folio.org/_/env',
      '  - Blocked requests: 1; first: GET https://eureka-customer-assets.s3.us-west-2.amazonaws.com/diku/logo.png (another origin)',
      'What to do:'
    ]);
    expect(from('  - F004-C1 axe DevTools (current major version) finds no WCAG 2.1 AA violations caused by the module on its main screens.', 6)).toEqual([
      '  - F004-C1 axe DevTools (current major version) finds no WCAG 2.1 AA violations caused by the module on its main screens.',
      '    - Start with:',
      '      - package.json — stripes.route /example',
      '      - /example — on the running UI: color-contrast (serious, 2 elements), aria-allowed-attr (critical, 1 element)',
      '      - /settings/example — no violations on the running UI',
      '  - F004-C2 Interactive elements have accessible names and keyboard support; each disabled jsx-a11y rule is justified.'
    ]);
    expect(analysis.checklist.items.map(item => [item.id, item.obligations.map(obligation => obligation.subject ?? obligation.id)])).toEqual([
      ['F004-C1', ['/example: color-contrast', '/example: aria-allowed-attr']],
      ['F004-C2', ['src/Main.js:7 jsx-a11y/click-events-have-key-events', 'src/Main.js:7 jsx-a11y/no-static-element-interactions',
        'src/Main.js:14 jsx-a11y/no-noninteractive-element-interactions', '.eslintrc:4 jsx-a11y/no-autofocus']],
      ['F004-C3', ['F004-C3#1']],
      ['F004-C4', ['F004-C4#1']],
      ['F004-C5', ['F004-C5#1']]
    ]);
    expect(lines.slice(-2)).toEqual(['Agent review:', '  - Not applied: agent review is disabled or unconfigured']);
  });

  it('says why the probe collected nothing without credentials, and starts no browser', async () => {
    writeApp();
    commit();
    const probe = new PlaywrightUiRuntimeProbe({ url: 'https://ui.example.org', loginOrigin: 'https://login.example.org', chromePath: '/nonexistent/chrome' });

    const { result } = await evaluate(probe);
    const lines = (result.details ?? '').split('\n');

    expect(lines.slice(lines.indexOf('Runtime evidence:'), lines.indexOf('Runtime evidence:') + 2)).toEqual([
      'Runtime evidence:', '  - Not collected: FOLIO_UI_USERNAME and FOLIO_UI_PASSWORD must both be set']);
    expect(lines.slice(-1)).toEqual(['  - Not applied: F004 agent review needs runtime evidence, and the probe of the running UI collected none (see "Runtime evidence")']);
  });

  it('is not applicable, and runs no probe, for a package that renders no UI', async () => {
    writePackage({ name: '@folio/stripes-connect', stripes: undefined });
    write('src/index.js', 'export const wrap = Wrapped => props => <Wrapped {...props} />;\n');
    commit();
    const probe = new FakeProbe(RUNTIME);

    const { result, analysis } = await evaluate(probe);

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.evidence).toBe('F004 not applicable: This package renders no user interface.');
    expect(result.details).toBe('What the tool found:\n  - Production source: 1 file in src/, lib/ and the repository root; none renders an HTML element or text\n'
      + '  - Translations: no translations/ directory');
    expect(analysis.checklist.items).toEqual([]);
    expect(probe.calls).toEqual([]);
  });

  it('reads a package.json eslintConfig, and finds no lint configuration when there is none', async () => {
    writePackage({ eslintConfig: { extends: ['@folio/eslint-config-stripes'], rules: { 'jsx-a11y/no-autofocus': ['off'] } } });
    write('src/Page.js', 'export default () => <p>Text</p>;\n');
    commit();

    const { analysis, result } = await evaluate();

    expect(analysis.lint).toEqual({ configFiles: ['package.json'], stripesConfigFiles: ['package.json'], stripesConfigVersion: '^9.0.0' });
    expect(analysis.disabledRules).toEqual([{ path: 'package.json', line: 1, rule: 'no-autofocus' }]);
    expect((result.details ?? '').split('\n')[2]).toBe('  - Lint: package.json uses @folio/eslint-config-stripes (^9.0.0)');

    write('package.json', JSON.stringify({ name: '@folio/example', stripes: { route: '/example' } }));
    commit();
    expect((await evaluate()).result.details?.split('\n')[2]).toBe('  - Lint: no lint configuration at the repository root');
  });

  it('scans disable directives, lint rules and test files in linear time', async () => {
    const source = (size: number) => `export default () => <p>x</p>;\n// ${'eslint-disable-next-line '.repeat(size)}${'jsx-a11y/'.repeat(size)}\n`
      + `/* eslint-disable ${'jsx-a11y/a'.repeat(size)} */\n// ${'eslint-disable-line'.repeat(size)}\n`;
    const config = (size: number) => `{ ${'"jsx-a11y/x": '.repeat(size)}${'jsx-a11y/'.repeat(size)}${`"jsx-a11y/${'a'.repeat(size)}" :`}"jsx-a11y/a":${' '.repeat(size)}x "jsx-a11y/b":[${' '.repeat(size)}x }`;
    await expectLinearTime(20_000, size => ({ source: source(size), config: config(size), test: `${'axe'.repeat(size)}${'@axe-core'.repeat(size)}` }),
      async input => evaluateF004({
        source: { ...sourceOf({ 'src/Page.js': input.source }), packageJson: input.config },
        files: { revision: 'HEAD', complete: true, diagnostics: [], files: [
          { path: '.eslintrc', oid: '', size: input.config.length, content: input.config },
          { path: 'src/Page.test.js', oid: '', size: input.test.length, content: input.test }] },
        runtime: { ...NO_RUNTIME_EVIDENCE },
        guides: { problem: 'not needed' }
      }));
  });

  function sourceOf(files: Record<string, string>): FrontendSource {
    return {
      revision: 'HEAD',
      files: Object.entries(files).map(([file, content]) => ({
        path: file, content, parseError: false, sourceFile: ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)
      })),
      translationPaths: [],
      englishTranslations: {},
      complete: true,
      diagnostics: []
    };
  }
  async function evaluate(probe?: UiRuntimeProbe): Promise<{ result: CriterionResult; analysis: F004Analysis }> {
    const run = createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', uiRuntime: probe });
    const result = await new FrontendEvaluator().evaluateCriterion('F004', repoPath, run);
    return { result, analysis: result.criterionDetails as F004Analysis };
  }
  function writePackage(fields: Record<string, unknown> = {}): void {
    write('package.json', JSON.stringify({ name: '@folio/example', version: '2.1.0', stripes: { actsAs: ['app', 'settings'], route: '/example', home: '/example?sort=name' },
      devDependencies: { '@folio/eslint-config-stripes': '^9.0.0' }, ...fields }));
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
