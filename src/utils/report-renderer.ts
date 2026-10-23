import { EvaluationResult } from '../types';
import { createHtmlReport } from './report-html-template';

export interface ReportRenderer {
  renderJson(result: EvaluationResult): string;
  renderHtml(result: EvaluationResult): string;
}

/**
 * Produces JSON and HTML report strings from an EvaluationResult.
 * Pure transformation: no I/O, no file writes.
 */
export class EvaluationReportRenderer implements ReportRenderer {
  renderJson(result: EvaluationResult): string {
    return JSON.stringify(result, null, 2);
  }

  renderHtml(result: EvaluationResult): string {
    return createHtmlReport(result);
  }
}
