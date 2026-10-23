import {
  CriterionAgentAssessment,
  CriterionAgentReviewResult,
  EvaluationStatus,
  FrontendChecklist,
  FrontendChecklistItem
} from '../types';
import { ASSESSMENT_LABELS, COVERAGE_LABELS, prose } from './agent-review-report';
import { reportPath, reportText } from './report-text';

/** The most obligations one F00x agent review is given; the rest are listed as not given to the agent. */
export const FRONTEND_AGENT_OBLIGATION_LIMIT = 25;

export const CHECKLIST_HEADING = 'Checklist for the reviewer:';

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
 * obligations, or says the item is checked by the reviewer only or the obligation was not given to the agent.
 */
export function renderFrontendChecklistLines(checklist: FrontendChecklist, review?: CriterionAgentReviewResult): string[] {
  if (checklist.items.length === 0) return [];
  const assessments = review?.available ? review.assessments ?? [] : undefined;
  const lines = [CHECKLIST_HEADING];
  for (const item of checklist.items) {
    lines.push(`  - ${item.id} ${reportText(item.title)}`);
    if (item.startingPoints.length) {
      lines.push('    - Start with:', ...item.startingPoints.map(point =>
        `      - ${reportPath(point.path)}${point.line ? `:${point.line}` : ''} — ${reportText(point.note)}`));
    }
    if (!assessments) continue;
    if (item.reviewerOnly) {
      lines.push('    - Checked by the reviewer only');
      continue;
    }
    for (const obligation of item.obligations) {
      const assessment = assessments.find(candidate => candidate.technologyId === obligation.id);
      const subject = obligation.subject ? reportText(obligation.subject) : undefined;
      if (assessment) {
        lines.push(...assessmentLines(subject, assessment));
      } else {
        // An accepted review answers every obligation it was given, so a missing one was withheld, or is a defect.
        const reason = obligation.withheld ? `Not given to the agent (limit of ${FRONTEND_AGENT_OBLIGATION_LIMIT})` : 'No agent result';
        lines.push(`    - ${reason}${subject ? `: ${subject}` : ''}`);
      }
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

// The label comes before the subject, which can be repository text such as a message id.
function assessmentLines(subject: string | undefined, assessment: CriterionAgentAssessment): string[] {
  return [
    `    - Agent: ${ASSESSMENT_LABELS[assessment.type][0]} — ${subject ? `${subject}: ` : ''}${prose(assessment.summary)}`,
    '      - Sources:',
    ...assessment.evidenceReferences.map(reference => `        - ${reportPath(reference)}`),
    ...(assessment.coverageDisposition ? [`      - Coverage judgment: ${COVERAGE_LABELS[assessment.coverageDisposition]}`] : [])
  ];
}
