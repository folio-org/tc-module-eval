import {
  CriterionAgentAssessment,
  CriterionAgentReviewResult,
  EvaluationStatus,
  FrontendChecklist,
  FrontendChecklistItem
} from '../types';
import { ASSESSMENT_LABELS, COVERAGE_LABELS, prose, RECOMMENDATION_LABELS, renderAgentReviewLines } from './agent-review-report';
import { overflowLine, reportPath, reportText } from './report-text';

/** The most obligations one F00x agent review is given; the rest are listed as not given to the agent. */
export const FRONTEND_AGENT_OBLIGATION_LIMIT = 25;

export const CHECKLIST_HEADING = 'Checklist for the reviewer:';

/** The most starting points shown per checklist item; the rest are counted. */
export const SHOWN_STARTING_POINTS = 20;

/** An F criterion's checklist: the items for a fail or manual result, none for pass or not applicable. */
export function frontendChecklist(status: EvaluationStatus, items: FrontendChecklistItem[]): FrontendChecklist {
  return { items: status === EvaluationStatus.FAIL || status === EvaluationStatus.MANUAL ? items : [] };
}

/** The checklist of an F criterion's result, or undefined for other criteria. */
export function frontendChecklistOf(criterionId: string, criterionDetails: unknown): FrontendChecklist | undefined {
  if (!/^F\d{3}$/.test(criterionId)) return undefined;
  const checklist = (criterionDetails as { checklist?: FrontendChecklist } | undefined)?.checklist;
  return Array.isArray(checklist?.items) ? checklist : undefined;
}

/**
 * The checklist as report rows. With an accepted agent review, each item lists the agent's result for each of its
 * obligations and why any result for it was dropped, or says the item is checked by the reviewer only, the obligation
 * was not given to the agent, or the agent returned no result for it.
 */
export function renderFrontendChecklistLines(checklist: FrontendChecklist, review?: CriterionAgentReviewResult): string[] {
  if (checklist.items.length === 0) return [];
  const assessments = review?.available ? review.assessments ?? [] : undefined;
  const lines = [CHECKLIST_HEADING];
  for (const item of checklist.items) {
    lines.push(`  - ${item.id} ${reportText(item.title)}`);
    if (item.startingPoints.length) {
      lines.push('    - Start with:', ...item.startingPoints.slice(0, SHOWN_STARTING_POINTS).map(point =>
        `      - ${reportPath(point.path)}${point.line ? `:${point.line}` : ''} — ${reportText(point.note)}`),
      ...overflowLine(item.startingPoints.length, SHOWN_STARTING_POINTS, '      '));
    }
    if (!assessments) continue;
    if (item.reviewerOnly) {
      lines.push('    - Checked by the reviewer only');
      continue;
    }
    for (const obligation of item.obligations) {
      const subject = obligation.subject ? reportText(obligation.subject) : undefined;
      if (obligation.withheld) {
        lines.push(`    - Not given to the agent (limit of ${FRONTEND_AGENT_OBLIGATION_LIMIT})${subject ? `: ${subject}` : ''}`);
        continue;
      }
      const kept = assessments.filter(candidate => candidate.technologyId === obligation.id);
      const dropped = (review?.droppedItems ?? []).filter(candidate => candidate.kind === 'assessment' && candidate.technologyId === obligation.id);
      lines.push(...kept.flatMap(assessment => assessmentLines(subject, assessment)),
        ...dropped.map(item => `    - Agent result dropped${subject ? ` — ${subject}` : ''}: ${reportText(item.reason)}`));
      if (!kept.length && !dropped.length) lines.push(`    - No agent result${subject ? `: ${subject}` : ''}`);
    }
  }
  return lines;
}

/** Assessments that answer none of the checklist's reviewed obligations, such as `discovered:` ones. */
export function unattachedAssessments(checklist: FrontendChecklist, review: CriterionAgentReviewResult): CriterionAgentAssessment[] {
  const obligationIds = new Set(checklist.items.filter(item => !item.reviewerOnly)
    .flatMap(item => item.obligations.map(obligation => obligation.id)));
  return (review.assessments ?? []).filter(assessment => !obligationIds.has(assessment.technologyId));
}

// What an agent may report beyond the checklist, as discovered:<kind>:<n> (F001 and F003).
const DISCOVERED_KIND_NAMES: Record<string, string> = {
  text: 'Hard-coded text found by the agent',
  id: 'Missing message id found by the agent',
  interface: 'Request found by the agent'
};

/**
 * An accepted review's own section: the recommendation (and the agent's own, when it was replaced), summary, the
 * findings that answer no checklist obligation, such as `discovered:` ones, reviewer actions, then the dropped items
 * that belong to no obligation given to the agent, before the review's sources.
 */
export function renderFrontendAgentReviewLines(checklist: FrontendChecklist, review: CriterionAgentReviewResult): string[] {
  const unattached = unattachedAssessments(checklist, review);
  const names = Object.fromEntries(unattached.flatMap(assessment => {
    const match = /^discovered:([a-z]+):(\d+)$/.exec(assessment.technologyId);
    return match && DISCOVERED_KIND_NAMES[match[1]] ? [[`${match[1]}:${match[2]}`, `${DISCOVERED_KIND_NAMES[match[1]]} (${match[2]})`]] : [];
  }));
  const lines = renderAgentReviewLines({ ...review, assessments: unattached }, names);
  const replaced = review.replacedRecommendation;
  const recommendation = lines.findIndex(line => line.startsWith('  - Recommendation: '));
  if (replaced) lines[recommendation] += ` — the agent recommended "${RECOMMENDATION_LABELS[replaced.recommendation]}", but ${reportText(replaced.reason)}.`;
  const given = new Set(checklist.items.filter(item => !item.reviewerOnly)
    .flatMap(item => item.obligations.filter(obligation => !obligation.withheld).map(obligation => obligation.id)));
  const dropped = (review.droppedItems ?? []).filter(item => item.kind === 'reviewer_action' || !given.has(item.technologyId ?? ''));
  if (dropped.length) {
    const sources = lines.indexOf('  - Sources:');
    lines.splice(sources < 0 ? lines.length : sources, 0, '  - Dropped from this review:', ...dropped.map(item => `    - ${item.kind === 'reviewer_action'
      ? 'A reviewer action' : !item.technologyId ? 'A result without an ID' : `A result for ${reportText(item.technologyId)}`}: ${reportText(item.reason)}`));
  }
  return [...lines, '  - Advisory only; the criterion status is unchanged.'];
}

/**
 * Layers 2 and 3 of an F criterion's details: the checklist with the agent's results, and the review's own section,
 * or the reason it was not applied.
 */
export function frontendReviewLines(
  checklist: FrontendChecklist,
  review: CriterionAgentReviewResult | undefined,
  unavailableReason: string | undefined
): string[] {
  return [
    ...renderFrontendChecklistLines(checklist, review),
    ...(review?.available ? renderFrontendAgentReviewLines(checklist, review)
      : unavailableReason ? ['Agent review:', `  - Not applied: ${reportText(unavailableReason)}`] : [])
  ];
}

// The label comes before the subject, which can be repository text such as a message id.
function assessmentLines(subject: string | undefined, assessment: CriterionAgentAssessment): string[] {
  return [
    `    - Agent: ${ASSESSMENT_LABELS[assessment.type][0]} — ${subject ? `${subject}: ` : ''}${prose(assessment.summary)}`,
    '      - Sources:',
    ...assessment.evidenceReferences.map(reference => `        - ${reportPath(reference)}`),
    ...(assessment.coverageDisposition ? [`      - Coverage judgment: ${COVERAGE_LABELS[assessment.coverageDisposition]}`] : [])
  ];
}
