import type { EvaluationStatus } from './index';
import type { FrontendChecklist } from './frontend-checklist';
import type { CommittedSourceDiagnostic } from '../utils/committed-source';

export interface F006SourceSite {
  path: string;
  line: number;
}

/** What a group of Stripes components is for, which decides the checklist item it is a starting point of. */
export type F006ComponentGroup = 'layout' | 'search-and-filter' | 'actions-and-menus' | 'confirmation' | 'controls' | 'settings';

/** How often production code renders one Stripes component, and in how many files. */
export interface F006ComponentUse {
  name: string;
  group: F006ComponentGroup;
  uses: number;
  files: number;
}

/** The first line of a file that renders components of a group, with the components it renders. */
export interface F006ComponentSite extends F006SourceSite {
  group: F006ComponentGroup;
  names: string[];
}

/**
 * The form's `navigationCheck` option: `true` asks before discarding unsaved changes; `false` and `not-set` (the
 * stripes-final-form and stripes-form default is false) do not; `expression` is a value the tool cannot read.
 */
export type F006NavigationCheck = 'true' | 'false' | 'not-set' | 'expression';

export interface F006Form extends F006SourceSite {
  builder: 'stripesFinalForm' | 'stripesForm';
  navigationCheck: F006NavigationCheck;
}

/** An HTML control rendered directly, where a Stripes component exists for it. */
export interface F006RawControl extends F006SourceSite {
  element: 'button' | 'input' | 'select' | 'textarea';
  stripesComponent: string;
}

/** A hex color in a CSS declaration instead of a Stripes color variable. */
export interface F006HexColor extends F006SourceSite {
  property: string;
  value: string;
}

/** An external URL in production code or en.json; never fetched. */
export interface F006Link {
  path: string;
  line?: number;
  /** The en.json key the URL is in. */
  key?: string;
  url: string;
}

export interface F006SettingsPage extends F006SourceSite {
  route: string;
}

export interface F006Analysis {
  criterionId: 'F006';
  status: EvaluationStatus;
  summary: string;
  rendersUi: boolean;
  uiFileCount: number;
  productionFileCount: number;
  cssFileCount: number;
  packageName?: string;
  /** The package implements the Stripes controls itself, so the HTML controls it renders are not raw controls. */
  implementsStripesControls: boolean;
  app: {
    actsAs: string[];
    route?: string;
    home?: string;
  };
  components: F006ComponentUse[];
  componentSites: F006ComponentSite[];
  forms: F006Form[];
  confirmationModals: F006SourceSite[];
  rawControls: F006RawControl[];
  hexColors: F006HexColor[];
  settingsPages: F006SettingsPage[];
  links: F006Link[];
  /** The pinned UX guidelines the agent review measures against. */
  guidelines: {
    loaded: boolean;
    repository?: string;
    commit?: string;
    committedAt?: string;
    sourceDirectory?: string;
    fileCount: number;
    problem?: string;
  };
  /** The committed `translations/<namespace>/en.json` files, which the agent review may read for wording. */
  englishTranslationFiles: string[];
  parseErrorFiles: string[];
  sourceDiagnostics: CommittedSourceDiagnostic[];
  agentBrowseScope: string;
  agentReviewUnavailableReason?: string;
  checklist: FrontendChecklist;
}
