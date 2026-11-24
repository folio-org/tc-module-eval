import type { CriterionAgentRecommendation, EvaluationResult, EvaluationStatus } from './index';

/** One row of a criterion's display tree in the HTML report. */
export interface HtmlReportNode {
  /** A top-level heading with rows below it, a top-level sentence, a "Name: value" row, or a list row. */
  kind: 'section' | 'paragraph' | 'field' | 'row';
  /** The heading, sentence, field value, or the row's text after its lead and tag. */
  text: string;
  /** A field's name. */
  key?: string;
  /** The file, path, or coordinate a row starts with. */
  lead?: string;
  /** The commit-pinned link for the lead, present only when the criterion cites that tracked file. */
  href?: string;
  tag?: string;
  /** The count shown beside a heading or row, such as "3" or "2 findings". */
  count?: string;
  /** Whether the row's children are shown when the report opens. */
  open?: boolean;
  /** Whether every child is shown, none behind "Show more". */
  showAll?: boolean;
  /** Whether the text is shown in full rather than shortened. */
  fullText?: boolean;
  /** How many further entries the criterion left out of its details. */
  hidden?: number;
  children: HtmlReportNode[];
}

export interface HtmlReportItem {
  id: string;
  title: string;
  description?: string;
  status: EvaluationStatus;
  evidence: string;
  /** The evidence shown under the title of a criterion without an automated check. */
  subtitle: string;
  category: string;
  /** The report group: automated findings to review, passed, not applicable, or no automated check. */
  triage: 'review' | 'passed' | 'not-applicable' | 'human';
  /** Lowercase text the report search matches. */
  search: string;
  /** Whether the criterion's card is open when the report opens. */
  open?: boolean;
  recommendation?: CriterionAgentRecommendation;
  /** The checklist items a reviewer records a decision for; empty for the criterion as a whole. */
  reviewItems: Array<{ id: string; title: string }>;
  tree: HtmlReportNode[];
}

export interface HtmlReportView {
  meta: {
    module: string;
    language: string;
    repo: string;
    evaluatedAt: string;
    createdAt: string;
    commit?: string;
    evaluator?: { name: string; version: string };
    agentReviewModel?: string;
    agentReviewCost?: string;
  };
  items: HtmlReportItem[];
}

/** What the HTML report shows, and the report its "Download JSON" button saves. */
export interface PreparedHtmlReport {
  view: HtmlReportView;
  download: EvaluationResult;
}
