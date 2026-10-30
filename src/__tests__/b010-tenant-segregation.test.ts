import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B010Analysis, EvaluationStatus } from '../types';
import { evaluateB010 } from '../utils/b010-tenant-segregation';
import { getBackendEvidence } from '../utils/backend-evidence';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b010(root: string) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
  const result = await new BackendEvaluator().evaluateCriterion('B010', root, run);
  return { result, analysis: result.criterionDetails as B010Analysis };
}

const descriptor = { 'descriptors/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0", "provides": []}' };
const rmbSchema = { 'src/main/resources/templates/db_scripts/schema.json': '{"tables": []}' };

const ITEMS_API = 'src/main/java/org/folio/rest/impl/ItemsApi.java';
const SETTINGS_SQL = 'src/main/resources/templates/db_scripts/settings.sql';

describe('B010 tenant data segregation', () => {
  it('lists the RMB mechanism and the places that may share data, leaving the decision to the reviewer', async () => {
    const { result, analysis } = await b010(repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      ...descriptor,
      ...rmbSchema,
      [SETTINGS_SQL]: [
        '-- INSERT INTO public.commented (id) VALUES (1);',
        'CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;',
        'CREATE SCHEMA IF NOT EXISTS ${myuniversity}_${mymodule};',
        'CREATE TABLE IF NOT EXISTS ${myuniversity}_${mymodule}.settings (id uuid DEFAULT public.uuid_generate_v4());',
        '/* CREATE SCHEMA hidden; */',
        'SELECT \'a--b\'; CREATE SCHEMA shared_data;',
        'CREATE TABLE IF NOT EXISTS public.shared_settings (id uuid);',
        'DROP FUNCTION IF EXISTS public.old_function();'
      ].join('\n'),
      [ITEMS_API]: [
        'package org.folio.rest.impl;',
        'class ItemsApi {',
        '  void a(Context vertxContext, String tenantId) {',
        '    PostgresClient.getInstance(vertxContext.owner(), tenantId).save("items", item, handler);',
        '  }',
        '  void b(Vertx vertx) {',
        '    // PostgresClient.getInstance(vertx).startPostgresTester();',
        '    PostgresClient.getInstance(vertx).execute("SELECT (1)", handler);',
        '  }',
        '  void c(Vertx vertx) {',
        '    PostgresClient.getInstance(vertx, "diku").get("items", Item.class, handler);',
        '  }',
        '  void d(Map<String, String> okapiHeaders) {',
        '    PgUtil.post(ItemsResource.class, entity, okapiHeaders, vertxContext, handler);',
        '  }',
        '}'
      ].join('\n')
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.basis).toBe('storage');
    expect(result.evidence).toBe('B010 manual: The module stores data with RMB\'s PostgresClient, which keeps each tenant in its own schema. '
      + 'The tool found 4 places where tenant data may be stored outside a tenant\'s schema: '
      + `PostgresClient.getInstance(vertx) has no tenant id, so RMB connects it to the shared public schema (${ITEMS_API}:8), `
      + `PostgresClient.getInstance with the fixed tenant id "diku" (${ITEMS_API}:11), `
      + `the schema shared_data has a fixed name, so all tenants share it (${SETTINGS_SQL}:6), `
      + `and CREATE TABLE IF NOT EXISTS public.shared_settings is in the public schema, which all tenants share (${SETTINGS_SQL}:7). A reviewer must confirm.`);
    expect(result.details?.split('\n')).toEqual([
      'Storage: found',
      '  - RMB database schema src/main/resources/templates/db_scripts/schema.json',
      `  - PostgresClient or PgUtil used in ${ITEMS_API}`,
      'Tenant-schema mechanism: found',
      '  - src/main/resources/templates/db_scripts/schema.json — RMB database schema; RMB creates these tables in each tenant\'s own schema',
      `  - ${ITEMS_API}:4 — PostgresClient.getInstance with a tenant id: 1 call in 1 file`,
      `  - ${ITEMS_API}:14 — PgUtil, which takes the tenant from the request's Okapi headers: used in 1 file`,
      'Places where tenant data may be stored outside a tenant\'s schema: found',
      `  - ${ITEMS_API}:8 — PostgresClient.getInstance(vertx) has no tenant id, so RMB connects it to the shared public schema`,
      `  - ${ITEMS_API}:11 — PostgresClient.getInstance with the fixed tenant id "diku"`,
      `  - ${SETTINGS_SQL}:6 — the schema shared_data has a fixed name, so all tenants share it`,
      `  - ${SETTINGS_SQL}:7 — CREATE TABLE IF NOT EXISTS public.shared_settings is in the public schema, which all tenants share`,
      'Checklist for the reviewer:',
      '  - B010-C1 Every table the module writes is in a per-tenant schema.',
      '    - Start with:',
      '      - src/main/resources/templates/db_scripts/schema.json — RMB database schema; RMB creates these tables in each tenant\'s own schema',
      `      - ${ITEMS_API}:4 — PostgresClient.getInstance with a tenant id: 1 call in 1 file`,
      `      - ${ITEMS_API}:14 — PgUtil, which takes the tenant from the request's Okapi headers: used in 1 file`,
      '  - B010-C2 Each place listed stores no tenant data in a schema, table or connection that tenants share.',
      '    - Start with:',
      `      - ${ITEMS_API}:8 — PostgresClient.getInstance(vertx) has no tenant id, so RMB connects it to the shared public schema`,
      `      - ${ITEMS_API}:11 — PostgresClient.getInstance with the fixed tenant id "diku"`,
      `      - ${SETTINGS_SQL}:6 — the schema shared_data has a fixed name, so all tenants share it`,
      `      - ${SETTINGS_SQL}:7 — CREATE TABLE IF NOT EXISTS public.shared_settings is in the public schema, which all tenants share`,
      '  - B010-C3 Caches and files that hold tenant data are keyed by tenant.',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
    expect(analysis.checklist.items.map(item => [item.id, item.reviewerOnly, item.obligations])).toEqual([
      ['B010-C1', false, [{ id: 'B010-C1#1' }]],
      ['B010-C2', false, [
        { id: 'B010-C2#1', subject: ITEMS_API, path: ITEMS_API, line: 8, flag: 'manual' },
        { id: 'B010-C2#2', subject: SETTINGS_SQL, path: SETTINGS_SQL, line: 6, flag: 'manual' }
      ]],
      ['B010-C3', false, [{ id: 'B010-C3#1' }]]
    ]);
  });

  it('flags fixed schemas and connections the code creates itself in a folio-spring-base module', async () => {
    const { result, analysis } = await b010(repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('folio-spring-base')}</dependencies>`),
      ...descriptor,
      'src/main/resources/db/changelog/a-changelog.xml': '<databaseChangeLog/>',
      'src/main/resources/db/changelog/changelog-master.xml': '<databaseChangeLog><include file="changes/v1.0.xml" relativeToChangelogFile="true"/></databaseChangeLog>',
      'src/main/resources/db/changelog/changes/v1.0.xml': [
        '<databaseChangeLog>',
        '  <!-- <createTable tableName="old" schemaName="commented"/> -->',
        '  <changeSet id="1" author="a">',
        '    <sql>CREATE SCHEMA IF NOT EXISTS mod_example__system;</sql>',
        '    <createTable tableName="note" schemaName="${database.defaultSchemaName}"/>',
        '    <createTable tableName="known_tenant" schemaName="mod_example__system"/>',
        '  </changeSet>',
        '  <changeSet id="a--1" author="x"><sql>INSERT INTO public.audit VALUES (1)</sql></changeSet>',
        '  <includeAll path="db/*/"/>',
        '  <changeSet id="2" author="x"><comment>tenant\'s</comment> <!-- <sql>INSERT INTO public.hidden VALUES (1)</sql> --></changeSet>',
        '  <changeSet id="3" author="x"><sql>-- INSERT INTO public.commented VALUES (1)\n      UPDATE public.counter SET n = n + 1</sql></changeSet>',
        '</databaseChangeLog>'
      ].join('\n'),
      'src/main/resources/db/changelog/changes/v2.0.json': '{"databaseChangeLog": [{"changeSet": {"id": "v2--1", "changes": [{"createTable": {"schemaName": "shared_json", "tableName": "t"}}]}}]}',
      'src/main/resources/application.yml': 'folio:\n  system:\n    schemaName: not_a_changelog\n',
      'src/main/java/org/folio/example/Note.java': '@Entity\n@Table(name = "note")\nclass Note {}\n@Table(name = "shared_note", schema = "shared", indexes = {@Index(columnList = "a")})\nclass SharedNote {}\n',
      'src/main/java/org/folio/example/ReportConfig.java': [
        'class ReportConfig {',
        '  DataSource reportDataSource() {',
        '    return DataSourceBuilder.create().url(url).build();',
        '  }',
        '  // DataSource old() { return new HikariDataSource(config); }',
        '  Pool reportPool() { return PgBuilder.pool().connectingTo(options).build(); }',
        '}'
      ].join('\n')
    }));

    expect(result.evidence).toBe('B010 manual: The module stores data with folio-spring-base, which sets each database connection to the tenant\'s schema. '
      + 'The tool found 7 places where tenant data may be stored outside a tenant\'s schema: '
      + 'the schema shared has a fixed name, so all tenants share it (src/main/java/org/folio/example/Note.java:4), '
      + 'DataSourceBuilder.create creates its own database connection, outside the framework\'s per-tenant connection (src/main/java/org/folio/example/ReportConfig.java:3), '
      + 'PgBuilder.pool creates its own database connection, outside the framework\'s per-tenant connection (src/main/java/org/folio/example/ReportConfig.java:6), and 4 more. A reviewer must confirm.');
    expect(analysis.redFlags.slice(3).map(flag => [flag.kind, `${flag.path}:${flag.line}`, flag.text])).toEqual([
      ['fixed-schema', 'src/main/resources/db/changelog/changes/v1.0.xml:4', 'mod_example__system'],
      ['public-schema', 'src/main/resources/db/changelog/changes/v1.0.xml:8', 'INSERT INTO public.audit'],
      ['public-schema', 'src/main/resources/db/changelog/changes/v1.0.xml:12', 'UPDATE public.counter'],
      ['fixed-schema', 'src/main/resources/db/changelog/changes/v2.0.json:1', 'shared_json']
    ]);
    expect(analysis.mechanisms).toEqual([{ name: 'folio-spring-base', evidence: [
      { path: 'pom.xml', note: 'folio-spring-base, whose DataSource sets each connection\'s search_path to the request tenant\'s schema' },
      { path: 'src/main/resources/db/changelog/changelog-master.xml', note: 'Liquibase changelog, which folio-spring-base runs in each tenant\'s schema' }
    ] }]);
  });

  it('checks Grails domain classes through their superclasses and reads the multi-tenancy mode', async () => {
    const { result, analysis } = await b010(repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0", "provides": []}',
      'service/grails-app/conf/application.yml': [
        'dataSource:',
        '  url: jdbc:postgresql://localhost/db',
        'grails:',
        '  gorm:',
        '    multiTenancy:',
        '      # mode: DISCRIMINATOR',
        '      mode: SCHEMA',
        '      tenantResolverClass: com.k_int.okapi.OkapiTenantResolver',
        '  mode: DISCRIMINATOR'
      ].join('\n'),
      'service/grails-app/conf/application-shared.yml': '# grails.gorm.multiTenancy.mode: DATABASE\ngrails.gorm.multiTenancy.mode: DISCRIMINATOR\n',
      'service/grails-app/conf/application.groovy': '// grails.gorm.multiTenancy.mode = "DISCRIMINATOR"\n/* grails.gorm.multiTenancy.mode = "DISCRIMINATOR" */\n',
      'service/grails-app/conf/runtime.properties': '! grails.gorm.multiTenancy.mode=DISCRIMINATOR\n',
      'service/src/main/groovy/org/example/Tenanted.groovy': 'package org.example\ntrait Tenanted implements MultiTenant<Tenanted> {}\n',
      'service/grails-app/domain/org/example/Note.groovy': 'package org.example\nclass Note implements Tenanted, Serializable {\n}\n',
      'service/grails-app/domain/org/other/Agreement.groovy': 'package org.other\nclass Agreement {\n}\n',
      'service/grails-app/services/org/example/LegacyService.groovy': 'class LegacyService { def client() { PostgresClient.getInstance(vertx, \'diku\') } }\n',
      'service/grails-app/domain/org/example/Agreement.groovy': 'package org.example\nimport grails.gorm.MultiTenant\nclass Agreement implements MultiTenant<Agreement> {\n  String name\n}\n',
      'service/grails-app/domain/org/example/Licence.groovy': 'package org.example\nclass Licence extends org.example.Agreement {\n}\n',
      'service/grails-app/domain/org/example/Refdata.groovy': 'package org.example\n// class Commented {}\nclass Refdata extends com.k_int.RefdataValue {\n  String label\n}\nenum Status { OPEN, CLOSED }\n'
    }));

    expect(result.evidence).toBe('B010 manual: The module stores data with GORM multi-tenancy, which keeps each tenant in its own schema or database. '
      + 'The tool found 4 places where tenant data may be stored outside a tenant\'s schema: '
      + 'GORM multi-tenancy in DISCRIMINATOR mode keeps all tenants in shared tables (service/grails-app/conf/application-shared.yml:2), '
      + 'the domain class Refdata does not implement MultiTenant (service/grails-app/domain/org/example/Refdata.groovy:3), '
      + 'the domain class Agreement does not implement MultiTenant (service/grails-app/domain/org/other/Agreement.groovy:2), '
      + 'and PostgresClient.getInstance with the fixed tenant id \'diku\' (service/grails-app/services/org/example/LegacyService.groovy:1). A reviewer must confirm.');
    expect(analysis.mechanisms).toEqual([{ name: 'grails', evidence: [
      { path: 'service/grails-app/conf/application.yml', line: 7, note: 'GORM multi-tenancy in SCHEMA mode: one schema per tenant' },
      { path: 'service/grails-app/domain/org/example/Agreement.groovy', line: 3, note: '3 of 5 domain classes implement MultiTenant' }
    ] }]);
  });

  it('claims no schema separation for MultiTenant domain classes without a schema or database mode', async () => {
    const { result } = await b010(repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': '{"id": "mod-example-1.0.0", "provides": []}',
      'service/grails-app/conf/application.yml': 'dataSource:\n  url: jdbc:postgresql://localhost/db\ngrails:\n  gorm:\n    multiTenancy:\n      mode: DISCRIMINATOR\n',
      'service/grails-app/domain/org/example/Agreement.groovy': 'class Agreement implements MultiTenant<Agreement> {}\n'
    }));

    expect(result.evidence).toBe('B010 manual: The module stores data with GORM MultiTenant domain classes, but the tool found no multi-tenancy mode that keeps each tenant in its own schema or database. '
      + 'The tool found 1 place where tenant data may be stored outside a tenant\'s schema: '
      + 'GORM multi-tenancy in DISCRIMINATOR mode keeps all tenants in shared tables (service/grails-app/conf/application.yml:6). A reviewer must confirm.');
  });

  it('gives the agent the whole-module items before the flagged files, and counts every unread call', async () => {
    const shared = Object.fromEntries(Array.from({ length: 30 }, (_item, index) =>
      [`src/main/java/org/folio/rest/impl/Api${String(index).padStart(2, '0')}.java`, 'class Api { void a() { PostgresClient.getInstance(vertx).execute(sql, h); } }']));
    const { result, analysis } = await b010(repository({
      'pom.xml': pom('mod-example', restVerticleBuild), ...descriptor, ...rmbSchema, ...shared,
      'src/main/java/org/folio/rest/impl/Unread.java': `class Unread { void a() {\n${`PostgresClient.getInstance(vertx, ${'x'.repeat(2_000)}\n`.repeat(150)}`
    }));
    const obligations = analysis.checklist.items.flatMap(item => item.obligations);

    expect(obligations.filter(obligation => !obligation.withheld).map(obligation => obligation.id)).toEqual([
      'B010-C1#1', ...Array.from({ length: 23 }, (_item, index) => `B010-C2#${index + 1}`), 'B010-C3#1']);
    expect(obligations.filter(obligation => obligation.withheld).map(obligation => obligation.id)).toEqual(
      Array.from({ length: 8 }, (_item, index) => `B010-C2#${index + 24}`));
    const lines = result.details!.split('\n');
    const start = lines.indexOf('PostgresClient.getInstance calls the tool could not read:');
    expect(lines.slice(start, start + 3)).toEqual([
      'PostgresClient.getInstance calls the tool could not read:',
      '  - src/main/java/org/folio/rest/impl/Unread.java:2',
      '  - src/main/java/org/folio/rest/impl/Unread.java:3'
    ]);
    expect(lines.slice(start + 20, start + 22)).toEqual([
      '  - src/main/java/org/folio/rest/impl/Unread.java:21',
      '  - ... 130 more'
    ]);
    expect(analysis.unreadClientCallCount).toBe(150);
  });

  it.each([
    ['a Vert.x module that depends on domain-models-runtime only for logging',
      { 'pom.xml': pom('mod-example', `<dependencies>${dependency('domain-models-runtime')}</dependencies>`), ...descriptor,
        'src/main/java/org/folio/example/ExampleVerticle.java': 'class ExampleVerticle extends AbstractVerticle {}' },
      EvaluationStatus.NOT_APPLICABLE, 'no-storage', 'B010 not_applicable: The module stores no data: the tool found no RMB database schema, PostgresClient or PgUtil use, '
        + 'Liquibase changelog, datasource configuration, or Grails domain classes with a datasource.'],
    ['an edge module',
      { 'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`), ...descriptor },
      EvaluationStatus.NOT_APPLICABLE, 'no-storage', 'B010 not_applicable: The edge module stores no data: the tool found no RMB database schema, PostgresClient or PgUtil use, '
        + 'Liquibase changelog, datasource configuration, or Grails domain classes with a datasource.'],
    ['a shared library with a Liquibase changelog',
      { 'pom.xml': pom('folio-spring-base'), 'folio-spring-tenant-settings/src/main/resources/db/tenant-settings/changelog.xml': '<databaseChangeLog/>' },
      EvaluationStatus.MANUAL, 'storage', 'B010 manual: The library stores data with folio-spring-base, which sets each database connection to the tenant\'s schema; '
        + 'no shared-schema use was found. A reviewer must confirm.'],
    ['a repository that is neither a module nor a known library, with an RMB schema',
      { 'pom.xml': pom('mod-example'), ...rmbSchema },
      EvaluationStatus.MANUAL, 'storage', 'B010 manual: The repository stores data with RMB\'s PostgresClient, which keeps each tenant in its own schema; '
        + 'no shared-schema use was found. A reviewer must confirm.'],
    ['a Spring module with a datasource but no folio-spring-base',
      { 'pom.xml': pom('mod-example'), ...descriptor, 'src/main/resources/application.yml': 'spring:\n  datasource:\n    url: jdbc:postgresql://localhost/db\n' },
      EvaluationStatus.MANUAL, 'storage', 'B010 manual: The module stores data, but the tool found no tenant-schema mechanism it knows: '
        + 'RMB\'s PostgresClient, folio-spring-base or GORM multi-tenancy. A reviewer must confirm.'],
    ['a module without storage evidence whose committed source was not read completely',
      { 'pom.xml': pom('mod-example'), ...descriptor, 'src/main/resources/data.json': `"${'x'.repeat(1024 * 1024)}"` },
      EvaluationStatus.MANUAL, 'storage-unconfirmed', 'B010 manual: The tool found no storage evidence, but the committed source was not read completely, '
        + 'so it could not confirm that the module stores no data. A reviewer must confirm.'],
    ['a module with storage whose committed source was not read completely',
      { 'pom.xml': pom('mod-example', restVerticleBuild), ...descriptor, ...rmbSchema, 'src/main/resources/data.json': `"${'x'.repeat(1024 * 1024)}"` },
      EvaluationStatus.MANUAL, 'storage', 'B010 manual: The module stores data with RMB\'s PostgresClient, which keeps each tenant in its own schema; '
        + 'no shared-schema use was found. The committed source was not read completely, so the tool may have missed some. A reviewer must confirm.'],
    ['a PostgresClient call whose arguments do not end',
      { 'pom.xml': pom('mod-example', restVerticleBuild), ...descriptor, ...rmbSchema,
        [ITEMS_API]: `class ItemsApi { void a() { PostgresClient.getInstance(vertx, ${'x'.repeat(2_500)}` },
      EvaluationStatus.MANUAL, 'storage', 'B010 manual: The module stores data with RMB\'s PostgresClient, which keeps each tenant in its own schema. '
        + 'The tool could not read the arguments of 1 PostgresClient.getInstance call, so it could not check that it passes a tenant id. A reviewer must confirm.']
  ])('decides %s', async (_name, files, status, basis, evidence) => {
    const { result, analysis } = await b010(repository(files));

    expect(result.status).toBe(status);
    expect(analysis.basis).toBe(basis);
    expect(result.evidence).toBe(evidence);
    if (status === EvaluationStatus.NOT_APPLICABLE) {
      expect(result.details).toBe('Storage: none found');
      expect(analysis.checklist.items).toEqual([]);
    }
  });

  it('scans sources, SQL, changelogs and Grails classes in linear time', async () => {
    const evidence = async (size: number) => {
      const root = repository({
        'pom.xml': pom('mod-example', restVerticleBuild),
        ...descriptor,
        ...rmbSchema,
        'src/main/resources/templates/db_scripts/a.sql': [
          `CREATE${' '.repeat(size * 100)}x;`,
          `${'CREATE OR REPLACE '.repeat(size * 20)}TABLE public.t1 (id int);`,
          `CREATE SCHEMA ${'a'.repeat(size * 100)}$;`,
          `CREATE UNIQUE INDEX ${'i'.repeat(size * 100)} ${'O'.repeat(size * 100)};`,
          `${'<!--'.repeat(size * 20)}`,
          `${'\'--'.repeat(size * 50)}`,
          `${'/*'.repeat(size * 50)}`
        ].join('\n'),
        'src/main/resources/db/changelog-master.yaml': `databaseChangeLog:\n${'  - schemaName: "'.repeat(size * 20)}\n${'schemaName: \''.repeat(size * 50)}\n# ${'#'.repeat(size * 100)}\n`,
        [ITEMS_API]: [
          `class ItemsApi { ${'PostgresClient.getInstance(('.repeat(size * 5)}`,
          `${'PgUtil.'.repeat(size * 50)}${'a'.repeat(size * 100)}`,
          ...Array.from({ length: size }, (_item, index) => `PostgresClient.getInstance(vertx, tenant${index}); INSERT INTO public.t${index} VALUES (1);`)
        ].join('\n'),
        'src/main/java/org/folio/example/Tables.java': `${'@Table('.repeat(size * 50)}\n${'@Table(a = ('.repeat(size * 50)}\n${'@Table(schema = "s", (x)'.repeat(size * 20)}`,
        'src/main/java/org/folio/example/Pools.java': `${'new '.repeat(size * 50)}${'DataSourceBuilder.'.repeat(size * 50)}${'PgBuilder . '.repeat(size * 50)}`,
        'grails-app/conf/application.yml': `${'multiTenancy:\n  mode: SCHEMA\n'.repeat(size * 5)}${'multiTenancy.mode='.repeat(size * 20)}\n${' #'.repeat(size * 50)}\n`,
        'grails-app/domain/org/example/Many.groovy': `${'class A extends B '.repeat(size * 20)}{}\n${Array.from({ length: size * 25 }, (_item, index) => `class C${index} extends C${index + 1} {}`).join('\n')}\nclass C${size * 25} implements MultiTenant<C${size * 25}> {}\n`
      });
      return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
    };

    const analysis = await expectLinearTime(200, evidence, async backendEvidence => evaluateB010(backendEvidence));

    expect(analysis.redFlags.slice(0, 2).map(flag => [flag.kind, flag.text])).toEqual([
      ['not-multitenant', 'A'],
      ['public-schema', 'INSERT INTO public.t0']
    ]);
    expect(analysis.redFlagCount).toBe(1 + 800 + 1);
    expect(analysis.mechanisms[1].evidence[1].note).toBe('20001 of 20002 domain classes implement MultiTenant');
    expect(analysis.unreadClientCalls).toHaveLength(100);
    expect(analysis.mechanisms.map(mechanism => mechanism.name)).toEqual(['rmb', 'grails']);
  }, 120_000);
});
