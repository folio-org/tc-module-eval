import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import {
  B004Analysis,
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  CriterionAgentAssessment,
  CriterionAgentReviewConfig,
  EvaluationStatus
} from '../types';
import { buildB004AgentReviewRequest, reviewB004WithAgent } from '../utils/b004-agent-review';
import { evaluateB004, loadB004Policy } from '../utils/b004-env-variables';
import { getBackendEvidence } from '../utils/backend-evidence';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { pom, repository, restVerticleBuild } from './helpers/backend-repository';

const TEMPLATE = 'descriptors/ModuleDescriptor-template.json';
const STARTUP = 'src/main/java/org/folio/example/Startup.java';

function module(extra: Record<string, string> = {}): string {
  return repository({
    'pom.xml': pom('mod-example', restVerticleBuild),
    [TEMPLATE]: JSON.stringify({ id: 'mod-example-1.0.0', env: [{ name: 'DB_HOST' }, { name: 'DB_PORT', value: '5432' }], launchDescriptor: { env: [] } }, null, 2),
    'ENV_VARS.md': '| Name | Default | Required | Description |\n|---|---|---|---|\n| DB_HOST | | yes | Host |\n| DB_PORT | 5432 | no | Port |\n',
    [STARTUP]: [
      'class Startup {',
      '  void start(String key) {',
      '    String password = System.getenv(key);',
      '    log.info("Connecting with {}", password);',
      '  }',
      '}'
    ].join('\n'),
    'src/test/java/org/folio/example/StartupTest.java': 'class StartupTest {}',
    ...extra
  });
}

const assessment = (technologyId: string, path: string, fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
  technologyId, type: 'substantive_concern', summary: 'Checked.', evidenceReferences: [path], coverageDisposition: 'investigated', ...fields
});
const action = { action: 'Decide whether the key read is required.', evidenceReferences: [STARTUP] };

function fakeConfig(fields: Record<string, unknown>, enabledCriteria: string[] | undefined = ['B004']): CriterionAgentReviewConfig {
  return { enabled: true, ...(enabledCriteria ? { enabledCriteria } : {}), adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
    available: true, criterionId: 'B004', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
    summary: 'DB_HOST does not fail fast.', rationale: 'Read Startup.java.', evidenceReferences: [STARTUP], warnings: [], errors: [], ...fields
  } as CriterionAgentReviewConfig['fakeResult'] };
}

async function evaluateWith(root: string, config?: CriterionAgentReviewConfig, existingModule = false) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java', existingModule, ...(config ? { agentReview: config } : {}) });
  const result = await new BackendEvaluator().evaluateCriterion('B004', root, run);
  return { result, rows: result.details?.split('\n') ?? [] };
}

async function analyze(root: string): Promise<B004Analysis> {
  return evaluateB004(await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root), false, loadB004Policy());
}

const checklistRows = (rows: string[]) => rows.slice(rows.indexOf('Checklist for the reviewer:'), rows.indexOf('Agent review (advisory):'));

describe('B004 agent review', () => {
  it('gives the agent one obligation per read, variable and log statement, the policy and the backend browse scope', async () => {
    const root = module();
    const analysis = await analyze(root);
    const prepared = (await prepareCriterionAgentReviewEvidence(buildB004AgentReviewRequest(root, analysis, loadB004Policy()))).request;
    const paths = prepared.files.map(file => file.repoRelativePath);
    const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/B004/checklist.json')!.content);

    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    expect(checklist.items.map((item: any) => [item.id, item.obligations])).toEqual([
      ['B004-C1', [{ id: 'B004-C1#1', subject: `System.getenv read at ${STARTUP}:3`, path: STARTUP, line: 3, flag: 'manual' }]],
      ['B004-C4', [{ id: 'B004-C4#1', subject: 'DB_HOST', path: TEMPLATE, line: 4, flag: 'manual' }]],
      ['B004-C5', [{ id: 'B004-C5#1', subject: `log statement at ${STARTUP}:4`, path: STARTUP, line: 4, flag: 'manual' }]]
    ]);
    expect(paths).toEqual(expect.arrayContaining([STARTUP, TEMPLATE, 'ENV_VARS.md', 'pom.xml', '.criterion-agent/B004/environment-variables-policy.md']));
    expect(paths).not.toContain('src/test/java/org/folio/example/StartupTest.java');
    expect(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/B004/environment-variables-policy.md')!.content).toBe(loadB004Policy().text);
    expect(prepared.instructions).toContain('Report an environment variable the module reads that evidence-summary.json does not list under variables as discovered:env:<n>, citing the source that reads it.');
  });

  it('runs by default, attaches the results to the checklist, names a discovered variable, and leaves the status unchanged', async () => {
    const { result, rows } = await evaluateWith(module(), fakeConfig({
      assessments: [
        assessment('B004-C1#1', STARTUP, { type: 'evidence_gap', coverageDisposition: 'unresolved', summary: 'key comes from callers outside the scope.' }),
        assessment('B004-C4#1', TEMPLATE, { summary: 'Startup continues without DB_HOST.', evidenceReferences: [TEMPLATE, STARTUP] }),
        assessment('B004-C5#1', STARTUP, { summary: 'The password is logged.' }),
        assessment('discovered:env:1', STARTUP, { summary: 'TENANT_ID is read through a helper.' })
      ],
      reviewerActions: [action]
    }, undefined));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(checklistRows(rows)).toEqual([
      'Checklist for the reviewer:',
      '  - B004-C1 Every environment variable the module uses is documented in ENV_VARS.md or a README table with a default, whether it is required, and a description, and the descriptor template lists it in a top-level env.',
      '    - Start with:',
      `      - ${STARTUP}:3 — System.getenv read whose name the tool could not read`,
      `    - Agent: Needs verification — System.getenv read at ${STARTUP}:3: key comes from callers outside the scope.`,
      '      - Sources:',
      `        - ${STARTUP}`,
      '      - Coverage judgment: Needs further verification',
      '  - B004-C4 Each required variable stops startup with a clear message when it is missing or empty.',
      '    - Start with:',
      `      - ${TEMPLATE}:4 — DB_HOST: documented as required; no fail-fast evidence found`,
      '    - Agent: Potential problem — DB_HOST: Startup continues without DB_HOST.',
      '      - Sources:',
      `        - ${TEMPLATE}`,
      `        - ${STARTUP}`,
      '      - Coverage judgment: Investigated directly',
      '  - B004-C5 Startup logs show the configuration without printing secret values or the whole environment.',
      '    - Start with:',
      `      - ${STARTUP}:4 — may print a secret-like value (password)`,
      '    - Agent: Potential problem — log statement at src/main/java/org/folio/example/Startup.java:4: The password is logged.',
      '      - Sources:',
      `        - ${STARTUP}`,
      '      - Coverage judgment: Investigated directly'
    ]);
    expect(rows).toContain('    - Environment variable found by the agent (1) — Potential problem:');
    expect(rows).toContain('  - Advisory only; the criterion status is unchanged.');
  });

  it('drops an assessment that does not cite its subject\'s file on its own', async () => {
    const { result, rows } = await evaluateWith(module(), fakeConfig({
      assessments: [
        assessment('B004-C1#1', STARTUP, { type: 'evidence_gap', coverageDisposition: 'unresolved' }),
        assessment('B004-C4#1', STARTUP),
        assessment('B004-C5#1', STARTUP)
      ],
      reviewerActions: [action]
    }));

    expect(result.agentReview?.available).toBe(true);
    expect(rows).toContain('    - Agent result dropped — DB_HOST: It is marked as investigated directly but does not cite the file it is about.');
  });

  it('does not run for a fail and says why', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      [TEMPLATE]: JSON.stringify({ id: 'mod-example-1.0.0', launchDescriptor: { env: [{ name: 'AWS_URL' }] } })
    });
    const { result, rows } = await evaluateWith(root, fakeConfig({ assessments: [], reviewerActions: [] }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.agentReview).toBeUndefined();
    expect(rows.slice(-2)).toEqual(['Agent review:', '  - Not applied: agent review runs only for manual results; the failures above are what the tool found on its own']);
  });

  it('times each OpenCode command out after the backend default of 600 s', async () => {
    const root = module();
    const runner = new TimedOutRunner();
    const review = await reviewB004WithAgent(root, await analyze(root), loadB004Policy(), {
      enabled: true, adapter: 'opencode', modelLabel: 'test-model', readOnlyAgentName: 'reviewer',
      endpoint: 'https://api.example.test', endpointFamily: 'openai-compatible'
    }, runner);

    expect(review.available).toBe(false);
    expect(runner.timeouts).toEqual([600_000]);
  });
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
