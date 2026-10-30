import type { EvaluationStatus } from './index';
import type { FrontendChecklist } from './frontend-checklist';
import type { CommittedSourceDiagnostic } from '../utils/committed-source';

/** A read of a navigator property that identifies the browser (`navigator.userAgent`), not a test that it exists. */
export interface F007UserAgentRead {
  path: string;
  line: number;
  property: string;
}

/** A vendor-prefixed API, or an API Chrome has removed, used in production code. */
export interface F007BrowserApi {
  path: string;
  line: number;
  kind: 'vendor-prefixed' | 'removed';
  name: string;
  /** What the pinned list says about it: the prefix's browsers, or the removed API and the Chrome version. */
  note: string;
  /**
   * The use is a test that the API exists (`if (navigator.msSaveBlob)`, `typeof`, an optional call), or sits where
   * such a test, or `'msSaveBlob' in navigator`, is the whole condition: an if branch, a `?:` branch or `test && use`.
   */
  featureDetected: boolean;
}

/** A browserslist configuration in the package, which overrides the targets of the platform build. */
export interface F007BrowserslistOverride {
  path: string;
  line?: number;
  queries: string;
}

/** A polyfill the package ships: a production dependency, or an import in production code. */
export interface F007Polyfill {
  path: string;
  line: number;
  name: string;
  via: 'dependency' | 'import';
}

export interface F007Analysis {
  criterionId: 'F007';
  status: EvaluationStatus;
  summary: string;
  rendersUi: boolean;
  uiFileCount: number;
  productionFileCount: number;
  app: {
    route?: string;
    home?: string;
    settings: boolean;
  };
  userAgentReads: F007UserAgentRead[];
  browserApis: F007BrowserApi[];
  browserslist: F007BrowserslistOverride[];
  polyfills: F007Polyfill[];
  /** The pinned list in `config/f007-browser-apis.json` the scan used. */
  apiList: {
    loaded: boolean;
    retrievedAt?: string;
    removedApiCount: number;
    problem?: string;
  };
  parseErrorFiles: string[];
  sourceDiagnostics: CommittedSourceDiagnostic[];
  agentReviewUnavailableReason?: string;
  checklist: FrontendChecklist;
}
