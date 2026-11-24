import { EvaluationReportRenderer } from '../utils/report-renderer';
import { prepareHtmlReport } from '../utils/report-presentation';
import { CriterionAgentReviewResult, EvaluationResult, EvaluationStatus, S007AnalysisResult } from '../types';
import { renderS007HumanDetails } from '../utils/s007-report-details';
import { runInNewContext } from 'vm';
import { EVALUATOR_SECRETS, SECRET_NAMES, withEvaluatorSecrets } from './helpers/evaluator-secrets';

describe('EvaluationReportRenderer', () => {
  function reportData(html: string): any {
    const match = html.match(/<script id="report-data" type="application\/json">([\s\S]+?)<\/script>/);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]);
  }

  function downloadData(html: string): any {
    const match = html.match(/<script id="download-data" type="application\/json">([\s\S]+?)<\/script>/);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]);
  }

  // Runs the report script against a minimal DOM and returns its root element, with its keydown listener as `keydown`.
  function rendered(html: string): any {
    const scripts: Record<string, string> = {
      'report-data': html.match(/<script id="report-data" type="application\/json">([\s\S]+?)<\/script>/)![1],
      'download-data': '{}'
    };
    const element = (tagName?: string): any => {
      const node: any = { tagName, children: [], textContent: '', dataset: {}, style: { setProperty() {} },
        setAttribute() {}, addEventListener() {}, appendChild: (child: any) => { node.children.push(child); return child; },
        append: (...children: any[]) => { node.children.push(...children); },
        replaceChildren: (...children: any[]) => { node.children = children; } };
      return node;
    };
    const root = element();
    runInNewContext(html.match(/<script>\s*([\s\S]*?)<\/script>/)![1], {
      window: { addEventListener: (type: string, listener: unknown) => { if (type === 'keydown') root.keydown = listener; } },
      requestAnimationFrame() {},
      document: { activeElement: null, createElement: element, createElementNS: element,
        createTextNode: (text: string) => ({ ...element(), textContent: text }),
        getElementById: (id: string) => id === 'report' ? root : { textContent: scripts[id] } }
    });
    return root;
  }
  const descendants = (node: any): any[] => [node, ...node.children.flatMap(descendants)];
  // The page's visible text, in document order.
  function renderedText(html: string): string {
    const text = (node: any): string => [node.textContent, ...node.children.map(text)].filter(Boolean).join(' ');
    return text(rendered(html)).replace(/\s+/g, ' ');
  }

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

  it('should render JSON with stable indentation', () => {
    const renderer = new EvaluationReportRenderer();
    const json = renderer.renderJson(result);

    expect(json).toContain('\n  "moduleName": "test-module"');
    expect(JSON.parse(json).criteria).toHaveLength(6);
  });

  it('groups not-applicable criteria on their own and moves through the groups in on-screen order with j and k', () => {
    const human = 'This criterion requires manual evaluation by a human reviewer';
    const root = rendered(new EvaluationReportRenderer().renderHtml({ ...result, criteria: [
      { criterionId: 'B014', status: EvaluationStatus.NOT_APPLICABLE, evidence: 'Shared library', details: 'Health check: not applicable to a shared library' },
      { criterionId: 'A001', status: EvaluationStatus.MANUAL, evidence: 'Listed', details: human },
      { criterionId: 'S001', status: EvaluationStatus.PASS, evidence: 'Apache 2.0', details: 'Line one' },
      { criterionId: 'S004', status: EvaluationStatus.MANUAL, evidence: 'S004 manual: Docs need review', details: 'What to do: Check.' }
    ] }));
    const headings = descendants(root).filter(node => node.tagName === 'h2').map(node => node.textContent);
    expect(headings).toEqual(['Needs review', 'Passed', 'Not applicable', 'No automated check']);
    const selected = () => descendants(root).filter(node => /^jump\b/.test(node.className ?? '') && / selected/.test(node.className))
      .map(node => descendants(node).find(child => child.className === 'jump-id')?.textContent);
    const press = (key: string) => root.keydown({ key, target: { tagName: 'BODY' }, preventDefault() {} });
    const visited = ['j', 'j', 'j', 'j', 'k', 'k', 'k'].map(key => { press(key); return selected()[0]; });
    expect(visited).toEqual(['S004', 'S001', 'B014', 'A001', 'B014', 'S001', 'S004']);
  });

  it('renders a self-contained interactive report with structured criterion data', () => {
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml(result);
    const data = reportData(html);

    expect(html).toContain('FOLIO Module Evaluation Report');
    expect(html).toContain('Search criteria and evidence');
    expect(html).toContain('Expand criteria');
    expect(html).toContain('Collapse criteria');
    expect(html).toContain('Download JSON');
    expect(html).toContain('No automated check');
    expect(html).toContain('window.addEventListener(\'keydown\'');
    expect(html).not.toContain('fetch(');
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/);
    expect(data.meta.module).toBe('test-module');
    expect(data.items[0]).toMatchObject({
      id: 'S001',
      title: 'Open-source license',
      evidence: 'Apache <2.0> & compatible'
    });
  });

  it('embeds the prepared report and its download unchanged', () => {
    jest.useFakeTimers({ now: new Date('2026-11-12T15:00:00.000Z') });
    try {
      const html = new EvaluationReportRenderer().renderHtml(result);
      const prepared = JSON.parse(JSON.stringify(prepareHtmlReport(result)));

      expect(reportData(html)).toEqual(prepared.view);
      expect(downloadData(html)).toEqual(prepared.download);
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders prepared source links as links and other leads as text', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const html = new EvaluationReportRenderer().renderHtml({ ...result,
      provenance: { repositoryCommit: commit, evaluator: { name: 'e', version: '1' }, citedSourcePaths: ['README.md'] },
      criteria: [{ criterionId: 'S004', status: EvaluationStatus.MANUAL, evidence: 'Review needed.',
        details: 'Sources:\n  - README.md:12 documented setup\n  - /tmp/generated.json:1 generated output',
        criterionDetails: { sources: [{ path: 'README.md' }, { path: '/tmp/generated.json' }] } }] });
    const leads = descendants(rendered(html)).filter(node => node.className === 'lead')
      .map(node => ({ text: node.textContent, href: node.href, target: node.target, rel: node.rel }));

    expect(leads).toEqual([
      { text: 'README.md:12', href: `https://github.com/folio-org/test-module/blob/${commit}/README.md#L12`, target: '_blank', rel: 'noopener noreferrer' },
      { text: '/tmp/generated.json:1', href: undefined, target: undefined, rel: undefined }
    ]);
  });

  it('uses the singular for one criterion in the summary', () => {
    const text = (criteria: EvaluationResult['criteria']) => renderedText(new EvaluationReportRenderer().renderHtml({ ...result, criteria }));
    const criterion = { criterionId: 'S010', status: EvaluationStatus.MANUAL, evidence: 'Manual' };

    expect(text([criterion])).toMatch(/ 1 criterion · 1 with automated findings · 0 without an automated check /);
    expect(text([criterion, { ...criterion, criterionId: 'S011' }])).toMatch(/ 2 criteria · 2 with automated findings /);
  });

  it('removes repository URL credentials from both embedded reports', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const credentials = ['report-user', 'credential-value'].join(':');
    const repositoryUrl = `https://${credentials}@github.com/folio-org/test-module`;
    const cleanRepositoryUrl = 'https://github.com/folio-org/test-module';
    const html = new EvaluationReportRenderer().renderHtml({
      ...result,
      repositoryUrl,
      provenance: {
        repositoryCommit: commit,
        evaluator: { name: 'folio-module-evaluator', version: '1.2.3' },
        citedSourcePaths: ['README.md']
      }
    });
    const data = reportData(html);
    const downloaded = downloadData(html);

    expect(data.meta.repo).toBe(cleanRepositoryUrl);
    expect(downloaded.repositoryUrl).toBe(cleanRepositoryUrl);
    expect(html).not.toContain(credentials);
  });

  it('shows every row of the agent review, without "Show more"', () => {
    // S006's review also states its scope, so its section has more than eight rows.
    const review: CriterionAgentReviewResult = { available: true, criterionId: 'S006', recommendation: 'likely_sufficient',
      confidence: 'medium', summary: 'Justified.', rationale: 'Read each suppression.', evidenceReferences: ['pom.xml'], warnings: [], errors: [],
      reviewerActions: [{ action: 'Add comments.', evidenceReferences: ['pom.xml'] }],
      assessments: Array.from({ length: 9 }, (_, index) => ({ technologyId: `group-${index}`, type: 'aligned_fact' as const,
        summary: `Group ${index} is justified.`, evidenceReferences: ['pom.xml'], coverageDisposition: 'investigated' as const })) };
    const html = new EvaluationReportRenderer().renderHtml({ ...result, criteria: [{ criterionId: 'S006', status: EvaluationStatus.MANUAL,
      evidence: 'S006 manual', details: 'Findings:\n  - Values to check: 1', agentReview: review }] });
    const text = renderedText(html);

    expect(text.match(/Show \d+ more/g)).toEqual(['Show 3 more']);
    expect(text.indexOf('Show 3 more')).toBeLessThan(text.indexOf('What to verify'));
    expect(text).toContain('Advisory only; the criterion status is unchanged.');
  });

  it('shows every section of a card, without "Show more"', () => {
    const details = Array.from({ length: 10 }, (_, index) => `Section ${index}:\n  - row ${index}`).join('\n');
    const text = renderedText(new EvaluationReportRenderer().renderHtml({ ...result, criteria: [{ criterionId: 'B003',
      status: EvaluationStatus.MANUAL, evidence: 'B003 manual', details }] }));

    expect(text).toContain('Section 9');
    expect(text).not.toMatch(/Show \d+ more/);
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

  it("masks each of the evaluator's secrets in both reports, wherever and however often they appear", async () => {
    const mentions = SECRET_NAMES.map(name => `${name} ${EVALUATOR_SECRETS[name]} and ${EVALUATOR_SECRETS[name]}`).join('; ');
    const masked = SECRET_NAMES.map(name => `${name} [REDACTED_${name}] and [REDACTED_${name}]`).join('; ');
    const report: EvaluationResult = { ...result, criteria: [{
      criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: mentions, details: mentions,
      criterionDetails: { nested: [{ note: mentions }], [EVALUATOR_SECRETS.GITHUB_TOKEN]: 'key' },
      agentReview: { available: true, criterionId: 'S005', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
        summary: mentions, rationale: mentions, evidenceReferences: ['README.md'], warnings: [mentions], errors: [] }
    }] };
    const renderer = new EvaluationReportRenderer();
    const [json, html] = await withEvaluatorSecrets(() => [renderer.renderJson(report), renderer.renderHtml(report)]);

    for (const value of Object.values(EVALUATOR_SECRETS)) {
      expect(json).not.toContain(value);
      expect(html).not.toContain(value);
    }
    const criterion = JSON.parse(json).criteria[0];
    expect([criterion.evidence, criterion.details, criterion.criterionDetails.nested[0].note, criterion.agentReview.summary])
      .toEqual([masked, masked, masked, masked]);
    expect(Object.keys(criterion.criterionDetails)).toEqual(['nested', '[REDACTED_GITHUB_TOKEN]']);
    expect(reportData(html).items[0].evidence).toBe(masked);
    expect(downloadData(html).criteria[0].agentReview.rationale).toBe(masked);
  });

  it('escapes untrusted criterion and advisory fields', () => {
    const renderer = new EvaluationReportRenderer();
    const json = renderer.renderJson(result);
    const html = renderer.renderHtml(result);
    const data = reportData(html);
    const embedded = JSON.stringify(data);
    const downloaded = JSON.stringify(downloadData(html));

    expect(json).toContain('"criterionDetails"');
    expect(embedded).toContain('<script>alert(\\"x\\")</script>');
    expect(embedded).toContain('**email** <script>bad()</script>');
    expect(embedded).toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('</script> password=');
    expect(html).not.toContain('<script>bad()</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(downloadData(html).criteria[2]).toHaveProperty('criterionDetails');
    expect(downloadData(html).criteria[2]).toHaveProperty('agentReview');
  });

  it('keeps S007 JSON and HTML rationale aligned and escapes repository-controlled evidence', () => {
    const analysis: S007AnalysisResult = {
      criterionId: 'S007',
      status: EvaluationStatus.FAIL,
      summary: 'S007 fail: normative violation with retained manual evidence.',
      policyFormatVersion: '1.0',
      findings: [
        {
          technologyId: 'react',
          displayName: 'React <script>alert("x")</script>',
          classification: 'normative-violation',
          contribution: 'fail',
          rationale: 'React 17 violates the current rule.',
          evidence: [{
            path: 'package<script>.json',
            detail: 'dependencies.react',
            declaredVersion: '17.0.2',
            resolvedVersion: '17.0.2',
            versionSourcePath: 'yarn.lock'
          }],
          matchedPolicy: {
            sectionId: 'frontend-third-party-frameworks',
            entryId: 'react',
            displayName: 'React',
            strength: 'normative',
            sourceStatement: 'React 18.2',
            constraint: { kind: 'minor-line', expression: '18.2' }
          },
          advisories: [],
          statusDetermining: true
        },
        {
          technologyId: 'vue',
          displayName: 'Vue',
          classification: 'unlisted-framework',
          contribution: 'manual',
          rationale: 'Unlisted framework candidate.',
          evidence: [{ path: 'package.json', detail: 'dependencies.vue', declaredVersion: '^3' }],
          advisories: [],
          statusDetermining: false
        }
      ],
      policyDiagnostics: [],
      evidenceDiagnostics: []
    };
    const s007Result: EvaluationResult = {
      ...result,
      criteria: [{
        criterionId: 'S007',
        status: EvaluationStatus.FAIL,
        evidence: analysis.summary,
        details: renderS007HumanDetails(analysis),
        criterionDetails: analysis
      }]
    };
    const renderer = new EvaluationReportRenderer();
    const json = JSON.parse(renderer.renderJson(s007Result));
    const html = renderer.renderHtml(s007Result);

    expect(json.criteria[0].criterionDetails.findings.map((finding: any) => finding.contribution)).toEqual(['fail', 'manual']);
    expect(json.criteria[0].criterionDetails.findings[0].matchedPolicy.entryId).toBe('react');
    expect(json.criteria[0].criterionDetails.findings[0].evidence[0].versionSourcePath).toBe('yarn.lock');
    expect(renderedText(html)).toContain(' React <script>alert("x")</script>: Fails: not an officially supported version. 1 observation ');
    expect(html).not.toContain('<script>alert("x")</script>');
  });
});
