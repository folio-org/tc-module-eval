import type { EvaluationStatus, ModuleKindResult } from './index';
import type { FrontendChecklist } from './frontend-checklist';
import type { CommittedSourceDiagnostic, CommittedSourceSnapshot } from '../utils/committed-source';

/**
 * What the B criteria evaluate the repository as:
 * - `backend-module`: classifyModuleKind found a module descriptor;
 * - `edge-module`: an `edge-` artifactId with an `edge-common*` dependency, with or without a descriptor;
 * - `library`: an allowlisted shared library without a descriptor;
 * - `ambiguous`: none of these, so a reviewer must decide whether it needs a descriptor.
 */
export type BackendRepositoryKind = 'backend-module' | 'edge-module' | 'library' | 'ambiguous';

/** Detected from main-class and source evidence, never from dependencies alone. */
export type BackendFramework = 'rmb' | 'spring' | 'vertx' | 'grails' | 'edge' | 'library' | 'unknown';

/** One build placeholder in the descriptor template, such as `${artifactId}` or `@version@`. */
export interface BackendPlaceholder {
  /** As written, e.g. `${artifactId}`. */
  text: string;
  name: string;
  /** The value from the build properties; absent when they do not define it. */
  value?: string;
  /** Where the value came from, e.g. `pom.xml <artifactId>` or `service/gradle.properties`. */
  source?: string;
  /** Written outside a JSON string, e.g. as a number, so the template's JSON depends on the build. */
  outsideString: boolean;
  /** JSON pointers of the string values that still contain it, for an unresolved placeholder. */
  pointers: string[];
}

/** The committed descriptor template, parsed after replacing the build placeholders the build properties define. */
export interface BackendDescriptorTemplate {
  path: string;
  /**
   * The parsed template; absent when it could not be read or is not valid JSON. Strings still containing an
   * unresolved placeholder (listed with their JSON pointers in `placeholders`) do not hold the build's value, so a
   * criterion must check those pointers before judging such a string.
   */
  descriptor?: unknown;
  /** The template text with resolved placeholders replaced; unresolved ones in strings are left as written. */
  content?: string;
  parseError?: string;
  /** Why the template could not be read (too large, binary, a link). */
  readError?: string;
  placeholders: BackendPlaceholder[];
}

/** Shared backend evidence for the B criteria, read once per run from committed blobs. */
export interface BackendEvidence {
  kind: BackendRepositoryKind;
  /** Why the repository has this kind. */
  kindEvidence: string[];
  moduleKind: ModuleKindResult;
  /** The root pom.xml's own artifactId. */
  artifactId?: string;
  /** Every committed descriptor candidate (`ModuleDescriptor*.json` where classifyModuleKind looks for one). */
  templateCandidates: string[];
  /** The template, when there is exactly one candidate. */
  template?: BackendDescriptorTemplate;
  framework: { name: BackendFramework; evidence: string[] };
  /**
   * Positive storage evidence only: a framework dependency alone is not storage. "None found" is conclusive only when
   * `snapshot.complete` is true.
   */
  storage: { present: boolean; evidence: string[] };
  /**
   * The committed files the include filter selects, for the B criteria that read sources. `listedPaths` lists the
   * reference-data folders (`ref-data/`, `reference-data/`) without reading them. Git submodules are skipped.
   */
  snapshot: CommittedSourceSnapshot;
}

/**
 * What B001 decided from:
 * - `template-valid`, `template-invalid-json`, `template-schema-errors`: the one template, checked against the Okapi schema;
 * - `template-placeholders-outside-strings`, `template-unreadable`, `several-templates`: a template a reviewer must check;
 * - `edge-without-template`, `ambiguous-without-template`, `library`: no template, by repository kind.
 */
export type B001Basis =
  | 'template-valid'
  | 'template-invalid-json'
  | 'template-schema-errors'
  | 'template-placeholders-outside-strings'
  | 'template-unreadable'
  | 'several-templates'
  | 'edge-without-template'
  | 'ambiguous-without-template'
  | 'library';

export interface B001Analysis {
  criterionId: 'B001';
  status: EvaluationStatus;
  summary: string;
  basis: B001Basis;
  kind: BackendRepositoryKind;
  kindEvidence: string[];
  templateCandidates: string[];
  template?: { path: string; placeholders: BackendPlaceholder[] };
  schemaBaseline?: string;
  /** Schema problems, described per descriptor field. */
  schemaProblems: string[];
  parseError?: string;
  /** S002's check of the descriptor the build generated, when S002 ran the build in this evaluation. */
  generatedDescriptor?: { path: string; valid: boolean; problemCount: number };
  framework: BackendEvidence['framework'];
  storage: BackendEvidence['storage'];
  /** Committed-source problems that may hide a template or build file. */
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
}

/** One operation an API spec documents: a method on a path. */
export interface BackendApiOperation {
  /** Upper case, such as `GET`. */
  method: string;
  /**
   * The full path, with parameters such as `{id}` as written: prefixed by its parent resources in RAML, by `basePath`
   * in Swagger 2.0, and by the path of a server URL in OpenAPI 3 (one operation per distinct server path). RAML
   * `baseUri` is not applied: RMB modules set it to a placeholder such as `http://github.com/org/folio/mod-users`.
   */
  path: string;
  /** The file that defines the operation, which is not the spec's root file when a `$ref` or `!include` leads there. */
  file: string;
  /**
   * The resource as the spec writes it, which code generators name interfaces after: the RAML top-level resource the
   * operation is under (`/loan-storage`), or the OpenAPI path without a server path or `basePath`.
   */
  resource: string;
  /** OpenAPI only. */
  tags?: string[];
  /** OpenAPI only. */
  operationId?: string;
}

/**
 * Part of a spec the tool could not read, so it may document more operations than `operations` lists: the methods of
 * `apiPath`, or of any path when `apiPath` is absent (an unreadable root file or `paths` object).
 */
export interface BackendApiSpecGap {
  file: string;
  apiPath?: string;
  /** The `$ref` or `!include` target that could not be followed. */
  reference?: string;
  message: string;
}

export interface BackendApiSpec {
  /** The root file: a JSON or YAML file with a top-level `openapi` or `swagger` key, or a RAML file without a fragment type. */
  file: string;
  /** `openapi` covers Swagger 2.0 too. */
  format: 'openapi' | 'raml';
  /** The `openapi` or `swagger` value, or the RAML version; absent when the file could not be parsed. */
  version?: string;
  operations: BackendApiOperation[];
  gaps: BackendApiSpecGap[];
}

/**
 * The API specs in the committed source backendEvidence reads (run artifact `backendApiSpecs`). OpenAPI `$ref`s are
 * followed inside that snapshot as far as the paths and their operations; schemas and parameters are not resolved.
 * RAML resource types are read from included files, or for FOLIO's shared `raml-util` submodule, which is not
 * committed, from the methods its resource types define.
 */
export interface BackendApiSpecs {
  specs: BackendApiSpec[];
  /** Spec sources the build names that the tool could not read: git submodules, which the committed source skips. */
  unreadSources: BackendApiSpecGap[];
}

/**
 * Where B006 found an endpoint:
 * - `openapi`: in an OpenAPI or Swagger spec;
 * - `raml`: only in a RAML spec;
 * - `library`: not in the repository's specs, and served by a library whose own spec documents it;
 * - `partial`: documented only for fixed values of a path parameter, such as `/erm/jobs/packageImport` for
 *   `/erm/jobs/{type}`;
 * - `unconfirmed`: not found, but part of a spec, or the source, could not be read;
 * - `undocumented`: in no spec.
 */
export type B006Documentation = 'openapi' | 'raml' | 'library' | 'partial' | 'unconfirmed' | 'undocumented';

/** A method on a path the module serves: from a descriptor handler, or for an edge module a router route. */
export interface B006Endpoint {
  method: string;
  path: string;
  /** The provided interface, for a descriptor handler. */
  interfaceId?: string;
  /** The source file and line, for a router route. */
  file?: string;
  line?: number;
  documentation: B006Documentation;
  /** The spec files that document it (`openapi`, `raml`, `partial`), or whose gaps may (`unconfirmed`). */
  specFiles: string[];
  /** The library that serves it (`library`). */
  library?: string;
}

/**
 * What B006 decided from:
 * - `library`, `no-descriptor`: the repository kind, or a descriptor template B001 could not read;
 * - `no-endpoints`: a module whose descriptor provides only system interfaces;
 * - `no-routes`: an edge module whose router routes were not found;
 * - `endpoints-checked`: each endpoint looked up in the specs.
 */
export type B006Basis = 'library' | 'no-descriptor' | 'no-endpoints' | 'no-routes' | 'endpoints-checked';

export interface B006Analysis {
  criterionId: 'B006';
  status: EvaluationStatus;
  summary: string;
  basis: B006Basis;
  kind: BackendRepositoryKind;
  framework: BackendEvidence['framework'];
  existingModule: boolean;
  /** RAML counts as documentation only for an RMB module in an existing-module evaluation. */
  ramlAccepted: boolean;
  /** Where the endpoints come from: the descriptor template, or an edge module's router routes. */
  endpointSource?: string;
  endpoints: B006Endpoint[];
  specs: Array<Pick<BackendApiSpec, 'file' | 'format' | 'version'> & { operationCount: number }>;
  gaps: BackendApiSpecGap[];
  /** Router route calls whose path is not a literal or a constant in the same file (edge modules). */
  unreadRoutes: Array<{ file: string; line: number }>;
  /** All such calls; `unreadRoutes` lists the first 100. */
  unreadRouteCount: number;
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
}

/**
 * How B003 found an endpoint's implementation:
 * - `interface`: in an API spec, and a committed class implements the interface the build generates for it;
 * - `route`: a route the source registers serves it;
 * - `no-implementing-class`: in an API spec, but no committed class implements the interface the build generates;
 * - `wildcard`: a handler path with Okapi's `*`, whose paths the tool cannot list;
 * - `library`: served by a library;
 * - `partial`: found only for fixed values of a path parameter, such as `/erm/jobs/packageImport` for `/erm/jobs/{type}`;
 * - `unconfirmed`: not found, but part of a spec, a route or the source could not be read;
 * - `not-found`: no implementation found; `specFiles` lists the specs that have it.
 */
export type B003Implementation = 'interface' | 'route' | 'no-implementing-class' | 'wildcard' | 'library' | 'partial' | 'unconfirmed' | 'not-found';

/** A provided endpoint: a descriptor handler's method and path, or for an edge module also an operation of its API spec. */
export interface B003Endpoint {
  method: string;
  path: string;
  /** The provided interface, for a descriptor handler. */
  interfaceId?: string;
  implementation: B003Implementation;
  /** The spec files that have the endpoint, have it for fixed values (`partial`), or whose gaps may (`unconfirmed`). */
  specFiles: string[];
  /** The interfaces the build generates for it (`interface`, `no-implementing-class`). */
  generatedInterfaces?: string[];
  /** The committed classes that implement a generated interface (`interface`), or the routes that serve it (`route`, `partial`). */
  implementedBy?: Array<{ file: string; line: number }>;
  /** The library that serves it (`library`). */
  library?: string;
}

/**
 * What B003 decided from:
 * - `library`, `no-descriptor`: the repository kind, or a descriptor template B001 could not read;
 * - `no-endpoints`: a module whose descriptor provides only system interfaces, or an edge module that declares no endpoints;
 * - `endpoints-checked`: each endpoint looked up in the specs and routes.
 */
export type B003Basis = 'library' | 'no-descriptor' | 'no-endpoints' | 'endpoints-checked';

export interface B003Analysis {
  criterionId: 'B003';
  status: EvaluationStatus;
  summary: string;
  basis: B003Basis;
  kind: BackendRepositoryKind;
  framework: BackendEvidence['framework'];
  /** Where the endpoints come from. */
  endpointSource?: string;
  /** How the tool finds an endpoint's implementation for this framework. */
  implementationSource?: string;
  endpoints: B003Endpoint[];
  /** Routes the source registers (Vert.x router, RouteRegistration, Spring mapping annotations, Grails URL mappings). */
  routeCount: number;
  /** Route registrations whose path or method the tool could not read: the first 100 of `unreadRouteCount`. */
  unreadRoutes: Array<{ file: string; line: number }>;
  unreadRouteCount: number;
  gaps: BackendApiSpecGap[];
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
}
