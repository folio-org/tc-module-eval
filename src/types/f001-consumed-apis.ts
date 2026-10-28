import type { EvaluationStatus } from './index';
import type { FrontendChecklist } from './frontend-checklist';
import type { CommittedSourceDiagnostic } from '../utils/committed-source';
import type { S008DeclarationDiagnostic } from './s008-interface-acceptance';

/** One handler of a provided interface, as in its module descriptor. */
export interface F001Handler {
  methods: string[];
  pathPattern: string;
}

/**
 * `config/f001-handler-index.json`: the handlers of every interface provided in the S008 official catalog's platform
 * release, built by `src/tools/build-f001-handler-index.ts` from the same descriptors (matched by descriptor hash).
 */
export interface F001HandlerIndex {
  schemaVersion: '1.0';
  baseline: {
    platformRepository: string;
    platformCommit: string;
    descriptorVersion: string;
  };
  /** The S008 catalog the index was built from, and its digest when built. */
  s008Catalog: { path: string; digest: string };
  providers: Array<{
    moduleId: string;
    descriptorHash: string;
    /** Interfaces with at least one handler; system interfaces are left out. */
    interfaces: Array<{ id: string; version: string; interfaceType?: string; handlers: F001Handler[] }>;
  }>;
}

/** How a request site names its path. */
export type UiRequestSiteKind = 'stripes-connect' | 'ky' | 'fetch';

/**
 * A place in production code that sends a request to the FOLIO backend: a stripes-connect manifest resource of type
 * `okapi`, a `ky` call on `useOkapiKy()`, or `fetch` on the Okapi URL. `requestPath` is the path without query string
 * and leading slash, where every segment the code fills in at run time is `{}`. Without `requestPath`, the path could
 * not be read and `unresolved` says why.
 */
export interface UiRequestSite {
  path: string;
  line: number;
  kind: UiRequestSiteKind;
  /** The HTTP method when the call names one (`ky.post`, a manifest's `PUT: { path }`). */
  method?: string;
  /** The path expression as written, on one line. */
  expression: string;
  requestPath?: string;
  /** The code appends something unknown to the last segment, such as a query string (`${ENDPOINT}${query}`). */
  openEnd?: boolean;
  unresolved?: string;
}

/** The `uiRequestSites` run artifact: every request site in production code, for F001 now and S010 later. */
export interface UiRequestSites {
  sites: UiRequestSite[];
  /** False when production source could not all be read or parsed. */
  complete: boolean;
}

/**
 * What a request site maps to: an interface, several equally specific ones (`ambiguous`), none (`not-in-index`),
 * or a path whose run-time segments could match several handlers' fixed segments (`dynamic`).
 */
export type F001SiteOutcome = 'interface' | 'ambiguous' | 'not-in-index' | 'dynamic' | 'unresolved';

export interface F001MappedSite extends UiRequestSite {
  outcome: F001SiteOutcome;
  /** The interface for `interface`; the candidates for `ambiguous` and `dynamic`. */
  interfaces: string[];
  /** The handler pattern that matched, for `interface`. */
  pathPattern?: string;
}

export interface F001InterfaceUse {
  id: string;
  sites: F001MappedSite[];
}

export interface F001Analysis {
  criterionId: 'F001';
  status: EvaluationStatus;
  summary: string;
  index: {
    loaded: boolean;
    problem?: string;
    descriptorVersion?: string;
    platformCommit?: string;
    interfaceCount?: number;
  };
  declared: { required: string[]; optional: string[] };
  declarationDiagnostics: S008DeclarationDiagnostic[];
  productionFileCount: number;
  /** Requests counted: every request site except those to Okapi's own `_/` endpoints. */
  siteCount: number;
  gatewaySiteCount: number;
  undeclared: F001InterfaceUse[];
  declaredAndUsed: F001InterfaceUse[];
  /** Declared interfaces no request site maps to; information only. */
  declaredNotSeen: string[];
  unresolvedSites: F001MappedSite[];
  notInIndexSites: F001MappedSite[];
  /** Imports of `use…` hooks from @folio packages other than stripes itself, which may send requests of their own. */
  libraryHooks: Array<{ path: string; line: number; name: string; from: string }>;
  parseErrorFiles: string[];
  sourceDiagnostics: CommittedSourceDiagnostic[];
  agentBrowseScope: string;
  agentReviewUnavailableReason?: string;
  checklist: FrontendChecklist;
}
