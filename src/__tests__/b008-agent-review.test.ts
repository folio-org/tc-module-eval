import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B008Analysis, CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus } from '../types';
import { buildB008AgentReviewRequest } from '../utils/b008-agent-review';
import { evaluateB008 } from '../utils/b008-reference-data';
import { getBackendEvidence } from '../utils/backend-evidence';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { pom, repository, restVerticleBuild } from './helpers/backend-repository';

const TEMPLATE = 'descriptors/ModuleDescriptor-template.json';
const LOADER = 'src/main/java/org/folio/rest/impl/TenantRefAPI.java';

const fixture = () => repository({
  'pom.xml': pom('mod-example', restVerticleBuild),
  'src/main/resources/templates/db_scripts/schema.json': '{}',
  [TEMPLATE]: [
    '{',
    '  "id": "mod-example-1.0.0",',
    '  "provides": [{ "id": "example", "version": "1.0", "handlers": [',
    '    { "methods": ["GET", "POST"], "pathPattern": "/groups" },',
    '    { "methods": ["GET", "POST"], "pathPattern": "/proxy-types" },',
    '    { "methods": ["GET", "POST"], "pathPattern": "/block-reasons" }',
    '  ] }]',
    '}'
  ].join('\n'),
  'src/main/resources/ref-data/groups/staff.json': '{"group": "staff"}',
  [LOADER]: [
    'public class TenantRefAPI extends TenantAPI {',
    '  Future<Integer> loadData() {',
    '    TenantLoading tl = new TenantLoading();',
    '    tl.withKey("loadReference").withLead("ref-data");',
    '    tl.add("groups");',
    '    return tl.perform(attributes, headers, context, 0);',
    '  }',
    '}'
  ].join('\n')
});

const assessment = (technologyId: string, fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
  technologyId, type: 'aligned_fact', summary: 'Users create every value; none is needed at installation.', evidenceReferences: [TEMPLATE],
  coverageDisposition: 'investigated', ...fields
});

function fakeConfig(fields: Record<string, unknown>, enabledCriteria: string[] | null = ['B008']): CriterionAgentReviewConfig {
  return {
    enabled: true, ...(enabledCriteria ? { enabledCriteria } : {}), adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
      available: true, criterionId: 'B008', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
      summary: 'One vocabulary needs a value.', rationale: 'Read the descriptor and TenantRefAPI.java.', evidenceReferences: [TEMPLATE],
      warnings: [], errors: [], ...fields
    } as CriterionAgentReviewConfig['fakeResult']
  };
}

async function evaluateWith(root: string, config: CriterionAgentReviewConfig) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java', agentReview: config });
  const result = await new BackendEvaluator().evaluateCriterion('B008', root, run);
  return { result, analysis: result.criterionDetails as B008Analysis, lines: (result.details ?? '').split('\n') };
}

const CHECKLIST = [
  'Checklist for the reviewer:',
  '  - B008-C1 Each controlled vocabulary the module needs at least one value for has one after tenant initialization.',
  '    - Start with:',
  `      - ${TEMPLATE}:6 — /block-reasons: collection endpoint named like a vocabulary, no reference data found`,
  `      - ${TEMPLATE}:5 — /proxy-types: collection endpoint named like a vocabulary, no reference data found`
];

describe('B008 agent review', () => {
  it.each([
    ['without a criteria list, since B008 is opt-in only', null, 'agent review for B008 runs only when listed in --criterion-agent-criteria'],
    ['when the list names other criteria', ['B007'], 'agent review is not enabled for B008']
  ])('does not run %s', async (_name, enabledCriteria, reason) => {
    const { result, analysis, lines } = await evaluateWith(fixture(), fakeConfig({ assessments: [] }, enabledCriteria));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toBeUndefined();
    expect(analysis.agentReviewUnavailableReason).toBe(reason);
    expect(lines.slice(-CHECKLIST.length - 2)).toEqual([...CHECKLIST, 'Agent review:', `  - Not applied: ${reason}`]);
  });

  it('gives the agent each vocabulary without reference data as a flagged obligation, the folder listing but not its contents, and 600 s', async () => {
    const root = fixture();
    const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
    const evidence = await getBackendEvidence(run, root);
    const prepared = (await prepareCriterionAgentReviewEvidence(buildB008AgentReviewRequest(root, evaluateB008(evidence), evidence.snapshot.listedPaths ?? []))).request;
    const paths = prepared.files.map(file => file.repoRelativePath);

    expect(paths).toEqual(expect.arrayContaining([TEMPLATE, LOADER, 'pom.xml', '.criterion-agent/B008/reference-data-listing.txt']));
    expect(paths).not.toContain('src/main/resources/ref-data/groups/staff.json');
    expect(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/B008/reference-data-listing.txt')!.content)
      .toBe('src/main/resources/ref-data/groups/staff.json\n');
    const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/B008/checklist.json')!.content);
    expect(checklist.items.flatMap((item: { obligations: unknown[] }) => item.obligations)).toEqual([
      { id: 'B008-C1#1', subject: '/block-reasons', path: TEMPLATE, line: 6, flag: 'manual' },
      { id: 'B008-C1#2', subject: '/proxy-types', path: TEMPLATE, line: 5, flag: 'manual' }
    ]);
    expect(prepared.defaultTimeoutMs).toBe(600_000);
  });

  it('keeps the evidence summary within its limit when one vocabulary has many load paths', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      'src/main/resources/templates/db_scripts/schema.json': '{}',
      [TEMPLATE]: JSON.stringify({ id: 'mod-example-1.0.0', provides: [{ id: 'example', version: '1.0', handlers: [{ methods: ['GET', 'POST'], pathPattern: '/proxy-types' }] }] }),
      [LOADER]: `class TenantRefAPI { void load() {\nTenantLoading tl = new TenantLoading();\ntl.withKey("loadReference");\n${
        Array.from({ length: 1_000 }, (_item, index) => `tl.add("missing-${index}", "proxy-types");\n`).join('')}} }\n`
    });
    const evidence = await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
    const analysis = evaluateB008(evidence);
    const prepared = (await prepareCriterionAgentReviewEvidence(buildB008AgentReviewRequest(root, analysis, []))).request;
    const summary = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/B008/evidence-summary.json')!.content);

    expect(analysis.vocabularies[0].notCounted).toHaveLength(1_000);
    expect(summary.vocabularies.items[0].notCounted.omitted).toBeGreaterThan(0);
  });

  it('attaches an accepted review to the vocabularies, drops an invalid item on its own, and keeps the status', async () => {
    const { result, lines } = await evaluateWith(fixture(), fakeConfig({
      assessments: [
        assessment('B008-C1#1', { type: 'substantive_concern', summary: 'Patron blocks need at least one reason, and none is created.', evidenceReferences: [TEMPLATE, LOADER] }),
        assessment('B008-C1#2'),
        assessment('B008-C1#9'),
        assessment('discovered:vocabulary:1', { type: 'substantive_concern', summary: 'Departments need a value.', evidenceReferences: [LOADER] })
      ],
      reviewerActions: [{ action: 'Decide whether block reasons need shipped values.', evidenceReferences: [TEMPLATE] }]
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    const start = lines.indexOf(CHECKLIST[0]);
    expect(lines.slice(start, start + CHECKLIST.length + 10)).toEqual([
      ...CHECKLIST,
      '    - Agent: Potential problem — /block-reasons: Patron blocks need at least one reason, and none is created.',
      '      - Sources:',
      `        - ${TEMPLATE}`,
      `        - ${LOADER}`,
      '      - Coverage judgment: Investigated directly',
      '    - Agent: Supported by evidence — /proxy-types: Users create every value; none is needed at installation.',
      '      - Sources:',
      `        - ${TEMPLATE}`,
      '      - Coverage judgment: Investigated directly',
      'Agent review (advisory):'
    ]);
    expect(lines.slice(lines.indexOf('Agent review (advisory):'))).toEqual([
      'Agent review (advisory):',
      '  - Recommendation: Reviewer judgment needed',
      '  - Confidence: medium',
      '  - Summary: One vocabulary needs a value.',
      '  - Rationale: Read the descriptor and TenantRefAPI.java.',
      '  - Findings:',
      '    - Controlled vocabulary found by the agent (1) — Potential problem:',
      '      - The reviewed source indicates a possible problem. Confirm its impact before making a decision.',
      '      - Finding: Departments need a value.',
      '      - Sources:',
      `        - ${LOADER}`,
      '      - Coverage judgment: Investigated directly',
      '  - What to verify:',
      '    - Decide whether block reasons need shipped values.',
      '      - Sources:',
      `        - ${TEMPLATE}`,
      '  - Dropped from this review:',
      '    - A result for B008-C1#9: It answers nothing the agent was asked to check.',
      '  - Sources:',
      `    - ${TEMPLATE}`,
      '  - Advisory only; the criterion status is unchanged.'
    ]);
  });
});
