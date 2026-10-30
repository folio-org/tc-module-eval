import {
  CriterionAgentAssessment,
  CriterionAgentDroppedItem,
  CriterionAgentReviewResult,
  FrontendChecklist,
  FrontendChecklistItem,
  FrontendChecklistObligation
} from '../types';
import { CriterionAgentReviewRequest } from './criterion-agent-review';
import { FRONTEND_AGENT_OBLIGATION_LIMIT, SHOWN_STARTING_POINTS } from './frontend-checklist';
import { isComponentCssPath, isProductionSourcePath } from './frontend-source';

/** F00x reviews wait for the model longer than the shared 120 s default; ui-checkin's S010 review took 158 s. */
export const FRONTEND_AGENT_TIMEOUT_MS = 420_000;

const EVIDENCE_SUMMARY_BYTES = 48 * 1024;

/** A checklist item before its obligations are numbered: what the agent assesses, one obligation per subject. */
export type FrontendChecklistItemDraft = FrontendChecklistItem & {
  subjects: Array<{ subject: string; path?: string; line?: number; flag?: FrontendChecklistObligation['flag'] }>;
};

/**
 * Number each item's obligations (`F003-C1#1`, `F003-C1#2`, ...): one per subject, or one for the whole item when it
 * has none; reviewer-only items get none. At most FRONTEND_AGENT_OBLIGATION_LIMIT are given to the agent: subject
 * obligations first, in item order or the given order, then whole-item ones. The rest are marked withheld.
 */
export function numberObligations(
  drafts: FrontendChecklistItemDraft[],
  order?: (a: FrontendChecklistObligation, b: FrontendChecklistObligation) => number
): FrontendChecklistItem[] {
  const items = drafts.map(({ subjects, ...item }) => ({
    ...item,
    obligations: item.reviewerOnly ? [] : subjects.length
      ? subjects.map((subject, index): FrontendChecklistObligation => ({ id: `${item.id}#${index + 1}`, ...subject }))
      : [{ id: `${item.id}#1` }]
  }));
  const subjectObligations = items.flatMap(item => item.obligations.filter(obligation => obligation.subject !== undefined));
  const ranked = [...order ? subjectObligations.sort(order) : subjectObligations,
    ...items.flatMap(item => item.obligations.filter(obligation => obligation.subject === undefined))];
  ranked.slice(FRONTEND_AGENT_OBLIGATION_LIMIT).forEach(obligation => { obligation.withheld = true; });
  return items;
}

/** The obligations given to the agent: those of items it may check, within the limit. */
export function givenObligations(checklist: FrontendChecklist): FrontendChecklistObligation[] {
  return checklist.items.filter(item => !item.reviewerOnly).flatMap(item => item.obligations.filter(obligation => !obligation.withheld));
}

function withheldCount(checklist: FrontendChecklist): number {
  return checklist.items.flatMap(item => item.obligations).filter(obligation => obligation.withheld).length;
}

/** The shared F00x browse scope, as stated to the agent and the reader. */
export const FRONTEND_BROWSE_SCOPE = 'source files under src/, lib/ and at the root (no tests, stories, examples, fixtures or mocks), CSS under src/ and lib/, package.json';

/**
 * The shared F00x browse scope: production source (src/, lib/, root-level files), package.json and component CSS,
 * without stories, guides or other locales; plus the criterion's own paths.
 */
export function frontendBrowseInclude(extraPaths: string[] = []): (path: string) => boolean {
  return path => path === 'package.json' || extraPaths.includes(path) || isProductionSourcePath(path) || isComponentCssPath(path);
}

export interface FrontendAgentReviewOptions {
  criterionId: string;
  repositoryPath: string;
  /** "F003: Internationalization with react-intl and an en.json of English texts" and similar. */
  criterionTitle: string;
  checklist: FrontendChecklist;
  /** The deterministic findings for evidence-summary.json, given the most list entries to keep. */
  evidenceSummary: (maxListEntries: number) => unknown;
  /** What the agent should do with each item, in the criterion's terms. */
  criterionInstructions: string[];
  /** The `discovered:<kind>:<n>` kinds the criterion accepts, e.g. `text` and `id` for F003. */
  discoveredKinds: string[];
  browseInclude: (path: string) => boolean;
  browseScope: string;
  /** Criterion reference material for the agent, under `.criterion-agent/<ID>/`. */
  extraFiles?: Array<{ name: string; content: string }>;
  /** The criterion's own rule for one assessment, applied after the shared ones: why to drop it, or undefined to keep it. */
  criterionRule?: (assessment: CriterionAgentAssessment) => string | undefined;
  generatedEvidencePaths?: CriterionAgentReviewRequest['generatedEvidencePaths'];
  /** 420 s unless given. */
  defaultTimeoutMs?: number;
  /** Two repository paths for the example response, the second for a discovered finding. */
  examplePaths?: [string, string];
}

/**
 * An F00x agent review request: the checklist with its obligations, the deterministic evidence capped at 48 KB, a
 * complete example response, the browse scope, the 420 s default timeout, and the shared F00x validation.
 */
export function buildFrontendAgentReviewRequest(options: FrontendAgentReviewOptions): CriterionAgentReviewRequest {
  const { criterionId, checklist, discoveredKinds } = options;
  const given = givenObligations(checklist);
  const withheld = withheldCount(checklist);
  const discoveredExample = discoveredKinds.length ? `discovered:${discoveredKinds[0]}:1` : undefined;
  const [examplePath, otherExamplePath] = options.examplePaths ?? ['src/actual/source/path.js', 'src/other/source/path.js'];
  const flagged = given.some(obligation => obligation.flag);
  const responseShape = {
    note: 'Shape example only, not findings. Replace prose and citations with investigated evidence, and return one assessment for every obligation in checklist.json.',
    response: {
      recommendation: 'needs_reviewer_judgment',
      confidence: 'medium',
      summary: 'State the overall judgment and the remaining decision.',
      rationale: 'State the decisive evidence and the scope actually investigated.',
      evidenceReferences: [examplePath],
      assessments: [
        { technologyId: given[0]?.id ?? `${criterionId}-C1#1`, type: 'aligned_fact', summary: 'State whether the item\'s desired state holds for this subject, with line numbers.',
          evidenceReferences: [given[0]?.path ?? examplePath], coverageDisposition: 'investigated' },
        ...(discoveredExample ? [{ technologyId: discoveredExample, type: 'substantive_concern', summary: 'Describe a problem of the same kind that the tool did not list.',
          evidenceReferences: [otherExamplePath], coverageDisposition: 'investigated' }] : [])
      ],
      reviewerActions: [{ action: 'Name the fact to verify and the decision it resolves.', evidenceReferences: [examplePath] }]
    }
  };
  return {
    criterionId,
    repositoryPath: options.repositoryPath,
    browseInclude: options.browseInclude,
    defaultTimeoutMs: options.defaultTimeoutMs ?? FRONTEND_AGENT_TIMEOUT_MS,
    ...(options.generatedEvidencePaths ? { generatedEvidencePaths: options.generatedEvidencePaths } : {}),
    instructions: [
      `Act as an advisory reviewer for ${options.criterionTitle}.`,
      `You may browse only: ${options.browseScope}.`,
      `checklist.json lists the reviewer's checklist. Each item is phrased as the desired state. Each obligation (an ID such as ${given[0]?.id ?? `${criterionId}-C1#1`}) asks whether the item's desired state holds for its subject, or for the whole item when it has no subject. evidence-summary.json holds the tool's deterministic findings.`,
      ...flagged ? ['An obligation\'s flag is what the tool decided for its subject on its own: fail when it found a violation, manual when it left the subject to the reviewer. Assess flagged subjects against the evidence like any other.'] : [],
      ...options.criterionInstructions,
      'Return assessments as an array with exactly one object for every obligation ID in checklist.json, using the ID as technologyId, and no other IDs except discovered ones. Each object has technologyId, type, summary, evidenceReferences (an array of repository paths) and coverageDisposition. Use exactly these field names; see response-shape.json.',
      'type: aligned_fact when the desired state holds; substantive_concern when it does not; evidence_gap when you could not establish it; analyzer_limitation when the tool\'s finding is wrong (for example a false positive); policy_question when the guideline or policy is unclear.',
      'coverageDisposition is required: investigated when you read the subject itself, immaterial when it does not affect the decision, unresolved when it remains open. An investigated obligation with a path must cite that path. An obligation whose path is not in repository-files.json is outside what you can read and must be unresolved. aligned_fact cannot be unresolved, and evidence_gap cannot be investigated.',
      discoveredKinds.length
        ? `Report problems of the same kind that checklist.json does not list as discovered:<kind>:<n>, numbered from 1, where kind is ${discoveredKinds.join(' or ')}. A discovered assessment is substantive_concern or evidence_gap.`
        : 'Do not add assessments beyond the obligations.',
      `Use likely_sufficient only when every obligation is aligned_fact or analyzer_limitation, none is unresolved and nothing was discovered${withheld ? `; it is not allowed here, because ${withheld} more obligations were not given to you` : ''}. Use likely_insufficient only with a substantive_concern. Use needs_reviewer_judgment only with at least one reviewer action naming the fact to verify.`,
      `This review is advisory only. Agent advice must not decide the ${criterionId} status.`,
      'Return exactly one JSON object, without prose or Markdown fences, with recommendation (likely_sufficient, likely_insufficient or needs_reviewer_judgment), confidence (low, medium or high), summary, rationale, evidenceReferences, assessments and reviewerActions (an array of objects with action and evidenceReferences).'
    ].join('\n'),
    files: [{
      repoRelativePath: `.criterion-agent/${criterionId}/checklist.json`,
      content: JSON.stringify({
        items: checklist.items.filter(item => !item.reviewerOnly).map(item => ({
          id: item.id,
          title: item.title,
          startingPoints: item.startingPoints.slice(0, SHOWN_STARTING_POINTS),
          ...(item.startingPoints.length > SHOWN_STARTING_POINTS ? { omittedStartingPoints: item.startingPoints.length - SHOWN_STARTING_POINTS } : {}),
          obligations: item.obligations.filter(obligation => !obligation.withheld).map(({ withheld: _withheld, ...obligation }) => obligation)
        })),
        ...(withheld ? { obligationsNotGiven: withheld } : {})
      }, null, 2)
    }, {
      repoRelativePath: `.criterion-agent/${criterionId}/evidence-summary.json`,
      content: boundedSummary(options.evidenceSummary)
    }, {
      repoRelativePath: `.criterion-agent/${criterionId}/response-shape.json`,
      content: JSON.stringify(responseShape, null, 2)
    }, ...(options.extraFiles ?? []).map(file => ({ repoRelativePath: `.criterion-agent/${criterionId}/${file.name}`, content: file.content }))],
    dropInvalidItems: true,
    validateReview: (review, availableSourcePaths) => {
      applyFrontendReviewRules(checklist, discoveredKinds, options.criterionRule, review, availableSourcePaths);
      return undefined;
    },
    schemaDescription: 'JSON object with recommendation enum, confidence enum, nonblank summary and rationale, nonempty evidenceReferences string[] of repository paths, assessments[] (one object per obligation ID in checklist.json, plus discovered ones: technologyId, type, summary, evidenceReferences string[], coverageDisposition investigated|immaterial|unresolved), and reviewerActions[] of { action, evidenceReferences string[] }. See response-shape.json for a complete example.'
  };
}

// Lists are cut to fewer entries until the JSON fits, rather than cutting the JSON text.
export function boundedSummary(render: (maxListEntries: number) => unknown): string {
  for (let entries = 1_000; entries >= 1; entries = Math.floor(entries / 2)) {
    const text = JSON.stringify(render(entries), null, 2);
    if (Buffer.byteLength(text) <= EVIDENCE_SUMMARY_BYTES) return text;
  }
  throw new Error(`the evidence summary does not fit in ${EVIDENCE_SUMMARY_BYTES} bytes`);
}

const UNRESOLVED_TYPES = new Set(['substantive_concern', 'evidence_gap', 'policy_question']);

/**
 * The F00x review rules, applied to an accepted review in place: an assessment that breaks one is dropped on its own,
 * with the reason, and a recommendation the kept assessments do not support becomes needs_reviewer_judgment.
 */
function applyFrontendReviewRules(
  checklist: FrontendChecklist,
  discoveredKinds: string[],
  criterionRule: FrontendAgentReviewOptions['criterionRule'],
  review: CriterionAgentReviewResult,
  availableSourcePaths: ReadonlySet<string>
): void {
  const obligations = new Map(givenObligations(checklist).map(obligation => [obligation.id, obligation]));
  const discovered = new RegExp(`^discovered:(?:${discoveredKinds.join('|') || '(?!)'}):[1-9]\\d*$`);
  const counts = new Map<string, number>();
  const ids = [...(review.assessments ?? []).map(assessment => assessment.technologyId),
    ...(review.droppedItems ?? []).flatMap(item => item.kind === 'assessment' && item.technologyId !== undefined ? [item.technologyId] : [])];
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const dropReason = (assessment: CriterionAgentAssessment): string | undefined => {
    const obligation = obligations.get(assessment.technologyId);
    const isDiscovered = discovered.test(assessment.technologyId);
    const disposition = assessment.coverageDisposition;
    if (!obligation && !isDiscovered) return 'It answers nothing the agent was asked to check.';
    if (counts.get(assessment.technologyId)! > 1) return `The agent returned ${counts.get(assessment.technologyId)} results for it, so none is used.`;
    if (!disposition) return 'It gives no coverage judgment.';
    if (obligation?.path && !availableSourcePaths.has(obligation.path) && disposition !== 'unresolved') {
      return 'Its file was not available to the agent, so it must stay open.';
    }
    if (obligation?.path && disposition === 'investigated' && !assessment.evidenceReferences.includes(obligation.path)) {
      return 'It is marked as investigated directly but does not cite the file it is about.';
    }
    if (assessment.type === 'aligned_fact' && disposition === 'unresolved') return 'It says the desired state holds but leaves it open.';
    if (assessment.type === 'evidence_gap' && disposition === 'investigated') return 'It says the evidence is missing but is marked as investigated directly.';
    if (isDiscovered && !['substantive_concern', 'evidence_gap'].includes(assessment.type)) {
      return 'A finding beyond the checklist must be a potential problem or need verification.';
    }
    return criterionRule?.(assessment);
  };
  const reasons = (review.assessments ?? []).map(dropReason);
  const dropped: CriterionAgentDroppedItem[] = [];
  (review.assessments ?? []).forEach((assessment, index) => {
    const reason = reasons[index];
    if (reason && !dropped.some(item => item.technologyId === assessment.technologyId && item.reason === reason)) {
      dropped.push({ kind: 'assessment', technologyId: assessment.technologyId, reason });
    }
  });
  const kept = (review.assessments ?? []).filter((_assessment, index) => !reasons[index]);
  if (review.assessments) review.assessments = kept;
  if (dropped.length) review.droppedItems = [...review.droppedItems ?? [], ...dropped];

  const withheld = withheldCount(checklist);
  const replaceReason = review.recommendation === 'likely_sufficient'
    ? withheld ? `${withheld} checklist ${withheld === 1 ? 'subject was' : 'subjects were'} not given to it`
      : review.droppedItems?.some(item => item.kind === 'assessment') ? 'some of its results were dropped'
        : [...obligations.keys()].some(id => !kept.some(assessment => assessment.technologyId === id)) ? 'it returned no result for some checklist subjects'
          : kept.some(assessment => UNRESOLVED_TYPES.has(assessment.type) || assessment.coverageDisposition === 'unresolved')
            ? 'its results include an open question or a problem' : undefined
    : review.recommendation === 'likely_insufficient' && !kept.some(assessment => assessment.type === 'substantive_concern')
      ? 'none of its kept results is a potential problem' : undefined;
  if (replaceReason) {
    review.replacedRecommendation = { recommendation: review.recommendation!, reason: replaceReason };
    review.recommendation = 'needs_reviewer_judgment';
  }
}
