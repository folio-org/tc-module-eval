import { EvaluationStatus } from './index';
import { RemoteEvidenceRecord } from './remote-evidence';
import { S007PolicyDiagnostic } from './s007-officially-supported-technologies';
import { BuildEvidenceDiagnostic, TestTechnologyKind } from './s012-build-tools';
import { S011ScopeSetting } from './s011-sonarqube';
import { SonarProjectSetting } from './sonarcloud-snapshot';

/** One half of S013: "ok" lets the criterion pass, "manual" and "fail" decide it. */
export type S013HalfOutcome = 'ok' | 'manual' | 'fail';

/** SonarCloud's coverage figures for the evaluated commit, and what they mean for S013. */
export interface S013Coverage {
  outcome: S013HalfOutcome;
  /** Why: no-lookups (remote lookups off), no-project, unreadable, stale, no-measures, nothing-to-cover, below, meets. */
  reason: 'no-lookups' | 'no-project' | 'unreadable' | 'stale' | 'no-measures' | 'nothing-to-cover' | 'below' | 'meets';
  /** One or two plain-English sentences; the start of the summary. */
  rationale: string;
  projectKey?: string;
  branch?: string;
  requestedBranchNotAnalysed?: string;
  analysis?: { date: string; revision?: string };
  /** Whether the analysis is of the evaluated commit; absent when there is no analysis. */
  fresh?: boolean;
  /** The SonarCloud measures read, by metric key. A metric SonarCloud did not return is absent. */
  measures: Record<string, number>;
  /** FOLIO shared workflows the repository builds with that do not run SonarCloud, such as gradle.yml. */
  workflowsWithoutSonar?: string[];
}

/** One test technology, with every declaration that shows it. */
export interface S013TechnologyFinding {
  id: string;
  displayName: string;
  kind: TestTechnologyKind;
  /** Whether the supported-technologies page lists it in its testing sections for this area. */
  listed: boolean;
  /** The policy statement that lists it, such as "Jest should be 29 or greater". */
  policyStatement?: string;
  /** The declared dependencies that show it, with their files. */
  declarations: Array<{ dependency: string; path: string; scope: string }>;
  /** Versions yarn.lock resolves (Jest and React Testing Library only). */
  versions?: string[];
  /** Policy advice for an older version; advisory, never changes the status. */
  recommendation?: string;
}

export interface S013Technologies {
  outcome: Exclude<S013HalfOutcome, 'fail'>;
  /** One plain-English sentence; the end of the summary. */
  rationale: string;
  findings: S013TechnologyFinding[];
}

/** The sources and exclusions a FOLIO shared workflow passes to the SonarCloud scanner. */
export interface S013WorkflowScope {
  /** Such as ui.yml@v1. */
  workflow: string;
  path: string;
  /** Absent when the workflow does not set the value. `input` means the caller's with: value replaced the default. */
  sources?: { patterns: string[]; input: boolean };
  exclusions?: { patterns: string[]; input: boolean };
  /** The shared-workflow table does not cover this workflow at this ref (or could not be loaded). */
  unknown?: true;
}

/**
 * What SonarCloud's coverage figure leaves out, as far as the tool can see: the analysis-scope settings S011's scan
 * finds in the repository, what FOLIO's shared workflows pass to the scanner, and SonarCloud's own project settings
 * when they could be read. Shown for review only.
 */
export interface S013CoverageScope {
  /** Settings in build files, properties files and -D options; shared-workflow inputs are in `workflows`. */
  settings: S011ScopeSetting[];
  workflows: S013WorkflowScope[];
  /** SonarCloud's project settings, when SONAR_TOKEN could read them; absent otherwise. */
  projectSettings?: SonarProjectSetting[];
  /** Whether S011's scan read every file that can set the analysis scope. */
  complete: boolean;
}

export interface S013Analysis {
  criterionId: 'S013';
  status: EvaluationStatus;
  summary: string;
  area: 'frontend' | 'backend';
  remoteLookups: boolean;
  coverage: S013Coverage;
  technologies: S013Technologies;
  /** Read only when SonarCloud has the project, so there is a coverage figure to qualify. */
  coverageScope?: S013CoverageScope;
  policy?: { sourcePath: string; title?: string; documentStatus?: string; exportDate?: string };
  policyDiagnostics: S007PolicyDiagnostic[];
  /** Problems reading the test declarations. */
  evidenceDiagnostics: BuildEvidenceDiagnostic[];
  remoteEvidence: RemoteEvidenceRecord[];
}
