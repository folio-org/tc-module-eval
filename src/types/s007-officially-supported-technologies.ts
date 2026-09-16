export type S007PolicyArea =
  | 'frontend'
  | 'backend'
  | 'infrastructure'
  | 'fast-moving-infrastructure';

export type S007PolicyCategory = 'language' | 'framework' | 'build-tool' | 'testing' | 'infrastructure';
export type S007PolicyConsumer = 's007' | 's012' | 's013' | 'future';
export type S007VersionPolicy =
  | 'one-of-specified-versions'
  | 'all-of-specified-versions'
  | 'unspecified-versions'
  | 'provisional';
export type S007RuleStrength = 'normative' | 'advisory' | 'provisional' | 'contested';
export type S007TechnologyType = 'language' | 'framework' | 'library' | 'build-tool' | 'testing' | 'infrastructure';
export type S007Ecosystem = 'javascript' | 'java' | 'go' | 'openapi' | 'infrastructure' | 'agnostic';
export type S007ConstraintKind = 'exact' | 'major-line' | 'minor-line' | 'minimum' | 'range' | 'latest-lts';

export type S007PolicySectionId =
  | 'frontend-languages'
  | 'frontend-build-tools'
  | 'frontend-first-party-frameworks'
  | 'frontend-third-party-frameworks'
  | 'frontend-build-testing'
  | 'frontend-integration-testing'
  | 'backend-languages'
  | 'backend-build-tools'
  | 'backend-first-party-frameworks'
  | 'backend-third-party-frameworks'
  | 'backend-build-testing'
  | 'backend-integration-testing'
  | 'infrastructure'
  | 'fast-moving-infrastructure';

export interface S007VersionConstraint {
  kind: S007ConstraintKind;
  expression: string;
}

export interface S007ApplicabilityException {
  appliesTo: string;
  constraint?: S007VersionConstraint;
  strength: S007RuleStrength;
  sourceStatement: string;
}

export interface S007PolicyDeprecation {
  deprecated: true;
  note: string;
}

export interface S007TechnologyPolicyEntry {
  id: string;
  displayName: string;
  aliases: string[];
  ecosystem: S007Ecosystem;
  technologyType: S007TechnologyType;
  sourceStatement: string;
  strength: S007RuleStrength;
  constraint?: S007VersionConstraint;
  applicability?: string[];
  exceptions?: S007ApplicabilityException[];
  deprecation?: S007PolicyDeprecation;
  provisional?: true;
  recommendations?: string[];
  notes?: string[];
}

export interface S007PolicySection {
  id: S007PolicySectionId;
  area: S007PolicyArea;
  category: S007PolicyCategory;
  consumer: S007PolicyConsumer;
  versionPolicy: S007VersionPolicy;
  sourceStatement?: string;
  entries: S007TechnologyPolicyEntry[];
}

export interface S007PolicySourceMetadata {
  url?: string;
  title?: string;
  documentStatus?: string;
  exportDate?: string;
  reviewDate?: string;
  supportPeriod?: {
    endDate?: string;
    statement: string;
  };
  notes?: string[];
}

export interface S007OfficiallySupportedTechnologiesPolicy {
  formatVersion: '1.0';
  source?: S007PolicySourceMetadata;
  definitions: {
    oneOfSpecifiedVersions: string;
    allOfSpecifiedVersions: string;
    unspecifiedVersions: string;
  };
  sections: S007PolicySection[];
}

export type S007PolicyDiagnosticCode =
  | 'policy_missing'
  | 'policy_read_error'
  | 'policy_parse_error'
  | 'policy_schema_error';

export interface S007PolicyDiagnostic {
  code: S007PolicyDiagnosticCode;
  message: string;
  path?: string;
  schemaPath?: string;
}

export type S007PolicyLoadResult =
  | {
      ok: true;
      policy: S007OfficiallySupportedTechnologiesPolicy;
      sourcePath: string;
      diagnostics: [];
    }
  | {
      ok: false;
      sourcePath: string;
      diagnostics: S007PolicyDiagnostic[];
    };

export type S007EvidenceKind =
  | 'language-indicator'
  | 'dependency-declaration'
  | 'plugin-declaration'
  | 'build-setting';

export interface S007TechnologyObservation {
  identityCandidates: string[];
  displayName: string;
  ecosystem: S007Ecosystem;
  technologyType: 'language' | 'framework' | 'library';
  evidenceKind: S007EvidenceKind;
  sourcePath: string;
  sourceDetail: string;
  declaredVersion?: string;
  resolvedVersion?: string;
  versionSourcePath?: string;
  confidence: 'confident' | 'partial';
  provenance: 'repository-static';
  unlistedFrameworkCandidate?: true;
  conflictPaths?: string[];
}

export interface S007EvidenceDiagnostic {
  code:
    | 'manifest_missing'
    | 'manifest_malformed'
    | 'manifest_too_large'
    | 'insufficient_evidence'
    | 'version_unresolved'
    | 'maven_remote_parent'
    | 'maven_imported_bom'
    | 'gradle_dynamic_expression'
    | 'gradle_version_catalog'
    | 'gradle_build_logic'
    | 'local_module_missing'
    | 'local_module_outside_repository'
    | 'local_module_symlink'
    | 'traversal_limit'
    | 'yarn_lock_missing'
    | 'yarn_lock_malformed'
    | 'yarn_lock_unsupported'
    | 'conflicting_versions';
  message: string;
  material: boolean;
  path?: string;
}

export interface S007TechnologyEvidenceResult {
  observations: S007TechnologyObservation[];
  diagnostics: S007EvidenceDiagnostic[];
  manifestPaths: string[];
  complete: boolean;
}
