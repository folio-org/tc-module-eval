import * as ts from 'typescript';
import { parse as parseIcuMessage } from '@formatjs/icu-messageformat-parser';
import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  F003Analysis,
  F003HardCodedText,
  F003InvalidText,
  F003MessageIdSite,
  F003NamespaceBasis,
  F003SourceSite,
  FrontendChecklistItem
} from '../types';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { FRONTEND_BROWSE_SCOPE, numberObligations } from './frontend-agent-review';
import { FrontendSource, frontendUiPresence, lineOf, RENDERS_NO_UI, TEXT_ATTRIBUTES } from './frontend-source';
import { count, listText, overflowLine, reportPath, reportText, unique } from './report-text';
import { isRecord } from './type-guards';

const MESSAGE_ELEMENTS = new Set(['FormattedMessage', 'FormattedHTMLMessage']);
const SHOWN_SITES = 20;
const SHOWN_UI_FILES = 5;

/** The translation files F003's agent review may read: the module's own en.json, or every candidate when unclear. */
export function f003TranslationPaths(namespace: string | undefined, directories: string[]): string[] {
  return (namespace ? [namespace] : directories).map(directory => `translations/${directory}/en.json`);
}

/**
 * F003 (i18n via react-intl and an en.json with English texts), from the committed production source. Not
 * applicable when the package renders no UI (Q10); fail without react-intl or a valid en.json; manual for literal
 * message ids missing from en.json (Q4), hard-coded text, invalid texts, an ambiguous namespace or an incomplete
 * scan; pass otherwise. Computed ids are listed but not checked.
 */
export function evaluateF003(source: FrontendSource): F003Analysis {
  const presence = frontendUiPresence(source);
  const packageJson = parsePackageJson(source.packageJson);
  const translationDirectories = [...new Set(source.translationPaths
    .map(path => /^translations\/([^/]+)\//.exec(path)?.[1]).filter((name): name is string => !!name))];
  const { namespace, basis } = translationNamespace(translationDirectories, packageJson?.name);
  const translationPaths = f003TranslationPaths(namespace, translationDirectories);
  const scan = scanSource(source, namespace);
  const declaration = reactIntlDeclaration(packageJson);
  const translationFile = namespace ? readTranslationFile(source, namespace) : undefined;
  const keys = translationFile?.keys;
  const missingIds = keys ? scan.literalIds.filter(site => !Object.prototype.hasOwnProperty.call(keys, site.text.slice(namespace!.length + 1))) : [];
  const parseErrorFiles = source.files.filter(file => file.parseError).map(file => file.path);
  const base = {
    criterionId: 'F003' as const,
    rendersUi: presence.rendersUi,
    uiFiles: presence.uiFiles.slice(0, SHOWN_UI_FILES),
    uiFileCount: presence.uiFiles.length,
    productionFileCount: source.files.length,
    reactIntl: { ...(declaration ? { declaration } : {}), importingFileCount: scan.reactIntlFiles },
    ...(namespace ? { namespace } : {}),
    namespaceBasis: basis,
    translationDirectories,
    ...(translationFile ? { translationFile: translationFile.record } : {}),
    literalIdCount: scan.literalIds.length,
    otherNamespaceIdCount: scan.otherNamespaceIds,
    missingIds,
    hardCodedText: scan.hardCodedText,
    computedIds: scan.computedIds,
    invalidTexts: translationFile?.invalidTexts ?? [],
    parseErrorFiles,
    sourceDiagnostics: source.diagnostics,
    agentBrowseScope: [FRONTEND_BROWSE_SCOPE, ...translationPaths].join(', ')
  };

  if (!presence.rendersUi) {
    return { ...base, status: EvaluationStatus.NOT_APPLICABLE, summary: `F003 not applicable: ${RENDERS_NO_UI}`, checklist: { items: [] } };
  }

  const incomplete = !source.complete || parseErrorFiles.length > 0;
  const failures: string[] = [];
  if (!declaration) failures.push('react-intl is not a dependency or peer dependency in package.json');
  else if (scan.reactIntlFiles === 0 && !incomplete) failures.push('no production file imports react-intl');
  if (basis === 'none') failures.push('there is no translations/<namespace>/en.json');
  else if (translationFile?.record.state === 'missing') failures.push(`there is no ${translationFile.record.path}`);
  else if (translationFile?.record.state === 'invalid') failures.push(`${translationFile.record.path} ${translationFile.record.problem}`);

  const reasons: string[] = [];
  const missingIdCount = unique(missingIds.map(site => site.text)).length;
  if (missingIdCount) {
    reasons.push(`${count(missingIdCount, 'message id')} it uses ${missingIdCount === 1 ? 'is' : 'are'} missing from en.json`
      + (missingIds.length > missingIdCount ? ` (in ${missingIds.length} places)` : ''));
  }
  if (scan.hardCodedText.length) reasons.push(`${count(scan.hardCodedText.length, 'text')} in the code ${scan.hardCodedText.length === 1 ? 'looks' : 'look'} hard-coded`);
  if (base.invalidTexts.length) reasons.push(`${count(base.invalidTexts.length, 'text')} in en.json ${base.invalidTexts.length === 1 ? 'is' : 'are'} not valid ICU messages`);
  if (basis === 'ambiguous') reasons.push(`the translation namespace is unclear (${listText(translationDirectories)})`);
  if (translationFile?.record.state === 'unreadable') reasons.push(`${translationFile.record.path} could not be read`);
  if (incomplete) reasons.push('not all production source could be read');

  const status = failures.length ? EvaluationStatus.FAIL : reasons.length ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  const fileText = translationFile?.record.state === 'valid'
    ? `${translationFile.record.path} (${count(translationFile.record.keyCount ?? 0, 'text')})` : 'an English translation file';
  const computedNote = scan.computedIds.length ? ` ${count(scan.computedIds.length, 'computed message id')} ${scan.computedIds.length === 1 ? 'was' : 'were'} not checked.` : '';
  const summary = status === EvaluationStatus.FAIL
    ? `F003 fail: The module renders a user interface, but ${listText(failures)}.`
    : status === EvaluationStatus.MANUAL
      ? `F003 manual: The module uses react-intl and has ${fileText}, but ${listText(reasons)}.`
      : `F003 pass: The module uses react-intl, and every message id it names literally is in ${fileText}.${computedNote}`;
  return { ...base, status, summary, checklist: frontendChecklist(status, checklistItems(base, incomplete, basis)) };
}

function checklistItems(analysis: Pick<F003Analysis, 'missingIds' | 'hardCodedText' | 'computedIds' | 'invalidTexts' | 'translationDirectories' | 'namespace' | 'parseErrorFiles' | 'sourceDiagnostics'>,
  incomplete: boolean, basis: F003NamespaceBasis): FrontendChecklistItem[] {
  const unread = [...analysis.sourceDiagnostics.flatMap(diagnostic => diagnostic.path ? [{ path: diagnostic.path, note: reportText(diagnostic.message) }] : []),
    ...analysis.parseErrorFiles.map(path => ({ path, note: 'does not parse cleanly' }))];
  const items: Array<FrontendChecklistItem & { subjects: Array<{ subject: string; path: string; line?: number }> }> = [];
  const site = (item: F003SourceSite) => ({ path: item.path, line: item.line });
  // An item the tool could not check at all is given to the reviewer and the agent as a whole.
  const unchecked = basis === 'ambiguous' || incomplete;
  if (analysis.missingIds.length || unchecked) {
    items.push({
      id: 'F003-C1',
      title: 'Each listed id exists in en.json, or the code supplies English fallback text (defaultMessage or a label prop).',
      startingPoints: analysis.missingIds.length
        ? analysis.missingIds.map(item => ({ ...site(item), note: `${item.text}${item.hasDefaultMessage ? ' (has defaultMessage)' : ''}` }))
        : basis === 'ambiguous'
          ? analysis.translationDirectories.map(directory => ({ path: `translations/${directory}/en.json`, note: 'one of several translation namespaces' }))
          : unread,
      reviewerOnly: false,
      obligations: [],
      // One obligation per id, at its first use; every use is a starting point.
      subjects: unique(analysis.missingIds.map(item => item.text))
        .map(id => analysis.missingIds.find(item => item.text === id)!)
        .map(item => ({ subject: item.text, ...site(item) }))
    });
  }
  if (analysis.hardCodedText.length || incomplete) {
    items.push({
      id: 'F003-C2',
      title: 'No user-visible text is hard-coded: each listed string is either not shown to users or comes from en.json.',
      startingPoints: analysis.hardCodedText.length
        ? analysis.hardCodedText.map(item => ({ ...site(item), note: hardCodedLabel(item) }))
        : unread,
      reviewerOnly: false,
      obligations: [],
      subjects: analysis.hardCodedText.map(item => ({ subject: hardCodedLabel(item), ...site(item) }))
    });
  }
  if (analysis.computedIds.length) {
    items.push({
      id: 'F003-C3',
      title: 'Computed message ids resolve to keys in en.json.',
      startingPoints: analysis.computedIds.map(item => ({ ...site(item), note: item.text })),
      reviewerOnly: false,
      obligations: [],
      subjects: []
    });
  }
  if (analysis.invalidTexts.length) {
    items.push({
      id: 'F003-C4',
      title: 'Every en.json value has valid ICU syntax.',
      startingPoints: analysis.invalidTexts.map(item => ({ path: item.path, note: `${item.key}: ${item.problem}` })),
      reviewerOnly: false,
      obligations: [],
      subjects: analysis.invalidTexts.map(item => ({ subject: item.key, path: item.path }))
    });
  }
  return numberObligations(items);
}

function hardCodedLabel(item: F003HardCodedText): string {
  return item.kind === 'jsx-text' ? `text "${item.text}"` : `${item.kind} "${item.text}"`;
}

function parsePackageJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function reactIntlDeclaration(packageJson: Record<string, unknown> | undefined): string | undefined {
  for (const field of ['dependencies', 'peerDependencies']) {
    const dependencies = packageJson?.[field];
    if (isRecord(dependencies) && typeof dependencies['react-intl'] === 'string') return `${field} ${dependencies['react-intl']}`;
  }
  return undefined;
}

// Stripes loads translations/<namespace>/, where the namespace is `ui-` plus the package name for apps and
// plugins, and the bare name for stripes-* libraries. ui-checkin's package is @folio/checkin.
function translationNamespace(directories: string[], packageName: unknown): { namespace?: string; basis: F003NamespaceBasis } {
  if (directories.length === 1) return { namespace: directories[0], basis: 'single-directory' };
  if (directories.length === 0) return { basis: 'none' };
  const bare = typeof packageName === 'string' ? packageName.replace(/^@[^/]+\//, '') : undefined;
  const expected = bare && (bare.startsWith('stripes-') ? bare : `ui-${bare}`);
  return expected && directories.includes(expected) ? { namespace: expected, basis: 'stripes-rule' } : { basis: 'ambiguous' };
}

function readTranslationFile(source: FrontendSource, namespace: string): {
  record: NonNullable<F003Analysis['translationFile']>;
  keys?: Record<string, unknown>;
  invalidTexts?: F003InvalidText[];
} {
  const path = `translations/${namespace}/en.json`;
  const text = source.englishTranslations[namespace];
  if (text === undefined) {
    return { record: { path, state: source.translationPaths.includes(path) ? 'unreadable' : 'missing' } };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { record: { path, state: 'invalid', problem: 'is not valid JSON' } };
  }
  if (!isRecord(value)) return { record: { path, state: 'invalid', problem: 'is not a JSON object of texts' } };
  const invalidTexts: F003InvalidText[] = [];
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== 'string' || !text.trim()) {
      invalidTexts.push({ key, path, problem: typeof text === 'string' ? 'empty text' : `not a string but ${Array.isArray(text) ? 'an array' : text === null ? 'null' : typeof text === 'object' ? 'an object' : `a ${typeof text}`}` });
      continue;
    }
    try {
      parseIcuMessage(text);
    } catch (error) {
      invalidTexts.push({ key, path, problem: `invalid ICU message syntax (${error instanceof Error ? error.message : String(error)})` });
    }
  }
  return { record: { path, state: 'valid', keyCount: Object.keys(value).length }, keys: value, invalidTexts };
}

interface SourceScan {
  reactIntlFiles: number;
  /** Literal ids in the namespace. */
  literalIds: F003MessageIdSite[];
  otherNamespaceIds: number;
  computedIds: F003SourceSite[];
  hardCodedText: F003HardCodedText[];
}

function scanSource(source: FrontendSource, namespace: string | undefined): SourceScan {
  const scan: SourceScan = { reactIntlFiles: 0, literalIds: [], otherNamespaceIds: 0, computedIds: [], hardCodedText: [] };
  for (const file of source.files) {
    const sourceFile = file.sourceFile;
    let importsReactIntl = false;
    const at = (node: ts.Node, text: string) => ({ path: file.path, line: lineOf(sourceFile, node.getStart(sourceFile)), text });
    const messageId = (node: ts.Node, id: ts.Expression | undefined, hasDefaultMessage: boolean): void => {
      // `cond ? 'ns.yes' : 'ns.no'` names two literal ids; a null or undefined branch names none.
      if (id && ts.isParenthesizedExpression(id)) return messageId(node, id.expression, hasDefaultMessage);
      if (id && (id.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(id) && id.text === 'undefined'))) return;
      if (id && ts.isConditionalExpression(id)) {
        messageId(node, id.whenTrue, hasDefaultMessage);
        return messageId(node, id.whenFalse, hasDefaultMessage);
      }
      const literal = id && literalText(id);
      if (literal === undefined) {
        // A template whose fixed start names another namespace belongs to that namespace's translations.
        const head = id && ts.isTemplateExpression(id) ? id.head.text : '';
        const ownOrUnknown = !namespace || !/^[\w-]+\./.test(head) || head.startsWith(`${namespace}.`);
        if (ownOrUnknown) scan.computedIds.push(at(id ?? node, id ? oneLine(id.getText(sourceFile)) : oneLine(node.getText(sourceFile))));
      } else if (namespace && literal.startsWith(`${namespace}.`)) {
        scan.literalIds.push({ ...at(id!, literal), hasDefaultMessage });
      } else {
        scan.otherNamespaceIds++;
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'react-intl') importsReactIntl = true;
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
        const [first] = node.arguments;
        if (ts.isIdentifier(node.expression) && name === 'require' && first && ts.isStringLiteral(first) && first.text === 'react-intl') importsReactIntl = true;
        if (name === 'formatMessage' || (name === 'translate' && ts.isIdentifier(node.expression))) {
          if (first && ts.isObjectLiteralExpression(first)) {
            const id = first.properties.find(property => propertyName(property) === 'id');
            messageId(node, id && ts.isPropertyAssignment(id) ? id.initializer : id && ts.isShorthandPropertyAssignment(id) ? id.name : undefined,
              first.properties.some(property => propertyName(property) === 'defaultMessage'));
          } else if (name === 'translate' && first && literalText(first) !== undefined) {
            messageId(node, first, false);
          } else if (name === 'formatMessage') {
            messageId(node, undefined, false);
          }
        }
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sourceFile);
        const attributes = node.attributes.properties;
        if (MESSAGE_ELEMENTS.has(tag)) {
          const id = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'id');
          messageId(node, id && ts.isJsxAttribute(id) ? attributeExpression(id) : undefined,
            attributes.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'defaultMessage'));
        }
        for (const attribute of attributes) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const name = attribute.name.getText(sourceFile);
          const value = attributeExpression(attribute);
          const text = value && literalText(value);
          if (TEXT_ATTRIBUTES.has(name) && text !== undefined && isWords(text)) {
            scan.hardCodedText.push({ ...at(value!, oneLine(text)), kind: name as F003HardCodedText['kind'] });
          }
        }
      }
      if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces && isWords(node.text)) {
        const leading = node.text.length - node.text.trimStart().length;
        scan.hardCodedText.push({ path: file.path, line: lineOf(sourceFile, node.pos + leading), text: oneLine(node.text), kind: 'jsx-text' });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (importsReactIntl) scan.reactIntlFiles++;
  }
  return scan;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  return property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
}

// The expression of `id="x"`, `id={'x'}` or `id={name}`.
function attributeExpression(attribute: ts.JsxAttribute): ts.Expression | undefined {
  const initializer = attribute.initializer;
  if (!initializer) return undefined;
  return ts.isJsxExpression(initializer) ? initializer.expression : ts.isStringLiteral(initializer) ? initializer : undefined;
}

function literalText(node: ts.Expression): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

// Two or more words: "Lost items search" is text for users, "ID:" or "—" is not worth a reviewer's time.
function isWords(text: string): boolean {
  // JSX text keeps HTML entities such as &nbsp; and &apos; as written; they are not words.
  return text.replace(/&(?:#x?[0-9a-f]+|[a-z]+\d*);/gi, ' ').trim().split(/\s+/).filter(word => /\p{L}/u.test(word)).length >= 2;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

export function renderF003HumanDetails(analysis: F003Analysis, agentReview?: CriterionAgentReviewResult): string {
  if (analysis.status === EvaluationStatus.NOT_APPLICABLE) {
    return [
      'What the tool found:',
      `  - Production source: ${count(analysis.productionFileCount, 'file')} in src/, lib/ and the repository root; none renders an HTML element or text`,
      '  - Translations: no translations/ directory'
    ].join('\n');
  }
  const file = analysis.translationFile;
  const lines = [
    'What the tool found:',
    `  - Uses react-intl: ${analysis.reactIntl.declaration ?? 'not in dependencies or peerDependencies'}; imported in ${count(analysis.reactIntl.importingFileCount, 'production file')}`,
    `  - Translation file: ${!file ? `none (${analysis.namespaceBasis === 'ambiguous'
      ? `several namespaces: ${analysis.translationDirectories.map(reportText).join(', ')}` : 'no translations/<namespace>/ directory'})`
      : file.state === 'valid' ? `${reportPath(file.path)}, ${count(file.keyCount ?? 0, 'text')}`
        : file.state === 'missing' ? `${reportPath(file.path)} does not exist`
          : file.state === 'unreadable' ? `${reportPath(file.path)} could not be read` : `${reportPath(file.path)} ${file.problem}`}`,
    `  - Message ids: ${count(analysis.literalIdCount, 'literal id')}${analysis.namespace ? ` in ${reportText(analysis.namespace)}` : ''} checked, ${unique(analysis.missingIds.map(site => site.text)).length} missing; `
      + `${count(analysis.otherNamespaceIdCount, 'id')} of other namespaces and ${count(analysis.computedIds.length, 'computed id')} not checked`,
    `  - Hard-coded text: ${analysis.hardCodedText.length ? count(analysis.hardCodedText.length, 'candidate') : 'none found'}`,
    `  - English texts: ${analysis.invalidTexts.length ? `${count(analysis.invalidTexts.length, 'invalid text')}` : file?.state === 'valid' ? 'all valid' : 'not checked'}`,
    `  - Production source: ${count(analysis.productionFileCount, 'file')} in src/, lib/ and the repository root (tests, stories and examples excluded); `
      + `${count(analysis.uiFileCount, 'file')} ${analysis.uiFileCount === 1 ? 'renders' : 'render'} HTML elements or text`,
    ...(agentReview ? [`  - Agent review scope: ${reportText(analysis.agentBrowseScope)}`] : [])
  ];
  const siteRows = (heading: string, sites: Array<F003SourceSite & { note?: string }>): void => {
    if (!sites.length) return;
    lines.push(heading, ...sites.slice(0, SHOWN_SITES).map(item => `  - ${reportPath(item.path)}:${item.line} — ${reportText(item.note ?? item.text)}`),
      ...overflowLine(sites.length, SHOWN_SITES, '  '));
  };
  siteRows('Missing from en.json:', analysis.missingIds.map(item => ({ ...item, note: `${item.text}${item.hasDefaultMessage ? ' (has defaultMessage)' : ''}` })));
  siteRows('Hard-coded text candidates:', analysis.hardCodedText.map(item => ({ ...item, note: hardCodedLabel(item) })));
  siteRows('Computed message ids (not checked):', analysis.computedIds);
  if (analysis.invalidTexts.length) {
    lines.push('Invalid texts in en.json:', ...analysis.invalidTexts.slice(0, SHOWN_SITES).map(item =>
      `  - ${reportPath(item.path)} — ${reportText(item.key)}: ${reportText(item.problem)}`), ...overflowLine(analysis.invalidTexts.length, SHOWN_SITES, '  '));
  }
  const unread = [...analysis.sourceDiagnostics.map(diagnostic => `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`),
    ...analysis.parseErrorFiles.map(path => `  - ${reportPath(path)} — does not parse cleanly`)];
  if (unread.length) lines.push('What the tool could not read:', ...unread);
  if (analysis.status === EvaluationStatus.FAIL) {
    lines.push('What to do:', '  - Declare react-intl in dependencies or peerDependencies, render user-visible text with FormattedMessage or formatMessage, '
      + 'and keep the English texts in translations/<namespace>/en.json, a JSON object of non-empty strings.');
  }
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}
