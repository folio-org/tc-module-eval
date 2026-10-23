import type { EvaluationStatus } from './index';
import type { FrontendChecklist } from './frontend-checklist';
import type { CommittedSourceDiagnostic } from '../utils/committed-source';

/** A place in production code: a message id, a text, or an expression. */
export interface F003SourceSite {
  path: string;
  line: number;
  /** The message id, the hard-coded text, or the source of a computed id expression. */
  text: string;
}

export interface F003MessageIdSite extends F003SourceSite {
  /** The call or element supplies English fallback text (`defaultMessage`). */
  hasDefaultMessage: boolean;
}

export interface F003HardCodedText extends F003SourceSite {
  /** Where the text is: JSX text, or the attribute it is the value of. */
  kind: 'jsx-text' | 'aria-label' | 'label' | 'placeholder' | 'title';
}

/** A value in en.json that react-intl cannot use: not a non-empty string, or not valid ICU message syntax. */
export interface F003InvalidText {
  key: string;
  path: string;
  problem: string;
}

/**
 * How the translation namespace was found: the only directory under translations/, the directory the Stripes
 * naming rule gives (`ui-` plus the package name, or the bare name for `stripes-*`), or none.
 */
export type F003NamespaceBasis = 'single-directory' | 'stripes-rule' | 'ambiguous' | 'none';

export interface F003Analysis {
  criterionId: 'F003';
  status: EvaluationStatus;
  summary: string;
  rendersUi: boolean;
  /** Production files whose JSX renders HTML elements or text (the first few). */
  uiFiles: string[];
  uiFileCount: number;
  productionFileCount: number;
  reactIntl: {
    /** e.g. `dependencies ^7.1.5`; absent when declared in neither dependencies nor peerDependencies. */
    declaration?: string;
    importingFileCount: number;
  };
  namespace?: string;
  namespaceBasis: F003NamespaceBasis;
  translationDirectories: string[];
  translationFile?: {
    path: string;
    /** `missing`: no committed file; `unreadable`: committed but not read; `invalid`: not JSON or not an object. */
    state: 'valid' | 'missing' | 'unreadable' | 'invalid';
    keyCount?: number;
    problem?: string;
  };
  literalIdCount: number;
  otherNamespaceIdCount: number;
  missingIds: F003MessageIdSite[];
  hardCodedText: F003HardCodedText[];
  /** Message ids built at run time in this namespace, or of unknown namespace; not checked. */
  computedIds: F003SourceSite[];
  invalidTexts: F003InvalidText[];
  /** Production files that did not parse cleanly. */
  parseErrorFiles: string[];
  sourceDiagnostics: CommittedSourceDiagnostic[];
  /** The paths an agent review may browse, as shown to the agent and the reader. */
  agentBrowseScope: string;
  agentReviewUnavailableReason?: string;
  checklist: FrontendChecklist;
}
