import type { EvaluationStatus } from './index';
import type { S007MatchedPolicyEntry, S007PolicyDiagnostic, S007VersionComparison } from './s007-officially-supported-technologies';

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
  /** For a workflow declaration, the job that sets it. */
  job?: string;
  /**
   * A declaration the build does not apply ("inactive", reported only), such as a Maven Enforcer rule that does not
   * run or a Node version set in a CI job that does not build the module; or one whose activation the repository
   * does not show ("uncertain": it cannot help a pass, and a violation needs review instead of failing).
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
  code: 'file_too_large' | 'symlink_not_followed' | 'outside_repository' | 'read_error' | 'malformed' | 'file_limit' | 'command_limit' | 'value_unreadable' | 'not_read';
  message: string;
  path?: string;
  /** A material problem leaves the evidence incomplete. */
  material: boolean;
}

/**
 * What a test dependency is for S013: a unit-test runner, a testing library the supported-technologies page lists
 * (React Testing Library, REST Assured, Testcontainers), a helper the page does not govern (Mockito, AssertJ), or an
 * integration or end-to-end tool that does not count for unit tests (Cypress, Karate).
 */
export type TestTechnologyKind = 'runner' | 'library' | 'helper' | 'integration';

/** One dependency declaration that shows a test technology. */
export interface TestTechnologyDeclaration {
  /** The technology, such as junit, jest, spock or react-testing-library. */
  id: string;
  displayName: string;
  kind: TestTechnologyKind;
  ecosystem: 'java' | 'javascript';
  /** The declared dependency, such as org.junit.jupiter:junit-jupiter or @folio/jest-config-stripes. */
  dependency: string;
  path: string;
  /** Maven scope, Gradle configuration or package.json field. */
  scope: string;
  /**
   * JavaScript only: the versions yarn.lock resolves for the technology's own package (jest,
   * @testing-library/react), wherever it sits in the tree. Absent when there is no readable Yarn 1 lockfile.
   */
  versions?: string[];
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
  /** Test technologies from test-scope declarations (S013). */
  testTechnologies: TestTechnologyDeclaration[];
  /** Problems reading the test declarations. Kept apart from `diagnostics` so they cannot change S012. */
  testDiagnostics: BuildEvidenceDiagnostic[];
  /** Whether every manifest that can declare test dependencies was read. */
  testComplete: boolean;
}

/** The build half of the evidence, which S012 reads and reports. */
export type BuildEvidence = Omit<BuildTestEvidence, 'testTechnologies' | 'testDiagnostics' | 'testComplete'>;

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
  comparison: S007VersionComparison;
  /** See VersionDeclaration.activation. */
  activation?: { state: 'inactive' | 'uncertain'; reason: string };
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
  matchedPolicy?: S007MatchedPolicyEntry;
  statusDetermining: boolean;
}

export interface S012AnalysisResult {
  criterionId: 'S012';
  status: EvaluationStatus.PASS | EvaluationStatus.FAIL | EvaluationStatus.MANUAL;
  summary: string;
  area: 'frontend' | 'backend';
  findings: S012Finding[];
  policy?: { sourcePath: string; title?: string; documentStatus?: string; exportDate?: string };
  sharedWorkflowTable?: { sourcePath: string; ref: string; reviewedAt: string };
  policyDiagnostics: S007PolicyDiagnostic[];
  evidence: BuildEvidence;
}
