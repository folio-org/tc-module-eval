import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B011Analysis, EvaluationStatus } from '../types';
import { evaluateB011, renderB011HumanDetails } from '../utils/b011-schema-access';
import { getBackendEvidence } from '../utils/backend-evidence';
import { createEvaluationRun } from '../utils/evaluation-run';
import { pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b011(root: string) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
  const result = await new BackendEvaluator().evaluateCriterion('B011', root, run);
  return { result, analysis: result.criterionDetails as B011Analysis };
}

const DB = 'src/main/resources/templates/db_scripts';
type Script = { snippetPath: string; fromModuleVersion?: string };

const rmbModule = (scripts: Script[], files: Record<string, string> = {}, artifactId = 'mod-example') => repository({
  'pom.xml': pom(artifactId, restVerticleBuild),
  'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: '${artifactId}-1.0.0', provides: [] }),
  [`${DB}/schema.json`]: JSON.stringify({ tables: [], scripts: scripts.map(script => ({ run: 'after', ...script })) }),
  ...files
});

const springModule = (files: Record<string, string>) => repository({
  'pom.xml': pom('mod-example'),
  'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: 'mod-example-2.1.0-SNAPSHOT', provides: [] }),
  'src/main/resources/db/changelog/changelog-master.xml': '<databaseChangeLog><include file="changes/copy.sql" relativeToChangelogFile="true"/></databaseChangeLog>\n',
  ...files
});

const javaFile = (body: string) => ({ 'src/main/java/org/example/Repository.java': `class Repository {\n${body}\n}\n` });

const migration = [
  '-- copy settings from ${myuniversity}_mod_configuration',
  'INSERT INTO ${myuniversity}_${mymodule}.settings',
  'SELECT * FROM ${myuniversity}_mod_configuration.config_data;',
  '/* also ${myuniversity}_mod_users.users',
  '   ${myuniversity}_mod_users.users */',
  'SELECT * FROM ${myuniversity}_mod_settings.settings',
  "WHERE key <> '--' AND EXISTS (SELECT 1 FROM ${myuniversity}_mod_settings.scopes);",
  'SELECT 1 FROM diku_mod_users.users;',
  '<#--',
  '  ${myuniversity}_mod_users',
  '-->',
  'SELECT 1 FROM ${myuniversity}_mod_example.items;',
  "SELECT 1 FROM information_schema.tables WHERE table_schema = '${myuniversity}_mod_settings';"
].join('\n');

describe('B011 access to other modules\' database schemas', () => {
  it('leaves an upgrade script that reads other modules\' schemas to the reviewer, without comments, literal tenants or the module\'s own schema', async () => {
    const { result, analysis } = await b011(rmbModule([{ snippetPath: './migrate.sql', fromModuleVersion: '17.5.0' }], { [`${DB}/migrate.sql`]: migration }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B011 manual: A migration refers to other modules\' database schemas: '
      + `${DB}/migrate.sql (an RMB script that runs on a tenant's first install and on upgrades from versions before 17.5.0) refers to `
      + '${myuniversity}_mod_configuration.config_data at line 3 and ${myuniversity}_mod_settings.settings at lines 6, 7, and 13. '
      + 'A reviewer must decide whether this one-time migration is acceptable.');
    expect(result.details?.split('\n')).toEqual([
      `Storage: RMB database schema ${DB}/schema.json`,
      'Own schema: <tenant>_mod_example',
      'Files read: 2 SQL scripts, changelogs and sources, with comments removed',
      'Own-schema references (not counted): 1',
      'References in migrations:',
      `  - ${DB}/migrate.sql:3 — \${myuniversity}_mod_configuration.config_data`,
      `  - ${DB}/migrate.sql:6 — \${myuniversity}_mod_settings.settings`,
      `  - ${DB}/migrate.sql:7 — \${myuniversity}_mod_settings.scopes`,
      `  - ${DB}/migrate.sql:13 — \${myuniversity}_mod_settings`,
      'How the migrations run:',
      `  - ${DB}/migrate.sql — an RMB script that runs on a tenant's first install and on upgrades from versions before 17.5.0`,
      'Checklist for the reviewer:',
      '  - B011-C1 Each reference to another module\'s database schema is unreachable, part of FQM, or an accepted one-time migration.',
      '    - Start with:',
      `      - ${DB}/migrate.sql:3 — \${myuniversity}_mod_configuration.config_data at line 3: an RMB script that runs on a tenant's first install and on upgrades from versions before 17.5.0`,
      `      - ${DB}/migrate.sql:6 — \${myuniversity}_mod_settings.settings at lines 6, 7, and 13: an RMB script that runs on a tenant's first install and on upgrades from versions before 17.5.0`,
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
    expect(analysis.references.map(({ schema, location, migration: how, occurrenceCount, failing }) => ({ schema, location, how, occurrenceCount, failing }))).toEqual([
      { schema: 'mod_configuration', location: 'migration', how: { kind: 'rmb', fromModuleVersion: '17.5.0' }, occurrenceCount: 1, failing: false },
      { schema: 'mod_settings', location: 'migration', how: { kind: 'rmb', fromModuleVersion: '17.5.0' }, occurrenceCount: 3, failing: false }
    ]);
    expect(analysis.checklist.items[0].obligations).toEqual([
      { id: 'B011-C1#1', subject: `${DB}/migrate.sql: \${myuniversity}_mod_configuration.config_data`, path: `${DB}/migrate.sql`, line: 3, flag: 'manual' },
      { id: 'B011-C1#2', subject: `${DB}/migrate.sql: \${myuniversity}_mod_settings.settings`, path: `${DB}/migrate.sql`, line: 6, flag: 'manual' }
    ]);
  });

  it('fails on references in code and in an RMB script that runs on every install, before the migrations left to the reviewer', async () => {
    const { result, analysis } = await b011(rmbModule([
      { snippetPath: 'migrate.sql', fromModuleVersion: '17.5.0' },
      { snippetPath: 'functions.sql' },
      { snippetPath: 'views.sql' },
      { snippetPath: './views.sql', fromModuleVersion: '3.0.0' }
    ], {
      [`${DB}/migrate.sql`]: 'SELECT * FROM ${myuniversity}_mod_configuration.config_data;\n',
      [`${DB}/functions.sql`]: 'CREATE OR REPLACE VIEW users_view AS\n  SELECT * FROM ${myuniversity}_mod_users.users;\n',
      [`${DB}/views.sql`]: "SELECT * FROM pg_namespace WHERE nspname LIKE '%_mod_inventory_storage';\nSELECT format('%I.purchase_order', tenant_id || '_mod_orders_storage');\n",
      ...javaFile('  static final String SQL = "SELECT jsonb FROM %s_mod_users.users WHERE id = $1";\n  String name(String tenantId) { return tenantId + "_mod_orders_storage"; }')
    }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B011 fail: The module\'s code refers to other modules\' database schemas, which only FQM may read: '
      + 'src/main/java/org/example/Repository.java refers to "_mod_orders_storage at line 3 and %s_mod_users.users at line 2. '
      + 'RMB scripts that run on every install and upgrade (schema.json lists them without fromModuleVersion) refer to other modules\' database schemas: '
      + `${DB}/functions.sql refers to \${myuniversity}_mod_users.users at line 2; ${DB}/views.sql refers to %_mod_inventory_storage at line 1 and '_mod_orders_storage at line 2. `
      + `A migration refers to another module's database schema: ${DB}/migrate.sql (an RMB script that runs on a tenant's first install and on upgrades from versions before 17.5.0) `
      + 'refers to ${myuniversity}_mod_configuration.config_data at line 1.');
    expect(result.details?.split('\n')).toEqual([
      `Storage: RMB database schema ${DB}/schema.json`,
      'Own schema: <tenant>_mod_example',
      'Files read: 5 SQL scripts, changelogs and sources, with comments removed',
      'References in the module\'s code:',
      '  - src/main/java/org/example/Repository.java:3 — "_mod_orders_storage',
      '  - src/main/java/org/example/Repository.java:2 — %s_mod_users.users',
      'References in RMB scripts that run on every install and upgrade:',
      `  - ${DB}/functions.sql:2 — \${myuniversity}_mod_users.users`,
      `  - ${DB}/views.sql:1 — %_mod_inventory_storage`,
      `  - ${DB}/views.sql:2 — '_mod_orders_storage`,
      'References in migrations:',
      `  - ${DB}/migrate.sql:1 — \${myuniversity}_mod_configuration.config_data`,
      'How the migrations run:',
      `  - ${DB}/migrate.sql — an RMB script that runs on a tenant's first install and on upgrades from versions before 17.5.0`,
      'What to do:',
      '  - Read the data of other modules through their APIs instead of their database schemas, for each reference in the module\'s code or in an RMB script that runs on every install and upgrade; a one-time copy belongs in a migration (an RMB script with fromModuleVersion, or a Liquibase changeset).',
      'Checklist for the reviewer:',
      '  - B011-C1 Each reference to another module\'s database schema is unreachable, part of FQM, or an accepted one-time migration.',
      '    - Start with:',
      '      - src/main/java/org/example/Repository.java:3 — "_mod_orders_storage at line 3: in the module\'s code',
      '      - src/main/java/org/example/Repository.java:2 — %s_mod_users.users at line 2: in the module\'s code',
      `      - ${DB}/functions.sql:2 — \${myuniversity}_mod_users.users at line 2: in an RMB script that runs on every install and upgrade`,
      `      - ${DB}/views.sql:1 — %_mod_inventory_storage at line 1: in an RMB script that runs on every install and upgrade`,
      `      - ${DB}/views.sql:2 — '_mod_orders_storage at line 2: in an RMB script that runs on every install and upgrade`,
      `      - ${DB}/migrate.sql:1 — \${myuniversity}_mod_configuration.config_data at line 1: an RMB script that runs on a tenant's first install and on upgrades from versions before 17.5.0`
    ]);
    expect(analysis.references.map(reference => [reference.file.split('/').pop(), reference.schema, reference.location, reference.failing])).toEqual([
      ['Repository.java', 'mod_orders_storage', 'code', true],
      ['Repository.java', 'mod_users', 'code', true],
      ['functions.sql', 'mod_users', 'every-install-script', true],
      ['views.sql', 'mod_inventory_storage', 'every-install-script', true],
      ['views.sql', 'mod_orders_storage', 'every-install-script', true],
      ['migrate.sql', 'mod_configuration', 'migration', false]
    ]);
    expect(analysis.checklist.items[0].obligations.map(obligation => [obligation.id, obligation.flag])).toEqual([
      ['B011-C1#1', 'fail'], ['B011-C1#2', 'fail'], ['B011-C1#3', 'fail'], ['B011-C1#4', 'fail'], ['B011-C1#5', 'fail'], ['B011-C1#6', 'manual']
    ]);
  });

  it.each([
    ['String.format with %s', 'String.format("SELECT * FROM %s_mod_users.users", tenantId)', 'mod_users'],
    ['an indexed format specifier', 'String.format("%1$s_mod_users.users", tenantId)', 'mod_users'],
    ['a MessageFormat placeholder', 'MessageFormat.format("{0}_mod_users.users", tenantId)', 'mod_users'],
    ['a template placeholder', '"${tenant}_mod_users.users"', 'mod_users'],
    ['a concatenation', 'tenantId +  "_mod_users"', 'mod_users'],
    ['a text block', '"""\n  SELECT * FROM %s_mod_users.users\n  """', 'mod_users'],
    ['a module whose name the own name starts with', 'String.format("%s_mod_example.items", tenantId)', 'mod_example', 'mod-example-storage'],
    ['a module whose name starts with the own name', 'String.format("%s_mod_example_storage.items", tenantId)', 'mod_example_storage'],
    ['upper case', 'String.format("%s_MOD_USERS.users", tenantId)', 'mod_users']
  ])('fails on a reference in code through %s', async (_name, expression, schema, artifactId = 'mod-example') => {
    const { result, analysis } = await b011(rmbModule([], javaFile(`  Object sql = ${expression};`), artifactId));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(analysis.references.map(reference => [reference.schema, reference.location])).toEqual([[schema, 'code']]);
  });

  it.each([
    ['a line comment', '  // String.format("%s_mod_users.users", tenantId)'],
    ['a block comment', '  /* tenantId + "_mod_users" */'],
    ['a literal tenant', '  String sql = "SELECT * FROM diku_mod_users.users";'],
    ['the module\'s own schema', '  String sql = String.format("SELECT * FROM %s_mod_example.items", tenantId);'],
    ['a schema suffix that is not concatenated', '  String suffix = "_mod_users";']
  ])('passes with %s', async (_name, body) => {
    const { result, analysis } = await b011(rmbModule([], javaFile(body)));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B011 pass: No reference to another module\'s database schema was found in the 2 SQL script, changelog and source files the tool read, with comments removed.');
    expect(analysis.checklist.items).toEqual([]);
  });

  it.each([
    ['a schema name built at runtime', () => rmbModule([], javaFile('  String schema(String tenantId, String module) { return tenantId + "_mod_" + module; }')),
      'B011 manual: A schema name is built at runtime, so the tool cannot tell which module\'s schema it names: src/main/java/org/example/Repository.java refers to "_mod_ at line 2. A reviewer must check them.'],
    ['a script that schema.json does not list', () => rmbModule([], { [`${DB}/rename.sql`]: 'ALTER SCHEMA ${myuniversity}_mod_old_name RENAME TO ${myuniversity}_${mymodule};\n' }),
      `B011 manual: A script in templates/db_scripts that no readable schema.json lists refers to another module's database schema, so when it runs is not known: ${DB}/rename.sql refers to \${myuniversity}_mod_old_name at line 1. A reviewer must check them.`],
    ['an inline snippet in schema.json', () => repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      [`${DB}/schema.json`]: JSON.stringify({ scripts: [{ run: 'after', snippet: "SELECT format('%s_mod_users.users', current_user);" }] }, null, 2)
    }), `B011 manual: A file the tool cannot place as code or a migration refers to another module's database schema: ${DB}/schema.json refers to %s_mod_users.users at line 5. A reviewer must check them.`],
    ['a schema.json that is not valid JSON', () => repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      [`${DB}/schema.json`]: '{"scripts": [{"snippetPath": "functions.sql"}',
      [`${DB}/functions.sql`]: 'SELECT * FROM ${myuniversity}_mod_users.users;\n'
    }), `B011 manual: A script in templates/db_scripts that no readable schema.json lists refers to another module's database schema, so when it runs is not known: ${DB}/functions.sql refers to \${myuniversity}_mod_users.users at line 1. A reviewer must check them.`],
    ['another SQL resource', () => rmbModule([], {
      'src/main/resources/changelog.xml': '<databaseChangeLog/>\n',
      'src/main/resources/sql/report.sql': 'SELECT * FROM ${tenant}_mod_users.users;\n'
    }),
      'B011 manual: A file the tool cannot place as code or a migration refers to another module\'s database schema: src/main/resources/sql/report.sql refers to ${tenant}_mod_users.users at line 1. A reviewer must check them.'],
    ['a Liquibase changeset', () => springModule({
      'src/main/resources/db/changelog/changes/copy.sql': '--liquibase formatted sql\n--changeset folio:1\nINSERT INTO notes SELECT * FROM ${myuniversity}_mod_notes_old.notes;\n',
      'src/main/resources/db/changelog/changes/other.xml': '<databaseChangeLog><!--\n ${myuniversity}_mod_users.users\n --></databaseChangeLog>\n'
    }), 'B011 manual: A migration refers to another module\'s database schema: src/main/resources/db/changelog/changes/copy.sql (a Liquibase changelog, whose changesets run once per tenant) '
      + 'refers to ${myuniversity}_mod_notes_old.notes at line 3. A reviewer must decide whether this one-time migration is acceptable.'],
    ['a Grails database migration', () => repository({
      'service/build.gradle': '',
      'service/settings.gradle': 'rootProject.name = "mod-example"\n',
      'service/src/main/okapi/ModuleDescriptor-template.json': '{"id": "${info.app.name}-${info.app.version}"}',
      'service/grails-app/domain/org/example/Item.groovy': 'class Item {}\n',
      'service/grails-app/conf/application.yml': 'dataSource:\n  url: jdbc:postgresql://localhost/db\n',
      'service/grails-app/migrations/copy.groovy': 'databaseChangeLog = {\n  changeSet(author: "folio", id: "1") {\n    sql("INSERT INTO item SELECT * FROM ${tenant}_mod_users.users")\n  }\n}\n',
      'service/grails-app/services/org/example/ItemService.groovy': 'class ItemService { def q = "SELECT * FROM ${tenant}_mod_example.item" }\n'
    }), 'B011 manual: A migration refers to another module\'s database schema: service/grails-app/migrations/copy.groovy (a Grails database migration, which runs once per tenant) '
      + 'refers to ${tenant}_mod_users.users at line 3. A reviewer must decide whether this one-time migration is acceptable.']
  ])('leaves %s to the reviewer', async (_name, root, evidence) => {
    const { result, analysis } = await b011(root());

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe(evidence);
    expect(analysis.checklist.items.map(item => [item.id, item.reviewerOnly, item.obligations.length])).toEqual([['B011-C1', false, 1]]);
  });

  it('takes the module\'s own name from the descriptor id when there is no pom.xml', async () => {
    const { result } = await b011(repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0-SNAPSHOT"}',
      'service/grails-app/domain/org/example/Item.groovy': 'class Item {}\n',
      'service/grails-app/conf/application.yml': 'dataSource:\n  url: jdbc:postgresql://localhost/db\n',
      'service/grails-app/services/org/example/ItemService.groovy': 'class ItemService { def q = "SELECT * FROM ${tenant}_mod_example.item" }\n'
    }));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.details?.split('\n').slice(1, 4)).toEqual([
      'Own schema: <tenant>_mod_example',
      'Files read: 2 SQL scripts, changelogs and sources, with comments removed',
      'Own-schema references (not counted): 1'
    ]);
  });

  it('leaves references to the reviewer when the module\'s own name is not known', async () => {
    const { result, analysis } = await b011(repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': '{"id": "${info.app.name}-${info.app.version}"}',
      'service/grails-app/domain/org/example/Item.groovy': 'class Item {}\n',
      'service/grails-app/conf/application.yml': 'dataSource:\n  url: jdbc:postgresql://localhost/db\n',
      'service/grails-app/services/org/example/ItemService.groovy': 'class ItemService { def q = "SELECT * FROM ${tenant}_mod_example.item" }\n'
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B011 manual: The module\'s code refers to another module\'s database schema, which only FQM may read: '
      + 'service/grails-app/services/org/example/ItemService.groovy refers to ${tenant}_mod_example.item at line 1. '
      + 'The module\'s own name is not known (no pom.xml artifactId, descriptor id or Gradle project name), so the tool cannot tell whether these schemas are its own. A reviewer must check them.');
    expect(result.details?.split('\n').slice(1, 3)).toEqual([
      'Own schema: not known (no pom.xml artifactId, descriptor id or Gradle project name)',
      'Files read: 2 SQL scripts, changelogs and sources, with comments removed'
    ]);
    expect(analysis.checklist.items[0].startingPoints).toEqual([{ path: 'service/grails-app/services/org/example/ItemService.groovy', line: 1,
      note: '${tenant}_mod_example.item at line 1: the module\'s own name is not known' }]);
  });

  it.each([
    ['a module without storage evidence', () => repository({
      'pom.xml': pom('mod-example'),
      ...javaFile('  String sql = String.format("SELECT * FROM %s_mod_users.users", tenantId);')
    }), EvaluationStatus.NOT_APPLICABLE, 'no-storage', 'B011 not_applicable: No storage evidence was found, so the module has no database schema of its own.'],
    ['mod-fqm-manager', () => springModule({
      'pom.xml': pom('mod-fqm-manager'),
      ...javaFile('  String sql = String.format("SELECT * FROM %s_mod_users.users", tenantId);')
    }), EvaluationStatus.NOT_APPLICABLE, 'fqm', 'B011 not_applicable: The repository is mod-fqm-manager (FQM), which the criterion excepts.'],
    ['a library with storage', () => repository({
      'pom.xml': pom('folio-spring-base'),
      'tenant-settings/src/main/resources/db/tenant-settings/changelog.xml': '<databaseChangeLog/>\n',
      'tenant-settings/src/main/java/org/folio/Settings.java': 'class Settings { String sql = "SELECT * FROM %s_mod_settings.settings"; }\n'
    }), EvaluationStatus.FAIL, 'references-checked', 'B011 fail: The module\'s code refers to another module\'s database schema, which only FQM may read: '
      + 'tenant-settings/src/main/java/org/folio/Settings.java refers to %s_mod_settings.settings at line 1.'],
    ['a module without storage evidence whose source was not read completely', () => repository({
      'pom.xml': pom('mod-example'),
      'src/main/resources/data.json': `"${'x'.repeat(1024 * 1024)}"`
    }), EvaluationStatus.MANUAL, 'storage-not-known', 'B011 manual: No storage evidence was found, but the committed source was not read completely, so the tool cannot tell whether the module stores data. A reviewer must check the files it could not read.'],
    ['a module with storage whose source was not read completely', () => rmbModule([], { 'src/main/resources/data.json': `"${'x'.repeat(1024 * 1024)}"` }),
      EvaluationStatus.MANUAL, 'references-checked', 'B011 manual: The committed source was not read completely, so the tool may have missed references. A reviewer must check them.'],
    ['a failing reference in source that was not read completely', () => rmbModule([], {
      'src/main/resources/data.json': `"${'x'.repeat(1024 * 1024)}"`,
      ...javaFile('  String sql = "%s_mod_users";')
    }), EvaluationStatus.FAIL, 'references-checked', 'B011 fail: The module\'s code refers to another module\'s database schema, which only FQM may read: '
      + 'src/main/java/org/example/Repository.java refers to %s_mod_users at line 2. The committed source was not read completely, so the tool may have missed references.']
  ])('decides %s', async (_name, root, status, basis, evidence) => {
    const { result, analysis } = await b011(root());

    expect(result.status).toBe(status);
    expect(analysis.basis).toBe(basis);
    expect(result.evidence).toBe(evidence);
  });

  it.each([
    ['a nested block comment', '/* outer /* inner */ SELECT * FROM ${myuniversity}_mod_users.users; */\nSELECT 1;\n', EvaluationStatus.PASS],
    ['an escaped quote in an E string', "SELECT E'it\\'s';\nSELECT '--', * FROM ${myuniversity}_mod_users.users;\n", EvaluationStatus.FAIL],
    ['a backslash in a plain string', "SELECT 'C:\\';\n-- ${myuniversity}_mod_users.users\n", EvaluationStatus.PASS],
    ['a quote inside a comment', "-- don't\nSELECT * FROM ${myuniversity}_mod_users.users;\n", EvaluationStatus.FAIL]
  ])('reads SQL with %s', async (_name, sql, status) => {
    const { result } = await b011(rmbModule([{ snippetPath: 'functions.sql' }], { [`${DB}/functions.sql`]: sql }));

    expect(result.status).toBe(status);
  });

  it('removes YAML comments only in YAML files', async () => {
    const { result, analysis } = await b011(rmbModule([], {
      'src/main/resources/db/queries.yml': 'query: "SELECT 1" # ${tenant}_mod_users.users\n#${tenant}_mod_users.users\nother: "a#${tenant}_mod_orders.x"\n',
      'src/main/resources/sql/report.sql': 'SELECT 1; # ${tenant}_mod_notes.notes\n'
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.references.map(reference => [reference.file, reference.schema])).toEqual([
      ['src/main/resources/db/queries.yml', 'mod_orders'],
      ['src/main/resources/sql/report.sql', 'mod_notes']
    ]);
  });

  it('reads scripts schema.json lists whatever their extension, keeping an every-install listing whichever comes first', async () => {
    const { result, analysis } = await b011(rmbModule([
      { snippetPath: 'views.ftl', fromModuleVersion: 3 as unknown as string },
      { snippetPath: 'functions.sql', fromModuleVersion: '2.0.0' },
      { snippetPath: 'functions.sql' }
    ], {
      [`${DB}/views.ftl`]: 'SELECT * FROM ${myuniversity}_mod_users.users;\n',
      [`${DB}/functions.sql`]: 'SELECT * FROM ${myuniversity}_mod_orders.orders;\n',
      [`${DB}/notes.ftl`]: 'SELECT * FROM ${myuniversity}_mod_notes.notes;\n'
    }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(analysis.references.map(reference => [reference.file.split('/').pop(), reference.location, reference.migration])).toEqual([
      ['functions.sql', 'every-install-script', undefined],
      ['views.ftl', 'migration', { kind: 'rmb', fromModuleVersion: '3' }]
    ]);
  });

  it('takes only a file with databaseChangeLog as a Liquibase changelog', async () => {
    const { analysis } = await b011(rmbModule([], {
      'src/main/resources/api/schemas/changelogEntry.yaml': 'type: object\n',
      'src/main/resources/api/schemas/run.sql': 'SELECT * FROM ${tenant}_mod_users.users;\n'
    }));

    expect(analysis.references.map(reference => [reference.file, reference.location])).toEqual([['src/main/resources/api/schemas/run.sql', 'other-file']]);
  });

  it('reads a concatenation split across lines', async () => {
    const { analysis } = await b011(rmbModule([], javaFile('  String a = tenantId +\n      "_mod_orders";\n  String b = tenantId\n      + "_mod_users";')));

    expect(analysis.references.map(reference => [reference.schema, reference.occurrences])).toEqual([
      ['mod_orders', [{ line: 3, text: '"_mod_orders' }]],
      ['mod_users', [{ line: 5, text: '"_mod_users' }]]
    ]);
  });

  it('counts the schema of a module the descriptor replaces as the module\'s own', async () => {
    const { result, analysis } = await b011(repository({
      'pom.xml': pom('mod-di-converter-storage', restVerticleBuild),
      'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: '${artifactId}-1.0.0', replaces: ['mod-data-import-converter-storage', 'inventory-storage', 7] }),
      [`${DB}/schema.json`]: '{"tables": []}',
      [`${DB}/rename.sql`]: 'ALTER SCHEMA ${myuniversity}_mod_data_import_converter_storage RENAME TO ${myuniversity}_${mymodule};\n'
    }));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(analysis.ownSchemas).toEqual(['mod_di_converter_storage', 'mod_data_import_converter_storage']);
    expect(analysis.ownSchemaReferences).toBe(1);
  });

  it.each([
    ['an unresolved build placeholder', '@artifactId@-@version@'],
    ['characters a schema name cannot have', 'mod example-1.0.0']
  ])('does not take a descriptor id with %s as the module\'s own name', async (_name, id) => {
    const { result } = await b011(repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': JSON.stringify({ id }),
      'service/grails-app/domain/org/example/Item.groovy': 'class Item {}\n',
      'service/grails-app/conf/application.yml': 'dataSource:\n  url: jdbc:postgresql://localhost/db\n',
      'service/grails-app/services/org/example/ItemService.groovy': 'class ItemService { def q = "SELECT * FROM ${tenant}_mod_example.item" }\n'
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details?.split('\n')[1]).toBe('Own schema: not known (no pom.xml artifactId, descriptor id or Gradle project name)');
  });

  it.each([
    ['descriptor id', { 'descriptors/ModuleDescriptor-template.json': '{"id": "mod-fqm-manager-4.0.0"}' }],
    ['Gradle project name', { 'settings.gradle': "rootProject.name = 'mod-fqm-manager'\n" }]
  ])('recognises mod-fqm-manager by its %s', async (_name, files) => {
    const { analysis } = await b011(repository({
      'build.gradle': '',
      'src/main/resources/db/changelog/changelog-master.xml': '<databaseChangeLog/>\n',
      ...javaFile('  String sql = "%s_mod_users";'),
      ...files
    }));

    expect(analysis.basis).toBe('fqm');
  });

  it('lists references it cannot place, runtime-built names and unreadable schema files in their own sections', async () => {
    const { result } = await b011(repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      [`${DB}/schema.json`]: '{"scripts": [',
      [`${DB}/rename.sql`]: 'ALTER SCHEMA ${myuniversity}_mod_old RENAME TO ${myuniversity}_${mymodule};\n',
      'src/main/resources/sql/report.sql': 'SELECT * FROM ${tenant}_mod_users.users;\n',
      ...javaFile('  String schema(String tenantId, String module) { return tenantId + "_mod_" + module; }')
    }));

    expect(result.details?.split('\n').slice(3, 14)).toEqual([
      'References in scripts no readable schema.json lists:',
      `  - ${DB}/rename.sql:1 — \${myuniversity}_mod_old`,
      'References in other files:',
      '  - src/main/resources/sql/report.sql:1 — ${tenant}_mod_users.users',
      'Schema names built at runtime:',
      '  - src/main/java/org/example/Repository.java:2 — "_mod_',
      'RMB schema files the tool could not read:',
      `  - ${DB}/schema.json — Unexpected end of JSON input`,
      'Checklist for the reviewer:',
      '  - B011-C1 Each reference to another module\'s database schema is unreachable, part of FQM, or an accepted one-time migration.',
      '    - Start with:'
    ]);
  });

  it('cuts long reference lists with an overflow row', async () => {
    const { result } = await b011(rmbModule([{ snippetPath: 'migrate.sql', fromModuleVersion: '1.0.0' }],
      { [`${DB}/migrate.sql`]: Array.from({ length: 25 }, (_item, index) => `SELECT * FROM \${myuniversity}_mod_a${index}.t;`).join('\n') }));
    const lines = result.details!.split('\n');
    const start = lines.indexOf('References in migrations:');

    expect(lines.slice(start + 20, start + 23)).toEqual([`  - ${DB}/migrate.sql:5 — \${myuniversity}_mod_a4.t`, '  - ... 5 more', 'How the migrations run:']);
  });

  it('lists the files it could not read for the reviewer', async () => {
    const { result } = await b011(rmbModule([], { 'src/main/resources/data.json': `"${'x'.repeat(1024 * 1024)}"` }));

    expect(result.details?.split('\n').slice(3)).toEqual([
      'What the tool could not read:',
      '  - src/main/resources/data.json — Committed file exceeds the 1048576-byte per-file limit',
      'Checklist for the reviewer:',
      '  - B011-C2 The files the tool could not read refer to no other module\'s database schema.',
      '    - Start with:',
      '      - src/main/resources/data.json — Committed file exceeds the 1048576-byte per-file limit',
      'Agent review:',
      '  - Not applied: only the files the tool could not read remain, and the reviewer checks those'
    ]);
  });

  it('scans comments, placeholders, concatenations and file locations in linear time', async () => {
    const evidence = async (size: number) => {
      const root = rmbModule(
        [...Array.from({ length: size }, (_item, index) => ({ snippetPath: `s${index}.sql`, ...(index % 2 ? { fromModuleVersion: '1.0.0' } : {}) })),
          ...Array.from({ length: size }, (_item, index) => ({ snippetPath: `m${index}.sql`, fromModuleVersion: '1.0.0' }))],
        {
          [`${DB}/s0.sql`]: `${'${'.repeat(size * 20)}\n${'{'.repeat(size * 20)}a}\n${'%'.repeat(size * 20)}\n${'+ \t'.repeat(size * 20)}\n${'|| '.repeat(size * 20)}\n`
            + `${'_mod_'.repeat(size * 20)}\n${'<!--'.repeat(size * 20)}`,
          [`${DB}/s1.sql`]: `${"'".repeat(size * 20 + 1)}\n${'/*'.repeat(size * 20)}`,
          [`${DB}/s2.sql`]: `${'-- ${myuniversity}_mod_users\n'.repeat(size * 10)}${'SELECT * FROM ${myuniversity}_mod_users.users;\n'.repeat(size * 10)}`,
          [`${DB}/s3.sql`]: `${"E'".repeat(size * 20)}\n${"E'\\".repeat(size * 20)}\n${'/* /*'.repeat(size * 20)}`,
          ...Object.fromEntries(Array.from({ length: size }, (_item, index) => [`${DB}/m${index}.sql`, `SELECT * FROM \${myuniversity}_mod_a${index}.t;\n`])),
          'src/main/resources/q.yml': `${' #'.repeat(size * 20)}\n${'#'.repeat(size * 20)}`,
          'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: `${'-1'.repeat(size * 200)}\nx` }),
          'settings.gradle': `${'\n'.repeat(size * 100)}${' rootProject.name'.repeat(size * 20)}`,
          'src/main/java/org/example/Repository.java': `class Repository {\n${'String.format("%s_mod_users", t); // %s_mod_users\n'.repeat(size * 10)}${'"'.repeat(size * 20)}\n}\n`
        });
      return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
    };

    const { analysis, details } = await expectLinearTime(100, evidence, async backendEvidence => {
      const result = evaluateB011(backendEvidence);
      return { analysis: result, details: renderB011HumanDetails(result) };
    });

    expect(analysis.status).toBe(EvaluationStatus.FAIL);
    expect(analysis.ownSchemas).toEqual(['mod_example']);
    expect(analysis.references.filter(reference => reference.schema === 'mod_users')
      .map(reference => [reference.file.split('/').pop(), reference.occurrenceCount, reference.occurrences.length])).toEqual([
      ['Repository.java', 4_000, 100],
      ['s2.sql', 4_000, 100]
    ]);
    expect(analysis.references.filter(reference => reference.location === 'migration')).toHaveLength(400);
    expect(details.split('\n').filter(line => line.startsWith('  - ... '))).toEqual(['  - ... 3980 more', '  - ... 3980 more', '  - ... 380 more', '  - ... 380 more']);
  }, 120_000);
});
