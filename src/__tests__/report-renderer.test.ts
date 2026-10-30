import { EvaluationReportRenderer } from '../utils/report-renderer';
import { CriterionAgentReviewResult, Dependency, EvaluationResult, EvaluationStatus, S007AnalysisResult, S010Analysis } from '../types';
import { renderS007HumanDetails } from '../utils/s007-report-details';
import { agentReviewReport } from './helpers/agent-review-report';
import { runInNewContext } from 'vm';
import { ThirdPartyLicenseEvaluator, buildEvidenceSummary } from '../utils/license-compliance-evaluator';
import { checkLicenseCompliance } from '../utils/license-compliance';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeS004Documentation, formatS004Evidence } from '../utils/s004-installation-documentation';
import { analyzeS005PersonalDataDisclosure, buildS005CriterionDetails, formatS005Evidence } from '../utils/s005-personal-data-disclosure';
import { s002ArtifactFailureResult } from '../utils/s002-module-descriptor-report';
import { evaluateS009, renderS009HumanDetails } from '../utils/s009-evaluator';
import { citedTrackedFiles } from '../module-evaluator';
import { analyzeS006SensitiveInformation, buildS006CriterionDetails, formatS006Evidence } from '../utils/s006-sensitive-information';
import { FakeS006GitleaksRunner } from './helpers/fake-s006-gitleaks-runner';
import { renderFrontendChecklistLines } from '../utils/frontend-checklist';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { evaluateB001, renderB001HumanDetails } from '../utils/b001-descriptor-template';
import { FrontendChecklist } from '../types';
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

  function preparedItems(html: string): any[] {
    const data = reportData(html);
    const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)![1];
    const setup = script.slice(0, script.indexOf('var items = data.items.map(prepare);'));
    return runInNewContext(setup + 'return data.items.map(prepare); }());', {
      document: { getElementById: () => ({ textContent: JSON.stringify(data) }) }
    });
  }

  // The browser's row parsing (lead, tag and source link) for a rendered report, run outside a DOM.
  function rowLinks(html: string, criterionId: string): (text: string) => { lead: string; tag: string; href: string | null } {
    const data = reportData(html);
    const cited = data.items.find((item: any) => item.id === criterionId).citedSourcePaths;
    const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)![1];
    const setup = script.slice(0, script.indexOf('var items = data.items.map(prepare);'));
    const helpers = script.slice(script.indexOf('    function segments('), script.indexOf('    function clampedText('));
    return runInNewContext(`${setup}${helpers}return function (text) { `
      + `var cited = ${JSON.stringify(cited)}; var parts = rowParts(text, cited); `
      + 'return {lead: parts.lead, tag: parts.tag, href: parts.lead ? rowHref(parts, cited) : null}; }; }());', {
      document: { getElementById: () => ({ textContent: JSON.stringify(data) }) }
    });
  }

  function walk(nodes: any[]): any[] {
    return nodes.flatMap(node => [node, ...walk(node.children)]);
  }

  // Runs the report script against a minimal DOM and returns the page's visible text, in document order.
  function renderedText(html: string): string {
    const scripts: Record<string, string> = {
      'report-data': html.match(/<script id="report-data" type="application\/json">([\s\S]+?)<\/script>/)![1],
      'download-data': '{}'
    };
    const element = (): any => {
      const node: any = { children: [], textContent: '', dataset: {}, style: { setProperty() {} },
        setAttribute() {}, addEventListener() {}, appendChild: (child: any) => { node.children.push(child); return child; },
        append: (...children: any[]) => { node.children.push(...children); },
        replaceChildren: (...children: any[]) => { node.children = children; } };
      return node;
    };
    const root = element();
    runInNewContext(html.match(/<script>\s*([\s\S]*?)<\/script>/)![1], {
      window: { addEventListener() {} },
      document: { activeElement: null, createElement: element, createElementNS: element,
        createTextNode: (text: string) => ({ ...element(), textContent: text }),
        getElementById: (id: string) => id === 'report' ? root : { textContent: scripts[id] } }
    });
    const text = (node: any): string => [node.textContent, ...node.children.map(text)].filter(Boolean).join(' ');
    return text(root).replace(/\s+/g, ' ');
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
      expect(item.tree[0].children.find((node: any) => node.text === 'Sources:')).toMatchObject({ unit: 'source', children: [{ text: 'pom.xml', children: [] }] });
      expect(item.tree.map((node: any) => node.text)).toEqual(['Agent review (advisory):', 'Evidence:', 'Diagnostics:']);
    }
    expect(JSON.stringify(report)).toBe(original);
  });

  // Each finding the agent assessed, with the label renderAgentReviewLines gives it.
  const assessedSubjects = (item: any) => item.tree[0].children.find((node: any) => node.text === 'Findings:')
    .children.map((node: any) => node.text.replace(/ — .*$/, ''));
  const assessment = (technologyId: string) => ({ technologyId, type: 'evidence_gap' as const,
    summary: 'Check it.', evidenceReferences: ['pom.xml'] });

  it('names S006 agent-review findings by the file and line they flag', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-s006-'));
    try {
      fs.mkdirSync(path.join(repo, 'docs'));
      fs.writeFileSync(path.join(repo, 'README.md'), '# Module\n');
      // More findings than criterionDetails keeps (16), so a name cannot come from the projected findings.
      fs.writeFileSync(path.join(repo, 'docs/setup notes.md'), Array.from({ length: 17 }, (_, index) =>
        `Example: Bearer abcdefghijklmnopqrstuvwxyz${String(index).padStart(6, '0')}`).join('\n') + '\n');
      fs.writeFileSync(path.join(repo, 'application.yml'), 'server:\n  password: Sup3rS3cretValue9\n');
      const analysis = await analyzeS006SensitiveInformation(repo, { commandRunner: new FakeS006GitleaksRunner() });
      const lastDocs = analysis.findings.findIndex(finding => finding.path === 'docs/setup notes.md' && finding.line === 17);
      const config = analysis.findings.findIndex(finding => finding.path === 'application.yml');
      expect(analysis.findings).toHaveLength(18);
      const review: CriterionAgentReviewResult = { available: true, criterionId: 'S006', recommendation: 'needs_reviewer_judgment',
        confidence: 'medium', summary: 'Check both.', rationale: 'Many findings.', evidenceReferences: ['README.md'],
        assessments: ['scope', `finding:${lastDocs}`, `finding:${config}`, 'finding:99'].map(assessment),
        warnings: [], errors: [] };
      const rendered = formatS006Evidence(analysis, review);
      const criterionDetails = buildS006CriterionDetails(analysis, review);
      expect(criterionDetails.findings.some(finding => finding.path === 'docs/setup notes.md' && finding.line === 17)).toBe(false);
      expect(criterionDetails.findings.findIndex(finding => finding.path === 'application.yml')).not.toBe(config);
      const html = new EvaluationReportRenderer().renderHtml({ ...result, criteria: [{ criterionId: 'S006',
        status: analysis.classification.status, evidence: rendered.evidence, details: rendered.details,
        criterionDetails, agentReview: review }] });

      // The path is percent-encoded like the rows above, so its space cannot split "path:line" from the label.
      expect(assessedSubjects(preparedItems(html)[0]))
        .toEqual(['Review scope', 'docs/setup%20notes.md:17', 'application.yml:2', 'Scanner finding 100']);
      for (const details of [rendered.details, downloadData(html).criteria[0].details]) {
        expect(details).toContain('    - docs/setup%20notes.md:17 — Needs verification:');
        expect(details).toContain('    - application.yml:2 — Needs verification:');
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('names S010 agent-review dependencies as the S010 report rows do', () => {
    const scenario = (id: string) => ({ id, dependencyId: id.slice(0, id.indexOf(':')), scenario: id.slice(id.lastIndexOf('/') + 1) });
    const analysis = { evidence: { scenarios: [
      scenario('search:ELASTICSEARCH_URL/configuration-absent'),
      // A client class named after a known service keeps the service name.
      scenario('search:src/main/java/org/folio/SearchClient.java/runtime-unavailable'),
      scenario('set-service-impl:src/main/java/org/folio/SetServiceImpl.java/runtime-unavailable'),
      scenario('users:src/main/java/org/folio/a/UsersClient.java/runtime-unavailable'),
      scenario('users:src/main/java/org/folio/b/Users.java/runtime-unavailable'),
      // Ids made from repository names are never Object.prototype members.
      scenario('__proto__:src/main/java/org/folio/__proto__.java/runtime-unavailable'),
      // An id that also names a setting keeps its plain name.
      scenario('constructor:src/main/java/org/folio/Constructor.java/runtime-unavailable'),
      scenario('constructor:CONSTRUCTOR_URL/configuration-absent')
    ] } };
    const review: CriterionAgentReviewResult = { available: true, criterionId: 'S010', recommendation: 'needs_reviewer_judgment',
      confidence: 'medium', summary: 'Check services.', rationale: 'Clients.', evidenceReferences: ['pom.xml'],
      assessments: ['search', 'set-service-impl', 'users', '__proto__', 'constructor', 'folio-interfaces', 'discovered:object-storage', 'discovered:mod-x']
        .map(assessment), warnings: [], errors: [] };
    const html = new EvaluationReportRenderer().renderHtml({ ...result, criteria: [{ criterionId: 'S010',
      status: EvaluationStatus.MANUAL, evidence: 'Manual', details: 'Needs review (not confirmed problems):\n  - x',
      criterionDetails: analysis as unknown as S010Analysis, agentReview: review }] });

    expect(assessedSubjects(preparedItems(html)[0])).toEqual([
      'OpenSearch or Elasticsearch',
      'Service called from SetServiceImpl.java',
      'Services called from UsersClient.java, Users.java',
      'Service called from __proto__.java',
      'constructor',
      'FOLIO interfaces',
      'Object storage',
      'mod x'
    ]);
  });

  it('uses the singular for a count of one in agent-review and summary labels', () => {
    const review = (actions: number): CriterionAgentReviewResult => ({ available: true, criterionId: 'S010',
      recommendation: 'needs_reviewer_judgment', confidence: 'medium', summary: 'Check.', rationale: 'Because.',
      evidenceReferences: ['pom.xml', 'README.md'].slice(0, actions),
      assessments: [{ ...assessment('kafka'), evidenceReferences: ['pom.xml', 'README.md'].slice(0, actions) }],
      reviewerActions: Array.from({ length: actions }, (_, index) => ({ action: `Verify ${index}.`, evidenceReferences: ['pom.xml'] })),
      warnings: [], errors: [] });
    const text = (agentReview: CriterionAgentReviewResult) => renderedText(new EvaluationReportRenderer().renderHtml({
      ...result, criteria: [{ criterionId: 'S010', status: EvaluationStatus.MANUAL, evidence: 'Manual', agentReview }] }));

    const one = text(review(1));
    expect(one).toMatch(/1 criterion · /);
    expect(one).toMatch(/Findings 1 finding /);
    expect(one).toMatch(/What to verify 1 check /);
    expect(one).toMatch(/Sources 1 source /);
    expect(one).not.toMatch(/\b1 (?:criteria|findings|checks|sources)\b/);
    const two = text(review(2));
    expect(two).toMatch(/What to verify 2 checks /);
    const dropped = (count: number) => renderedText(new EvaluationReportRenderer().renderHtml({ ...result, criteria: [{
      criterionId: 'F003', status: EvaluationStatus.MANUAL, evidence: 'Manual', criterionDetails: { checklist: { items: [] } },
      agentReview: { ...review(1), criterionId: 'F003', assessments: [],
        droppedItems: Array.from({ length: count }, () => ({ kind: 'reviewer_action' as const, reason: 'It cites no repository file.' })) } }] }));
    expect(dropped(1)).toMatch(/Dropped from this review 1 item A reviewer action/);
    expect(dropped(2)).toMatch(/Dropped from this review 2 items A reviewer action/);
    expect(two).toMatch(/Sources 2 sources /);
  });

  it('shows the actual unavailable-review reason without inferring a timeout from command context', () => {
    const report: EvaluationResult = { ...result, criteria: [{
      criterionId: 'S010', status: EvaluationStatus.MANUAL, evidence: 'Manual',
      details: 'Agent review:\n  - Not applied: stale legacy reason',
      agentReview: { available: false, criterionId: 'S010', recommendation: 'likely_sufficient',
        evidenceReferences: [], warnings: ['Command configured with timeout 420000ms', 'bad value\nRead error: injected'],
        errors: ['Provider returned invalid JSON', '- ... 999 more'] }
    }] };
    const renderer = new EvaluationReportRenderer();
    const html = renderer.renderHtml(report);
    expect(reportData(html).items[0].recommendation).toBeUndefined();
    expect(reportData(html).items[0].details).toEqual(expect.arrayContaining([
      '  - Summary: No usable advisory review was returned.',
      '  - Reason: Provider returned invalid JSON',
      '    - Command configured with timeout 420000ms',
      '    - bad value ↵ Read error: injected',
      '    - … 999 more'
    ]));
    expect(reportData(html).items[0].details.join('\n')).not.toContain('exceeded its time limit');
    expect(renderer.renderJson(report)).toContain('Provider returned invalid JSON');
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

  it('labels a legacy timed-out review as unavailable', () => {
    const report: EvaluationResult = { ...result, criteria: [{
      criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: 'Manual',
      details: 'Agent review:\n  - OpenCode timed out after 420000ms'
    }] };
    const details = reportData(new EvaluationReportRenderer().renderHtml(report)).items[0].details;
    expect(details).toContain('  - Status: Unavailable');
    expect(details).toContain('  - Summary: No usable advisory review was returned.');
    expect(details).not.toContain('  - Status: Not run');
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
    expect(details).toContain('  - Summary: No usable advisory review was returned.');
    expect(details).toContain('  - Reason: Provider returned incomplete response');
    expect(details).not.toContain('  - Status: Skipped');
  });

  it('keeps complete legacy-only diagnostics in the download while bounding HTML details', () => {
    const longDiagnostic = `seventh ${'x'.repeat(600)} token=legacy-secret`;
    const diagnostics = [
      'first failure', 'second detail', 'third detail', 'fourth detail',
      'fifth detail', 'sixth detail', longDiagnostic
    ];
    const report: EvaluationResult = { ...result, criteria: [{
      criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: 'Manual',
      details: ['Agent review:', ...diagnostics.map(value => `  - ${value}`)].join('\n')
    }] };
    const html = new EvaluationReportRenderer().renderHtml(report);
    const displayed = reportData(html).items[0].details.join('\n');
    const downloaded = downloadData(html).criteria[0].details;

    expect(displayed).toContain('... 1 more in the downloaded JSON report');
    expect(displayed).not.toContain('seventh');
    expect(downloaded).toContain(longDiagnostic);
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
      evidence: 'Apache <2.0> & compatible',
      details: ['Line one', 'Line two']
    });
  });

  it('renders compatible provenance, a downloadable report, and only commit-pinned tracked source links', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const html = new EvaluationReportRenderer().renderHtml({
      ...result,
      provenance: {
        repositoryCommit: commit,
        evaluator: { name: 'folio-module-evaluator', version: '1.2.3' },
        agentReviewModel: 'openrouter/deepseek/deepseek-v4-flash',
        citedSourcePaths: ['README.md']
      },
      criteria: [{
        criterionId: 'S004',
        status: EvaluationStatus.MANUAL,
        evidence: 'Review needed.',
        details: 'Sources:\n  - README.md:12 documented setup\n  - /tmp/generated.json:1 generated output',
        criterionDetails: { sources: [{ path: 'README.md' }, { path: '/tmp/generated.json' }] }
      }]
    });
    const data = reportData(html);
    const links = rowLinks(html, 'S004');
    const downloaded = downloadData(html);

    expect(data.meta).toMatchObject({
      commit,
      evaluator: { name: 'folio-module-evaluator', version: '1.2.3' },
      agentReviewModel: 'openrouter/deepseek/deepseek-v4-flash',
      sourceBase: `https://github.com/folio-org/test-module/blob/${commit}/`,
      citedSourcePaths: ['README.md']
    });
    expect(downloaded.provenance.repositoryCommit).toBe(commit);
    expect(downloaded.criteria[0]).toMatchObject({ criterionId: 'S004', status: 'manual' });
    expect(links('README.md:12 documented setup').href).toBe(`https://github.com/folio-org/test-module/blob/${commit}/README.md#L12`);
    expect(links('/tmp/generated.json:1 generated output').href).toBeNull();
  });

  it('removes repository URL credentials before preserving report links', () => {
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
    expect(data.meta.sourceBase).toBe(`${cleanRepositoryUrl}/blob/${commit}/`);
    expect(downloaded.repositoryUrl).toBe(cleanRepositoryUrl);
    expect(html).not.toContain(credentials);
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

  // Runs the real S003 evaluator on the given dependencies and prepares its report card.
  async function preparedS003(dependencies: Dependency[]): Promise<any> {
    const criterion = await new ThirdPartyLicenseEvaluator({
      extractDependencies: async () => ({ dependencies, errors: [], warnings: [] }),
      readReadmeContent: () => '',
      checkCompliance: checkLicenseCompliance
    }).evaluate('/unused');
    return preparedItems(new EvaluationReportRenderer().renderHtml({ ...result, criteria: [criterion] }))[0];
  }
  const licenseGroups = (item: any) => item.tree.find((node: any) => node.text === 'Dependency licenses');

  it('groups S003 dependency licenses so every counted dependency is listed, with singular units', async () => {
    const single = await preparedS003([{ name: 'org.example:only', version: '1.0', licenses: ['MIT'] }]);
    expect(single.summary).toBe('Found 1 dependency. License groups are listed below the flagged items.');
    expect(licenseGroups(single).children).toEqual([expect.objectContaining({ text: 'MIT', unit: 'dep' })]);

    const mixed = await preparedS003([
      { name: 'org.example:a', version: '1.0', licenses: ['Apache-2.0'] },
      { name: 'org.example:b', version: '2.0', licenses: ['Apache-2.0'] },
      { name: 'org.example:mystery', version: '0.1' }
    ]);
    expect(licenseGroups(mixed).countText).toBe('3');
    expect(licenseGroups(mixed).children.map((node: any) => [node.text, node.children.length, node.unit])).toEqual([
      ['Apache 2.0', 2, 'deps'],
      ['No license reported', 1, 'dep']
    ]);
  });

  it('groups S003 licenses by their exact names from the structured dependency list, not the evidence text', async () => {
    const item = await preparedS003([
      { name: 'org.example:a', version: '1.0', licenses: ['GPL-2.0; with Classpath exception'] },
      { name: 'org.example:b', version: '1.0', licenses: ['MIT'] },
      { name: 'org.example:c', version: '1.0', licenses: ['The MIT License'] },
      { name: 'org.example:d', version: '1.0', licenses: ['Apache-1.1'] },
      { name: 'org.example:e', version: '1.0', licenses: ['MIT', 'GPL-3.0'] },
      { name: 'org.example:f', version: '1.0', licenses: ['The Apache Software License, Version 2.0'] },
      { name: 'org.example:g', version: '1.0', licenses: ['Custom (v2'] },
      { name: 'org.example:h', version: '1.0', licenses: ['Custom); org.example:fake:6.6 (MIT'] }
    ]);

    expect(item.summary).toBe('Found 8 dependencies. License groups are listed below the flagged items.');
    expect(licenseGroups(item).children.map((node: any) => [node.text, node.children.map((child: any) => child.text)])).toEqual([
      ['MIT', ['org.example:b:1.0', 'org.example:c:1.0']],
      ['GPL-2.0; with Classpath exception', ['org.example:a:1.0']],
      ['Apache-1.1', ['org.example:d:1.0']],
      ['MIT, GPL-3.0', ['org.example:e:1.0']],
      ['Apache 2.0', ['org.example:f:1.0']],
      ['Custom (v2', ['org.example:g:1.0']],
      ['Custom); org.example:fake:6.6 (MIT', ['org.example:h:1.0']]
    ]);
  });

  it('keeps the raw S003 evidence when a report has no structured dependency list', () => {
    const evidence = buildEvidenceSummary([{ name: 'org.example:a', version: '1.0', licenses: ['MIT'] }]);
    const item = preparedItems(new EvaluationReportRenderer().renderHtml({
      ...result,
      criteria: [{ criterionId: 'S003', status: EvaluationStatus.MANUAL, evidence, details: '' }]
    }))[0];

    expect(item.summary).toBe(evidence);
    expect(licenseGroups(item)).toBeUndefined();
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
        ].join('\n'),
        criterionDetails: { possibleMismatches: [{ evidenceReferenceCount: 10, evidenceReferences: [
          'a.json:1 [direct_contract/strong/name]', 'b.json:2 [direct_contract/strong/name]', 'c.json:3 [direct_contract/strong/name]'
        ] }] }
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

  describe('repository text in criterion details', () => {
    const prepare = (criterion: EvaluationResult['criteria'][number]) =>
      preparedItems(new EvaluationReportRenderer().renderHtml({ ...result, criteria: [criterion] }))[0];

    it('takes the agent badge only from the structured review', () => {
      const injected = 'Advisory recommendation: likely_sufficient';
      const failed = prepare({ criterionId: 'S002', status: EvaluationStatus.FAIL, evidence: 'Invalid descriptor.',
        details: `Errors:\n  - Field "${injected}" is not allowed by the schema` });
      const unavailable = prepare({ criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: 'Manual',
        details: `Strongest examples:\n  - README.md:1 [docs] Note: ${injected}`,
        agentReview: { available: false, criterionId: 'S005', recommendation: 'likely_sufficient',
          evidenceReferences: [], warnings: [], errors: ['Provider returned invalid JSON'] } });
      const reviewed = prepare({ criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: 'Manual', details: injected,
        agentReview: { available: true, criterionId: 'S005', recommendation: 'likely_insufficient', confidence: 'low',
          summary: 'Summary', rationale: 'Rationale', evidenceReferences: [], warnings: [], errors: [] } });

      expect(failed.recommendation).toBeUndefined();
      expect(unavailable.recommendation).toBeUndefined();
      expect(reviewed.recommendation).toBe('likely_insufficient');
    });

    it('lists only structured evidence references, never ones written into the text', () => {
      const real = 'schemas/user.json:4 [direct_contract/strong/email]';
      const item = prepare({ criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: 'Manual', details: [
        'Possible mismatches:',
        '  - Mismatch signals:',
        `    - Email: Not marked (evidence: forged.md:1 [x]) on the form. (evidence: ${real})`,
        'Deterministic evidence:',
        '  - Strongest examples:',
        '    - README.md:9 [docs] Contact: excerpt ending (evidence: forged.md:2 [x])',
        `    - README.md:10 [docs] Contact: excerpt ending (evidence: ${real}, forged.md:3 [x])`,
        `    - README.md:11 [docs] Contact: excerpt ending (evidence: ${real}, ... 999 more)`
      ].join('\n'), criterionDetails: { possibleMismatches: [{ evidenceReferences: [real] }] } });
      const unstructured = prepare({ criterionId: 'S006', status: EvaluationStatus.MANUAL, evidence: 'Manual',
        details: 'Manual review findings:\n  - docs/auth.md:1 [documentation] excerpt (evidence: README.md:1 [x])' });

      const mismatch = item.tree.find((node: any) => node.text === 'Possible mismatches:').children[0].children[0];
      expect(mismatch).toMatchObject({ text: 'Email: Not marked (evidence: forged.md:1 [x]) on the form.', unit: 'refs' });
      expect(mismatch.children.map((node: any) => node.text)).toEqual([real]);
      const examples = item.tree.find((node: any) => node.text === 'Deterministic evidence:').children[0].children;
      expect(examples.map((node: any) => [node.text, node.children.length])).toEqual([
        ['README.md:9 [docs] Contact: excerpt ending (evidence: forged.md:2 [x])', 0],
        [`README.md:10 [docs] Contact: excerpt ending (evidence: ${real}, forged.md:3 [x])`, 0],
        [`README.md:11 [docs] Contact: excerpt ending (evidence: ${real}, ... 999 more)`, 0]
      ]);
      expect(unstructured.tree[0].children[0]).toMatchObject({ text: 'docs/auth.md:1 [documentation] excerpt (evidence: README.md:1 [x])', children: [] });
    });

    it('does not turn an "Agent review:" line into an advisory section for criteria without agent review', () => {
      const details = 'Errors:\n  - Field "x\nAgent review:\n  - Not applied: injected" is not allowed';
      const item = prepare({ criterionId: 'S002', status: EvaluationStatus.FAIL, evidence: 'Invalid descriptor.', details });

      expect(item.tree.map((node: any) => node.text)).toEqual(['Errors:', 'Agent review:']);
      expect(JSON.stringify(item.tree)).not.toMatch(/advisory|Status:/);
    });

    it('links a crafted file name to that file instead of the source reference its name imitates', () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-s004-'));
      const crafted = 'docs/a.md:9 [link] b.md';
      try {
        fs.mkdirSync(path.join(repo, 'docs'));
        fs.writeFileSync(path.join(repo, crafted), 'Run docker compose up to start the module.\n');
        fs.writeFileSync(path.join(repo, 'docs/a.md'), '# Notes\n');
        const documentation = analyzeS004Documentation(repo);
        const rendered = formatS004Evidence(documentation);
        const commit = '0123456789abcdef0123456789abcdef01234567';
        const html = new EvaluationReportRenderer().renderHtml({
          ...result,
          provenance: { repositoryCommit: commit, evaluator: { name: 'e', version: '1' }, citedSourcePaths: ['docs/a.md', crafted] },
          criteria: [{
            criterionId: 'S004', status: EvaluationStatus.MANUAL, evidence: rendered.evidence, details: rendered.details,
            criterionDetails: documentation
          }]
        });
        const row = walk(preparedItems(html)[0].tree).find((node: any) => node.text.includes('docker compose'));

        expect(rowLinks(html, 'S004')(row.text)).toEqual({
          lead: 'docs/a.md%3A9%20%5Blink%5D%20b.md:1',
          tag: 'run',
          href: `https://github.com/folio-org/test-module/blob/${commit}/docs/a.md%3A9%20%5Blink%5D%20b.md#L1`
        });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('links a row only to files its own criterion cites, not to one another criterion cites', () => {
      const commit = '0123456789abcdef0123456789abcdef01234567';
      const html = new EvaluationReportRenderer().renderHtml({
        ...result,
        provenance: { repositoryCommit: commit, evaluator: { name: 'e', version: '1' }, citedSourcePaths: ['README.md'] },
        criteria: [
          { criterionId: 'S002', status: EvaluationStatus.FAIL, evidence: 'Build failed.', details: 'Build output:\n  - README.md:9 [approved] crafted line' },
          {
            criterionId: 'S004', status: EvaluationStatus.MANUAL, evidence: 'Review needed.', details: 'Sources:\n  - README.md:12 setup',
            criterionDetails: { sources: [{ path: 'README.md' }] }
          }
        ]
      });

      expect(rowLinks(html, 'S002')('README.md:9 [approved] crafted line').href).toBeNull();
      expect(rowLinks(html, 'S004')('README.md:12 setup').href).toBe(`https://github.com/folio-org/test-module/blob/${commit}/README.md#L12`);
    });

    it('links S009 project files and source hashes it cites only in its dependency evidence', () => {
      const commit = '0123456789abcdef0123456789abcdef01234567';
      const evaluation = evaluateS009({ ok: false, sourcePath: 'ledger.json', diagnostics: [{ code: 'ledger_not_authoritative', message: 'Not reviewed' }] }, {
        observations: [], diagnostics: [], projectFiles: ['pom.xml'], fileHashes: { 'pom.xml': `sha256:${'a'.repeat(64)}` },
        hasDependencyProject: true, complete: true
      });
      const report: EvaluationResult = {
        ...result,
        criteria: [
          { criterionId: 'S007', status: EvaluationStatus.MANUAL, evidence: 'x', details: 'Notes:\n  - y', criterionDetails: { findings: [{ sourcePath: 'pom.xml' }] } },
          { criterionId: 'S009', status: EvaluationStatus.PASS, evidence: 'x', details: renderS009HumanDetails(evaluation), criterionDetails: evaluation }
        ]
      };
      const html = new EvaluationReportRenderer().renderHtml({
        ...report,
        provenance: { repositoryCommit: commit, evaluator: { name: 'e', version: '1' }, citedSourcePaths: citedTrackedFiles(report.criteria, ['pom.xml']) }
      });
      // S009 lists each project file once, with its hash: "pom.xml (sha256:...)".
      const rows = walk(preparedItems(html)[1].tree).filter((node: any) => /^pom\.xml \(sha256:[0-9a-f]{64}\)$/.test(node.text));

      expect(rows).toHaveLength(1);
      expect(rowLinks(html, 'S009')(rows[0].text)).toMatchObject({ lead: 'pom.xml', href: `https://github.com/folio-org/test-module/blob/${commit}/pom.xml` });
    });

    it('links an agent-review source that is a cited file name without an extension or directory', () => {
      const commit = '0123456789abcdef0123456789abcdef01234567';
      const html = new EvaluationReportRenderer().renderHtml({
        ...result,
        provenance: { repositoryCommit: commit, evaluator: { name: 'e', version: '1' }, citedSourcePaths: ['Dockerfile', 'pom.xml'] },
        criteria: [{
          criterionId: 'S010', status: EvaluationStatus.MANUAL, evidence: 'Manual', details: 'Dependency observations:\n  - none',
          agentReview: { available: true, criterionId: 'S010', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
            summary: 'Check runtime behavior.', evidenceReferences: ['Dockerfile'], warnings: [], errors: [] }
        }]
      });
      const sources = walk(preparedItems(html)[0].tree).find((node: any) => node.text === 'Sources:');
      const links = rowLinks(html, 'S010');

      expect(sources.children.map((node: any) => node.text)).toEqual(['Dockerfile']);
      expect(links('Dockerfile').href).toBe(`https://github.com/folio-org/test-module/blob/${commit}/Dockerfile`);
      expect(links('pom.xml').href).toBeNull();
    });

    it('does not link the cited prefix of a path shortened to the reference budget', () => {
      const commit = '0123456789abcdef0123456789abcdef01234567';
      const prefix = 'docs/a.md';
      const html = new EvaluationReportRenderer().renderHtml({
        ...result,
        provenance: { repositoryCommit: commit, evaluator: { name: 'e', version: '1' }, citedSourcePaths: [prefix] },
        criteria: [{
          criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: 'Review needed.',
          details: `Deterministic evidence:\n  - ${prefix} [truncated to 300 bytes]\n  - ${prefix}:3 [docs] real`,
          criterionDetails: { signals: [{ path: prefix }] }
        }]
      });
      const links = rowLinks(html, 'S005');

      expect(links(`${prefix} [truncated to 300 bytes]`).href).toBeNull();
      expect(links(`${prefix}:3 [docs] real`).href).toBe(`https://github.com/folio-org/test-module/blob/${commit}/${prefix}#L3`);
    });

    it('shows a build output line reading "... N more" instead of turning it into an omitted count', () => {
      const criterion = s002ArtifactFailureResult({
        status: 'command-failed',
        strategy: 'maven-generation',
        command: {
          identity: 'mvn', command: 'mvn', args: ['process-resources'], cwd: '/repo', commandExecutionEnvironment: 'local',
          localCommandsAllowed: true, status: 'failed', exitCode: 1, durationMs: 0, sanitized: true, stderr: '',
          stdout: 'java.lang.IllegalStateException: boom\n\tat org.example.Foo.bar(Foo.java:1)\n\t... 12 more\n'
        },
        warnings: [],
        errors: ['Command exited with code 1']
      });
      const buildError = prepare(criterion).tree.find((node: any) => node.text.startsWith('Build error'));

      expect(buildError.hidden).toBeUndefined();
      expect(buildError.children.map((node: any) => node.text)).toEqual([
        'java.lang.IllegalStateException: boom', 'at org.example.Foo.bar(Foo.java:1)', '… 12 more'
      ]);
    });

    describe('S005 evidence lists', () => {
      let repo: string;
      beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-s005-'));
        fs.writeFileSync(path.join(repo, 'PERSONAL_DATA_DISCLOSURE.md'), '# Personal Data Disclosure\n- [x] This module does not store or process personal data.\n');
      });
      afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

      function preparedS005(reference: string | string[], excerpt: string, oversized: boolean): any {
        const analysis = analyzeS005PersonalDataDisclosure(repo);
        analysis.possibleMismatches = [{ kind: 'likely_omission', category: 'email', message: 'Not marked on the form.',
          evidenceReferences: Array.isArray(reference) ? reference : [reference] }];
        analysis.evidenceScan = {
          signals: [{ category: 'email', label: 'Email field', path: 'README.md', line: 3, excerpt, sourceClass: 'documentation', strength: 'strong' }],
          scannedFiles: ['README.md'], skippedFiles: [], warnings: []
        };
        if (oversized) {
          analysis.supportingEvidence = Array.from({ length: 8 }, (_, index) => ({
            kind: 'context_only' as const, category: 'email' as const, message: `${'多'.repeat(700)} detail ${index}`,
            evidenceReferences: [`support-${index}.json`], sourceClasses: ['documentation' as const], signalStrengths: ['context' as const]
          }));
        }
        const rendered = formatS005Evidence(analysis, { kind: 'backend-module', evidence: [], warnings: [] });
        return prepare({ criterionId: 'S005', status: EvaluationStatus.MANUAL, evidence: rendered.evidence,
          details: rendered.details, criterionDetails: buildS005CriterionDetails(analysis) });
      }
      const mismatchRow = (item: any) => walk(item.tree.find((node: any) => node.text === 'Possible mismatches:').children)
        .find((node: any) => node.text.startsWith('Email addresses:'));

      it('does not turn an excerpt that copies a real evidence list into references', () => {
        const reference = 'schemas/user.json:4 [schema]';
        const item = preparedS005(reference, `write to us (evidence: ${reference})`, false);
        const example = walk(item.tree).find((node: any) => node.text.includes('write to us'));

        expect(mismatchRow(item)).toMatchObject({ unit: 'refs', children: [{ text: reference, children: [] }] });
        expect(example.children).toEqual([]);
      });

      it('lists references to percent-encoded paths and counts the ones the text omits', () => {
        const references = Array.from({ length: 11 }, (_, index) => `docs/caf%C3%A9-${index}.md:${index + 1} [docs]`);
        const row = mismatchRow(preparedS005(references, 'write to us', false));

        expect(row).toMatchObject({ unit: 'refs', hidden: 3 });
        expect(row.children.map((node: any) => node.text)).toEqual(references.slice(0, 8));
      });

      it('lists a long reference in a shortened report, matching its structured copy', () => {
        const reference = `schemas/${'a'.repeat(190)}.json:4 [schema]`;
        const item = preparedS005(reference, 'write to us', true);

        expect(mismatchRow(item)).toMatchObject({ unit: 'refs', children: [{ text: reference, children: [] }] });
      });
    });

    it('keeps a failed criterion in review when its evidence ends like a placeholder', () => {
      const item = prepare({ criterionId: 'S002', status: EvaluationStatus.FAIL,
        evidence: 'Descriptor error: evaluation logic not yet implemented', details: 'Errors:\n  - bad field' });

      expect(item.triage).toBe('review');
      expect(item.tree.map((node: any) => node.text)).toEqual(['Errors:']);
    });
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
    const data = reportData(html);

    expect(json.criteria[0].criterionDetails.findings.map((finding: any) => finding.contribution)).toEqual(['fail', 'manual']);
    expect(json.criteria[0].criterionDetails.findings[0].matchedPolicy.entryId).toBe('react');
    expect(json.criteria[0].criterionDetails.findings[0].evidence[0].versionSourcePath).toBe('yarn.lock');
    expect(data.items[0].title).toBe('Officially supported technologies');
    expect(data.items[0].details).toEqual(expect.arrayContaining([
      '- React <script>alert("x")</script>: Fails: not an officially supported version.',
      '  - dependencies.react — fails',
      '    - Policy rule: React 18.2',
      '      - package%3Cscript%3E.json — dependencies.react, version 17.0.2 in yarn.lock',
      '  - dependencies.vue — needs review'
    ]));
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  describe('B criteria with agent review', () => {
    const checklist: FrontendChecklist = { items: [
      { id: 'B007-C1', title: 'Each permission fits what its endpoint does.', reviewerOnly: false,
        startingPoints: [{ path: 'descriptors/ModuleDescriptor-template.json', line: 12, note: 'interface users' }],
        obligations: [{ id: 'B007-C1#1', subject: 'interface users (#/provides/1)', path: 'descriptors/ModuleDescriptor-template.json', line: 12, flag: 'manual' }] }
    ] };
    const backendResult = (criterionId: string, reason: string, agentReview?: CriterionAgentReviewResult): EvaluationResult => ({ ...result, criteria: [{
      criterionId, status: EvaluationStatus.MANUAL, evidence: `${criterionId} manual: a reviewer must judge the permissions.`,
      details: ['Handlers: 1', ...renderFrontendChecklistLines(checklist), 'Agent review:', `  - Not applied: ${reason}`].join('\n'),
      criterionDetails: { checklist }, agentReview
    }] });

    it('attaches agent results to the checklist items, as for F criteria', () => {
      const review: CriterionAgentReviewResult = { available: true, criterionId: 'B007', recommendation: 'needs_reviewer_judgment',
        confidence: 'medium', summary: 'The permission fits.', rationale: 'Read the handler.', evidenceReferences: ['descriptors/ModuleDescriptor-template.json'],
        assessments: [{ technologyId: 'B007-C1#1', type: 'aligned_fact', summary: 'GET requires a read permission.',
          evidenceReferences: ['descriptors/ModuleDescriptor-template.json'], coverageDisposition: 'investigated' }],
        warnings: [], errors: [] };
      const details: string[] = reportData(new EvaluationReportRenderer().renderHtml(backendResult('B007', 'stale note', review))).items[0].details;

      expect(details.slice(0, details.indexOf('Agent review (advisory):'))).toEqual([
        'Handlers: 1',
        'Checklist for the reviewer:',
        '  - B007-C1 Each permission fits what its endpoint does.',
        '    - Start with:', '      - descriptors/ModuleDescriptor-template.json:12 — interface users',
        '    - Agent: Supported by evidence — interface users (#/provides/1): GET requires a read permission.',
        '      - Sources:', '        - descriptors/ModuleDescriptor-template.json', '      - Coverage judgment: Investigated directly'
      ]);
    });

    it.each([
      ['B007', 'agent review is not enabled for B007', ['  - Status: Skipped', '  - Summary: Skipped because agent review is not enabled for this criterion.']],
      ['B002', 'agent review for B002 runs only when listed in --criterion-agent-criteria',
        ['  - Status: Not run', '  - Summary: Agent review was not run.', '  - Reason: agent review for B002 runs only when listed in --criterion-agent-criteria']]
    ])('keeps the checklist and shows why %s did not review after it', (criterionId, reason, rows) => {
      const details: string[] = reportData(new EvaluationReportRenderer().renderHtml(backendResult(criterionId, reason))).items[0].details;

      expect(details.slice(details.indexOf('Agent review (advisory):'))).toEqual(['Agent review (advisory):', ...rows]);
      expect(details[1]).toBe('Checklist for the reviewer:');
    });
  });

  describe('F criteria', () => {
    // An F003-like result: what the tool found, then the checklist, then the agent review note.
    const checklist: FrontendChecklist = { items: [
      { id: 'F003-C1', title: 'Each listed id exists in en.json.', reviewerOnly: false,
        startingPoints: [{ path: 'src/Scan.js', line: 60, note: 'ui-checkin.statusModal.cancel' }],
        obligations: [
          { id: 'F003-C1#1', subject: 'ui-checkin.statusModal.cancel', path: 'src/Scan.js', line: 60 },
          { id: 'F003-C1#2', subject: 'ui-checkin.other', withheld: true },
          { id: 'F003-C1#3', subject: 'ui-checkin.third' }
        ] },
      { id: 'F003-C2', title: 'No user-visible text is hard-coded.', reviewerOnly: false, startingPoints: [], obligations: [{ id: 'F003-C2#1' }] },
      { id: 'F003-C3', title: 'Computed ids resolve to keys in en.json.', reviewerOnly: true, startingPoints: [], obligations: [{ id: 'F003-C3#1' }] }
    ] };
    const frontendResult = (reason: string, agentReview?: CriterionAgentReviewResult): EvaluationResult => ({ ...result, criteria: [{
      criterionId: 'F003', status: EvaluationStatus.MANUAL, evidence: 'F003 manual: 1 message id is missing from en.json.',
      details: ['What the tool found:', '  - react-intl ^7.1.5', ...renderFrontendChecklistLines(checklist),
        'Agent review:', `  - Not applied: ${reason}`].join('\n'),
      criterionDetails: { checklist }, agentReview
    }] });
    const sources = ['      - Sources:', '        - src/Scan.js'];
    const investigated = '      - Coverage judgment: Investigated directly';

    it('attaches agent results to checklist items and puts the review last', () => {
      const review: CriterionAgentReviewResult = { available: true, criterionId: 'F003', recommendation: 'needs_reviewer_judgment',
        confidence: 'medium', summary: 'One id lacks a fallback.', rationale: 'Checked the listed ids.', evidenceReferences: ['src/Scan.js'],
        assessments: [
          { technologyId: 'F003-C1#1', type: 'substantive_concern', summary: 'No defaultMessage.', evidenceReferences: ['src/Scan.js'], coverageDisposition: 'investigated' },
          { technologyId: 'F003-C2#1', type: 'aligned_fact', summary: 'All text comes from en.json.', evidenceReferences: ['src/Scan.js'], coverageDisposition: 'investigated' },
          { technologyId: 'discovered:text:1', type: 'evidence_gap', summary: 'Possible hard-coded label.', evidenceReferences: ['src/Other.js'], coverageDisposition: 'unresolved' },
          // A reviewer-only item is not reviewed, so an answer for it stays in the review's own findings.
          { technologyId: 'F003-C3#1', type: 'aligned_fact', summary: 'Ids resolve.', evidenceReferences: ['src/Scan.js'], coverageDisposition: 'investigated' }
        ],
        warnings: [], errors: [] };
      const html = new EvaluationReportRenderer().renderHtml(frontendResult('stale note', review));
      const details: string[] = reportData(html).items[0].details;
      const item = preparedItems(html)[0];

      expect(details.slice(0, details.indexOf('Agent review (advisory):'))).toEqual([
        'What the tool found:', '  - react-intl ^7.1.5',
        'Checklist for the reviewer:',
        '  - F003-C1 Each listed id exists in en.json.',
        '    - Start with:', '      - src/Scan.js:60 — ui-checkin.statusModal.cancel',
        '    - Agent: Potential problem — ui-checkin.statusModal.cancel: No defaultMessage.', ...sources, investigated,
        '    - Not given to the agent (limit of 25): ui-checkin.other',
        '    - No agent result: ui-checkin.third',
        '  - F003-C2 No user-visible text is hard-coded.',
        '    - Agent: Supported by evidence — All text comes from en.json.', ...sources, investigated,
        '  - F003-C3 Computed ids resolve to keys in en.json.',
        '    - Checked by the reviewer only'
      ]);
      expect(details).not.toContain('  - Not applied: stale note');
      expect(item.tree.map((node: any) => node.text)).toEqual(['What the tool found:', 'Checklist for the reviewer:', 'Agent review (advisory):']);
      const agent = item.tree[2];
      expect(agent.hideCount).toBe(true);
      // Only the assessment that answers no checklist obligation stays in the review's findings.
      expect(agent.children.find((node: any) => node.text === 'Findings:').children.map((node: any) => node.text))
        .toEqual(['Hard-coded text found by the agent (1) — Needs verification:', 'F003 C3#1 — Supported by evidence:']);
      expect(agent.children.map((node: any) => node.text)).toContain('Recommendation: Reviewer judgment needed');
      expect(downloadData(html).criteria[0].details).toBe(details.join('\n'));
    });

    it.each([
      ['agent review is not enabled for F003', 'Skipped', 'Skipped because agent review is not enabled for this criterion.'],
      ['OpenCode timed out after 420000ms', 'Unavailable', 'No usable advisory review was returned.']
    ])('keeps the checklist and shows "%s" after it', (reason, status, summary) => {
      const html = new EvaluationReportRenderer().renderHtml(frontendResult(reason));
      const details: string[] = reportData(html).items[0].details;

      expect(preparedItems(html)[0].tree.map((node: any) => node.text))
        .toEqual(['What the tool found:', 'Checklist for the reviewer:', 'Agent review (advisory):']);
      expect(details).toEqual(expect.arrayContaining(['  - F003-C1 Each listed id exists in en.json.', `  - Status: ${status}`, `  - Summary: ${summary}`]));
      expect(details).not.toContain('    - Checked by the reviewer only');
    });

    it('shows why F007, which has no agent review, did not review', () => {
      const report: EvaluationResult = { ...result, criteria: [{ criterionId: 'F007', status: EvaluationStatus.MANUAL, evidence: 'F007 manual: a reviewer must check.',
        details: 'Agent review:\n  - Not applied: F007 agent review needs runtime evidence', criterionDetails: { checklist: { items: [] } } }] };
      expect(reportData(new EvaluationReportRenderer().renderHtml(report)).items[0].details).toEqual(['Agent review (advisory):',
        '  - Status: Not run', '  - Summary: Agent review was not run.', '  - Reason: F007 agent review needs runtime evidence']);
    });

    it('renders F005 as a Frontend criterion whose checklist starting points link to the cited file', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-f005-'));
      try {
        fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@folio/checkin', stripes: { actsAs: ['app'] },
          devDependencies: { '@folio/stripes': '^10.0.0' } }));
        const f005 = await new FrontendEvaluator().evaluateCriterion('F005', repo);
        const commit = '0123456789abcdef0123456789abcdef01234567';
        const html = new EvaluationReportRenderer().renderHtml({ ...result, criteria: [f005], provenance: {
          repositoryCommit: commit, evaluator: { name: 'folio-module-evaluator', version: '1.0.0' },
          citedSourcePaths: citedTrackedFiles([f005], ['package.json', 'yarn.lock']) } });
        const item = preparedItems(html)[0];

        expect(item).toMatchObject({ id: 'F005', title: 'Stripes version', category: 'Frontend', triage: 'review' });
        expect(item.summary).toMatch(/^Stripes is declared as devDependencies\.@folio\/stripes \^10\.0\.0 in package\.json\./);
        const checklistNode = item.tree.find((node: any) => node.text === 'Checklist for the reviewer:');
        // The checklist item and where to start on it are open, so the reviewer sees them without clicking.
        expect(checklistNode.children[0]).toMatchObject({ openByDefault: true, children: [{ text: 'Start with:', openByDefault: true }] });
        expect(item.tree.find((node: any) => node.text === "S007's Stripes finding:").children[0].unit).toBe('observation');
        expect(walk(checklistNode.children).map((node: any) => node.text)).toEqual([
          'F005-C1 The module works with Stripes 10.1 or greater (lower bound ^10.1.0).',
          'Start with:',
          'package.json — devDependencies.@folio/stripes ^10.0.0'
        ]);
        expect(rowLinks(html, 'F005')('package.json — devDependencies.@folio/stripes ^10.0.0').href)
          .toBe(`https://github.com/folio-org/test-module/blob/${commit}/package.json`);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  it('renders B001 as a Backend criterion whose open checklist links to the cited build file', () => {
    const analysis = evaluateB001({
      kind: 'ambiguous', kindEvidence: ['No module descriptor found'], moduleKind: { kind: 'ambiguous', evidence: [], warnings: [] },
      templateCandidates: [], framework: { name: 'unknown', evidence: [] }, storage: { present: false, evidence: [] },
      snapshot: { revision: 'x', complete: true, diagnostics: [], files: [{ path: 'pom.xml', oid: 'x', size: 1, content: '<project/>' }] }
    });
    const b001 = { criterionId: 'B001', status: analysis.status, evidence: analysis.summary, details: renderB001HumanDetails(analysis), criterionDetails: analysis };
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const html = new EvaluationReportRenderer().renderHtml({ ...result, criteria: [b001], provenance: {
      repositoryCommit: commit, evaluator: { name: 'folio-module-evaluator', version: '1.0.0' },
      citedSourcePaths: citedTrackedFiles([b001], ['pom.xml']) } });
    const item = preparedItems(html)[0];

    expect(item).toMatchObject({ id: 'B001', title: 'Module descriptor template', category: 'Backend', triage: 'review' });
    expect(item.summary).toBe('No module descriptor was found, and the repository is not a known shared library. A module must have one; a library need not.');
    const checklistNode = item.tree.find((node: any) => node.text === 'Checklist for the reviewer:');
    expect(checklistNode.children[0]).toMatchObject({
      text: 'B001-C2 The repository is a shared library, or it is a module and commits its module descriptor template.',
      openByDefault: true, children: [{ text: 'Start with:', openByDefault: true }]
    });
    expect(rowLinks(html, 'B001')('pom.xml — what the build produces').href).toBe(`https://github.com/folio-org/test-module/blob/${commit}/pom.xml`);
  });
});
