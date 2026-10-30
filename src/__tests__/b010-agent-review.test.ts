import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import {
  B010Analysis,
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  CriterionAgentAssessment,
  CriterionAgentReviewConfig,
  EvaluationStatus
} from '../types';
import { buildB010AgentReviewRequest, reviewB010WithAgent } from '../utils/b010-agent-review';
import { evaluateB010 } from '../utils/b010-tenant-segregation';
import { getBackendEvidence } from '../utils/backend-evidence';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { pom, repository, restVerticleBuild } from './helpers/backend-repository';

const ITEMS_API = 'src/main/java/org/folio/rest/impl/ItemsApi.java';
const SETTINGS_SQL = 'templates/db_scripts/settings.sql';
const SCHEMA = 'src/main/resources/templates/db_scripts/schema.json';

const rmbModule = () => repository({
  'pom.xml': pom('mod-example', restVerticleBuild),
  'descriptors/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0", "provides": []}',
  [SCHEMA]: '{"tables": []}',
  [SETTINGS_SQL]: 'CREATE TABLE IF NOT EXISTS public.shared_settings (id uuid);\n',
  [ITEMS_API]: [
    'class ItemsApi {',
    '  void a(Context vertxContext, String tenantId) {',
    '    PostgresClient.getInstance(vertxContext.owner(), tenantId).save("items", item, handler);',
    '    PostgresClient.getInstance(vertx).execute("SELECT 1", handler);',
    '  }',
    '}'
  ].join('\n'),
  'src/test/java/org/folio/rest/impl/ItemsApiTest.java': 'class ItemsApiTest {}',
  'reference-data/items/item.json': '{}'
});

const assessment = (technologyId: string, fields: Partial<CriterionAgentAssessment>): CriterionAgentAssessment => ({
  technologyId, type: 'aligned_fact', summary: 'Holds.', evidenceReferences: [], coverageDisposition: 'investigated', ...fields
});
const tables = assessment('B010-C1#1', { summary: 'Every table in schema.json is created in the tenant schema.', evidenceReferences: [SCHEMA] });
const sharedClient = assessment('B010-C2#1', { type: 'substantive_concern', summary: 'The public-schema client writes outbox rows for every tenant.', evidenceReferences: [ITEMS_API] });
const publicTable = assessment('B010-C2#2', { type: 'analyzer_limitation', summary: 'The table holds only module-wide settings.', evidenceReferences: [SETTINGS_SQL] });
const caches = assessment('B010-C3#1', { coverageDisposition: 'immaterial', summary: 'The module has no caches or local files.', evidenceReferences: ['pom.xml'] });
const action = { action: 'Confirm whether the outbox rows in public carry tenant data.', evidenceReferences: [ITEMS_API] };

describe('B010 agent review', () => {
  it('browses production source and db_scripts, and gives the flagged files first', async () => {
    const root = rmbModule();
    const analysis = evaluateB010(await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root));
    const prepared = (await prepareCriterionAgentReviewEvidence(buildB010AgentReviewRequest(root, analysis))).request;
    const paths = prepared.files.map(file => file.repoRelativePath);

    expect(paths).toEqual(expect.arrayContaining([ITEMS_API, SETTINGS_SQL, SCHEMA, 'pom.xml']));
    expect(paths.filter(file => file.startsWith('src/test/') || file.startsWith('reference-data/'))).toEqual([]);
    const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/B010/checklist.json')!.content);
    expect(checklist.items.map((item: any) => [item.id, item.obligations])).toEqual([
      ['B010-C1', [{ id: 'B010-C1#1' }]],
      ['B010-C2', [
        { id: 'B010-C2#1', subject: ITEMS_API, path: ITEMS_API, line: 4, flag: 'manual' },
        { id: 'B010-C2#2', subject: SETTINGS_SQL, path: SETTINGS_SQL, line: 1, flag: 'manual' }
      ]],
      ['B010-C3', [{ id: 'B010-C3#1' }]]
    ]);
    expect(prepared.instructions).toContain('templates/db_scripts/ in any module folder, and every file the checklist lists.');
    expect(prepared.defaultTimeoutMs).toBe(600_000);
  });

  it('runs by default for a manual result and attaches the results to the checklist items, leaving the status unchanged', async () => {
    const config = fakeConfig({ assessments: [tables, sharedClient, publicTable, caches], reviewerActions: [action] });
    delete config.enabledCriteria;
    const result = await evaluateWith(config);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.recommendation).toBe('needs_reviewer_judgment');
    expect(checklistLines(result.details)).toEqual([
      'Checklist for the reviewer:',
      '  - B010-C1 Every table the module writes is in a per-tenant schema.',
      '    - Start with:',
      `      - ${SCHEMA} — RMB database schema; RMB creates these tables in each tenant's own schema`,
      `      - ${ITEMS_API}:3 — PostgresClient.getInstance with a tenant id: 1 call in 1 file`,
      '    - Agent: Supported by evidence — Every table in schema.json is created in the tenant schema.',
      '      - Sources:',
      `        - ${SCHEMA}`,
      '      - Coverage judgment: Investigated directly',
      '  - B010-C2 Each place listed stores no tenant data in a schema, table or connection that tenants share.',
      '    - Start with:',
      `      - ${ITEMS_API}:4 — PostgresClient.getInstance(vertx) has no tenant id, so RMB connects it to the shared public schema`,
      `      - ${SETTINGS_SQL}:1 — CREATE TABLE IF NOT EXISTS public.shared_settings is in the public schema, which all tenants share`,
      `    - Agent: Potential problem — ${ITEMS_API}: The public-schema client writes outbox rows for every tenant.`,
      '      - Sources:',
      `        - ${ITEMS_API}`,
      '      - Coverage judgment: Investigated directly',
      `    - Agent: Automated check limitation — ${SETTINGS_SQL}: The table holds only module-wide settings.`,
      '      - Sources:',
      `        - ${SETTINGS_SQL}`,
      '      - Coverage judgment: Investigated directly',
      '  - B010-C3 Caches and files that hold tenant data are keyed by tenant.',
      '    - Agent: Supported by evidence — The module has no caches or local files.',
      '      - Sources:',
      '        - pom.xml',
      '      - Coverage judgment: Not material to this scoped decision'
    ]);
    expect(result.details).toContain('  - Advisory only; the criterion status is unchanged.');
  });

  it('drops a result that does not cite its file on its own and keeps the rest', async () => {
    const result = await evaluateWith(fakeConfig({
      assessments: [tables, { ...sharedClient, evidenceReferences: [SCHEMA] }, publicTable, caches], reviewerActions: [action]
    }));

    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.assessments?.map(kept => kept.technologyId)).toEqual(['B010-C1#1', 'B010-C2#2', 'B010-C3#1']);
    expect(result.details).toContain(`    - Agent result dropped — ${ITEMS_API}: It is marked as investigated directly but does not cite the file it is about.`);
  });

  it('does not review a repository without storage', async () => {
    const root = repository({ 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0"}' });
    const result = await evaluateWith(fakeConfig({ assessments: [tables], reviewerActions: [action] }), root);

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.agentReview).toBeUndefined();
    expect((result.criterionDetails as B010Analysis).agentReviewUnavailableReason).toBeUndefined();
    expect(result.details).toBe('Storage: none found');
  });

  it.each([
    [undefined, 600_000],
    [90_000, 90_000]
  ])('times each OpenCode command out after the backend default unless a timeout is given (%s)', async (timeoutMs, expected) => {
    const root = rmbModule();
    const analysis = evaluateB010(await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root));
    const runner = new TimedOutRunner();
    const review = await reviewB010WithAgent(root, analysis, {
      enabled: true, adapter: 'opencode', modelLabel: 'test-model', readOnlyAgentName: 'reviewer',
      endpoint: 'https://api.example.test', endpointFamily: 'openai-compatible', ...(timeoutMs ? { timeoutMs } : {})
    }, runner);

    expect(review.available).toBe(false);
    expect(runner.timeouts).toEqual([expected]);
  });

  class TimedOutRunner implements CommandRunner {
    timeouts: Array<number | undefined> = [];
    normalize(request: CommandExecutionRequest): string {
      return JSON.stringify(request);
    }
    async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
      this.timeouts.push(request.timeoutMs);
      return { identity: '', command: request.command, args: request.args ?? [], cwd: request.cwd, commandExecutionEnvironment: 'local',
        localCommandsAllowed: false, status: 'timed_out', durationMs: 1, stdout: '', stderr: '', sanitized: true };
    }
  }

  function checklistLines(details: string | undefined): string[] {
    const lines = (details ?? '').split('\n');
    return lines.slice(lines.indexOf('Checklist for the reviewer:'), lines.indexOf('Agent review (advisory):'));
  }
  async function evaluateWith(config: CriterionAgentReviewConfig, root = rmbModule()) {
    return new BackendEvaluator().evaluateCriterion('B010', root, createEvaluationRun({ repositoryPath: root, language: 'java', agentReview: config }));
  }
  function fakeConfig(fields: Record<string, unknown>): CriterionAgentReviewConfig {
    return { enabled: true, enabledCriteria: ['B010'], adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
      available: true, criterionId: 'B010', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
      summary: 'One client uses the public schema.', rationale: 'Read ItemsApi.java and schema.json.', evidenceReferences: [ITEMS_API],
      warnings: [], errors: [], ...fields
    } as CriterionAgentReviewConfig['fakeResult'] };
  }
});
