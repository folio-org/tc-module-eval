import * as fs from 'fs';
import * as path from 'path';
import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B012Analysis, CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus } from '../types';
import { buildB012AgentReviewRequest } from '../utils/b012-agent-review';
import { evaluateB012 } from '../utils/b012-readme-dependencies';
import { getBackendEvidence } from '../utils/backend-evidence';
import { collectBackendInfrastructure } from '../utils/backend-infrastructure';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, git, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b012(root: string, agentReview?: CriterionAgentReviewConfig) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java', agentReview });
  const result = await new BackendEvaluator().evaluateCriterion('B012', root, run);
  return { result, analysis: result.criterionDetails as B012Analysis, rows: result.details?.split('\n') };
}

const TEMPLATE = { 'descriptors/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0"}' };

const rmbModule = (readme: Record<string, string>) => repository({
  'pom.xml': pom('mod-example', `${restVerticleBuild}<dependencies>${dependency('folio-kafka-wrapper')}${dependency('folio-s3-client')}</dependencies>`),
  ...TEMPLATE,
  'src/main/resources/templates/db_scripts/schema.json': '{}',
  ...readme
});

const edgeModule = (readme: string) => repository({
  'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}${dependency('ssm', 'software.amazon.awssdk')}${dependency('vault-java-driver', 'com.bettercloud')}</dependencies>`),
  'README.md': readme
});

const C1 = (readme = 'README.md') => [
  `  - B012-C1 Each external service the module calls, other than FOLIO interfaces and the infrastructure listed, is named in ${readme}.`,
  '    - Start with:',
  `      - ${readme} — the README`
];
const C3 = (readme = 'README.md') =>
  `  - B012-C3 Each infrastructure listed as not named or not checked, and any infrastructure in files the tool could not read, is named in ${readme} if the module uses it.`;
const C2 = (readme = 'README.md', kafka: string[] = []) => [
  `  - B012-C2 Each Kafka topic the module consumes from or produces for other modules is named in ${readme}.`,
  '    - Start with:',
  `      - ${readme} — the README`,
  ...kafka
];

describe('B012 dependencies declared in README', () => {
  it('fails when README.md does not name required infrastructure, counting only whole names', async () => {
    const { result, analysis, rows } = await b012(rmbModule({
      'README.md': '# mod-example\nObject storage (S3/minio) is optional. Data is saved with PostgresClient; the design is kafkaesque.\n'
    }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B012 fail: README.md does not name PostgreSQL or Apache Kafka, which the module uses '
      + '(RMB database schema src/main/resources/templates/db_scripts/schema.json; org.folio:folio-kafka-wrapper in pom.xml).');
    expect(rows).toEqual([
      'README: README.md',
      'Infrastructure the module uses (direct dependencies, configuration and storage):',
      '  - PostgreSQL (required) — not named',
      '    - RMB database schema src/main/resources/templates/db_scripts/schema.json',
      '  - Apache Kafka (required) — not named',
      '    - org.folio:folio-kafka-wrapper in pom.xml',
      '  - S3 object storage (required) — named as "S3"',
      '    - org.folio:folio-s3-client in pom.xml',
      'What to do:',
      '  - Name PostgreSQL and Apache Kafka in README.md, with what the module uses each for.',
      'Checklist for the reviewer:',
      ...C1(),
      ...C2('README.md', ['      - pom.xml — Apache Kafka: org.folio:folio-kafka-wrapper'])
    ]);
    expect(analysis.checklist.items.map(item => [item.id, item.reviewerOnly, item.obligations])).toEqual([
      ['B012-C1', false, [{ id: 'B012-C1#1' }]],
      ['B012-C2', false, [{ id: 'B012-C2#1' }]]
    ]);
  });

  it('reads README.MD case-insensitively, with synonyms, and still lists the reviewer items on a pass', async () => {
    const { result, rows } = await b012(rmbModule({ 'README.MD': '## Prerequisites\n- postgres 12\n- KAFKA 2.6\n- MinIO\n' }));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B012 pass: README.MD names every infrastructure the tool found: PostgreSQL (as "Postgres"), Apache Kafka (as "Kafka"), '
      + 'and S3 object storage (as "MinIO").');
    expect(rows).toEqual([
      'README: README.MD',
      'Infrastructure the module uses (direct dependencies, configuration and storage):',
      '  - PostgreSQL (required) — named as "Postgres"',
      '    - RMB database schema src/main/resources/templates/db_scripts/schema.json',
      '  - Apache Kafka (required) — named as "Kafka"',
      '    - org.folio:folio-kafka-wrapper in pom.xml',
      '  - S3 object storage (required) — named as "MinIO"',
      '    - org.folio:folio-s3-client in pom.xml',
      'Checklist for the reviewer:',
      ...C1('README.MD'),
      ...C2('README.MD', ['      - pom.xml — Apache Kafka: org.folio:folio-kafka-wrapper'])
    ]);
  });

  it('passes an edge module whose README names its secure stores as `AwsSsm` and `Vault`, and leaves an unnamed optional store to the reviewer', async () => {
    const named = await b012(edgeModule('| `secure_store` | `Ephemeral` | Valid: `Ephemeral`, `AwsSsm`, `Vault` |\n'));
    const vaultOnly = await b012(edgeModule('Secrets can be kept in HashiCorp Vault.\n'));

    expect(named.result.status).toBe(EvaluationStatus.PASS);
    expect(named.result.evidence).toBe('B012 pass: README.md names every infrastructure the tool found: AWS Systems Manager Parameter Store (as "AwsSsm") and HashiCorp Vault (as "Vault").');

    const note = 'edge-common secure store, chosen with secure_store; the default is Ephemeral';
    expect(vaultOnly.result.status).toBe(EvaluationStatus.MANUAL);
    expect(vaultOnly.result.evidence).toBe(`B012 manual: README.md does not name AWS Systems Manager Parameter Store, which the module may use (software.amazon.awssdk:ssm in pom.xml (${note})). `
      + 'A reviewer must check the items listed under B012-C3.');
    expect(vaultOnly.rows).toEqual([
      'README: README.md',
      'Infrastructure the module uses (direct dependencies, configuration and storage):',
      '  - AWS Systems Manager Parameter Store (optional or selectable) — not named',
      `    - software.amazon.awssdk:ssm in pom.xml (${note})`,
      '  - HashiCorp Vault (optional or selectable) — named',
      `    - com.bettercloud:vault-java-driver in pom.xml (${note})`,
      'Checklist for the reviewer:',
      ...C1(),
      ...C2(),
      C3(),
      '    - Start with:',
      `      - pom.xml — AWS Systems Manager Parameter Store: software.amazon.awssdk:ssm (${note})`,
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
    expect(vaultOnly.analysis.checklist.items.find(item => item.id === 'B012-C3')).toMatchObject({ reviewerOnly: true, obligations: [] });
  });

  it('fails on unnamed required infrastructure even when a build file could not be read, and escapes repository text', async () => {
    const { result, rows } = await b012(repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('jedis', 'redis.clients')}${dependency('lettuce(evidence: x)', '${lettuce.group}')}</dependencies>`),
      'src/main/resources/application.yml': 'spring:\n  kafka:\n    "a\\x01b": 1\n',
      'src/main/java/org/example/Main.java': 'class Main { String token = System.getenv("VAULT_TOKEN"); }',
      'README.md': 'A module.\n'
    }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B012 fail: README.md does not name Redis, which the module uses (redis.clients:jedis in pom.xml). '
      + 'It does not name Apache Kafka or HashiCorp Vault either, which the module may use (spring.kafka.a\\u0001b in src/main/resources/application.yml; VAULT_TOKEN in src/main/java/org/example/Main.java).');
    expect(rows).toEqual([
      'README: README.md',
      'Infrastructure the module uses (direct dependencies, configuration and storage):',
      '  - Apache Kafka (configuration only, no client library) — not named',
      '    - spring.kafka.a\\u0001b in src/main/resources/application.yml',
      '  - Redis (required) — not named',
      '    - redis.clients:jedis in pom.xml',
      '  - HashiCorp Vault (configuration only, no client library) — not named',
      '    - VAULT_TOKEN in src/main/java/org/example/Main.java',
      'What the tool could not read:',
      '  - pom.xml — the dependency ${lettuce.group}:lettuce[evidence: x) uses a property the tool could not resolve',
      'What to do:',
      '  - Name Redis in README.md, with what the module uses it for.',
      'Checklist for the reviewer:',
      ...C1(),
      ...C2('README.md', ['      - src/main/resources/application.yml — Apache Kafka: spring.kafka.a\\u0001b'])
    ]);
  });

  it('reads only README.md: another README does not count, and without README.md a required dependency fails', async () => {
    const { result, rows } = await b012(repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('folio-kafka-wrapper')}</dependencies>`),
      'README.txt': 'This module uses Kafka.\n'
    }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B012 fail: There is no README.md at the repository root, so nothing names Apache Kafka, which the module uses (org.folio:folio-kafka-wrapper in pom.xml).');
    expect(rows).toEqual([
      'README: no README.md at the repository root',
      'Infrastructure the module uses (direct dependencies, configuration and storage):',
      '  - Apache Kafka (required) — not named',
      '    - org.folio:folio-kafka-wrapper in pom.xml',
      'What to do:',
      '  - Add a README.md at the repository root that names Apache Kafka, with what the module uses it for.',
      'Checklist for the reviewer:',
      '  - B012-C1 Each external service the module calls, other than FOLIO interfaces and the infrastructure listed, is named in README.md.',
      '  - B012-C2 Each Kafka topic the module consumes from or produces for other modules is named in README.md.',
      '    - Start with:',
      '      - pom.xml — Apache Kafka: org.folio:folio-kafka-wrapper'
    ]);
  });

  it('leaves a README.md variant it cannot read to the reviewer instead of failing, and does not list it twice', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('folio-kafka-wrapper')}${dependency('jedis', 'redis.clients')}</dependencies>`),
      'README.md': 'Uses Kafka.\n',
      'docs/other.md': 'Redis\n'
    });
    fs.symlinkSync('docs/other.md', path.join(root, 'README.MD'));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'link');
    const { result, rows } = await b012(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B012 manual: The tool could not read README.MD, so it could not check that it names the infrastructure the module uses: Apache Kafka and Redis. '
      + 'A reviewer must check the items listed under B012-C3.');
    expect(rows).toEqual([
      'README: README.md; could not read README.MD',
      'Infrastructure the module uses (direct dependencies, configuration and storage):',
      '  - Apache Kafka (required) — named as "Kafka"',
      '    - org.folio:folio-kafka-wrapper in pom.xml',
      '  - Redis (required) — not checked',
      '    - redis.clients:jedis in pom.xml',
      'Checklist for the reviewer:',
      ...C1(),
      ...C2('README.md', ['      - pom.xml — Apache Kafka: org.folio:folio-kafka-wrapper']),
      C3(),
      '    - Start with:',
      '      - pom.xml — Redis: redis.clients:jedis',
      '      - README.MD — Skipped a non-regular committed tree entry',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
  });

  it('does not fail when the committed source was cut short before README.md', async () => {
    const ramls = Object.fromEntries(Array.from({ length: 2_001 }, (_item, index) => [`ramls/r${index}.raml`, '#%RAML 1.0\n']));
    const { result, rows } = await b012(repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('folio-kafka-wrapper')}</dependencies>`),
      'README.md': 'Uses Kafka.\n',
      ...ramls
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B012 manual: The committed source was not read completely and README.md was not among the files read, so the tool could not check that it names '
      + 'the infrastructure the module uses: Apache Kafka. A reviewer must check the items listed under B012-C3.');
    expect(rows).toEqual([
      'README: not among the files read',
      'Infrastructure the module uses (direct dependencies, configuration and storage):',
      '  - Apache Kafka (required) — not checked',
      '    - org.folio:folio-kafka-wrapper in pom.xml',
      'What the tool could not read:',
      '  - Committed source candidate count exceeded 2000 files',
      'Checklist for the reviewer:',
      '  - B012-C1 Each external service the module calls, other than FOLIO interfaces and the infrastructure listed, is named in README.md.',
      ...C2('README.md', []).slice(0, 1),
      '    - Start with:',
      '      - pom.xml — Apache Kafka: org.folio:folio-kafka-wrapper',
      C3(),
      '    - Start with:',
      '      - pom.xml — Apache Kafka: org.folio:folio-kafka-wrapper',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
  }, 60_000);

  it('passes when no infrastructure is found, and is manual when a build file could not be read', async () => {
    const none = await b012(repository({ 'pom.xml': pom('folio-spring-base'), 'README.md': 'A library.\n' }));
    const unread = await b012(repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('folio-kafka-wrapper')}${dependency('lettuce-core', '${lettuce.group}')}</dependencies>`),
      'README.md': 'Kafka\n'
    }));

    expect(none.analysis.kind).toBe('library');
    expect(none.result.status).toBe(EvaluationStatus.PASS);
    expect(none.result.evidence).toBe('B012 pass: The tool found no infrastructure the module uses, so README.md has none to name.');
    expect(none.rows).toEqual([
      'README: README.md',
      'Infrastructure the module uses (direct dependencies, configuration and storage): none found',
      'Checklist for the reviewer:',
      ...C1(),
      ...C2()
    ]);
    expect(unread.result.status).toBe(EvaluationStatus.MANUAL);
    expect(unread.result.evidence).toBe('B012 manual: README.md names every infrastructure the tool found: Apache Kafka (as "Kafka"). '
      + 'Some build, configuration or source files could not be read, so the module may use infrastructure the tool did not find. A reviewer must check the items listed under B012-C3.');
    expect(unread.rows).toEqual([
      'README: README.md',
      'Infrastructure the module uses (direct dependencies, configuration and storage):',
      '  - Apache Kafka (required) — named as "Kafka"',
      '    - org.folio:folio-kafka-wrapper in pom.xml',
      'What the tool could not read:',
      '  - pom.xml — the dependency ${lettuce.group}:lettuce-core uses a property the tool could not resolve',
      'Checklist for the reviewer:',
      ...C1(),
      ...C2('README.md', ['      - pom.xml — Apache Kafka: org.folio:folio-kafka-wrapper']),
      C3(),
      '    - Start with:',
      '      - pom.xml — the dependency ${lettuce.group}:lettuce-core uses a property the tool could not resolve',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
  });

  it('lists at most 20 files it could not read', async () => {
    const { rows } = await b012(repository({
      'build.gradle': `dependencies {\n${Array.from({ length: 22 }, (_item, index) => `  implementation libs.l${index}`).join('\n')}\n}\n`,
      'README.md': 'A module.\n'
    }));
    const message = 'a dependency that is not a plain "group:name" string, such as a version catalog entry or a variable';
    const start = rows!.indexOf('What the tool could not read:');
    expect(rows!.slice(start, start + 23)).toEqual([
      'What the tool could not read:',
      ...Array.from({ length: 20 }, (_item, index) => `  - build.gradle:${index + 2} — ${message}`),
      '  - ... 2 more',
      'Checklist for the reviewer:'
    ]);
  });

  it('names OpenSearch, Elasticsearch and AWS SSM by their synonyms', async () => {
    const { analysis } = await b012(repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('opensearch-java', 'org.opensearch.client')}${dependency('elasticsearch-java', 'co.elastic.clients')}${dependency('ssm', 'software.amazon.awssdk')}</dependencies>`),
      'README.md': 'Search runs on Elasticsearch or OpenSearch. Secrets live in the AWS SSM parameter store.\n'
    }));
    expect(analysis.infrastructure.map(item => [item.id, item.namedAs])).toEqual([['opensearch', 'OpenSearch'], ['elasticsearch', 'Elasticsearch'], ['aws-ssm', 'AWS SSM']]);
  });

  it('matches names in README.md in linear time', async () => {
    const prepare = async (size: number) => {
      const root = rmbModule({ 'README.md': `${'Postgre Postgres_ kafka- -S3 MinIO.io AwsSs '.repeat(size)}\n` });
      const evidence = await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
      return { evidence, detected: await collectBackendInfrastructure(evidence) };
    };
    const analysis = await expectLinearTime(5_000, prepare, async ({ evidence, detected }) => evaluateB012(evidence, detected));
    expect(analysis.infrastructure.map(item => item.namedAs ?? null)).toEqual([null, null, null]);
  }, 60_000);

  describe('agent review', () => {
    const vaultOnly = () => edgeModule('Secrets can be kept in HashiCorp Vault.\n');
    const assessment = (fields: Partial<CriterionAgentAssessment>): CriterionAgentAssessment => ({
      technologyId: 'B012-C1#1', type: 'aligned_fact', summary: 'The module calls no service outside FOLIO.',
      evidenceReferences: ['src/main/java/org/example/Main.java'], coverageDisposition: 'investigated', ...fields
    });
    const fakeConfig = (enabledCriteria: string[], fields: Record<string, unknown> = {}): CriterionAgentReviewConfig => ({
      enabled: true, enabledCriteria, adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
        available: true, criterionId: 'B012', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
        summary: 'A mail server is not named.', rationale: 'Read the sources and README.md.', evidenceReferences: ['README.md'],
        warnings: [], errors: [], reviewerActions: [{ action: 'Ask the developers to name the SMTP server in README.md.', evidenceReferences: ['README.md'] }], ...fields
      }
    } as CriterionAgentReviewConfig);
    const withSource = () => {
      const root = vaultOnly();
      fs.mkdirSync(path.join(root, 'src/main/java/org/example'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src/main/java/org/example/Main.java'), 'class Main { String smtp = "smtp.example.org"; }\n');
      fs.mkdirSync(path.join(root, 'src/test/java'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src/test/java/MainTest.java'), 'class MainTest {}\n');
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'sources');
      return root;
    };

    it('runs only when --criterion-agent-criteria lists B012', async () => {
      const { result, rows } = await b012(vaultOnly(), { enabled: true, adapter: 'fake', modelLabel: 'fake-model' } as CriterionAgentReviewConfig);

      expect(result.agentReview).toBeUndefined();
      expect(rows!.slice(-2)).toEqual(['Agent review:', '  - Not applied: agent review for B012 runs only when listed in --criterion-agent-criteria']);
    });

    it('does not review a pass or a fail, even when listed', async () => {
      const pass = await b012(edgeModule('`AwsSsm`, `Vault`'), fakeConfig(['B012']));
      const fail = await b012(rmbModule({ 'README.md': 'Nothing.\n' }), fakeConfig(['B012']));

      expect([pass.result.status, pass.result.agentReview, fail.result.status, fail.result.agentReview])
        .toEqual([EvaluationStatus.PASS, undefined, EvaluationStatus.FAIL, undefined]);
      expect(pass.rows!.some(row => row.startsWith('Agent review'))).toBe(false);
    });

    it('browses production sources and README.md and gives the agent C1 and C2 only', async () => {
      const root = withSource();
      const { analysis } = await b012(root);
      const prepared = (await prepareCriterionAgentReviewEvidence(buildB012AgentReviewRequest(root, analysis))).request;
      const paths = prepared.files.map(file => file.repoRelativePath);

      expect(paths).toEqual(expect.arrayContaining(['README.md', 'pom.xml', 'src/main/java/org/example/Main.java']));
      expect(paths).not.toContain('src/test/java/MainTest.java');
      const checklist = JSON.parse(prepared.files.find(file => file.repoRelativePath === '.criterion-agent/B012/checklist.json')!.content);
      expect(checklist.items.flatMap((item: { obligations: unknown[] }) => item.obligations)).toEqual([{ id: 'B012-C1#1' }, { id: 'B012-C2#1' }]);
      expect(prepared.defaultTimeoutMs).toBe(600_000);
    });

    it('attaches the agent\'s results to C1 and C2, keeps discovered services and topics in the review, and drops an invalid item on its own', async () => {
      const { result, rows } = await b012(withSource(), fakeConfig(['B012'], {
        assessments: [
          assessment({ type: 'substantive_concern', summary: 'Main.java connects to an SMTP server the README does not name.' }),
          assessment({ technologyId: 'B012-C2#1', summary: 'The module uses no Kafka topic.' }),
          assessment({ technologyId: 'discovered:service:1', type: 'substantive_concern', summary: 'smtp.example.org is not named.' }),
          assessment({ technologyId: 'discovered:interface:1', type: 'substantive_concern', summary: 'Not a B012 kind.' })
        ]
      }));

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.agentReview?.available).toBe(true);
      const c1 = rows!.indexOf(C1()[0]);
      expect(rows!.slice(c1, c1 + 8)).toEqual([
        ...C1(),
        '    - Agent: Potential problem — Main.java connects to an SMTP server the README does not name.',
        '      - Sources:',
        '        - src/main/java/org/example/Main.java',
        '      - Coverage judgment: Investigated directly',
        ...C2().slice(0, 1)
      ]);
      expect(rows).toContain('    - Agent: Supported by evidence — The module uses no Kafka topic.');
      expect(rows).toContain('    - External service found by the agent (1) — Potential problem:');
      expect(rows).toContain('    - A result for discovered:interface:1: It answers nothing the agent was asked to check.');
      expect(rows).toContain('  - Advisory only; the criterion status is unchanged.');
    });
  });
});
