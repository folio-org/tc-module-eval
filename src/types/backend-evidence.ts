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
