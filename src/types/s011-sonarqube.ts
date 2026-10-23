import { EvaluationStatus } from './index';
import { RemoteEvidenceRecord } from './remote-evidence';
import { SonarCloudSnapshot, SonarRule } from './sonarcloud-snapshot';

export type S011SuppressionKind = 'annotation' | 'nosonar' | 'all';
export type S011AnnotationTarget = 'class' | 'method' | 'field' | 'unknown';

/** One in-source suppression of a Sonar rule. */
export interface S011Suppression {
  kind: S011SuppressionKind;
  /** The Sonar rule key, or the javac warning name, for annotation suppressions. */
  rule?: string;
  /** For a javac warning name (such as "unused"), the Sonar rules sonar-java suppresses with it. */
  appliesTo?: string[];
  path: string;
  line: number;
  target?: S011AnnotationTarget;
  /** A comment on the same line or the two lines above. */
  comment?: string;
  test: boolean;
}

/** A Sonar analysis-scope setting in the repository or its CI. */
export interface S011ScopeSetting {
  key: string;
  value: string;
  path: string;
  line: number;
  /** Where it was set: a build file, sonar-project.properties, or a CI workflow input. */
  source: 'pom' | 'gradle' | 'properties' | 'workflow-input' | 'command-line';
  /** False when it only affects coverage, which S011 does not check. */
  affectsS011: boolean;
  note?: string;
}

export interface S011ScanDiagnostic {
  path?: string;
  message: string;
}

export interface S011SuppressionScan {
  complete: boolean;
  suppressions: S011Suppression[];
  scope: S011ScopeSetting[];
  eslintDisableCount: number;
  filesScanned: number;
  /** Shared FOLIO workflows the repository's CI calls (maven.yml, ui.yml, gradle.yml, ...). */
  sharedWorkflows: string[];
  diagnostics: S011ScanDiagnostic[];
}

/** A group of suppressions or scope settings the advisory agent review assesses as one. */
export interface S011ReviewGroup {
  id: string;
  kind: 'suppression' | 'nosonar' | 'all' | 'scope';
  rule?: string;
  ruleName?: string;
  /** For a javac warning name, the Sonar rules it suppresses. */
  appliesTo?: string[];
  path: string;
  lines: number[];
  /** FOLIO guidance this group does not follow. */
  flags: string[];
  comments: string[];
  settings?: Array<{ key: string; value: string }>;
}

export interface S011Analysis {
  criterionId: 'S011';
  status: EvaluationStatus;
  summary: string;
  remoteLookups: boolean;
  projectKey?: string;
  /** Why SonarCloud was not used: the gate that made the result manual before any finding was judged. */
  gate?: string;
  repositoryCommit?: string;
  snapshot?: Omit<SonarCloudSnapshot, 'remoteEvidence'>;
  /** Each fail rule that holds. */
  violations: string[];
  /** Why the result cannot pass, other than violations. */
  manualReasons: string[];
  scan: S011SuppressionScan;
  reviewGroups: S011ReviewGroup[];
  /** Rule names and whether each is a security rule; report enrichment that never changes the status. */
  rules: Record<string, SonarRule>;
  agentReviewUnavailableReason?: string;
  remoteEvidence: RemoteEvidenceRecord[];
}
