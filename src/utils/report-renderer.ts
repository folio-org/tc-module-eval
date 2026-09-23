import { EvaluationResult, EvaluationStatus } from '../types';
import { redactJsonValue, redactSensitiveText } from './redaction';
import { createHtmlReport } from './report-html-template';

export interface EvaluationReportStats {
  pass: number;
  fail: number;
  manual: number;
  notApplicable: number;
  total: number;
}

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
    return JSON.stringify(redactJsonValue(result), null, 2);
  }

  renderHtml(result: EvaluationResult): string {
    return createHtmlReport(redactJsonValue(result));
  }

  // Retained for focused escaping tests and callers that format small HTML fragments.
  escapeHtml(text: string): string {
    const htmlEscapes: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, char => htmlEscapes[char]);
  }

  textToHtml(text: string): string {
    return this.escapeHtml(text).replace(/\n/g, '<br>');
  }

  calculateStats(result: EvaluationResult): EvaluationReportStats {
    const pass = result.criteria.filter(c => c.status === EvaluationStatus.PASS).length;
    const fail = result.criteria.filter(c => c.status === EvaluationStatus.FAIL).length;
    const manual = result.criteria.filter(c => c.status === EvaluationStatus.MANUAL).length;
    const notApplicable = result.criteria.filter(c => c.status === EvaluationStatus.NOT_APPLICABLE).length;

    return {
      pass,
      fail,
      manual,
      notApplicable,
      total: result.criteria.length
    };
  }
}
