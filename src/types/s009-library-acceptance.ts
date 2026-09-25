import { EvaluationStatus } from './index';
import { AcceptanceLedger, S008PolicyDiagnostic } from './s008-interface-acceptance';

export type S009Ecosystem = 'maven' | 'npm';

export interface S009DependencyObservation {
  ecosystem: S009Ecosystem;
  coordinate: string;
  declaredVersion?: string;
  sourcePath: string;
  sourceField: string;
  scope: string;
}

export interface S009EvidenceDiagnostic {
  code: string;
  message: string;
  path?: string;
  material: boolean;
}

export interface S009DependencyEvidence {
  observations: S009DependencyObservation[];
  diagnostics: S009EvidenceDiagnostic[];
  projectFiles: string[];
  fileHashes: Record<string, string>;
  hasDependencyProject: boolean;
  complete: boolean;
}

export interface S009Finding {
  observation: S009DependencyObservation;
  classification: 'accepted' | 'unaccepted';
  familyId?: string;
  familyDisplayName?: string;
  acceptance?: AcceptanceLedger['families'][number]['acceptance'];
}

export interface S009AnalysisResult {
  criterionId: 'S009';
  status: EvaluationStatus;
  summary: string;
  ledger?: { sourcePath: string; digest: string };
  evidence: S009DependencyEvidence;
  findings: S009Finding[];
  policyDiagnostics: S008PolicyDiagnostic[];
}
