import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, F006Analysis } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { buildFrontendAgentReviewRequest, frontendBrowseInclude, givenObligations } from './frontend-agent-review';
import { F006Guidelines, F006Input } from './f006-ui-patterns';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

const GUIDELINES_DIRECTORY = '.criterion-agent/F006/ux-guidelines';
const CSS_VARIABLE = /--[a-z][\w-]*/;

export function hasF006AgentReviewMaterial(analysis: F006Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewF006WithAgent(
  repoPath: string,
  analysis: F006Analysis,
  guidelines: F006Input['guidelines'],
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    if ('problem' in guidelines) throw new Error(guidelines.problem);
    request = buildF006AgentReviewRequest(repoPath, analysis, guidelines);
  } catch (error) {
    return { ...unavailableResult('F006'), errors: [redactEvaluatorSecrets(`Unable to prepare F006 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

/**
 * F006's review: check the checklist items against the pinned UX guidelines, one obligation per item and one per form
 * that does not set navigationCheck to true. A substantive_concern names the guideline file it is measured against.
 */
export function buildF006AgentReviewRequest(repoPath: string, analysis: F006Analysis, guidelines: F006Guidelines): CriterionAgentReviewRequest {
  const guidelineNames = guidelines.files.map(file => file.path.split('/').pop()!.replace(/\.mdx$/, ''));
  const guidelinePaths = new Set(guidelines.files.map(file => `${GUIDELINES_DIRECTORY}/${file.path}`));
  const wording = analysis.englishTranslationFiles.length ? ` Their texts are in ${analysis.englishTranslationFiles.join(', ')}.` : '';
  return buildFrontendAgentReviewRequest({
    criterionId: 'F006',
    repositoryPath: repoPath,
    criterionTitle: 'F006: the module follows existing FOLIO UI layouts, patterns and norms',
    checklist: analysis.checklist,
    discoveredKinds: [],
    browseInclude: frontendBrowseInclude(analysis.englishTranslationFiles),
    browseScope: analysis.agentBrowseScope,
    extraFiles: guidelines.files.map(file => ({ name: `ux-guidelines/${file.path}`, content: file.content })),
    criterionInstructions: [
      `${GUIDELINES_DIRECTORY}/ holds the FOLIO UX guidelines, pinned from stripes-components ${guidelines.sourceDirectory} at commit ${guidelines.commit}: `
        + 'layout/, forms/, navigation/, actions/, feedback/ConfirmationModalPattern.mdx and data-display/MultiColumnListGuidelines.mdx. Measure the code against them.',
      'Every item except F006-C3 is about the whole module: read a representative sample (the main routes and their screens, the settings) rather than every file, and say in the summary which screens you read.',
      'F006-C1: compare the structure of the main screens (Paneset, Pane, PaneHeader, Layer) with layout/LayoutTypesContext.mdx, layout/PanesetGuidelines.mdx, layout/PaneGuidelines.mdx, layout/PaneHeaderGuidelines.mdx and layout/LayerGuidelines.mdx.',
      'F006-C2: compare the search and filter screens (SearchAndSort, FilterGroups, SearchField, MultiColumnList) with navigation/FilterPaneSearchGuidelines.mdx, navigation/FilterGroupsGuidelines.mdx, forms/SearchFieldGuidelines.mdx, forms/AdvancedSearchGuidelines.mdx and data-display/MultiColumnListGuidelines.mdx.',
      'F006-C3: for each form, decide whether leaving it with unsaved changes asks the user first, as the "Leaving a page" section of actions/ConfirmationLanguageGuidelines.mdx requires for create and edit pages. '
        + 'navigationCheck defaults to false in stripesFinalForm and stripesForm, so a form without it does not ask unless the code asks some other way. '
        + 'aligned_fact when the form asks, or cannot lose changes (say why); substantive_concern when unsaved changes can be lost without a prompt, '
        + 'naming the guideline in its summary, for example: closing the form loses unsaved changes without the prompt that ConfirmationLanguageGuidelines.mdx asks for. Cite the form\'s own file.',
      `F006-C4: find destructive actions (delete, remove, discard, cancel a record) and check that each asks for confirmation in a ConfirmationModal whose heading, message and buttons follow feedback/ConfirmationModalPattern.mdx and actions/ConfirmationLanguageGuidelines.mdx.${wording}`,
      'F006-C5: check pane action menus (the actionMenu prop, PaneMenu), dropdowns and buttons against layout/PaneMenuGuidelines.mdx, layout/PaneHeaderGuidelines.mdx, navigation/DropdownGuidelines.mdx, navigation/MenuSectionGuidelines.mdx and the actions/ guidelines (ButtonGuidelines.mdx, IconButtonGuidelines.mdx, DropdownButtonGuidelines.mdx, ButtonGroupGuidelines.mdx, ActionLanguage.mdx).',
      'F006-C6: for the raw HTML controls and hex colors in checklist.json, decide whether a Stripes component (actions/ButtonGuidelines.mdx for buttons, forms/ for inputs, selects and text areas) or a Stripes color variable should be used. Vendored third-party CSS, and a color Stripes has no variable for, are not problems; say so.',
      'F006-C8: compare the settings pages (the Settings component and its pages) with the pane layout and form guidelines.',
      'When the module has nothing an item is about (no search screen, no settings), use aligned_fact with coverageDisposition immaterial, and cite package.json or the file that shows it: every assessment cites at least one repository file.',
      `A substantive_concern must name, in its summary, the guideline file it is measured against, such as ${guidelineNames.includes('ConfirmationModalPattern') ? 'ConfirmationModalPattern' : guidelineNames[0]}.mdx. `
        + 'The guidelines have no page on colors, so an F006-C6 concern about a hard-coded color may instead name the Stripes color variable to use, such as --color-text.',
      'Before you answer, check every substantive_concern: its summary must contain the name of a guideline file ending in .mdx (or, for an F006-C6 color, a --variable name). A concern without one is dropped.',
      'F006-C7 (state kept when navigating between apps) and F006-C9 (documentation links are publicly accessible) are for the reviewer only and are not in checklist.json. Do not fetch any link.'
    ],
    criterionRule: assessment => assessment.type === 'substantive_concern'
      && !guidelineNames.some(name => assessment.summary.includes(name))
      && !assessment.evidenceReferences.some(reference => guidelinePaths.has(reference))
      && !(assessment.technologyId.startsWith('F006-C6#') && CSS_VARIABLE.test(assessment.summary))
      ? `The potential problem does not name the guideline file it is measured against${assessment.technologyId.startsWith('F006-C6#') ? ', or the Stripes color variable to use' : ''}.`
      : undefined,
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      return {
        criterionId: 'F006',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        packageName: analysis.packageName,
        app: analysis.app,
        components: analysis.components,
        componentSites: list(analysis.componentSites),
        forms: list(analysis.forms),
        confirmationModals: list(analysis.confirmationModals),
        rawControls: analysis.implementsStripesControls ? 'not counted; this package implements the Stripes controls' : list(analysis.rawControls),
        hexColors: list(analysis.hexColors),
        settingsPages: list(analysis.settingsPages),
        guidelines: analysis.guidelines,
        unreadFiles: list([...analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message), ...analysis.parseErrorFiles])
      };
    }
  });
}
