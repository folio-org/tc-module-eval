import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, F004Analysis } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { f004BrowsePaths, F004Input, runtimeCollected } from './f004-accessibility';
import { F006Guidelines } from './f006-ui-patterns';
import { boundedSummary, buildFrontendAgentReviewRequest, frontendBrowseInclude, givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';
import { AXE_TAGS } from './ui-runtime-probe';

export const F004_AXE_RESULTS_PATH = '.criterion-agent/F004/axe-results.json';
const GUIDES_DIRECTORY = '.criterion-agent/F004/accessibility-guides';

export function hasF004AgentReviewMaterial(analysis: F004Analysis): boolean {
  return runtimeCollected(analysis.runtime) && givenObligations(analysis.checklist).length > 0;
}

export async function reviewF004WithAgent(
  repoPath: string,
  analysis: F004Analysis,
  guides: F004Input['guides'],
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    if ('problem' in guides) throw new Error(guides.problem);
    request = buildF004AgentReviewRequest(repoPath, analysis, guides);
  } catch (error) {
    return { ...unavailableResult('F004'), errors: [redactEvaluatorSecrets(`Unable to prepare F004 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildF004AgentReviewRequest(repoPath: string, analysis: F004Analysis, guides: F006Guidelines): CriterionAgentReviewRequest {
  const runtime = analysis.runtime;
  const runtimeIds = givenObligations(analysis.checklist).filter(obligation => obligation.id.startsWith('F004-C1#')).map(obligation => obligation.id);
  const deployed = runtime.deployedModule ? `${runtime.deployedModule.id} ${runtime.deployedModule.version}` : 'an unknown version';
  const axeResults = boundedSummary(maxEntries => ({
    note: 'axe-core results from a running FOLIO UI. They show the version deployed there, which may differ from the evaluated commit.',
    uiOrigin: runtime.uiOrigin,
    browserVersion: runtime.browserVersion,
    axeVersion: runtime.axeVersion,
    tags: AXE_TAGS,
    deployedModule: runtime.deployedModule,
    evaluatedPackageVersion: analysis.packageVersion,
    pages: runtime.pages.map(page => ({
      path: page.path,
      ...(page.finalUrl ? { finalUrl: page.finalUrl } : {}),
      ...(page.problem ? { problem: page.problem } : {}),
      ...(page.axe ? {
        passCount: page.axe.passCount,
        incompleteCount: page.axe.incompleteCount,
        violations: page.axe.violations.slice(0, maxEntries).map(violation => ({
          ...violation,
          nodes: violation.nodes.slice(0, Math.min(maxEntries, violation.nodes.length)),
          ...(violation.nodeCount > Math.min(maxEntries, violation.nodes.length) ? { nodesNotShown: violation.nodeCount - Math.min(maxEntries, violation.nodes.length) } : {})
        })),
        ...(page.axe.violations.length > maxEntries ? { violationsNotShown: page.axe.violations.length - maxEntries } : {})
      } : {})
    })),
    skippedPaths: runtime.skippedPaths
  }));
  return buildFrontendAgentReviewRequest({
    criterionId: 'F004',
    repositoryPath: repoPath,
    criterionTitle: 'F004: the module meets WCAG 2.1 AA as measured by a current major version of axe DevTools',
    checklist: analysis.checklist,
    discoveredKinds: [],
    browseInclude: frontendBrowseInclude(f004BrowsePaths(analysis)),
    browseScope: analysis.agentBrowseScope,
    extraFiles: [
      { name: 'axe-results.json', content: axeResults },
      ...guides.files.map(file => ({ name: `accessibility-guides/${file.path}`, content: file.content }))
    ],
    generatedEvidencePaths: [{ path: F004_AXE_RESULTS_PATH, technologyIds: runtimeIds }],
    criterionInstructions: [
      `${F004_AXE_RESULTS_PATH} holds axe-core ${runtime.axeVersion ?? ''} results (${AXE_TAGS.join(', ')}) for the module's pages on a running FOLIO UI at ${runtime.uiOrigin ?? 'an unknown origin'}, `
        + `which runs ${deployed}; the evaluated package.json has version ${analysis.packageVersion ?? 'unknown'}. Each violation lists up to 10 elements with their selector and HTML.`,
      `${GUIDES_DIRECTORY}/ holds FOLIO's accessibility guides from stripes-components ${guides.sourceDirectory} at commit ${guides.commit}.`,
      'F004-C1: each obligation is one axe rule on one page, or the whole item when axe found no violations. Map the violation to the component that renders it, from the selectors and HTML, and cite that source file. '
        + 'aligned_fact when the violation comes from the platform rather than this module (stripes-core navigation, the login page, another app) or axe found none; '
        + 'substantive_concern when this module renders the failing element; evidence_gap when the element cannot be traced. These obligations may cite axe-results.json besides source files.',
      'F004-C2: each obligation is one disabled jsx-a11y rule. Read the element it covers: aligned_fact when the element still has an accessible name and keyboard support, or the rule does not apply (say why); substantive_concern when the disable hides a real barrier. '
        + 'Without disabled rules, the obligation is the whole item: sample interactive elements (the click handlers and hard-coded aria-labels in checklist.json) for accessible names and keyboard support.',
      'F004-C3: sample images and icons for text alternatives (alt, aria-label, or Stripes Icon with a label), and check that statuses are not shown by color alone.',
      'F004-C4: check that modals and layers move focus into themselves and back on close (Stripes Modal and Layer do this; custom ones may not).',
      'F004-C5: check whether the axe tests listed cover the module\'s main screens and components, and name the main ones without one.',
      'Every item is about the whole module except the subjects listed: read a representative sample and say in the summary which screens you read.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      return {
        criterionId: 'F004',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        packageName: analysis.packageName,
        axeTests: { testFileCount: analysis.axeTests.testFileCount, files: list(analysis.axeTests.files) },
        lint: analysis.lint,
        disabledRules: list(analysis.disabledRules),
        imagesWithoutAlt: list(analysis.imagesWithoutAlt),
        clickHandlers: list(analysis.clickHandlers),
        hardCodedAriaLabels: list(analysis.hardCodedAriaLabels),
        unreadFiles: list([...analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message), ...analysis.parseErrorFiles])
      };
    }
  });
}
