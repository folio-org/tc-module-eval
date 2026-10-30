import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  F006Analysis,
  F006ComponentGroup,
  F006ComponentSite,
  F006ComponentUse,
  F006Form,
  F006HexColor,
  F006Link,
  F006NavigationCheck,
  F006RawControl,
  F006SettingsPage,
  F006SourceSite
} from '../types';
import { CommittedSourceSnapshot, readCommittedSource } from './committed-source';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { FRONTEND_BROWSE_SCOPE, FrontendChecklistItemDraft, numberObligations } from './frontend-agent-review';
import { FrontendSource, frontendUiPresence, isComponentCssPath, lineOf, RENDERS_NO_UI } from './frontend-source';
import { count, reportPath, reportText } from './report-text';
import { isRecord } from './type-guards';

const DEFAULT_GUIDELINES_DIRECTORY = path.resolve(__dirname, '../../config/f006-ux-guidelines');

const COMPONENT_GROUPS: Record<F006ComponentGroup, string[]> = {
  layout: ['Paneset', 'PersistedPaneset', 'Pane', 'PaneHeader', 'PaneSubheader', 'PaneFooter', 'PaneCloseLink', 'Layer'],
  'search-and-filter': ['SearchAndSort', 'SearchAndSortQuery', 'SearchAndSortPane', 'SearchField', 'FilterGroups', 'FilterPaneSearch',
    'FilterAccordionHeader', 'CollapseFilterPaneButton', 'ExpandFilterPaneButton', 'AdvancedSearch', 'MultiColumnList'],
  'actions-and-menus': ['PaneMenu', 'Dropdown', 'DropdownMenu', 'DropdownButton', 'MenuSection', 'ButtonGroup', 'IconButton', 'PaneHeaderIconButton'],
  confirmation: ['ConfirmationModal'],
  controls: ['Button', 'TextField', 'TextArea', 'Select', 'Checkbox', 'RadioButton', 'RadioButtonGroup', 'Datepicker', 'Timepicker',
    'Selection', 'MultiSelection', 'AutoSuggest', 'RepeatableField'],
  settings: ['Settings', 'ControlledVocab', 'EditableList', 'ConfigManager']
};
const GROUP_NAMES: Record<F006ComponentGroup, string> = {
  layout: 'Layout', 'search-and-filter': 'Search and filter', 'actions-and-menus': 'Actions and menus',
  confirmation: 'Confirmation', controls: 'Form controls and buttons', settings: 'Settings'
};
const GROUP_OF = new Map(Object.entries(COMPONENT_GROUPS)
  .flatMap(([group, names]) => names.map(name => [name, group as F006ComponentGroup] as const)));

const STRIPES_UI_MODULE = /^@folio\/stripes[/-](?:smart-)?components(?:\/|$)/;
const FORM_MODULE = /^@folio\/stripes[/-](final-)?form$/;
/** Packages whose own components count when imported from inside the package. */
const STRIPES_COMPONENT_PACKAGES = new Set(['@folio/stripes-components', '@folio/stripes-smart-components']);
/** The package that implements the Stripes controls, so the HTML controls in it are those components. */
const STRIPES_CONTROLS_PACKAGE = '@folio/stripes-components';
const RAW_CONTROLS = new Map<string, string>([['button', 'Button'], ['input', 'TextField'], ['select', 'Select'], ['textarea', 'TextArea']]);
// Input types Stripes has a component for; file, range, color and hidden inputs have none.
const INPUT_COMPONENTS = new Map(Object.entries({
  text: 'TextField', email: 'TextField', number: 'TextField', password: 'TextField', search: 'TextField', tel: 'TextField', url: 'TextField',
  checkbox: 'Checkbox', radio: 'RadioButton', date: 'Datepicker', time: 'Timepicker', submit: 'Button', button: 'Button', reset: 'Button'
}));

const HEX_DIGIT = /[0-9a-fA-F]/;
const WORD_CHARACTER = /[\w-]/;
const EXTERNAL_URL = /https?:\/\/[^\s"'<>`{}|\\^]+/g;
const XML_NAMESPACE = /^http:\/\/www\.w3\.org\//;
const URL_TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']']);

const NAVIGATION_CHECK_LABELS: Record<F006NavigationCheck, string> = {
  true: 'true', false: 'false', 'not-set': 'not set', expression: 'set to an expression'
};

export interface F006Guidelines {
  repository: string;
  commit: string;
  committedAt: string;
  sourceDirectory: string;
  files: Array<{ path: string; content: string }>;
}

/** The pinned snapshot of the stripes-components UX guidelines under `config/f006-ux-guidelines/`. */
export function loadF006Guidelines(directory = DEFAULT_GUIDELINES_DIRECTORY): F006Guidelines {
  const source: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
  if (!isRecord(source) || !Array.isArray(source.files) || !source.files.every(file => typeof file === 'string')
    || typeof source.repository !== 'string' || typeof source.commit !== 'string'
    || typeof source.committedAt !== 'string' || typeof source.sourceDirectory !== 'string') {
    throw new Error('source.json must name the repository, commit, commit date, source directory and files');
  }
  return {
    repository: source.repository,
    commit: source.commit,
    committedAt: source.committedAt,
    sourceDirectory: source.sourceDirectory,
    files: (source.files as string[]).map(file => ({ path: file, content: fs.readFileSync(path.join(directory, file), 'utf8') }))
  };
}

/** The committed component CSS F006 reads for hard-coded colors. */
export function readF006Css(repoPath: string): Promise<CommittedSourceSnapshot> {
  return readCommittedSource(repoPath, { include: isComponentCssPath, maxFiles: 2_000 });
}

export interface F006Input {
  source: FrontendSource;
  css: CommittedSourceSnapshot;
  guidelines: F006Guidelines | { problem: string };
}

/**
 * F006 (UI layouts, patterns and norms): not applicable when the package renders no UI (Q10), otherwise always
 * manual. Layer 1 lists the signals a reviewer starts from: Stripes components used, forms and their
 * navigationCheck, confirmation modals, raw HTML controls, hex colors in CSS, the app's settings pages and the
 * external links, which are never fetched.
 */
export function evaluateF006({ source, css, guidelines }: F006Input): F006Analysis {
  const presence = frontendUiPresence(source);
  const packageJson = parseJson(source.packageJson);
  const packageName = typeof packageJson?.name === 'string' ? packageJson.name : undefined;
  const stripes = isRecord(packageJson?.stripes) ? packageJson.stripes : undefined;
  const implementsStripesControls = packageName === STRIPES_CONTROLS_PACKAGE;
  const scan = scanSource(source, packageName !== undefined && STRIPES_COMPONENT_PACKAGES.has(packageName), implementsStripesControls);
  const translationFiles = Object.keys(source.englishTranslations).sort().map(namespace => `translations/${namespace}/en.json`);
  const links = [...scan.links, ...translationFiles.flatMap(file => translationLinks(file, source.englishTranslations[file.split('/')[1]]))];
  const hexColors = css.files.flatMap(file => cssHexColors(file.path, file.content, !implementsStripesControls));
  const parseErrorFiles = source.files.filter(file => file.parseError).map(file => file.path);
  const analysis: F006Analysis = {
    criterionId: 'F006',
    status: EvaluationStatus.MANUAL,
    summary: '',
    rendersUi: presence.rendersUi,
    uiFileCount: presence.uiFiles.length,
    productionFileCount: source.files.length,
    cssFileCount: css.files.length,
    ...(packageName ? { packageName } : {}),
    implementsStripesControls,
    app: {
      actsAs: Array.isArray(stripes?.actsAs) ? stripes.actsAs.filter((role): role is string => typeof role === 'string' && role !== '') : [],
      ...(typeof stripes?.route === 'string' ? { route: stripes.route } : {}),
      ...(typeof stripes?.home === 'string' ? { home: stripes.home } : {})
    },
    components: scan.components,
    componentSites: scan.componentSites,
    forms: scan.forms,
    confirmationModals: scan.confirmationModals,
    rawControls: scan.rawControls,
    hexColors,
    settingsPages: scan.settingsPages,
    links,
    guidelines: 'problem' in guidelines
      ? { loaded: false, fileCount: 0, problem: guidelines.problem }
      : { loaded: true, repository: guidelines.repository, commit: guidelines.commit, committedAt: guidelines.committedAt,
        sourceDirectory: guidelines.sourceDirectory, fileCount: guidelines.files.length },
    englishTranslationFiles: translationFiles,
    parseErrorFiles,
    sourceDiagnostics: [...source.diagnostics, ...css.diagnostics],
    agentBrowseScope: [FRONTEND_BROWSE_SCOPE, ...translationFiles].join(', '),
    checklist: { items: [] }
  };
  if (!presence.rendersUi) {
    return { ...analysis, status: EvaluationStatus.NOT_APPLICABLE, summary: `F006 not applicable: ${RENDERS_NO_UI}` };
  }
  const incomplete = !source.complete || !css.complete || parseErrorFiles.length > 0;
  return { ...analysis, summary: summaryText(analysis, incomplete), checklist: frontendChecklist(EvaluationStatus.MANUAL, checklistItems(analysis)) };
}

function summaryText(analysis: F006Analysis, incomplete: boolean): string {
  const uses = analysis.components.reduce((total, component) => total + component.uses, 0);
  const componentFiles = new Set(analysis.componentSites.map(site => site.path)).size;
  const notAsking = analysis.forms.filter(form => form.navigationCheck !== 'true').length;
  const findings = [
    `${count(uses, 'use')} of Stripes components in ${count(componentFiles, 'file')}`,
    analysis.forms.length ? `${count(analysis.forms.length, 'form')} (${notAsking} without navigationCheck set to true)` : 'no stripesFinalForm or stripesForm forms',
    count(analysis.confirmationModals.length, 'confirmation modal'),
    analysis.implementsStripesControls ? undefined : count(analysis.rawControls.length, 'raw HTML control'),
    count(analysis.hexColors.length, 'hex color') + ' in CSS',
    count(analysis.links.length, 'external link')
  ].filter((finding): finding is string => !!finding);
  return `F006 manual: A reviewer must check the package against FOLIO's UI layouts, patterns and norms. The tool found ${findings.join('; ')}.`
    + (incomplete ? ' Not all source files could be read.' : '');
}

function checklistItems(analysis: F006Analysis): ReturnType<typeof numberObligations> {
  const componentStarts = (group: F006ComponentGroup) => analysis.componentSites.filter(site => site.group === group)
    .map(site => ({ path: site.path, line: site.line, note: site.names.join(', ') }));
  const formsToCheck = analysis.forms.filter(form => form.navigationCheck !== 'true');
  const formNote = (form: F006Form) => `${form.builder} with navigationCheck ${NAVIGATION_CHECK_LABELS[form.navigationCheck]}`;
  const item = (id: string, title: string, startingPoints: FrontendChecklistItemDraft['startingPoints'], reviewerOnly = false,
    subjects: FrontendChecklistItemDraft['subjects'] = []): FrontendChecklistItemDraft => ({ id, title, startingPoints, reviewerOnly, obligations: [], subjects });
  return numberObligations([
    item('F006-C1', 'Screens use the standard pane layout (search and filter, results, detail, edit layer).', componentStarts('layout')),
    item('F006-C2', 'Search and filter screens follow the SearchAndSort and filter pane patterns.', componentStarts('search-and-filter')),
    item('F006-C3', 'Every form asks before discarding unsaved changes.',
      formsToCheck.map(form => ({ path: form.path, line: form.line, note: formNote(form) })), false,
      formsToCheck.map(form => ({ subject: `${form.path}:${form.line}`, path: form.path, line: form.line }))),
    item('F006-C4', 'Destructive actions ask for confirmation with standard wording.',
      analysis.confirmationModals.map(site => ({ ...site, note: 'ConfirmationModal' }))),
    item('F006-C5', 'Actions, buttons and menus follow the action menu and button guidelines.', componentStarts('actions-and-menus')),
    item('F006-C6', 'Stripes components and color variables are used instead of raw HTML controls and hard-coded colors.', [
      ...analysis.rawControls.map(control => ({ path: control.path, line: control.line, note: `<${control.element}>; Stripes has ${control.stripesComponent}` })),
      ...analysis.hexColors.map(color => ({ path: color.path, line: color.line, note: `${color.property}: ${color.value}` }))
    ]),
    item('F006-C7', 'State is kept when navigating between apps and back, or the user is told it will be lost.', [], true),
    item('F006-C8', 'Settings pages follow the settings layout.', [
      ...componentStarts('settings'),
      ...analysis.settingsPages.map(page => ({ path: page.path, line: page.line, note: `settings page ${page.route}` }))
    ], true),
    item('F006-C9', 'Each documentation link shown in the UI is publicly accessible.',
      analysis.links.map(link => ({ path: link.path, ...(link.line ? { line: link.line } : {}), note: link.key ? `${link.key}: ${link.url}` : link.url })), true)
  ]);
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

interface SourceScan {
  components: F006ComponentUse[];
  componentSites: F006ComponentSite[];
  forms: F006Form[];
  confirmationModals: F006SourceSite[];
  rawControls: F006RawControl[];
  settingsPages: F006SettingsPage[];
  links: F006Link[];
}

interface FileBindings {
  /** Local name to Stripes component name. */
  components: Map<string, string>;
  /** Local names of `import * as X` from a Stripes component module. */
  namespaces: Set<string>;
  forms: Map<string, F006Form['builder']>;
}

function scanSource(source: FrontendSource, ownComponentsCount: boolean, implementsStripesControls: boolean): SourceScan {
  const uses = new Map<string, { uses: number; files: Set<string> }>();
  const scan: SourceScan = { components: [], componentSites: [], forms: [], confirmationModals: [], rawControls: [], settingsPages: [], links: [] };
  for (const file of source.files) {
    const sourceFile = file.sourceFile;
    const bindings = importBindings(sourceFile, ownComponentsCount);
    const at = (node: ts.Node): F006SourceSite => ({ path: file.path, line: lineOf(sourceFile, node.getStart(sourceFile)) });
    const sites = new Map<F006ComponentGroup, F006ComponentSite>();
    // Links count only where the UI shows them: in JSX, not in data or constants.
    const visit = (node: ts.Node, inJsx: boolean): void => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = componentName(node.tagName, bindings);
        if (name) {
          const group = GROUP_OF.get(name)!;
          const use = uses.get(name) ?? { uses: 0, files: new Set<string>() };
          use.uses++;
          use.files.add(file.path);
          uses.set(name, use);
          const site = sites.get(group) ?? { ...at(node), group, names: [] };
          if (!site.names.includes(name)) site.names.push(name);
          sites.set(group, site);
          if (name === 'ConfirmationModal') scan.confirmationModals.push(at(node));
        } else if (!implementsStripesControls) {
          const control = rawControl(node);
          if (control) scan.rawControls.push({ ...at(node), ...control });
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bindings.forms.has(node.expression.text)) {
        scan.forms.push({ ...at(node), builder: bindings.forms.get(node.expression.text)!, navigationCheck: navigationCheck(node.arguments[0]) });
      }
      if (ts.isObjectLiteralExpression(node)) {
        const route = settingsPageRoute(node);
        if (route !== undefined) scan.settingsPages.push({ ...at(node), route });
      }
      if (inJsx && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node))) {
        for (const url of externalUrls(node.text)) scan.links.push({ ...at(node), url });
      }
      const childInJsx = inJsx || ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
      ts.forEachChild(node, child => visit(child, childInJsx));
    };
    visit(sourceFile, false);
    scan.componentSites.push(...sites.values());
  }
  scan.components = [...uses].map(([name, use]) => ({ name, group: GROUP_OF.get(name)!, uses: use.uses, files: use.files.size }))
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  return scan;
}

function importBindings(sourceFile: ts.SourceFile, ownComponentsCount: boolean): FileBindings {
  const bindings: FileBindings = { components: new Map(), namespaces: new Set(), forms: new Map() };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const form = FORM_MODULE.exec(specifier);
    if (form) {
      if (clause.name) bindings.forms.set(clause.name.text, form[1] ? 'stripesFinalForm' : 'stripesForm');
      continue;
    }
    if (!STRIPES_UI_MODULE.test(specifier) && !(ownComponentsCount && specifier.startsWith('.'))) continue;
    if (clause.name) {
      const name = defaultImportName(specifier);
      if (name && GROUP_OF.has(name)) bindings.components.set(clause.name.text, name);
    }
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.namespaces.add(named.name.text);
    else if (named) {
      for (const element of named.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (GROUP_OF.has(imported)) bindings.components.set(element.name.text, imported);
      }
    }
  }
  return bindings;
}

// `@folio/stripes-components/lib/Pane` and `../Pane/index.js` are Pane.
function defaultImportName(specifier: string): string | undefined {
  const segments = specifier.split('/').filter(segment => segment && segment !== '.' && segment !== '..').map(segment => segment.replace(/\.[jt]sx?$/, ''));
  const last = segments.pop();
  return last === 'index' ? segments.pop() : last;
}

function componentName(tagName: ts.JsxTagNameExpression, bindings: FileBindings): string | undefined {
  if (ts.isIdentifier(tagName)) return bindings.components.get(tagName.text);
  if (ts.isPropertyAccessExpression(tagName) && ts.isIdentifier(tagName.expression) && bindings.namespaces.has(tagName.expression.text)
    && GROUP_OF.has(tagName.name.text)) return tagName.name.text;
  return undefined;
}

function rawControl(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): Omit<F006RawControl, 'path' | 'line'> | undefined {
  const stripesComponent = ts.isIdentifier(node.tagName) ? RAW_CONTROLS.get(node.tagName.text) : undefined;
  if (!stripesComponent) return undefined;
  const element = (node.tagName as ts.Identifier).text as F006RawControl['element'];
  const type = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'type');
  const value = type && ts.isJsxAttribute(type) && type.initializer && ts.isJsxExpression(type.initializer) ? type.initializer.expression : type && ts.isJsxAttribute(type) ? type.initializer : undefined;
  if (element !== 'input' || !value || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return { element, stripesComponent };
  const inputComponent = INPUT_COMPONENTS.get(value.text.toLowerCase());
  return inputComponent ? { element, stripesComponent: inputComponent } : undefined;
}

function navigationCheck(options: ts.Expression | undefined): F006NavigationCheck {
  if (!options) return 'not-set';
  if (!ts.isObjectLiteralExpression(options)) return 'expression';
  const index = options.properties.findIndex(item => propertyName(item) === 'navigationCheck');
  const property = options.properties[index];
  // A spread after the option, or anywhere when it is absent, may set it.
  if (options.properties.slice(index + 1).some(ts.isSpreadAssignment)) return 'expression';
  if (!property) return 'not-set';
  if (!ts.isPropertyAssignment(property)) return 'expression';
  return property.initializer.kind === ts.SyntaxKind.TrueKeyword ? 'true'
    : property.initializer.kind === ts.SyntaxKind.FalseKeyword ? 'false' : 'expression';
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  return property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
}

// A Stripes settings page: { route: 'groups', label: ..., component: ... }.
function settingsPageRoute(node: ts.ObjectLiteralExpression): string | undefined {
  const named = (name: string) => node.properties.find(property => propertyName(property) === name);
  const route = named('route');
  if (!route || !named('label') || !named('component') || !ts.isPropertyAssignment(route)) return undefined;
  return ts.isStringLiteral(route.initializer) || ts.isNoSubstitutionTemplateLiteral(route.initializer) ? route.initializer.text : undefined;
}

function externalUrls(text: string): string[] {
  if (!text.includes('://')) return [];
  return [...text.matchAll(EXTERNAL_URL)].map(match => withoutTrailingPunctuation(match[0])).filter(url => !XML_NAMESPACE.test(url));
}

function withoutTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && URL_TRAILING_PUNCTUATION.has(url[end - 1])) end--;
  return url.slice(0, end);
}

function translationLinks(file: string, text: string | undefined): F006Link[] {
  const value = parseJson(text);
  if (!value) return [];
  return Object.entries(value).flatMap(([key, message]) => typeof message === 'string'
    ? externalUrls(message).map(url => ({ path: file, key, url })) : []);
}

/**
 * Hex colors in CSS declaration values (inside a rule, or in an at-rule such as `@value`), outside comments and
 * strings; `#id` selectors are not colors. In the package that defines the Stripes color variables, their
 * definitions (`--name: #fff`) are not counted.
 */
function cssHexColors(file: string, css: string, countVariableDefinitions: boolean): F006HexColor[] {
  const colors: F006HexColor[] = [];
  let line = 1;
  let depth = 0;
  let statementStart = 0;
  let statementBlank = true;
  let statementAtRule = false;
  let property: string | undefined;
  const skipTo = (from: number, to: number): number => {
    for (let position = from; position < to; position++) if (css[position] === '\n') line++;
    return to - 1;
  };
  for (let position = 0; position < css.length; position++) {
    const character = css[position];
    if (character === '\n') {
      line++;
    } else if (character === '/' && css[position + 1] === '*') {
      const end = css.indexOf('*/', position + 2);
      position = skipTo(position, end < 0 ? css.length : end + 2);
    } else if (character === '"' || character === "'") {
      let end = position + 1;
      while (end < css.length && css[end] !== character && css[end] !== '\n') end += css[end] === '\\' ? 2 : 1;
      position = skipTo(position, css[end] === character ? end + 1 : Math.min(end, css.length));
    } else if (character === '{' || character === '}' || character === ';') {
      depth = character === '{' ? depth + 1 : character === '}' ? Math.max(0, depth - 1) : depth;
      statementStart = position + 1;
      statementBlank = true;
      statementAtRule = false;
      property = undefined;
      continue;
    } else if (character === ':' && property === undefined && (depth > 0 || statementAtRule)) {
      property = css.slice(statementStart, position).replace(/\s+/g, ' ').trim();
    } else if (character === '#' && property !== undefined) {
      let end = position + 1;
      while (end < css.length && end - position <= 8 && HEX_DIGIT.test(css[end])) end++;
      const digits = end - position - 1;
      if ([3, 4, 6, 8].includes(digits) && !WORD_CHARACTER.test(css[end] ?? '') && (countVariableDefinitions || !property.startsWith('--'))) {
        colors.push({ path: file, line, property: property.length > 60 ? `${property.slice(0, 57)}...` : property, value: css.slice(position, end) });
      }
      position = end - 1;
    }
    if (statementBlank && character.trim()) {
      statementBlank = false;
      statementAtRule = character === '@';
    }
  }
  return colors;
}

export function renderF006HumanDetails(analysis: F006Analysis, agentReview?: CriterionAgentReviewResult): string {
  if (analysis.status === EvaluationStatus.NOT_APPLICABLE) {
    return [
      'What the tool found:',
      `  - Production source: ${count(analysis.productionFileCount, 'file')} in src/, lib/ and the repository root; none renders an HTML element or text`,
      '  - Translations: no translations/ directory'
    ].join('\n');
  }
  const forms = analysis.forms;
  const byCheck = (value: F006NavigationCheck) => forms.filter(form => form.navigationCheck === value).length;
  const uses = analysis.components.reduce((total, component) => total + component.uses, 0);
  const guidelines = analysis.guidelines;
  const lines = [
    'What the tool found:',
    `  - App: ${analysis.app.actsAs.length ? `actsAs ${analysis.app.actsAs.map(reportText).join(', ')}` : 'no stripes.actsAs in package.json'}`
      + `${analysis.app.route ? `; route ${reportText(analysis.app.route)}` : ''}${analysis.app.home ? `; home ${reportText(analysis.app.home)}` : ''}`
      + `; ${count(analysis.settingsPages.length, 'settings page')}`,
    `  - Stripes components: ${count(uses, 'use')} in ${count(new Set(analysis.componentSites.map(site => site.path)).size, 'file')}`,
    ...(Object.keys(COMPONENT_GROUPS) as F006ComponentGroup[]).flatMap(group => {
      const used = analysis.components.filter(component => component.group === group);
      return used.length ? [`    - ${GROUP_NAMES[group]}: ${used.map(component => `${component.name} ${component.uses}`).join(', ')}`] : [];
    }),
    `  - Forms: ${forms.length ? `${count(forms.length, 'form')} built with stripesFinalForm or stripesForm; navigationCheck true in ${byCheck('true')}, `
      + `false in ${byCheck('false')}, not set in ${byCheck('not-set')}${byCheck('expression') ? `, set to an expression in ${byCheck('expression')}` : ''}` : 'none built with stripesFinalForm or stripesForm'}`,
    `  - Confirmation modals: ${count(analysis.confirmationModals.length, 'ConfirmationModal use')}`,
    `  - Raw HTML controls: ${analysis.implementsStripesControls ? 'not counted; this package implements the Stripes controls'
      : analysis.rawControls.length ? `${analysis.rawControls.length} (${elementCounts(analysis.rawControls)})` : 'none found'}`,
    `  - Hard-coded colors: ${count(analysis.hexColors.length, 'hex color')} in ${count(new Set(analysis.hexColors.map(color => color.path)).size, 'file')} of ${count(analysis.cssFileCount, 'CSS file')}`
      + (analysis.implementsStripesControls ? '; the color variable definitions of this package (--name: #fff) are not counted' : ''),
    `  - External links: ${count(analysis.links.length, 'URL')} in production code and en.json, not fetched`,
    `  - Production source: ${count(analysis.productionFileCount, 'file')} in src/, lib/ and the repository root (tests, stories and examples excluded); `
      + `${count(analysis.uiFileCount, 'file')} ${analysis.uiFileCount === 1 ? 'renders' : 'render'} HTML elements or text`,
    `  - UX guidelines: ${guidelines.loaded ? `stripes-components ${reportText(guidelines.sourceDirectory ?? '')} at ${(guidelines.commit ?? '').slice(0, 7)} `
      + `(${(guidelines.committedAt ?? '').slice(0, 10)}), ${count(guidelines.fileCount, 'file')}` : reportText(guidelines.problem ?? 'not loaded')}`,
    ...(agentReview ? [`  - Agent review scope: ${reportText(analysis.agentBrowseScope)}`] : [])
  ];
  const unread = [...analysis.sourceDiagnostics.map(diagnostic => `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`),
    ...analysis.parseErrorFiles.map(file => `  - ${reportPath(file)} — does not parse cleanly`)];
  if (unread.length) lines.push('What the tool could not read:', ...unread);
  lines.push('What to do:', '  - Check each item below against the FOLIO UX guidelines (stripes-components guides/ux-guidelines, published on ux.folio.org); '
    + 'F006 is always decided by a reviewer.');
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

function elementCounts(controls: F006RawControl[]): string {
  const counts = new Map<string, number>();
  for (const control of controls) counts.set(control.element, (counts.get(control.element) ?? 0) + 1);
  return [...counts].map(([element, total]) => `${element} ${total}`).join(', ');
}
