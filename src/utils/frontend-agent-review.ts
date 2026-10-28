import {
  CriterionAgentReviewResult,
  FrontendChecklist,
  FrontendChecklistItem,
  FrontendChecklistObligation
} from '../types';
import { CriterionAgentReviewRequest } from './criterion-agent-review';
import { FRONTEND_AGENT_OBLIGATION_LIMIT, SHOWN_STARTING_POINTS } from './frontend-checklist';
import { isProductionSourcePath } from './frontend-source';

/** F00x reviews wait for the model longer than the shared 120 s default; ui-checkin's S010 review took 158 s. */
export const FRONTEND_AGENT_TIMEOUT_MS = 420_000;

const EVIDENCE_SUMMARY_BYTES = 48 * 1024;

/** A checklist item before its obligations are numbered: what the agent assesses, one obligation per subject. */
export type FrontendChecklistItemDraft = FrontendChecklistItem & {
  subjects: Array<{ subject: string; path?: string; line?: number }>;
};

/**
 * Number each item's obligations (`F003-C1#1`, `F003-C1#2`, ...): one per subject, or one for the whole item when it
 * has none; reviewer-only items get none. At most FRONTEND_AGENT_OBLIGATION_LIMIT are given to the agent: subject
 * obligations first, in item order, then whole-item ones. The rest are marked withheld.
 */
export function numberObligations(drafts: FrontendChecklistItemDraft[]): FrontendChecklistItem[] {
  const items = drafts.map(({ subjects, ...item }) => ({
    ...item,
    obligations: item.reviewerOnly ? [] : subjects.length
      ? subjects.map((subject, index): FrontendChecklistObligation => ({ id: `${item.id}#${index + 1}`, ...subject }))
      : [{ id: `${item.id}#1` }]
  }));
  const ranked = [...items.flatMap(item => item.obligations.filter(obligation => obligation.subject !== undefined)),
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
  return path => path === 'package.json' || extraPaths.includes(path) || isProductionSourcePath(path)
    || (/^(?:src|lib)\/.*\.css$/.test(path) && !/(?:^|\/)(?:stories|examples)\//.test(path));
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
  /** The criterion's own validation rule, applied after the shared ones. */
  validateCriterion?: (review: CriterionAgentReviewResult) => string | undefined;
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
  const responseShape = {
    note: 'Shape example only, not findings. Replace prose and citations with investigated evidence, and return one assessment for every obligation in checklist.json.',
    response: {
      recommendation: 'needs_reviewer_judgment',
      confidence: 'medium',
      summary: 'State the overall judgment and the remaining decision.',
      rationale: 'State the decisive evidence and the scope actually investigated.',
      evidenceReferences: ['src/actual/source/path.js'],
      assessments: [
        { technologyId: given[0]?.id ?? `${criterionId}-C1#1`, type: 'aligned_fact', summary: 'State whether the item\'s desired state holds for this subject, with line numbers.',
          evidenceReferences: [given[0]?.path ?? 'src/actual/source/path.js'], coverageDisposition: 'investigated' },
        ...(discoveredExample ? [{ technologyId: discoveredExample, type: 'substantive_concern', summary: 'Describe a problem of the same kind that the tool did not list.',
          evidenceReferences: ['src/other/source/path.js'], coverageDisposition: 'investigated' }] : [])
      ],
      reviewerActions: [{ action: 'Name the fact to verify and the decision it resolves.', evidenceReferences: ['src/actual/source/path.js'] }]
    }
  };
  return {
    criterionId,
    repositoryPath: options.repositoryPath,
    browseInclude: options.browseInclude,
    defaultTimeoutMs: FRONTEND_AGENT_TIMEOUT_MS,
    instructions: [
      `Act as an advisory reviewer for ${options.criterionTitle}.`,
      `You may browse only: ${options.browseScope}.`,
      `checklist.json lists the reviewer's checklist. Each item is phrased as the desired state. Each obligation (an ID such as ${given[0]?.id ?? `${criterionId}-C1#1`}) asks whether the item's desired state holds for its subject, or for the whole item when it has no subject. evidence-summary.json holds the tool's deterministic findings.`,
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
    validateReview: (review, availableSourcePaths) => validateFrontendReview(criterionId, checklist, discoveredKinds, review, availableSourcePaths)
      ?? options.validateCriterion?.(review),
    schemaDescription: 'JSON object with recommendation enum, confidence enum, nonblank summary and rationale, nonempty evidenceReferences string[] of repository paths, assessments[] (one object per obligation ID in checklist.json, plus discovered ones: technologyId, type, summary, evidenceReferences string[], coverageDisposition investigated|immaterial|unresolved), and reviewerActions[] of { action, evidenceReferences string[] }. See response-shape.json for a complete example.'
  };
}

// Lists are cut to fewer entries until the JSON fits, rather than cutting the JSON text.
function boundedSummary(render: (maxListEntries: number) => unknown): string {
  for (let entries = 1_000; entries >= 1; entries = Math.floor(entries / 2)) {
    const text = JSON.stringify(render(entries), null, 2);
    if (Buffer.byteLength(text) <= EVIDENCE_SUMMARY_BYTES) return text;
  }
  throw new Error(`the evidence summary does not fit in ${EVIDENCE_SUMMARY_BYTES} bytes`);
}

const UNRESOLVED_TYPES = new Set(['substantive_concern', 'evidence_gap', 'policy_question']);

/**
 * The F00x validation contract, all or nothing: one assessment with a coverage disposition per given obligation,
 * only allowed discovered IDs, investigated subjects cite their own path, subjects outside the browse scope stay
 * unresolved, and the recommendation agrees with the assessments, the reviewer actions and withheld obligations.
 * Citations of repository paths are checked before this by the shared runner.
 */
export function validateFrontendReview(
  criterionId: string,
  checklist: FrontendChecklist,
  discoveredKinds: string[],
  review: CriterionAgentReviewResult,
  availableSourcePaths: ReadonlySet<string>
): string | undefined {
  const assessments = review.assessments ?? [];
  const obligations = givenObligations(checklist);
  const discovered = new RegExp(`^discovered:(?:${discoveredKinds.join('|') || '(?!)'}):[1-9]\\d*$`);
  const isDiscovered = (id: string) => discovered.test(id);
  if (obligations.some(obligation => assessments.filter(assessment => assessment.technologyId === obligation.id).length !== 1)
    || new Set(assessments.map(assessment => assessment.technologyId)).size !== assessments.length
    || assessments.some(assessment => !obligations.some(obligation => obligation.id === assessment.technologyId) && !isDiscovered(assessment.technologyId))) {
    return `${criterionId} requires exactly one assessment for every obligation in checklist.json, and no other IDs except `
      + `${discoveredKinds.length ? discoveredKinds.map(kind => `discovered:${kind}:<n>`).join(' or ') : 'none'}.`;
  }
  if (assessments.some(assessment => !assessment.coverageDisposition)) {
    return `${criterionId} requires a coverageDisposition on every assessment.`;
  }
  for (const obligation of obligations.filter(item => item.path)) {
    const assessment = assessments.find(item => item.technologyId === obligation.id)!;
    if (!availableSourcePaths.has(obligation.path!) && assessment.coverageDisposition !== 'unresolved') {
      return `${criterionId} obligation ${obligation.id} is about a file outside the review snapshot, so it must stay unresolved.`;
    }
    if (assessment.coverageDisposition === 'investigated' && !assessment.evidenceReferences.includes(obligation.path!)) {
      return `${criterionId} obligation ${obligation.id} is marked investigated but does not cite its own file.`;
    }
  }
  if (assessments.some(assessment => (assessment.type === 'aligned_fact' && assessment.coverageDisposition === 'unresolved')
    || (assessment.type === 'evidence_gap' && assessment.coverageDisposition === 'investigated'))) {
    return `${criterionId} does not accept an unresolved aligned_fact or an investigated evidence_gap.`;
  }
  if (assessments.some(assessment => isDiscovered(assessment.technologyId) && !['substantive_concern', 'evidence_gap'].includes(assessment.type))) {
    return `${criterionId} discovered assessments must be substantive_concern or evidence_gap.`;
  }
  if (review.recommendation === 'likely_sufficient' && (withheldCount(checklist) > 0
    || assessments.some(assessment => UNRESOLVED_TYPES.has(assessment.type) || assessment.coverageDisposition === 'unresolved'))) {
    return `${criterionId} likely_sufficient conflicts with an open assessment, a discovered problem or obligations not given to the agent.`;
  }
  if (review.recommendation === 'likely_insufficient' && !assessments.some(assessment => assessment.type === 'substantive_concern')) {
    return `${criterionId} likely_insufficient requires a cited substantive_concern.`;
  }
  if (review.recommendation === 'needs_reviewer_judgment' && !review.reviewerActions?.length) {
    return `${criterionId} needs_reviewer_judgment requires a cited reviewer action.`;
  }
  return undefined;
}
