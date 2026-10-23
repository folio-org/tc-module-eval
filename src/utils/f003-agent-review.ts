import { CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult, F003Analysis } from '../types';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { buildFrontendAgentReviewRequest, frontendBrowseInclude, givenObligations } from './frontend-agent-review';
import { f003TranslationPaths } from './f003-internationalization';
import { redactSensitiveText } from './redaction';
import { errorMessage } from './type-guards';

export function hasF003AgentReviewMaterial(analysis: F003Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewF003WithAgent(
  repoPath: string,
  analysis: F003Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildF003AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return { ...unavailableResult('F003'), errors: [redactSensitiveText(`Unable to prepare F003 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildF003AgentReviewRequest(repoPath: string, analysis: F003Analysis): CriterionAgentReviewRequest {
  const namespace = analysis.namespace;
  const translationPaths = f003TranslationPaths(namespace, analysis.translationDirectories);
  return buildFrontendAgentReviewRequest({
    criterionId: 'F003',
    repositoryPath: repoPath,
    criterionTitle: 'F003: the module is internationalized with react-intl and has an en.json with its English texts',
    checklist: analysis.checklist,
    discoveredKinds: ['text', 'id'],
    browseInclude: frontendBrowseInclude(translationPaths),
    browseScope: analysis.agentBrowseScope,
    criterionInstructions: [
      namespace
        ? `The translation namespace is ${namespace}. A message id ${namespace}.<key> is the key <key> in ${translationPaths[0]}, without the namespace prefix. Ids of other namespaces (stripes-core., stripes-components., ...) belong to other packages and are out of scope.`
        : `The translation namespace is unclear; check which of ${translationPaths.join(', ') || 'the translation files'} the code uses.`,
      'F003-C1: for each missing id, confirm it is absent from en.json and say whether the code supplies English fallback text (defaultMessage, or a label prop shown instead). aligned_fact when the key exists or a fallback is shown; substantive_concern when users would see the raw id.',
      'F003-C2: for each hard-coded text candidate, decide whether users see it. aligned_fact when it is not shown to users (a comment, a test helper, developer-only text) or already comes from en.json; substantive_concern when users see untranslated text; analyzer_limitation when the tool misread the code.',
      'F003-C3: sample the computed message id families (template literals and variables) and check that the keys they can produce exist in en.json.',
      'F003-C4: for each invalid text, check whether react-intl would fail to format it.',
      'Report user-visible hard-coded text the checklist does not list as discovered:text:<n>, and message ids the code uses that are missing from en.json and not listed as discovered:id:<n>, citing the source file.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      return {
        criterionId: 'F003',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        namespace: analysis.namespace,
        namespaceBasis: analysis.namespaceBasis,
        translationDirectories: analysis.translationDirectories,
        translationFile: analysis.translationFile,
        reactIntl: analysis.reactIntl,
        literalIdCount: analysis.literalIdCount,
        otherNamespaceIdCount: analysis.otherNamespaceIdCount,
        missingIds: list(analysis.missingIds),
        hardCodedText: list(analysis.hardCodedText),
        computedIds: list(analysis.computedIds),
        invalidTexts: list(analysis.invalidTexts),
        unreadFiles: list([...analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message), ...analysis.parseErrorFiles])
      };
    }
  });
}
