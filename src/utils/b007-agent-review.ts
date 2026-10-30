import { B003Analysis, B007Analysis, B007Endpoint, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

/** Where the source implements an endpoint, as `file:line`, from B003's matching; empty when B003 found none. */
export type B007Implementations = (endpoint: B007Endpoint) => string[];

export function b007Implementations(b003: B003Analysis): B007Implementations {
  const byEndpoint = new Map<string, string[]>();
  for (const endpoint of b003.endpoints) {
    const key = `${endpoint.interfaceId}\n${endpoint.method}\n${endpoint.path}`;
    byEndpoint.set(key, [...byEndpoint.get(key) ?? [], ...(endpoint.implementedBy ?? []).map(at => `${at.file}:${at.line}`)]);
  }
  return endpoint => [...new Set(endpoint.methods.flatMap(method => byEndpoint.get(`${endpoint.interfaceId}\n${method.toUpperCase()}\n${endpoint.path}`) ?? []))];
}

export function hasB007AgentReviewMaterial(analysis: B007Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB007WithAgent(
  repoPath: string,
  analysis: B007Analysis,
  implementations: B007Implementations,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB007AgentReviewRequest(repoPath, analysis, implementations);
  } catch (error) {
    return { ...unavailableResult('B007'), errors: [redactEvaluatorSecrets(`Unable to prepare B007 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildB007AgentReviewRequest(repoPath: string, analysis: B007Analysis, implementations: B007Implementations): CriterionAgentReviewRequest {
  return buildBackendAgentReviewRequest({
    criterionId: 'B007',
    repositoryPath: repoPath,
    criterionTitle: 'B007: every endpoint the module provides is protected with an appropriate permission',
    checklist: analysis.checklist,
    discoveredKinds: [],
    browse: backendBrowse(),
    criterionInstructions: [
      `Each obligation is about one interface in the descriptor template ${analysis.templatePath}, at the line given; evidence-summary.json lists its endpoints with their permissionsRequired, modulePermissions and, where the tool found it, the code that implements them. Cite the template and the implementation files you read.`,
      'B007-C1: read what each endpoint of the interface does and say whether its permissionsRequired fit: a GET needs a read permission and POST, PUT, PATCH or DELETE a write one; an endpoint that reads, changes or creates one record an item permission (POST /users creating one user takes users.item.post) and one that reads or changes many records a collection permission; and the permission is not broader than the endpoint needs. aligned_fact when every endpoint\'s permission fits; substantive_concern naming each endpoint and permission that does not.',
      'B007-C2: for each endpoint of the interface that requires no permission, say whether it is meant to be public (a health check, a lookup used before login) and whether it returns tenant data or changes state. aligned_fact when it is safe without a permission; substantive_concern when it is not.',
      'B007-C3: follow the implementation of the interface\'s endpoints to the calls they make to other FOLIO modules (HTTP clients, Feign or folio-spring clients, Okapi path literals) and say whether each endpoint\'s modulePermissions include the permissions those calls need, without *.all permissions. Name the missing permission, or the call whose permission you could not establish.',
      'A permission the template does not define, or a *.all permission an endpoint requires, is already a fail; the review runs only for manual results.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      const interfaces = new Map<string, B007Endpoint[]>();
      for (const endpoint of analysis.endpoints) {
        const key = endpoint.pointer.split('/').slice(0, 3).join('/');
        const list = interfaces.get(key) ?? [];
        interfaces.set(key, list);
        list.push(endpoint);
      }
      return {
        criterionId: 'B007',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        templatePath: analysis.templatePath,
        permissionPrefix: analysis.permissionPrefix,
        interfaces: list([...interfaces].map(([pointer, endpoints]) => ({
          interfaceId: endpoints[0].interfaceId,
          pointer,
          endpoints: list(endpoints.map(endpoint => {
            const implementedBy = implementations(endpoint);
            return {
              methods: endpoint.methods, path: endpoint.path, line: endpoint.line,
              permissionsRequired: endpoint.permissionsRequired ?? null, modulePermissions: endpoint.modulePermissions,
              ...(implementedBy.length ? { implementedBy } : {})
            };
          }))
        }))),
        findings: list(analysis.findings.map(({ interfaceId, methods, path, line, problem, permission }) => ({ interfaceId, methods, path, line, problem, permission })))
      };
    }
  });
}
