import type { EvaluationStatus } from './index';
import type { FrontendChecklist } from './frontend-checklist';
import type { F003HardCodedText } from './f003-internationalization';
import type { UiRuntimeEvidence } from './ui-runtime-evidence';
import type { CommittedSourceDiagnostic } from '../utils/committed-source';

export interface F004SourceSite {
  path: string;
  line: number;
}

export interface F004DisabledRule extends F004SourceSite {
  rule: string;
}

export interface F004ClickHandler extends F004SourceSite {
  element: string;
  keyboardHandler: boolean;
}

export interface F004Analysis {
  criterionId: 'F004';
  status: EvaluationStatus;
  summary: string;
  rendersUi: boolean;
  uiFileCount: number;
  productionFileCount: number;
  packageName?: string;
  packageVersion?: string;
  axeTests: { files: string[]; testFileCount: number };
  lint: { configFiles: string[]; stripesConfigFiles: string[]; stripesConfigVersion?: string };
  disabledRules: F004DisabledRule[];
  imagesWithoutAlt: F004SourceSite[];
  clickHandlers: F004ClickHandler[];
  hardCodedAriaLabels: F003HardCodedText[];
  runtime: UiRuntimeEvidence;
  guides: {
    loaded: boolean;
    repository?: string;
    commit?: string;
    committedAt?: string;
    sourceDirectory?: string;
    fileCount: number;
    problem?: string;
  };
  parseErrorFiles: string[];
  sourceDiagnostics: CommittedSourceDiagnostic[];
  agentBrowseScope: string;
  agentReviewUnavailableReason?: string;
  checklist: FrontendChecklist;
}
