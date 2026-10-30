import { B002Analysis, B002MappedSite, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { handlerPatterns } from './f001-agent-review';
import { F001Pattern } from './f001-consumed-apis';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

export function hasB002AgentReviewMaterial(analysis: B002Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB002WithAgent(
  repoPath: string,
  analysis: B002Analysis,
  patterns: F001Pattern[],
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB002AgentReviewRequest(repoPath, analysis, patterns);
  } catch (error) {
    return { ...unavailableResult('B002'), errors: [redactEvaluatorSecrets(`Unable to prepare B002 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

/**
 * B002's review: follow each undeclared interface's request to the code that sends it, resolve each request the tool
 * could not map and identify the interface of each path not in the handler index, with the index's patterns that
 * share a first path segment as reference; report missed requests to undeclared interfaces as
 * `discovered:interface:<n>`.
 */
export function buildB002AgentReviewRequest(repoPath: string, analysis: B002Analysis, patterns: F001Pattern[]): CriterionAgentReviewRequest {
  const declared = new Set([...analysis.declared.required, ...analysis.declared.optional]);
  const sites = [...analysis.undeclared.flatMap(use => use.sites), ...analysis.unresolvedSites, ...analysis.notInIndexSites];
  return buildBackendAgentReviewRequest({
    criterionId: 'B002',
    repositoryPath: repoPath,
    criterionTitle: 'B002: every interface the module calls is declared in the module descriptor\'s requires or optional',
    checklist: analysis.checklist,
    discoveredKinds: ['interface'],
    browse: backendBrowse(),
    extraFiles: [{ name: 'handler-patterns.json', content: handlerPatterns(analysis.index.descriptorVersion, sites, patterns) }],
    criterionInstructions: [
      `${analysis.templatePath ?? 'The descriptor template'} declares ${declared.size ? [...declared].sort().join(', ') : 'no interfaces'} in requires or optional; the version does not matter here.`,
      'handler-patterns.json lists, for the first path segment of each request in checklist.json, the interfaces of the platform release that serve paths starting with it, with their path patterns ({name} is one segment, * any text).',
      'B002-C1: for each undeclared interface, follow the request at the obligation\'s file and line to the code that calls it (a client built in one class may be used through an accessor elsewhere). aligned_fact when no production code path sends the request (dead code); substantive_concern when production code sends it; evidence_gap when this cannot be established from the source.',
      'B002-C2: for each request the tool could not map, follow the constants, fields, arguments and URI builders the path comes from, and decide which interface it reaches; for each path not in the handler index, identify the interface it belongs to, or the service outside FOLIO it is sent to (such as Keycloak or a knowledge base). aligned_fact when every interface it can reach is declared, or it goes to a service outside FOLIO; substantive_concern when it reaches an undeclared interface; evidence_gap when the path cannot be established from the source.',
      'A substantive_concern must name, in its summary and in backticks, the interface id it believes is undeclared, such as `configuration`: as in handler-patterns.json when the interface is there, otherwise as the target module\'s descriptor names it.',
      'Report requests to FOLIO interfaces the checklist does not list, that go to an undeclared interface, as discovered:interface:<n>, citing the source file.'
    ],
    criterionRule: assessment => assessment.type === 'substantive_concern'
      && ![...assessment.summary.matchAll(/`([a-z][a-z0-9._-]*)`/g)].some(match => !declared.has(match[1]))
      ? 'The potential problem does not name, in backticks, an interface that the descriptor does not declare.' : undefined,
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      const site = (item: B002MappedSite) => ({
        path: item.path, line: item.line, kind: item.kind, ...(item.method ? { method: item.method } : {}),
        ...(item.requestPath !== undefined ? { requestPath: `/${item.requestPath}${item.openEnd ? '…' : ''}` } : {}),
        expression: item.expression, outcome: item.outcome,
        ...(item.unresolved ? { reason: item.unresolved } : {}), ...(item.interfaces.length ? { candidateInterfaces: item.interfaces } : {})
      });
      return {
        criterionId: 'B002',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        handlerIndex: analysis.index,
        templatePath: analysis.templatePath,
        declared: analysis.declared,
        undeclared: list(analysis.undeclared.map(use => ({ id: use.id, requests: list(use.sites.map(site)) }))),
        declaredAndUsed: list(analysis.declaredAndUsed.map(use => ({ id: use.id, requests: use.sites.length }))),
        unresolvedRequests: list(analysis.unresolvedSites.map(site)),
        pathsNotInIndex: list(analysis.notInIndexSites.map(site)),
        requestingLibraries: list(analysis.libraries),
        unreadFiles: list(analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message))
      };
    }
  });
}
