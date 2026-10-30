import type { EvaluationStatus, ModuleKindResult } from './index';
import type { S007PolicyDiagnostic, S007RuleStrength } from './s007-officially-supported-technologies';
import type { FrontendChecklist } from './frontend-checklist';
import type { CommittedSourceDiagnostic, CommittedSourceSnapshot } from '../utils/committed-source';
import type { F001Analysis, F001SiteOutcome } from './f001-consumed-apis';

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

/**
 * A problem with a provided interface's id or version
 * (https://dev.folio.org/guidelines/naming-conventions/#interfaces):
 * - `dot`, `underscore`: the id has one, where the guide joins words with hyphens;
 * - `version-format`: the version is not major.minor, the first two portions of a semantic version;
 * - `uppercase`: the id has an uppercase letter, which the guide neither allows nor forbids;
 * - `other-characters`: the id has characters other than letters, digits, hyphens, dots and underscores, or an empty word;
 * - `id-placeholder`, `version-placeholder`: it has a build placeholder the build properties do not define;
 * - `id-missing`, `version-missing`: it is absent or not a string.
 */
export type B005Problem =
  | 'dot'
  | 'underscore'
  | 'version-format'
  | 'uppercase'
  | 'other-characters'
  | 'id-placeholder'
  | 'version-placeholder'
  | 'id-missing'
  | 'version-missing';

/** A non-system interface in the descriptor template's `provides`. */
export interface B005Interface {
  /** As read; empty when missing or not a string. */
  id: string;
  version: string;
  /** JSON pointer of the interface in the template. */
  pointer: string;
  problems: B005Problem[];
  /** Unresolved build placeholders in the id or version, as written. */
  placeholders: string[];
  /** Build placeholders in the id or version that the build properties define. */
  resolved: Array<{ field: 'id' | 'version'; text: string; value: string; source: string }>;
  /** The first segments of its handler paths, when none is the id (information only). */
  otherFirstSegments?: string[];
}

/**
 * What B005 decided from:
 * - `library`, `no-descriptor`: the repository kind, or a descriptor template B001 could not read;
 * - `no-interfaces`: a descriptor that provides only system interfaces;
 * - `interfaces-checked`: each interface's id and version, and the routes in the source.
 */
export type B005Basis = 'library' | 'no-descriptor' | 'no-interfaces' | 'interfaces-checked';

export interface B005Analysis {
  criterionId: 'B005';
  status: EvaluationStatus;
  summary: string;
  basis: B005Basis;
  kind: BackendRepositoryKind;
  existingModule: boolean;
  templatePath?: string;
  interfaces: B005Interface[];
  /** The system interfaces left out, by id or, without one, JSON pointer. */
  systemInterfaces: string[];
  /** JSON pointers of a `provides` that is not a list, or of its entries that are not objects. */
  unreadableEntries: string[];
  /** Whether routes were checked against the provided interfaces; an edge module's routes serve clients outside FOLIO. */
  routesChecked: boolean;
  /** Routes the source registers, without `/admin/health` and paths with `*`. */
  routeCount: number;
  /** Routes no provided interface's handlers cover, system interfaces included. */
  unprovidedRoutes: Array<{ method: string; path: string; file: string; line: number }>;
  /** Route registrations whose path or method the tool could not read: the first 100 of `unreadRouteCount`. */
  unreadRoutes: Array<{ file: string; line: number }>;
  unreadRouteCount: number;
  /** Routes not found covered when matching stopped at the tool's limit, so not known to be in no interface. */
  unmatchedRoutes: Array<{ method: string; path: string; file: string; line: number }>;
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
}

/** A handler of a non-system provided interface: its methods, path and JSON pointer, and where it starts in the template. */
export interface B007Endpoint {
  interfaceId: string;
  methods: string[];
  /** `pathPattern`, or Okapi's legacy `path`; empty when the handler has neither. */
  path: string;
  pointer: string;
  line?: number;
  /** Absent when `permissionsRequired` is missing or not a list of strings. */
  permissionsRequired?: string[];
  modulePermissions: string[];
}

/**
 * A permission problem of one endpoint:
 * - `all-required`: it requires a `*.all` permission;
 * - `undefined-required`: it requires a permission no permission set in the template defines;
 * - `no-permission`: its `permissionsRequired` is missing or empty, so it is public;
 * - `all-module-permission`: its `modulePermissions` include a `*.all` permission;
 * - `unreadable`: its `permissionsRequired` or `modulePermissions` is not a list of strings.
 */
export type B007Problem = 'all-required' | 'undefined-required' | 'no-permission' | 'all-module-permission' | 'unreadable';

export interface B007Finding extends B007Endpoint {
  problem: B007Problem;
  /** The permission at fault, for `all-required`, `undefined-required` and `all-module-permission`. */
  permission?: string;
  /** For `no-permission`: true when `permissionsRequired` is missing rather than an empty list. */
  missing?: boolean;
}

/**
 * How a permission name departs from the Permission Naming Guidelines (`<module>.<resource>.<scope>.<action>`):
 * - `prefix`: its first term is not the module name without `mod-`;
 * - `word-format`: a term is not lowercase words joined by hyphens, such as a camelCase term;
 * - `action`: its last term is not a backend action (`get`, `post`, `put`, `patch`, `delete`, `execute`) or `all`.
 */
export type B007NamingProblem = 'prefix' | 'word-format' | 'action';

/**
 * What B007 decided from:
 * - `library`, `no-descriptor`: the repository kind, or a descriptor template B001 could not read;
 * - `no-endpoints`: a descriptor whose provided interfaces, other than system interfaces, have no handlers;
 * - `endpoints-checked`: each handler's permissions checked against the template's permission sets.
 */
export type B007Basis = 'library' | 'no-descriptor' | 'no-endpoints' | 'endpoints-checked';

export interface B007Analysis {
  criterionId: 'B007';
  status: EvaluationStatus;
  summary: string;
  basis: B007Basis;
  kind: BackendRepositoryKind;
  templatePath?: string;
  /** The module name permission names should start with, without `mod-`; absent when the build files do not give one. */
  permissionPrefix?: string;
  /** Where the module name came from. */
  permissionPrefixSource?: string;
  endpoints: B007Endpoint[];
  /** Permission names the template's permission sets define. */
  definedPermissionCount: number;
  /**
   * Whether every permission set name could be read: `permissionSets` and its entries are readable and no
   * `permissionName` has an undefined build placeholder. Otherwise no required permission is reported as undefined.
   */
  definitionsChecked: boolean;
  /** Required or defined permission names with a build placeholder the build properties do not define. */
  placeholderPermissions: string[];
  findings: B007Finding[];
  namingDeviations: Array<{ permission: string; problems: B007NamingProblem[]; line?: number }>;
  /**
   * JSON pointers the tool could not read: a `provides`, `handlers` or `permissionSets` that is not a list, a handler or
   * permission set that is not an object, a `permissionName` that is not a string, or a `permissionsRequired` or
   * `modulePermissions` that is not a list of strings.
   */
  unreadable: Array<{ pointer: string; line?: number }>;
  checklist: FrontendChecklist;
  agentBrowseScope: string;
  agentReviewUnavailableReason?: string;
}

/**
 * What B014 decided from:
 * - `library`: a shared library, which serves no health check;
 * - `ambiguous`: no descriptor and not a known library, so not known to be a module;
 * - `mechanism-found`, `no-mechanism`: whether the committed files show a mechanism that serves GET /admin/health.
 */
export type B014Basis = 'library' | 'ambiguous' | 'mechanism-found' | 'no-mechanism';

/** A mechanism the committed files show serving GET /admin/health. */
export interface B014Mechanism {
  /** RMB's RestVerticle as the main verticle, Spring Boot actuator configured at /admin, or a route in the source. */
  kind: 'rmb' | 'actuator' | 'route';
  path: string;
  line?: number;
  note: string;
}

/** A reason a Spring Boot or Grails application's actuator may not serve health at /admin/health. */
export interface B014ActuatorProblem {
  path?: string;
  line?: number;
  /** The profile or Grails environment the problem applies in; absent for the default configuration. */
  condition?: string;
  note: string;
}

export interface B014ActuatorApplication {
  framework: 'spring' | 'grails';
  /** The folder holding the application's `src/main` or `grails-app`, such as `service/`; empty at the root. */
  root: string;
  /** The `@SpringBootApplication` class or the `grails-app` folder. */
  source: string;
  /** The build file that brings in actuator, directly or through folio-spring-base. */
  dependency?: { path: string; line: number };
  configFiles: string[];
  /** The first 50 of `problemCount`. */
  problems: B014ActuatorProblem[];
  problemCount: number;
}

export interface B014Analysis {
  criterionId: 'B014';
  status: EvaluationStatus;
  summary: string;
  basis: B014Basis;
  kind: BackendRepositoryKind;
  /** Whether the tool called GET /admin/health; false when it decided from the committed files alone. */
  endpointCalled: boolean;
  mechanisms: B014Mechanism[];
  actuator: B014ActuatorApplication[];
  /** Route registrations whose path or method the tool could not read: the first 100 of `unreadRouteCount`. */
  unreadRoutes: Array<{ file: string; line: number }>;
  unreadRouteCount: number;
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
}

/**
 * Infrastructure the B criteria recognise. The ids of listed infrastructure are the ids or aliases of entries in the
 * Officially Supported Technologies policy (`s3` is MinIO's alias, `keycloak` FOLIO Keycloak's).
 */
export type BackendInfrastructureId =
  | 'postgresql'
  | 'kafka'
  | 'opensearch'
  | 'elasticsearch'
  | 's3'
  | 'keycloak'
  | 'redis'
  | 'mongodb'
  | 'rabbitmq'
  | 'activemq'
  | 'cassandra'
  | 'solr'
  | 'hazelcast'
  | 'aws-ssm'
  | 'aws-sqs'
  | 'aws-sns'
  | 'vault'
  | 'mysql'
  | 'mariadb';

/**
 * One piece of evidence that the repository uses an infrastructure:
 * - `dependency`: a direct production dependency on a client library (`detail` is `groupId:artifactId`);
 * - `storage`: backendEvidence's storage evidence, which is PostgreSQL in FOLIO (`detail` is that evidence);
 * - `configuration`: configuration keys or values in `src/main/resources` or `grails-app/conf` (`detail` lists them);
 * - `environment`: environment variable names with the infrastructure's prefix, from the descriptor template's env
 *   lists, `${NAME}` placeholders in configuration and `System.getenv` in sources (`detail` lists them).
 */
export interface BackendInfrastructureSignal {
  kind: 'dependency' | 'storage' | 'configuration' | 'environment';
  /** Repository text, unescaped. */
  detail: string;
  path?: string;
  line?: number;
  /** Why this evidence does not make the infrastructure required, such as a Maven `<optional>` dependency. */
  optional?: string;
}

/**
 * An infrastructure the repository uses:
 * - `required`: a direct production dependency that is not optional, or storage evidence;
 * - `optional`: only optional or selectable evidence (Maven `<optional>` or profile dependencies, edge-common's secure
 *   stores);
 * - `configuration-only`: configuration keys or environment variables, but no client library among the direct
 *   dependencies.
 */
export interface BackendInfrastructure {
  id: BackendInfrastructureId;
  name: string;
  usage: 'required' | 'optional' | 'configuration-only';
  signals: BackendInfrastructureSignal[];
}

/** The infrastructure in backendEvidence's committed source: direct dependencies only, without dependency resolution. */
export interface BackendInfrastructureEvidence {
  items: BackendInfrastructure[];
  /** The Maven and Gradle build files read for dependencies. */
  buildFiles: string[];
  /** Build and configuration files, or dependency declarations, the tool could not read; repository text, unescaped. */
  diagnostics: Array<{ path: string; line?: number; message: string }>;
  /** backendEvidence's material snapshot diagnostics: when present, infrastructure may have been missed. */
  sourceDiagnostics: CommittedSourceDiagnostic[];
}

/** A detected infrastructure and the Officially Supported Technologies entry it is listed under, if any. */
export interface B016Technology {
  id: BackendInfrastructureId;
  name: string;
  usage: BackendInfrastructure['usage'];
  listedAs?: { id: string; displayName: string; sourceStatement: string; strength: S007RuleStrength; section: string };
  signals: BackendInfrastructureSignal[];
}

/**
 * What B016 decided from:
 * - `policy-unreadable`: the committed policy could not be loaded;
 * - `no-build-file`: no `pom.xml` or `build.gradle`, so the dependencies are unknown;
 * - `infrastructure-checked`: the detected infrastructure against the policy's infrastructure sections.
 */
export type B016Basis = 'policy-unreadable' | 'no-build-file' | 'infrastructure-checked';

export interface B016Analysis {
  criterionId: 'B016';
  status: EvaluationStatus;
  summary: string;
  basis: B016Basis;
  kind: BackendRepositoryKind;
  policy?: { exportDate?: string; sections: string[] };
  policyDiagnostics: S007PolicyDiagnostic[];
  technologies: B016Technology[];
  buildFiles: string[];
  diagnostics: BackendInfrastructureEvidence['diagnostics'];
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
}

/** An infrastructure B016 found, and the name README.md uses for it, such as `Postgres` for PostgreSQL. */
export type B012Infrastructure = BackendInfrastructure & { namedAs?: string };

/**
 * What B012 decided from:
 * - `readme-checked`: README.md, read, against the infrastructure found;
 * - `no-readme`: no README.md at the repository root;
 * - `readme-unreadable`: a README.md the tool could not read;
 * - `source-incomplete`: no README.md among the files read, when the committed source was not read completely.
 */
export type B012Basis = 'readme-checked' | 'no-readme' | 'readme-unreadable' | 'source-incomplete';

export interface B012Analysis {
  criterionId: 'B012';
  status: EvaluationStatus;
  summary: string;
  basis: B012Basis;
  kind: BackendRepositoryKind;
  /** The root README.md files read, in any case (`README.MD`). */
  readmePaths: string[];
  /** The root README.md files the tool could not read. */
  unreadableReadmePaths: string[];
  infrastructure: B012Infrastructure[];
  /** Build and configuration files B016's detection could not read, and committed source the tool could not read. */
  diagnostics: Array<{ path?: string; line?: number; message: string }>;
  checklist: FrontendChecklist;
  /** Why agent review was not applied, when it was not. */
  agentReviewUnavailableReason?: string;
}

/**
 * Where B004 found an environment variable:
 * - `env`, `launch-env`: the descriptor template's top-level `env` or `launchDescriptor.env`;
 * - `code`: a `System.getenv` read in `src/main` sources;
 * - `configuration`: a `${NAME}` or `${NAME:default}` Spring placeholder in a Java string or in an `application*.yml`
 *   or `.properties` file under `src/main/resources` or `grails-app/conf`.
 */
export type B004SourceKind = 'env' | 'launch-env' | 'code' | 'configuration';

export interface B004Source {
  kind: B004SourceKind;
  path: string;
  line?: number;
  /** The entry's `value` (`env`, `launch-env`), or the default the code gives (`code`, `configuration`), as written. */
  value?: string;
  /** A `@Value("${NAME}")` binding without a default, which stops a Spring module at startup when the variable is unset. */
  failFast?: boolean;
}

/** The documentation row B004 reads for a variable: a Markdown table row in ENV_VARS.md or the README that names it. */
export interface B004DocumentationRow {
  path: string;
  line: number;
  /** The table's columns for a default, required or optional, and a description that it lacks. */
  missingColumns: Array<'default' | 'required' | 'description'>;
  /** The cells of the columns it has, as written. */
  default?: string;
  required?: string;
  description?: string;
  /** The required column's header names only "optional", so "yes" there means optional. */
  optionalColumn?: boolean;
}

/**
 * A problem with one variable, by sub-check:
 * - C1 `undocumented`: in no ENV_VARS.md or README table row; `missing-columns`: its table lacks a default, required
 *   or description column; `missing-required`, `missing-description`: its row leaves that cell empty;
 *   `unreadable-required`: its required cell is not yes, no, true, false, required or optional;
 *   `framework-unlinked`: not documented by the module, but by its framework, which neither README.md nor ENV_VARS.md links to;
 * - C2 `required-with-default`: documented as required, but has a default;
 * - C3 `name-format`: not upper case letters, digits and underscores; `aws-prefix`: `AWS_` without the `S3_` name;
 * - C4 `no-fail-fast`: documented as required, with no evidence that startup stops without it.
 */
export type B004Problem =
  | 'undocumented'
  | 'missing-columns'
  | 'missing-required'
  | 'missing-description'
  | 'unreadable-required'
  | 'framework-unlinked'
  | 'required-with-default'
  | 'name-format'
  | 'aws-prefix'
  | 'no-fail-fast';

export interface B004Variable {
  name: string;
  /** The first sources found; `sourceCount` counts them all. */
  sources: B004Source[];
  sourceCount: number;
  documentation?: B004DocumentationRow;
  /**
   * The framework that documents the variable when the module does not (policy section 2.2), with the pinned source;
   * `linked` when README.md or ENV_VARS.md links to that framework's documentation.
   */
  framework?: { name: string; source: string; linked: boolean };
  /** Required or optional, as the documentation says; absent when it does not say. */
  required?: boolean;
  /** The default from the documentation, a top-level `env` value or the code, when it has one. */
  defaultFrom?: { kind: 'documentation' | 'env' | 'code'; path: string; line?: number; value: string };
  problems: B004Problem[];
}

/** A log or print statement in `src/main` sources of a file that reads configuration. */
export interface B004LogSignal {
  kind: 'secret-value' | 'environment-dump';
  path: string;
  line: number;
  /** The secret-like name, or the call that reads the whole environment. */
  subject: string;
}

/**
 * The state of the descriptor template's top-level `env` (policy section 3.1): `not-checked` for a repository C1 does
 * not apply to (a library or a repository without a descriptor) or one that uses no variables; `no-template` for an
 * edge module without a template, which B001 fails; `template-unreadable` when B001 could not read the template.
 */
export type B004TopLevelEnv = 'present' | 'missing' | 'empty' | 'not-a-list' | 'no-template' | 'template-unreadable' | 'not-checked';

export interface B004Analysis {
  criterionId: 'B004';
  status: EvaluationStatus;
  summary: string;
  kind: BackendRepositoryKind;
  existingModule: boolean;
  policy: { title: string; url: string; pageVersion: number; modifiedAt: string } | { problem: string };
  templatePath?: string;
  /** Whether C1 and C2 apply: not to a library or a repository without a descriptor, which B004 treats as one. */
  documentationChecked: boolean;
  /** The root ENV_VARS.md and README.md files, and how many Markdown tables they have. */
  documentationFiles: Array<{ path: string; tableCount: number }>;
  topLevelEnv: B004TopLevelEnv;
  variables: B004Variable[];
  /** `System.getenv` reads whose name is not a literal or a string constant: the first 100 of `unreadReadCount`. */
  unreadReads: Array<{ path: string; line: number }>;
  unreadReadCount: number;
  logSignals: B004LogSignal[];
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
  /** Why the agent review was not applied, when agent review is enabled. */
  agentReviewUnavailableReason?: string;
}

/**
 * How B002 found an outbound request:
 * - `spring-client`: a method of a Spring HTTP interface client (`@HttpExchange`, or `@FeignClient` with mapping
 *   annotations), its path joined to the type's;
 * - `code`: a path built in Java or Groovy code, from string literals and string constants.
 */
export type BackendRequestSiteKind = 'spring-client' | 'code';

/**
 * A place in production code that sends a request to the FOLIO backend. `requestPath` is the path without query
 * string or leading slash, where every segment the code fills in at run time is `{}`. Without `requestPath`, the path
 * could not be read and `unresolved` says why.
 */
export interface BackendRequestSite {
  path: string;
  line: number;
  kind: BackendRequestSiteKind;
  /** The HTTP method, for a Spring client method. */
  method?: string;
  /** The path expression as written, on one line. */
  expression: string;
  requestPath?: string;
  /** The code appends something unknown to the last segment, such as a query string. */
  openEnd?: boolean;
  unresolved?: string;
}

/** What a request site maps to in the F001 handler index, as for F001. */
export interface B002MappedSite extends BackendRequestSite {
  outcome: F001SiteOutcome;
  /** The interface for `interface`; the candidates for `ambiguous` and `dynamic`. */
  interfaces: string[];
  /** The handler pattern that matched, for `interface`. */
  pathPattern?: string;
}

export interface B002InterfaceUse {
  id: string;
  sites: B002MappedSite[];
}

/**
 * What B002 decided from:
 * - `library`, `no-descriptor`: the repository kind, or a descriptor template B001 could not read;
 * - `requests-checked`: each request site mapped to an interface and looked up in requires and optional.
 */
export type B002Basis = 'library' | 'no-descriptor' | 'requests-checked';

export interface B002Analysis {
  criterionId: 'B002';
  status: EvaluationStatus;
  summary: string;
  basis: B002Basis;
  kind: BackendRepositoryKind;
  templatePath?: string;
  index: F001Analysis['index'];
  /** Interface ids in the template's requires and optional. */
  declared: { required: string[]; optional: string[] };
  /** JSON pointers of requires or optional entries whose interface id is not known: not an object, no string id, or an undefined build placeholder. */
  unreadDeclarations: string[];
  /**
   * S008's declared interfaces, which S008 reads from the generated descriptor when S002 built one, and the ids found
   * in only one of the two sets; information only.
   */
  s008?: { sourcePaths: string[]; onlyInS008: string[]; onlyInTemplate: string[]; unusableEntryCount: number };
  /** Production Java and Groovy files read for requests. */
  productionFileCount: number;
  /** Requests counted: every request site except those to Okapi's own `_/` endpoints and to the module's own paths. */
  siteCount: number;
  gatewaySiteCount: number;
  /** Requests to paths the module's own descriptor handlers or routes serve. */
  ownSiteCount: number;
  undeclared: B002InterfaceUse[];
  declaredAndUsed: B002InterfaceUse[];
  /** Declared interfaces no request site maps to; information only. */
  declaredNotSeen: string[];
  unresolvedSites: B002MappedSite[];
  notInIndexSites: B002MappedSite[];
  /** Dependencies on FOLIO libraries that send requests of their own, out of the tool's sight. */
  libraries: Array<{ artifactId: string; path: string }>;
  /** Kotlin source under src/main, which the tool does not read. */
  kotlinFiles: string[];
  sourceDiagnostics: CommittedSourceDiagnostic[];
  agentReviewUnavailableReason?: string;
  checklist: FrontendChecklist;
}

/**
 * Where a controlled vocabulary's reference data comes from:
 * - `reference-data-folder`: files in a `ref-data/` or `reference-data/` folder, with an RMB `TenantLoading` for the
 *   `loadReference` key or a Spring `loadReferenceData` override to load them;
 * - `liquibase-insert`: an insert into the vocabulary's table in a Liquibase changelog, which runs at tenant initialization;
 * - `grails-defaults`: the `@Defaults` values of a Grails refdata property, which the toolkit creates for each tenant.
 */
export type B008SourceKind = 'reference-data-folder' | 'liquibase-insert' | 'grails-defaults';

export interface B008Source {
  kind: B008SourceKind;
  file: string;
  line?: number;
  /** The folder, the table, or the number of default values. */
  detail: string;
}

/**
 * Why B008 treats something as a controlled vocabulary:
 * - `name`: a collection endpoint with GET and POST named like `*-types`, `*-statuses`, `*-reasons` or `*-categories`;
 * - `reference-data`: an endpoint a reference-data folder or a `loadReference` load path names;
 * - `grails-refdata`: a Grails refdata category, from the `RefdataValue` properties of domain classes.
 */
export type B008VocabularyReason = 'name' | 'reference-data' | 'grails-refdata';

export interface B008Vocabulary {
  /** The endpoint path, or the refdata category. */
  name: string;
  reason: B008VocabularyReason;
  /** The descriptor template, or the domain class that declares the category's first property. */
  file: string;
  line?: number;
  /** Reference data that gives it values at tenant initialization; empty when the tool found none. */
  sources: B008Source[];
  /** Reference data that names it but does not count, and why. */
  notCounted: Array<{ file: string; line?: number; note: string }>;
}

/**
 * What B008 decided from:
 * - `library`, `no-storage`: the repository kind, or no positive storage evidence in a completely read source;
 * - `storage-unconfirmed`: no storage evidence, in a source that was not read completely;
 * - `no-descriptor`: a module whose descriptor template B001 could not read, so its endpoints are not known;
 * - `no-vocabularies`: no controlled vocabulary found;
 * - `vocabularies-checked`: each vocabulary looked up in the reference data.
 */
export type B008Basis = 'library' | 'no-storage' | 'storage-unconfirmed' | 'no-descriptor' | 'no-vocabularies' | 'vocabularies-checked';

export interface B008Analysis {
  criterionId: 'B008';
  status: EvaluationStatus;
  summary: string;
  basis: B008Basis;
  kind: BackendRepositoryKind;
  framework: BackendEvidence['framework'];
  storage: BackendEvidence['storage'];
  templatePath?: string;
  /** Code that loads reference-data folders at tenant initialization. */
  loaders: Array<{ file: string; line: number; mechanism: 'rmb-tenant-loading' | 'spring-load-reference-data' }>;
  /**
   * Folders under `ref-data/` or `reference-data/` that hold files, and whether reference data is loaded from them: a
   * loader names them in a `loadReference` load path, or loads paths the tool could not read.
   */
  referenceDataFolders: Array<{ path: string; loaded: boolean }>;
  /** Inserts in Liquibase changelogs and the SQL files in their folders, per file and table, with the first line. */
  liquibaseInserts: Array<{ table: string; file: string; line: number; count: number }>;
  vocabularies: B008Vocabulary[];
  /** `add` calls for the `loadReference` key, or under a key, the tool could not read: the first 100 of `unreadLoadPathCount`. */
  unreadLoadPaths: Array<{ file: string; line: number }>;
  unreadLoadPathCount: number;
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
  /** Why agent review did not run, when it would have been relevant. */
  agentReviewUnavailableReason?: string;
}

/**
 * Where B011 found a reference, which decides how it counts:
 * - `code`: Java, Groovy or Kotlin source outside a migration (fails);
 * - `every-install-script`: an RMB script schema.json lists without `fromModuleVersion` (fails);
 * - `migration`: an RMB script with `fromModuleVersion`, a Liquibase changelog or a Grails database migration;
 * - `unlisted-script`: a file in `templates/db_scripts` that no readable schema.json lists;
 * - `other-file`: another SQL, XML or YAML file, such as schema.json itself, whose execution the tool cannot place.
 */
export type B011Location = 'code' | 'every-install-script' | 'migration' | 'unlisted-script' | 'other-file';

/** One file's references to one other module's schema, or to schema names it builds at runtime. */
export interface B011Reference {
  file: string;
  /** The schema without the tenant, such as `mod_configuration`; absent when the rest of the name is built at runtime. */
  schema?: string;
  location: B011Location;
  migration?: { kind: 'rmb' | 'liquibase' | 'grails'; fromModuleVersion?: string };
  /** The occurrences, with the text as written, such as `${myuniversity}_mod_configuration.config_data`. */
  occurrences: Array<{ line: number; text: string }>;
  /** All occurrences; `occurrences` keeps the first 100. */
  occurrenceCount: number;
  /** A known schema of another module in code or an every-install script, when the module's own name is known. */
  failing: boolean;
}

/**
 * What B011 decided from:
 * - `no-storage`: no positive storage evidence in completely read source;
 * - `storage-not-known`: no storage evidence, but the source was not read completely;
 * - `fqm`: mod-fqm-manager, which the criterion excepts;
 * - `references-checked`: the scripts, changelogs and sources of a module with storage.
 */
export type B011Basis = 'no-storage' | 'storage-not-known' | 'fqm' | 'references-checked';

export interface B011Analysis {
  criterionId: 'B011';
  status: EvaluationStatus;
  summary: string;
  basis: B011Basis;
  kind: BackendRepositoryKind;
  storage: BackendEvidence['storage'];
  /** The module's own schema names without the tenant, such as `mod_users`, from its artifactId, descriptor id, Gradle project name and the modules its descriptor replaces. */
  ownSchemas: string[];
  filesRead: number;
  /** References to the module's own schema, which do not count. */
  ownSchemaReferences: number;
  references: B011Reference[];
  /** RMB schema.json files that could not be parsed, so the scripts they list could not be placed. */
  unreadRmbSchemas: Array<{ path: string; message: string }>;
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
  agentReviewUnavailableReason?: string;
}

/**
 * How the repository keeps each tenant's data in its own schema:
 * - `rmb`: RMB's PostgresClient and PgUtil, which use the `<tenant>_<module>` schema of the tenant they are given;
 * - `folio-spring-base`: its DataSource sets each connection's search_path to the request tenant's schema, and it runs
 *   Liquibase in that schema;
 * - `grails`: GORM multi-tenancy in SCHEMA or DATABASE mode.
 */
export type B010MechanismName = 'rmb' | 'folio-spring-base' | 'grails';

export interface B010Mechanism {
  name: B010MechanismName;
  evidence: Array<{ path: string; line?: number; note: string }>;
}

/**
 * A place where tenant data may be stored outside a tenant's schema:
 * - `shared-client`: `PostgresClient.getInstance` without a tenant id, which RMB connects to the shared `public` schema;
 * - `fixed-tenant`: `PostgresClient.getInstance` with a string literal as the tenant id;
 * - `own-datasource`: a DataSource, JDBC connection or Vert.x database pool the code creates itself;
 * - `public-schema`: SQL that creates or writes an object in the `public` schema;
 * - `fixed-schema`: a schema with a fixed name (`CREATE SCHEMA`, a Liquibase `schemaName`, a JPA `@Table(schema)`);
 * - `not-multitenant`: a Grails domain class that neither implements MultiTenant nor extends or implements a class or trait
 *   in the repository that does;
 * - `discriminator`: GORM multi-tenancy in DISCRIMINATOR mode, which keeps every tenant in shared tables.
 */
export type B010RedFlagKind = 'shared-client' | 'fixed-tenant' | 'own-datasource' | 'public-schema' | 'fixed-schema' | 'not-multitenant' | 'discriminator';

export interface B010RedFlag {
  kind: B010RedFlagKind;
  path: string;
  line: number;
  /** What was found, as written: a call, a statement such as `CREATE FUNCTION public.f`, a schema or class name. */
  text: string;
}

/**
 * What B010 decided from:
 * - `no-storage`: the committed source was read completely and has no storage evidence;
 * - `storage-unconfirmed`: no storage evidence, but the committed source was not read completely;
 * - `storage`: storage evidence was found.
 */
export type B010Basis = 'no-storage' | 'storage-unconfirmed' | 'storage';

export interface B010Analysis {
  criterionId: 'B010';
  status: EvaluationStatus;
  summary: string;
  basis: B010Basis;
  kind: BackendRepositoryKind;
  storage: BackendEvidence['storage'];
  mechanisms: B010Mechanism[];
  /** The first 100 of `redFlagCount`, by path and line. */
  redFlags: B010RedFlag[];
  redFlagCount: number;
  /** `PostgresClient.getInstance` calls whose arguments the tool could not read: the first 100 of `unreadClientCallCount`. */
  unreadClientCalls: Array<{ path: string; line: number }>;
  unreadClientCallCount: number;
  sourceDiagnostics: CommittedSourceDiagnostic[];
  checklist: FrontendChecklist;
  agentReviewUnavailableReason?: string;
}

/**
 * How B013 found the module taking the tenant from `X-Okapi-Tenant`:
 * - `folio-execution-context`: folio-spring-base's FolioExecutionContext;
 * - `rmb-tenant-tool`: RMB's TenantTool, which reads the tenant from okapiHeaders;
 * - `rmb-pg-util`: RMB's PgUtil, which selects the tenant's schema from okapiHeaders;
 * - `grails-tenants`: grails-okapi's OkapiTenantResolver and GORM's Tenants;
 * - `tenant-header`: the header's name, or a constant for it, in the module's own code.
 */
export type B013Mechanism = 'folio-execution-context' | 'rmb-tenant-tool' | 'rmb-pg-util' | 'grails-tenants' | 'tenant-header';

/**
 * A possible tenant problem B013 lists for the reviewer:
 * - `configured-tenant`: a tenant named in configuration, an environment variable, a system property or `@Value`;
 * - `static-tenant`: a static field that is not final and holds a tenant;
 * - `cache-without-tenant`: a Spring cache annotation without a tenant in its key, or a cache built in a file that
 *   never mentions a tenant.
 */
export type B013RedFlagKind = 'configured-tenant' | 'static-tenant' | 'cache-without-tenant';

/** Work that runs outside a request: Kafka consumers, and scheduled jobs and timers. */
export type B013AsyncKind = 'kafka-consumer' | 'scheduled';

export interface B013Site {
  path: string;
  line: number;
}

/** Uses of one kind, counted in full, with the first site in each of the first 100 files in path order. */
export interface B013Uses<Kind extends string> {
  kind: Kind;
  uses: number;
  fileCount: number;
  sites: B013Site[];
}

export interface B013RedFlag extends B013Site {
  kind: B013RedFlagKind;
  /** What was found, such as `tenantId: public`. */
  text: string;
}

export interface B013Analysis {
  criterionId: 'B013';
  status: EvaluationStatus;
  summary: string;
  kind: BackendRepositoryKind;
  framework: BackendEvidence['framework'];
  /** Only the mechanisms found. */
  mechanisms: Array<B013Uses<B013Mechanism>>;
  /** The first 100 of `redFlagCount`, in path and line order. */
  redFlags: B013RedFlag[];
  redFlagCount: number;
  /** Only the kinds found. */
  asyncWork: Array<B013Uses<B013AsyncKind>>;
  sourceDiagnostics: CommittedSourceDiagnostic[];
  agentReviewUnavailableReason?: string;
  checklist: FrontendChecklist;
}
