import type { EvaluationStatus, ModuleKindResult } from './index';
import type { FrontendChecklist } from './frontend-checklist';
import type { S007EvidenceDiagnostic, S007PolicyDiagnostic, S007TechnologyFinding } from './s007-officially-supported-technologies';

/**
 * What F005 decided from:
 * - `s007-finding`: S007's own finding for `@folio/stripes`, whose outcome F005 takes over;
 * - `constituent-library`: a library without an `@folio/stripes` dependency, i.e. part of Stripes itself;
 * - `stripes-missing`: a module without an `@folio/stripes` dependency;
 * - `manifest-unreadable`: S007 could not read package.json;
 * - `policy-unavailable`: the officially supported technologies list could not be loaded.
 */
export type F005Basis = 's007-finding' | 'constituent-library' | 'stripes-missing' | 'manifest-unreadable' | 'policy-unavailable';

export interface F005Analysis {
  criterionId: 'F005';
  status: EvaluationStatus;
  summary: string;
  basis: F005Basis;
  /** The policy rule, e.g. "Stripes 10.1 or greater"; absent when the policy did not load or has no Stripes entry. */
  policyRule?: string;
  /** S007's findings for `@folio/stripes`, exactly as S007 reports them. */
  stripesFindings: S007TechnologyFinding[];
  /** Present when the module kind decided the result (no `@folio/stripes` dependency). */
  moduleKind?: ModuleKindResult;
  policyDiagnostics: S007PolicyDiagnostic[];
  /** S007's reasons for not reading package.json, when it could not. */
  manifestDiagnostics: S007EvidenceDiagnostic[];
  checklist: FrontendChecklist;
}
