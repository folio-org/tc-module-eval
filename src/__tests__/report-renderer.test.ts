import { EvaluationReportRenderer } from '../utils/report-renderer';
import { EvaluationResult, EvaluationStatus } from '../types';

describe('EvaluationReportRenderer', () => {
  const result: EvaluationResult = {
    repositoryUrl: 'https://github.com/folio-org/test-module',
    moduleName: 'test-module',
    language: 'Java',
    evaluatedAt: new Date('2026-06-03T12:00:00.000Z'),
    criteria: [
      {
        criterionId: 'S001',
        status: EvaluationStatus.PASS,
        evidence: 'Apache <2.0> & compatible',
        details: 'Line one\nLine two'
      },
      {
        criterionId: 'S002',
        status: EvaluationStatus.FAIL,
        evidence: 'Failed evidence'
      },
      {
        criterionId: 'S003',
        status: EvaluationStatus.MANUAL,
        evidence: 'Manual with token=abc123',
        details: 'Advisory says <script>alert("x")</script> password=hunter2',
        criterionDetails: {
          nested: [{ note: 'OPENAI_API_KEY=sk-details-secret' }]
        },
        agentReview: {
          available: true,
          criterionId: 'S003',
          recommendation: 'needs_reviewer_judgment',
          confidence: 'medium',
          summary: '<script>bad()</script>',
          rationale: 'private URL http://192.168.1.10/admin',
          evidenceReferences: ['README.md'],
          metadata: {
            adapter: 'fake',
            modelLabel: 'fake-model',
            reviewMode: 'read-only',
            promptInputSanitized: true,
            reviewWorkspaceSanitized: true
          },
          warnings: [],
          errors: []
        }
      },
      {
        criterionId: 'S004',
        status: EvaluationStatus.NOT_APPLICABLE,
        evidence: 'Not applicable evidence'
      },
      {
        criterionId: 'S005',
        status: EvaluationStatus.MANUAL,
        evidence: 'S005 manual: Completed disclosure with <checked> fields',
        details: [
          'Parsed disclosure fields:',
          '  - Checked answers: email',
          'Deterministic evidence:',
          '  - Strongest signals:',
          '    - schemas/user.json:1 [direct_contract/strong/email] Email field: **email** <script>bad()</script>'
        ].join('\n'),
        criterionDetails: {
          parseResult: {
            checkedCategories: ['email'],
            checklistItems: [
              {
                rawLabel: 'Email <address>',
                checked: true
              }
            ]
          },
          evidenceScan: {
            signals: [
              {
                excerpt: '[REDACTED_EMAIL] token=s005secret'
              }
            ]
          }
        }
      },
      {
        criterionId: 'S006',
        status: EvaluationStatus.FAIL,
        evidence: 'S006 fail: <script>alert("s006")</script> OPENAI_API_KEY=sk-proj-renderersecret1234567890',
        details: [
          'Deterministic failure findings:',
          '  - src/main/resources/application.yml:1 [production_source_or_configuration/high/critical/provider_api_key] provider-api-key',
          '    rationale: <img src=x onerror=alert(1)>',
          '    excerpt: OPENAI_API_KEY=sk-proj-renderersecret1234567890',
          'Manual review findings:',
          '  - docs/auth.md:1 [documentation/high/high/bearer_or_jwt_token] bearer-or-jwt-token',
          '    excerpt: Bearer abcdefghijklmnopqrstuvwxyz123456'
        ].join('\n'),
        criterionDetails: {
          findings: [
            {
              redactedExcerpt: {
                text: 'OPENAI_API_KEY=sk-proj-renderersecret1234567890'
              }
            }
          ],
          coverageSummary: {
            skippedFileCount: 1,
            scanLimitWarnings: [
              {
                kind: 'file-truncated',
                path: '/Users/alice/private/.env.production',
                message: 'token=renderersecret',
                materialToCoverage: true
              }
            ]
          }
        }
      }
    ]
  };

  it('should calculate report stats', () => {
    const renderer = new EvaluationReportRenderer();

    expect(renderer.calculateStats(result)).toEqual({
      pass: 1,
      fail: 2,
      manual: 2,
      notApplicable: 1,
      total: 6
    });
  });

  it('should render JSON with stable indentation', () => {
    const renderer = new EvaluationReportRenderer();
    const json = renderer.renderJson(result);

    expect(json).toContain('\n  "moduleName": "test-module"');
    expect(JSON.parse(json).criteria).toHaveLength(6);
  });

  it('should escape HTML and preserve multiline details', () => {
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml(result);

    expect(html).toContain('FOLIO Module Evaluation Report');
    expect(html).toContain('test-module');
    expect(html).toContain('Criterion S001');
    expect(html).toContain('Apache &lt;2.0&gt; &amp; compatible');
    expect(html).toContain('Line one<br>Line two');
  });

  it('escapes untrusted module names in the HTML title', () => {
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml({
      ...result,
      moduleName: '</title><script>alert("x")</script>'
    });

    expect(html).toContain('<title>FOLIO Module Evaluation Report - &lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</title>');
    expect(html).not.toContain('</title><script>');
  });

  it('redacts and escapes untrusted criterion and advisory fields', () => {
    const renderer = new EvaluationReportRenderer();
    const json = renderer.renderJson(result);
    const html = renderer.renderHtml(result);

    expect(json).toContain('token=[REDACTED]');
    expect(json).toContain('password=[REDACTED]');
    expect(json).toContain('"criterionDetails"');
    expect(json).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(json).toContain('[REDACTED_PRIVATE_URL]');
    expect(json).toContain('[REDACTED_EMAIL]');
    expect(json).toContain('token=[REDACTED]');
    expect(json).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(json).toContain('Bearer [REDACTED]');
    expect(json).not.toContain('abc123');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('sk-details-secret');
    expect(json).not.toContain('s005secret');
    expect(json).not.toContain('sk-proj-renderersecret1234567890');
    expect(json).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(json).not.toContain('renderersecret');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('**email** &lt;script&gt;bad()&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(html).toContain('Bearer [REDACTED]');
    expect(html).not.toContain('<script>bad()</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('token=abc123');
    expect(html).not.toContain('sk-proj-renderersecret1234567890');
  });

  it('should expose escaping helpers for focused renderer tests', () => {
    const renderer = new EvaluationReportRenderer();

    expect(renderer.escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
    expect(renderer.textToHtml('one\ntwo')).toBe('one<br>two');
  });
});
