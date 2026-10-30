import { BackendDescriptorTemplate, FrontendChecklistItem, FrontendChecklistObligation } from '../types';
import { templateLineOf } from './backend-evidence';
import { CriterionAgentReviewRequest } from './criterion-agent-review';
import { isSystemInterface } from './descriptor-handlers';
import { buildFrontendAgentReviewRequest, FrontendAgentReviewOptions, FrontendChecklistItemDraft, numberObligations } from './frontend-agent-review';
import { isRecord } from './type-guards';

export const BACKEND_AGENT_TIMEOUT_MS = 600_000;

const BROWSED = [
  /(?:^|\/)src\/main\/(?:java|groovy|kotlin|resources)\//,
  /(?:^|\/)grails-app\//,
  /(?:^|\/)ramls\//,
  /^descriptors\//,
  /(?:^|\/)ModuleDescriptor[^/]*\.json$/i,
  /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/,
  /^(?:README[^/]*|ENV_VARS\.md|Dockerfile|docker-compose[^/]*)$/i
];
const NOT_BROWSED = /(?:^|\/)(?:ref-data|reference-data|sample-data|sample_data|raml-util)\//;

const BACKEND_BROWSE_SCOPE = 'Java, Groovy and Kotlin sources and resources under src/main/ in any module folder (no reference or sample data), '
  + 'grails-app/, descriptors/ and the descriptor template, ramls/ (no raml-util), pom.xml and build.gradle files, '
  + 'and README, ENV_VARS.md, Dockerfile and docker-compose files at the root';

/**
 * The shared B00x browse scope, as a path filter and as stated to the agent and the reader, plus the criterion's own
 * paths (B010 and B011: templates/db_scripts/ and Liquibase changelogs; B008: reference-data listings).
 */
export function backendBrowse(extra?: { include: (path: string) => boolean; scope: string }): { include: (path: string) => boolean; scope: string } {
  return {
    include: path => extra?.include(path) || (!NOT_BROWSED.test(path) && BROWSED.some(pattern => pattern.test(path))),
    scope: extra ? `${BACKEND_BROWSE_SCOPE}, ${extra.scope}` : BACKEND_BROWSE_SCOPE
  };
}

const FLAG_RANK: Record<NonNullable<FrontendChecklistObligation['flag']>, number> = { fail: 0, manual: 1 };

function backendObligationOrder(a: FrontendChecklistObligation, b: FrontendChecklistObligation): number {
  const rank = (obligation: FrontendChecklistObligation) => obligation.flag ? FLAG_RANK[obligation.flag] : 2;
  const pathA = a.path ?? '\uffff';
  const pathB = b.path ?? '\uffff';
  return rank(a) - rank(b) || (pathA < pathB ? -1 : pathA > pathB ? 1 : 0)
    || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Number a B criterion's obligations as for F criteria, but give the agent the subjects the tool flagged first (failing,
 * then manual), then the rest by path and line, before whole-item obligations; the rest past the limit of 25 are withheld.
 */
export function numberBackendObligations(drafts: FrontendChecklistItemDraft[]): FrontendChecklistItem[] {
  return numberObligations(drafts, backendObligationOrder);
}

/** A non-system interface of the template's `provides`, as one obligation subject for all of its handlers. */
export interface InterfaceSubject {
  interfaceId: string;
  /** Its index in `provides`. */
  index: number;
  /** `interface users (#/provides/3)`. */
  subject: string;
  path: string;
  line?: number;
}

/**
 * One subject per non-system interface the template provides, at the line where it starts, so an obligation covers
 * an interface's handlers together.
 */
export function providedInterfaceSubjects(template: BackendDescriptorTemplate): InterfaceSubject[] {
  const provides = isRecord(template.descriptor) && Array.isArray(template.descriptor.provides) ? template.descriptor.provides : [];
  const lineOf = templateLineOf(template);
  return provides.flatMap((provided, index) => {
    if (!isRecord(provided) || isSystemInterface(provided)) return [];
    const interfaceId = String(provided.id);
    const line = lineOf(`/provides/${index}`);
    return [{ interfaceId, index, subject: `interface ${interfaceId} (#/provides/${index})`, path: template.path, ...(line ? { line } : {}) }];
  });
}

export type BackendAgentReviewOptions = Omit<FrontendAgentReviewOptions, 'browseInclude' | 'browseScope' | 'defaultTimeoutMs' | 'examplePaths'> & {
  /** From backendBrowse, with the criterion's own paths. */
  browse: ReturnType<typeof backendBrowse>;
};

/**
 * A B00x agent review request: the F00x contract (checklist obligations, 48 KB evidence summary, example response,
 * item-by-item validation that drops an invalid item on its own) with the backend browse scope and the 600 s default
 * timeout.
 */
export function buildBackendAgentReviewRequest(options: BackendAgentReviewOptions): CriterionAgentReviewRequest {
  const { browse, ...rest } = options;
  return buildFrontendAgentReviewRequest({
    ...rest,
    browseInclude: browse.include,
    browseScope: browse.scope,
    defaultTimeoutMs: BACKEND_AGENT_TIMEOUT_MS,
    examplePaths: ['src/main/java/org/folio/actual/SourceFile.java', 'src/main/java/org/folio/other/SourceFile.java']
  });
}
