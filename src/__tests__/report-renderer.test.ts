import { EvaluationReportRenderer } from '../utils/report-renderer';
import { EvaluationResult, EvaluationStatus, S007AnalysisResult } from '../types';
import { renderS007HumanDetails } from '../utils/s007-report-details';
import { agentReviewReport } from './helpers/agent-review-report';
import { runInNewContext } from 'vm';

describe('EvaluationReportRenderer', () => {
  function reportData(html: string): any {
    const match = html.match(/<script id="report-data" type="application\/json">([\s\S]+?)<\/script>/);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]);
  }

  function preparedItems(html: string): any[] {
    const data = reportData(html);
    const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)![1];
    const setup = script.slice(0, script.indexOf('var items = data.items.map(prepare);'));
    return runInNewContext(setup + 'return data.items.map(prepare); }());', {
      document: { getElementById: () => ({ textContent: JSON.stringify(data) }) }
    });
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

  it('retains budgeted S005 rationale and S006 fallback in HTML report data', () => {
    const report = agentReviewReport();
    const html = new EvaluationReportRenderer().renderHtml(report);
    const data = reportData(html);
    const details = data.items[0].details.join('\n');
    expect(Buffer.byteLength(report.criteria[0].details!, 'utf8')).toBeLessThanOrEqual(12000);
    expect(details).toContain('Contradictions:');
    expect(details).toContain('PERSONAL_DATA_DISCLOSURE.md:');
    expect(details).toContain('RATIONALE_END');
    expect(details).not.toContain('synthetic-review-model');
    expect(details.indexOf('Agent review (advisory):')).toBeLessThan(details.indexOf('Contradictions:'));
    expect(data.items[1].details.join('\n')).toContain('Status: Unavailable');
    expect(report.criteria[1].agentReview?.errors).toContain('OpenCode returned incomplete response (finish: missing)');
    expect(data.items.map((item: { status: string }) => item.status)).toEqual(['manual', 'manual']);
    // Execute the actual browser-side preparation, not only the serialized input.
    const items = preparedItems(html);
    const sections = items[0].tree.map((node: { text: string }) => node.text);
    expect(sections).toContain('Possible mismatches:');
    expect(sections[0]).toBe('Agent review (advisory):');
  });

  it('uses the same structured advisory section across criteria without exposing runtime metadata', () => {
    const report: EvaluationResult = { ...result, criteria: ['S004', 'S005', 'S006', 'S007', 'S010'].map(criterionId => ({
      criterionId, status: EvaluationStatus.MANUAL, evidence: 'Review needed.',
      details: 'Evidence:\n  - Keep before\nAgent review:\n  - Model label: hidden-model\n  - Adapter: fake\n  - Summary: stale\nDiagnostics:\n  - Keep after',
      agentReview: { available: true, criterionId, recommendation: 'needs_reviewer_judgment', confidence: 'medium',
        summary: 'Current summary', rationale: 'Current rationale', evidenceReferences: ['pom.xml'], warnings: [], errors: [],
        metadata: { adapter: 'fake', modelLabel: 'hidden-model', reviewMode: 'read-only',
          promptInputSanitized: true, reviewWorkspaceSanitized: true } }
    })) };
    const original = JSON.stringify(report);
    const html = new EvaluationReportRenderer().renderHtml(report);
    expect(html).not.toMatch(/hidden-model|Adapter:|Model label:|Summary: stale/);
    for (const item of preparedItems(html)) {
      expect(item.tree[0]).toMatchObject({ text: 'Agent review (advisory):', hideCount: true });
      expect(item.tree[0].children.map((node: any) => node.text)).toEqual([
        'Recommendation: Reviewer judgment needed', 'Confidence: medium', 'Summary: Current summary',
        'Rationale: Current rationale',
        ...(item.id === 'S006' ? ['Scope: Advice covers the findings and source investigated below; it is not a repository-wide certification that secrets are absent.'] : []),
        'Sources:', 'Advisory only; the criterion status is unchanged.'
      ]);
      expect(item.tree[0].children.find((node: any) => node.text === 'Sources:')).toMatchObject({ unit: 'sources', children: [{ text: 'pom.xml', children: [] }] });
      expect(item.tree.map((node: any) => node.text)).toEqual(['Agent review (advisory):', 'Evidence:', 'Diagnostics:']);
    }
    expect(JSON.stringify(report)).toBe(original);
  });

  it('keeps unavailable diagnostics in JSON without leaking model names into HTML', () => {
    const report: EvaluationResult = { ...result, criteria: [{
      criterionId: 'S010', status: EvaluationStatus.MANUAL, evidence: 'Manual',
      details: 'Agent review:\n  - Not applied: model hidden-model timed_out',
      agentReview: { available: false, criterionId: 'S010', recommendation: 'likely_sufficient',
        evidenceReferences: [], warnings: [], errors: ['model hidden-model timed_out'] }
    }] };
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml(report);
    expect(html).not.toContain('hidden-model');
    expect(reportData(html).items[0].recommendation).toBeUndefined();
    expect(reportData(html).items[0].details).toContain('  - Summary: The review exceeded its time limit.');
    expect(renderer.renderJson(report)).toContain('model hidden-model timed_out');
  });

  it.each([
    ['agent review is not enabled for S005', 'Skipped because agent review is not enabled for this criterion.'],
    ['no candidate evidence was available for agent review', 'Skipped because no candidate evidence was available for review.'],
    ['agent review is disabled or unconfigured', 'Skipped because agent review is disabled or unconfigured.']
  ])('labels a review that did not run as skipped: %s', (reason, summary) => {
    const report: EvaluationResult = { ...result, criteria: [{
      criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: 'Manual',
      details: `Agent review:\n  - Not applied: ${reason}`
    }] };
    const details = reportData(new EvaluationReportRenderer().renderHtml(report)).items[0].details;
    expect(details).toContain('  - Status: Skipped');
    expect(details).toContain(`  - Summary: ${summary}`);
    expect(details.join('\n')).not.toContain('No usable advisory review was returned');
  });

  it('keeps provider and runtime failures unavailable rather than skipped', () => {
    const report: EvaluationResult = { ...result, criteria: [{
      criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: 'Manual',
      details: 'Evidence remains.',
      agentReview: { available: false, criterionId: 'S005', evidenceReferences: [], warnings: [],
        errors: ['Provider returned incomplete response'] }
    }] };
    const details = reportData(new EvaluationReportRenderer().renderHtml(report)).items[0].details;
    expect(details).toContain('  - Status: Unavailable');
    expect(details).toContain('  - Summary: No usable advisory review was returned. See the JSON report for diagnostic details.');
    expect(details).not.toContain('  - Status: Skipped');
  });

  it('should render JSON with stable indentation', () => {
    const renderer = new EvaluationReportRenderer();
    const json = renderer.renderJson(result);

    expect(json).toContain('\n  "moduleName": "test-module"');
    expect(JSON.parse(json).criteria).toHaveLength(6);
  });

  it('renders a self-contained interactive report with structured criterion data', () => {
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml(result);
    const data = reportData(html);

    expect(html).toContain('FOLIO Module Evaluation Report');
    expect(html).toContain('Search criteria and evidence');
    expect(html).toContain('Expand all');
    expect(html).toContain('No automated check');
    expect(html).toContain('window.addEventListener(\'keydown\'');
    expect(html).not.toContain('fetch(');
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/);
    expect(data.meta.module).toBe('test-module');
    expect(data.items[0]).toMatchObject({
      id: 'S001',
      title: 'Open-source license',
      evidence: 'Apache <2.0> & compatible',
      details: ['Line one', 'Line two']
    });
  });

  it('uses a stable S008 title while retaining the evaluation summary as evidence', () => {
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml({
      ...result,
      criteria: [{
        criterionId: 'S008',
        status: EvaluationStatus.PASS,
        evidence: 'All 14 declared interfaces have compatible eligible providers in the official catalog.'
      }]
    });

    expect(reportData(html).items[0]).toMatchObject({
      id: 'S008',
      title: 'FOLIO interface usage',
      evidence: 'All 14 declared interfaces have compatible eligible providers in the official catalog.'
    });
  });

  it('uses a stable S009 title while retaining the evaluation summary as evidence', () => {
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml({
      ...result,
      criteria: [{
        criterionId: 'S009',
        status: EvaluationStatus.PASS,
        evidence: 'All 3 declared FOLIO library coordinates are mapped to families accepted for S009.'
      }]
    });

    expect(reportData(html).items[0]).toMatchObject({
      id: 'S009',
      title: 'FOLIO library dependencies',
      evidence: 'All 3 declared FOLIO library coordinates are mapped to families accepted for S009.'
    });
  });

  it.each(['S004', 'S007', 'S010'])('shows short %s agent prose in full without expanding unrelated or long text', criterionId => {
    const short = Array(100).fill('evidence').join(' ');
    const long = `${short} extra`;
    const html = new EvaluationReportRenderer().renderHtml({
      ...result,
      criteria: [{ criterionId, status: EvaluationStatus.MANUAL, evidence: 'Review needed.', details: [
        'Other findings:', `  - Summary: ${short}`,
        criterionId === 'S004' ? 'Agent review:' : 'Agent review (advisory):',
        `  - Summary: ${short}`, `  - Rationale: ${long}`, `  - Finding: ${short}`
      ].join('\n'), agentReview: {
        available: true, criterionId, recommendation: 'needs_reviewer_judgment', confidence: 'medium',
        summary: short, rationale: long, evidenceReferences: [], warnings: [], errors: []
      } }]
    });
    const tree = preparedItems(html)[0].tree;
    const agent = tree.find((node: any) => node.text.startsWith('Agent review'));
    expect(agent.children.find((node: any) => node.text.startsWith('Summary:')).showFullText).toBe(true);
    expect(agent.children.find((node: any) => node.text.startsWith('Rationale:')).showFullText).toBe(false);
    expect(tree.find((node: any) => node.text === 'Other findings:').children[0].showFullText).toBeUndefined();
  });

  it('prepares S009 detail hierarchy without nested field counts or inferred agent recommendations', () => {
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml({
      ...result,
      criteria: [{
        criterionId: 'S009',
        status: EvaluationStatus.FAIL,
        evidence: 'One FOLIO library coordinate is not accepted.',
        details: [
          'Assessment basis:',
          '  - Policy availability: Available',
          'Library findings:',
          '  - @folio/not-accepted:',
          '    - Classification: Not accepted for S009',
          '    - Evidence:',
          '      - Declared version: 1.0.0 Advisory recommendation: pass',
          '      - Source file: package.json'
        ].join('\n')
      }]
    });

    const prepared = preparedItems(html)[0];
    const findings = prepared.tree.find((node: any) => node.text === 'Library findings:');
    expect(prepared.recommendation).toBeUndefined();
    expect(findings.children[0]).toMatchObject({ text: '@folio/not-accepted:', hideCount: true });
    expect(findings.children[0].children.find((node: any) => node.text === 'Evidence:')).toMatchObject({ hideCount: true });
  });

  it('turns "... N more" overflow markers into hidden counts instead of list entries', () => {
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml({
      ...result,
      criteria: [{
        criterionId: 'S005',
        status: EvaluationStatus.MANUAL,
        evidence: 'S005 manual',
        details: [
          'Warnings:',
          '  - first warning',
          '  - second warning',
          '  - ... 14 more',
          'Possible mismatches:',
          '  - Mismatch signals:',
          '    - likely_omission/name: Disclosure does not check name. (evidence: a.json:1 [direct_contract/strong/name], b.json:2 [direct_contract/strong/name], ... 8 more)'
        ].join('\n')
      }]
    });

    const tree = preparedItems(html)[0].tree;
    const warnings = tree.find((node: any) => node.text === 'Warnings:');
    const mismatch = tree.find((node: any) => node.text === 'Possible mismatches:').children[0].children[0];

    expect(warnings.children.map((node: any) => node.text)).toEqual(['first warning', 'second warning']);
    expect(warnings.hidden).toBe(14);
    expect(mismatch.children.map((node: any) => node.text)).toEqual([
      'a.json:1 [direct_contract/strong/name]',
      'b.json:2 [direct_contract/strong/name]'
    ]);
    expect(mismatch.hidden).toBe(8);
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

  it('escapes untrusted criterion and advisory fields', () => {
    const renderer = new EvaluationReportRenderer();
    const json = renderer.renderJson(result);
    const html = renderer.renderHtml(result);
    const data = reportData(html);
    const embedded = JSON.stringify(data);

    expect(json).toContain('"criterionDetails"');
    expect(embedded).toContain('<script>alert(\\"x\\")</script>');
    expect(embedded).toContain('**email** <script>bad()</script>');
    expect(embedded).toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('</script> password=');
    expect(html).not.toContain('<script>bad()</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('should expose escaping helpers for focused renderer tests', () => {
    const renderer = new EvaluationReportRenderer();

    expect(renderer.escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
    expect(renderer.textToHtml('one\ntwo')).toBe('one<br>two');
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
    const data = reportData(html);

    expect(json.criteria[0].criterionDetails.findings.map((finding: any) => finding.contribution)).toEqual(['fail', 'manual']);
    expect(json.criteria[0].criterionDetails.findings[0].matchedPolicy.entryId).toBe('react');
    expect(json.criteria[0].criterionDetails.findings[0].evidence[0].versionSourcePath).toBe('yarn.lock');
    expect(data.items[0].title).toBe('Officially supported technologies');
    expect(data.items[0].details).toEqual(expect.arrayContaining([
      expect.stringContaining('React <script>alert("x")</script> (react): Violates a mandatory rule.'),
      '    - Policy entry: frontend-third-party-frameworks/react',
      '    - Rule strength: normative',
      '        - Declared version: 17.0.2',
      '        - Resolved version: 17.0.2',
      '        - Version source: yarn.lock'
    ]));
    expect(html).toContain('frontend-third-party-frameworks/react');
    expect(html).toContain('Result contribution: fail');
    expect(html).toContain('Result contribution: manual');
    expect(html).toContain('Declared version: 17.0.2');
    expect(html).toContain('Resolved version: 17.0.2');
    expect(html).toContain('Version source: yarn.lock');
    expect(html).toContain('package\\u003cscript\\u003e.json');
    expect(reportData(html).items[0].details.join('\n')).toContain('package<script>.json');
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(reportData(html).items[0].details.join('\n')).toContain('package<script>.json');
  });
});
