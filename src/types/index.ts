/**
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

export interface Criterion {
  id: string;
  code: string;
  description: string;
  section: string;
}

export interface CriterionResult {
  criterionId: string;
  status: EvaluationStatus;
  evidence: string;
  details?: string;
  criterionDetails?: unknown;
  agentReview?: CriterionAgentReviewResult;
}

export interface EvaluationResult {
  repositoryUrl: string;
  moduleName: string;
  language: string;
  evaluatedAt: Date;
  provenance?: EvaluationProvenance;
  criteria: CriterionResult[];
}

/** Reproducibility metadata captured before repository-controlled commands run. */
export interface EvaluationProvenance {
  repositoryCommit: string;
  evaluator: {
    name: string;
    version: string;
  };
  agentReviewModel?: string;
  /** Committed target paths cited by this report; used for safe source links. */
  citedSourcePaths?: string[];
}

export type ArtifactKey = 'moduleDescriptor' | 'moduleKind' | 's007TechnologyEvidence' | 's007Analysis' | 's009DependencyEvidence' | 's010ThirdPartyEvidence' | 'buildTestEvidence' | 'platformMembership' | 'sonarCloudSnapshot' | 's011SuppressionScan' | 'agentReviewSnapshot' | 'frontendSource' | 'uiRequestSites' | 'backendEvidence' | 'backendApiSpecs';
export type CommandExecutionEnvironment = 'local' | 'github-actions';

export interface CommandExecutionRequest {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** When stdout exceeds maxOutputBytes, keep its last complete lines instead of its first bytes. */
  keepStdoutTail?: boolean;
  stdoutFormat?: 'text' | 'json' | 'opencode-json';
  captureDebugTrace?: boolean;
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
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutDiagnostics?: string[];
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
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
  strategy?: 'maven-generation' | 'gradle-generation' | 'frontend-script' | 'static-root';
  descriptorPath?: string;
  absolutePath?: string;
  command?: CommandExecutionResult;
  warnings: string[];
  errors: string[];
}

export interface EvaluationRunArtifacts {
  moduleDescriptor?: ModuleDescriptorArtifact;
  moduleKind?: ModuleKindResult;
  s007TechnologyEvidence?: import('./s007-officially-supported-technologies').S007TechnologyEvidenceResult;
  /** S007's policy and analysis, shared with F005 so both report the same Stripes finding. Read-only once produced. */
  s007Analysis?: import('./s007-officially-supported-technologies').S007RunAnalysis;
  s009DependencyEvidence?: import('./s009-library-acceptance').S009DependencyEvidence;
  s010ThirdPartyEvidence?: import('./s010-third-party-resilience').S010Evidence;
  buildTestEvidence?: import('./s012-build-tools').BuildTestEvidence;
  platformMembership?: import('./s014-application-assignment').S014PlatformSnapshot;
  sonarCloudSnapshot?: import('./sonarcloud-snapshot').SonarCloudSnapshot;
  s011SuppressionScan?: import('./s011-sonarqube').S011SuppressionScan;
  /** The committed source every agent review browses; read once and frozen, since the reviews share it. */
  agentReviewSnapshot?: import('../utils/committed-source').CommittedSourceSnapshot;
  /** The committed production source, package.json and English translations the F criteria read. */
  frontendSource?: import('../utils/frontend-source').FrontendSource;
  /** Every request a UI package's production code sends to the backend, for F001. */
  uiRequestSites?: import('./f001-consumed-apis').UiRequestSites;
  /** The B criteria's shared evidence: repository kind, descriptor template, framework and storage. */
  backendEvidence?: import('./backend-evidence').BackendEvidence;
  /** The API specs in backendEvidence's snapshot, for B006 and B003. */
  backendApiSpecs?: import('./backend-evidence').BackendApiSpecs;
}

export interface EvaluationRun {
  repositoryPath: string;
  repositoryUrl?: string;
  repositoryName?: string;
  language: import('../criteria-definitions').CriterionLanguage;
  selectedCriteria: string[];
  artifacts: EvaluationRunArtifacts;
  commandObservations: Map<string, CommandExecutionResult>;
  commandRunner?: CommandRunner;
  agentReview?: CriterionAgentReviewConfig;
  s008CatalogChannel: import('./s008-interface-acceptance').S008CatalogChannel;
  /** The evaluated commit; absent for direct evaluateCriterion calls. */
  repositoryCommit?: string;
  /** The --branch value, if one was given. */
  requestedBranch?: string;
  /** The remote-evidence transport; absent unless --allow-remote-lookups was given. */
  remoteLookups?: import('./remote-evidence').RemoteLookups;
  /** The application the evaluation's Jira task names (--application). */
  s014Application?: string;
  /** The platform-lsp branch, tag or commit S014 reads (--platform-ref). */
  s014PlatformRef?: string;
  /** Evaluate an existing module rather than a new one (--existing-module), which relaxes some new-module rules. */
  existingModule: boolean;
  getOrCreateArtifact<K extends ArtifactKey>(
    key: K,
    producer: () => Promise<NonNullable<EvaluationRunArtifacts[K]>>
  ): Promise<NonNullable<EvaluationRunArtifacts[K]>>;
  /**
   * Run one criterion's agent review once a review slot is free, after handing the section loop on to the next
   * criterion. Call it at most once per criterion: a second call would start the next criterion early.
   */
  runAgentReview<T>(review: () => Promise<T>): Promise<T>;
  /** Resolves when the next runAgentReview call starts, so the section loop can start the next criterion. */
  nextAgentReviewHandoff(): Promise<void>;
}

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
  s008CatalogChannel?: import('./s008-interface-acceptance').S008CatalogChannel;
  /** Allow read-only lookups of SonarCloud, platform-lsp and FAR (--allow-remote-lookups). */
  allowRemoteLookups?: boolean;
  /** Replaces the remote-evidence transport, like commandRunner; implies remote lookups are allowed. */
  remoteLookups?: import('./remote-evidence').RemoteLookups;
  s014Application?: string;
  s014PlatformRef?: string;
  /** Evaluate an existing module rather than a new one (--existing-module). */
  existingModule?: boolean;
}

export * from './s004-installation-documentation';
export * from './s005-personal-data-disclosure';
export * from './s006-sensitive-information';
export * from './s007-officially-supported-technologies';
export * from './s008-interface-acceptance';
export * from './s009-library-acceptance';
export * from './s010-third-party-resilience';
export * from './s011-sonarqube';
export * from './sonarcloud-snapshot';
export * from './s012-build-tools';
export * from './s013-test-coverage';
export * from './s014-application-assignment';
export * from './remote-evidence';
export * from './frontend-checklist';
export * from './f001-consumed-apis';
export * from './f002-e2e-tests';
export * from './f003-internationalization';
export * from './f005-stripes-version';
export * from './backend-evidence';

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
  assessments?: CriterionAgentAssessment[];
  reviewerActions?: CriterionAgentReviewerAction[];
  metadata?: CriterionAgentReviewMetadata;
  warnings: string[];
  errors: string[];
}

export interface CriterionAgentAssessment {
  technologyId: string;
  type: 'aligned_fact' | 'substantive_concern' | 'analyzer_limitation' | 'evidence_gap' | 'policy_question';
  summary: string;
  evidenceReferences: string[];
  coverageDisposition?: 'investigated' | 'immaterial' | 'unresolved';
  failureBounds?: CriterionAgentFailureBound[];
}

export interface CriterionAgentFailureBound {
  phase: 'startup' | 'tenant_initialization' | 'runtime';
  requirement: 'required' | 'optional' | 'conditional' | 'unknown';
  status: 'established' | 'unverified' | 'not_applicable';
  explanation: string;
  evidenceReferences: string[];
}

export interface CriterionAgentReviewerAction {
  action: string;
  evidenceReferences: string[];
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
  /** Set per run by reviewCriterionWithAgent so a run's reviews share one committed-source read. */
  readRepositorySnapshot?: () => Promise<import('../utils/committed-source').CommittedSourceSnapshot>;
}

export interface CriterionAgentGeneratedProvider {
  name: 'openrouter' | 'openai';
  apiKeyEnv: 'OPENROUTER_API_KEY' | 'OPENAI_API_KEY';
  modelEnv: 'OPENROUTER_MODEL' | 'OPENAI_MODEL';
  modelId: string;
  modelSelector: string;
}

export type CriterionFunction = (repoPath: string, evaluationRun?: EvaluationRun) => Promise<CriterionResult>;

export interface SectionEvaluator {
  readonly sectionName: string;

  readonly criteriaIds: string[];

  evaluate(repoPath: string, criteriaFilter?: string[], evaluationRun?: EvaluationRun): Promise<CriterionResult[]>;

  evaluateCriterion(criterionId: string, repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult>;
}

export interface LanguageEvaluator {
  canEvaluate(repoPath: string): Promise<boolean>;

  evaluate(repoPath: string, criteriaFilter?: string[], evaluationRun?: EvaluationRun): Promise<CriterionResult[]>;

  getLanguage(): string;
}

export interface ReportOptions {
  outputHtml?: boolean;
  outputJson?: boolean;
  outputDir?: string;
}

export interface Dependency {
  name: string;
  version: string;
  // Alternative licenses (any one may be chosen), or none declared. An array entry is a set of
  // licenses that all apply together, such as SPDX "MIT AND Zlib".
  licenses?: Array<string | string[]>;
}

export enum LicenseIssueType {
  CATEGORY_X_VIOLATION = 'CATEGORY_X_VIOLATION',
  UNKNOWN_LICENSE = 'UNKNOWN_LICENSE',
  UNDOCUMENTED_CATEGORY_B = 'UNDOCUMENTED_CATEGORY_B',
  NO_LICENSE_INFO = 'NO_LICENSE_INFO',
  PARSER_ERROR = 'PARSER_ERROR'
}

export interface ComplianceIssue {
  dependency: Dependency;
  reason: string;
  issueType: LicenseIssueType;
}

export interface ComplianceResult {
  compliant: boolean;
  issues: ComplianceIssue[];
}

export interface DependencyExtractionError {
  source: string;      // e.g., "maven-parser", "gradle-parser", "path-validation"
  message: string;
  error?: Error;
  commandsDisabled?: boolean; // True when the build command was not run because local commands are off
}

/**
 * Result of dependency extraction including success data and error information
 * Allows callers to distinguish between "no dependencies found" (valid) and "extraction failed" (error)
 */
export interface DependencyExtractionResult {
  dependencies: Dependency[];
  errors: DependencyExtractionError[];      // Fatal errors that prevented extraction
  warnings: DependencyExtractionError[];    // Non-fatal issues (e.g., "no build file found")
}

export interface LicenseCategoriesConfig {
  _description?: string;
  _reference?: string;
  categories: Record<string, string>;
}

export interface SpecialExceptionsConfig {
  _description?: string;
  _note?: string;
  exceptions: Array<{
    name: string;
    description: string;
    matchType: 'exact' | 'prefix';
  }>;
}

export interface DualLicensedConfig {
  _description?: string;
  _reference?: string;
  projects: Array<{
    name: string;
    matchType: 'exact' | 'prefix';
    licenses: string;
    source: string;
  }>;
}

export interface LicenseVariationsConfig {
  _description?: string;
  _source?: string;
  variations: Record<string, string>;
}
