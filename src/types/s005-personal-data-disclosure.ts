import type { EvaluationStatus } from './index';

export type S005PersonalDataDisclosureParseState = 'completed' | 'incomplete' | 'unparseable' | 'not_parsed';

export type S005PersonalDataCategory =
  | 'no_personal_data'
  | 'name'
  | 'username'
  | 'user_identifier'
  | 'email'
  | 'phone'
  | 'address'
  | 'birth_date'
  | 'patron_data'
  | 'free_form_notes'
  | 'profile_picture'
  | 'ip_or_mac_address'
  | 'financial_information'
  | 'circulation_transactions'
  | 'custom_fields'
  | 'storage'
  | 'processing'
  | 'transmission'
  | 'cache'
  | 'logging'
  | 'other';

export type S005PersonalDataDisclosureTemplateIdentity = 'current-like' | 'older-or-custom' | 'unknown';

export interface S005PersonalDataDisclosureChecklistItem {
  order: number;
  lineNumber: number;
  sectionHeading?: string;
  rawLabel: string;
  checked: boolean;
  normalizedCategory: S005PersonalDataCategory;
}

export interface S005PersonalDataDisclosurePlaceholderEvidence {
  field: string;
  lineNumber: number;
  placeholderText: string;
  excerpt: string;
}

export interface S005PersonalDataDisclosureMetadata {
  versionText?: string;
  versionLineNumber?: number;
  templateIdentity: S005PersonalDataDisclosureTemplateIdentity;
  lastUpdatedText?: string;
  lastUpdatedLineNumber?: number;
  lastReviewedText?: string;
  lastReviewedLineNumber?: number;
}

export interface S005PersonalDataDisclosureCompletionState {
  completed: boolean;
  checkedMeaningfulAnswers: number;
  checkedCategories: S005PersonalDataCategory[];
  uncheckedCategories: S005PersonalDataCategory[];
}

export interface S005PersonalDataDisclosureContradiction {
  kind: 'no-personal-data-with-personal-fields';
  message: string;
  lineNumbers: number[];
  conflictingCategories: S005PersonalDataCategory[];
}

export interface S005PersonalDataDisclosureParseError {
  message: string;
  excerpt: string;
}

export type S005PersonalDataEvidenceSourceClass =
  | 'direct_contract'
  | 'implementation'
  | 'documentation'
  | 'ui'
  | 'test_sample';

export type S005PersonalDataEvidenceStrength = 'strong' | 'candidate' | 'context';

export interface S005PersonalDataEvidenceSignal {
  category: S005PersonalDataCategory;
  label: string;
  path: string;
  excerpt: string;
  line?: number;
  sourceClass: S005PersonalDataEvidenceSourceClass;
  strength: S005PersonalDataEvidenceStrength;
}

export interface S005PersonalDataEvidenceSkippedFile {
  path: string;
  reason: 'binary' | 'outside-repository' | 'unsupported-file' | 'read-error';
  message?: string;
}

export interface S005PersonalDataEvidenceScanResult {
  signals: S005PersonalDataEvidenceSignal[];
  scannedFiles: string[];
  skippedFiles: S005PersonalDataEvidenceSkippedFile[];
  warnings: string[];
}

export interface S005PersonalDataPossibleMismatch {
  kind: 'likely_omission' | 'possible_omission' | 'possible_over_disclosure' | 'contradiction';
  category?: S005PersonalDataCategory;
  message: string;
  evidenceReferences: string[];
  sourceClasses?: S005PersonalDataEvidenceSourceClass[];
  signalStrengths?: S005PersonalDataEvidenceStrength[];
}

export interface S005PersonalDataDeterministicClassification {
  status: EvaluationStatus.FAIL | EvaluationStatus.MANUAL;
  parseState: S005PersonalDataDisclosureParseState;
  reason: string;
}

export type S005PersonalDataEvidenceAssessmentKind =
  | 'likely_match'
  | 'supporting_no_personal_data'
  | 'context_only';

export interface S005PersonalDataEvidenceAssessment {
  kind: S005PersonalDataEvidenceAssessmentKind;
  category?: S005PersonalDataCategory;
  message: string;
  evidenceReferences: string[];
  sourceClasses: S005PersonalDataEvidenceSourceClass[];
  signalStrengths: S005PersonalDataEvidenceStrength[];
}

export interface S005PersonalDataDisclosureAnalysisResult {
  discovery: S005PersonalDataDisclosureDiscoveryResult;
  parseResult?: S005PersonalDataDisclosureParseResult;
  evidenceScan?: S005PersonalDataEvidenceScanResult;
  classification: S005PersonalDataDeterministicClassification;
  agentReviewUnavailableReason?: string;
  possibleMismatches: S005PersonalDataPossibleMismatch[];
  matchingEvidence: S005PersonalDataEvidenceAssessment[];
  supportingEvidence: S005PersonalDataEvidenceAssessment[];
  uncheckedAnswerDetails: S005PersonalDataDisclosureChecklistItem[];
  placeholders: S005PersonalDataDisclosurePlaceholderEvidence[];
  contradictions: S005PersonalDataDisclosureContradiction[];
  warnings: string[];
}

export interface S005PersonalDataDisclosureParseResult {
  metadata: S005PersonalDataDisclosureMetadata;
  checklistItems: S005PersonalDataDisclosureChecklistItem[];
  checkedCategories: S005PersonalDataCategory[];
  uncheckedCategories: S005PersonalDataCategory[];
  completion: S005PersonalDataDisclosureCompletionState;
  placeholders: S005PersonalDataDisclosurePlaceholderEvidence[];
  contradictions: S005PersonalDataDisclosureContradiction[];
  classification: S005PersonalDataDeterministicClassification;
  parseError?: S005PersonalDataDisclosureParseError;
  warnings: string[];
}

export type S005PersonalDataDisclosureAttemptReason =
  | 'root-near-match'
  | 'bounded-nested-near-match'
  | 'exact-file-read-error';

export interface S005PersonalDataDisclosureAttempt {
  path: string;
  reason: S005PersonalDataDisclosureAttemptReason;
}

export interface S005PersonalDataDisclosureArtifact {
  path: string;
  absolutePath: string;
  content: string;
}

export interface S005PersonalDataDisclosureDiscoveryResult {
  status: 'found' | 'missing' | 'unreadable';
  artifact?: S005PersonalDataDisclosureArtifact;
  attempts: S005PersonalDataDisclosureAttempt[];
  readError?: string;
  warnings: string[];
}
