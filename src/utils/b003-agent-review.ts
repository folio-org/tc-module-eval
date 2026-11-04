import { B003Analysis, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

export function hasB003AgentReviewMaterial(analysis: B003Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB003WithAgent(
  repoPath: string,
  analysis: B003Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB003AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return { ...unavailableResult('B003'), errors: [redactEvaluatorSecrets(`Unable to prepare B003 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

/**
 * B003's review: one B003-C1 obligation per endpoint the tool could not match to an implementation, except those a
 * library serves (B003-C2, reviewer only, since the library's source is not in the repository).
 */
export function buildB003AgentReviewRequest(repoPath: string, analysis: B003Analysis): CriterionAgentReviewRequest {
  return buildBackendAgentReviewRequest({
    criterionId: 'B003',
    repositoryPath: repoPath,
    criterionTitle: 'B003: every endpoint the module provides has an executable implementation',
    checklist: analysis.checklist,
    discoveredKinds: [],
    browse: backendBrowse(),
    criterionInstructions: [
      'Each B003-C1 obligation is one method and path from the module descriptor template (or, for an edge module, its API spec) that the tool could not match to code. evidence-summary.json says why for each: no committed class implements the interface the build generates, no route serves it, a wildcard path, a match only for fixed values of a path parameter, or a spec part or route the tool could not read.',
      'Each obligation\'s path is where the tool started (the API spec, the descriptor template line of a wildcard handler, or a route): cite that path together with the code you read.',
      'Find the code that serves the endpoint\'s method and path and cite its file, saying which class and method or route you read. An RMB module serves an endpoint through a class in org.folio.rest.impl that implements the interface RMB generates from the RAML resource the path is under; a Spring module through a class implementing the openapi-generator interface (which answers 501 Not Implemented unless the class overrides the operation) or a mapping annotation; Vert.x, Grails and edge modules through routes.',
      'A wildcard path such as /groups* routes every path that starts with it to the module: find the concrete paths under it in the API spec and the routes, and say whether each method the handler lists is implemented for them.',
      'aligned_fact when the method and path are served by code you read; substantive_concern when no code serves them, so a request would get 404, 405 or 501; evidence_gap when the code that would serve them is generated or loaded at runtime and you cannot read it.',
      'Endpoints served by a library (B003-C2) are not given to you: their code is in the library, outside the repository.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      const unmatched = analysis.endpoints.filter(endpoint => !['interface', 'route', 'library'].includes(endpoint.implementation));
      return {
        criterionId: 'B003',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        framework: analysis.framework.name,
        endpointSource: analysis.endpointSource,
        implementationSource: analysis.implementationSource,
        unmatchedEndpoints: list(unmatched.map(({ method, path, interfaceId, implementation, specFiles, generatedInterfaces, implementedBy }) => ({
          method, path, interfaceId, implementation, specFiles,
          ...(generatedInterfaces ? { generatedInterfaces } : {}),
          ...(implementedBy ? { implementedBy: implementedBy.map(at => `${at.file}:${at.line}`) } : {})
        }))),
        unreadRoutes: list(analysis.unreadRoutes.map(route => `${route.file}:${route.line}`)),
        unreadSpecParts: list(analysis.gaps.map(gap => ({ file: gap.file, ...(gap.apiPath ? { apiPath: gap.apiPath } : {}), message: gap.message })))
      };
    }
  });
}
