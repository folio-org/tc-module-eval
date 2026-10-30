import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  CriterionAgentReviewConfig,
  EvaluationStatus,
  FrontendChecklist
} from '../types';
import { backendBrowse, buildBackendAgentReviewRequest, numberBackendObligations, providedInterfaceSubjects } from '../utils/backend-agent-review';
import { getBackendEvidence, templateLineOf } from '../utils/backend-evidence';
import { prepareCriterionAgentReviewEvidence, reviewCriterionWithAgent, runCriterionAgentReview } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { FrontendChecklistItemDraft } from '../utils/frontend-agent-review';
import { pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

const TEMPLATE = [
  '{',
  '  "id": "${artifactId}-1.0.0",',
  '  "provides": [',
  '    { "id": "_tenant", "version": "2.0", "interfaceType": "system", "handlers": [] },',
  '    {',
  '      "id": "users",',
  '      "version": "16.4",',
  '      "handlers": [{ "methods": ["GET"], "pathPattern": "/users", "permissionsRequired": ["users.collection.get"] }]',
  '    },',
  '    {',
  '      "id": "users-settings", "version": "1.0", "handlers": []',
  '    }',
  '  ],',
  '  "a/b~c": { "x": 1 }',
  '}'
].join('\n');

function module(files: Record<string, string> = {}): string {
  return repository({ 'pom.xml': pom('mod-users', restVerticleBuild), 'descriptors/ModuleDescriptor-template.json': TEMPLATE, ...files });
}

async function evidence(root: string) {
  return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
}

describe('backend agent review contract', () => {
  it('makes one subject per non-system interface, at the line where the interface starts', async () => {
    const { template } = await evidence(module());

    expect(providedInterfaceSubjects(template!)).toEqual([
      { interfaceId: 'users', index: 1, subject: 'interface users (#/provides/1)', path: 'descriptors/ModuleDescriptor-template.json', line: 5 },
      { interfaceId: 'users-settings', index: 2, subject: 'interface users-settings (#/provides/2)', path: 'descriptors/ModuleDescriptor-template.json', line: 10 }
    ]);
    const lineOf = templateLineOf(template);
    expect([lineOf('/provides/1/handlers/0'), lineOf('/provides/1/handlers/0/permissionsRequired/0'), lineOf('/a~1b~0c/x'), lineOf('/provides/9'), lineOf('/provides/x')])
      .toEqual([8, 8, 14, undefined, undefined]);
  });

  it('finds lines in linear time', async () => {
    const template = (size: number) => {
      const content = JSON.stringify({ id: 'mod-users-1.0.0', provides: Array.from({ length: size }, (_, index) => ({
        id: `interface-${index}`, version: '1.0', handlers: [{ methods: ['GET'], pathPattern: `/path-${index}`, permissionsRequired: [`p.${index}.get`] }]
      })) }, null, 2);
      return { path: 'descriptors/ModuleDescriptor-template.json', content, descriptor: JSON.parse(content), placeholders: [] };
    };
    const subjects = await expectLinearTime(2_000, template, async input => providedInterfaceSubjects(input));
    expect(subjects).toHaveLength(8_000);
    expect(subjects[7_999].line).toBe(template(8_000).content.split('\n').indexOf('      "id": "interface-7999",'));
  });

  it('finds lines in linear time after many keys, and takes the last of duplicate keys, as JSON.parse does', async () => {
    const template = (size: number) => {
      const keys = Array.from({ length: size }, (_, index) => `"k${index}": ${index}`).join(',\n');
      const interfaces = Array.from({ length: size }, (_, index) => `{"id": "i${index}", "handlers": []}`).join(',\n');
      const content = `{\n"provides": [],\n${keys},\n"provides": [\n${interfaces}\n]\n}`;
      return { path: 'descriptors/ModuleDescriptor-template.json', content, descriptor: JSON.parse(content), placeholders: [] };
    };
    const subjects = await expectLinearTime(5_000, template, async input => providedInterfaceSubjects(input));
    expect(subjects.map(subject => subject.line)).toEqual(Array.from({ length: 20_000 }, (_, index) => 20_004 + index));
  });

  it('gives flagged subjects first (failing, then manual), then the rest by path and line, then whole items, up to 25', () => {
    const item = (id: string, subjects: FrontendChecklistItemDraft['subjects']): FrontendChecklistItemDraft =>
      ({ id, title: id, startingPoints: [], reviewerOnly: false, obligations: [], subjects });
    const many = Array.from({ length: 22 }, (_, index) => ({ subject: `s${index}`, path: 'b.json', line: 100 - index }));
    const items = numberBackendObligations([
      item('B999-C1', [{ subject: 'late', path: 'b.json', line: 200 }, ...many]),
      item('B999-C2', [{ subject: 'flagged manual', path: 'z.json', line: 1, flag: 'manual' }, { subject: 'early path', path: 'a.json', line: 500 }]),
      item('B999-C3', [{ subject: 'flagged fail', path: 'z.json', line: 9, flag: 'fail' }]),
      item('B999-C4', [])
    ]);
    const given = items.flatMap(entry => entry.obligations).filter(obligation => !obligation.withheld);

    expect(given).toHaveLength(25);
    expect(items.flatMap(entry => entry.obligations).filter(obligation => obligation.withheld).map(obligation => obligation.subject ?? obligation.id))
      .toEqual(['late', 'B999-C4#1']);
    expect(items[1].obligations[0]).toEqual({ id: 'B999-C2#1', subject: 'flagged manual', path: 'z.json', line: 1, flag: 'manual' });
  });

  it('gives subjects the tool failed before those it left to the reviewer', () => {
    const items = numberBackendObligations([
      { id: 'B999-C1', title: 'C1', startingPoints: [], reviewerOnly: false, obligations: [],
        subjects: Array.from({ length: 25 }, (_, index) => ({ subject: `manual ${index}`, path: 'a.json', line: index + 1, flag: 'manual' as const })) },
      { id: 'B999-C2', title: 'C2', startingPoints: [], reviewerOnly: false, obligations: [], subjects: [{ subject: 'fail', path: 'z.json', line: 99, flag: 'fail' }] }
    ]);
    expect(items.flatMap(entry => entry.obligations).filter(obligation => obligation.withheld).map(obligation => obligation.subject)).toEqual(['manual 24']);
  });

  it('browses backend production source, the descriptor and build files, and the criterion\'s own paths', () => {
    const paths = [
      'src/main/java/org/folio/Users.java', 'mod-x-server/src/main/kotlin/A.kt', 'service/src/main/groovy/B.groovy',
      'src/main/resources/application.yml', 'service/grails-app/controllers/C.groovy', 'ramls/users.raml', 'descriptors/ModuleDescriptor-template.json',
      'service/src/main/okapi/ModuleDescriptor-template.json', 'pom.xml', 'service/build.gradle', 'README.md', 'ENV_VARS.md', 'Dockerfile', 'docker-compose.yml',
      'src/test/java/UsersTest.java', 'src/main/resources/ref-data/groups/a.json', 'src/main/resources/sample-data/b.json', 'ramls/raml-util/traits.raml',
      'reference-data/c.json', 'docs/guide.md', 'target/generated-sources/D.java', 'src/main/webapp/x.html', 'module/README.md', 'templates/db_scripts/schema.json'
    ];
    const browse = backendBrowse();
    const own = backendBrowse({ include: path => path.startsWith('templates/db_scripts/'), scope: 'templates/db_scripts/' });

    expect(paths.filter(browse.include)).toEqual(paths.slice(0, 14));
    expect(paths.filter(own.include)).toEqual([...paths.slice(0, 14), 'templates/db_scripts/schema.json']);
    expect(own.scope).toBe(`${browse.scope}, templates/db_scripts/`);
  });

  it('matches browse paths in linear time', async () => {
    const browse = backendBrowse();
    const count = await expectLinearTime(20_000, size => [`${'src/main/'.repeat(size)}java/x.java`, `${'a/'.repeat(size)}ModuleDescriptor${'-'.repeat(size)}`,
      `README${'/'.repeat(size)}`, `${'ref-data'.repeat(size)}/src/main/java/A.java`], async paths => paths.filter(browse.include).length);
    expect(count).toBe(2);
  });

  describe('which criteria review (Q6, Q16)', () => {
    const outcome = async (criterionId: string, enabledCriteria?: string[]) => {
      const run = createEvaluationRun({ repositoryPath: '/nonexistent', language: 'java', agentReview: { enabled: true, adapter: 'fake', ...(enabledCriteria ? { enabledCriteria } : {}) } });
      const ran: string[] = [];
      const result = await reviewCriterionWithAgent({ criterionId, status: EvaluationStatus.MANUAL, hasReviewMaterial: true, evaluationRun: run,
        review: async () => { ran.push(criterionId); return { available: true, criterionId, evidenceReferences: ['pom.xml'], warnings: [], errors: [] }; } });
      return ran.length ? 'ran' : result.unavailableReason;
    };

    it.each([
      ['B007', undefined, 'ran'],
      ['B004', undefined, 'ran'],
      ['S004', undefined, 'ran'],
      ['B002', undefined, 'agent review for B002 runs only when listed in --criterion-agent-criteria'],
      ['B008', undefined, 'agent review for B008 runs only when listed in --criterion-agent-criteria'],
      ['B012', undefined, 'agent review for B012 runs only when listed in --criterion-agent-criteria'],
      ['B002', ['B002'], 'ran'],
      ['B012', ['B007', 'B012'], 'ran'],
      ['B007', ['B002'], 'agent review is not enabled for B007'],
      ['S004', ['B002'], 'agent review is not enabled for S004'],
      ['B008', ['B002'], 'agent review is not enabled for B008']
    ] as const)('%s with the list %j: %s', async (criterionId, list, expected) => {
      expect(await outcome(criterionId, list ? [...list] : undefined)).toBe(expected);
    });
  });

  describe('request', () => {
    const checklist: FrontendChecklist = { items: [{ id: 'B999-C1', title: 'Each interface holds.', startingPoints: [], reviewerOnly: false,
      obligations: [{ id: 'B999-C1#1', subject: 'interface users (#/provides/1)', path: 'descriptors/ModuleDescriptor-template.json', line: 5, flag: 'manual' }] }] };
    const request = (root: string) => buildBackendAgentReviewRequest({
      criterionId: 'B999', repositoryPath: root, criterionTitle: 'B999: a test criterion', checklist, evidenceSummary: () => ({ criterionId: 'B999' }),
      criterionInstructions: ['B999-C1: check it.'], discoveredKinds: [], browse: backendBrowse()
    });

    it('states the backend scope and the flags, and offers only the backend scope to browse', async () => {
      const root = module({ 'src/main/java/org/folio/Users.java': 'class Users {}', 'src/test/java/UsersTest.java': 'class UsersTest {}' });
      const prepared = await prepareCriterionAgentReviewEvidence(request(root));

      expect([...prepared.availableSourcePaths].sort()).toEqual(['descriptors/ModuleDescriptor-template.json', 'pom.xml', 'src/main/java/org/folio/Users.java']);
      expect(prepared.request.instructions).toContain(`You may browse only: ${backendBrowse().scope}.`);
      expect(prepared.request.instructions).toContain('An obligation\'s flag is what the tool decided for its subject on its own');
      const shape = JSON.parse(prepared.request.files.find(file => file.repoRelativePath === '.criterion-agent/B999/response-shape.json')!.content);
      expect(shape.response.evidenceReferences).toEqual(['src/main/java/org/folio/actual/SourceFile.java']);
      expect(shape.response.assessments[0].evidenceReferences).toEqual(['descriptors/ModuleDescriptor-template.json']);
    });

    it.each([
      [undefined, 600_000],
      [90_000, 90_000]
    ])('times each OpenCode command out after 600 s unless a timeout is given (%s)', async (timeoutMs, expected) => {
      const runner = new TimedOutRunner();
      const config: CriterionAgentReviewConfig = { enabled: true, adapter: 'opencode', modelLabel: 'test-model', readOnlyAgentName: 'reviewer',
        endpoint: 'https://api.example.test', endpointFamily: 'openai-compatible', ...(timeoutMs ? { timeoutMs } : {}) };
      const review = await runCriterionAgentReview(request(module()), config, runner);
      expect(review.available).toBe(false);
      expect(runner.timeouts).toEqual([expected]);
    });

    it('drops an invalid assessment on its own and keeps the rest of the review', async () => {
      const assessment = { technologyId: 'B999-C1#1', type: 'aligned_fact', summary: 'Holds.', evidenceReferences: ['descriptors/ModuleDescriptor-template.json'], coverageDisposition: 'investigated' };
      const review = await runCriterionAgentReview(request(module()), { enabled: true, adapter: 'fake', fakeResult: {
        available: true, criterionId: 'B999', recommendation: 'likely_sufficient', confidence: 'high', summary: 'Holds.', rationale: 'Read the template.',
        evidenceReferences: ['pom.xml'], warnings: [], errors: [],
        assessments: [assessment, { ...assessment, technologyId: 'B999-C9#1' }], reviewerActions: []
      } as CriterionAgentReviewConfig['fakeResult'] });

      expect(review.available).toBe(true);
      expect(review.assessments).toEqual([assessment]);
      expect(review.droppedItems).toEqual([{ kind: 'assessment', technologyId: 'B999-C9#1', reason: 'It answers nothing the agent was asked to check.' }]);
      expect(review.replacedRecommendation).toEqual({ recommendation: 'likely_sufficient', reason: 'some of its results were dropped' });
    });
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
