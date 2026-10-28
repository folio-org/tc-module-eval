import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionResult, EvaluationStatus, F003Analysis } from '../types';

describe('F003 internationalization', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f003-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
  });
  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  it('takes the namespace from translations/ when the package name differs, and reports only the missing key', async () => {
    // The Stripes rule would look for ui-circulation-checkin; the only translations directory is ui-checkin.
    writePackage({ name: '@folio/circulation-checkin' });
    write('translations/ui-checkin/en.json', JSON.stringify({ present: 'Present', 'nested.key': 'Nested' }));
    write('translations/ui-checkin/de.json', JSON.stringify({}));
    write('src/Page.js', [
      "import { FormattedMessage, useIntl } from 'react-intl';",
      'export default () => {',
      '  const intl = useIntl();',
      "  const title = intl.formatMessage({ id: 'ui-checkin.nested.key' });",
      '  return (',
      '    <div title={title}>',
      '      <FormattedMessage id="ui-checkin.present" />',
      "      <FormattedMessage id={'ui-checkin.absent'} defaultMessage=\"Absent\" />",
      '    </div>',
      '  );',
      '};'
    ].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(analysis.namespace).toBe('ui-checkin');
    expect(analysis.namespaceBasis).toBe('single-directory');
    expect(analysis.literalIdCount).toBe(3);
    expect(analysis.missingIds).toEqual([{ path: 'src/Page.js', line: 8, text: 'ui-checkin.absent', hasDefaultMessage: true }]);
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('F003 manual: The module uses react-intl and has translations/ui-checkin/en.json (2 texts), '
      + 'but 1 message id it uses is missing from en.json.');
    expect(analysis.checklist.items).toEqual([expect.objectContaining({
      id: 'F003-C1',
      startingPoints: [{ path: 'src/Page.js', line: 8, note: 'ui-checkin.absent (has defaultMessage)' }],
      obligations: [{ id: 'F003-C1#1', subject: 'ui-checkin.absent', path: 'src/Page.js', line: 8 }]
    })]);
    expect(result.details).toContain('Missing from en.json:\n  - src/Page.js:8 — ui-checkin.absent (has defaultMessage)');
  });

  it('counts a missing id once however often it is used, and lists its first 20 uses', async () => {
    writePackage();
    write('translations/ui-example/en.json', JSON.stringify({ present: 'Present' }));
    write('src/Page.js', ["import { FormattedMessage } from 'react-intl';", 'export default ({ flag }) => <>',
      ...Array.from({ length: 22 }, () => '  <FormattedMessage id="ui-example.gone" />'),
      "  <FormattedMessage id={flag ? 'ui-example.present' : null} />", '</>;'].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.evidence).toContain('but 1 message id it uses is missing from en.json (in 22 places).');
    expect(analysis.missingIds).toHaveLength(22);
    // A null branch names no id, so nothing is computed.
    expect(analysis.computedIds).toEqual([]);
    expect(analysis.checklist.items[0].obligations).toEqual([{ id: 'F003-C1#1', subject: 'ui-example.gone', path: 'src/Page.js', line: 3 }]);
    expect(result.details).toContain('      - src/Page.js:22 — ui-example.gone\n      - ... 2 more\n');
  });

  it.each([
    ['a source file over the size limit', 'src/Big.js', `export const data = '${'x'.repeat(300 * 1024)}';\n`],
    ['a source file that does not parse', 'src/Broken.js', 'export default () => <div>{</div>;\n']
  ])('lists %s as not read and keeps the package in scope', async (_name, file, content) => {
    writePackage({ peerDependencies: {} });
    write(file, content);
    commit();

    const { result, analysis } = await evaluate();

    expect(analysis.rendersUi).toBe(true);
    // An unread file might render UI, so the package is not "no UI"; the missing react-intl still fails it.
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.details).toContain(`What the tool could not read:\n  - ${file} — `);
    expect(analysis.checklist.items.map(item => [item.id, item.obligations])).toEqual([
      ['F003-C1', [{ id: 'F003-C1#1' }]], ['F003-C2', [{ id: 'F003-C2#1' }]]]);
  });

  it('is manual for an incomplete scan that would otherwise pass', async () => {
    writePackage();
    write('translations/ui-example/en.json', JSON.stringify({ save: 'Save' }));
    write('src/Page.js', "import { FormattedMessage } from 'react-intl';\nexport default () => <FormattedMessage id=\"ui-example.save\" />;\n");
    write('src/Broken.js', 'export default () => <div>{</div>;\n');
    commit();

    const { result } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toContain('not all production source could be read');
  });

  it('fails for an invalid en.json even when other findings are manual', async () => {
    writePackage();
    write('translations/ui-example/en.json', '{ not json');
    write('src/Page.js', "import { FormattedMessage } from 'react-intl';\nexport default () => <p aria-label=\"Hard coded label\"><FormattedMessage id=\"ui-example.save\" /></p>;\n");
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(analysis.hardCodedText).toHaveLength(1);
    expect(analysis.checklist.items.map(item => item.id)).toEqual(['F003-C2']);
  });

  it.each([
    // With several directories the Stripes rule picks ui- plus the package name, or the bare name for stripes-*.
    ['@folio/checkin', ['ui-legacy', 'ui-checkin'], 'ui-checkin'],
    ['@folio/stripes-widgets', ['stripes-widgets', 'ui-widgets'].reverse(), 'stripes-widgets'],
    ['@folio/checkin', ['ui-legacy', 'ui-other'], undefined]
  ])('with %s and directories %j uses namespace %s', async (name, directories, expected) => {
    writePackage({ name });
    for (const directory of directories) write(`translations/${directory}/en.json`, JSON.stringify({ save: 'Save' }));
    write('src/Page.js', `import { FormattedMessage } from 'react-intl';\nexport default () => <FormattedMessage id="${expected ?? directories[0]}.save" />;\n`);
    commit();

    const { result, analysis } = await evaluate();

    expect(analysis.namespace).toBe(expected);
    if (expected) {
      expect(analysis.namespaceBasis).toBe('stripes-rule');
      expect(result.status).toBe(EvaluationStatus.PASS);
    } else {
      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('the translation namespace is unclear (ui-legacy and ui-other)');
      expect(analysis.checklist.items.map(item => item.id)).toEqual(['F003-C1']);
      expect(analysis.checklist.items[0].obligations).toEqual([{ id: 'F003-C1#1' }]);
    }
  });

  it('lists hard-coded text in JSX and text attributes, but not comments, tests, stories, entities or single words', async () => {
    writePackage();
    write('translations/ui-example/en.json', JSON.stringify({ save: 'Save' }));
    write('src/Search.js', [
      "import { FormattedMessage } from 'react-intl';",
      '// this constant is read as "no value set" by a screen reader',
      'export const Search = () => (',
      '  <div>',
      '    {/* A comment with several words */}',
      '    <input aria-label="Lost items search" placeholder="Search" />',
      '    <p>',
      '      How did you get to',
      '      {\' \'}',
      '    </p>',
      '    <span>&nbsp; &nbsp;</span>',
      '    <Pane title={`Two words`} label={label} />',
      '    <FormattedMessage id="ui-example.save" />',
      '  </div>',
      ');'
    ].join('\n'));
    write('src/Search.test.js', 'it("renders", () => render(<div aria-label="Test only text">Some test words</div>));\n');
    write('lib/Thing/stories/Thing.js', 'export default () => <div>Story text here</div>;\n');
    commit();

    const { result, analysis } = await evaluate();

    expect(analysis.hardCodedText).toEqual([
      { path: 'src/Search.js', line: 6, text: 'Lost items search', kind: 'aria-label' },
      { path: 'src/Search.js', line: 8, text: 'How did you get to', kind: 'jsx-text' },
      { path: 'src/Search.js', line: 12, text: 'Two words', kind: 'title' }
    ]);
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.checklist.items).toEqual([expect.objectContaining({
      id: 'F003-C2',
      obligations: [
        { id: 'F003-C2#1', subject: 'aria-label "Lost items search"', path: 'src/Search.js', line: 6 },
        { id: 'F003-C2#2', subject: 'text "How did you get to"', path: 'src/Search.js', line: 8 },
        { id: 'F003-C2#3', subject: 'title "Two words"', path: 'src/Search.js', line: 12 }
      ]
    })]);
  });

  it('passes with computed ids and other namespaces unchecked, and checks both ids of a conditional', async () => {
    writePackage();
    write('translations/ui-example/en.json', JSON.stringify({ yes: 'Yes', no: 'No', 'items.count': '{count, plural, one {# item} other {# items}}' }));
    write('src/Page.js', [
      "import { FormattedMessage } from 'react-intl';",
      'export default ({ flag, status, intl }) => (',
      '  <div>',
      "    <FormattedMessage id={flag ? 'ui-example.yes' : 'ui-example.no'} />",
      '    <FormattedMessage id={`ui-example.status.${status}`} />',
      "    <FormattedMessage id=\"stripes-core.button.save\" />",
      "    {intl.formatMessage({ id: 'ui-example.items.count' }, { count: 2 })}",
      '  </div>',
      ');'
    ].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(analysis.literalIdCount).toBe(3);
    expect(analysis.otherNamespaceIdCount).toBe(1);
    expect(analysis.computedIds).toEqual([{ path: 'src/Page.js', line: 5, text: '`ui-example.status.${status}`' }]);
    expect(result.evidence).toBe('F003 pass: The module uses react-intl, and every message id it names literally is in '
      + 'translations/ui-example/en.json (3 texts). 1 computed message id was not checked.');
    expect(analysis.checklist.items).toEqual([]);
  });

  it('makes invalid ICU syntax, empty texts and non-strings manual without flagging valid plurals', async () => {
    writePackage();
    write('translations/ui-example/en.json', JSON.stringify({
      ok: '{count, plural, one {# item} other {# items}}',
      broken: '{count, plural, one {# item}',
      empty: ' ',
      nested: { text: 'Nested' }
    }));
    write('src/Page.js', "import { FormattedMessage } from 'react-intl';\nexport default () => <FormattedMessage id=\"ui-example.ok\" />;\n");
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.invalidTexts.map(item => [item.key, item.problem.split(' (')[0]])).toEqual([
      ['broken', 'invalid ICU message syntax'],
      ['empty', 'empty text'],
      ['nested', 'not a string but an object']
    ]);
    expect(analysis.checklist.items.map(item => item.id)).toEqual(['F003-C4']);
  });

  it.each([
    ['a package with no JSX and no translations', EvaluationStatus.NOT_APPLICABLE, 'export const connect = store => store;\n'],
    // stripes-connect wraps the components it is given; it renders no HTML or text of its own.
    ['JSX that only renders components it is given', EvaluationStatus.NOT_APPLICABLE, 'export const wrap = Wrapped => props => <Wrapped {...props} />;\n'],
    ['an HTML element without translations', EvaluationStatus.FAIL, 'export const Box = () => <div className="box" />;\n'],
    ['a component with a literal text prop without translations', EvaluationStatus.FAIL, 'export const Save = () => <Button label="Save changes" />;\n']
  ])('treats %s as %s', async (_name, expected, source) => {
    writePackage({ peerDependencies: {} });
    write('src/index.js', source);
    write('src/index.test.js', 'it("renders", () => render(<div>Test</div>));\n');
    commit();

    const { result } = await evaluate();

    expect(result.status).toBe(expected);
    expect(result.evidence).toBe(expected === EvaluationStatus.NOT_APPLICABLE
      ? 'F003 not applicable: This package renders no user interface.'
      : 'F003 fail: The module renders a user interface, but react-intl is not a dependency or peer dependency in package.json '
        + 'and there is no translations/<namespace>/en.json.');
  });

  it.each([
    ['react-intl only in devDependencies', { devDependencies: { 'react-intl': '^7.1.5' } }, '{"save":"Save"}',
      'react-intl is not a dependency or peer dependency in package.json'],
    ['react-intl declared but never imported', undefined, '{"save":"Save"}', 'no production file imports react-intl'],
    ['en.json that is not JSON', undefined, '{"save": "Save",}', 'translations/ui-example/en.json is not valid JSON']
  ])('fails for %s', async (_name, packageFields, enJson, reason) => {
    writePackage(packageFields && { peerDependencies: {}, ...packageFields });
    write('translations/ui-example/en.json', enJson);
    write('src/Page.js', reason.includes('imports')
      ? 'export default () => <span>{"text"}</span>;\n'
      : "import { FormattedMessage } from 'react-intl';\nexport default () => <FormattedMessage id=\"ui-example.save\" />;\n");
    commit();

    const { result } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe(`F003 fail: The module renders a user interface, but ${reason}.`);
  });

  it('reads committed files only', async () => {
    writePackage();
    write('translations/ui-example/en.json', JSON.stringify({ save: 'Save' }));
    write('src/Page.js', "import { FormattedMessage } from 'react-intl';\nexport default () => <FormattedMessage id=\"ui-example.save\" />;\n");
    commit();
    write('src/Page.js', "import { FormattedMessage } from 'react-intl';\nexport default () => <FormattedMessage id=\"ui-example.uncommitted\" />;\n");

    const { result } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.PASS);
  });

  async function evaluate(): Promise<{ result: CriterionResult; analysis: F003Analysis }> {
    const result = await new FrontendEvaluator().evaluateCriterion('F003', repoPath);
    return { result, analysis: result.criterionDetails as F003Analysis };
  }
  function writePackage(fields: Record<string, unknown> = {}): void {
    write('package.json', JSON.stringify({ name: '@folio/example', stripes: { actsAs: ['app'] }, peerDependencies: { 'react-intl': '^7.1.5' }, ...fields }));
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
