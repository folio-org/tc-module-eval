import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as ts from 'typescript';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionResult, EvaluationStatus, F006Analysis } from '../types';
import { evaluateF006, loadF006Guidelines } from '../utils/f006-ui-patterns';
import { FrontendSource } from '../utils/frontend-source';
import { expectLinearTime } from './helpers/linear-time';

describe('F006 UI layouts, patterns and norms', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f006-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
  });
  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  function writeApp(): void {
    writePackage();
    write('translations/ui-example/en.json', JSON.stringify({ help: 'See https://docs.folio.org/docs/example.', save: 'Save' }));
    write('src/routes/Main.js', [
      "import { Paneset, Pane as StripesPane, Button, ConfirmationModal, Select } from '@folio/stripes/components';",
      "import * as Smart from '@folio/stripes/smart-components';",
      "import Layer from '../local/Layer';",
      'export default () => (',
      '  <Paneset>',
      '    <StripesPane paneTitle="Example">',
      '      <Smart.SearchAndSort />',
      '      <Button>Save</Button>',
      '      <button type="button">Raw</button>',
      '      <Select><option value="a">A</option></Select>',
      '      <input type="checkbox" />',
      '      <input type="file" />',
      '      <input type="hidden" />',
      '      <ConfirmationModal open />',
      '      <a href="https://docs.folio.org/docs/example">Docs</a>',
      '      <Layer />',
      '      <svg xmlns="http://www.w3.org/2000/svg" />',
      "      <input type={'hidden'} />",
      '    </StripesPane>',
      '  </Paneset>',
      ');'
    ].join('\n'));
    write('src/local/Layer.js', 'export default () => <div className="layer" />;\n');
    write('src/local/fake.js', 'const stripesFinalForm = options => component => component;\nexport default stripesFinalForm({})(() => null);\n');
    write('src/data.js', "export const RECORD = { url: 'https://example.org/record' };\nexport const NS = 'http://www.w3.org/2000/svg';\n");
    write('src/forms/Forms.js', [
      "import stripesFinalForm from '@folio/stripes/final-form';",
      "import withReduxForm from '@folio/stripes-form';",
      'const Base = () => null;',
      'export const Checked = stripesFinalForm({ navigationCheck: true })(Base);',
      'export const Unchecked = stripesFinalForm({ navigationCheck: false })(Base);',
      'export const Unset = stripesFinalForm({ enableReinitialize: true })(Base);',
      'export const Computed = stripesFinalForm({ ...options })(Base);',
      "export const Legacy = withReduxForm({ form: 'legacy' })(Base);",
      'export const Overridden = stripesFinalForm({ navigationCheck: true, ...options })(Base);',
      "export const Quoted = stripesFinalForm({ 'navigationCheck': true })(Base);",
      'export const Bare = stripesFinalForm()(Base);'
    ].join('\n'));
    write('src/settings/index.js', [
      "import { Settings } from '@folio/stripes/smart-components';",
      'const pages = [',
      "  { route: 'general', label: 'General', component: () => null },",
      "  { route: 'other', component: () => null },",
      '];',
      'export default props => <Settings pages={pages} {...props} />;'
    ].join('\n'));
    write('src/Main.css', [
      '/* #ffffff in a comment */',
      '#add { color: #333; }',
      '.a { background: var(--color-fill); border: 1px solid #12345; }',
      '.b:hover {',
      '  --accent: #ABCDEF80;',
      '}',
      '.c { border: 1px /* was #eeeeee */ solid; }',
      'a:hover, #add { color: #fed; }',
      '/* a comment over',
      '   two lines #abcdef */ .d { content: "/* #fff"; color: #0a0b0c; }',
      '@value brand: #123;'
    ].join('\n'));
    write('src/stories/Example.css', '.story { color: #000; }\n');
    write('src/routes/Main.test.js', 'it("renders", () => render(<button>Test</button>));\n');
  }

  it('lists the signals a reviewer starts from, with forms that do not set navigationCheck to true', async () => {
    writeApp();
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.forms).toEqual([
      { path: 'src/forms/Forms.js', line: 4, builder: 'stripesFinalForm', navigationCheck: 'true' },
      { path: 'src/forms/Forms.js', line: 5, builder: 'stripesFinalForm', navigationCheck: 'false' },
      { path: 'src/forms/Forms.js', line: 6, builder: 'stripesFinalForm', navigationCheck: 'not-set' },
      { path: 'src/forms/Forms.js', line: 7, builder: 'stripesFinalForm', navigationCheck: 'expression' },
      { path: 'src/forms/Forms.js', line: 8, builder: 'stripesForm', navigationCheck: 'not-set' },
      { path: 'src/forms/Forms.js', line: 9, builder: 'stripesFinalForm', navigationCheck: 'expression' },
      { path: 'src/forms/Forms.js', line: 10, builder: 'stripesFinalForm', navigationCheck: 'true' },
      { path: 'src/forms/Forms.js', line: 11, builder: 'stripesFinalForm', navigationCheck: 'not-set' }
    ]);
    // The aliased Pane and the namespace's SearchAndSort count; the local Layer does not.
    expect(analysis.components.map(component => [component.name, component.uses])).toEqual([
      ['Button', 1], ['ConfirmationModal', 1], ['Pane', 1], ['Paneset', 1], ['SearchAndSort', 1], ['Select', 1], ['Settings', 1]]);
    // <option> inside the Stripes Select, file and hidden inputs, and test files are not raw controls.
    expect(analysis.rawControls).toEqual([
      { path: 'src/routes/Main.js', line: 9, element: 'button', stripesComponent: 'Button' },
      { path: 'src/routes/Main.js', line: 11, element: 'input', stripesComponent: 'Checkbox' }
    ]);
    // #add selectors (also after a pseudo-class), comments, a string, the five-digit value and the story are not colors.
    expect(analysis.hexColors).toEqual([
      { path: 'src/Main.css', line: 2, property: 'color', value: '#333' },
      { path: 'src/Main.css', line: 5, property: '--accent', value: '#ABCDEF80' },
      { path: 'src/Main.css', line: 8, property: 'color', value: '#fed' },
      { path: 'src/Main.css', line: 10, property: 'color', value: '#0a0b0c' },
      { path: 'src/Main.css', line: 11, property: '@value brand', value: '#123' }
    ]);
    // A URL in data and an XML namespace are not links the UI shows.
    expect(analysis.links).toEqual([
      { path: 'src/routes/Main.js', line: 15, url: 'https://docs.folio.org/docs/example' },
      { path: 'translations/ui-example/en.json', key: 'help', url: 'https://docs.folio.org/docs/example' }
    ]);
    expect(analysis.settingsPages).toEqual([{ path: 'src/settings/index.js', line: 3, route: 'general' }]);
    expect(analysis.app).toEqual({ actsAs: ['app', 'settings'], route: '/example', home: '/example?sort=name' });
    expect(result.evidence).toBe('F006 manual: A reviewer must check the package against FOLIO\'s UI layouts, patterns and norms. The tool found '
      + '7 uses of Stripes components in 2 files; 8 forms (6 without navigationCheck set to true); 1 confirmation modal; 2 raw HTML controls; '
      + '5 hex colors in CSS; 2 external links.');
    expect(result.details).toBe([
      'What the tool found:',
      '  - App: actsAs app, settings; route /example; home /example?sort=name; 1 settings page',
      '  - Stripes components: 7 uses in 2 files',
      '    - Layout: Pane 1, Paneset 1',
      '    - Search and filter: SearchAndSort 1',
      '    - Confirmation: ConfirmationModal 1',
      '    - Form controls and buttons: Button 1, Select 1',
      '    - Settings: Settings 1',
      '  - Forms: 8 forms built with stripesFinalForm or stripesForm; navigationCheck true in 2, false in 1, not set in 3, set to an expression in 2',
      '  - Confirmation modals: 1 ConfirmationModal use',
      '  - Raw HTML controls: 2 (button 1, input 1)',
      '  - Hard-coded colors: 5 hex colors in 1 file of 1 CSS file',
      '  - External links: 2 URLs in production code and en.json, not fetched',
      '  - Production source: 6 files in src/, lib/ and the repository root (tests, stories and examples excluded); 2 files render HTML elements or text',
      '  - UX guidelines: stripes-components guides/ux-guidelines at ae9e5d7 (2026-10-28), 46 files',
      'What to do:',
      '  - Check each item below against the FOLIO UX guidelines (stripes-components guides/ux-guidelines, published on ux.folio.org); F006 is always decided by a reviewer.',
      'Checklist for the reviewer:',
      '  - F006-C1 Screens use the standard pane layout (search and filter, results, detail, edit layer).',
      '    - Start with:',
      '      - src/routes/Main.js:5 — Paneset, Pane',
      '  - F006-C2 Search and filter screens follow the SearchAndSort and filter pane patterns.',
      '    - Start with:',
      '      - src/routes/Main.js:7 — SearchAndSort',
      '  - F006-C3 Every form asks before discarding unsaved changes.',
      '    - Start with:',
      '      - src/forms/Forms.js:5 — stripesFinalForm with navigationCheck false',
      '      - src/forms/Forms.js:6 — stripesFinalForm with navigationCheck not set',
      '      - src/forms/Forms.js:7 — stripesFinalForm with navigationCheck set to an expression',
      '      - src/forms/Forms.js:8 — stripesForm with navigationCheck not set',
      '      - src/forms/Forms.js:9 — stripesFinalForm with navigationCheck set to an expression',
      '      - src/forms/Forms.js:11 — stripesFinalForm with navigationCheck not set',
      '  - F006-C4 Destructive actions ask for confirmation with standard wording.',
      '    - Start with:',
      '      - src/routes/Main.js:14 — ConfirmationModal',
      '  - F006-C5 Actions, buttons and menus follow the action menu and button guidelines.',
      '  - F006-C6 Stripes components and color variables are used instead of raw HTML controls and hard-coded colors.',
      '    - Start with:',
      '      - src/routes/Main.js:9 — <button>; Stripes has Button',
      '      - src/routes/Main.js:11 — <input>; Stripes has Checkbox',
      '      - src/Main.css:2 — color: #333',
      '      - src/Main.css:5 — --accent: #ABCDEF80',
      '      - src/Main.css:8 — color: #fed',
      '      - src/Main.css:10 — color: #0a0b0c',
      '      - src/Main.css:11 — @value brand: #123',
      '  - F006-C7 State is kept when navigating between apps and back, or the user is told it will be lost.',
      '  - F006-C8 Settings pages follow the settings layout.',
      '    - Start with:',
      '      - src/settings/index.js:6 — Settings',
      '      - src/settings/index.js:3 — settings page general',
      '  - F006-C9 Each documentation link shown in the UI is publicly accessible.',
      '    - Start with:',
      '      - src/routes/Main.js:15 — https://docs.folio.org/docs/example',
      '      - translations/ui-example/en.json — help: https://docs.folio.org/docs/example',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ].join('\n'));
    expect(analysis.checklist.items.map(item => [item.id, item.reviewerOnly, item.obligations.map(obligation => obligation.id)])).toEqual([
      ['F006-C1', false, ['F006-C1#1']],
      ['F006-C2', false, ['F006-C2#1']],
      ['F006-C3', false, ['F006-C3#1', 'F006-C3#2', 'F006-C3#3', 'F006-C3#4', 'F006-C3#5', 'F006-C3#6']],
      ['F006-C4', false, ['F006-C4#1']],
      ['F006-C5', false, ['F006-C5#1']],
      ['F006-C6', false, ['F006-C6#1']],
      ['F006-C7', true, []],
      ['F006-C8', false, ['F006-C8#1']],
      ['F006-C9', true, []]
    ]);
    expect(analysis.checklist.items[2].obligations[1]).toEqual({
      id: 'F006-C3#2', subject: 'src/forms/Forms.js:6', path: 'src/forms/Forms.js', line: 6 });
  });

  it('counts the components of a Stripes component package imported from inside it, but not the HTML controls that implement them', async () => {
    writePackage({ name: '@folio/stripes-components', stripes: undefined });
    write('lib/TextField/TextField.js', 'export default props => <div><input type="text" {...props} /><button type="button">Clear</button></div>;\n');
    write('lib/Pane/Pane.js', "import PaneHeader from '../PaneHeader';\nimport { Button } from '../index';\nexport default () => <section><PaneHeader /><Button /></section>;\n");
    write('lib/variables.css', ':root {\n  --color-text: #333;\n}\n');
    write('lib/Pane/Pane.css', '.pane { color: #fff; }\n');
    commit();

    const { result, analysis } = await evaluate();

    expect(analysis.implementsStripesControls).toBe(true);
    expect(analysis.rawControls).toEqual([]);
    expect(analysis.components.map(component => [component.name, component.uses])).toEqual([['Button', 1], ['PaneHeader', 1]]);
    expect(result.evidence).toBe('F006 manual: A reviewer must check the package against FOLIO\'s UI layouts, patterns and norms. The tool found '
      + '2 uses of Stripes components in 1 file; no stripesFinalForm or stripesForm forms; 0 confirmation modals; 1 hex color in CSS; 0 external links.');
    expect((result.details ?? '').split('\n').slice(0, 11)).toEqual([
      'What the tool found:',
      '  - App: no stripes.actsAs in package.json; 0 settings pages',
      '  - Stripes components: 2 uses in 1 file',
      '    - Layout: PaneHeader 1',
      '    - Form controls and buttons: Button 1',
      '  - Forms: none built with stripesFinalForm or stripesForm',
      '  - Confirmation modals: 0 ConfirmationModal uses',
      '  - Raw HTML controls: not counted; this package implements the Stripes controls',
      '  - Hard-coded colors: 1 hex color in 1 file of 2 CSS files; the color variable definitions of this package (--name: #fff) are not counted',
      '  - External links: 0 URLs in production code and en.json, not fetched',
      '  - Production source: 2 files in src/, lib/ and the repository root (tests, stories and examples excluded); 2 files render HTML elements or text'
    ]);
  });

  it('counts raw HTML controls in other Stripes libraries', async () => {
    writePackage({ name: '@folio/stripes-smart-components', stripes: undefined });
    write('lib/Notes/Note.js', "import { TextArea } from '@folio/stripes-components';\nimport SearchAndSort from '../SearchAndSort';\n"
      + 'export default () => <div><TextArea /><textarea /><SearchAndSort /></div>;\n');
    write('lib/Notes/Note.css', ':root { --note-color: #333; }\n');
    commit();

    const { analysis } = await evaluate();

    expect(analysis.rawControls).toEqual([{ path: 'lib/Notes/Note.js', line: 3, element: 'textarea', stripesComponent: 'TextArea' }]);
    // Its own SearchAndSort, imported from inside the package, counts; other packages' variable definitions are hard-coded colors.
    expect(analysis.components.map(component => [component.name, component.uses])).toEqual([['SearchAndSort', 1], ['TextArea', 1]]);
    expect(analysis.hexColors).toEqual([{ path: 'lib/Notes/Note.css', line: 1, property: '--note-color', value: '#333' }]);
  });

  it('gives the whole of F006-C3 to the agent when every form sets navigationCheck to true', async () => {
    writePackage();
    write('src/Form.js', "import stripesFinalForm from '@folio/stripes/final-form';\nconst Base = () => <form />;\nexport default stripesFinalForm({ navigationCheck: true })(Base);\n");
    commit();

    const { analysis } = await evaluate();

    expect(analysis.checklist.items[2]).toEqual({ id: 'F006-C3', title: 'Every form asks before discarding unsaved changes.',
      startingPoints: [], reviewerOnly: false, obligations: [{ id: 'F006-C3#1' }] });
  });

  it.each([
    ['a package with no JSX and no translations', 'export const connect = store => store;\n'],
    ['JSX that only renders components it is given', 'export const wrap = Wrapped => props => <Wrapped {...props} />;\n']
  ])('is not applicable for %s, with no checklist', async (_name, source) => {
    writePackage({ name: '@folio/stripes-connect', stripes: undefined });
    write('src/index.js', source);
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.evidence).toBe('F006 not applicable: This package renders no user interface.');
    expect(result.details).toBe('What the tool found:\n  - Production source: 1 file in src/, lib/ and the repository root; none renders an HTML element or text\n'
      + '  - Translations: no translations/ directory');
    expect(analysis.checklist.items).toEqual([]);
  });

  it('says what it could not read and stays manual', async () => {
    writePackage();
    write('src/Page.js', 'export default () => <div />;\n');
    write('src/Big.css', `.a { color: #fff; content: "${'x'.repeat(300 * 1024)}"; }\n`);
    commit();

    const { result } = await evaluate();
    const lines = (result.details ?? '').split('\n');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('F006 manual: A reviewer must check the package against FOLIO\'s UI layouts, patterns and norms. The tool found '
      + '0 uses of Stripes components in 0 files; no stripesFinalForm or stripesForm forms; 0 confirmation modals; 0 raw HTML controls; 0 hex colors in CSS; '
      + '0 external links. Not all source files could be read.');
    expect(lines.slice(lines.indexOf('What the tool could not read:'), lines.indexOf('What the tool could not read:') + 3)).toEqual([
      'What the tool could not read:', '  - src/Big.css — Committed file exceeds the 262144-byte per-file limit', 'What to do:']);
  });

  it('vendors exactly the files its manifest lists: layout, forms, navigation, actions, the confirmation modal and the results list', () => {
    const directory = path.resolve(__dirname, '../../config/f006-ux-guidelines');
    const guidelines = loadF006Guidelines();
    const onDisk = listFiles(directory).filter(file => file !== 'source.json').sort();
    expect(guidelines.files.map(file => file.path).sort()).toEqual(onDisk);
    expect(onDisk.filter(file => !/^(?:layout|forms|navigation|actions)\//.test(file)))
      .toEqual(['data-display/MultiColumnListGuidelines.mdx', 'feedback/ConfirmationModalPattern.mdx']);
    expect(onDisk.filter(file => file.startsWith('actions/'))).toEqual(['actions/ActionLanguage.mdx', 'actions/ButtonGroupGuidelines.mdx',
      'actions/ButtonGuidelines.mdx', 'actions/ConfirmationLanguageGuidelines.mdx', 'actions/DropdownButtonGuidelines.mdx',
      'actions/ExportCsvGuidelines.mdx', 'actions/IconButtonGuidelines.mdx']);
    expect(guidelines.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(guidelines.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)).toBeLessThan(80 * 1024);
  });

  it('scans CSS and links in linear time', async () => {
    const css = (size: number) => [
      `.a { color: ${'#'.repeat(size)}fff; }`,
      `${':'.repeat(size)}#abc;`,
      `.b { background: #${'a'.repeat(size)}; }`,
      `a{${' '.repeat(size)}x:${' #fff'.repeat(size / 5)}}`,
      `.c { content: "${'\\"'.repeat(size)}`,
      '/* '.repeat(size)
    ].join('\n');
    const jsx = (size: number) => `export default () => <p title="${`https://${')'.repeat(size)}a`} ${'http'.repeat(size)}">{'${'https://x.org/'.repeat(size)}'}</p>;\n`;
    await expectLinearTime(20_000, size => ({ css: css(size), jsx: jsx(size) }), async input => evaluateF006({
      source: sourceOf({ 'src/Page.js': input.jsx }),
      css: { revision: 'HEAD', files: [{ path: 'src/Page.css', oid: '', size: input.css.length, content: input.css }], diagnostics: [], complete: true },
      guidelines: { problem: 'not needed' }
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
  function listFiles(directory: string, prefix = ''): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? listFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
  }
  async function evaluate(): Promise<{ result: CriterionResult; analysis: F006Analysis }> {
    const result = await new FrontendEvaluator().evaluateCriterion('F006', repoPath);
    return { result, analysis: result.criterionDetails as F006Analysis };
  }
  function writePackage(fields: Record<string, unknown> = {}): void {
    write('package.json', JSON.stringify({ name: '@folio/example', stripes: { actsAs: ['app', 'settings'], route: '/example', home: '/example?sort=name' }, ...fields }));
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
