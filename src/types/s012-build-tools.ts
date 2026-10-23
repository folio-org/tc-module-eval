import type { S007PolicyDiagnostic, S007PolicySectionId, S007RuleStrength, S007VersionConstraint } from './s007-officially-supported-technologies';

// ---- FOLIO shared-workflow table (config/folio-shared-workflows.json) ----

export interface FolioRecordedToolVersion {
  version: string;
  /** Where a maintainer read the version, such as a runner image release. */
  source: string;
  recordedAt: string;
}

export interface FolioSharedWorkflow {
  /** The build tool the workflow runs. */
  buildTool: 'maven' | 'gradle' | 'yarn';
  runner?: string;
  maven?: FolioRecordedToolVersion;
  /** Gradle comes from the repository's wrapper. */
  gradle?: 'wrapper';
  gradleDirectory?: string;
  /** The Node.js version the workflow installs unless the caller sets node-version. */
  node?: string;
  yarn?: FolioRecordedToolVersion;
  java?: string;
  docker?: boolean;
  sonar?: boolean;
  sonarSources?: string[];
  sonarExclusions?: string[];
}

export interface FolioSharedWorkflowTable {
  formatVersion: '1.0';
  source: string;
  ref: string;
  reviewedCommit?: string;
  reviewedAt: string;
  notes?: string[];
  workflows: Record<string, FolioSharedWorkflow>;
}

export type FolioSharedWorkflowTableLoadResult =
  | { ok: true; table: FolioSharedWorkflowTable; sourcePath: string; diagnostics: [] }
  | { ok: false; sourcePath: string; diagnostics: S007PolicyDiagnostic[] };

// ---- Build evidence (src/utils/build-test-evidence.ts) ----

export type BuildFileKind =
  | 'maven-pom'
  | 'maven-wrapper'
  | 'gradle-build'
  | 'gradle-wrapper'
  | 'package-json'
  | 'yarn-lock'
  | 'package-lock'
  | 'pnpm-lock'
  | 'yarnrc-yml'
  | 'nvmrc'
  | 'node-version-file'
  | 'makefile'
  | 'go-mod'
  | 'dockerfile'
  | 'sbt'
  | 'bazel'
  /** A root file named exactly Jenkinsfile, which Jenkins runs. */
  | 'jenkinsfile'
  /** Jenkinsfile-disabled, Jenkinsfile.deprecated and other Jenkinsfile.* names, which community CI does not run. */
  | 'jenkinsfile-inactive';

export interface BuildFile {
  kind: BuildFileKind;
  path: string;
}

export type BuildToolId = 'maven' | 'gradle' | 'node' | 'yarn' | 'npm' | 'pnpm' | 'make' | 'go' | 'sbt' | 'bazel';

export type VersionDeclarationSource =
  | 'maven-wrapper'
  | 'maven-enforcer'
  | 'gradle-wrapper'
  | 'nvmrc'
  | 'node-version-file'
  | 'engines-node'
  | 'package-manager-field'
  | 'yarn-lock'
  | 'yarnrc-yarn-path'
  | 'workflow-input'
  | 'setup-node'
  | 'setup-maven';

/** A version of a build tool as the repository writes it. S012 turns each kind into a range. */
export interface VersionDeclaration {
  tool: BuildToolId;
  source: VersionDeclarationSource;
  path: string;
  /** Where in the file, such as "distributionUrl" or "job build, actions/setup-node". */
  detail: string;
  /** The value as written, or for yarn.lock "v1" or "berry". */
  text: string;
  /**
   * A Maven Enforcer rule that does not run ("inactive", reported only) or whose activation this POM does not show
   * ("uncertain": it cannot help a pass, and a violation needs review instead of failing).
   */
  activation?: { state: 'inactive' | 'uncertain'; reason: string };
}

/** A job that calls one of FOLIO's reusable workflows, folio-org/.github/.github/workflows/<name>@<ref>. */
export interface SharedWorkflowUse {
  path: string;
  job: string;
  name: string;
  ref: string;
  /** Its with: inputs that are plain values. */
  inputs: Record<string, string>;
}

/** A build command an inline workflow step runs in the repository root (or service/). */
export interface BuildCommand {
  path: string;
  job: string;
  tool: BuildToolId;
  command: string;
}

export interface BuildEvidenceDiagnostic {
  code: 'file_too_large' | 'symlink_not_followed' | 'outside_repository' | 'read_error' | 'malformed' | 'file_limit' | 'command_limit' | 'value_unreadable';
  message: string;
  path?: string;
  /** A material problem leaves the evidence incomplete. */
  material: boolean;
}

export interface BuildTestEvidence {
  files: BuildFile[];
  declarations: VersionDeclaration[];
  workflowFiles: string[];
  sharedWorkflows: SharedWorkflowUse[];
  buildCommands: BuildCommand[];
  diagnostics: BuildEvidenceDiagnostic[];
  filesRead: string[];
  complete: boolean;
}

// ---- S012 analysis ----

export type S012ToolRole = 'primary' | 'secondary' | 'incidental' | 'coverage';

export type S012FindingClassification =
  | 'compliant'
  | 'unlisted-tool'
  | 'version-violation'
  | 'version-unsettled'
  | 'conflicting'
  | 'provisional'
  | 'contested'
  | 'advisory'
  | 'legacy-ci'
  | 'not-used'
  | 'coverage-incomplete'
  | 'note';

export type S012VersionComparison = 'compliant' | 'noncompliant' | 'overlap' | 'unresolved';

export interface S012VersionCheck {
  /** Plain-English label, such as "Maven wrapper" or "maven-enforcer-plugin requireMavenVersion". */
  label: string;
  path?: string;
  text: string;
  /** The versions the declaration allows, as a semver range; absent when it could not be read. */
  range?: string;
  /** A pin selects the version; a requirement only rejects others. */
  kind: 'pin' | 'requirement';
  /** The version comes from FOLIO's shared workflow, not the repository. */
  inherited?: { workflow: string; ref: string; source?: string; recordedAt?: string };
  comparison: S012VersionComparison;
  /** See VersionDeclaration.activation. */
  activation?: { state: 'inactive' | 'uncertain'; reason: string };
}

export interface S012MatchedPolicy {
  sectionId: S007PolicySectionId;
  entryId: string;
  displayName: string;
  strength: S007RuleStrength;
  sourceStatement: string;
  constraint?: S007VersionConstraint;
}

export interface S012Finding {
  toolId: string;
  displayName: string;
  role: S012ToolRole;
  classification: S012FindingClassification;
  contribution: 'pass' | 'manual' | 'fail' | 'note';
  /** One plain-English sentence or two; used as the status reason when this finding decides it. */
  rationale: string;
  files: string[];
  /** How the build reaches the tool, such as "FOLIO's maven.yml@v1 workflow (.github/workflows/maven.yml)". */
  via?: string;
  versions: S012VersionCheck[];
  matchedPolicy?: S012MatchedPolicy;
  statusDetermining: boolean;
}

export interface S012AnalysisResult {
  criterionId: 'S012';
  status: 'pass' | 'fail' | 'manual';
  summary: string;
  area: 'frontend' | 'backend';
  findings: S012Finding[];
  policy?: { sourcePath: string; title?: string; documentStatus?: string; exportDate?: string };
  sharedWorkflowTable?: { sourcePath: string; ref: string; reviewedAt: string };
  policyDiagnostics: S007PolicyDiagnostic[];
  evidence: BuildTestEvidence;
}
