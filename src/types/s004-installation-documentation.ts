import type { EvaluationStatus } from './index';

export type S004SignalGroup =
  | 'install_deploy_run'
  | 'docker_runtime'
  | 'env_configuration'
  | 'okapi_tenant_enablement'
  | 'stripes_setup'
  | 'build_test'
  | 'external_reference';

export interface S004DocumentationSignal {
  group: S004SignalGroup;
  label: string;
  path: string;
  excerpt: string;
  line?: number;
  strength: 'strong' | 'candidate' | 'insufficient';
}

export interface S004DocumentationCandidate {
  path: string;
  source: 'root-readme' | 'conventional-doc' | 'linked-doc';
  sizeBytes: number;
  signals: S004DocumentationSignal[];
}

export interface S004DeterministicClassification {
  status: EvaluationStatus.FAIL | EvaluationStatus.MANUAL;
  reason: string;
  strongestSignals: S004DocumentationSignal[];
  filesConsidered: string[];
  warnings: string[];
}

export interface S004InstallationDocumentationResult {
  candidates: S004DocumentationCandidate[];
  classification: S004DeterministicClassification;
  agentReviewUnavailableReason?: string;
  warnings: string[];
}
