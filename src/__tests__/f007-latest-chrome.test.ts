import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as ts from 'typescript';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionAgentReviewConfig, CriterionResult, EvaluationStatus, F007Analysis } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { evaluateF007, loadF007BrowserApis, renderF007HumanDetails } from '../utils/f007-latest-chrome';
import { FrontendSource } from '../utils/frontend-source';
import { expectLinearTime } from './helpers/linear-time';

describe('F007 works in the latest Chrome', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f007-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
  });
  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  const IE = 'ms prefix: Internet Explorer and Edge before Chromium';
  const WEBKIT = 'webkit prefix: Chrome, Safari and other WebKit or Chromium browsers';

  function writeApp(): void {
    write('package.json', JSON.stringify({
      name: '@folio/example',
      stripes: { actsAs: ['app', 'settings'], route: '/example', home: '/example?q=1' },
      browserslist: ['last 2 Chrome versions', 'not dead'],
      dependencies: { 'core-js': '^3', 'resize-observer-polyfill': '^1', lodash: '^4' },
      devDependencies: { 'regenerator-runtime': '^0.14' }
    }, null, 2));
    write('.browserslistrc', '# Chrome only\n> 1%\n\n[production]\nlast 2 Chrome versions # current\n');
    write('src/Browser.js', [
      "import { msHelper } from './helpers';",
      "import 'core-js/stable';",
      "import './polyfills/closest';",
      "import debounce from 'lodash/debounce';",
      "const ua = navigator.userAgent || '';",
      "const supported = 'userAgent' in navigator;",
      'if (navigator.userAgentData) debounce(ua);',
      'const brands = window.navigator.userAgentData.brands;',
      'const { vendor, platform: os, language } = navigator;',
      '// navigator.vendor and navigator.msSaveBlob(blob) in a comment',
      "const text = 'navigator.userAgent msSaveBlob webkitURL';",
      'export const save = blob => {',
      '  if (navigator.msSaveBlob) {',
      '    navigator.msSaveBlob(blob);',
      '  }',
      '  navigator.msSaveBlob(blob);',
      "  if ('msSaveOrOpenBlob' in navigator) navigator.msSaveOrOpenBlob(blob);",
      '  navigator.msSaveOrOpenBlob?.(blob);',
      '  if (!window.webkitRequestAnimationFrame) debounce(blob); else window.webkitRequestAnimationFrame(save);',
      "  if (typeof webkitAudioContext !== 'undefined') return new webkitAudioContext();",
      '  return msHelper(new MozWebSocket(text), supported, brands, vendor, os, language, <p>webkitURL</p>);',
      '};'
    ].join('\n'));
    write('src/Legacy.js', [
      "const openDb = name => openDatabase(name, '1', name, 1);",
      'export const dialog = url => window.showModalDialog(url);',
      'export const other = modal => modal.showModalDialog();',
      "export const define = () => document.registerElement('x-a', {});",
      'export function setUp(element, listener, registerElement) {',
      '  element.createShadowRoot();',
      '  registerElement();',
      '  this.registerElement();',
      "  window.addEventListener('DOMNodeInserted', listener);",
      "  window.addEventListener('beforeunload', listener);",
      '  addEventListener(',
      "    'unload', listener);",
      '  window.onunload = listener;',
      '  return openDb(applicationCache);',
      '}'
    ].join('\n'));
    write('src/setup.js', [
      "require('whatwg-fetch');",
      'export const host = process.platform;',
      'export const types = constants.MSG_TYPES;',
      "export const pick = require('lodash/pick');",
      "export const legacy = window['showModalDialog'];"
    ].join('\n'));
    write('src/Browser.test.js', 'it("sniffs", () => expect(navigator.userAgent).toBeTruthy());\n');
  }

  it('lists browser-specific code with file and line, and tells feature detection from sniffing', async () => {
    writeApp();
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    // 'userAgent' in navigator and if (navigator.userAgentData) test for the property; the comment, strings,
    // JSX text, process.platform and the test file are not reads.
    expect(analysis.userAgentReads).toEqual([
      { path: 'src/Browser.js', line: 5, property: 'userAgent' },
      { path: 'src/Browser.js', line: 8, property: 'userAgentData' },
      { path: 'src/Browser.js', line: 9, property: 'vendor' },
      { path: 'src/Browser.js', line: 9, property: 'platform' }
    ]);
    // msHelper is imported, so it is not the browser global; MSG_TYPES is not an interface name.
    expect(analysis.browserApis).toEqual([
      { path: 'src/Browser.js', line: 13, kind: 'vendor-prefixed', name: 'msSaveBlob', note: IE, featureDetected: true },
      { path: 'src/Browser.js', line: 14, kind: 'vendor-prefixed', name: 'msSaveBlob', note: IE, featureDetected: true },
      { path: 'src/Browser.js', line: 16, kind: 'vendor-prefixed', name: 'msSaveBlob', note: IE, featureDetected: false },
      { path: 'src/Browser.js', line: 17, kind: 'vendor-prefixed', name: 'msSaveOrOpenBlob', note: IE, featureDetected: true },
      { path: 'src/Browser.js', line: 18, kind: 'vendor-prefixed', name: 'msSaveOrOpenBlob', note: IE, featureDetected: true },
      { path: 'src/Browser.js', line: 19, kind: 'vendor-prefixed', name: 'webkitRequestAnimationFrame', note: WEBKIT, featureDetected: true },
      { path: 'src/Browser.js', line: 19, kind: 'vendor-prefixed', name: 'webkitRequestAnimationFrame', note: WEBKIT, featureDetected: true },
      { path: 'src/Browser.js', line: 20, kind: 'vendor-prefixed', name: 'webkitAudioContext', note: WEBKIT, featureDetected: true },
      { path: 'src/Browser.js', line: 20, kind: 'vendor-prefixed', name: 'webkitAudioContext', note: WEBKIT, featureDetected: true },
      { path: 'src/Browser.js', line: 21, kind: 'vendor-prefixed', name: 'MozWebSocket', note: 'Moz prefix: Firefox', featureDetected: false },
      // The local openDb, the registerElement parameter, this.registerElement and modal.showModalDialog are not the removed APIs.
      { path: 'src/Legacy.js', line: 1, kind: 'removed', name: 'openDatabase', note: 'window.openDatabase() (Web SQL); removed in Chrome 119', featureDetected: false },
      { path: 'src/Legacy.js', line: 2, kind: 'removed', name: 'showModalDialog', note: 'window.showModalDialog(); removed in Chrome 37', featureDetected: false },
      { path: 'src/Legacy.js', line: 4, kind: 'removed', name: 'registerElement', note: 'document.registerElement() (Custom Elements v0); removed in Chrome 80', featureDetected: false },
      { path: 'src/Legacy.js', line: 6, kind: 'removed', name: 'createShadowRoot', note: 'Element.createShadowRoot() (Shadow DOM v0); removed in Chrome 80', featureDetected: false },
      { path: 'src/Legacy.js', line: 9, kind: 'removed', name: 'DOMNodeInserted', note: 'the DOMNodeInserted mutation event; removed in Chrome 127', featureDetected: false },
      { path: 'src/Legacy.js', line: 12, kind: 'removed', name: 'unload', note: 'the unload event; removed in Chrome 155 (no longer fires by default)', featureDetected: false },
      { path: 'src/Legacy.js', line: 13, kind: 'removed', name: 'onunload', note: 'the onunload handler; removed in Chrome 155 (no longer fires by default)', featureDetected: false },
      { path: 'src/Legacy.js', line: 14, kind: 'removed', name: 'applicationCache', note: 'window.applicationCache (AppCache); removed in Chrome 85', featureDetected: false },
      { path: 'src/setup.js', line: 5, kind: 'removed', name: 'showModalDialog', note: 'window.showModalDialog(); removed in Chrome 37', featureDetected: false }
    ]);
    expect(analysis.browserslist).toEqual([
      { path: 'package.json', line: 11, queries: 'last 2 Chrome versions, not dead' },
      { path: '.browserslistrc', queries: '> 1%, [production], last 2 Chrome versions' }
    ]);
    // devDependencies do not ship, and lodash is no polyfill.
    expect(analysis.polyfills).toEqual([
      { path: 'package.json', line: 16, name: 'core-js', via: 'dependency' },
      { path: 'package.json', line: 17, name: 'resize-observer-polyfill', via: 'dependency' },
      { path: 'src/Browser.js', line: 2, name: 'core-js/stable', via: 'import' },
      { path: 'src/Browser.js', line: 3, name: './polyfills/closest', via: 'import' },
      { path: 'src/setup.js', line: 1, name: 'whatwg-fetch', via: 'import' }
    ]);
    expect(analysis.app).toEqual({ route: '/example', home: '/example?q=1', settings: true });
    expect(result.evidence).toBe('F007 manual: Whether the module works in the latest Chrome must be checked in the browser. The tool found '
      + '4 reads of navigator properties that identify the browser; 10 vendor-prefixed API uses; 9 uses of APIs Chrome removed; 2 browserslist overrides; 5 polyfills.');
    const notes = [
      'src/Browser.js:5 — navigator.userAgent', 'src/Browser.js:8 — navigator.userAgentData',
      'src/Browser.js:9 — navigator.vendor', 'src/Browser.js:9 — navigator.platform'
    ];
    expect(result.details).toBe([
      'What the tool found:',
      '  - App: route /example; home /example?q=1; settings /settings/example',
      '  - User-agent sniffing: 4 reads of navigator properties that identify the browser',
      ...notes.map(note => `    - ${note}`),
      '  - Vendor-prefixed APIs: 10 uses, 8 feature-detected',
      `    - src/Browser.js:13 — msSaveBlob, feature-detected; ${IE}`,
      `    - src/Browser.js:14 — msSaveBlob, feature-detected; ${IE}`,
      `    - src/Browser.js:16 — msSaveBlob; ${IE}`,
      `    - src/Browser.js:17 — msSaveOrOpenBlob, feature-detected; ${IE}`,
      `    - src/Browser.js:18 — msSaveOrOpenBlob, feature-detected; ${IE}`,
      `    - src/Browser.js:19 — webkitRequestAnimationFrame, feature-detected; ${WEBKIT}`,
      `    - src/Browser.js:19 — webkitRequestAnimationFrame, feature-detected; ${WEBKIT}`,
      `    - src/Browser.js:20 — webkitAudioContext, feature-detected; ${WEBKIT}`,
      `    - src/Browser.js:20 — webkitAudioContext, feature-detected; ${WEBKIT}`,
      '    - src/Browser.js:21 — MozWebSocket; Moz prefix: Firefox',
      '  - APIs Chrome removed: 9 uses',
      '    - src/Legacy.js:1 — openDatabase; window.openDatabase() (Web SQL); removed in Chrome 119',
      '    - src/Legacy.js:2 — showModalDialog; window.showModalDialog(); removed in Chrome 37',
      '    - src/Legacy.js:4 — registerElement; document.registerElement() (Custom Elements v0); removed in Chrome 80',
      '    - src/Legacy.js:6 — createShadowRoot; Element.createShadowRoot() (Shadow DOM v0); removed in Chrome 80',
      '    - src/Legacy.js:9 — DOMNodeInserted; the DOMNodeInserted mutation event; removed in Chrome 127',
      '    - src/Legacy.js:12 — unload; the unload event; removed in Chrome 155 (no longer fires by default)',
      '    - src/Legacy.js:13 — onunload; the onunload handler; removed in Chrome 155 (no longer fires by default)',
      '    - src/Legacy.js:14 — applicationCache; window.applicationCache (AppCache); removed in Chrome 85',
      '    - src/setup.js:5 — showModalDialog; window.showModalDialog(); removed in Chrome 37',
      '  - Browserslist: 2 overrides of the platform build\'s browser targets',
      '    - package.json:11 — last 2 Chrome versions, not dead',
      '    - .browserslistrc — > 1%, [production], last 2 Chrome versions',
      '  - Polyfills: 5 polyfills in dependencies, peerDependencies or production imports',
      '    - package.json:16 — core-js (dependency)',
      '    - package.json:17 — resize-observer-polyfill (dependency)',
      '    - src/Browser.js:2 — core-js/stable (import)',
      '    - src/Browser.js:3 — ./polyfills/closest (import)',
      '    - src/setup.js:1 — whatwg-fetch (import)',
      '  - Production source: 3 files in src/, lib/ and the repository root (tests, stories and examples excluded); 1 file renders HTML elements or text',
      '  - Browser API list: config/f007-browser-apis.json, retrieved 2026-10-30, 13 removed APIs',
      'What to do:',
      '  - Open the module\'s main screens in the latest Chrome with the developer tools console open, and check the items below; F007 is always decided by a reviewer.',
      'Checklist for the reviewer:',
      '  - F007-C1 The module\'s main screens load in the latest Chrome without console errors caused by the module.',
      '    - Start with:',
      '      - package.json:8 — route /example',
      '      - package.json:9 — home /example?q=1',
      '      - package.json:4 — settings /settings/example',
      '  - F007-C2 No code path depends on another browser or a removed Chrome API.',
      '    - Start with:',
      '      - src/Browser.js:5 — navigator.userAgent identifies the browser',
      '      - src/Browser.js:8 — navigator.userAgentData identifies the browser',
      '      - src/Browser.js:9 — navigator.vendor identifies the browser',
      '      - src/Browser.js:9 — navigator.platform identifies the browser',
      `      - src/Browser.js:13 — msSaveBlob, feature-detected; ${IE}`,
      `      - src/Browser.js:14 — msSaveBlob, feature-detected; ${IE}`,
      `      - src/Browser.js:16 — msSaveBlob; ${IE}`,
      `      - src/Browser.js:17 — msSaveOrOpenBlob, feature-detected; ${IE}`,
      `      - src/Browser.js:18 — msSaveOrOpenBlob, feature-detected; ${IE}`,
      `      - src/Browser.js:19 — webkitRequestAnimationFrame, feature-detected; ${WEBKIT}`,
      `      - src/Browser.js:19 — webkitRequestAnimationFrame, feature-detected; ${WEBKIT}`,
      `      - src/Browser.js:20 — webkitAudioContext, feature-detected; ${WEBKIT}`,
      `      - src/Browser.js:20 — webkitAudioContext, feature-detected; ${WEBKIT}`,
      '      - src/Browser.js:21 — MozWebSocket; Moz prefix: Firefox',
      '      - src/Legacy.js:1 — openDatabase; window.openDatabase() (Web SQL); removed in Chrome 119',
      '      - src/Legacy.js:2 — showModalDialog; window.showModalDialog(); removed in Chrome 37',
      '      - src/Legacy.js:4 — registerElement; document.registerElement() (Custom Elements v0); removed in Chrome 80',
      '      - src/Legacy.js:6 — createShadowRoot; Element.createShadowRoot() (Shadow DOM v0); removed in Chrome 80',
      '      - src/Legacy.js:9 — DOMNodeInserted; the DOMNodeInserted mutation event; removed in Chrome 127',
      '      - src/Legacy.js:12 — unload; the unload event; removed in Chrome 155 (no longer fires by default)',
      '      - ... 10 more',
      'Agent review:',
      '  - Not applied: F007 agent review needs runtime evidence from a running FOLIO instance, and the evaluator collects none'
    ].join('\n'));
    expect(analysis.checklist.items.map(item => [item.id, item.reviewerOnly, item.startingPoints.length, item.obligations])).toEqual([
      ['F007-C1', false, 3, [{ id: 'F007-C1#1' }]],
      ['F007-C2', false, 30, [{ id: 'F007-C2#1' }]]
    ]);
  });

  it('gives the runtime evidence reason, not "no candidate evidence", when agent review is enabled for F007', async () => {
    write('package.json', JSON.stringify({ name: '@folio/example', stripes: { actsAs: ['app'], route: '/example' } }));
    write('lib/Button.js', 'export default props => <button type="button" {...props} />;\n');
    commit();
    const config: CriterionAgentReviewConfig = { enabled: true, enabledCriteria: ['F007'], adapter: 'fake', modelLabel: 'fake-model' };

    const result = await new FrontendEvaluator().evaluateCriterion('F007', repoPath,
      createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', agentReview: config }));

    expect(result.agentReview).toBeUndefined();
    expect(result.evidence).toBe('F007 manual: Whether the module works in the latest Chrome must be checked in the browser. The tool found '
      + '0 reads of navigator properties that identify the browser; 0 vendor-prefixed API uses; 0 uses of APIs Chrome removed; no browserslist override; 0 polyfills.');
    expect((result.details ?? '').split('\n').slice(1, 8)).toEqual([
      '  - App: route /example',
      '  - User-agent sniffing: none found',
      '  - Vendor-prefixed APIs: none found',
      '  - APIs Chrome removed: none found',
      '  - Browserslist: no override; the platform build\'s browser targets apply',
      '  - Polyfills: none in dependencies, peerDependencies or production imports',
      '  - Production source: 1 file in src/, lib/ and the repository root (tests, stories and examples excluded); 1 file renders HTML elements or text'
    ]);
    expect((result.details ?? '').split('\n').slice(-7)).toEqual([
      'Checklist for the reviewer:',
      '  - F007-C1 The module\'s main screens load in the latest Chrome without console errors caused by the module.',
      '    - Start with:',
      '      - package.json:1 — route /example',
      '  - F007-C2 No code path depends on another browser or a removed Chrome API.',
      'Agent review:',
      '  - Not applied: F007 agent review needs runtime evidence from a running FOLIO instance, and the evaluator collects none'
    ]);
  });

  it.each([
    ['a package with no JSX and no translations', 'export const connect = store => navigator.userAgent;\n'],
    ['JSX that only renders components it is given', 'export const wrap = Wrapped => props => <Wrapped {...props} />;\n']
  ])('is not applicable for %s, with no checklist', async (_name, source) => {
    write('package.json', JSON.stringify({ name: '@folio/stripes-connect' }));
    write('src/index.js', source);
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.evidence).toBe('F007 not applicable: This package renders no user interface.');
    expect(result.details).toBe('What the tool found:\n  - Production source: 1 file in src/, lib/ and the repository root; none renders an HTML element or text\n'
      + '  - Translations: no translations/ directory');
    expect(analysis.checklist.items).toEqual([]);
    expect(analysis.agentReviewUnavailableReason).toBeUndefined();
  });

  it('reads equality and typeof tests per receiver, TypeScript, re-exports and the last of duplicate package.json keys', async () => {
    write('package.json', '{"name": "@folio/example", "browserslist": "defaults", "stripes": {"route": "/a"}, '
      + '"browserslist": {"production": ["> 1%", "last 2 versions"], "development": "last 1 chrome version"}}');
    write('src/Checks.tsx', [
      'export const run = (blob: Blob, props: { webkitHidden?: boolean }) => {',
      '  if (navigator.msSaveBlob == null) navigator.msSaveBlob(blob);',
      '  if (navigator.msSaveOrOpenBlob != null) navigator.msSaveOrOpenBlob(blob);',
      "  if (typeof window.webkitURL !== 'undefined') window.webkitURL.revokeObjectURL('x');",
      '  if (props.webkitHidden) document.webkitHidden;',
      '  return <p>{(navigator as Navigator).userAgent}</p>;',
      '};',
      "import type { Polyfill } from 'core-js';",
      "export * from 'core-js/stable';",
      "export type { Fetch } from 'whatwg-fetch';"
    ].join('\n'));
    commit();

    const { analysis } = await evaluate();
    const row = (line: number, name: string, featureDetected: boolean) => ({ path: 'src/Checks.tsx', line, kind: 'vendor-prefixed', name,
      note: name.startsWith('ms') ? IE : WEBKIT, featureDetected });

    expect(analysis.userAgentReads).toEqual([{ path: 'src/Checks.tsx', line: 6, property: 'userAgent' }]);
    expect(analysis.browserApis).toEqual([
      row(2, 'msSaveBlob', true), row(2, 'msSaveBlob', false),
      row(3, 'msSaveOrOpenBlob', true), row(3, 'msSaveOrOpenBlob', true),
      row(4, 'webkitURL', true), row(4, 'webkitURL', true),
      row(5, 'webkitHidden', true), row(5, 'webkitHidden', false)
    ]);
    expect(analysis.polyfills).toEqual([{ path: 'src/Checks.tsx', line: 9, name: 'core-js/stable', via: 'import' }]);
    expect(analysis.browserslist).toEqual([
      { path: 'package.json', line: 1, queries: 'production: > 1%, last 2 versions; development: last 1 chrome version' }]);
  });

  it.each([
    ['a comment and a trailing comma', '{"stripes": {"route": "/a"}, // app\n}'],
    ['a root that is not an object', '[{"stripes": {"route": "/a"}}]'],
    ['nesting too deep for the line reader', `{"stripes": {"route": "/a"}, "deep": ${'['.repeat(5_000)}${']'.repeat(5_000)}}`]
  ])('lists package.json with %s as unreadable instead of reading it', async (_name, packageJson) => {
    write('package.json', packageJson);
    write('src/Page.js', 'export default () => <p />;\n');
    commit();

    const { result, analysis } = await evaluate();

    expect(analysis.app).toEqual({ settings: false });
    expect(result.evidence).toBe('F007 manual: Whether the module works in the latest Chrome must be checked in the browser. The tool found '
      + '0 reads of navigator properties that identify the browser; 0 vendor-prefixed API uses; 0 uses of APIs Chrome removed; no browserslist override; '
      + '0 polyfills. Not all source files could be read.');
    const lines = (result.details ?? '').split('\n');
    expect(lines.slice(lines.indexOf('What the tool could not read:'), lines.indexOf('What to do:'))).toEqual([
      'What the tool could not read:', '  - package.json — does not parse cleanly']);
  });

  it('says it did not check browser APIs when the pinned list cannot be read, and stays manual', () => {
    const analysis = evaluateF007({
      source: sourceOf({ 'src/Page.js': 'export default () => <p>{navigator.userAgent}</p>;\n' }, '{ "browserslist": "defaults" }'),
      browserslistFiles: { revision: 'HEAD', files: [], diagnostics: [], complete: true },
      apiList: { problem: 'the browser API list could not be read: missing' }
    });

    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.userAgentReads).toEqual([]);
    expect(analysis.summary).toBe('F007 manual: Whether the module works in the latest Chrome must be checked in the browser. The tool found '
      + '1 browserslist override. The pinned browser API list could not be read, so browser-specific APIs and polyfills were not checked.');
    expect(renderF007HumanDetails(analysis)).toBe([
      'What the tool found:',
      '  - App: no stripes.route in package.json',
      '  - Browserslist: 1 override of the platform build\'s browser targets',
      '    - package.json:1 — defaults',
      '  - Production source: 1 file in src/, lib/ and the repository root (tests, stories and examples excluded); 1 file renders HTML elements or text',
      '  - Browser API list: the browser API list could not be read: missing',
      'What to do:',
      '  - Open the module\'s main screens in the latest Chrome with the developer tools console open, and check the items below; F007 is always decided by a reviewer.',
      'Checklist for the reviewer:',
      '  - F007-C1 The module\'s main screens load in the latest Chrome without console errors caused by the module.',
      '  - F007-C2 No code path depends on another browser or a removed Chrome API.',
      '    - Start with:',
      '      - package.json:1 — browserslist defaults',
      'Agent review:',
      '  - Not applied: F007 agent review needs runtime evidence from a running FOLIO instance, and the evaluator collects none'
    ].join('\n'));
  });

  it('pins every part of the browser API list to its source', () => {
    const list = loadF007BrowserApis();
    const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/f007-browser-apis.json'), 'utf8'));
    const sources = [...raw.userAgentProperties.sources, raw.vendorPrefixes.source, ...list.removedFromChrome.map(api => api.source)];
    const hosts = new Set(sources.map(source => new URL(source).host));

    expect([...hosts].sort()).toEqual(['blog.chromium.org', 'developer.chrome.com', 'developer.mozilla.org', 'web.dev']);
    expect(sources.every(source => source.startsWith('https://'))).toBe(true);
    expect(list.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(list.vendorPrefixes.map(prefix => [prefix.property, prefix.interface])).toEqual([['webkit', 'WebKit'], ['moz', 'Moz'], ['ms', 'MS']]);
    expect(() => loadF007BrowserApis(path.join(repoPath, 'missing.json'))).toThrow();
    write('broken.json', JSON.stringify({ ...raw, removedFromChrome: [{ ...raw.removedFromChrome[0], forms: ['attribute'] }] }));
    expect(() => loadF007BrowserApis(path.join(repoPath, 'broken.json'))).toThrow('f007-browser-apis.json must list');
  });

  it('scans source, package.json and browserslist files in linear time', async () => {
    const list = loadF007BrowserApis();
    const run = (input: { source: FrontendSource; browserslist: string }) => Promise.resolve(evaluateF007({
      source: input.source,
      browserslistFiles: { revision: 'HEAD', files: [{ path: '.browserslistrc', oid: '', size: input.browserslist.length, content: input.browserslist }], diagnostics: [], complete: true },
      apiList: list
    }));
    // Nesting the parser can still read: parentheses, negations and && chains around feature tests.
    const nested = (size: number) => [
      `if (${'('.repeat(size / 3)}navigator.msSaveBlob${')'.repeat(size / 3)}) navigator.msSaveBlob(x);`,
      `if (${'!'.repeat(size / 3)}window.webkitHidden) y(); else window.webkitHidden();`,
      ...Array.from({ length: 30 }, () => `if (${'navigator.msSaveBlob && '.repeat(size)}navigator.msSaveBlob(x)) z();`),
      'export default () => <p />;'
    ].join('\n');
    await expectLinearTime(300, size => ({ source: sourceOf({ 'src/Page.js': nested(size) }), browserslist: '' }), run);
    const wide = (size: number) => [
      `const b = MS${'A'.repeat(size)};`,
      `const c = ${'navigator.userAgent + '.repeat(size / 50)}'';`,
      `const { ${Array.from({ length: size / 20 }, (_, index) => `userAgent: u${index}`).join(', ')} } = navigator;`,
      `${'webkitA(); '.repeat(size / 20)}`,
      `${"window.addEventListener('unload', f); ".repeat(size / 40)}`,
      'export default () => <p />;'
    ].join('\n');
    const manifest = (size: number) => JSON.stringify({
      browserslist: Array.from({ length: size / 10 }, () => 'last 2 versions'),
      dependencies: Object.fromEntries(Array.from({ length: size / 10 }, (_, index) => [`polyfill-${index}`, '1'])),
      stripes: { route: `/${'a'.repeat(size)}` }
    });
    const browserslist = (size: number) => `${'#'.repeat(size)}\n${'> 1% '.repeat(size / 5)}\n${'\n'.repeat(size)}`;
    await expectLinearTime(10_000, size => ({ source: sourceOf({ 'src/Page.js': wide(size) }, manifest(size)), browserslist: browserslist(size) }), run);
  });

  function sourceOf(files: Record<string, string>, packageJson?: string): FrontendSource {
    return {
      revision: 'HEAD',
      files: Object.entries(files).map(([file, content]) => ({
        path: file, content, parseError: false, sourceFile: ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)
      })),
      packageJson,
      translationPaths: [],
      englishTranslations: {},
      complete: true,
      diagnostics: []
    };
  }
  async function evaluate(): Promise<{ result: CriterionResult; analysis: F007Analysis }> {
    const result = await new FrontendEvaluator().evaluateCriterion('F007', repoPath);
    return { result, analysis: result.criterionDetails as F007Analysis };
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
