/**
 * Evaluation status for a criteria
 *
 * FRAMEWORK USAGE NOTES:
 * - PASS: Criterion automatically verified as meeting requirements
 * - FAIL: Criterion automatically verified as NOT meeting requirements
 * - MANUAL: Requires human review (e.g., errors during evaluation, non-automatable criteria)
 * - NOT_APPLICABLE: Criterion does not apply to this repository
 *
 */
export enum EvaluationStatus {
  PASS = 'pass',
  FAIL = 'fail',
  MANUAL = 'manual',
  NOT_APPLICABLE = 'not_applicable'
}

/**
 * A single criterion from the acceptance criteria
 */
export interface Criterion {
  id: string;
  code: string;
  description: string;
  section: string;
}

/**
 * Result of evaluating a single criterion
 */
export interface CriterionResult {
  criterionId: string;
  status: EvaluationStatus;
  evidence: string;
  details?: string;
  criterionDetails?: unknown;
  agentReview?: CriterionAgentReviewResult;
}

/**
 * Complete evaluation result for a module
 */
export interface EvaluationResult {
  repositoryUrl: string;
  moduleName: string;
  language: string;
  evaluatedAt: Date;
  criteria: CriterionResult[];
}

export type ArtifactKey = 'moduleDescriptor' | 'moduleKind';
export type CommandExecutionEnvironment = 'local' | 'github-actions';

export interface CommandExecutionRequest {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
  requiresIsolation?: boolean;
  networkPolicy?: CommandNetworkPolicy;
}

export interface CommandNetworkPolicy {
  default: 'deny' | 'allow';
  allowedHosts?: string[];
}

export interface CommandExecutionResult {
  identity: string;
  command: string;
  args: string[];
  cwd: string;
  commandExecutionEnvironment: CommandExecutionEnvironment;
  localCommandsAllowed: boolean;
  status: 'success' | 'failed' | 'timed_out' | 'blocked';
  exitCode?: number | null;
  signal?: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  errorMessage?: string;
  sanitized: boolean;
}

export interface CommandRunner {
  run(request: CommandExecutionRequest, evaluationRun?: EvaluationRun): Promise<CommandExecutionResult>;
  normalize(request: CommandExecutionRequest): string;
}

export interface ModuleDescriptorArtifact {
  status:
    | 'produced'
    | 'discovered'
    | 'missing'
    | 'invalid-candidate'
    | 'ambiguous-candidates'
    | 'unsafe-to-run'
    | 'command-failed';
  strategy?: 'maven-generation' | 'frontend-script' | 'static-root';
  descriptorPath?: string;
  absolutePath?: string;
  command?: CommandExecutionResult;
  warnings: string[];
  errors: string[];
}

export interface EvaluationRunArtifacts {
  moduleDescriptor?: ModuleDescriptorArtifact;
  moduleKind?: ModuleKindResult;
}

export interface EvaluationRun {
  repositoryPath: string;
  repositoryUrl?: string;
  repositoryName?: string;
  language: string;
  selectedCriteria: string[];
  artifacts: EvaluationRunArtifacts;
  commandObservations: Map<string, CommandExecutionResult>;
  commandRunner?: CommandRunner;
  agentReview?: CriterionAgentReviewConfig;
  getOrCreateArtifact<K extends ArtifactKey>(
    key: K,
    producer: () => Promise<NonNullable<EvaluationRunArtifacts[K]>>
  ): Promise<NonNullable<EvaluationRunArtifacts[K]>>;
}

/**
 * Configuration for the evaluation process
 */
export interface EvaluationConfig {
  tempDir?: string;
  outputDir?: string;
  skipCleanup?: boolean;
  criteriaFilter?: string[];
  branch?: string;
  commandRunner?: CommandRunner;
  allowLocalCommands?: boolean;
  commandExecutionEnvironment?: CommandExecutionEnvironment;
  agentReview?: CriterionAgentReviewConfig;
}

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

export type S005PersonalDataDisclosureParseState = 'completed' | 'incomplete' | 'unparseable';

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

export interface S005PersonalDataEvidenceSignal {
  category: S005PersonalDataCategory;
  label: string;
  path: string;
  excerpt: string;
  line?: number;
  sourceClass: 'direct_contract' | 'implementation' | 'documentation' | 'ui' | 'test_sample';
  strength: 'strong' | 'candidate' | 'context';
}

export interface S005PersonalDataPossibleMismatch {
  kind: 'possible_omission' | 'possible_over_disclosure' | 'contradiction' | 'unverifiable';
  category?: S005PersonalDataCategory;
  message: string;
  evidenceReferences: string[];
}

export interface S005PersonalDataDeterministicClassification {
  status: EvaluationStatus.FAIL | EvaluationStatus.MANUAL;
  parseState: S005PersonalDataDisclosureParseState;
  reason: string;
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

export type ModuleKind = 'backend-module' | 'ui-module' | 'library' | 'ambiguous';

export interface ModuleKindResult {
  kind: ModuleKind;
  evidence: string[];
  warnings: string[];
}

export type CriterionAgentRecommendation = 'likely_sufficient' | 'likely_insufficient' | 'needs_reviewer_judgment';

export interface CriterionAgentReviewMetadata {
  adapter: 'opencode' | 'fake';
  modelLabel?: string;
  endpointFamily?: string;
  reviewMode: 'read-only';
  promptInputSanitized: boolean;
  reviewWorkspaceSanitized: boolean;
  retainedWorkspacePath?: string;
}

export interface CriterionAgentReviewResult {
  available: boolean;
  criterionId: string;
  recommendation?: CriterionAgentRecommendation;
  confidence?: 'low' | 'medium' | 'high';
  summary?: string;
  rationale?: string;
  evidenceReferences: string[];
  metadata?: CriterionAgentReviewMetadata;
  warnings: string[];
  errors: string[];
}

export interface CriterionAgentReviewConfig {
  enabled: boolean;
  enabledCriteria?: string[];
  adapter: 'opencode' | 'fake';
  modelLabel?: string;
  readOnlyAgentName?: string;
  timeoutMs?: number;
  trustedConfigPath?: string;
  trustedAuthStorePath?: string;
  providerEnvAllowlist?: string[];
  proxyEnvAllowlist?: string[];
  endpoint?: string;
  endpointFamily?: string;
  endpointAllowlist?: string[];
  debugRetainWorkspace?: boolean;
  fakeResult?: CriterionAgentReviewResult;
  generatedProvider?: CriterionAgentGeneratedProvider;
  providerConfigError?: string;
}

export interface CriterionAgentGeneratedProvider {
  name: 'openrouter' | 'openai';
  apiKeyEnv: 'OPENROUTER_API_KEY' | 'OPENAI_API_KEY';
  modelEnv: 'OPENROUTER_MODEL' | 'OPENAI_MODEL';
  modelId: string;
  modelSelector: string;
}

/**
 * Function signature for individual criterion evaluation methods
 */
export type CriterionFunction = (repoPath: string, evaluationRun?: EvaluationRun) => Promise<CriterionResult>;

/**
 * Base interface for section-specific evaluators
 */
export interface SectionEvaluator {
  /**
   * The name of the section this evaluator handles
   */
  readonly sectionName: string;

  /**
   * Array of criterion IDs this evaluator handles
   */
  readonly criteriaIds: string[];

  /**
   * Evaluate all criteria in this section
   * @param repoPath Path to the cloned repository
   * @param criteriaFilter Optional array of criterion IDs to filter evaluation
   * @returns Promise<CriterionResult[]> Results of all criteria in this section
   */
  evaluate(repoPath: string, criteriaFilter?: string[], evaluationRun?: EvaluationRun): Promise<CriterionResult[]>;

  /**
   * Evaluate a specific criterion by ID
   * @param criterionId The ID of the criterion to evaluate
   * @param repoPath Path to the cloned repository
   * @returns Promise<CriterionResult> Result of the specific criterion
   */
  evaluateCriterion(criterionId: string, repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult>;
}

/**
 * Interface for language-specific evaluators
 */
export interface LanguageEvaluator {
  /**
   * Determine if this evaluator can handle the given repository
   * @param repoPath Path to the cloned repository
   * @returns Promise<boolean> true if this evaluator can handle the repo
   */
  canEvaluate(repoPath: string): Promise<boolean>;

  /**
   * Evaluate the repository against all applicable criteria
   * @param repoPath Path to the cloned repository
   * @param criteriaFilter Optional array of criterion IDs to filter evaluation
   * @returns Promise<CriterionResult[]> Results of the evaluation
   */
  evaluate(repoPath: string, criteriaFilter?: string[], evaluationRun?: EvaluationRun): Promise<CriterionResult[]>;

  /**
   * Get the language this evaluator handles
   */
  getLanguage(): string;
}

/**
 * Report generation options
 */
export interface ReportOptions {
  outputHtml?: boolean;
  outputJson?: boolean;
  outputDir?: string;
}

/**
 * Represents a third-party dependency with its licenses
 */
export interface Dependency {
  name: string;
  version: string;
  // A dependency can have multiple licenses, or none declared
  licenses?: string[];
}

/**
 * License issue types for structured compliance reporting
 */
export enum LicenseIssueType {
  CATEGORY_X_VIOLATION = 'CATEGORY_X_VIOLATION',
  UNKNOWN_LICENSE = 'UNKNOWN_LICENSE',
  UNDOCUMENTED_CATEGORY_B = 'UNDOCUMENTED_CATEGORY_B',
  NO_LICENSE_INFO = 'NO_LICENSE_INFO',
  PARSER_ERROR = 'PARSER_ERROR'
}

/**
 * Represents a compliance issue with a specific dependency
 */
export interface ComplianceIssue {
  dependency: Dependency;
  reason: string; // Human-readable description
  issueType: LicenseIssueType; // Structured type for programmatic handling
}

/**
 * Result of license compliance checking
 */
export interface ComplianceResult {
  compliant: boolean;
  issues: ComplianceIssue[];
}

/**
 * Represents an error or warning during dependency extraction
 */
export interface DependencyExtractionError {
  source: string;      // e.g., "maven-parser", "gradle-parser", "path-validation"
  message: string;     // Human-readable error message
  error?: Error;       // Original error for debugging/logging
}

/**
 * Result of dependency extraction including success data and error information
 * Allows callers to distinguish between "no dependencies found" (valid) and "extraction failed" (error)
 */
export interface DependencyExtractionResult {
  dependencies: Dependency[];               // Successfully extracted dependencies
  errors: DependencyExtractionError[];      // Fatal errors that prevented extraction
  warnings: DependencyExtractionError[];    // Non-fatal issues (e.g., "no build file found")
}

/**
 * Configuration interfaces for external JSON files used by license policy
 */

/**
 * License categories configuration structure
 */
export interface LicenseCategoriesConfig {
  _description?: string;
  _reference?: string;
  categories: Record<string, string>;
}

/**
 * Special exceptions configuration structure
 */
export interface SpecialExceptionsConfig {
  _description?: string;
  _note?: string;
  exceptions: Array<{
    name: string;
    description: string;
    matchType: 'exact' | 'prefix';
  }>;
}

/**
 * License variations configuration structure
 */
export interface LicenseVariationsConfig {
  _description?: string;
  _source?: string;
  variations: Record<string, string>;
}
