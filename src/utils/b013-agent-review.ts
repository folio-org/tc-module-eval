import { B013Analysis, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

export function hasB013AgentReviewMaterial(analysis: B013Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB013WithAgent(
  repoPath: string,
  analysis: B013Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB013AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return { ...unavailableResult('B013'), errors: [redactEvaluatorSecrets(`Unable to prepare B013 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

/**
 * B013's review: whether requests, and work outside requests, select tenant content by X-Okapi-Tenant. One obligation
 * for request handling as a whole, one per possible tenant problem the tool listed, and one per file with a Kafka
 * consumer or a scheduled job.
 */
export function buildB013AgentReviewRequest(repoPath: string, analysis: B013Analysis): CriterionAgentReviewRequest {
  return buildBackendAgentReviewRequest({
    criterionId: 'B013',
    repositoryPath: repoPath,
    criterionTitle: 'B013: the module responds with tenant-specific content, selected by the X-Okapi-Tenant header',
    checklist: analysis.checklist,
    discoveredKinds: [],
    browse: backendBrowse(),
    criterionInstructions: [
      'Okapi and Kong send the tenant of every request in X-Okapi-Tenant. A module must take the tenant from that header, directly or through its framework, and use it to choose the data it reads and writes and the tenant of the calls it makes: '
        + 'folio-spring-base\'s FolioExecutionContext, RMB\'s okapiHeaders with TenantTool and PgUtil, grails-okapi\'s OkapiTenantResolver with GORM\'s Tenants. An edge module maps each API key to a tenant through edge-common and sends that tenant on in X-Okapi-Tenant.',
      'B013-C1 is about request handling as a whole: read a representative sample of request handlers (controllers, RMB resource classes in org.folio.rest.impl, router handlers) and follow each to its storage and outbound calls. '
        + 'aligned_fact when they use the tenant from the request; substantive_concern, with the handler, when one uses a fixed, configured, default or cached tenant instead. Say in the summary which handlers you read. '
        + 'In an edge module, aligned_fact when each handler takes the tenant of the request\'s API key through edge-common and sends it on in X-Okapi-Tenant.',
      'B013-C2: for each listed site, decide whether a tenant from configuration or shared state selects tenant content there. '
        + 'Not a problem, as analyzer_limitation with the reason: a tenant used only for the module\'s own setup or system user, an edge module\'s API key store, a value only used in local development, '
        + 'a cache whose key is already tenant-specific (an index or schema name that includes the tenant) or holds data that is the same for every tenant. Cite the file of the site.',
      'B013-C3: for each Kafka consumer or scheduled job, decide whether it sets the tenant before it touches tenant data: from the message (a header or the payload), or by running once per enabled tenant with the tenant set for each. '
        + 'A job that runs once for the whole module and reads tenant data without setting a tenant is a substantive_concern. Cite the file of the consumer or job.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      return {
        criterionId: 'B013',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        repositoryKind: analysis.kind,
        framework: analysis.framework,
        tenantFromHeader: analysis.mechanisms.map(uses => ({ ...uses, sites: list(uses.sites) })),
        possibleTenantProblems: { ...list(analysis.redFlags), ...(analysis.redFlagCount > analysis.redFlags.length ? { notListed: analysis.redFlagCount - analysis.redFlags.length } : {}) },
        workOutsideRequests: analysis.asyncWork.map(uses => ({ ...uses, sites: list(uses.sites) })),
        unreadFiles: list(analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message))
      };
    }
  });
}
