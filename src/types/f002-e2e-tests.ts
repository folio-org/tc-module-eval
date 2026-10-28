import type { EvaluationStatus } from './index';
import type { FrontendChecklist } from './frontend-checklist';
import type { S007VersionComparison } from './s007-officially-supported-technologies';

/** The browser test tools F002 recognizes; `unrecognized` is a test/e2e directory without any of them. */
export type F002FrameworkId =
  | 'cypress'
  | 'playwright'
  | 'webdriverio'
  | 'nightwatch'
  | 'testcafe'
  | 'puppeteer'
  | 'nightmare'
  | 'karma'
  | 'bigtest'
  | 'unrecognized';

/**
 * `supported`: on the officially supported technologies page; `unsupported`: an end-to-end framework that is not;
 * `unclear`: browser tests that may be component tests or end-to-end tests.
 */
export type F002Support = 'supported' | 'unsupported' | 'unclear';

/** Where a framework was seen: a dependency, a configuration file, a test directory, a package.json script or CI. */
export interface F002Evidence {
  kind: 'dependency' | 'configuration' | 'directory' | 'script' | 'ci';
  /** A repository file, or a directory with a trailing slash. */
  path: string;
  line?: number;
  detail: string;
}

export interface F002Framework {
  id: F002FrameworkId;
  displayName: string;
  support: F002Support;
  evidence: F002Evidence[];
}

/** Cypress's version against the policy minimum: the yarn.lock version when the lockfile resolves the range, else the range. */
export interface F002CypressVersion {
  resolved?: string;
  comparison: S007VersionComparison;
  /** e.g. `13.6.0 (yarn.lock)` or `^13.6.0 (package.json, no yarn.lock)`. */
  text: string;
}

export interface F002Analysis {
  criterionId: 'F002';
  status: EvaluationStatus;
  summary: string;
  frameworks: F002Framework[];
  /** Present when Cypress was found. */
  cypress?: F002CypressVersion;
  /** The `frontend-integration-testing` entry for Cypress. */
  policy: { loaded: boolean; sourceStatement?: string; minimum?: string; strength?: string; problem?: string };
  /** The CI files read: `.github/workflows/*.yml` and `Jenkinsfile`. */
  ciFiles: string[];
  /** Files the tool could not read or parse. `material` ones may hide a framework, so they block pass and not applicable. */
  unread: Array<{ path?: string; message: string; material: boolean }>;
  /** The paths an agent review may browse, as shown to the agent and the reader. */
  agentBrowseScope: string;
  agentReviewUnavailableReason?: string;
  checklist: FrontendChecklist;
}
