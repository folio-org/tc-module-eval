import { EvaluationStatus, ModuleKindResult } from './index';

export type S008CatalogChannel = 'official' | 'development';
export type AcceptanceDecision =
  | { kind: 'approved-tcr'; reference: string }
  | { kind: 'provisional-tcr'; reference: string }
  | { kind: 'legacy-baseline'; reference: string }
  | { kind: 'exception'; reference: string; scope: 'S008' | 'S009' | 'S008,S009' };

export interface AcceptanceFamily {
  id: string;
  displayName: string;
  canonicalRepositories: string[];
  acceptance: AcceptanceDecision;
}

export interface AcceptanceLedger {
  schemaVersion: '1.0';
  authoritative: boolean;
  source: { reviewedBy: string; reference: string };
  families: AcceptanceFamily[];
  moduleIdentities: Array<{ identity: string; familyId: string }>;
  libraryCoordinates: Array<
    { ecosystem: 'maven'; groupId: string; artifactId: string; familyId: string }
    | { ecosystem: 'npm'; packageName: string; familyId: string }
  >;
}

export interface S008RawProvidedInterface {
  id: string;
  version: string;
  interfaceType?: string;
}

export interface S008Provider {
  moduleId: string;
  moduleIdentity: string;
  source: string;
  descriptorHash: string;
  provides: S008RawProvidedInterface[];
}

export interface S008EurekaComponent {
  familyId: string;
  moduleIdentities: string[];
  version: string;
  descriptorSource:
    | { status: 'intentionally-descriptorless' }
    | { status: 'unresolved' }
    | { status: 'acquired'; kind: 'registry'; source: string; descriptorHash: string }
    | { status: 'acquired'; kind: 'repository-tag'; repository: string; tag: string; commit: string; source: string; descriptorHash: string };
}

export interface S008Catalog {
  schemaVersion: '1.0';
  authoritative: boolean;
  channel: S008CatalogChannel;
  baseline: {
    platformRepository: string;
    platformCommit: string;
    platformTag?: string;
    descriptorVersion: string;
    descriptorHash: string;
  };
  applications: Array<{
    name: string;
    version: string;
    optional: boolean;
    farSource: string;
    descriptorHash: string;
  }>;
  eurekaComponents: S008EurekaComponent[];
  providers: S008Provider[];
}

export interface S008PolicyDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export type S008PolicyLoadResult<T> =
  | { ok: true; value: Readonly<T>; sourcePath: string; digest: string; diagnostics: [] }
  | { ok: false; sourcePath: string; diagnostics: S008PolicyDiagnostic[] };

export interface S008Declaration {
  id: string;
  version: string;
  optional: boolean;
  sourcePath: string;
  sourceField: string;
}

export interface S008DeclarationDiagnostic {
  code: string;
  message: string;
  path?: string;
  material: boolean;
}

export interface S008DeclarationResult {
  declarations: S008Declaration[];
  diagnostics: S008DeclarationDiagnostic[];
  sourcePaths: string[];
  fileHashes: Record<string, string>;
  complete: boolean;
}

export interface S008ProviderCandidate {
  moduleId: string;
  moduleIdentity: string;
  source: string;
  descriptorHash: string;
  version: string;
  interfaceType?: string;
  eligible: boolean;
  compatible: boolean;
  eligibility: 'accepted-family' | 'eureka-component' | 'unaccepted';
  familyId?: string;
}

export interface S008Finding {
  declaration: S008Declaration;
  classification: 'satisfied' | 'unaccepted' | 'incompatible' | 'missing';
  candidates: S008ProviderCandidate[];
}

export interface S008AnalysisResult {
  criterionId: 'S008';
  status: EvaluationStatus;
  summary: string;
  moduleKind: ModuleKindResult;
  channel: S008CatalogChannel;
  ledger?: { sourcePath: string; digest: string };
  catalog?: {
    sourcePath: string;
    digest: string;
    baseline: S008Catalog['baseline'];
    applications: S008Catalog['applications'];
    eurekaComponents: S008Catalog['eurekaComponents'];
  };
  declarations: S008DeclarationResult;
  findings: S008Finding[];
  policyDiagnostics: S008PolicyDiagnostic[];
}
