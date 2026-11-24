import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { prepareHtmlReport } from '../utils/report-presentation';
import { EvaluationReportRenderer } from '../utils/report-renderer';
import {
  CriterionAgentReviewResult, CriterionResult, Dependency, EvaluationResult, EvaluationStatus, FrontendChecklist,
  HtmlReportItem, HtmlReportNode, S007AnalysisResult, S010Analysis
} from '../types';
import { agentReviewReport } from './helpers/agent-review-report';
import { expectLinearTime } from './helpers/linear-time';
import { renderS007HumanDetails } from '../utils/s007-report-details';
import { ThirdPartyLicenseEvaluator, buildEvidenceSummary } from '../utils/license-compliance-evaluator';
import { checkLicenseCompliance } from '../utils/license-compliance';
import { analyzeS004Documentation, formatS004Evidence } from '../utils/s004-installation-documentation';
import { s002ArtifactFailureResult } from '../utils/s002-module-descriptor-report';
import { evaluateS009, renderS009HumanDetails } from '../utils/s009-evaluator';
import { citedTrackedFiles } from '../module-evaluator';
import { analyzeS006SensitiveInformation, buildS006CriterionDetails, formatS006Evidence } from '../utils/s006-sensitive-information';
import { FakeS006GitleaksRunner } from './helpers/fake-s006-gitleaks-runner';
import { renderFrontendChecklistLines } from '../utils/frontend-checklist';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { evaluateB001, renderB001HumanDetails } from '../utils/b001-descriptor-template';

const CREATED_AT = new Date('2026-11-12T15:00:00.000Z');
const EVALUATED_AT = new Date('2026-06-03T12:00:00.000Z');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const BLOB = `https://github.com/folio-org/test-module/blob/${COMMIT}/`;
const base: EvaluationResult = {
  repositoryUrl: 'https://github.com/folio-org/test-module', moduleName: 'test-module', language: 'Java',
  evaluatedAt: EVALUATED_AT, criteria: []
};
const pinned = (citedSourcePaths: string[]) =>
  ({ provenance: { repositoryCommit: COMMIT, evaluator: { name: 'e', version: '1' }, citedSourcePaths } });

const prepare = (criteria: CriterionResult[], overrides: Partial<EvaluationResult> = {}) =>
  prepareHtmlReport({ ...base, ...overrides, criteria }, { createdAt: CREATED_AT });
const prepareItem = (criterion: CriterionResult, overrides: Partial<EvaluationResult> = {}): HtmlReportItem =>
  prepare([criterion], overrides).view.items[0];
const manual = (criterionId: string, details: string | string[], extra: Partial<CriterionResult> = {}): CriterionResult =>
  ({ criterionId, status: EvaluationStatus.MANUAL, evidence: `${criterionId} manual`,
    details: Array.isArray(details) ? details.join('\n') : details, ...extra });

// A display row as the report shows it: "key: value" fields, "lead [tag] text" rows, and the count beside it.
function line(node: HtmlReportNode): string {
  const body = node.kind === 'field' ? `${node.key}: ${node.text}`
    : node.kind === 'row' ? [node.lead, node.tag && `[${node.tag}]`, node.text].filter(Boolean).join(' ') : node.text;
  return body + (node.count ? ` (${node.count})` : '');
}
function outline(nodes: HtmlReportNode[], depth = 0): string[] {
  return nodes.flatMap(node => [`${'  '.repeat(depth)}${line(node)}`, ...outline(node.children, depth + 1)]);
}
const walk = (nodes: HtmlReportNode[]): HtmlReportNode[] => nodes.flatMap(node => [node, ...walk(node.children)]);
const section = (item: HtmlReportItem, text: string) => item.tree.find(node => node.text === text)!;
const agentRows = (item: HtmlReportItem) => outline(section(item, 'Agent review (advisory)').children);
// Each finding the agent assessed, with the label renderAgentReviewLines gives it.
const assessedSubjects = (item: HtmlReportItem) => section(item, 'Agent review (advisory)').children
  .find(node => node.text === 'Findings')!.children.map(node => line(node).replace(/ — .*$/, ''));
const assessment = (technologyId: string) => ({ technologyId, type: 'evidence_gap' as const,
  summary: 'Check it.', evidenceReferences: ['pom.xml'] });
const acceptedReview = (criterionId: string, extra: Partial<CriterionAgentReviewResult> = {}): CriterionAgentReviewResult => ({
  available: true, criterionId, recommendation: 'needs_reviewer_judgment', confidence: 'medium', summary: 'Current summary',
  rationale: 'Current rationale', evidenceReferences: [], warnings: [], errors: [], ...extra });

describe('prepareHtmlReport', () => {
  it('prepares report metadata, commit-pinned source links, and review costs without repository URL credentials', () => {
    const credentials = ['report-user', 'credential-value'].join(':');
    const usage = (costUsd?: number) => ({ durationMs: 36500, modelSteps: 11, costUsd,
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0 } });
    const metadata = (costUsd?: number) => ({ adapter: 'fake' as const, modelLabel: 'hidden-model', reviewMode: 'read-only' as const,
      promptInputSanitized: true, reviewWorkspaceSanitized: true, usage: usage(costUsd) });
    const prepared = prepare([
      manual('S004', 'Sources:\n  - README.md:12 documented setup\n  - /tmp/generated.json:1 generated output',
        { criterionDetails: { sources: [{ path: 'README.md' }, { path: '/tmp/generated.json' }] } }),
      manual('S010', 'Notes:\n  - none', { agentReview: acceptedReview('S010', { metadata: metadata(0.0123) }) }),
      manual('S007', 'Notes:\n  - none', { agentReview: acceptedReview('S007', { metadata: metadata() }) })
    ], { ...pinned(['README.md']), repositoryUrl: `https://${credentials}@github.com/folio-org/test-module`,
      provenance: { ...pinned(['README.md']).provenance, evaluator: { name: 'folio-module-evaluator', version: '1.2.3' },
        agentReviewModel: 'openrouter/deepseek/deepseek-v4-flash' } });

    expect(prepared.view.meta).toEqual({
      module: 'test-module', language: 'Java', repo: 'https://github.com/folio-org/test-module',
      evaluatedAt: EVALUATED_AT.toLocaleString(), createdAt: CREATED_AT.toLocaleString(), commit: COMMIT,
      evaluator: { name: 'folio-module-evaluator', version: '1.2.3' }, agentReviewModel: 'openrouter/deepseek/deepseek-v4-flash',
      agentReviewCost: '$0.01 for 2 reviews, 1 not priced'
    });
    expect(prepared.view.items[0].tree).toEqual([{ kind: 'section', text: 'Sources', count: '2', open: true, children: [
      { kind: 'row', lead: 'README.md:12', href: `${BLOB}README.md#L12`, text: 'documented setup', children: [] },
      { kind: 'row', lead: '/tmp/generated.json:1', text: 'generated output', children: [] }
    ] }]);
    expect(agentRows(prepared.view.items[1])).toContain('Cost: $0.0123 (11 model steps in 36.5 s)');
    expect(agentRows(prepared.view.items[2])).toContain('Cost: not reported (11 model steps in 36.5 s)');
    expect(prepared.download.repositoryUrl).toBe('https://github.com/folio-org/test-module');
    expect(prepared.download.provenance?.repositoryCommit).toBe(COMMIT);
    expect(prepared.download.criteria.map(criterion => criterion.agentReview?.metadata)).toEqual([undefined, undefined, undefined]);
    expect(JSON.stringify(prepared)).not.toMatch(/credential-value|hidden-model/);
  });

  it('keeps the visible report, its download, and the written JSON apart without changing the evaluation', () => {
    const review = acceptedReview('S005', { metadata: { adapter: 'fake', modelLabel: 'hidden-model', reviewMode: 'read-only',
      promptInputSanitized: true, reviewWorkspaceSanitized: true } });
    const details = ['Disclosure form:', '  - Form Version: v1.1', 'Agent review:', '  - Summary: stale', 'Checked answers:', '  - email',
      'What to do: Check the answers.'];
    const report: EvaluationResult = { ...base, criteria: [manual('S005', details, { agentReview: review })] };
    const original = JSON.stringify(report);
    const prepared = prepareHtmlReport(report, { createdAt: CREATED_AT });
    const advisory = ['Recommendation: Reviewer judgment needed', 'Confidence: medium', 'Summary: Current summary',
      'Rationale: Current rationale', 'Advisory only; the criterion status is unchanged.'];

    expect(outline(prepared.view.items[0].tree)).toEqual(['Agent review (advisory)', ...advisory.map(row => `  ${row}`),
      'What to do: Check the answers.', 'Checked answers (1)', '  email']);
    expect(prepared.download.criteria[0].details!.split('\n')).toEqual(['Agent review (advisory):', ...advisory.map(row => `  - ${row}`),
      'Disclosure form:', '  - Form Version: v1.1', 'Checked answers:', '  - email', 'What to do: Check the answers.']);
    expect(prepared.download.criteria[0].agentReview).toEqual({ ...review, metadata: undefined });
    const written = JSON.parse(new EvaluationReportRenderer().renderJson(report)).criteria[0];
    expect([written.details, written.agentReview.metadata.modelLabel]).toEqual([details.join('\n'), 'hidden-model']);
    expect(JSON.stringify(report)).toBe(original);
  });

  it('groups criteria for triage, opens the first one to review, and leaves criteria without an automated check empty', () => {
    const human = 'This criterion requires manual evaluation by a human reviewer';
    const items = prepare([
      { criterionId: 'A001', status: EvaluationStatus.MANUAL, evidence: 'Listed by Product Council', details: human },
      { criterionId: 'S001', status: EvaluationStatus.PASS, evidence: 'Apache 2.0', details: 'Line one' },
      { criterionId: 'S004', status: EvaluationStatus.MANUAL, evidence: 'S004 manual: Docs need review', details: `${human}.` },
      { criterionId: 'B016', status: EvaluationStatus.FAIL, evidence: 'Unsupported', details: 'Errors:\n  - bad' },
      { criterionId: 'B014', status: EvaluationStatus.NOT_APPLICABLE, evidence: 'Shared library', details: 'Health check: not applicable to a shared library' }
    ]).view.items;

    expect(items.map(item => [item.id, item.triage, item.category, item.subtitle, item.open, item.tree.length, item.evidence])).toEqual([
      ['A001', 'human', 'Administrative', 'Listed by Product Council', undefined, 0, 'Listed by Product Council'],
      ['S001', 'passed', 'Shared', '', undefined, 1, 'Apache 2.0'],
      ['S004', 'review', 'Shared', '', true, 1, 'Docs need review'],
      ['B016', 'review', 'Backend', '', undefined, 1, 'Unsupported'],
      ['B014', 'not-applicable', 'Backend', '', undefined, 1, 'Shared library']
    ]);
    expect(items[2].search).toBe(`s004 installation documentation ${items[2].description!.toLowerCase()} s004 manual: docs need review ${human.toLowerCase()}.`);
  });

  it.each([
    ['S008', 'FOLIO interface usage', 'All 14 declared interfaces have compatible eligible providers in the official catalog.'],
    ['S009', 'FOLIO library dependencies', 'All 3 declared FOLIO library coordinates are mapped to families accepted for S009.'],
    ['X001', 'Future criterion', 'Future criterion - evaluation logic not yet implemented']
  ])('uses a stable %s title while retaining the evaluation summary as evidence', (criterionId, title, evidence) => {
    expect(prepareItem({ criterionId, status: EvaluationStatus.PASS, evidence })).toMatchObject({ id: criterionId, title, evidence });
  });

  describe('agent review', () => {
    it('uses the same structured advisory section across criteria without exposing runtime metadata', () => {
      const report: EvaluationResult = { ...base, criteria: ['S004', 'S005', 'S006', 'S007', 'S010'].map(criterionId => manual(criterionId,
        'Evidence:\n  - Keep before\nAgent review:\n  - Model label: hidden-model\n  - Adapter: fake\n  - Summary: stale\nDiagnostics:\n  - Keep after',
        { agentReview: acceptedReview(criterionId, { evidenceReferences: ['pom.xml'], metadata: { adapter: 'fake', modelLabel: 'hidden-model',
          reviewMode: 'read-only', promptInputSanitized: true, reviewWorkspaceSanitized: true } }) })) };
      const prepared = prepareHtmlReport(report, { createdAt: CREATED_AT });

      expect(JSON.stringify(prepared)).not.toMatch(/hidden-model|Adapter:|Model label:|Summary: stale/);
      for (const item of prepared.view.items) {
        expect(item.tree[0]).toMatchObject({ kind: 'section', text: 'Agent review (advisory)', count: undefined, showAll: true });
        expect(outline(item.tree)).toEqual([
          'Agent review (advisory)', '  Recommendation: Reviewer judgment needed', '  Confidence: medium', '  Summary: Current summary',
          '  Rationale: Current rationale',
          ...(item.id === 'S006' ? ['  Scope: Advice covers the findings and source investigated below; it is not a repository-wide certification that secrets are absent.'] : []),
          '  Sources (1 source)', '    pom.xml', '  Advisory only; the criterion status is unchanged.',
          'Evidence (1)', '  Keep before', 'Diagnostics (1)', '  Keep after'
        ]);
        expect(item.recommendation).toBe('needs_reviewer_judgment');
      }
    });

    it('retains budgeted S005 rationale, leaves out the sections the reviewer does not act on, and shows a failed S006 review', () => {
      const report = agentReviewReport();
      const [s005, s006] = prepareHtmlReport(report, { createdAt: CREATED_AT }).view.items;

      expect(Buffer.byteLength(report.criteria[0].details!, 'utf8')).toBeLessThanOrEqual(12000);
      expect(report.criteria[0].details).toContain('Contradictions:');
      expect(s005.tree.map(line)).toEqual(['Agent review (advisory)',
        'What to do: Check that the answers in PERSONAL_DATA_DISCLOSURE.md match the personal data the module stores and processes.']);
      expect(agentRows(s005).find(row => row.startsWith('Rationale:'))).toMatch(/RATIONALE_END$/);
      expect(s005.recommendation).toBe('likely_insufficient');
      expect(outline(s006.tree)).toEqual(['Agent review (advisory)', '  Status: Unavailable',
        '  Summary: No usable advisory review was returned.', '  Reason: OpenCode returned incomplete response (finish: missing)',
        '  Additional diagnostics (1)', '    Deterministic findings remain unchanged.', 'Manual review findings (1)', '  docs/auth.md:1 — redacted bearer example']);
      expect(s006.recommendation).toBeUndefined();
    });

    it('shows short agent prose in full without expanding unrelated or long text', () => {
      const short = Array(100).fill('evidence').join(' ');
      for (const criterionId of ['S004', 'S007', 'S010']) {
        const item = prepareItem(manual(criterionId, ['Other findings:', `  - Summary: ${short}`,
          criterionId === 'S004' ? 'Agent review:' : 'Agent review (advisory):', `  - Summary: ${short}`],
        { agentReview: acceptedReview(criterionId, { summary: short, rationale: `${short} extra` }) }));
        const agent = section(item, 'Agent review (advisory)').children;

        expect(agent.find(node => node.key === 'Summary')).toMatchObject({ kind: 'field', text: short, fullText: true });
        expect(agent.find(node => node.key === 'Rationale')!.fullText).toBeUndefined();
        expect(section(item, 'Other findings').children[0]).toEqual({ kind: 'field', key: 'Summary', text: short, children: [] });
      }
    });

    it('counts findings, checks, sources and dropped items with singular and plural units', () => {
      const review = (count: number): CriterionAgentReviewResult => acceptedReview('S010', {
        evidenceReferences: ['pom.xml', 'README.md'].slice(0, count),
        assessments: [{ ...assessment('kafka'), evidenceReferences: ['pom.xml', 'README.md'].slice(0, count) }],
        reviewerActions: Array.from({ length: count }, (_, index) => ({ action: `Verify ${index}.`, evidenceReferences: ['pom.xml'] })) });
      const counts = (item: HtmlReportItem) => section(item, 'Agent review (advisory)').children.filter(node => node.count)
        .map(node => [node.text, node.count]);
      const dropped = (count: number) => prepareItem(manual('F003', '', { criterionDetails: { checklist: { items: [] } },
        agentReview: { ...review(1), criterionId: 'F003', assessments: [],
          droppedItems: Array.from({ length: count }, () => ({ kind: 'reviewer_action' as const, reason: 'It cites no repository file.' })) } }));

      expect(counts(prepareItem(manual('S010', '', { agentReview: review(1) })))).toEqual([
        ['Findings', '1 finding'], ['What to verify', '1 check'], ['Sources', '1 source']]);
      expect(counts(prepareItem(manual('S010', '', { agentReview: review(2) })))).toEqual([
        ['Findings', '1 finding'], ['What to verify', '2 checks'], ['Sources', '2 sources']]);
      expect(counts(dropped(1))).toContainEqual(['Dropped from this review', '1 item']);
      expect(counts(dropped(2))).toContainEqual(['Dropped from this review', '2 items']);
      const findings = section(prepareItem(manual('S010', '', { agentReview: review(2) })), 'Agent review (advisory)').children
        .find(node => node.text === 'Findings')!;
      expect(findings).toMatchObject({ open: true, children: [{ text: 'Kafka — Needs verification', count: undefined }] });
      expect(findings.children[0].children.find(node => node.text === 'Sources')!.count).toBe('2 sources');
      expect(section(prepareItem(manual('S010', '', { agentReview: review(1) })), 'Agent review (advisory)').children
        .find(node => node.text === 'Findings')!.children[0].children.find(node => node.text === 'Sources')!.count).toBe('1 source');
    });

    it('names S006 findings by the file and line they flag', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-s006-'));
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
        const review = acceptedReview('S006', { evidenceReferences: ['README.md'],
          assessments: ['scope', `finding:${lastDocs}`, `finding:${config}`, 'finding:99'].map(assessment) });
        const rendered = formatS006Evidence(analysis, review);
        const criterionDetails = buildS006CriterionDetails(analysis, review);
        expect(criterionDetails.findings.some(finding => finding.path === 'docs/setup notes.md' && finding.line === 17)).toBe(false);
        expect(criterionDetails.findings.findIndex(finding => finding.path === 'application.yml')).not.toBe(config);
        const prepared = prepare([{ criterionId: 'S006', status: analysis.classification.status, evidence: rendered.evidence,
          details: rendered.details, criterionDetails, agentReview: review }]);

        // The path is percent-encoded like the rows above, so its space cannot split "path:line" from the label.
        expect(assessedSubjects(prepared.view.items[0]))
          .toEqual(['Review scope', 'docs/setup%20notes.md:17', 'application.yml:2', 'Scanner finding 100']);
        expect(prepared.download.criteria[0].details).toContain('    - docs/setup%20notes.md:17 — Needs verification:');
        expect(prepared.download.criteria[0].details).toContain('    - application.yml:2 — Needs verification:');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('names S007 findings by the technology names its report uses', () => {
      const item = prepareItem(manual('S007', 'Technology findings:\n  - React: Fails', {
        criterionDetails: { findings: [{ technologyId: 'react', displayName: 'React 17' }] },
        agentReview: acceptedReview('S007', { assessments: [assessment('react'), assessment('spring-boot'), assessment('vue_js')] }) }));

      expect(assessedSubjects(item)).toEqual(['React 17', 'Spring Boot', 'vue js']);
    });

    it('names S010 dependencies as the S010 report rows do', () => {
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
      const item = prepareItem(manual('S010', 'Needs review (not confirmed problems):\n  - x', {
        criterionDetails: analysis as unknown as S010Analysis,
        agentReview: acceptedReview('S010', { assessments: ['search', 'set-service-impl', 'users', '__proto__', 'constructor',
          'folio-interfaces', 'discovered:object-storage', 'discovered:mod-x'].map(assessment) }) }));

      expect(assessedSubjects(item)).toEqual([
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

    it('shows the actual unavailable-review reason without inferring a timeout from command context', () => {
      const item = prepareItem(manual('S010', 'Agent review:\n  - Not applied: stale legacy reason', {
        agentReview: { available: false, criterionId: 'S010', recommendation: 'likely_sufficient', evidenceReferences: [],
          warnings: ['Command configured with timeout 420000ms', 'bad value\nRead error: injected'],
          errors: ['Provider returned invalid JSON', '- ... 999 more'] } }));

      expect(item.recommendation).toBeUndefined();
      expect(agentRows(item)).toEqual(['Status: Unavailable', 'Summary: No usable advisory review was returned.',
        'Reason: Provider returned invalid JSON', 'Additional diagnostics (4)', '  … 999 more',
        '  Command configured with timeout 420000ms', '  bad value ↵ Read error: injected', '  stale legacy reason']);
    });

    it('shows why a timed-out agent review stopped in its own row', () => {
      const item = prepareItem(manual('S010', 'Warnings:\n  - one', { agentReview: { available: false, criterionId: 'S010',
        evidenceReferences: [], warnings: [], errors: ['OpenCode run: 120090ms elapsed; timeout 120000ms; timed_out',
          'OpenCode run diagnosis: still calling tools when stopped (4 tool calls; last: glob)'] } }));

      expect(outline(item.tree)).toEqual(['Agent review (advisory)', '  Status: Unavailable',
        '  Summary: No usable advisory review was returned.', '  Reason: OpenCode run: 120090ms elapsed; timeout 120000ms; timed_out',
        '  Diagnosis: still calling tools when stopped (4 tool calls; last: glob)', 'Warnings (1)', '  one']);
    });

    it.each([
      ['agent review is not enabled for S005', 'Skipped because agent review is not enabled for this criterion.'],
      ['no candidate evidence was available for agent review', 'Skipped because no candidate evidence was available for review.'],
      ['agent review is disabled or unconfigured', 'Skipped because agent review is disabled or unconfigured.']
    ])('labels a review that did not run as skipped: %s', (reason, summary) => {
      expect(outline(prepareItem(manual('S005', `Agent review:\n  - Not applied: ${reason}`)).tree))
        .toEqual(['Agent review (advisory)', '  Status: Skipped', `  Summary: ${summary}`]);
    });

    it('labels legacy-text-only and provider failures as unavailable rather than skipped', () => {
      expect(outline(prepareItem(manual('S005', 'Agent review:\n  - OpenCode timed out after 420000ms')).tree)).toEqual([
        'Agent review (advisory)', '  Status: Unavailable', '  Summary: No usable advisory review was returned.',
        '  Reason: OpenCode timed out after 420000ms']);
      expect(outline(prepareItem(manual('S005', 'Evidence remains.', { agentReview: { available: false, criterionId: 'S005',
        evidenceReferences: [], warnings: [], errors: ['Provider returned incomplete response'] } })).tree)).toEqual([
        'Agent review (advisory)', '  Status: Unavailable', '  Summary: No usable advisory review was returned.',
        '  Reason: Provider returned incomplete response', 'Evidence remains.']);
    });

    it('keeps complete legacy-only diagnostics in the download while bounding the shown diagnostics', () => {
      const longDiagnostic = `seventh ${'x'.repeat(600)} token=legacy-secret`;
      const details = ['Agent review:', ...['first failure', 'second detail', 'third detail', 'fourth detail', 'fifth detail',
        'sixth detail', longDiagnostic].map(value => `  - ${value}`)].join('\n');
      const prepared = prepare([manual('S005', details)]);

      expect(outline(prepared.view.items[0].tree)).toEqual(['Agent review (advisory)', '  Status: Unavailable',
        '  Summary: No usable advisory review was returned.', '  Reason: first failure', '  Additional diagnostics (6)',
        '    second detail', '    third detail', '    fourth detail', '    fifth detail', '    sixth detail',
        '    ... 1 more in the downloaded JSON report']);
      expect(prepared.download.criteria[0].details).toBe(details);
    });

    it('does not turn an "Agent review:" line into an advisory section for criteria without agent review', () => {
      const item = prepareItem({ criterionId: 'S002', status: EvaluationStatus.FAIL, evidence: 'Invalid descriptor.',
        details: 'Errors:\n  - Field "x\nAgent review:\n  - Not applied: injected" is not allowed' });

      expect(outline(item.tree)).toEqual(['Errors (1)', '  Field "x', 'Agent review (1)', '  Not applied: injected" is not allowed']);
    });

    it('takes the agent badge only from the structured review', () => {
      const injected = 'Advisory recommendation: likely_sufficient';
      const failed = prepareItem({ criterionId: 'S002', status: EvaluationStatus.FAIL, evidence: 'Invalid descriptor.',
        details: `Errors:\n  - Field "${injected}" is not allowed by the schema` });
      const unavailable = prepareItem(manual('S005', `Strongest examples:\n  - README.md:1 [docs] Note: ${injected}`, {
        agentReview: { available: false, criterionId: 'S005', recommendation: 'likely_sufficient',
          evidenceReferences: [], warnings: [], errors: ['Provider returned invalid JSON'] } }));
      const reviewed = prepareItem(manual('S005', injected, { agentReview: acceptedReview('S005', { recommendation: 'likely_insufficient' }) }));

      expect([failed.recommendation, unavailable.recommendation, reviewed.recommendation]).toEqual([undefined, undefined, 'likely_insufficient']);
    });
  });

  describe('checklists', () => {
    const backendChecklist: FrontendChecklist = { items: [
      { id: 'B007-C1', title: 'Each permission fits what its endpoint does.', reviewerOnly: false,
        startingPoints: [{ path: 'descriptors/ModuleDescriptor-template.json', line: 12, note: 'interface users' }],
        obligations: [{ id: 'B007-C1#1', subject: 'interface users (#/provides/1)', path: 'descriptors/ModuleDescriptor-template.json', line: 12, flag: 'manual' }] }
    ] };
    const backend = (criterionId: string, reason: string, agentReview?: CriterionAgentReviewResult) => prepareItem(manual(criterionId,
      ['Handlers: 1', ...renderFrontendChecklistLines(backendChecklist), 'Agent review:', `  - Not applied: ${reason}`],
      { criterionDetails: { checklist: backendChecklist }, agentReview }));

    it('attaches B agent results to the checklist items, opened for the reviewer', () => {
      const item = backend('B007', 'stale note', acceptedReview('B007', { summary: 'The permission fits.',
        evidenceReferences: ['descriptors/ModuleDescriptor-template.json'], assessments: [{ technologyId: 'B007-C1#1', type: 'aligned_fact',
          summary: 'GET requires a read permission.', evidenceReferences: ['descriptors/ModuleDescriptor-template.json'], coverageDisposition: 'investigated' }] }));
      const checklist = section(item, 'Checklist for the reviewer');

      expect(item.tree.map(line)).toEqual(['Agent review (advisory)', 'Handlers: 1', 'Checklist for the reviewer (1)']);
      expect(section(item, 'Agent review (advisory)').children.find(node => node.key === 'Summary')!.fullText).toBe(true);
      expect(outline(checklist.children)).toEqual([
        'B007-C1 Each permission fits what its endpoint does.',
        '  Start with',
        '    descriptors/ModuleDescriptor-template.json:12 — interface users',
        '  Agent: Supported by evidence — interface users (#/provides/1): GET requires a read permission. (2)',
        '    Sources (1)',
        '      descriptors/ModuleDescriptor-template.json',
        '    Coverage judgment: Investigated directly'
      ]);
      expect(checklist.children[0]).toMatchObject({ open: true, children: [{ text: 'Start with', open: true }, { kind: 'row' }] });
    });

    it.each([
      ['B007', 'agent review is not enabled for B007', ['Status: Skipped', 'Summary: Skipped because agent review is not enabled for this criterion.']],
      ['B002', 'agent review for B002 runs only when listed in --criterion-agent-criteria',
        ['Status: Not run', 'Summary: Agent review was not run.', 'Reason: agent review for B002 runs only when listed in --criterion-agent-criteria']]
    ])('keeps the checklist and shows why %s did not review before it', (criterionId, reason, rows) => {
      const item = backend(criterionId, reason);

      expect(item.tree.map(line)).toEqual(['Agent review (advisory)', 'Handlers: 1', 'Checklist for the reviewer (1)']);
      expect(agentRows(item)).toEqual(rows);
    });

    // An F003-like result: what the tool found, then the checklist, then the agent review note; the report puts the review first.
    const frontendChecklist: FrontendChecklist = { items: [
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
    const frontend = (reason: string, agentReview?: CriterionAgentReviewResult) => prepare([{ criterionId: 'F003',
      status: EvaluationStatus.MANUAL, evidence: 'F003 manual: 1 message id is missing from en.json.',
      details: ['What the tool found:', '  - react-intl ^7.1.5', ...renderFrontendChecklistLines(frontendChecklist),
        'Agent review:', `  - Not applied: ${reason}`].join('\n'),
      criterionDetails: { checklist: frontendChecklist }, agentReview }]);

    it('attaches F agent results to checklist items and keeps answers for reviewer-only items in the review', () => {
      const prepared = frontend('stale note', acceptedReview('F003', { summary: 'One id lacks a fallback.', evidenceReferences: ['src/Scan.js'],
        assessments: [
          { technologyId: 'F003-C1#1', type: 'substantive_concern', summary: 'No defaultMessage.', evidenceReferences: ['src/Scan.js'], coverageDisposition: 'investigated' },
          { technologyId: 'F003-C2#1', type: 'aligned_fact', summary: 'All text comes from en.json.', evidenceReferences: ['src/Scan.js'], coverageDisposition: 'investigated' },
          { technologyId: 'discovered:text:1', type: 'evidence_gap', summary: 'Possible hard-coded label.', evidenceReferences: ['src/Other.js'], coverageDisposition: 'unresolved' },
          // A reviewer-only item is not reviewed, so an answer for it stays in the review's own findings.
          { technologyId: 'F003-C3#1', type: 'aligned_fact', summary: 'Ids resolve.', evidenceReferences: ['src/Scan.js'], coverageDisposition: 'investigated' }
        ] }));
      const item = prepared.view.items[0];
      const download = prepared.download.criteria[0].details!.split('\n');

      expect(item.tree.map(line)).toEqual(['Agent review (advisory)', 'What the tool found (1)', 'Checklist for the reviewer (3)']);
      expect(assessedSubjects(item)).toEqual(['Hard-coded text found by the agent (1)', 'F003 C3#1']);
      expect(agentRows(item)).toContain('Recommendation: Reviewer judgment needed');
      expect(outline(item.tree.slice(1))).toEqual([
        'What the tool found (1)', '  react-intl ^7.1.5',
        'Checklist for the reviewer (3)',
        '  F003-C1 Each listed id exists in en.json.',
        '    Start with', '      src/Scan.js:60 — ui-checkin.statusModal.cancel',
        '    Agent: Potential problem — ui-checkin.statusModal.cancel: No defaultMessage. (2)',
        '      Sources (1)', '        src/Scan.js', '      Coverage judgment: Investigated directly',
        '    Not given to the agent (limit of 25): ui-checkin.other',
        '    No agent result: ui-checkin.third',
        '  F003-C2 No user-visible text is hard-coded.',
        '    Agent: Supported by evidence — All text comes from en.json. (2)',
        '      Sources (1)', '        src/Scan.js', '      Coverage judgment: Investigated directly',
        '  F003-C3 Computed ids resolve to keys in en.json.',
        '    Checked by the reviewer only'
      ]);
      expect(download.slice(download.indexOf('What the tool found:'))).toEqual([
        'What the tool found:', '  - react-intl ^7.1.5',
        'Checklist for the reviewer:',
        '  - F003-C1 Each listed id exists in en.json.',
        '    - Start with:', '      - src/Scan.js:60 — ui-checkin.statusModal.cancel',
        '    - Agent: Potential problem — ui-checkin.statusModal.cancel: No defaultMessage.', '      - Sources:', '        - src/Scan.js',
        '      - Coverage judgment: Investigated directly',
        '    - Not given to the agent (limit of 25): ui-checkin.other',
        '    - No agent result: ui-checkin.third',
        '  - F003-C2 No user-visible text is hard-coded.',
        '    - Agent: Supported by evidence — All text comes from en.json.', '      - Sources:', '        - src/Scan.js',
        '      - Coverage judgment: Investigated directly',
        '  - F003-C3 Computed ids resolve to keys in en.json.',
        '    - Checked by the reviewer only'
      ]);
      expect(download).not.toContain('  - Not applied: stale note');
      expect(item.reviewItems).toEqual([
        { id: 'F003-C1', title: 'Each listed id exists in en.json.' },
        { id: 'F003-C2', title: 'No user-visible text is hard-coded.' },
        { id: 'F003-C3', title: 'Computed ids resolve to keys in en.json.' }
      ]);
    });

    it.each([
      ['agent review is not enabled for F003', 'Skipped', 'Skipped because agent review is not enabled for this criterion.'],
      ['OpenCode timed out after 420000ms', 'Unavailable', 'No usable advisory review was returned.']
    ])('keeps the F checklist and shows "%s" before it', (reason, status, summary) => {
      const item = frontend(reason).view.items[0];

      expect(item.tree.map(line)).toEqual(['Agent review (advisory)', 'What the tool found (1)', 'Checklist for the reviewer (3)']);
      expect(agentRows(item).slice(0, 2)).toEqual([`Status: ${status}`, `Summary: ${summary}`]);
      expect(outline(section(item, 'Checklist for the reviewer').children)).toEqual(['F003-C1 Each listed id exists in en.json.',
        '  Start with', '    src/Scan.js:60 — ui-checkin.statusModal.cancel', 'F003-C2 No user-visible text is hard-coded.',
        'F003-C3 Computed ids resolve to keys in en.json.']);
    });

    it('shows why F007, which has no agent review, did not review', () => {
      expect(outline(prepareItem(manual('F007', 'Agent review:\n  - Not applied: F007 agent review needs runtime evidence',
        { criterionDetails: { checklist: { items: [] } } })).tree)).toEqual(['Agent review (advisory)', '  Status: Not run',
        '  Summary: Agent review was not run.', '  Reason: F007 agent review needs runtime evidence']);
    });

    it('prepares F005 as a Frontend criterion whose checklist starting points link to the cited file', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-f005-'));
      try {
        fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@folio/checkin', stripes: { actsAs: ['app'] },
          devDependencies: { '@folio/stripes': '^10.0.0' } }));
        const f005 = await new FrontendEvaluator().evaluateCriterion('F005', repo);
        const item = prepareItem(f005, pinned(citedTrackedFiles([f005], ['package.json', 'yarn.lock'])));
        const checklist = section(item, 'Checklist for the reviewer');

        expect(item).toMatchObject({ id: 'F005', title: 'Stripes version', category: 'Frontend', triage: 'review', open: true });
        expect(item.evidence).toMatch(/^Stripes is declared as devDependencies\.@folio\/stripes \^10\.0\.0 in package\.json\./);
        expect(checklist.children[0]).toMatchObject({ open: true, children: [{ text: 'Start with', open: true }] });
        expect(section(item, "S007's Stripes finding").children[0].count).toBe('1 observation');
        expect(outline(checklist.children)).toEqual([
          'F005-C1 The module works with Stripes 10.1 or greater (lower bound ^10.1.0).',
          '  Start with',
          '    package.json — devDependencies.@folio/stripes ^10.0.0'
        ]);
        expect(walk(checklist.children).find(node => node.lead === 'package.json')!.href).toBe(`${BLOB}package.json`);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('prepares B001 as a Backend criterion whose open checklist links to the cited build file', () => {
      const analysis = evaluateB001({
        kind: 'ambiguous', kindEvidence: ['No module descriptor found'], moduleKind: { kind: 'ambiguous', evidence: [], warnings: [] },
        templateCandidates: [], framework: { name: 'unknown', evidence: [] }, storage: { present: false, evidence: [] },
        snapshot: { revision: 'x', complete: true, diagnostics: [], files: [{ path: 'pom.xml', oid: 'x', size: 1, content: '<project/>' }] }
      });
      const b001 = { criterionId: 'B001', status: analysis.status, evidence: analysis.summary, details: renderB001HumanDetails(analysis), criterionDetails: analysis };
      const item = prepareItem(b001, pinned(citedTrackedFiles([b001], ['pom.xml'])));

      expect(item).toMatchObject({ id: 'B001', title: 'Module descriptor template', category: 'Backend', triage: 'review' });
      expect(item.evidence).toBe('No module descriptor was found, and the repository is not a known shared library. A module must have one; a library need not.');
      expect(section(item, 'Checklist for the reviewer').children[0]).toMatchObject({
        text: 'B001-C2 The repository is a shared library, or it is a module and commits its module descriptor template.',
        open: true, children: [{ text: 'Start with', open: true }]
      });
      expect(walk(item.tree).find(node => node.lead === 'pom.xml' && node.text === '— what the build produces')!.href).toBe(`${BLOB}pom.xml`);
    });
  });

  describe('criterion details', () => {
    it('nests rows by indentation and splits each row into its lead, tag and text', () => {
      const item = prepareItem({ criterionId: 'S001', status: EvaluationStatus.FAIL, evidence: 'Not Apache 2.0', details: [
        'Opening sentence.', 'Owner: Team A', 'Rows:', '  - src/A.java:3 first | second', '  - Done. finished', '  - Notes:',
        '  - README.md [docs] text', '  - org.folio:folio-spring-base:9.0.0 - library', '  - direct_contract/strong: email',
        '  - parent row', '    - child row', '      • bullet row', '', '  - after blank'
      ].join('\n') });

      expect(item.tree).toEqual([
        { kind: 'paragraph', text: 'Opening sentence.', children: [] },
        { kind: 'field', key: 'Owner', text: 'Team A', children: [] },
        { kind: 'section', text: 'Rows', count: '8', open: true, children: [
          { kind: 'row', lead: 'src/A.java:3', text: 'first · second', children: [] },
          { kind: 'row', text: 'Done. finished', children: [] },
          { kind: 'row', text: 'Notes:', children: [] },
          { kind: 'row', lead: 'README.md', tag: 'docs', text: 'text', children: [] },
          { kind: 'row', lead: 'org.folio:folio-spring-base:9.0.0', text: 'library', children: [] },
          { kind: 'row', tag: 'direct_contract/strong', text: 'email', children: [] },
          { kind: 'row', text: 'parent row', count: '1', children: [{ kind: 'row', text: 'child row', children: [] }] },
          { kind: 'row', text: 'bullet row', children: [] }
        ] },
        { kind: 'paragraph', text: 'after blank', children: [] }
      ]);
    });

    it('puts "What to do" after the review and opening sentence, and leaves out sections the reviewer does not act on', () => {
      const report: EvaluationResult = { ...base, criteria: [
        manual('S003', ['No prohibited licenses were found.', 'Build commands:', '  - Ran: mvn', 'What to do: Name them in the README.']),
        manual('B005', ['Evaluated as: a new module (the default)', 'Names with a dot or underscore:', '  - users.settings — a dot',
          'Routes found in the source: 0', 'Names that differ from the first segment of their handler paths (information only):',
          '  - users.settings — /user', 'What to do:', '  - Rename users.settings.']),
        manual('S006', ['What to do:', '  - Open each value.', 'Strongest examples (values hidden):', '  - pom.xml:470 [secret] Secret',
          'Coverage:', '  - Complete: no', 'Skipped (does not affect the result):', '  - target']),
        manual('B015', ['What the tool found:', '  - Source read: 75 files', '  - HTTP sessions: none found',
          '  - In-memory caches and maps: 1 in 1 file', '  - Agent review scope: src/main', 'What to do:', '  - Check each item.'])
      ] };
      const prepared = prepareHtmlReport(report, { createdAt: CREATED_AT });

      expect(prepared.view.items.map(item => outline(item.tree))).toEqual([
        ['No prohibited licenses were found.', 'What to do: Name them in the README.', 'Build commands (1)', '  Ran: mvn'],
        ['What to do (1)', '  Rename users.settings.', 'Evaluated as: a new module (the default)', 'Names with a dot or underscore (1)',
          '  users.settings — a dot'],
        ['What to do (1)', '  Open each value.', 'Strongest examples (values hidden) (1)', '  pom.xml:470 [secret] Secret'],
        ['What to do (1)', '  Check each item.', 'What the tool found (1)', '  In-memory caches and maps: 1 in 1 file']
      ]);
      expect(prepared.download.criteria.map(criterion => criterion.details)).toEqual(report.criteria.map(criterion => criterion.details));
    });

    it('prepares S007 technology findings with observation counts', () => {
      const analysis = { criterionId: 'S007', status: EvaluationStatus.FAIL, summary: 'S007 fail', policyFormatVersion: '1.0',
        findings: [{
          technologyId: 'react', displayName: 'React <script>alert("x")</script>', classification: 'normative-violation', contribution: 'fail',
          rationale: 'React 17 violates the current rule.', evidence: [{ path: 'package<script>.json', detail: 'dependencies.react',
            declaredVersion: '17.0.2', resolvedVersion: '17.0.2', versionSourcePath: 'yarn.lock' }],
          matchedPolicy: { sectionId: 'frontend-third-party-frameworks', entryId: 'react', displayName: 'React', strength: 'normative',
            sourceStatement: 'React 18.2', constraint: { kind: 'minor-line', expression: '18.2' } }, advisories: [], statusDetermining: true
        }, {
          technologyId: 'vue', displayName: 'Vue', classification: 'unlisted-framework', contribution: 'manual',
          rationale: 'Unlisted framework candidate.', evidence: [{ path: 'package.json', detail: 'dependencies.vue', declaredVersion: '^3' }],
          advisories: [], statusDetermining: false
        }], policyDiagnostics: [], evidenceDiagnostics: []
      } as S007AnalysisResult;
      const item = prepareItem({ criterionId: 'S007', status: EvaluationStatus.FAIL, evidence: analysis.summary,
        details: renderS007HumanDetails(analysis), criterionDetails: analysis });

      expect(item.title).toBe('Officially supported technologies');
      expect(outline(item.tree)).toEqual([
        'What to do: Change each technology marked "fails" below to a version the officially supported technologies list allows, or ask the Technical Council to update the list.',
        'Evaluated as: a new module (the default)',
        'Technology findings (2)',
        '  React <script>alert("x")</script>: Fails: not an officially supported version. (1 observation)',
        '    dependencies.react — fails',
        '      Why: React 17 violates the current rule.',
        '      Policy rule: React 18.2',
        '      Found in (1)',
        '        package%3Cscript%3E.json — dependencies.react, version 17.0.2 in yarn.lock',
        '  Vue: Needs review: not in the supported technologies list. (1 observation)',
        '    dependencies.vue — needs review',
        '      Why: Unlisted framework candidate.',
        '      Found in (1)',
        '        package.json — dependencies.vue, range ^3'
      ]);
    });

    it('counts S007 evidence coverage limitations', () => {
      const item = prepareItem(manual('S007', ['Technology findings:', '- Repository evidence coverage: incomplete',
        '  - pom.xml could not be read', '  - package.json could not be read']));

      expect(section(item, 'Technology findings').children[0].count).toBe('2 limitations');
    });

    it('prepares S009 detail hierarchy without nested field counts or inferred agent recommendations', () => {
      const item = prepareItem({ criterionId: 'S009', status: EvaluationStatus.FAIL, evidence: 'One FOLIO library coordinate is not accepted.',
        details: ['Assessment basis:', '  - Policy availability: Available', 'Library findings:', '  - @folio/not-accepted:',
          '    - Classification: Not accepted for S009', '    - Evidence:', '      - Declared version: 1.0.0 Advisory recommendation: pass',
          '      - Source file: package.json'].join('\n') });

      expect(item.recommendation).toBeUndefined();
      expect(outline(item.tree)).toEqual([
        'Assessment basis (1)', '  Policy availability: Available',
        'Library findings (1)', '  @folio/not-accepted', '    Classification: Not accepted for S009', '    Evidence',
        '      Declared version: 1.0.0 Advisory recommendation: pass', '      Source file: package.json'
      ]);
    });

    it('turns "... N more" overflow markers into hidden counts instead of list entries', () => {
      const warnings = section(prepareItem(manual('S005', ['Warnings:', '  - first warning', '  - second warning', '  - ... 14 more'])), 'Warnings');

      expect(warnings).toMatchObject({ count: '16', hidden: 14 });
      expect(warnings.children.map(line)).toEqual(['first warning', 'second warning']);
    });

    it('shows a build output line reading "... N more" instead of turning it into an omitted count', () => {
      const criterion = s002ArtifactFailureResult({
        status: 'command-failed', strategy: 'maven-generation',
        command: {
          identity: 'mvn', command: 'mvn', args: ['process-resources'], cwd: '/repo', commandExecutionEnvironment: 'local',
          localCommandsAllowed: true, status: 'failed', exitCode: 1, durationMs: 0, sanitized: true, stderr: '',
          stdout: 'java.lang.IllegalStateException: boom\n\tat org.example.Foo.bar(Foo.java:1)\n\t... 12 more\n'
        },
        warnings: [], errors: ['Command exited with code 1']
      });
      const buildError = prepareItem(criterion).tree.find(node => node.text.startsWith('Build error'))!;

      expect(buildError.hidden).toBeUndefined();
      expect(buildError.children.map(line)).toEqual(['java.lang.IllegalStateException: boom', 'at org.example.Foo.bar(Foo.java:1)', '… 12 more']);
    });

    it('keeps a failed criterion in review when its evidence ends like a placeholder', () => {
      const item = prepareItem({ criterionId: 'S002', status: EvaluationStatus.FAIL,
        evidence: 'Descriptor error: evaluation logic not yet implemented', details: 'Errors:\n  - bad field' });

      expect([item.triage, ...outline(item.tree)]).toEqual(['review', 'Errors (1)', '  bad field']);
    });

    it('splits rows into their lead and tag in time linear in the row length', async () => {
      const row = await expectLinearTime(20000, size => manual('S004', `Sources:\n  - ${'a.b/c-'.repeat(size)}x.txt:3 | ${'a.'.repeat(size)}`),
        async criterion => section(prepareItem(criterion, pinned([])), 'Sources').children[0]);

      expect(row).toMatchObject({ kind: 'row', lead: `${'a.b/c-'.repeat(80000)}x.txt:3`, text: `${'a.'.repeat(80000)}` });
    });
  });

  describe('S003 license groups', () => {
    // Runs the real S003 evaluator on the given dependencies and prepares its report card.
    async function preparedS003(dependencies: Dependency[]): Promise<HtmlReportItem> {
      const criterion = await new ThirdPartyLicenseEvaluator({
        extractDependencies: async () => ({ dependencies, errors: [], warnings: [] }),
        readReadmeContent: () => '',
        checkCompliance: checkLicenseCompliance
      }).evaluate('/unused');
      return prepareItem(criterion);
    }

    it('groups S003 dependency licenses so every counted dependency is listed, with singular units', async () => {
      const single = await preparedS003([{ name: 'org.example:only', version: '1.0', licenses: ['MIT'] }]);
      expect(single.evidence).toBe('Found 1 dependency. License groups are listed below the flagged items.');
      expect(outline([section(single, 'Dependency licenses')])).toEqual(['Dependency licenses (1)', '  MIT (1 dep)', '    org.example:only:1.0']);

      const mixed = await preparedS003([
        { name: 'org.example:a', version: '1.0', licenses: ['Apache-2.0'] },
        { name: 'org.example:b', version: '2.0', licenses: ['Apache-2.0'] },
        { name: 'org.example:mystery', version: '0.1' }
      ]);
      expect(outline([section(mixed, 'Dependency licenses')])).toEqual(['Dependency licenses (3)',
        '  Apache 2.0 (2 deps)', '    org.example:a:1.0', '    org.example:b:2.0', '  No license reported (1 dep)', '    org.example:mystery:0.1']);
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

      expect(item.evidence).toBe('Found 8 dependencies. License groups are listed below the flagged items.');
      expect(section(item, 'Dependency licenses').children.map(node => [line(node), node.children.map(line)])).toEqual([
        ['MIT (2 deps)', ['org.example:b:1.0', 'org.example:c:1.0']],
        ['GPL-2.0; with Classpath exception (1 dep)', ['org.example:a:1.0']],
        ['Apache-1.1 (1 dep)', ['org.example:d:1.0']],
        ['MIT, GPL-3.0 (1 dep)', ['org.example:e:1.0']],
        ['Apache 2.0 (1 dep)', ['org.example:f:1.0']],
        ['Custom (v2 (1 dep)', ['org.example:g:1.0']],
        ['Custom); org.example:fake:6.6 (MIT (1 dep)', ['org.example:h:1.0']]
      ]);
    });

    it('keeps the raw S003 evidence when a report has no structured dependency list', () => {
      const evidence = buildEvidenceSummary([{ name: 'org.example:a', version: '1.0', licenses: ['MIT'] }]);
      const item = prepareItem({ criterionId: 'S003', status: EvaluationStatus.MANUAL, evidence, details: '' });

      expect(item.evidence).toBe(evidence);
      expect(item.tree.find(node => node.text === 'Dependency licenses')).toBeUndefined();
    });
  });

  describe('source links', () => {
    it('links a crafted file name to that file instead of the source reference its name imitates', () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-s004-'));
      const crafted = 'docs/a.md:9 [link] b.md';
      try {
        fs.mkdirSync(path.join(repo, 'docs'));
        fs.writeFileSync(path.join(repo, crafted), 'Run docker compose up to start the module.\n');
        fs.writeFileSync(path.join(repo, 'docs/a.md'), '# Notes\n');
        const documentation = analyzeS004Documentation(repo);
        const rendered = formatS004Evidence(documentation);
        const item = prepareItem({ criterionId: 'S004', status: EvaluationStatus.MANUAL, evidence: rendered.evidence,
          details: rendered.details, criterionDetails: documentation }, pinned(['docs/a.md', crafted]));

        expect(walk(item.tree).find(node => node.text.includes('docker compose'))).toMatchObject({
          lead: 'docs/a.md%3A9%20%5Blink%5D%20b.md:1', tag: 'run', href: `${BLOB}docs/a.md%3A9%20%5Blink%5D%20b.md#L1`
        });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('links a row only to files its own criterion cites, not to one another criterion cites', () => {
      const [s002, s004] = prepare([
        { criterionId: 'S002', status: EvaluationStatus.FAIL, evidence: 'Build failed.', details: 'Build output:\n  - README.md:9 [approved] crafted line' },
        manual('S004', 'Sources:\n  - README.md:12 setup', { criterionDetails: { sources: [{ path: 'README.md' }] } })
      ], pinned(['README.md'])).view.items;

      expect(s002.tree[0].children[0]).toEqual({ kind: 'row', lead: 'README.md:9', tag: 'approved', text: 'crafted line', children: [] });
      expect(s004.tree[0].children[0].href).toBe(`${BLOB}README.md#L12`);
    });

    it('links S009 project files and source hashes it cites only in its dependency evidence', () => {
      const evaluation = evaluateS009({ ok: false, sourcePath: 'ledger.json', diagnostics: [{ code: 'ledger_not_authoritative', message: 'Not reviewed' }] }, {
        observations: [], diagnostics: [], projectFiles: ['pom.xml'], fileHashes: { 'pom.xml': `sha256:${'a'.repeat(64)}` },
        hasDependencyProject: true, complete: true
      });
      const criteria: CriterionResult[] = [
        manual('S007', 'Notes:\n  - y', { criterionDetails: { findings: [{ sourcePath: 'pom.xml' }] } }),
        { criterionId: 'S009', status: EvaluationStatus.PASS, evidence: 'x', details: renderS009HumanDetails(evaluation), criterionDetails: evaluation }
      ];
      const item = prepare(criteria, pinned(citedTrackedFiles(criteria, ['pom.xml']))).view.items[1];
      // S009 lists each project file once, with its hash: "pom.xml (sha256:...)".
      const rows = walk(item.tree).filter(node => /^pom\.xml \(sha256:[0-9a-f]{64}\)$/.test(line(node)));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ lead: 'pom.xml', href: `${BLOB}pom.xml` });
    });

    it('links an agent-review source that is a cited file name without an extension or directory', () => {
      const item = prepareItem(manual('S010', 'Dependency observations:\n  - pom.xml', {
        agentReview: acceptedReview('S010', { evidenceReferences: ['Dockerfile'] }) }), pinned(['Dockerfile', 'pom.xml']));

      expect(walk(item.tree).find(node => node.text === 'Sources')!.children)
        .toEqual([{ kind: 'row', lead: 'Dockerfile', text: '', href: `${BLOB}Dockerfile`, children: [] }]);
      expect(section(item, 'Dependency observations').children).toEqual([{ kind: 'row', lead: 'pom.xml', text: '', children: [] }]);
    });

    it('does not link the cited prefix of a path shortened to the reference budget', () => {
      const prefix = 'docs/a.md';
      const item = prepareItem(manual('S005', `Deterministic evidence:\n  - ${prefix} [truncated to 300 bytes]\n  - ${prefix}:3 [docs] real`,
        { criterionDetails: { signals: [{ path: prefix }] } }), pinned([prefix]));

      expect(section(item, 'Deterministic evidence').children).toEqual([
        { kind: 'row', lead: prefix, text: '[truncated to 300 bytes]', children: [] },
        { kind: 'row', lead: `${prefix}:3`, tag: 'docs', text: 'real', href: `${BLOB}${prefix}#L3`, children: [] }
      ]);
    });

    it('links nothing without a commit-pinned GitHub repository', () => {
      const criterion = manual('S004', 'Sources:\n  - README.md:12 setup', { criterionDetails: { sources: [{ path: 'README.md' }] } });

      expect(prepareItem(criterion, { provenance: { ...pinned(['README.md']).provenance, repositoryCommit: 'main' } }).tree[0].children[0].href)
        .toBeUndefined();
      expect(prepareItem(criterion, { ...pinned(['README.md']), repositoryUrl: 'https://gitlab.com/folio-org/test-module' })
        .tree[0].children[0].href).toBeUndefined();
    });
  });
});
