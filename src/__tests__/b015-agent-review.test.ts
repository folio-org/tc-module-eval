import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B015Analysis, CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus } from '../types';
import { buildB015AgentReviewRequest } from '../utils/b015-agent-review';
import { backendBrowse } from '../utils/backend-agent-review';
import { evaluateB015 } from '../utils/b015-high-availability';
import { getBackendEvidence } from '../utils/backend-evidence';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { pom, repository } from './helpers/backend-repository';

const JAVA = 'src/main/java/org/folio/example';
const JOBS = `${JAVA}/Jobs.java`;
const CACHES = `${JAVA}/Caches.java`;

const fixture = () => repository({
  'pom.xml': pom('mod-example'),
  'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: 'mod-example-1.0.0', provides: [] }),
  [JOBS]: 'class Jobs {\n  @Scheduled(cron = "0 0 * * * *")\n  void notices() {}\n}',
  [CACHES]: 'class Caches {\n  private final Map<String, Job> progress = new ConcurrentHashMap<>();\n}',
  [`${JAVA}/Export.java`]: 'class Export {\n  void save(String id) { out = new PrintStream(new File("/var/export/" + id)); }\n}',
  'src/test/java/org/folio/example/JobsTest.java': 'class JobsTest {}',
  'reference-data/groups/staff.json': '{}'
});

const holds = (id: string, fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
  technologyId: id, type: 'aligned_fact', summary: 'Nothing of this kind in the module.', evidenceReferences: [JOBS], coverageDisposition: 'immaterial', ...fields
});
const jobConcern = holds('B015-C4#1', {
  type: 'substantive_concern', summary: 'Every instance sends the daily notices, so patrons get them twice with two instances (lines 2-3).',
  evidenceReferences: [JOBS], coverageDisposition: 'investigated'
});
const mapConcern = holds('B015-C3#1', {
  type: 'substantive_concern', summary: 'Job progress lives only in this map; a status request on another instance finds nothing.',
  evidenceReferences: [CACHES], coverageDisposition: 'investigated'
});
const action = { action: 'Check whether the notice job is meant to run on one instance only.', evidenceReferences: [JOBS] };

function fakeConfig(fields: Record<string, unknown>, enabledCriteria: string[] | undefined = ['B015']): CriterionAgentReviewConfig {
  return { enabled: true, ...(enabledCriteria ? { enabledCriteria } : {}), adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
    available: true, criterionId: 'B015', recommendation: 'likely_insufficient', confidence: 'medium',
    summary: 'Two sites keep work on one instance.', rationale: `Read ${JOBS} and ${CACHES}.`, evidenceReferences: [JOBS],
    warnings: [], errors: [], reviewerActions: [action], ...fields
  } as CriterionAgentReviewConfig['fakeResult'] };
}

async function evaluateWith(root: string, config: CriterionAgentReviewConfig) {
  return new BackendEvaluator().evaluateCriterion('B015', root, createEvaluationRun({ repositoryPath: root, language: 'java', agentReview: config }));
}

function rowsFrom(details: string | undefined, heading: string): string[] {
  const lines = (details ?? '').split('\n');
  return lines.slice(lines.indexOf(heading));
}

describe('B015 agent review', () => {
  it('gives the agent one obligation per file with sites, or the whole item, within the backend browse scope', async () => {
    const root = fixture();
    const analysis: B015Analysis = evaluateB015(await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root));
    const request = buildB015AgentReviewRequest(root, analysis);
    const prepared = (await prepareCriterionAgentReviewEvidence(request)).request;
    const paths = prepared.files.map(file => file.repoRelativePath);

    expect(request.defaultTimeoutMs).toBe(600_000);
    expect(paths).toEqual(expect.arrayContaining([JOBS, CACHES, 'pom.xml', 'descriptors/ModuleDescriptor-template.json']));
    expect(paths.filter(file => file.startsWith('src/test/') || file.startsWith('reference-data/'))).toEqual([]);
    const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/B015/checklist.json')!.content);
    expect(checklist.items.map((item: { id: string; obligations: unknown[] }) => [item.id, item.obligations])).toEqual([
      ['B015-C1', [{ id: 'B015-C1#1' }]],
      ['B015-C2', [{ id: 'B015-C2#1' }]],
      ['B015-C3', [{ id: 'B015-C3#1', subject: CACHES, path: CACHES, line: 2 }]],
      ['B015-C4', [{ id: 'B015-C4#1', subject: JOBS, path: JOBS, line: 2 }]]
    ]);
    expect(prepared.instructions).toContain('Report a site of the same four kinds that checklist.json does not list as discovered:site:<n>, citing its file.');
  });

  it('attaches an accepted review to the checklist items, lists discovered sites in the review, and keeps the status', async () => {
    const result = await evaluateWith(fixture(), fakeConfig({ assessments: [
      holds('B015-C1#1'), holds('B015-C2#1'), mapConcern, jobConcern,
      holds('discovered:site:1', { type: 'substantive_concern', summary: 'Exports are written to /var/export and served later.', evidenceReferences: [`${JAVA}/Export.java`], coverageDisposition: 'investigated' })
    ] }, undefined));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect((result.details ?? '').split('\n').slice(0, 9)).toEqual([
      'What the tool found:',
      '  - Source read: 3 Java, Groovy or Kotlin files in src/main and grails-app, without comments',
      '  - HTTP sessions: none found',
      '  - Local file writes: none found',
      '  - In-memory caches and maps: 1 in 1 file',
      '  - Scheduled jobs: 1 in 1 file',
      `  - Agent review scope: ${backendBrowse().scope}`,
      'What to do:',
      '  - Check each item below for a deployment of several instances behind a load balancer without session affinity; B015 is always decided by a reviewer.'
    ]);
    expect(rowsFrom(result.details, 'Checklist for the reviewer:')).toEqual([
      'Checklist for the reviewer:',
      '  - B015-C1 No request depends on session affinity: no HTTP session state, and no sticky routing.',
      '    - Agent: Supported by evidence — Nothing of this kind in the module.',
      '      - Sources:',
      `        - ${JOBS}`,
      '      - Coverage judgment: Not material to this scoped decision',
      '  - B015-C2 No data is kept only on one instance\'s local disk; temporary files are removed in the same request or job.',
      '    - Agent: Supported by evidence — Nothing of this kind in the module.',
      '      - Sources:',
      `        - ${JOBS}`,
      '      - Coverage judgment: Not material to this scoped decision',
      '  - B015-C3 In-memory state is a cache that can be rebuilt from shared storage, not data other instances need.',
      '    - Start with:',
      `      - ${CACHES}:2 — ConcurrentHashMap field`,
      `    - Agent: Potential problem — ${CACHES}: Job progress lives only in this map; a status request on another instance finds nothing.`,
      '      - Sources:',
      `        - ${CACHES}`,
      '      - Coverage judgment: Investigated directly',
      '  - B015-C4 Scheduled work runs once across instances, or is safe to run on every instance.',
      '    - Start with:',
      `      - ${JOBS}:2 — @Scheduled`,
      `    - Agent: Potential problem — ${JOBS}: Every instance sends the daily notices, so patrons get them twice with two instances (lines 2-3).`,
      '      - Sources:',
      `        - ${JOBS}`,
      '      - Coverage judgment: Investigated directly',
      'Agent review (advisory):',
      '  - Recommendation: Likely insufficient',
      '  - Confidence: medium',
      '  - Summary: Two sites keep work on one instance.',
      `  - Rationale: Read ${JOBS} and ${CACHES}.`,
      '  - Findings:',
      '    - Site found by the agent (1) — Potential problem:',
      '      - The reviewed source indicates a possible problem. Confirm its impact before making a decision.',
      '      - Finding: Exports are written to /var/export and served later.',
      '      - Sources:',
      `        - ${JAVA}/Export.java`,
      '      - Coverage judgment: Investigated directly',
      '  - What to verify:',
      '    - Check whether the notice job is meant to run on one instance only.',
      '      - Sources:',
      `        - ${JOBS}`,
      '  - Sources:',
      `    - ${JOBS}`,
      '  - Advisory only; the criterion status is unchanged.'
    ]);
  });

  it('drops invalid results one by one and does not accept "likely sufficient" with an open item', async () => {
    const result = await evaluateWith(fixture(), fakeConfig({ recommendation: 'likely_sufficient', assessments: [
      holds('B015-C1#1'),
      holds('B015-C2#1', { coverageDisposition: 'unresolved' }),
      holds('B015-C3#1', { coverageDisposition: 'investigated' }),
      jobConcern,
      holds('discovered:site:1'),
      holds('B015-C5#1')
    ] }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.assessments?.map(assessment => assessment.technologyId)).toEqual(['B015-C1#1', 'B015-C4#1']);
    expect(result.agentReview?.droppedItems).toEqual([
      { kind: 'assessment', technologyId: 'B015-C2#1', reason: 'It says the desired state holds but leaves it open.' },
      { kind: 'assessment', technologyId: 'B015-C3#1', reason: 'It is marked as investigated directly but does not cite the file it is about.' },
      { kind: 'assessment', technologyId: 'discovered:site:1', reason: 'A finding beyond the checklist must be a potential problem or need verification.' },
      { kind: 'assessment', technologyId: 'B015-C5#1', reason: 'It answers nothing the agent was asked to check.' }
    ]);
    const lines = (result.details ?? '').split('\n');
    expect(lines.find(line => line.startsWith('  - Recommendation: '))).toBe('  - Recommendation: Reviewer judgment needed — the agent recommended "Likely sufficient", but some of its results were dropped.');
    expect(lines.slice(lines.indexOf('  - B015-C3 In-memory state is a cache that can be rebuilt from shared storage, not data other instances need.') + 3).slice(0, 1))
      .toEqual([`    - Agent result dropped — ${CACHES}: It is marked as investigated directly but does not cite the file it is about.`]);
  });

  it('does not run when the criteria list names other criteria', async () => {
    const result = await evaluateWith(fixture(), fakeConfig({ assessments: [] }, ['B007']));
    expect(result.agentReview).toBeUndefined();
    expect((result.details ?? '').split('\n').slice(-2)).toEqual(['Agent review:', '  - Not applied: agent review is not enabled for B015']);
  });
});
