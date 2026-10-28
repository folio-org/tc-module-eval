import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, F001Analysis } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { buildFrontendAgentReviewRequest, frontendBrowseInclude, givenObligations } from './frontend-agent-review';
import { F001Pattern, siteLabel } from './f001-consumed-apis';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

const HANDLER_PATTERN_BYTES = 48 * 1024;

export function hasF001AgentReviewMaterial(analysis: F001Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewF001WithAgent(
  repoPath: string,
  analysis: F001Analysis,
  patterns: F001Pattern[],
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildF001AgentReviewRequest(repoPath, analysis, patterns);
  } catch (error) {
    return { ...unavailableResult('F001'), errors: [redactEvaluatorSecrets(`Unable to prepare F001 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

/**
 * F001's review: resolve each unresolved request and identify the interface of each path not in the handler index,
 * with the index's patterns that share a first path segment as reference; report missed requests as
 * `discovered:interface:<n>`. A substantive_concern must name, in backticks, an interface id the module does not declare.
 */
export function buildF001AgentReviewRequest(repoPath: string, analysis: F001Analysis, patterns: F001Pattern[]): CriterionAgentReviewRequest {
  const declared = new Set([...analysis.declared.required, ...analysis.declared.optional]);
  return buildFrontendAgentReviewRequest({
    criterionId: 'F001',
    repositoryPath: repoPath,
    criterionTitle: 'F001: every backend interface the module calls is declared in package.json under stripes.okapiInterfaces or stripes.optionalOkapiInterfaces',
    checklist: analysis.checklist,
    discoveredKinds: ['interface'],
    browseInclude: frontendBrowseInclude(),
    browseScope: analysis.agentBrowseScope,
    extraFiles: [{ name: 'handler-patterns.json', content: handlerPatterns(analysis, patterns) }],
    criterionInstructions: [
      `package.json declares ${declared.size ? [...declared].sort().join(', ') : 'no interfaces'}. An interface is declared when it is a key of stripes.okapiInterfaces or stripes.optionalOkapiInterfaces; the version does not matter here.`,
      'handler-patterns.json lists, for the first path segment of each request in checklist.json, the interfaces of the platform release that serve paths starting with it, with their path patterns ({name} is one segment, * any text).',
      'F001-C2: for each request the tool could not map, follow the constants, props, hooks and stripes-connect tokens the path comes from, and decide which interface it reaches. aligned_fact when every interface it can reach is declared; substantive_concern when it reaches an undeclared interface; evidence_gap when the path cannot be established from the source.',
      'F001-C3: for each path that is not in the handler index, identify the interface it belongs to (from the backend module it targets or the module\'s own documentation in the source). aligned_fact when that interface is declared; substantive_concern when it is not.',
      'A substantive_concern must name, in its summary and in backticks, the interface id it believes is undeclared, such as `service-points`: as in handler-patterns.json when the interface is there, otherwise as the backend module\'s descriptor names it.',
      'Report requests to backend interfaces the checklist does not list, that go to an undeclared interface, as discovered:interface:<n>, citing the source file.'
    ],
    // Interfaces newer than the index's release are not in it, so any id-shaped name the module does not declare counts.
    validateCriterion: review => {
      const unnamed = (review.assessments ?? []).find(assessment => assessment.type === 'substantive_concern'
        && ![...assessment.summary.matchAll(/`([a-z][a-z0-9._-]*)`/g)].some(match => !declared.has(match[1])));
      return unnamed ? `F001 substantive_concern ${unnamed.technologyId} must name, in backticks, the undeclared interface id it believes the request reaches.` : undefined;
    },
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      const site = (item: F001Analysis['unresolvedSites'][number]) => ({
        path: item.path, line: item.line, kind: item.kind, request: siteLabel(item), expression: item.expression, outcome: item.outcome,
        ...(item.unresolved ? { reason: item.unresolved } : {}), ...(item.interfaces.length ? { candidateInterfaces: item.interfaces } : {})
      });
      return {
        criterionId: 'F001',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        handlerIndex: analysis.index,
        declared: analysis.declared,
        declaredAndUsed: list(analysis.declaredAndUsed.map(use => ({ id: use.id, requests: use.sites.length }))),
        unresolvedRequests: list(analysis.unresolvedSites.map(site)),
        pathsNotInIndex: list(analysis.notInIndexSites.map(site)),
        libraryHooks: list(analysis.libraryHooks),
        unreadFiles: list([...analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message), ...analysis.parseErrorFiles])
      };
    }
  });
}

// The index's patterns that share a first segment with a request the agent is asked about, cut to fit 48 KB.
function handlerPatterns(analysis: F001Analysis, patterns: F001Pattern[]): string {
  const sites = [...analysis.unresolvedSites, ...analysis.notInIndexSites];
  const segments = [...new Set(sites.map(site => site.requestPath?.split('/')[0]).filter((segment): segment is string => !!segment && segment !== '{}'))].sort();
  // `patron-block${query}` may continue its only segment: patron-block-limits and patron-block-conditions both start with it.
  const openSegments = new Set(sites.filter(site => site.openEnd && !site.requestPath!.includes('/')).map(site => site.requestPath!));
  const render = (maxPerSegment: number) => JSON.stringify({
    platform: analysis.index.descriptorVersion,
    bySegment: Object.fromEntries(segments.map(segment => {
      const matching = patterns.filter(pattern => openSegments.has(segment) ? pattern.pathPattern.startsWith(`/${segment}`) : pattern.pathPattern.split('/')[1] === segment);
      return [segment, {
        patterns: matching.slice(0, maxPerSegment).map(pattern => ({ interface: pattern.interfaceId, methods: pattern.methods, pathPattern: pattern.pathPattern })),
        ...(matching.length > maxPerSegment ? { omitted: matching.length - maxPerSegment } : {})
      }];
    }))
  }, null, 2);
  for (let entries = 1_000; entries >= 1; entries = Math.floor(entries / 2)) {
    const text = render(entries);
    if (Buffer.byteLength(text) <= HANDLER_PATTERN_BYTES) return text;
  }
  return render(0);
}
