import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus, F001Analysis } from '../types';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { buildF001AgentReviewRequest } from '../utils/f001-agent-review';
import { loadF001HandlerIndex } from '../utils/f001-consumed-apis';
import { createEvaluationRun } from '../utils/evaluation-run';

describe('F001 agent review', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f001-agent-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    write('package.json', JSON.stringify({ name: '@folio/example', stripes: { actsAs: ['app'], okapiInterfaces: { users: '16.5', configuration: '2.0' } } }));
    write('src/Requests.js', [
      'export const useRequests = ({ moduleName }) => {',
      '  const ky = useOkapiKy();',
      "  ky.get('users');",
      '  ky.get(`${moduleName}/entries`);',
      "  return ky.get('circulation/not-a-real-endpoint');",
      '};'
    ].join('\n'));
    write('src/Requests.test.js', "it('requests', () => {});\n");
    commit();
  });
  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  const dynamic = (fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
    technologyId: 'F001-C2#1', type: 'substantive_concern', summary: 'moduleName is "settings", so this reaches `settings`, which is not declared.',
    evidenceReferences: ['src/Requests.js'], coverageDisposition: 'investigated', ...fields
  });
  const notInIndex = (fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
    technologyId: 'F001-C3#1', type: 'evidence_gap', summary: 'No backend module in the source names this path.',
    evidenceReferences: ['src/Requests.js'], coverageDisposition: 'unresolved', ...fields
  });
  const action = { action: 'Declare settings in okapiInterfaces.', evidenceReferences: ['package.json'] };

  it('gives the agent the unmapped requests, production source only, and the index patterns of their first segment', async () => {
    const analysis = await analyze();
    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    const prepared = (await prepareCriterionAgentReviewEvidence(buildF001AgentReviewRequest(repoPath, analysis, patterns()))).request;
    const file = (name: string) => JSON.parse(prepared.files.find(item => item.repoRelativePath === `.criterion-agent/F001/${name}`)!.content);

    expect(prepared.files.map(item => item.repoRelativePath)).not.toContain('src/Requests.test.js');
    expect(file('checklist.json').items.flatMap((item: any) => item.obligations)).toEqual([
      { id: 'F001-C2#1', subject: 'GET {}/entries', path: 'src/Requests.js', line: 4 },
      { id: 'F001-C3#1', subject: 'circulation/not-a-real-endpoint', path: 'src/Requests.js', line: 5 }
    ]);
    const circulation = file('handler-patterns.json').bySegment.circulation.patterns;
    expect(circulation).toEqual(expect.arrayContaining([{ interface: 'patron-action-session', methods: ['POST'], pathPattern: '/circulation/end-patron-action-session' }]));
    expect(Object.keys(file('handler-patterns.json').bySegment)).toEqual(['circulation']);
    expect(prepared.instructions).toContain('package.json declares configuration, users.');
  });

  it('attaches an accepted review to the checklist and shows discovered requests on their own, leaving the status unchanged', async () => {
    const result = await evaluateWith(fakeConfig({
      assessments: [dynamic(), notInIndex(), { technologyId: 'discovered:interface:1', type: 'substantive_concern',
        summary: 'useNotes posts to `notes`, which is not declared.', evidenceReferences: ['src/Requests.js'], coverageDisposition: 'investigated' }],
      reviewerActions: [action]
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.details).toContain('  - F001-C2 Each unresolved request goes to an interface the module declares.\n    - Start with:\n      - src/Requests.js:4 — GET {}/entries: run-time parts could reach');
    expect(result.details).toContain('    - Agent: Potential problem — GET {}/entries: moduleName is "settings", so this reaches `settings`, which is not declared.');
    expect(result.details).toContain('    - Request found by the agent (1) — Potential problem:');
  });

  it('accepts a concern about an interface newer than the handler index', async () => {
    const result = await evaluateWith(fakeConfig({
      assessments: [dynamic(), notInIndex({ type: 'substantive_concern', coverageDisposition: 'investigated',
        summary: 'mod-circulation serves this path in its `circulation-experiments` interface, which is not declared.' })],
      reviewerActions: [action]
    }));
    expect(result.agentReview?.errors).toEqual([]);
    expect(result.agentReview?.available).toBe(true);
  });

  it.each([
    ['a concern that names only a declared interface', [dynamic({ summary: 'This reaches `users` or `configuration`.' }), notInIndex()],
      ['    - Agent result dropped — GET {}/entries: The potential problem does not name, in backticks, an interface that package.json does not declare.'], []],
    ['a concern that names an interface without backticks', [dynamic({ summary: 'This reaches settings, which is not declared.' }), notInIndex()],
      ['    - Agent result dropped — GET {}/entries: The potential problem does not name, in backticks, an interface that package.json does not declare.'], []],
    ['a discovered concern that names no interface', [dynamic(), notInIndex(), { technologyId: 'discovered:interface:1', type: 'substantive_concern' as const,
      summary: 'Another request goes to an undeclared interface.', evidenceReferences: ['src/Requests.js'], coverageDisposition: 'investigated' as const }],
    ['    - Agent: Potential problem — GET {}/entries: moduleName is "settings", so this reaches `settings`, which is not declared.',
      '      - Sources:', '        - src/Requests.js', '      - Coverage judgment: Investigated directly'],
    ['  - Dropped from this review:',
      '    - A result for discovered:interface:1: The potential problem does not name, in backticks, an interface that package.json does not declare.']]
  ])('drops %s and keeps the rest of the review', async (_name, assessments, c2Rows, droppedRows) => {
    const result = await evaluateWith(fakeConfig({ assessments, reviewerActions: [action] }));
    const lines = (result.details ?? '').split('\n');
    const c2 = lines.indexOf('  - F001-C2 Each unresolved request goes to an interface the module declares.');
    const dropped = lines.indexOf('  - Dropped from this review:');

    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.assessments?.map(assessment => assessment.technologyId)).toContain('F001-C3#1');
    expect(lines.slice(c2 + 3, c2 + 3 + c2Rows.length + 1)).toEqual([...c2Rows, '  - F001-C3 Each path not in the handler index belongs to an interface the module declares.']);
    expect(dropped < 0 ? [] : lines.slice(dropped, lines.indexOf('  - Sources:'))).toEqual(droppedRows);
  });

  it('never reviews a fail, and says so when agent review is enabled', async () => {
    write('src/Requests.js', "export const useSessions = () => useOkapiKy().post('circulation/end-patron-action-session');\n");
    commit();
    const config = fakeConfig({ assessments: [], reviewerActions: [action] });
    delete config.enabledCriteria;

    const result = await evaluateWith(config);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.agentReview).toBeUndefined();
    expect(result.details).toContain('Agent review:\n  - Not applied: agent review runs only for manual results; the reviewer confirms each undeclared interface (F001-C1)');
  });

  function patterns() {
    const index = loadF001HandlerIndex();
    if (!index.loaded) throw new Error(index.problem);
    return index.patterns;
  }
  async function analyze(): Promise<F001Analysis> {
    return (await new FrontendEvaluator().evaluateCriterion('F001', repoPath)).criterionDetails as F001Analysis;
  }
  async function evaluateWith(config: CriterionAgentReviewConfig) {
    return new FrontendEvaluator().evaluateCriterion('F001', repoPath, createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', agentReview: config }));
  }
  function fakeConfig(fields: Record<string, unknown>): CriterionAgentReviewConfig {
    return { enabled: true, enabledCriteria: ['F001'], adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
      available: true, criterionId: 'F001', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
      summary: 'One request may reach an undeclared interface.', rationale: 'Read src/Requests.js.', evidenceReferences: ['src/Requests.js'],
      warnings: [], errors: [], ...fields
    } as CriterionAgentReviewConfig['fakeResult'] };
  }
  function write(relativePath: string, content: string): void {
    const absolutePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repoPath });
  }
  function commit(): void {
    git('add', '.');
    git('commit', '-qm', 'fixture');
  }
});
