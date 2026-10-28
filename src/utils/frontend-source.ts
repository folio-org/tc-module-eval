import * as ts from 'typescript';
import { EvaluationRun } from '../types';
import { CommittedSourceDiagnostic, readCommittedSource } from './committed-source';

const SOURCE_EXTENSION = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/;
// Tests, stories, examples and mocks are not what the package ships to its users.
const NOT_PRODUCTION = /(?:^|\/)(?:tests?|__tests__|__mocks?__|stories|\.storybook|examples|fixtures)\/|\.(?:test|spec|stories|story)\.[cm]?[jt]sx?$/;
const ENGLISH_TRANSLATION = /^translations\/([^/]+)\/en\.json$/;

/** Production code of a UI package: source files under `src/` and `lib/`, and at the repository root. */
export function isProductionSourcePath(path: string): boolean {
  return SOURCE_EXTENSION.test(path) && (/^(?:src|lib)\//.test(path) || !path.includes('/')) && !NOT_PRODUCTION.test(path);
}

export interface FrontendSourceFile {
  path: string;
  content: string;
  /** Parsed with JSX enabled for JavaScript; comments are not part of the tree. */
  sourceFile: ts.SourceFile;
  /** The file does not parse cleanly, so what was read from it may be incomplete. */
  parseError: boolean;
}

/** What F criteria read from the committed tree: production code, package.json and the English translation files. */
export interface FrontendSource {
  revision: string;
  files: FrontendSourceFile[];
  /** The committed package.json text, if any. */
  packageJson?: string;
  /** Every committed path under `translations/`, read or not. */
  translationPaths: string[];
  /** The text of each committed `translations/<namespace>/en.json`, by namespace. */
  englishTranslations: Record<string, string>;
  /** False when a candidate file could not be read (too large, binary, over a limit) or Git failed. */
  complete: boolean;
  diagnostics: CommittedSourceDiagnostic[];
}

/** The run's one read of the committed frontend source, shared by the F criteria. */
export function getFrontendSource(run: EvaluationRun, repoPath: string): Promise<FrontendSource> {
  return run.getOrCreateArtifact('frontendSource', () => readFrontendSource(repoPath));
}

export async function readFrontendSource(repoPath: string): Promise<FrontendSource> {
  const translationPaths: string[] = [];
  // A read of its own, so a large source tree cannot crowd out package.json and en.json, which sort after src/.
  const manifests = await readCommittedSource(repoPath, {
    // Every committed path passes through here, so the translations directory is listed without reading it.
    include: path => {
      if (path.startsWith('translations/')) translationPaths.push(path);
      return path === 'package.json' || ENGLISH_TRANSLATION.test(path);
    }
  });
  const source = await readCommittedSource(repoPath, { include: isProductionSourcePath, maxFiles: 2_000 });
  const englishTranslations: Record<string, string> = {};
  let packageJson: string | undefined;
  for (const file of manifests.files) {
    const namespace = ENGLISH_TRANSLATION.exec(file.path)?.[1];
    if (file.path === 'package.json') packageJson = file.content;
    else if (namespace) englishTranslations[namespace] = file.content;
  }
  return {
    revision: source.revision,
    files: source.files.map(file => parseSourceFile(file.path, file.content)),
    packageJson,
    translationPaths: translationPaths.sort(),
    englishTranslations,
    complete: manifests.complete && source.complete,
    diagnostics: [...manifests.diagnostics, ...source.diagnostics]
  };
}

function parseSourceFile(path: string, content: string): FrontendSourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  // parseDiagnostics is internal, but it is the only record of syntax the parser had to skip.
  const parseError = ((sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length ?? 0) > 0;
  return { path, content, sourceFile, parseError };
}

/** Whether the package renders a user interface of its own, and the evidence for it. */
export interface FrontendUiPresence {
  rendersUi: boolean;
  /** Production files whose JSX renders an HTML element, text, or a literal text prop (not only components passed to it). */
  uiFiles: string[];
  /** The package has a committed `translations/` directory. */
  hasTranslations: boolean;
}

export const RENDERS_NO_UI = 'This package renders no user interface.';

/**
 * F003, F004, F006 and F007 do not apply to a package that renders no user interface (Q10): its production code
 * renders no HTML element, no JSX text and no literal text prop (`label="Save"`), and it has no `translations/`
 * directory. JSX that only renders components it is given, such as stripes-connect's `<Wrapped {...props} />`, does
 * not count. When the scan is incomplete the
 * package is treated as rendering UI, so a criterion reports the incomplete scan instead.
 */
export function frontendUiPresence(source: FrontendSource): FrontendUiPresence {
  const uiFiles = source.files.filter(file => rendersOwnMarkup(file.sourceFile)).map(file => file.path);
  const hasTranslations = source.translationPaths.length > 0;
  return { rendersUi: !source.complete || hasTranslations || uiFiles.length > 0, uiFiles, hasTranslations };
}

function rendersOwnMarkup(sourceFile: ts.SourceFile): boolean {
  const visit = (node: ts.Node): boolean => {
    if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) return true;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && (isIntrinsicElement(node.tagName) || node.attributes.properties.some(isLiteralTextProp))) return true;
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(sourceFile);
}

// <div>, <svg:rect> and <my-element> are HTML or SVG elements; <Wrapped> and <Context.Consumer> are components.
function isIntrinsicElement(tagName: ts.JsxTagNameExpression): boolean {
  return (ts.isIdentifier(tagName) && /^[a-z]/.test(tagName.text)) || ts.isJsxNamespacedName(tagName);
}

export const TEXT_ATTRIBUTES = new Set(['aria-label', 'label', 'placeholder', 'title']);

// `label="Save"` or `title={'Save'}`: text the element shows, though it is a component.
function isLiteralTextProp(attribute: ts.JsxAttributeLike): boolean {
  if (!ts.isJsxAttribute(attribute) || !TEXT_ATTRIBUTES.has(attribute.name.getText()) || !attribute.initializer) return false;
  const value = ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer;
  return !!value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && /\p{L}/u.test(value.text);
}

/** 1-based line of a node's first character. */
export function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}
