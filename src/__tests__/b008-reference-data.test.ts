import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B008Analysis, BackendEvidence, EvaluationStatus } from '../types';
import { evaluateB008 } from '../utils/b008-reference-data';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b008(root: string) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
  const result = await new BackendEvaluator().evaluateCriterion('B008', root, run);
  return { result, analysis: result.criterionDetails as B008Analysis };
}

function template(paths: Array<[string[], string]>): string {
  return JSON.stringify({
    id: 'mod-example-1.0.0',
    provides: [
      { id: 'example', version: '1.0', handlers: paths.map(([methods, pathPattern]) => ({ methods, pathPattern })) },
      { id: '_tenant', version: '2.0', interfaceType: 'system', handlers: [{ methods: ['POST'], pathPattern: '/_/tenant' }] }
    ]
  }, null, 2);
}

const collection = (path: string, methods = ['GET', 'POST']): [string[], string] => [methods, path];
const lines = (...text: string[]) => `${text.join('\n')}\n`;

const rmb = (files: Record<string, string>) => repository({
  'pom.xml': pom('mod-example', restVerticleBuild),
  'src/main/resources/templates/db_scripts/schema.json': '{}',
  ...files
});

const spring = (files: Record<string, string>) => repository({
  'pom.xml': pom('mod-example', `<dependencies>${dependency('folio-spring-base')}</dependencies>`),
  'src/main/java/org/folio/example/Application.java': '@SpringBootApplication\npublic class Application {}\n',
  ...files
});

const CHECKLIST_TITLE = '  - B008-C1 Each controlled vocabulary the module needs at least one value for has one after tenant initialization.';
const NOT_APPLIED = ['Agent review:', '  - Not applied: agent review is disabled or unconfigured'];
const WHAT_TO_DO = ['What to do:', '  - For each vocabulary listed under "Controlled vocabularies without reference data found" that needs a value, ship reference data that tenant initialization loads, or record why it needs none.'];

describe('B008 reference data', () => {
  it('counts only the folders that the loadReference key loads, not those of other keys or other add calls', async () => {
    const { result, analysis } = await b008(rmb({
      'descriptors/ModuleDescriptor-template.json': template([collection('/groups'), collection('/groups/{id}', ['GET']), collection('/proxy-types'), collection('/users')]),
      'src/main/resources/ref-data/groups-1.0.0/staff.json': '{}',
      'src/main/resources/ref-data/proxy-types/sponsor.json': '{}',
      'src/main/java/org/folio/rest/impl/TenantRefAPI.java': lines(
        'package org.folio.rest.impl;',
        'public class TenantRefAPI extends TenantAPI {',
        '  private static final String REFERENCE_KEY = "loadReference";',
        '  private static final String SAMPLE_KEY = "loadSample";',
        '  Future<Integer> loadData() {',
        '    TenantLoading tl = new TenantLoading();',
        '    tl.withKey(REFERENCE_KEY).withLead("ref-data");',
        '    tl.withIdContent().add("groups-1.0.0", "groups");',
        '    // tl.add("proxy-types");',
        '    List<String> names = new ArrayList<>();',
        '    names.add(name());',
        '    tl.withKey(SAMPLE_KEY).withLead("sample-data");',
        '    tl.add("proxy-types");',
        '    return tl.perform(attributes, headers, context, 0);',
        '  }',
        '}')
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B008 manual: 1 of the 2 controlled vocabularies has no reference data the tool found: /proxy-types. '
      + 'A reviewer must check whether it needs a value after tenant initialization.');
    expect(result.details?.split('\n')).toEqual([
      'Storage: RMB database schema src/main/resources/templates/db_scripts/schema.json',
      'Code that loads reference data at tenant initialization:',
      '  - src/main/java/org/folio/rest/impl/TenantRefAPI.java:7 — RMB TenantLoading for the loadReference key',
      'Reference-data folders:',
      '  - src/main/resources/ref-data/groups-1.0.0',
      '  - src/main/resources/ref-data/proxy-types — not loaded as reference data',
      'Controlled vocabularies with reference data:',
      '  - /groups — reference-data folder src/main/resources/ref-data/groups-1.0.0',
      'Controlled vocabularies without reference data found:',
      '  - /proxy-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:21',
      '    - src/main/resources/ref-data/proxy-types — reference-data folder that no reference load path names',
      ...WHAT_TO_DO,
      'Checklist for the reviewer:',
      CHECKLIST_TITLE,
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:21 — /proxy-types: collection endpoint named like a vocabulary, no reference data found',
      '      - src/main/resources/ref-data/proxy-types — /proxy-types: reference-data folder that no reference load path names',
      ...NOT_APPLIED
    ]);
    expect(analysis.checklist.items.map(item => [item.reviewerOnly, item.obligations])).toEqual([
      [false, [{ id: 'B008-C1#1', subject: '/proxy-types', path: 'descriptors/ModuleDescriptor-template.json', line: 21, flag: 'manual' }]]
    ]);
  });

  it('keeps a key per TenantLoading instance and reads only the calls of its chain', async () => {
    const loader = 'src/main/java/org/folio/rest/impl/TenantRefAPI.java';
    const { result, analysis } = await b008(rmb({
      'descriptors/ModuleDescriptor-template.json': template([collection('/groups'), collection('/loan-types'), collection('/hold-reasons')]),
      'src/main/resources/ref-data/groups/staff.json': '{}',
      'src/main/resources/ref-data/loan-types/can-circulate.json': '{}',
      'src/main/resources/ref-data/hold-reasons/README.md': 'Reasons',
      'src/test/resources/ref-data/hold-reasons/lost.json': '{}',
      [loader]: lines(
        'public class TenantRefAPI {',
        '  Future<Integer> load() {',
        '    TenantLoading ref = new TenantLoading();',
        '    TenantLoading sample = new TenantLoading();',
        '    sample.withKey("loadSample");',
        '    ref.withKey("loadReference").withLead("ref-data");',
        '    ref.add("groups");',
        '    sample.add("loan-types");',
        '    ref.perform(a, h, c, l.add("loan-types") ? 0 : 1);',
        '    ref.withIdContent().perform(a, h, c, 0).onSuccess(n -> ids.add(n));',
        '    return addMore(ref);',
        '  }',
        '  void addMore(TenantLoading ref) {',
        '    ref.add("hold-reasons");',
        '  }',
        '  void unknownKey(TenantLoading tl) {',
        '    tl.withKey(key(a));',
        '    tl.add("loan-types");',
        '  }',
        '}')
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B008 manual: 2 of the 3 controlled vocabularies have no reference data the tool found: /hold-reasons and /loan-types. '
      + 'A reviewer must check whether each needs a value after tenant initialization.');
    expect(result.details?.split('\n')).toEqual([
      'Storage: RMB database schema src/main/resources/templates/db_scripts/schema.json',
      'Code that loads reference data at tenant initialization:',
      `  - ${loader}:6 — RMB TenantLoading for the loadReference key`,
      'Reference-data folders:',
      '  - src/main/resources/ref-data/groups',
      '  - src/main/resources/ref-data/loan-types — not loaded as reference data',
      'Controlled vocabularies with reference data:',
      '  - /groups — reference-data folder src/main/resources/ref-data/groups',
      'Controlled vocabularies without reference data found:',
      '  - /hold-reasons — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:22',
      '  - /loan-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:15',
      '    - src/main/resources/ref-data/loan-types — reference-data folder that no reference load path names',
      'Reference-data load paths the tool could not read:',
      `  - ${loader}:14`,
      `  - ${loader}:18`,
      ...WHAT_TO_DO,
      'Checklist for the reviewer:',
      CHECKLIST_TITLE,
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:22 — /hold-reasons: collection endpoint named like a vocabulary, no reference data found',
      '      - descriptors/ModuleDescriptor-template.json:15 — /loan-types: collection endpoint named like a vocabulary, no reference data found',
      '      - src/main/resources/ref-data/loan-types — /loan-types: reference-data folder that no reference load path names',
      `      - ${loader}:14 — reference-data load path the tool could not read`,
      `      - ${loader}:18 — reference-data load path the tool could not read`,
      ...NOT_APPLIED
    ]);
    expect(analysis.unreadLoadPathCount).toBe(2);
  });

  it('lists a Spring loadReferenceData override without counting the folders it may load', async () => {
    const { result } = await b008(spring({
      'descriptors/ModuleDescriptor-template.json': template([collection('/note-types')]),
      'src/main/resources/db/changelog/changelog-master.xml': '<databaseChangeLog/>\n',
      'src/main/resources/reference-data/note-types/general.json': '{}',
      'src/main/java/org/folio/example/ExampleTenantService.java': lines(
        'public class ExampleTenantService extends TenantService {',
        '  @Override',
        '  public void loadReferenceData() {',
        '  }',
        '}')
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details?.split('\n')).toEqual([
      'Storage: Liquibase changelog src/main/resources/db/changelog/changelog-master.xml',
      'Code that loads reference data at tenant initialization:',
      '  - src/main/java/org/folio/example/ExampleTenantService.java:3 — loadReferenceData() override',
      'Reference-data folders:',
      '  - src/main/resources/reference-data/note-types — not loaded as reference data',
      'Controlled vocabularies without reference data found:',
      '  - /note-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:8',
      '    - src/main/resources/reference-data/note-types — reference-data folder; the tool does not read which folders loadReferenceData() loads',
      'What to do:',
      '  - For each vocabulary listed under "Controlled vocabularies without reference data found" that needs a value, ship reference data that tenant initialization loads, or record why it needs none.',
      'Checklist for the reviewer:',
      '  - B008-C1 Each controlled vocabulary the module needs at least one value for has one after tenant initialization.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:8 — /note-types: collection endpoint named like a vocabulary, no reference data found',
      '      - src/main/resources/reference-data/note-types — /note-types: reference-data folder; the tool does not read which folders loadReferenceData() loads',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
  });

  it('counts only Liquibase inserts that run at installation, not comments, strings, comment blocks or rollbacks', async () => {
    const { result } = await b008(spring({
      'descriptors/ModuleDescriptor-template.json': template(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(name => collection(`/${name}-types`))),
      'src/main/resources/db/changelog/changelog-master.xml': lines(
        '<databaseChangeLog>',
        '  <changeSet id="1" author="a">',
        '    <sql>-- INSERT INTO a_type VALUES (1);',
        '      INSERT INTO b_type (id) VALUES (1);',
        "      DELETE FROM x WHERE name = 'insert into c_type values';",
        '    </sql>',
        '    <rollback><insert tableName="d_type"/></rollback>',
        '  </changeSet>',
        '  <changeSet id="2" author="a">',
        '    <rollback/>',
        '    <insert tableName="e_type"/>',
        '  </changeSet>',
        '</databaseChangeLog>'),
      'src/main/resources/db/changelog/more.yaml': lines(
        'databaseChangeLog:',
        '  - changeSet:',
        '      id: 3',
        '      comment: |',
        '        INSERT INTO f_type VALUES (1)',
        '      changes:',
        '        # - insert:',
        '        #     tableName: g_type',
        '        - insert:  # the default type',
        '            tableName: h_type',
        '      rollback:',
        '        - insert:',
        '            tableName: f_type'),
      'src/main/resources/db/changelog/compact.yaml': lines(
        'databaseChangeLog:',
        '- changeSet:',
        '    id: 4',
        '    changes:',
        '    - createTable:',
        '        tableName: g_type',
        '    rollback:',
        '    - insert:',
        '        tableName: g_type')
    }));

    expect(result.evidence).toBe('B008 manual: 5 of the 8 controlled vocabularies have no reference data the tool found: /a-types, /c-types, /d-types, and 2 more. '
      + 'A reviewer must check whether each needs a value after tenant initialization.');
    expect(result.details?.split('\n')).toEqual([
      'Storage: Liquibase changelog src/main/resources/db/changelog/changelog-master.xml',
      'Liquibase inserts:',
      '  - src/main/resources/db/changelog/changelog-master.xml:4 — into b_type',
      '  - src/main/resources/db/changelog/changelog-master.xml:11 — into e_type',
      '  - src/main/resources/db/changelog/more.yaml:9 — into h_type',
      'Controlled vocabularies with reference data:',
      '  - /b-types — Liquibase insert into b_type, src/main/resources/db/changelog/changelog-master.xml:4',
      '  - /e-types — Liquibase insert into e_type, src/main/resources/db/changelog/changelog-master.xml:11',
      '  - /h-types — Liquibase insert into h_type, src/main/resources/db/changelog/more.yaml:9',
      'Controlled vocabularies without reference data found:',
      '  - /a-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:8',
      '  - /c-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:22',
      '  - /d-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:29',
      '  - /f-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:43',
      '  - /g-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:50',
      'What to do:',
      '  - For each vocabulary listed under "Controlled vocabularies without reference data found" that needs a value, ship reference data that tenant initialization loads, or record why it needs none.',
      'Checklist for the reviewer:',
      '  - B008-C1 Each controlled vocabulary the module needs at least one value for has one after tenant initialization.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:8 — /a-types: collection endpoint named like a vocabulary, no reference data found',
      '      - descriptors/ModuleDescriptor-template.json:22 — /c-types: collection endpoint named like a vocabulary, no reference data found',
      '      - descriptors/ModuleDescriptor-template.json:29 — /d-types: collection endpoint named like a vocabulary, no reference data found',
      '      - descriptors/ModuleDescriptor-template.json:43 — /f-types: collection endpoint named like a vocabulary, no reference data found',
      '      - descriptors/ModuleDescriptor-template.json:50 — /g-types: collection endpoint named like a vocabulary, no reference data found',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
  });

  it('passes when load paths it cannot read leave every folder loaded, matching folders without version suffixes', async () => {
    const { result, analysis } = await b008(rmb({
      'descriptors/ModuleDescriptor-template.json': template([collection('/addresstypes'), collection('/loan-types'), collection('/instance-statuses', ['GET']), collection('/users')]),
      'src/main/resources/ref-data/addresstypes-15.4.0/home.json': '{}',
      'reference-data/loan-types/can-circulate.json': '{}',
      'src/main/java/org/folio/rest/impl/TenantRefApi.java': lines(
        'public class TenantRefApi {',
        '  final String[] refPaths = new String[] { "loan-types", "addresstypes-15.4.0" };',
        '  void load() {',
        '    var tl = new TenantLoading();',
        '    tl.withKey("loadReference").withLead("ref-data");',
        '    for (String p : refPaths) {',
        '      tl.add(p);',
        '    }',
        '  }',
        '}')
    }));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B008 pass: Each of the 2 controlled vocabularies has reference data loaded at tenant initialization, '
      + 'from reference-data folders loaded by src/main/java/org/folio/rest/impl/TenantRefApi.java: /addresstypes and /loan-types.');
    expect(result.details?.split('\n')).toEqual([
      'Storage: RMB database schema src/main/resources/templates/db_scripts/schema.json',
      'Code that loads reference data at tenant initialization:',
      '  - src/main/java/org/folio/rest/impl/TenantRefApi.java:5 — RMB TenantLoading for the loadReference key',
      'Reference-data folders:',
      '  - reference-data/loan-types',
      '  - src/main/resources/ref-data/addresstypes-15.4.0',
      'Controlled vocabularies with reference data:',
      '  - /addresstypes — reference-data folder src/main/resources/ref-data/addresstypes-15.4.0',
      '  - /loan-types — reference-data folder reference-data/loan-types',
      'Reference-data load paths the tool could not read:',
      '  - src/main/java/org/folio/rest/impl/TenantRefApi.java:7'
    ]);
    expect(analysis.vocabularies.map(vocabulary => [vocabulary.name, vocabulary.reason])).toEqual([['/addresstypes', 'reference-data'], ['/loan-types', 'name']]);
    expect(analysis.checklist.items).toEqual([]);
  });

  it('matches Liquibase inserts to vocabulary tables, skipping comments, trigger bodies, copies and ambiguous tables', async () => {
    const { result, analysis } = await b008(spring({
      'descriptors/ModuleDescriptor-template.json': template([
        collection('/note-types'), collection('/link-types'), collection('/status-reasons'), collection('/hold-categories'), collection('/notes')
      ]),
      'src/main/resources/db/changelog/changelog-master.xml': lines(
        '<databaseChangeLog>',
        '  <!-- <insert tableName="link_type"><column name="name" value="x"/></insert> -->',
        '  <changeSet id="1" author="a">',
        '    <insert tableName="type">',
        '      <column name="name" value="General note"/>',
        '    </insert>',
        '    <sqlFile path="sql/trigger.sql" relativeToChangelogFile="true"/>',
        '  </changeSet>',
        '</databaseChangeLog>'),
      'src/main/resources/db/changelog/more.yaml': lines(
        'databaseChangeLog:',
        '  - changeSet:',
        '      id: 2',
        '      changes:',
        '        - insert:',
        '            columns:',
        '              - column:',
        '                  name: name',
        '            tableName: hold_categories'),
      'src/main/resources/db/changelog/sql/trigger.sql': lines(
        "-- INSERT INTO link_types (id) VALUES ('a');",
        'CREATE FUNCTION f() RETURNS trigger AS $body$',
        'BEGIN',
        '  INSERT INTO link_types (id) VALUES (NEW.id);',
        'END;',
        '$body$ LANGUAGE plpgsql;',
        "INSERT INTO ${database.defaultSchemaName}.status_reasons (id, name) VALUES ('1', 'Lost');",
        'INSERT INTO link_types SELECT * FROM old_link_types;'),
      'src/main/resources/templates/db_scripts/insert.sql': "INSERT INTO note_types (id) VALUES ('1');\n"
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B008 manual: 2 of the 4 controlled vocabularies have no reference data the tool found: /link-types and /note-types. '
      + 'A reviewer must check whether each needs a value after tenant initialization.');
    expect(result.details?.split('\n')).toEqual([
      'Storage: Liquibase changelog src/main/resources/db/changelog/changelog-master.xml',
      'Liquibase inserts:',
      '  - src/main/resources/db/changelog/changelog-master.xml:4 — into type',
      '  - src/main/resources/db/changelog/more.yaml:5 — into hold_categories',
      '  - src/main/resources/db/changelog/sql/trigger.sql:7 — into status_reasons',
      'Controlled vocabularies with reference data:',
      '  - /hold-categories — Liquibase insert into hold_categories, src/main/resources/db/changelog/more.yaml:5',
      '  - /status-reasons — Liquibase insert into status_reasons, src/main/resources/db/changelog/sql/trigger.sql:7',
      'Controlled vocabularies without reference data found:',
      '  - /link-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:15',
      '  - /note-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:8',
      ...WHAT_TO_DO,
      'Checklist for the reviewer:',
      CHECKLIST_TITLE,
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:15 — /link-types: collection endpoint named like a vocabulary, no reference data found',
      '      - descriptors/ModuleDescriptor-template.json:8 — /note-types: collection endpoint named like a vocabulary, no reference data found',
      ...NOT_APPLIED
    ]);
    expect(analysis.checklist.items[0].obligations.map(obligation => [obligation.id, obligation.subject])).toEqual([['B008-C1#1', '/link-types'], ['B008-C1#2', '/note-types']]);
  });

  it('reads Grails refdata categories, their @Defaults and shared @CategoryId values, at class level only', async () => {
    const domain = 'service/grails-app/domain/org/olf/Agreement.groovy';
    const { result } = await b008(repository({
      'service/build.gradle': '',
      'service/grails-app/conf/application.yml': 'dataSource:\n  url: jdbc:postgresql://localhost/db\n',
      'service/src/main/okapi/ModuleDescriptor-template.json': template([collection('/erm/refdata'), collection('/erm/sas')]),
      [domain]: lines(
        'package org.olf',
        'class Agreement implements MultiTenant<Agreement> {',
        '  String name',
        "  @CategoryId(value='Global.Yes_No', defaultInternal=true)",
        "  @Defaults(['Yes', 'No'])",
        '  RefdataValue isPerpetual',
        '',
        "  @CategoryId(value='Global.Yes_No', defaultInternal=true)",
        '  RefdataValue renewable',
        '  @Defaults([',
        "    'Draft',",
        "    'Active (current)'",
        '  ])',
        '  RefdataValue agreementStatus',
        '  @CategoryId(defaultInternal=true) RefdataValue reasonForClosure',
        "  @Defaults(value = [], comment = 'none yet')",
        '  RefdataValue eventType',
        '  // @Defaults([\'x\'])',
        '  RefdataValue renewalPriority',
        '  static mapping = {',
        "    agreementStatus column: 'status'",
        '  }',
        '  def beforeValidate() {',
        "    RefdataValue fallback = RefdataValue.lookupOrCreate('Agreement.Fallback', 'x')",
        '  }',
        '}')
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B008 manual: 3 of the 5 controlled vocabularies have no reference data the tool found: '
      + 'Agreement.EventType, Agreement.ReasonForClosure, and Agreement.RenewalPriority. A reviewer must check whether each needs a value after tenant initialization.');
    expect(result.details?.split('\n')).toEqual([
      'Storage: Grails domain classes with a datasource in service/grails-app/conf/application.yml',
      'Controlled vocabularies with reference data:',
      `  - Agreement.AgreementStatus — @Defaults (2 values), ${domain}:14`,
      `  - Global.Yes_No — @Defaults (2 values), ${domain}:6`,
      'Controlled vocabularies without reference data found:',
      `  - Agreement.EventType — Grails refdata category, ${domain}:17`,
      `  - Agreement.ReasonForClosure — Grails refdata category, ${domain}:15`,
      `  - Agreement.RenewalPriority — Grails refdata category, ${domain}:19`,
      ...WHAT_TO_DO,
      'Checklist for the reviewer:',
      CHECKLIST_TITLE,
      '    - Start with:',
      `      - ${domain}:17 — Agreement.EventType: Grails refdata category, no reference data found`,
      `      - ${domain}:15 — Agreement.ReasonForClosure: Grails refdata category, no reference data found`,
      `      - ${domain}:19 — Agreement.RenewalPriority: Grails refdata category, no reference data found`,
      ...NOT_APPLIED
    ]);
  });

  it('leaves a module with no vocabulary to the reviewer, listing the reference data it found', async () => {
    const { result, analysis } = await b008(spring({
      'descriptors/ModuleDescriptor-template.json': template([collection('/browse/config'), collection('/instance-statuses', ['GET'])]),
      'src/main/resources/db/changelog/changelog-master.xml': '<databaseChangeLog><insert tableName="browse_config"/><insert tableName="browse_config"/></databaseChangeLog>\n'
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.basis).toBe('no-vocabularies');
    expect(result.evidence).toBe('B008 manual: The tool found no controlled vocabulary: no collection endpoint in descriptors/ModuleDescriptor-template.json is named like one '
      + '(*-types, *-statuses, *-reasons, *-categories) or is named by reference data. It found Liquibase inserts into browse_config, which no vocabulary-like endpoint matches. '
      + 'A reviewer must decide whether the module has controlled vocabularies that need a value after tenant initialization.');
    expect(result.details?.split('\n')).toEqual([
      'Storage: Liquibase changelog src/main/resources/db/changelog/changelog-master.xml',
      'Liquibase inserts:',
      '  - src/main/resources/db/changelog/changelog-master.xml:1 — into browse_config (2 inserts)',
      'Checklist for the reviewer:',
      CHECKLIST_TITLE,
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json — the endpoints the module provides',
      '      - src/main/resources/db/changelog/changelog-master.xml:1 — Liquibase inserts into browse_config',
      ...NOT_APPLIED
    ]);
    expect(analysis.checklist.items[0].obligations).toEqual([{ id: 'B008-C1#1' }]);
  });

  it.each([
    ['a module without storage evidence', () => repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('domain-models-runtime')}</dependencies>`),
      'descriptors/ModuleDescriptor-template.json': template([collection('/loan-types')]),
      'src/main/java/org/folio/Verticle.java': 'public class Verticle extends AbstractVerticle {}\n'
    }), EvaluationStatus.NOT_APPLICABLE, 'no-storage',
    'B008 not_applicable: The tool found no storage evidence (an RMB schema.json, PostgresClient or PgUtil use, a Liquibase changelog, a datasource, or Grails domain classes with a datasource), so the module keeps no data that needs reference values.', [
      'Storage: none found'
    ]],
    ['a shared library with storage', () => repository({
      'pom.xml': pom('folio-spring-base'),
      'src/main/resources/db/changelog/changelog.xml': '<databaseChangeLog/>'
    }), EvaluationStatus.NOT_APPLICABLE, 'library', 'B008 not_applicable: The repository is a shared library; reference data belongs to the modules that store data.', []],
    ['no storage evidence in source read incompletely', () => repository({
      'pom.xml': pom('mod-example'),
      'descriptors/ModuleDescriptor-template.json': template([collection('/loan-types')]),
      'src/main/resources/large.txt': 'x'.repeat(1024 * 1024 + 1)
    }), EvaluationStatus.MANUAL, 'storage-unconfirmed',
    'B008 manual: The tool found no storage evidence, but the committed source was not read completely, so it could not rule storage out.', [
      'Storage: none found',
      'What the tool could not read:',
      '  - src/main/resources/large.txt — Committed file exceeds the 1048576-byte per-file limit',
      'Checklist for the reviewer:',
      '  - B008-C1 Each controlled vocabulary the module needs at least one value for has one after tenant initialization.',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]],
    ['a module without a descriptor template', () => repository({
      'pom.xml': pom('example-service', restVerticleBuild),
      'src/main/resources/templates/db_scripts/schema.json': '{}'
    }), EvaluationStatus.MANUAL, 'no-descriptor',
    'B008 manual: No module descriptor template was found, so the module\'s endpoints, and the controlled vocabularies among them, are not known (see B001). '
      + 'A reviewer must decide whether the module has controlled vocabularies that need a value after tenant initialization.', [
      'Storage: RMB database schema src/main/resources/templates/db_scripts/schema.json',
      'Checklist for the reviewer:',
      '  - B008-C1 Each controlled vocabulary the module needs at least one value for has one after tenant initialization.',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]],
    ['an insert into a singular table named after its endpoint', () => spring({
      'descriptors/ModuleDescriptor-template.json': template([collection('/note-types'), collection('/notes')]),
      'src/main/resources/db/changelog/changelog-master.xml': '<databaseChangeLog><insert tableName="type"/></databaseChangeLog>\n'
    }), EvaluationStatus.PASS, 'vocabularies-checked',
    'B008 pass: The controlled vocabulary /note-types has reference data loaded at tenant initialization, from Liquibase inserts.', [
      'Storage: Liquibase changelog src/main/resources/db/changelog/changelog-master.xml',
      'Liquibase inserts:',
      '  - src/main/resources/db/changelog/changelog-master.xml:1 — into type',
      'Controlled vocabularies with reference data:',
      '  - /note-types — Liquibase insert into type, src/main/resources/db/changelog/changelog-master.xml:1'
    ]],
    ['folders without a loader', () => rmb({
      'descriptors/ModuleDescriptor-template.json': template([collection('/loan-types')]),
      'reference-data/loan-types/a.json': '{}'
    }), EvaluationStatus.MANUAL, 'vocabularies-checked',
    'B008 manual: The controlled vocabulary /loan-types has no reference data the tool found. A reviewer must check whether it needs a value after tenant initialization.', [
      'Storage: RMB database schema src/main/resources/templates/db_scripts/schema.json',
      'Reference-data folders:',
      '  - reference-data/loan-types — not loaded as reference data',
      'Controlled vocabularies without reference data found:',
      '  - /loan-types — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:8',
      '    - reference-data/loan-types — reference-data folder, but no code that loads reference data at tenant initialization was found',
      'What to do:',
      '  - For each vocabulary listed under "Controlled vocabularies without reference data found" that needs a value, ship reference data that tenant initialization loads, or record why it needs none.',
      'Checklist for the reviewer:',
      '  - B008-C1 Each controlled vocabulary the module needs at least one value for has one after tenant initialization.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:8 — /loan-types: collection endpoint named like a vocabulary, no reference data found',
      '      - reference-data/loan-types — /loan-types: reference-data folder, but no code that loads reference data at tenant initialization was found',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]],
    ['a load path whose folder holds no files', () => rmb({
      'descriptors/ModuleDescriptor-template.json': template([collection('/item-damaged-statuses')]),
      'src/main/java/org/folio/rest/impl/TenantRefAPI.java': lines(
        'public class TenantRefAPI {',
        '  void load(TenantLoading tl) {',
        '    tl = new TenantLoading();',
        '    tl.withKey("loadReference").add("item-damaged-statuses-1.0", "item-damaged-statuses");',
        '  }',
        '}')
    }), EvaluationStatus.MANUAL, 'vocabularies-checked',
    'B008 manual: The controlled vocabulary /item-damaged-statuses has no reference data the tool found. A reviewer must check whether it needs a value after tenant initialization.', [
      'Storage: RMB database schema src/main/resources/templates/db_scripts/schema.json',
      'Code that loads reference data at tenant initialization:',
      '  - src/main/java/org/folio/rest/impl/TenantRefAPI.java:4 — RMB TenantLoading for the loadReference key',
      'Controlled vocabularies without reference data found:',
      '  - /item-damaged-statuses — collection endpoint named like a vocabulary, descriptors/ModuleDescriptor-template.json:8',
      '    - src/main/java/org/folio/rest/impl/TenantRefAPI.java:4 — loaded from item-damaged-statuses-1.0, but no ref-data/ or reference-data/ folder of that name holds files',
      'What to do:',
      '  - For each vocabulary listed under "Controlled vocabularies without reference data found" that needs a value, ship reference data that tenant initialization loads, or record why it needs none.',
      'Checklist for the reviewer:',
      '  - B008-C1 Each controlled vocabulary the module needs at least one value for has one after tenant initialization.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:8 — /item-damaged-statuses: collection endpoint named like a vocabulary, no reference data found',
      '      - src/main/java/org/folio/rest/impl/TenantRefAPI.java:4 — /item-damaged-statuses: loaded from item-damaged-statuses-1.0, but no ref-data/ or reference-data/ folder of that name holds files',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]],
    ['every vocabulary covered in source read incompletely', () => spring({
      'descriptors/ModuleDescriptor-template.json': template([collection('/note-types')]),
      'src/main/resources/db/changelog/changelog-master.xml': '<databaseChangeLog><insert tableName="note_type"/></databaseChangeLog>\n',
      'src/main/resources/large.txt': 'x'.repeat(1024 * 1024 + 1)
    }), EvaluationStatus.MANUAL, 'vocabularies-checked',
    'B008 manual: The committed source was not read completely, so the tool may have missed reference data. '
      + 'A reviewer must check whether the parts the tool could not read hold controlled vocabularies without reference data.', [
      'Storage: Liquibase changelog src/main/resources/db/changelog/changelog-master.xml',
      'Liquibase inserts:',
      '  - src/main/resources/db/changelog/changelog-master.xml:1 — into note_type',
      'Controlled vocabularies with reference data:',
      '  - /note-types — Liquibase insert into note_type, src/main/resources/db/changelog/changelog-master.xml:1',
      'What the tool could not read:',
      '  - src/main/resources/large.txt — Committed file exceeds the 1048576-byte per-file limit',
      'Checklist for the reviewer:',
      '  - B008-C1 Each controlled vocabulary the module needs at least one value for has one after tenant initialization.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json — the endpoints the module provides',
      '      - src/main/resources/db/changelog/changelog-master.xml:1 — Liquibase insert into note_type',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]]
  ])('decides %s', async (_name, files, status, basis, evidence, details) => {
    const { result, analysis } = await b008(files());

    expect(result.status).toBe(status);
    expect(analysis.basis).toBe(basis);
    expect(result.evidence).toBe(evidence);
    expect(result.details ? result.details.split('\n') : []).toEqual(details);
  });

  it('reads load paths, changelogs, domain classes and folders in linear time', async () => {
    const evidence = (size: number): BackendEvidence => {
      const files: Record<string, string> = {
        [`src/main/resources/db/changelog/${'x/'.repeat(size * 50)}deep.sql`]: "INSERT INTO deep_type VALUES ('x');\n",
        [`grails-app/domain/${'x/'.repeat(size * 50)}Deep.groovy`]: 'class Deep {\n  RefdataValue deep\n}\n',
        'descriptors/ModuleDescriptor-template.json': '',
        'src/main/java/org/folio/rest/impl/TenantRefAPI.java': [
          'TenantLoading tl = new TenantLoading();\ntl.withKey("loadReference");\ntl.add(p);\n',
          `tl.add("/a${'/'.repeat(size * 50)}a", "/b${'/'.repeat(size * 50)}b");\n`,
          `tl${'.withIdContent()'.repeat(size * 20)}.add(${'"("'.repeat(size * 20)});\n`,
          ...Array.from({ length: size }, (_item, index) => `tl.add("t${index}-types");\n`),
          ...Array.from({ length: size * 30 }, (_item, index) => `tl.add("same-${index}", "same");\n`),
          `tl${'.add(x'.repeat(size * 50)};\n`,
          `tl.add(${'('.repeat(size * 50)};\n`,
          `${'a.'.repeat(size * 50)};\n`
        ].join(''),
        'src/main/resources/db/changelog/changelog.xml': [
          '<databaseChangeLog>\n',
          ...Array.from({ length: size }, (_item, index) => `<insert tableName="t${index}_type"/>\n`),
          '<insert '.repeat(size * 50),
          `INSERT INTO ${'a.'.repeat(size * 50)} x\n`,
          `INSERT INTO a${' '.repeat(size * 50)}x (${' '.repeat(size * 50)}x\n`,
          'insert into insert into '.repeat(size * 20),
          '$a$'.repeat(size * 20),
          '<!--'.repeat(size * 20)
        ].join(''),
        'src/main/resources/db/changelog/sql/data.sql': ['--'.repeat(size * 50), '\n', '/*'.repeat(size * 50)].join(''),
        'src/main/resources/db/changelog/changes.yaml': [
          'databaseChangeLog:\n',
          ...Array.from({ length: size }, () => `  - insert:\n${'      columns: x\n'.repeat(60)}`),
          `${' '.repeat(size * 50)}x\n`,
          `${' #'.repeat(size * 50)}\r\n`
        ].join(''),
        'grails-app/domain/org/olf/Many.groovy': [
          'class Many {\n',
          ...Array.from({ length: size }, (_item, index) => `  @Defaults(['a'])\n  RefdataValue p${index}\n`),
          ...Array.from({ length: size * 30 }, (_item, index) => `  @CategoryId('Shared') RefdataValue s${index}\n`),
          `  ${'@A() '.repeat(size * 50)}\n`,
          `  ${'@B('.repeat(size * 50)}\n`,
          `  ${'\''.repeat(size * 50)}\n`,
          `  @CategoryId(${'value=\'x\', '.repeat(size * 20)}) @Defaults(${'[\'a\', '.repeat(size * 20)}\n  RefdataValue q\n`,
          `  @Defaults(['${'a'.repeat(size * 50)}\n  RefdataValue r\n`,
          '}\n',
          '{'.repeat(size * 50)
        ].join('')
      };
      return {
        kind: 'backend-module',
        kindEvidence: [],
        moduleKind: { kind: 'backend-module', evidence: [], warnings: [] },
        templateCandidates: ['descriptors/ModuleDescriptor-template.json'],
        template: {
          path: 'descriptors/ModuleDescriptor-template.json',
          placeholders: [],
          descriptor: { provides: [{ id: 'example', version: '1.0', handlers: Array.from({ length: size }, (_item, index) =>
            ({ methods: ['GET', 'POST'], pathPattern: `/t${index}-types` })).concat([{ methods: ['GET'], pathPattern: `/a${'/'.repeat(size * 50)}a` }]) }] }
        },
        framework: { name: 'rmb', evidence: [] },
        storage: { present: true, evidence: ['schema'] },
        snapshot: {
          revision: 'HEAD',
          complete: true,
          diagnostics: [],
          files: Object.entries(files).map(([path, content]) => ({ path, oid: '', size: content.length, content })),
          listedPaths: [
            ...Array.from({ length: size }, (_item, index) => `reference-data/t${index}-types-${'1.'.repeat(50)}1/a.json`),
            ...Array.from({ length: size * 10 }, (_item, index) => `reference-data/same-${index}/a.json`),
            `reference-data/${'-1.1'.repeat(size * 50)}x/a.json`
          ]
        }
      };
    };

    const analysis = await expectLinearTime(250, evidence, async backendEvidence => evaluateB008(backendEvidence));

    expect(analysis.vocabularies).toHaveLength(1_000 + 1_000 + 2);
    expect(analysis.vocabularies.filter(vocabulary => vocabulary.reason === 'name' && vocabulary.sources.map(source => source.kind).join() === 'reference-data-folder,liquibase-insert')).toHaveLength(1_000);
    expect(analysis.unreadLoadPathCount).toBeGreaterThan(0);
  }, 120_000);
});
