import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, F007Analysis } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { f007BrowsePaths } from './f007-latest-chrome';
import { boundedSummary, buildFrontendAgentReviewRequest, frontendBrowseInclude, givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';
import { runtimeCollected } from './ui-runtime-report';

const F007_CONSOLE_PATH = '.criterion-agent/F007/console.json';

export function hasF007AgentReviewMaterial(analysis: F007Analysis): boolean {
  return runtimeCollected(analysis.runtime) && givenObligations(analysis.checklist).length > 0;
}

export async function reviewF007WithAgent(
  repoPath: string,
  analysis: F007Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildF007AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return { ...unavailableResult('F007'), errors: [redactEvaluatorSecrets(`Unable to prepare F007 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildF007AgentReviewRequest(repoPath: string, analysis: F007Analysis): CriterionAgentReviewRequest {
  const runtime = analysis.runtime;
  const runtimeIds = givenObligations(analysis.checklist).filter(obligation => obligation.id.startsWith('F007-C1#')).map(obligation => obligation.id);
  const deployed = runtime.deployedModule ? `${runtime.deployedModule.id} ${runtime.deployedModule.version}` : 'an unknown version';
  const list = <T>(items: T[], maxEntries: number, cut: number) => {
    const shown = items.slice(0, maxEntries);
    const notShown = items.length + cut - shown.length;
    return { items: shown, ...(notShown ? { notShown } : {}) };
  };
  const consoleEvidence = boundedSummary(maxEntries => ({
    note: 'Console errors and failed requests from a running FOLIO UI in headless Chrome. They show the version deployed there, which may differ from the evaluated commit.',
    uiOrigin: runtime.uiOrigin,
    apiOrigin: runtime.apiOrigin,
    browserVersion: runtime.browserVersion,
    deployedModule: runtime.deployedModule,
    evaluatedPackageVersion: analysis.packageVersion,
    pages: runtime.pages.map(page => ({
      path: page.path,
      ...(page.finalUrl ? { finalUrl: page.finalUrl } : {}),
      ...(page.status !== undefined ? { status: page.status } : {}),
      ...(page.problem ? { problem: page.problem } : {}),
      consoleErrors: list(page.consoleErrors, maxEntries, page.consoleErrorsCut),
      failedRequests: list(page.failedRequests, maxEntries, page.failedRequestsCut)
    })),
    skippedPaths: runtime.skippedPaths,
    blockedRequests: list(runtime.blockedRequests, maxEntries, runtime.blockedRequestsCut)
  }));
  return buildFrontendAgentReviewRequest({
    criterionId: 'F007',
    repositoryPath: repoPath,
    criterionTitle: 'F007: the module works in the latest Chrome',
    checklist: analysis.checklist,
    discoveredKinds: [],
    browseInclude: frontendBrowseInclude(f007BrowsePaths(analysis)),
    browseScope: analysis.agentBrowseScope,
    extraFiles: [{ name: 'console.json', content: consoleEvidence }],
    generatedEvidencePaths: [{ path: F007_CONSOLE_PATH, technologyIds: runtimeIds, accepts: assessment => assessment.type !== 'substantive_concern' }],
    criterionInstructions: [
      `${F007_CONSOLE_PATH} holds, per page the probe visited on a running FOLIO UI at ${runtime.uiOrigin ?? 'an unknown origin'} in Chrome ${runtime.browserVersion ?? 'of an unknown version'}, `
        + `the console errors and failed requests; the UI runs ${deployed}, and the evaluated package.json has version ${analysis.packageVersion ?? 'unknown'}.`,
      'F007-C1: each obligation is one distinct console error, with the pages that logged it, or the whole item when the pages logged none. Explain the error from source: find the code that logs it or causes it. '
        + 'aligned_fact when it does not come from this module (stripes-core, another app, the login page, a backend that answers with an error the module handles) or no error was logged; '
        + 'substantive_concern when this module\'s code causes it, citing that source file; evidence_gap when it cannot be traced to code. These obligations may cite console.json instead of source files, except a substantive_concern.',
      'F007-C2: each obligation is one browser-specific use the tool flagged, with its file and line, or the whole item when it flagged none. Read the code around it: aligned_fact when Chrome takes a working path '
        + '(the use is feature-detected with a Chrome fallback, or the API still works in Chrome); substantive_concern when Chrome takes a missing or broken path; analyzer_limitation when the flagged code is not the browser API. '
        + 'Without flagged uses, sample the code that touches the browser (navigator, window, document, downloads, clipboard) for paths that depend on another browser or a removed API.',
      'Say in the summary which screens and files you read.'
    ],
    evidenceSummary: maxEntries => {
      const items = <T>(entries: T[]) => ({ items: entries.slice(0, maxEntries), ...(entries.length > maxEntries ? { omitted: entries.length - maxEntries } : {}) });
      return {
        criterionId: 'F007',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        app: analysis.app,
        userAgentReads: items(analysis.userAgentReads),
        browserApis: items(analysis.browserApis),
        browserslist: items(analysis.browserslist),
        polyfills: items(analysis.polyfills),
        apiList: analysis.apiList,
        unreadFiles: items([...analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message), ...analysis.parseErrorFiles])
      };
    }
  });
}
