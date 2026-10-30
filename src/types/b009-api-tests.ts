import type { EvaluationStatus } from './index';
import type { BackendRepositoryKind } from './backend-evidence';
import type { FrontendChecklist } from './frontend-checklist';
import type { RemoteEvidenceRecord } from './remote-evidence';
import type { S014ModuleName } from './s014-application-assignment';

/** `feature-files`: Gherkin `.feature` files without Karate evidence, which may be Cucumber or Karate tests. */
export type B009FrameworkId = 'karate' | 'postman' | 'bruno' | 'insomnia' | 'feature-files';

/** Against the `backend-integration-testing` section of the officially supported technologies policy. */
export type B009Support = 'supported' | 'unlisted' | 'unclear';

export interface B009Suite {
  source: 'repository' | 'folio-integration-tests';
  framework: B009FrameworkId;
  displayName: string;
  support: B009Support;
  /** At most 20; folio-integration-tests paths start with the folder name. */
  files: string[];
  fileCount: number;
  /** The `karate-config.js` that makes `.feature` files Karate tests. */
  configFile?: string;
}

/**
 * The lookup of a folio-integration-tests folder named after the module: `no-folder` only when the top-level listing
 * was read completely; `unread` when the listing or the folder's tree could not be read completely.
 */
export interface B009IntegrationTestsLookup {
  folder: string;
  outcome: 'folder' | 'no-folder' | 'unread';
  problem?: string;
  featureFiles: string[];
  featureFileCount: number;
  karateConfig?: string;
}

export type B009Basis =
  | 'library'
  | 'ambiguous'
  | 'unlisted-framework'
  | 'karate'
  | 'unclear-suites'
  | 'policy-unavailable'
  | 'incomplete'
  | 'lookups-off'
  | 'no-tests';

export interface B009Analysis {
  criterionId: 'B009';
  status: EvaluationStatus;
  summary: string;
  basis: B009Basis;
  kind: BackendRepositoryKind;
  remoteLookups: boolean;
  moduleName?: S014ModuleName;
  suites: B009Suite[];
  integrationTests?: B009IntegrationTestsLookup;
  policy: { loaded: boolean; displayName?: string; strength?: string; provisional?: boolean; problem?: string };
  unread: Array<{ path?: string; message: string }>;
  remoteEvidence: RemoteEvidenceRecord[];
  checklist: FrontendChecklist;
}
