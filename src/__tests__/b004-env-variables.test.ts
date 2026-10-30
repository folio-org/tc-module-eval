import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B004Analysis, EvaluationStatus } from '../types';
import { evaluateB004, loadB004Policy } from '../utils/b004-env-variables';
import { getBackendEvidence } from '../utils/backend-evidence';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b004(root: string, existingModule = false) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java', existingModule });
  const result = await new BackendEvaluator().evaluateCriterion('B004', root, run);
  return { result, analysis: result.criterionDetails as B004Analysis, rows: result.details?.split('\n') ?? [] };
}

type Entry = { name: string; value?: string };

function template(launchEnv: Entry[], env?: Entry[] | unknown): string {
  return JSON.stringify({ id: 'mod-example-1.0.0', ...(env === undefined ? {} : { env }), launchDescriptor: { env: launchEnv } }, null, 2);
}

const moduleRepository = (descriptor: string, files: Record<string, string> = {}) => repository({
  'pom.xml': pom('mod-example', restVerticleBuild),
  'descriptors/ModuleDescriptor-template.json': descriptor,
  ...files
});

const table = (header: string, rows: string[]) => {
  const columns = header.split('|').length - 2;
  return [header, `|${'---|'.repeat(columns)}`, ...rows].join('\n');
};

const FULL_HEADER = '| Name | Default value | Required | Description |';
const POLICY = 'Policy: FOLIO Environment Variables policy, page version 13 of 2026-01-26 (https://folio-org.atlassian.net/wiki/spaces/TC/pages/1319141429/Environment+Variables)';
const NEW_MODULE = 'Evaluated as: a new module (the default)';
const TEMPLATE = 'descriptors/ModuleDescriptor-template.json';
const C1_TITLE = '  - B004-C1 Every environment variable the module uses is documented in ENV_VARS.md or a README table with a default, whether it is required, and a description, and the descriptor template lists it in a top-level env.';
const C4_TITLE = '  - B004-C4 Each required variable stops startup with a clear message when it is missing or empty.';
const NO_SIGNALS = ['C5 Startup logging:', '  - No log statement in files that read configuration prints a secret-like value or the whole environment'];
const NAMES_OK = ['C3 Naming:', '  - Every name is upper case letters, digits and underscores, and no AWS_ variable lacks an S3_ one'];

const documentedModule = (envVarsRows: string[], options: { env?: Entry[] | unknown; launchEnv?: Entry[]; files?: Record<string, string> } = {}) => moduleRepository(
  template(options.launchEnv ?? [{ name: 'DB_HOST', value: 'postgres' }, { name: 'DB_PORT', value: '5432' }],
    'env' in options ? options.env : [{ name: 'DB_HOST', value: '' }, { name: 'DB_PORT', value: '5432' }]),
  { 'ENV_VARS.md': `# Environment variables\n\n${table(FULL_HEADER, envVarsRows)}\n`, ...options.files }
);

const springBinding = (name: string) => ({ 'src/main/java/org/folio/example/Config.java': `class Config {\n  @Value("\${${name}}")\n  private String value;\n}\n` });

describe('B004 environment variables', () => {
  it('fails a module whose variables are only in the descriptor env lists, which are not documentation', async () => {
    const { result, analysis, rows } = await b004(moduleRepository(template([{ name: 'DB_HOST', value: 'postgres' }, { name: 'JAVA_OPTIONS', value: '-Xmx1g' }])));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B004 fail: The module uses 2 environment variables, but none is documented in ENV_VARS.md or a README table. '
      + 'The descriptor template has no top-level "env" (policy section 3.1).');
    expect(rows).toEqual([
      NEW_MODULE,
      POLICY,
      'Variables used: 2 (2 in launchDescriptor.env)',
      'Documentation: no ENV_VARS.md, no README.md; the descriptor\'s env lists do not count as documentation',
      'C1 Documentation:',
      `  - Top-level env: ${TEMPLATE} has no top-level "env" (policy section 3.1)`,
      '  - Documented in a table: 0 of 2',
      '  - Not documented (2):',
      `    - DB_HOST — launchDescriptor.env in ${TEMPLATE}:5`,
      `    - JAVA_OPTIONS — launchDescriptor.env in ${TEMPLATE}:9`,
      'C2 Required vs optional:',
      '  - Not checked: no documentation says whether a variable is required',
      ...NAMES_OK,
      'C4 Startup behaviour:',
      '  - Not known for 2 variables, because the documentation does not say whether they are required',
      ...NO_SIGNALS,
      'What to do:',
      '  - Document every variable the module uses in ENV_VARS.md or a README table with its name, default (or empty), whether it is required, and a description (policy section 3).',
      '  - List every variable with a description in the descriptor template\'s top-level "env" (policy section 3.1).',
      'Checklist for the reviewer:',
      C1_TITLE,
      '    - Start with:',
      `      - ${TEMPLATE} — the template has no top-level "env"`,
      `      - ${TEMPLATE}:5 — DB_HOST: not in ENV_VARS.md or a README table`,
      `      - ${TEMPLATE}:9 — JAVA_OPTIONS: not in ENV_VARS.md or a README table`,
      C4_TITLE,
      '    - Start with:',
      `      - ${TEMPLATE}:5 — DB_HOST: not documented as required or optional`,
      `      - ${TEMPLATE}:9 — JAVA_OPTIONS: not documented as required or optional`
    ]);
    expect(analysis.variables.map(variable => [variable.name, variable.problems])).toEqual([['DB_HOST', ['undocumented']], ['JAVA_OPTIONS', ['undocumented']]]);
  });

  it('fails a README table that names every variable but has no required column', async () => {
    const readme = `# mod-example\n\n## Environment variables\n\n${table('| Name | Default value | Description |', [
      '| `DB_HOST` | `postgres` | Postgres host |',
      '| DB\\_PORT | 5432 | Postgres port |'
    ])}\n`;
    const { result, analysis } = await b004(documentedModule([], { files: { 'README.md': readme }, env: [{ name: 'DB_HOST' }] }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B004 fail: 2 documented variables are in a table with no Required column (policy section 3.2).');
    expect(analysis.variables.map(variable => [variable.name, variable.problems, variable.documentation?.line])).toEqual([
      ['DB_HOST', ['missing-columns'], 7],
      ['DB_PORT', ['missing-columns'], 8]
    ]);
  });

  it.each([
    ['no top-level env', undefined, 'has no top-level "env"'],
    ['an empty top-level env', [], 'has an empty top-level "env"'],
    ['a top-level env that is not a list', { DB_HOST: '' }, 'has a top-level "env" that is not a list']
  ])('fails a complete ENV_VARS.md with %s, and leaves it to the reviewer for an existing module', async (_name, env, text) => {
    const root = documentedModule(['| DB_HOST | | no | Postgres host |', '| DB_PORT | 5432 | no | Postgres port |'], { env });

    const fresh = await b004(root);
    expect(fresh.result.status).toBe(EvaluationStatus.FAIL);
    expect(fresh.result.evidence).toBe(`B004 fail: The descriptor template ${text} (policy section 3.1).`);
    expect(fresh.analysis.variables.every(variable => variable.problems.length === 0)).toBe(true);

    const existing = await b004(root, true);
    expect(existing.result.status).toBe(EvaluationStatus.MANUAL);
    expect(existing.result.evidence).toBe(`B004 manual: The descriptor template ${text} (policy section 3.1). `
      + 'In an existing-module evaluation (--existing-module) these documentation gaps are not a fail (policy section 7.2). A reviewer must check the findings on the checklist.');
  });

  it('passes a complete ENV_VARS.md table when each required variable stops startup without a default', async () => {
    const { result, analysis, rows } = await b004(documentedModule([
      '| `DB_HOST` | | yes | Postgres host |',
      '| `DB_PORT` | `5432` | no | Postgres port |'
    ], { files: springBinding('DB_HOST') }));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B004 pass: All 2 environment variables the module uses are documented in a table with a default, required or optional, and a description, '
      + 'and the descriptor template has a top-level "env". Their names follow the policy, each required variable stops startup when missing (a @Value binding without a default), '
      + 'and no log statement in files that read configuration prints a secret-like value or the whole environment.');
    expect(rows).toEqual([
      NEW_MODULE,
      POLICY,
      'Variables used: 2 (2 in the top-level env, 2 in launchDescriptor.env, 1 in Spring placeholders)',
      'Documentation: ENV_VARS.md with 1 table, no README.md; the descriptor\'s env lists do not count as documentation',
      'C1 Documentation:',
      `  - Top-level env: present in ${TEMPLATE}`,
      '  - Documented in a table: 2 of 2',
      'C2 Required vs optional:',
      '  - Documented as required: 1; as optional: 1',
      '  - No variable documented as required has a default',
      ...NAMES_OK,
      'C4 Startup behaviour:',
      '  - Stops startup when missing (a @Value binding without a default) (1):',
      '    - DB_HOST — src/main/java/org/folio/example/Config.java:2',
      ...NO_SIGNALS
    ]);
    expect(analysis.variables.map(variable => [variable.name, variable.required, variable.defaultFrom?.kind])).toEqual([['DB_HOST', true, undefined], ['DB_PORT', false, 'documentation']]);
    expect(analysis.checklist.items).toEqual([]);
  });

  it('leaves a required variable without fail-fast evidence to the reviewer', async () => {
    const { result, analysis } = await b004(documentedModule(['| DB_HOST | - | Required | Postgres host |', '| DB_PORT | 5432 | Optional | Postgres port |'], {
      files: { 'src/main/java/org/folio/example/Config.java': 'class Config {\n  @Value("${DB_HOST:}")\n  private String host;\n}\n' }
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B004 manual: The required variable DB_HOST has no evidence that startup stops when it is missing. A reviewer must check the findings on the checklist.');
    expect(analysis.variables[0].problems).toEqual(['no-fail-fast']);
    expect(analysis.checklist.items.map(item => [item.id, item.startingPoints, item.obligations])).toEqual([[
      'B004-C4',
      [{ path: 'src/main/java/org/folio/example/Config.java', line: 2, note: 'DB_HOST: documented as required; no fail-fast evidence found' }],
      [{ id: 'B004-C4#1', subject: 'DB_HOST', path: 'src/main/java/org/folio/example/Config.java', line: 2, flag: 'manual' }]
    ]]);
  });

  it.each([
    ['an empty description', ['| DB_HOST | | no | |', '| DB_PORT | 5432 | no | Port |'], {}, EvaluationStatus.FAIL,
      'B004 fail: The documented variable DB_HOST has no description.'],
    ['a getenv read whose name is not known', ['| DB_HOST | | no | Host |', '| DB_PORT | 5432 | no | Port |'],
      { 'src/main/java/org/folio/example/Env.java': 'class Env { String read(String key) { return System.getenv(key); } }' }, EvaluationStatus.MANUAL,
      'B004 manual: The tool could not read the name of 1 System.getenv read. A reviewer must check the findings on the checklist.']
  ])('decides a documented module with %s', async (_name, rows, files, status, evidence) => {
    const { result } = await b004(documentedModule(rows, { files }));

    expect(result.status).toBe(status);
    expect(result.evidence).toBe(evidence);
  });

  it.each([
    ['a parameter that shares its name with a local elsewhere', {
      'src/main/java/org/folio/example/Env.java': 'class Env { static String read(String key) { return System.getenv(key); } }',
      'src/main/java/org/folio/example/Other.java': 'class Other { void x() { String key = "okapi.url"; } }'
    }, EvaluationStatus.MANUAL, 'B004 manual: The tool could not read the name of 1 System.getenv read. A reviewer must check the findings on the checklist.'],
    ['a constant defined with two values in the repository', {
      'src/main/java/org/folio/example/Env.java': 'class Env { String a = System.getenv(Names.HOST); }',
      'src/main/java/org/folio/example/A.java': 'class A { static final String HOST = "DB_HOST"; }',
      'src/main/java/org/folio/example/B.java': 'class B { static final String HOST = "KAFKA_HOST"; }'
    }, EvaluationStatus.MANUAL, 'B004 manual: The tool could not read the name of 1 System.getenv read. A reviewer must check the findings on the checklist.'],
    ['the whole environment read into a map', {
      'src/main/java/org/folio/example/Env.java': 'class Env { void r() { Map<String, String> env = System.getenv(); String p = env.get("DB_PASSWORD"); } }'
    }, EvaluationStatus.MANUAL, 'B004 manual: The tool could not read the name of 1 System.getenv read. A reviewer must check the findings on the checklist.'],
    ['getenv in a string and a method named getenv', {
      'src/main/java/org/folio/example/Env.java': 'class Env { String getenv(String name) { log.warn("getenv(x) failed"); return name; } }'
    }, EvaluationStatus.PASS, undefined],
    ['a placeholder whose fallback is another placeholder', {
      'src/main/java/org/folio/example/Config.java': 'class Config {\n  @Value("${DB_HOST:${DB_PORT}}")\n  private String host;\n  @Value("${DB_HOST}")\n  private String again;\n}\n'
    }, EvaluationStatus.PASS, undefined]
  ])('reads %s', async (_name, files, status, evidence) => {
    const { result } = await b004(documentedModule(['| DB_HOST | | yes | Host |', '| DB_PORT | 5432 | no | Port |'], { files: { ...springBinding('DB_HOST'), ...files } }));

    expect(result.status).toBe(status);
    if (evidence) expect(result.evidence).toBe(evidence);
  });

  it('gives no fail-fast credit to a fallback placeholder, and reads Kotlin placeholders without string templates', async () => {
    const { analysis } = await b004(documentedModule(['| DB_HOST | | yes | Host |', '| DB_PORT | | yes | Port |'], { env: [{ name: 'DB_HOST' }, { name: 'DB_PORT' }], files: {
      'src/main/java/org/folio/example/Config.java': 'class Config { @Value("${DB_HOST:${DB_PORT}}") String host; }',
      'src/main/kotlin/org/folio/example/Settings.kt': 'class Settings(@Value("\\${KOTLIN_VAR}") val v: String) { val label = "${TEMPLATE_VALUE}" }',
      'src/main/resources/application.yml': 'deep: ${OUTER:${L1:${L2:${L3:${L4:${L5:${L6:${L7:${L8:x}}}}}}}}}\n'
    } }));
    expect(analysis.variables.find(variable => variable.name === 'OUTER')?.sources).toEqual([{ kind: 'configuration', path: 'src/main/resources/application.yml', line: 1, value: '${L1:${L2:${L3:${L4:${L5:${L6:${L7:${L8:x}}}}}}}}' }]);
    expect(analysis.variables.some(variable => variable.name === 'L8')).toBe(false);

    expect(analysis.variables.filter(variable => !/^(?:OUTER|L\d)$/.test(variable.name)).map(variable => [variable.name, variable.problems, variable.defaultFrom?.kind])).toEqual([
      ['DB_HOST', ['no-fail-fast'], undefined],
      ['DB_PORT', ['no-fail-fast'], undefined],
      ['KOTLIN_VAR', ['undocumented'], undefined]
    ]);
  });

  it.each([
    ['_none_', 'yes'],
    ['<none>', 'yes'],
    ['No default value', 'Required']
  ])('reads %j as no default for a required variable', async (cell, required) => {
    const { result } = await b004(documentedModule([`| DB_HOST | ${cell} | ${required} | Host |`, '| DB_PORT | 5432 | no | Port |'], {
      env: [{ name: 'DB_HOST' }, { name: 'DB_PORT', value: '5432' }],
      files: { ...springBinding('DB_HOST'), 'src/main/java/org/folio/example/Env.java': 'class Env { String h = System.getenv().getOrDefault("DB_HOST", null); }' }
    }));

    expect(result.status).toBe(EvaluationStatus.PASS);
  });

  it('still fails a required variable with a default in an existing-module evaluation', async () => {
    const { result } = await b004(documentedModule(['| DB_HOST | postgres | yes | Host |', '| DB_PORT | 5432 | no | Port |'], { files: springBinding('DB_HOST') }), true);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B004 fail: DB_HOST is documented as required but has a default; a variable with a default is optional (policy section 4.1).');
  });

  it('reads names only from the name column of tables outside code blocks', async () => {
    const readme = [
      '| Name | Default value | Required | Description | Notes |',
      '|---|---|---|---|---|',
      '| DB_HOST | | no | Host | replaces KAFKA_HOST |',
      '| DB_PORT | 5432 | no | Port | | OKAPI_URL |',
      '',
      '````',
      '```',
      FULL_HEADER, '|---|---|---|---|', '| ENV | folio | no | Prefix |',
      '````',
      '',
      `    ${FULL_HEADER}`, '    |---|---|---|---|', '    | SYSTEM_USER_NAME | | no | User |',
      '',
      '~~~', FULL_HEADER, '|---|---|---|---|', '| SYSTEM_USER_ENABLED | | no | Flag |', '~~~'
    ].join('\n');
    const names = ['DB_HOST', 'DB_PORT', 'KAFKA_HOST', 'OKAPI_URL', 'ENV', 'SYSTEM_USER_NAME', 'SYSTEM_USER_ENABLED'];
    const { analysis } = await b004(moduleRepository(template([], names.map(name => ({ name }))), { 'README.md': readme }));

    expect(analysis.variables.filter(variable => variable.documentation).map(variable => variable.name)).toEqual(['DB_HOST', 'DB_PORT']);
    expect(analysis.documentationFiles).toEqual([{ path: 'README.md', tableCount: 1 }]);
  });

  it('fails a variable documented as required that has a default in the table, the top-level env or the code, but not one with only a launchDescriptor value', async () => {
    const { result, analysis } = await b004(documentedModule([
      '| DB_HOST | `postgres` | yes | Postgres host |',
      '| DB_PORT | | yes | Postgres port |',
      '| DB_DATABASE | none | yes | Database name |',
      '| DB_USERNAME | | yes | User |',
      '| DB_PASSWORD | | yes | Password |'
    ], {
      env: [{ name: 'DB_HOST', value: '' }, { name: 'DB_PORT', value: '5432' }, { name: 'DB_DATABASE', value: '' }, { name: 'DB_USERNAME' }, { name: 'DB_PASSWORD' }],
      launchEnv: [{ name: 'DB_DATABASE', value: 'okapi_modules' }, { name: 'DB_PASSWORD', value: 'folio_admin' }],
      files: { 'src/main/resources/application.yml': 'spring:\n  datasource:\n    username: ${DB_USERNAME:folio_admin}\n    password: ${DB_PASSWORD}\n    host: ${DB_HOST}\n    database: ${DB_DATABASE}\n    port: ${DB_PORT}\n' }
    }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B004 fail: DB_HOST, DB_PORT, and DB_USERNAME are documented as required but have a default; a variable with a default is optional (policy section 4.1). '
      + '5 required variables have no evidence that startup stops when they are missing: DB_HOST, DB_PORT, DB_DATABASE, and 2 more.');
    expect(analysis.variables.map(variable => [variable.name, variable.defaultFrom])).toEqual([
      ['DB_HOST', { kind: 'documentation', path: 'ENV_VARS.md', line: 5, value: '`postgres`' }],
      ['DB_PORT', { kind: 'env', path: TEMPLATE, value: '5432' }],
      ['DB_DATABASE', undefined],
      ['DB_USERNAME', { kind: 'code', path: 'src/main/resources/application.yml', line: 3, value: 'folio_admin' }],
      ['DB_PASSWORD', undefined]
    ]);
  });

  it('counts only tables as documentation, not bullet lists, code blocks or a mention in another row', async () => {
    const readme = '# mod-example\n\n* `DB_HOST` - Postgres host (default `postgres`)\n\n```\n'
      + `${table(FULL_HEADER, ['| DB_PORT | | no | Port |'])}\n\`\`\`\n\n`
      + `${table(FULL_HEADER, ['| KAFKA_HOST | kafka | no | Used when DB_PORT is not set |'])}\n`;
    const { result, analysis } = await b004(moduleRepository(template([{ name: 'DB_HOST' }, { name: 'DB_PORT' }, { name: 'KAFKA_HOST' }], [{ name: 'DB_HOST' }]), { 'README.md': readme }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B004 fail: ENV_VARS.md or a README table documents 1 of the 3 environment variables the module uses; 2 are not: DB_HOST and DB_PORT.');
    expect(analysis.documentationFiles).toEqual([{ path: 'README.md', tableCount: 1 }]);
  });

  it('reads required or optional from the cell words and the column header', async () => {
    const envVars = table('| Variable | Optional | Default | Description |', [
      '| A_ONE | yes | | a |',
      '| A_TWO | No | | b |',
      '| A_THREE | ✓ | | c |',
      '| A_FOUR | required | | d |',
      '| A_FIVE | when S3 is used | | e |',
      '| A_SIX | | | f |',
      '| A_SEVEN | no | x | |'
    ]);
    const names = ['A_ONE', 'A_TWO', 'A_THREE', 'A_FOUR', 'A_FIVE', 'A_SIX', 'A_SEVEN'];
    const { result, analysis } = await b004(moduleRepository(template([], names.map(name => ({ name }))), { 'ENV_VARS.md': envVars }));

    expect(analysis.variables.map(variable => [variable.name, variable.required, variable.problems])).toEqual([
      ['A_ONE', false, []],
      ['A_TWO', true, ['no-fail-fast']],
      ['A_THREE', false, []],
      ['A_FOUR', true, ['no-fail-fast']],
      ['A_FIVE', undefined, ['unreadable-required']],
      ['A_SIX', undefined, ['missing-required']],
      ['A_SEVEN', true, ['missing-description', 'required-with-default', 'no-fail-fast']]
    ]);
    expect(result.status).toBe(EvaluationStatus.FAIL);
  });

  it.each([
    [false, EvaluationStatus.FAIL],
    [true, EvaluationStatus.FAIL]
  ])('fails AWS_ names without the S3_ name alongside, also when existing-module is %s', async (existingModule, status) => {
    const rows = ['AWS_URL', 'AWS_BUCKET', 'S3_URL', 'S3_REGION'].map(name => `| ${name} | | no | storage |`);
    const names = ['AWS_URL', 'AWS_BUCKET', 'S3_URL', 'S3_REGION'].map(name => ({ name }));
    const { result, analysis } = await b004(moduleRepository(template([], names), { 'ENV_VARS.md': table(FULL_HEADER, rows) }), existingModule);

    expect(result.status).toBe(status);
    expect(result.evidence).toBe('B004 fail: AWS_BUCKET uses the AWS_ prefix without an S3_ variable alongside (policy sections 2.1 and 5.1).');
    expect(analysis.variables.filter(variable => variable.problems.length).map(variable => [variable.name, variable.problems])).toEqual([['AWS_BUCKET', ['aws-prefix']]]);
  });

  it('collects every name the descriptor, the code and Spring configuration use, and fails names that are not upper case', async () => {
    const { result, analysis } = await b004(moduleRepository(template([{ name: 'JAVA_OPTIONS' }, { name: 'db.host' }], [{ name: 'Kafka_Port' }]), {
      'src/main/resources/application-dev.yml': '# url: ${COMMENTED_OUT}\nfolio:\n  okapi: ${OKAPI_URL:http://okapi:9130}\n  name: ${spring.application.name}\n  pattern: ${KAFKA_PATTERN:(${ENV:folio}\\.)(.*)}\n',
      'src/main/resources/config/application.properties': '! ${COMMENTED_OUT}\nsystem-user.password=${SYSTEM_USER_PASSWORD}\n',
      'src/main/java/org/folio/example/Reader.java': [
        'import static java.lang.System.getenv;',
        'class Reader {',
        '  static final String TIMEOUT = "HTTP_TIMEOUT";',
        '  // String commented = System.getenv("COMMENTED_OUT");',
        '  String a = System.getenv("FOLIO_ENVIRONMENT");',
        '  String b = getenv().getOrDefault(TIMEOUT, "30");',
        '  String c = System.getenv().get(Names.SHARED);',
        '  String d = System.getenv(key);',
        '  String e = "${NOT_A_PLACEHOLDER";',
        '}'
      ].join('\n'),
      'src/main/java/org/folio/example/Names.java': 'class Names { public static final String SHARED = "SHARED_NAME"; }',
      'src/main/groovy/org/folio/example/Jobs.groovy': 'class Jobs { String label = "${MAX_JOBS}"; String home = System.getenv(\'GROOVY_HOME\') }',
      'src/test/java/org/folio/example/ReaderTest.java': 'class ReaderTest { String t = System.getenv("TEST_ONLY"); }'
    }));

    expect(analysis.variables.map(variable => [variable.name, variable.sources.map(source => `${source.kind} ${source.path}${source.line ? `:${source.line}` : ''}${source.value === undefined ? '' : ` = ${source.value}`}`)])).toEqual([
      ['Kafka_Port', [`env ${TEMPLATE}:4`]],
      ['JAVA_OPTIONS', [`launch-env ${TEMPLATE}:10`]],
      ['db.host', [`launch-env ${TEMPLATE}:13`]],
      ['OKAPI_URL', ['configuration src/main/resources/application-dev.yml:3 = http://okapi:9130']],
      ['ENV', ['configuration src/main/resources/application-dev.yml:5 = folio']],
      ['KAFKA_PATTERN', ['configuration src/main/resources/application-dev.yml:5 = (${ENV:folio}\\.)(.*)']],
      ['SYSTEM_USER_PASSWORD', ['configuration src/main/resources/config/application.properties:2']],
      ['GROOVY_HOME', ['code src/main/groovy/org/folio/example/Jobs.groovy:1']],
      ['FOLIO_ENVIRONMENT', ['code src/main/java/org/folio/example/Reader.java:5']],
      ['HTTP_TIMEOUT', ['code src/main/java/org/folio/example/Reader.java:6 = 30']],
      ['SHARED_NAME', ['code src/main/java/org/folio/example/Reader.java:7']]
    ]);
    expect(analysis.unreadReads).toEqual([{ path: 'src/main/java/org/folio/example/Reader.java', line: 8 }]);
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B004 fail: The module uses 11 environment variables, but none is documented in ENV_VARS.md or a README table. '
      + '2 names are not upper case letters, digits and underscores: Kafka_Port and db.host (policy section 2.1). The tool could not read the name of 1 System.getenv read.');
    expect(analysis.variables.filter(variable => variable.problems.includes('name-format')).map(variable => variable.name)).toEqual(['Kafka_Port', 'db.host']);
  });

  it('flags log statements in configuration code that print a secret-like value or the whole environment', async () => {
    const { result, analysis, rows } = await b004(documentedModule(['| DB_HOST | | no | Host |', '| DB_PORT | 5432 | no | Port |'], {
      files: {
        'src/main/java/org/folio/example/Startup.java': [
          'class Startup {',
          '  void start() {',
          '    String password = System.getenv("DB_PASSWORD_X");',
          '    log.info("Connecting with password {}", password);',
          '    log.info("Client {} with key {}", clientId, config.getApiKey());',
          '    LOG.debug("Environment: {}", System.getenv());',
          '    log.info("Host {}", System.getenv().get("DB_HOST"));',
          '    log.warn("The token could not be read");',
          '  }',
          '}'
        ].join('\n'),
        'src/main/java/org/folio/example/Other.java': 'class Other { void x() { log.info("token {}", token); } }'
      }
    }));

    expect(analysis.logSignals).toEqual([
      { kind: 'secret-value', subject: 'password', path: 'src/main/java/org/folio/example/Startup.java', line: 4 },
      { kind: 'secret-value', subject: 'getApiKey', path: 'src/main/java/org/folio/example/Startup.java', line: 5 },
      { kind: 'environment-dump', subject: 'getenv()', path: 'src/main/java/org/folio/example/Startup.java', line: 6 }
    ]);
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(rows.slice(rows.indexOf('C5 Startup logging:'), rows.indexOf('C5 Startup logging:') + 5)).toEqual([
      'C5 Startup logging:',
      '  - Log statements that may print a secret value or the whole environment (3):',
      '    - src/main/java/org/folio/example/Startup.java:4 — may print a secret-like value (password)',
      '    - src/main/java/org/folio/example/Startup.java:5 — may print a secret-like value (getApiKey)',
      '    - src/main/java/org/folio/example/Startup.java:6 — reads the whole environment (getenv())'
    ]);
  });

  it('checks only names, startup behaviour and logging for a library or a repository without a descriptor', async () => {
    const files = {
      'src/main/java/org/folio/spring/Envs.java': 'class Envs { String env = System.getenv("ENV"); String aws = System.getenv("AWS_REGION"); }'
    };
    const library = await b004(repository({ 'pom.xml': pom('folio-spring-base'), ...files }));
    const ambiguous = await b004(repository({ 'pom.xml': pom('mod-unknown'), ...files }));

    expect(library.result.status).toBe(EvaluationStatus.FAIL);
    expect(library.result.evidence).toBe('B004 fail: AWS_REGION uses the AWS_ prefix without an S3_ variable alongside (policy sections 2.1 and 5.1). '
      + 'The repository is a shared library: its documentation is not checked, so the tool cannot tell which of its 2 environment variables are required.');
    expect(library.analysis.topLevelEnv).toBe('not-checked');
    expect(library.rows.slice(2)).toEqual([
      'Variables used: 2 (2 read with System.getenv)',
      'C3 Naming:',
      '  - AWS_ without an S3_ variable alongside (policy sections 2.1 and 5.1) (1):',
      '    - AWS_REGION — no S3_REGION',
      'C4 Startup behaviour:',
      '  - Not checked: a library\'s documentation is not read, so which variables are required is not known',
      ...NO_SIGNALS,
      'What to do:',
      '  - Support an S3_ variable alongside each AWS_ one, taking precedence over it, and document both (policy sections 2.1 and 5.1).',
      'Checklist for the reviewer:',
      '  - B004-C3 Each variable name is upper case letters, digits and underscores, and each AWS_ variable has an S3_ variable alongside it.',
      '    - Start with:',
      '      - src/main/java/org/folio/spring/Envs.java:1 — AWS_REGION: no S3_REGION alongside',
      C4_TITLE,
      '    - Start with:',
      '      - src/main/java/org/folio/spring/Envs.java:1 — ENV: required or optional not known',
      '      - src/main/java/org/folio/spring/Envs.java:1 — AWS_REGION: required or optional not known'
    ]);
    expect(ambiguous.result.evidence).toBe('B004 fail: AWS_REGION uses the AWS_ prefix without an S3_ variable alongside (policy sections 2.1 and 5.1). '
      + 'The repository has no module descriptor, so B004 treats it as a library (see B001): its documentation is not checked, so the tool cannot tell which of its 2 environment variables are required.');
    expect(ambiguous.analysis.documentationChecked).toBe(false);

    const clean = await b004(repository({ 'pom.xml': pom('folio-spring-base') }));
    expect(clean.result.evidence).toBe('B004 pass: The repository uses no environment variables, and no log statement in files that read configuration prints the whole environment.');
  });

  it('does not count the top-level env against an edge module without a template, which B001 fails', async () => {
    const { result, analysis, rows } = await b004(repository({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      'README.md': table(FULL_HEADER, ['| SECURE_TENANT_ID | secure | no | Tenant of the secure store |']),
      'src/main/java/org/folio/edge/Main.java': 'class Main { String t = System.getenv().getOrDefault("SECURE_TENANT_ID", "secure"); }'
    }));

    expect(analysis.kind).toBe('edge-module');
    expect(analysis.topLevelEnv).toBe('no-template');
    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B004 pass: The environment variable the module uses is documented in a table with a default, required or optional, and a description. '
      + 'Their names follow the policy, none is documented as required, and no log statement in files that read configuration prints a secret-like value or the whole environment.');
    expect(rows.slice(3, 7)).toEqual([
      'Documentation: no ENV_VARS.md, README.md with 1 table; the descriptor\'s env lists do not count as documentation',
      'C1 Documentation:',
      '  - Top-level env: not checked, because the edge module has no descriptor template (see B001).',
      '  - Documented in a table: 1 of 1'
    ]);
  });

  it('does not ask for a top-level env in a module that uses no variables', async () => {
    const { result, analysis } = await b004(moduleRepository(template([])));

    expect(result.evidence).toBe('B004 pass: The module uses no environment variables, and no log statement in files that read configuration prints the whole environment.');
    expect(analysis.topLevelEnv).toBe('not-checked');
  });

  it('leaves an unreadable template to the reviewer', async () => {
    const { result } = await b004(moduleRepository('{"id": "mod-example-1.0.0",', { 'ENV_VARS.md': table(FULL_HEADER, []) }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B004 manual: The module descriptor template could not be read (see B001), so the variables its env lists name are not known. A reviewer must check the findings on the checklist.');
  });

  it('cites the pinned policy snapshot', () => {
    const policy = loadB004Policy();

    expect([policy.title, policy.pageVersion, policy.modifiedAt]).toEqual(['Environment Variables', 13, '2026-01-26T15:03:06.548Z']);
    expect(policy.text).toContain('**Formatting Rule:** All environment variable names MUST be uppercase with underscores only');
    expect(policy.text).toContain('Existing modules MUST add support for standardized environment variables alongside their existing non-compliant ones.');
  });

  it('reads placeholders, getenv calls, log statements and tables in linear time', async () => {
    const evidence = async (size: number) => {
      const root = moduleRepository(template(Array.from({ length: size }, (_item, index) => ({ name: `VAR_${index}` }))), {
        'README.md': `${table(FULL_HEADER, Array.from({ length: size * 10 }, (_item, index) => `| VAR_${index} \\| x | | yes | ${'| '.repeat(20)}`))}\n${'| a | b |\n'.repeat(size * 10)}${'```\n'.repeat(size)}`,
        'src/main/resources/application.yml': [
          '${'.repeat(size * 100),
          `x: ${'${A:'.repeat(size * 50)}${'}'.repeat(size * 50)}`,
          `y: \${${'B'.repeat(size * 100)}}`,
          ...Array.from({ length: size * 10 }, (_item, index) => `k${index}: \${VAR_${index}:d}`)
        ].join('\n'),
        'src/main/java/org/folio/example/Many.java': [
          `class Many { ${'String s = System.getenv('.repeat(size * 5)}`,
          `${'log.info("password {}", '.repeat(size * 5)}`,
          `${'System.getenv().getOrDefault('.repeat(size * 5)}`,
          `@Value("${'${X:'.repeat(size * 5)}")`,
          ...Array.from({ length: size * 10 }, (_item, index) => `static final String C${index} = "V${index}"; String r${index} = System.getenv(C${index}); void l${index}() { log.info("x {}", secret${index}); }`),
          '}'
        ].join('\n')
      });
      return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
    };

    const analysis = await expectLinearTime(100, evidence, async backendEvidence => evaluateB004(backendEvidence, false, loadB004Policy()));

    expect(analysis.variables.filter(variable => /^V\d+$/.test(variable.name)).length).toBe(400 * 10);
    expect(analysis.logSignals.length).toBe(400 * 10);
    expect(analysis.sourceDiagnostics).toEqual([]);
  }, 120_000);
});
