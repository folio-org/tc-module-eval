import { EvaluationStatus, ModuleKind } from './index';
import { RemoteEvidenceRecord } from './remote-evidence';

export type S014ApplicationTier = 'required' | 'optional' | 'experimental';

/** One platform application and the modules its FAR descriptor lists. */
export interface S014PlatformApplication {
  name: string;
  version?: string;
  tier?: S014ApplicationTier;
  /** Module and UI module names with versions; absent when the descriptor could not be read. */
  modules?: Array<{ name: string; version: string }>;
  /** Why the application could not be read, or read completely. */
  problem?: string;
}

/** The platform-lsp descriptor at one commit and its applications from FAR; the same for every module. */
export interface S014PlatformSnapshot {
  platformRef: string;
  platformCommit?: string;
  platformVersion?: string;
  /** Why the platform descriptor could not be read. */
  problem?: string;
  applications: S014PlatformApplication[];
  remoteEvidence: RemoteEvidenceRecord[];
}

export interface S014ModuleName {
  name?: string;
  source?: 'descriptor' | 'pom' | 'package' | 'repository';
  /** Repository path the name came from. */
  path?: string;
  /** Why no name could be determined. */
  problem?: string;
}

export interface S014Membership {
  application: string;
  version: string;
  tier: S014ApplicationTier;
  moduleVersion: string;
}

/** The named application's own template, read only when the module is in no platform application. */
export interface S014TemplateCheck {
  application: string;
  url: string;
  listsModule?: boolean;
  problem?: string;
}

export interface S014Analysis {
  criterionId: 'S014';
  status: EvaluationStatus;
  summary: string;
  moduleKind: ModuleKind;
  moduleName?: S014ModuleName;
  /** The application named for this evaluation (--application). */
  application?: string;
  remoteLookups: boolean;
  platform?: {
    ref: string;
    commit?: string;
    version?: string;
    applicationCount: number;
    problem?: string;
  };
  memberships: S014Membership[];
  /** Platform applications that could not be read completely. */
  unresolvedApplications: Array<{ name: string; version?: string; tier?: S014ApplicationTier; problem: string }>;
  /** Whether the named application is one of the platform's applications. */
  applicationOnPlatform?: boolean;
  namedApplicationTemplate?: S014TemplateCheck;
  remoteEvidence: RemoteEvidenceRecord[];
}
