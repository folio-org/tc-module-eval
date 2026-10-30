import * as path from 'path';
import * as ts from 'typescript';
import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  F004Analysis,
  F004ClickHandler,
  F004DisabledRule,
  F004SourceSite,
  UiRuntimeEvidence,
  UiRuntimePage
} from '../types';
import { CommittedSourceSnapshot, readCommittedSource } from './committed-source';
import { evaluateF003 } from './f003-internationalization';
import { F006Guidelines } from './f006-ui-patterns';
import { FRONTEND_BROWSE_SCOPE, FrontendChecklistItemDraft, numberObligations } from './frontend-agent-review';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { FrontendSource, frontendUiPresence, lineOf, RENDERS_NO_UI } from './frontend-source';
import { count, reportPath, reportText } from './report-text';
import { isRecord } from './type-guards';
import { AXE_TAGS, UiRuntimeTargets, uiRuntimeTargets } from './ui-runtime-probe';
import { runtimeCollected, runtimeEvidenceLines } from './ui-runtime-report';

export const F004_GUIDES_DIRECTORY = path.resolve(__dirname, '../../config/f004-accessibility-guides');

const SOURCE_EXTENSION = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)\/|[.-](?:test|spec)\.[cm]?[jt]sx?$/;
const LINT_CONFIG = /^(?:\.eslintrc(?:\.(?:json|js|cjs|yml|yaml))?|eslint\.config\.(?:js|mjs|cjs|ts|mts)|oxlint\.config\.(?:js|mjs|ts|mts)|\.oxlintrc\.json)$/;
const AXE_USE = /\b(?:runAxeTest|jest-axe|axe-core|toHaveNoViolations)\b|@axe-core\/|\baxe\.run\b/;
const STRIPES_LINT_CONFIG = '@folio/eslint-config-stripes';
const DISABLE_DIRECTIVE = /(?:eslint|oxlint)-disable(?:-next-line|-line)?/g;
const A11Y_RULE = /jsx-a11y\/([a-z][a-z-]*)/g;
const CONFIG_RULE_OFF = /jsx-a11y\/([a-z][a-z-]*)["']?\s*:\s*(?:\[\s*)?(?:"off"|'off'|0(?![\d.]))/g;
const INTERACTIVE_ELEMENTS = new Set(['a', 'area', 'button', 'details', 'input', 'option', 'select', 'summary', 'textarea']);
const KEY_HANDLERS = new Set(['onKeyDown', 'onKeyUp', 'onKeyPress']);

export function isF004TestPath(file: string): boolean {
  return SOURCE_EXTENSION.test(file) && TEST_PATH.test(file);
}

export function readF004Files(repoPath: string): Promise<CommittedSourceSnapshot> {
  return readCommittedSource(repoPath, { include: file => LINT_CONFIG.test(file) || isF004TestPath(file), maxFiles: 2_000 });
}

export interface F004Input {
  source: FrontendSource;
  files: CommittedSourceSnapshot;
  runtime: UiRuntimeEvidence;
  guides: F006Guidelines | { problem: string };
}

export function evaluateF004({ source, files, runtime, guides }: F004Input): F004Analysis {
  const presence = frontendUiPresence(source);
  const manifest = parseJson(source.packageJson);
  const testFiles = files.files.filter(file => isF004TestPath(file.path));
  const configFiles = files.files.filter(file => LINT_CONFIG.test(file.path));
  const usesStripesConfig = (text: string) => text.includes(STRIPES_LINT_CONFIG);
  const eslintConfig = manifest?.eslintConfig === undefined ? undefined : JSON.stringify(manifest.eslintConfig);
  const devDependencies = isRecord(manifest?.devDependencies) ? manifest.devDependencies : {};
  const dependencies = isRecord(manifest?.dependencies) ? manifest.dependencies : {};
  const stripesConfigVersion = devDependencies[STRIPES_LINT_CONFIG] ?? dependencies[STRIPES_LINT_CONFIG];
  const scan = scanSource(source);
  const parseErrorFiles = source.files.filter(file => file.parseError).map(file => file.path);
  const configRules = [...configFiles, ...(source.packageJson ? [{ path: 'package.json', content: source.packageJson }] : [])]
    .flatMap(file => configDisabledRules(file.path, file.content));
  const analysis: F004Analysis = {
    criterionId: 'F004',
    status: EvaluationStatus.MANUAL,
    summary: '',
    rendersUi: presence.rendersUi,
    uiFileCount: presence.uiFiles.length,
    productionFileCount: source.files.length,
    ...(typeof manifest?.name === 'string' ? { packageName: manifest.name } : {}),
    ...(typeof manifest?.version === 'string' ? { packageVersion: manifest.version } : {}),
    axeTests: { files: testFiles.filter(file => AXE_USE.test(file.content)).map(file => file.path), testFileCount: testFiles.length },
    lint: {
      configFiles: [...configFiles.map(file => file.path), ...(eslintConfig !== undefined ? ['package.json'] : [])],
      stripesConfigFiles: [...configFiles.filter(file => usesStripesConfig(file.content)).map(file => file.path),
        ...(eslintConfig !== undefined && usesStripesConfig(eslintConfig) ? ['package.json'] : [])],
      ...(typeof stripesConfigVersion === 'string' ? { stripesConfigVersion } : {})
    },
    disabledRules: [...scan.disabledRules, ...configRules],
    imagesWithoutAlt: scan.imagesWithoutAlt,
    clickHandlers: scan.clickHandlers,
    hardCodedAriaLabels: evaluateF003(source).hardCodedText.filter(text => text.kind === 'aria-label'),
    runtime,
    guides: 'problem' in guides
      ? { loaded: false, fileCount: 0, problem: guides.problem }
      : { loaded: true, repository: guides.repository, commit: guides.commit, committedAt: guides.committedAt,
        sourceDirectory: guides.sourceDirectory, fileCount: guides.files.length },
    parseErrorFiles,
    sourceDiagnostics: [...source.diagnostics, ...files.diagnostics],
    agentBrowseScope: '',
    checklist: { items: [] }
  };
  if (!presence.rendersUi) {
    return { ...analysis, status: EvaluationStatus.NOT_APPLICABLE, summary: `F004 not applicable: ${RENDERS_NO_UI}` };
  }
  const incomplete = !source.complete || !files.complete || parseErrorFiles.length > 0;
  return {
    ...analysis,
    summary: summaryText(analysis, incomplete),
    agentBrowseScope: [FRONTEND_BROWSE_SCOPE, ...f004BrowsePaths(analysis)].join(', '),
    checklist: frontendChecklist(EvaluationStatus.MANUAL, checklistItems(analysis, uiRuntimeTargets(source.packageJson)))
  };
}

export function f004BrowsePaths(analysis: F004Analysis): string[] {
  return [...analysis.axeTests.files, ...analysis.lint.configFiles.filter(file => file !== 'package.json')];
}

function summaryText(analysis: F004Analysis, incomplete: boolean): string {
  const findings = [
    `${count(analysis.axeTests.files.length, 'test file')} using axe`,
    `${count(analysis.disabledRules.length, 'disabled jsx-a11y rule')}`,
    `${count(analysis.imagesWithoutAlt.length, 'image')} without alt text`,
    `${count(analysis.clickHandlers.length, 'click handler')} on non-interactive elements`,
    `${count(analysis.hardCodedAriaLabels.length, 'hard-coded aria-label')}`
  ];
  const runtime = analysis.runtime;
  const pages = runtime.pages.filter(page => page.axe);
  const violations = pages.flatMap(page => page.axe!.violations);
  const runtimeText = runtimeCollected(runtime)
    ? ` On the running UI (${reportText(runtime.uiOrigin ?? '')}), axe-core found ${violations.length
      ? `${count(violations.length, 'violation')} of ${count(new Set(violations.map(violation => violation.id)).size, 'rule')}`
      : 'no violations'} on ${count(pages.length, 'page')}.`
    : '';
  return 'F004 manual: Accessibility must be measured with axe DevTools on the running module; the repository alone cannot show WCAG 2.1 AA conformance. '
    + `The tool found ${findings.join('; ')}.${runtimeText}${incomplete ? ' Not all source files could be read.' : ''}`;
}

function checklistItems(analysis: F004Analysis, routes: UiRuntimeTargets): ReturnType<typeof numberObligations> {
  const pages = analysis.runtime.pages.filter(page => page.axe);
  const ruleSubjects = pages.flatMap(page => page.axe!.violations.map(violation => ({ subject: `${page.path}: ${violation.id}` })));
  const item = (id: string, title: string, startingPoints: FrontendChecklistItemDraft['startingPoints'],
    subjects: FrontendChecklistItemDraft['subjects'] = []): FrontendChecklistItemDraft => ({ id, title, startingPoints, reviewerOnly: false, obligations: [], subjects });
  const site = (entry: F004SourceSite, note: string) => ({ path: entry.path, line: entry.line, note });
  return numberObligations([
    item('F004-C1', 'axe DevTools (current major version) finds no WCAG 2.1 AA violations caused by the module on its main screens.',
      [...routes.targets.filter(target => target.source === 'route' || target.source === 'home').map(target => ({ path: 'package.json', note: `stripes.${target.source} ${target.path}` })),
        ...pages.map(page => ({ path: page.path, note: page.axe!.violations.length ? `on the running UI: ${violationList(page)}` : 'no violations on the running UI' }))], ruleSubjects),
    item('F004-C2', 'Interactive elements have accessible names and keyboard support; each disabled jsx-a11y rule is justified.', [
      ...analysis.disabledRules.map(rule => site(rule, `jsx-a11y/${rule.rule} disabled`)),
      ...analysis.clickHandlers.map(handler => site(handler, `<${handler.element}> with onClick${handler.keyboardHandler ? ' and a key handler' : ''}, no role`)),
      ...analysis.hardCodedAriaLabels.map(label => site(label, `aria-label "${label.text}"`))
    ], analysis.disabledRules.map(rule => ({ subject: `${rule.path}:${rule.line} jsx-a11y/${rule.rule}`, path: rule.path, line: rule.line }))),
    item('F004-C3', 'Images and icons have text alternatives; status is not shown by color alone.',
      analysis.imagesWithoutAlt.map(image => site(image, '<img> without alt'))),
    item('F004-C4', 'Modals and panes manage focus.', []),
    item('F004-C5', 'Accessibility tests (axe) cover the main components.', analysis.axeTests.files.map(file => ({ path: file, note: 'uses axe' })))
  ]);
}

function violationList(page: UiRuntimePage): string {
  return page.axe!.violations.map(violation => `${violation.id} (${violation.impact ?? 'impact unknown'}, ${count(violation.nodeCount, 'element')})`).join(', ');
}

interface SourceScan {
  disabledRules: F004DisabledRule[];
  imagesWithoutAlt: F004SourceSite[];
  clickHandlers: F004ClickHandler[];
}

function scanSource(source: FrontendSource): SourceScan {
  const scan: SourceScan = { disabledRules: [], imagesWithoutAlt: [], clickHandlers: [] };
  for (const file of source.files) {
    const sourceFile = file.sourceFile;
    scan.disabledRules.push(...disabledRules(file.content).map(({ index, rule }) => ({ path: file.path, line: lineOf(sourceFile, index), rule })));
    const visit = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && /^[a-z]/.test(node.tagName.text)) {
        const element = node.tagName.text;
        const names = new Set(node.attributes.properties.filter(ts.isJsxAttribute).map(attribute => attribute.name.getText(sourceFile)));
        const spread = node.attributes.properties.some(ts.isJsxSpreadAttribute);
        const at = { path: file.path, line: lineOf(sourceFile, node.getStart(sourceFile)) };
        if (element === 'img' && !names.has('alt') && !spread) scan.imagesWithoutAlt.push(at);
        if (!INTERACTIVE_ELEMENTS.has(element) && names.has('onClick') && !names.has('role')) {
          scan.clickHandlers.push({ ...at, element, keyboardHandler: [...names].some(name => KEY_HANDLERS.has(name)) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return scan;
}

function disabledRules(text: string): Array<{ index: number; rule: string }> {
  const directives = [...text.matchAll(DISABLE_DIRECTIVE)];
  let lineEnd = -1;
  let commentEnd = -1;
  const next = (marker: string, from: number) => {
    const found = text.indexOf(marker, from);
    return found < 0 ? text.length : found;
  };
  return directives.flatMap((directive, position) => {
    const start = directive.index! + directive[0].length;
    if (lineEnd < start) lineEnd = next('\n', start);
    if (commentEnd < start) commentEnd = next('*/', start);
    const end = Math.min(directives[position + 1]?.index ?? text.length, lineEnd, commentEnd);
    return [...text.slice(start, end).matchAll(A11Y_RULE)].map(rule => ({ index: directive.index!, rule: rule[1] }));
  });
}

function configDisabledRules(file: string, text: string): F004DisabledRule[] {
  let line = 1;
  let counted = 0;
  return [...text.matchAll(CONFIG_RULE_OFF)].map(match => {
    for (; counted < match.index!; counted++) if (text[counted] === '\n') line++;
    return { path: file, line, rule: match[1] };
  });
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function renderF004HumanDetails(analysis: F004Analysis, agentReview?: CriterionAgentReviewResult): string {
  if (analysis.status === EvaluationStatus.NOT_APPLICABLE) {
    return [
      'What the tool found:',
      `  - Production source: ${count(analysis.productionFileCount, 'file')} in src/, lib/ and the repository root; none renders an HTML element or text`,
      '  - Translations: no translations/ directory'
    ].join('\n');
  }
  const lint = analysis.lint;
  const guides = analysis.guides;
  const ruleCounts = new Map<string, number>();
  for (const rule of analysis.disabledRules) ruleCounts.set(rule.rule, (ruleCounts.get(rule.rule) ?? 0) + 1);
  const lines = [
    'What the tool found:',
    `  - Accessibility tests: ${analysis.axeTests.files.length} of ${count(analysis.axeTests.testFileCount, 'test file')} ${analysis.axeTests.files.length === 1 ? 'uses' : 'use'} axe (runAxeTest, jest-axe or axe-core)`,
    `  - Lint: ${lint.stripesConfigFiles.length
      ? `${lint.stripesConfigFiles.map(reportPath).join(', ')} ${lint.stripesConfigFiles.length === 1 ? 'uses' : 'use'} ${STRIPES_LINT_CONFIG}${lint.stripesConfigVersion ? ` (${reportText(lint.stripesConfigVersion)})` : ''}`
      : lint.configFiles.length ? `${lint.configFiles.map(reportPath).join(', ')}, without ${STRIPES_LINT_CONFIG}` : 'no lint configuration at the repository root'}`,
    `  - Disabled jsx-a11y rules: ${analysis.disabledRules.length
      ? `${analysis.disabledRules.length} (${[...ruleCounts].map(([rule, total]) => `${reportText(rule)} ${total}`).join(', ')})` : 'none'}`,
    `  - Images without alt: ${analysis.imagesWithoutAlt.length ? count(analysis.imagesWithoutAlt.length, '<img> element') : 'none found'}`,
    `  - Click handlers without a role: ${analysis.clickHandlers.length || 'none found'}`,
    `  - Hard-coded aria-label text: ${analysis.hardCodedAriaLabels.length || 'none found'} (also listed by F003)`,
    `  - Production source: ${count(analysis.productionFileCount, 'file')} in src/, lib/ and the repository root (tests, stories and examples excluded); `
      + `${count(analysis.uiFileCount, 'file')} ${analysis.uiFileCount === 1 ? 'renders' : 'render'} HTML elements or text`,
    `  - Accessibility guides: ${guides.loaded ? `stripes-components ${reportText(guides.sourceDirectory ?? '')} at ${(guides.commit ?? '').slice(0, 7)} `
      + `(${(guides.committedAt ?? '').slice(0, 10)}), ${count(guides.fileCount, 'file')}` : reportText(guides.problem ?? 'not loaded')}`,
    ...(agentReview ? [`  - Agent review scope: ${reportText(analysis.agentBrowseScope)}`] : []),
    ...runtimeLines(analysis)
  ];
  const unread = [...analysis.sourceDiagnostics.map(diagnostic => `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`),
    ...analysis.parseErrorFiles.map(file => `  - ${reportPath(file)} — does not parse cleanly`)];
  if (unread.length) lines.push('What the tool could not read:', ...unread);
  lines.push('What to do:', '  - Run axe DevTools (current major version) on the module\'s main screens in a test or reference environment and check each item below; '
    + 'F004 is always decided by a reviewer.');
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

function runtimeLines(analysis: F004Analysis): string[] {
  return runtimeEvidenceLines(analysis.runtime, analysis.packageVersion, {
    notConfigured: '--ui-runtime-url and --ui-runtime-login-origin measure a running FOLIO UI with axe-core',
    tools: `, axe-core ${reportText(analysis.runtime.axeVersion ?? 'unknown')} (${AXE_TAGS.join(', ')})`,
    pageResult: page => page.axe ? page.axe.violations.length ? reportText(violationList(page)) : 'no violations' : 'read for the deployed version'
  });
}
