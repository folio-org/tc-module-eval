import { RemoteEvidenceRecord } from './remote-evidence';

// The SonarCloud snapshot S011 and S013 share (src/utils/sonarcloud-snapshot.ts).

/** An open issue as SonarCloud listed it, kept as a report example. */
export interface SonarIssueExample {
  rule: string;
  /** Repository path, without the project key prefix. */
  path?: string;
  line?: number;
  /** The highest severity among the issue's impacts. */
  severity?: string;
  message?: string;
  test: boolean;
}

/**
 * A count SonarCloud reported. `total` is absent when it could not be read, and `problem` says why; a missing
 * count is never zero.
 */
export interface SonarCount {
  total?: number;
  problem?: string;
}

export interface SonarIssueQuery extends SonarCount {
  /** Up to the listed page; counts come from `total`, never from this list. */
  examples: SonarIssueExample[];
  /** How many issues the listing covered (at most the page size). */
  listed?: number;
}

export interface SonarHighIssueQuery extends SonarIssueQuery {
  /** Open HIGH/BLOCKER issues per rule, from the rules facet. */
  rules?: Array<{ rule: string; count: number }>;
  /** Main and test code split of the listed issues. */
  mainCount?: number;
  testCount?: number;
}

export interface SonarHotspotQuery extends SonarCount {
  /** Listed hotspots grouped by probability and category. */
  groups: Array<{ probability: string; category: string; count: number }>;
  examples: Array<{ rule?: string; path?: string; line?: number; probability?: string; category?: string }>;
  listed?: number;
}

export interface SonarRule {
  name: string;
  /** A vulnerability or hotspot rule, or one with a security impact. */
  security: boolean;
}

export interface SonarProjectSetting {
  key: string;
  value: string;
  /** Where SonarCloud says the value comes from: PROJECT, or the organization it inherits from. */
  origin: string;
}

/** SonarCloud's own project settings (Administration > Analysis Scope), readable only with an admin token. */
export interface SonarProjectSettings {
  read: boolean;
  /** Why they were not read. */
  problem?: string;
  values: SonarProjectSetting[];
}

/** One SonarCloud project's latest analysis on one branch; shared by S011 and S013. */
export interface SonarCloudSnapshot {
  projectKey: string;
  /** Set once components/show answered: whether SonarCloud has the project. */
  projectFound?: boolean;
  /** Why the project, its branch or its latest analysis could not be read. */
  problem?: string;
  branch?: string;
  branchIsMain?: boolean;
  /** The --branch value when SonarCloud has no analysis of it, so the main branch was read instead. */
  requestedBranchNotAnalysed?: string;
  analysis?: { key: string; date: string; revision?: string };
  /** The latest analysis again, read after every other request. */
  recheck?: { key?: string; date?: string; revision?: string; problem?: string };
  /** Metrics SonarCloud returned, by key. A metric it did not return is absent, never 0. */
  measures: Record<string, number>;
  measuresProblem?: string;
  securityIssues: SonarIssueQuery;
  vulnerabilities: SonarCount;
  highIssues: SonarHighIssueQuery;
  ignoredIssues: SonarIssueQuery & { statuses?: Record<string, number> };
  hotspotsToReview: SonarHotspotQuery;
  hotspotsSafe: SonarHotspotQuery;
  qualityProfiles?: Array<{ language: string; name: string; isDefault: boolean }>;
  qualityProfilesProblem?: string;
  settings: SonarProjectSettings;
  remoteEvidence: RemoteEvidenceRecord[];
}

export type SonarFreshness =
  | { fresh: true }
  | { fresh: false; reason: 'no-analysis' | 'unknown-commit' | 'no-revision' | 'different-commit' | 'recheck-failed' | 'reanalysed'; message: string };
