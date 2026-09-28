import type { EvaluationStatus } from './index';

export type S006FindingCategory =
  | 'provider_api_key'
  | 'private_key'
  | 'bearer_or_jwt_token'
  | 'password_or_secret_assignment'
  | 'credential_url'
  | 'private_url'
  | 'environment_file'
  | 'tenant_or_host_endpoint'
  | 'local_absolute_path';

export type S006FindingContext =
  | 'production_source_or_configuration'
  | 'ci_or_deployment_configuration'
  | 'documentation'
  | 'test_fixture'
  | 'sample_or_example'
  | 'local_docker_defaults'
  | 'generated_content'
  | 'unknown';

export type S006FindingConfidence = 'low' | 'medium' | 'high';

export type S006FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type S006StatusContribution = 'pass_neutral' | 'manual_candidate' | 'fail_candidate';

export type S006DetectorId =
  | 'provider-api-key'
  | 'private-key-block'
  | 'bearer-or-jwt-token'
  | 'password-secret-assignment'
  | 'credential-url'
  | 'private-url'
  | 'environment-file'
  | 'tenant-host-endpoint'
  | 'local-absolute-path';

export type S006ValueClassification = 'placeholder' | 'synthetic' | 'live-looking';

export type S006FindingStatusImpact = 'deterministic_fail' | 'manual_review';

export interface S006Excerpt {
  text: string;
  multiline: boolean;
  startLine?: number;
  endLine?: number;
}

export interface S006RunLocalValueFingerprint {
  algorithm: 'hmac-sha256';
  scope: 'run-local';
  value: string;
  length: number;
}

export interface S006DetectorSeverityMapping {
  low: S006FindingSeverity;
  medium: S006FindingSeverity;
  high: S006FindingSeverity;
}

export interface S006DetectorStatusContributionMapping {
  low: S006StatusContribution;
  medium: S006StatusContribution;
  high: S006StatusContribution;
}

export interface S006DetectorCalibrationCase {
  name: string;
  rawValue: string;
  expectedValueClassification: S006ValueClassification;
  expectedConfidence?: S006FindingConfidence;
  expectedSeverity?: S006FindingSeverity;
}

export interface S006DetectorRegistryEntry {
  id: S006DetectorId;
  category: S006FindingCategory;
  label: string;
  pattern: RegExp;
  defaultConfidence: S006FindingConfidence;
  severityByConfidence: S006DetectorSeverityMapping;
  statusContributionByConfidence: S006DetectorStatusContributionMapping;
  contextualDowngradeWhenNonLive?: S006FindingConfidence;
  classifyValue: (rawMatch: string) => S006ValueClassification;
  calibrationCases: S006DetectorCalibrationCase[];
}

export interface S006DetectorMatch {
  detectorId: S006DetectorId;
  category: S006FindingCategory;
  valueClassification: S006ValueClassification;
  confidence: S006FindingConfidence;
  severity: S006FindingSeverity;
  excerpt: S006Excerpt;
  valueFingerprint: S006RunLocalValueFingerprint;
}

export interface S006SensitiveInformationFinding {
  path: string;
  line?: number;
  endLine?: number;
  detectorId: S006DetectorId;
  category: S006FindingCategory;
  context: S006FindingContext;
  valueClassification: S006ValueClassification;
  confidence: S006FindingConfidence;
  severity: S006FindingSeverity;
  excerpt: S006Excerpt;
  valueFingerprint: S006RunLocalValueFingerprint;
  statusImpact: S006FindingStatusImpact;
  rationale: string;
}

export interface S006ReportFinding {
  path: string;
  line?: number;
  endLine?: number;
  detectorId: S006DetectorId;
  category: S006FindingCategory;
  context: S006FindingContext;
  confidence: S006FindingConfidence;
  severity: S006FindingSeverity;
  disposition: 'deterministic_failure' | 'scanner_or_pattern_candidate';
  excerpt: S006Excerpt;
  rationale: string;
}

export type S006SkippedFileReason =
  | 'outside-repository'
  | 'dependency-directory'
  | 'generated-artifact'
  | 'binary'
  | 'unsupported-file'
  | 'read-error'
  | 'file-too-large'
  | 'scan-limit';

export interface S006SkippedFile {
  path: string;
  reason: S006SkippedFileReason;
  message?: string;
  materialToCoverage: boolean;
}

export type S006ScanWarningKind =
  | 'traversal-limit'
  | 'candidate-limit'
  | 'byte-limit'
  | 'file-truncated'
  | 'unreadable-file'
  | 'unsupported-high-signal-file'
  | 'scanner-unavailable'
  | 'finding-limit';

export interface S006ScanWarning {
  kind: S006ScanWarningKind;
  message: string;
  path?: string;
  materialToCoverage: boolean;
}

export interface S006ScanCoverage {
  scannedFiles: number;
  scannedBytes: number;
  candidateFiles: number;
  skippedFiles: S006SkippedFile[];
  warnings: S006ScanWarning[];
  materiallyWeakened: boolean;
  complete: boolean;
}

export interface S006SecretScannerSummary {
  name: 'Gitleaks';
  status: 'completed' | 'unavailable';
  findingCount: number;
  warning?: S006ScanWarning;
}

export interface S006DeterministicClassification {
  status: EvaluationStatus.PASS | EvaluationStatus.FAIL | EvaluationStatus.MANUAL;
  reason: string;
  findingReferences: string[];
  materiallyWeakenedCoverage: boolean;
}

export interface S006SensitiveInformationAnalysisResult {
  criterionId: 'S006';
  findings: S006SensitiveInformationFinding[];
  scanner: S006SecretScannerSummary;
  coverage: S006ScanCoverage;
  classification: S006DeterministicClassification;
  warnings: S006ScanWarning[];
  agentReviewUnavailableReason?: string;
}

export interface S006ReportDetails {
  criterionId: 'S006';
  findingCount: number;
  retainedFindingCount: number;
  findings: S006ReportFinding[];
  findingSummary: {
    confidenceRange?: { minimum: S006FindingConfidence; maximum: S006FindingConfidence };
    severityRange?: { minimum: S006FindingSeverity; maximum: S006FindingSeverity };
  };
  scanner: S006SecretScannerSummary;
  coverage: S006ScanCoverage;
  coverageSummary: {
    skippedFileCount: number;
    materialSkippedFileCount: number;
    warningCount: number;
    materialWarningCount: number;
    skippedFileReasonCounts: Partial<Record<S006SkippedFileReason, number>>;
    scanLimitWarnings: S006ScanWarning[];
  };
  classification: S006DeterministicClassification;
  warnings: S006ScanWarning[];
  agentReviewUnavailableReason?: string;
}
