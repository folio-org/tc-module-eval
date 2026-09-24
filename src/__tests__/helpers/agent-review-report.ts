import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvaluationResult, EvaluationStatus, CriterionAgentReviewResult } from '../../types';
import { analyzeS005PersonalDataDisclosure } from '../../utils/s005-personal-data-disclosure';
import { formatS005Evidence } from '../../utils/s005-personal-data-disclosure-report';

/** Synthetic report shared by renderer regressions and browser verification. */
export function agentReviewReport(): EvaluationResult {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-report-'));
  try {
    fs.writeFileSync(path.join(repo, 'PERSONAL_DATA_DISCLOSURE.md'), [
      '# Personal Data Disclosure', 'Form Version: v1.1', 'Last Updated: 2026-09-24',
      'Last Reviewed: 2026-09-24', '## Personal Data',
      '- [x] Does not store personal data', '- [x] Email address'
    ].join('\n'));
    const analysis = analyzeS005PersonalDataDisclosure(repo);
    const agentReview: CriterionAgentReviewResult = {
      available: true, criterionId: 'S005', recommendation: 'likely_insufficient', confidence: 'medium',
      summary: 'The disclosure contains conflicting answers.',
      rationale: 'The form selects both no personal data and email address. A reviewer should resolve that contradiction against repository evidence. RATIONALE_END',
      evidenceReferences: ['PERSONAL_DATA_DISCLOSURE.md'], warnings: [], errors: [],
      metadata: { adapter: 'fake', modelLabel: 'synthetic-review-model', reviewMode: 'read-only',
        promptInputSanitized: true, reviewWorkspaceSanitized: true }
    };
    const formatted = formatS005Evidence(analysis, { kind: 'backend-module', warnings: [],
      evidence: Array.from({ length: 100 }, (_, i) => `Synthetic supporting observation ${i}: ${'évidence '.repeat(20)}`)
    }, agentReview);
    return { repositoryUrl: 'https://github.com/folio-org/test-module', moduleName: 'Synthetic advisory regression',
      language: 'Java', evaluatedAt: new Date('2026-09-24T12:00:00Z'), criteria: [
        { criterionId: 'S005', status: EvaluationStatus.MANUAL, ...formatted, agentReview },
        { criterionId: 'S006', status: EvaluationStatus.MANUAL,
          evidence: 'S006 manual: documentation example requires reviewer context.',
          details: 'Manual review findings:\n  - docs/auth.md:1 — redacted bearer example\nAgent review:\n  - Not applied: OpenCode returned incomplete response (finish: missing)\n  - Deterministic findings remain unchanged.',
          agentReview: { available: false, criterionId: 'S006', evidenceReferences: [], warnings: [],
            errors: ['OpenCode returned incomplete response (finish: missing)'] }
        }
      ] };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
