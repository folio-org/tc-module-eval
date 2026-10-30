import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B011Analysis, CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus } from '../types';
import { buildB011AgentReviewRequest } from '../utils/b011-agent-review';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { pom, repository, restVerticleBuild } from './helpers/backend-repository';

const DB = 'src/main/resources/templates/db_scripts';
const MIGRATE = `${DB}/migrate.sql`;
const SERVICE = 'src/main/java/org/example/SettingsService.java';

function module(java = 'class SettingsService {}\n'): string {
  return repository({
    'pom.xml': pom('mod-example', restVerticleBuild),
    'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: '${artifactId}-1.0.0', provides: [] }),
    [`${DB}/schema.json`]: JSON.stringify({ scripts: [{ run: 'after', snippetPath: 'migrate.sql', fromModuleVersion: '17.5.0' }] }),
    [MIGRATE]: [
      'DO $$ BEGIN',
      "  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = '${myuniversity}_mod_configuration') THEN",
      '    INSERT INTO ${myuniversity}_${mymodule}.settings SELECT * FROM ${myuniversity}_mod_configuration.config_data;',
      '  END IF;',
      'END $$;',
      'SELECT * FROM ${myuniversity}_mod_settings.settings;'
    ].join('\n'),
    [SERVICE]: java,
    'src/test/java/org/example/SettingsServiceTest.java': 'class SettingsServiceTest { String s = "%s_mod_users"; }\n'
  });
}

const configuration = (fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
  technologyId: 'B011-C1#1', type: 'aligned_fact', summary: 'A one-time copy guarded by IF EXISTS; it runs only before 17.5.0.',
  evidenceReferences: [MIGRATE, `${DB}/schema.json`], coverageDisposition: 'investigated', ...fields
});
const settings = (fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
  technologyId: 'B011-C1#2', type: 'substantive_concern', summary: 'Fails when mod-settings is absent: no guard.',
  evidenceReferences: [MIGRATE], coverageDisposition: 'investigated', ...fields
});
const action = { action: 'Decide whether the unguarded mod-settings copy is acceptable.', evidenceReferences: [MIGRATE] };

function fakeConfig(fields: Record<string, unknown>, enabledCriteria: string[] | undefined = ['B011']): CriterionAgentReviewConfig {
  return { enabled: true, ...(enabledCriteria ? { enabledCriteria } : {}), adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
    available: true, criterionId: 'B011', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
    summary: 'One migration copy is unguarded.', rationale: 'Read migrate.sql and schema.json.', evidenceReferences: [MIGRATE],
    warnings: [], errors: [], ...fields
  } as CriterionAgentReviewConfig['fakeResult'] };
}

async function evaluateWith(root: string, config?: CriterionAgentReviewConfig) {
  const result = await new BackendEvaluator().evaluateCriterion('B011', root, createEvaluationRun({ repositoryPath: root, language: 'java', ...(config ? { agentReview: config } : {}) }));
  return { result, analysis: result.criterionDetails as B011Analysis };
}

function rowsFrom(details: string | undefined, heading: string): string[] {
  const lines = (details ?? '').split('\n');
  return lines.slice(lines.indexOf(heading));
}

describe('B011 agent review', () => {
  it('gives the agent the references to classify and lets it browse sources and db_scripts, without tests', async () => {
    const root = module();
    const { analysis } = await evaluateWith(root);
    const request = buildB011AgentReviewRequest(root, analysis);
    const prepared = (await prepareCriterionAgentReviewEvidence(request)).request;
    const paths = prepared.files.map(file => file.repoRelativePath);

    expect(request.defaultTimeoutMs).toBe(600_000);
    expect(paths).toEqual(expect.arrayContaining([MIGRATE, `${DB}/schema.json`, SERVICE, 'pom.xml']));
    expect(paths).not.toContain('src/test/java/org/example/SettingsServiceTest.java');
    const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/B011/checklist.json')!.content);
    expect(checklist.items.flatMap((item: any) => item.obligations)).toEqual([
      { id: 'B011-C1#1', subject: `${MIGRATE}: \${myuniversity}_mod_configuration`, path: MIGRATE, line: 2, flag: 'manual' },
      { id: 'B011-C1#2', subject: `${MIGRATE}: \${myuniversity}_mod_settings.settings`, path: MIGRATE, line: 6, flag: 'manual' }
    ]);
    expect(prepared.instructions).toContain('The module\'s own schema is <tenant>_mod_example; references to it are not listed.');
  });

  it('attaches an accepted review to the checklist, keeps a discovered reference in its own section and leaves the status unchanged', async () => {
    const { result } = await evaluateWith(module(), fakeConfig({
      assessments: [configuration(), settings(), { technologyId: 'discovered:schema:1', type: 'substantive_concern',
        summary: 'Sets search_path to the mod-users schema.', evidenceReferences: [SERVICE], coverageDisposition: 'investigated' }],
      reviewerActions: [action]
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(rowsFrom(result.details, 'Checklist for the reviewer:').slice(0, 16)).toEqual([
      'Checklist for the reviewer:',
      '  - B011-C1 Each reference to another module\'s database schema is unreachable, part of FQM, or an accepted one-time migration.',
      '    - Start with:',
      `      - ${MIGRATE}:2 — \${myuniversity}_mod_configuration at lines 2 and 3: an RMB script that runs on a tenant's first install and on upgrades from versions before 17.5.0`,
      `      - ${MIGRATE}:6 — \${myuniversity}_mod_settings.settings at line 6: an RMB script that runs on a tenant's first install and on upgrades from versions before 17.5.0`,
      `    - Agent: Supported by evidence — ${MIGRATE}: \${myuniversity}_mod_configuration: A one-time copy guarded by IF EXISTS; it runs only before 17.5.0.`,
      '      - Sources:',
      `        - ${MIGRATE}`,
      `        - ${DB}/schema.json`,
      '      - Coverage judgment: Investigated directly',
      `    - Agent: Potential problem — ${MIGRATE}: \${myuniversity}_mod_settings.settings: Fails when mod-settings is absent: no guard.`,
      '      - Sources:',
      `        - ${MIGRATE}`,
      '      - Coverage judgment: Investigated directly',
      'Agent review (advisory):',
      '  - Recommendation: Reviewer judgment needed'
    ]);
    expect(result.details).toContain(['    - Schema reference found by the agent (1) — Potential problem:',
      '      - The reviewed source indicates a possible problem. Confirm its impact before making a decision.',
      '      - Finding: Sets search_path to the mod-users schema.',
      '      - Sources:',
      `        - ${SERVICE}`].join('\n'));
    expect(result.details).toContain('  - Advisory only; the criterion status is unchanged.');
  });

  it('drops an invalid result on its own and keeps the rest of the review', async () => {
    const { result } = await evaluateWith(module(), fakeConfig({ assessments: [configuration({ evidenceReferences: [`${DB}/schema.json`] }), settings()], reviewerActions: [action] }));

    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.assessments).toEqual([settings()]);
    expect(result.details).toContain(`    - Agent result dropped — ${MIGRATE}: \${myuniversity}_mod_configuration: It is marked as investigated directly but does not cite the file it is about.`);
  });

  it('shows why a rejected review was not applied', async () => {
    const { result } = await evaluateWith(module(), fakeConfig({ evidenceReferences: ['.criterion-agent/B011/checklist.json'], assessments: [configuration(), settings()], reviewerActions: [action] }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(false);
    expect(rowsFrom(result.details, 'Agent review:')).toEqual([
      'Agent review:',
      '  - Not applied: Agent review requires repository evidence for the review and every assessment and action; generated context alone is not evidence.'
    ]);
  });

  it('runs by default when agent review is enabled without a criteria list (Q6)', async () => {
    const { result } = await evaluateWith(module(), fakeConfig({ assessments: [configuration(), settings()], reviewerActions: [action] }, undefined));
    expect(result.agentReview?.available).toBe(true);
  });

  it('does not run for a fail and says why', async () => {
    const { result } = await evaluateWith(module('class SettingsService { String sql = String.format("SELECT * FROM %s_mod_users.users", tenantId); }\n'),
      fakeConfig({ assessments: [configuration(), settings()], reviewerActions: [action] }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.agentReview).toBeUndefined();
    expect(rowsFrom(result.details, 'Agent review:')).toEqual([
      'Agent review:',
      '  - Not applied: agent review runs only for manual results; the reviewer confirms each reference in code or in an every-install script (B011-C1)'
    ]);
  });
});
