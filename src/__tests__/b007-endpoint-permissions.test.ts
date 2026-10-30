import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B007Analysis, CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus } from '../types';
import { buildB007AgentReviewRequest } from '../utils/b007-agent-review';
import { evaluateB007 } from '../utils/b007-endpoint-permissions';
import { getBackendEvidence } from '../utils/backend-evidence';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b007(root: string, agentReview?: CriterionAgentReviewConfig) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java', ...(agentReview ? { agentReview } : {}) });
  const result = await new BackendEvaluator().evaluateCriterion('B007', root, run);
  return { result, analysis: result.criterionDetails as B007Analysis };
}

const TEMPLATE = 'descriptors/ModuleDescriptor-template.json';
const rmbModule = (descriptor: unknown, files: Record<string, string> = {}) => repository({
  'pom.xml': pom('mod-users', restVerticleBuild),
  [TEMPLATE]: JSON.stringify(descriptor, null, 2),
  ...files
});
const set = (permissionName: string, subPermissions: string[] = []) => ({ permissionName, displayName: permissionName, subPermissions });
const tenant = { id: '_tenant', version: '2.0', interfaceType: 'system', handlers: [{ methods: ['POST'], pathPattern: '/_/tenant' }] };

const manualDescriptor = {
  id: 'mod-users-1.0.0',
  provides: [
    tenant,
    { id: 'users', version: '16.4', handlers: [
      { methods: ['GET'], pathPattern: '/users', permissionsRequired: ['users.collection.get'], permissionsDesired: ['users.all'] },
      { methods: ['POST'], pathPattern: '/users', permissionsRequired: ['users.allops'], modulePermissions: ['notes.all', 'notes.item.post'] }
    ] },
    { id: 'public-lookup', version: '1.0', handlers: [
      { methods: ['GET'], pathPattern: '/public/lookup', permissionsRequired: [] },
      { methods: ['GET'], pathPattern: '/public/other' }
    ] },
    { id: 'empty', version: '1.0', handlers: [] }
  ],
  permissionSets: [
    set('users.collection.get'), set('users.allops'), set('users-settings.collection.get'), set('users.itemGet.get'),
    set('users.all', ['users.collection.get']), set('users.records.export'), set('users..get')
  ]
};

describe('B007 endpoint permissions', () => {
  it('leaves a module without violations to the reviewer, with every deviation listed', async () => {
    const { result, analysis } = await b007(rmbModule(manualDescriptor));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B007 manual: Every endpoint that requires a permission requires one that a permission set defines, and none requires a *.all permission. '
      + '2 endpoints require no permission: GET /public/lookup and GET /public/other. An endpoint has a *.all module permission: POST /users (notes.all). '
      + '5 permission names depart from the permission naming guidelines: 1 does not start with the module name users, 2 are not lowercase words joined by hyphens, such as camelCase, '
      + 'and 2 do not end with an action (get, post, put, patch, delete or execute) or all. A reviewer must judge whether the permissions fit the endpoints.');
    expect(result.details?.split('\n')).toEqual([
      'Endpoints: 4 in 2 interfaces of descriptors/ModuleDescriptor-template.json, without system interfaces',
      'Permissions defined in permissionSets: 7',
      'Endpoints that require no permission:',
      '  - GET /public/lookup: permissionsRequired is empty — descriptors/ModuleDescriptor-template.json:52',
      '  - GET /public/other: permissionsRequired is missing — descriptors/ModuleDescriptor-template.json:59',
      'Endpoints with a *.all module permission:',
      '  - POST /users (notes.all) — descriptors/ModuleDescriptor-template.json:33',
      'Module name for permission names: users (from pom.xml artifactId mod-users)',
      'Permission names that depart from the naming guidelines: 5, listed under B007-C4',
      'Checklist for the reviewer:',
      '  - B007-C1 Each endpoint\'s permission fits what it does: a read permission for a read and a write permission for a write, an item permission for one record and a collection permission for many.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:17 — interface users: 2 endpoints',
      '      - descriptors/ModuleDescriptor-template.json:48 — interface public-lookup: 2 endpoints',
      '  - B007-C2 Each endpoint without a permission is meant to be public, and exposes or changes no tenant data.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:52 — GET /public/lookup: permissionsRequired is empty',
      '      - descriptors/ModuleDescriptor-template.json:59 — GET /public/other: permissionsRequired is missing',
      '  - B007-C3 Each endpoint\'s modulePermissions cover every interface its implementation calls, without *.all permissions.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:33 — POST /users: module permission notes.all',
      '  - B007-C4 Permission names follow the permission naming guidelines (https://folio-org.atlassian.net/wiki/x/BgDtY): <module>.<resource>.<scope>.<action>, '
        + 'each term lowercase words joined by hyphens, ending with get, post, put, patch, delete or execute, or all for a broad permission set.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json:79 — users.allops: does not end with an action',
      '      - descriptors/ModuleDescriptor-template.json:84 — users-settings.collection.get: does not start with users',
      '      - descriptors/ModuleDescriptor-template.json:89 — users.itemGet.get: a term is not lowercase words joined by hyphens',
      '      - descriptors/ModuleDescriptor-template.json:101 — users.records.export: does not end with an action',
      '      - descriptors/ModuleDescriptor-template.json:106 — users..get: a term is not lowercase words joined by hyphens',
      'Agent review:',
      '  - Not applied: agent review is disabled or unconfigured'
    ]);
    // One obligation per interface: the flagged ones (public endpoints, *.all module permissions) first, then by line.
    expect(analysis.checklist.items.flatMap(item => item.obligations)).toEqual([
      { id: 'B007-C1#1', subject: 'interface users (#/provides/1)', path: TEMPLATE, line: 17 },
      { id: 'B007-C1#2', subject: 'interface public-lookup (#/provides/2)', path: TEMPLATE, line: 48 },
      { id: 'B007-C2#1', subject: 'interface public-lookup (#/provides/2)', path: TEMPLATE, line: 48, flag: 'manual' },
      { id: 'B007-C3#1', subject: 'interface users (#/provides/1)', path: TEMPLATE, line: 17, flag: 'manual' },
      { id: 'B007-C3#2', subject: 'interface public-lookup (#/provides/2)', path: TEMPLATE, line: 48 }
    ]);
  });

  it('fails on a required *.all permission and on one no permission set defines, even when a set names it as a sub-permission', async () => {
    const { result, analysis } = await b007(rmbModule({
      id: 'mod-users-1.0.0',
      provides: [tenant, { id: 'users', version: '16.4', handlers: [
        { methods: ['GET'], pathPattern: '/users', permissionsRequired: ['users.collection.get'] },
        { methods: ['PUT', 'DELETE'], pathPattern: '/users/{id}', permissionsRequired: ['users.all', 'users.item.put'] }
      ] }],
      permissionSets: [set('users.collection.get'), set('users.all', ['users.item.put'])]
    }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B007 fail: An endpoint requires a *.all permission: PUT, DELETE /users/{id} (users.all); a *.all permission grants a whole module\'s permissions, '
      + 'so an endpoint should require only what it needs. An endpoint requires a permission that no permission set in the template defines: PUT, DELETE /users/{id} (users.item.put).');
    expect(result.details?.split('\n').slice(0, 9)).toEqual([
      'Endpoints: 2 in 1 interface of descriptors/ModuleDescriptor-template.json, without system interfaces',
      'Permissions defined in permissionSets: 2',
      'Endpoints that require a *.all permission:',
      '  - PUT, DELETE /users/{id} (users.all) — descriptors/ModuleDescriptor-template.json:30',
      'Endpoints that require a permission no permission set defines:',
      '  - PUT, DELETE /users/{id} (users.item.put) — descriptors/ModuleDescriptor-template.json:30',
      'Module name for permission names: users (from pom.xml artifactId mod-users)',
      'What to do:',
      '  - Give each endpoint listed under "Endpoints that require a *.all permission" a permission for what it does, and define each permission listed under '
        + '"Endpoints that require a permission no permission set defines" in permissionSets, or require a defined one.'
    ]);
    expect(analysis.checklist.items.flatMap(item => item.obligations).map(obligation => [obligation.id, obligation.flag])).toEqual([
      ['B007-C1#1', 'fail'], ['B007-C3#1', undefined]
    ]);
  });

  it.each([
    ['a library', () => repository({ 'pom.xml': pom('folio-spring-base') }), EvaluationStatus.NOT_APPLICABLE,
      'B007 not_applicable: The repository is a shared library, which provides no endpoints of its own.'],
    ['an edge module that provides nothing', () => repository({
      'pom.xml': pom('edge-patron', `<dependencies>${dependency('edge-common')}</dependencies>`),
      [TEMPLATE]: JSON.stringify({ id: 'edge-patron-1.0.0', provides: [], permissionSets: [] })
    }), EvaluationStatus.NOT_APPLICABLE,
    'B007 not_applicable: descriptors/ModuleDescriptor-template.json provides no endpoints other than those of system interfaces.'],
    ['a module with system interfaces only', () => rmbModule({ id: 'mod-users-1.0.0', provides: [tenant] }), EvaluationStatus.NOT_APPLICABLE,
      'B007 not_applicable: descriptors/ModuleDescriptor-template.json provides no endpoints other than those of system interfaces.'],
    ['a repository without a descriptor', () => repository({ 'pom.xml': pom('mod-unknown') }), EvaluationStatus.MANUAL,
      'B007 manual: No module descriptor template was found, so the module\'s endpoints and their permissions are not known (see B001).'],
    ['permissions the tool cannot read', () => rmbModule({ id: 'mod-users-1.0.0', provides: [{ id: 'users', version: '1.0', handlers: [
      { methods: ['GET'], pathPattern: '/users', permissionsRequired: 'users.all' }, 'not a handler',
      { methods: ['POST'], pathPattern: '/users', permissionsRequired: ['users.item.post'], modulePermissions: 'notes.all' }] }], permissionSets: { users: 1 } }),
    EvaluationStatus.MANUAL, 'B007 manual: The tool could not read /permissionSets in the template (see B001), so it could not check that the required permissions are defined. '
      + 'The tool could not read the permissions at /provides/0/handlers/0, /provides/0/handlers/1, and /provides/0/handlers/2 in the template (see B001). A reviewer must judge whether the permissions fit the endpoints.'],
    ['a required permission with an undefined build placeholder', () => rmbModule({ id: 'mod-users-1.0.0', provides: [{ id: 'users', version: '1.0', handlers: [
      { methods: ['GET'], pathPattern: '/users', permissionsRequired: ['${prefix}.collection.get'] }] }], permissionSets: [set('users.collection.get')] }),
    EvaluationStatus.MANUAL, 'B007 manual: The endpoint requires a permission that a permission set defines, and not a *.all permission. '
      + 'The tool could not check that the required permissions are defined, because the permission ${prefix}.collection.get has a build placeholder the build properties do not define. '
      + 'A reviewer must judge whether the permissions fit the endpoints.'],
    ['a permission set name with an undefined build placeholder, or none', () => rmbModule({ id: 'mod-users-1.0.0', provides: [{ id: 'users', version: '1.0', handlers: [
      { methods: ['GET'], pathPattern: '/users', permissionsRequired: ['users.collection.get'] },
      { methods: ['POST'], pathPattern: '/users', permissionsRequired: ['users.item.post'] }] }],
    permissionSets: [set('${prefix}.collection.get'), { permissionName: null }] }),
    EvaluationStatus.MANUAL, 'B007 manual: No endpoint requires a *.all permission. '
      + 'The tool could not check that the required permissions are defined, because the permission ${prefix}.collection.get has a build placeholder the build properties do not define. '
      + 'The tool could not read /permissionSets/1 in the template (see B001), so it could not check that the required permissions are defined. A reviewer must judge whether the permissions fit the endpoints.'],
    ['a *.all permission in a list the tool cannot fully read', () => rmbModule({ id: 'mod-users-1.0.0', provides: [{ id: 'users', version: '1.0', handlers: [
      { methods: ['GET'], pathPattern: '/users', permissionsRequired: ['users.all', 'x.all', 5] },
      { methods: ['GET'], pathPattern: '/users/{id}', permissionsRequired: null }] }], permissionSets: [] }),
    EvaluationStatus.FAIL, 'B007 fail: An endpoint requires *.all permissions: GET /users (users.all) and GET /users (x.all); a *.all permission grants a whole module\'s permissions, '
      + 'so an endpoint should require only what it needs. The tool could not read the permissions at /provides/0/handlers/0 and /provides/0/handlers/1 in the template (see B001).']
  ])('%s', async (_name, root, status, evidence) => {
    const { result } = await b007(root());
    expect(result.status).toBe(status);
    expect(result.evidence).toBe(evidence);
  });

  it('gives the agent the interfaces it flagged first, then the others by line, up to 25 obligations', async () => {
    const provides = Array.from({ length: 30 }, (_, index) => ({ id: `i${index}`, version: '1.0', handlers: [
      { methods: ['GET'], pathPattern: `/i${index}`, permissionsRequired: index === 29 ? [] : ['users.collection.get'] }] }));
    const { analysis } = await b007(rmbModule({ id: 'mod-users-1.0.0', provides, permissionSets: [set('users.collection.get')] }));
    const given = analysis.checklist.items.flatMap(item => item.obligations.filter(obligation => !obligation.withheld).map(obligation => obligation.id));

    expect(given).toEqual(['B007-C1#1', 'B007-C1#2', 'B007-C1#3', 'B007-C1#4', 'B007-C1#5', 'B007-C1#6', 'B007-C1#7', 'B007-C1#8', 'B007-C1#9', 'B007-C1#10',
      'B007-C1#11', 'B007-C1#12', 'B007-C2#1', 'B007-C3#1', 'B007-C3#2', 'B007-C3#3', 'B007-C3#4', 'B007-C3#5', 'B007-C3#6', 'B007-C3#7', 'B007-C3#8',
      'B007-C3#9', 'B007-C3#10', 'B007-C3#11', 'B007-C3#12']);
  });

  it('leaves the checklist to the reviewer when no handler could be read', async () => {
    const { result, analysis } = await b007(rmbModule({ id: 'mod-users-1.0.0', provides: [{ id: 'users', version: '1.0', handlers: ['not a handler'] }] }));
    expect(result.evidence).toBe('B007 manual: The tool could not read the permissions at /provides/0/handlers/0 in the template (see B001). A reviewer must judge whether the permissions fit the endpoints.');
    expect(analysis.checklist.items.map(item => [item.id, item.reviewerOnly, item.obligations.length])).toEqual([['B007-C1', true, 0], ['B007-C3', true, 0]]);
  });

  it('fails on a required permission when the template has no permission sets', async () => {
    const { result } = await b007(rmbModule({ id: 'mod-users-1.0.0', provides: [{ id: 'users', version: '1.0', handlers: [
      { methods: ['GET'], pathPattern: '/users', permissionsRequired: ['users.collection.get'] }] }] }));
    expect(result.status).toBe(EvaluationStatus.FAIL);
  });

  it('takes the module name from Gradle\'s rootProject.name when there is no pom.xml', async () => {
    const { analysis } = await b007(repository({
      'service/build.gradle': '',
      'service/settings.gradle': 'pluginManagement {}\nrootProject.name="mod-agreements"\n',
      'service/grails-app/conf/application.yml': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': JSON.stringify({ id: 'mod-agreements-1.0.0',
        provides: [{ id: 'erm', version: '7.5', handlers: [{ methods: ['GET'], pathPattern: '/erm/sas', permissionsRequired: ['erm.sas.collection.get'] }] }],
        permissionSets: [set('erm.sas.collection.get'), set('agreements.sas.collection.get')] })
    }));
    expect([analysis.permissionPrefix, analysis.permissionPrefixSource]).toEqual(['agreements', 'service/settings.gradle rootProject.name mod-agreements']);
    expect(analysis.namingDeviations).toEqual([{ permission: 'erm.sas.collection.get', problems: ['prefix'], line: 1 }]);
  });

  it('reads many endpoints and permission names in linear time', async () => {
    const descriptor = (size: number) => ({
      id: 'mod-users-1.0.0',
      provides: Array.from({ length: size / 10 }, (_, index) => ({ id: `i${index}`, version: '1.0', handlers: Array.from({ length: 10 }, (_unused, handler) => ({
        methods: ['GET'], pathPattern: `/i${index}/h${handler}`, permissionsRequired: [`users.p${index}-${handler}.get`], modulePermissions: [`x${'-a'.repeat(10)}.all`]
      })) })),
      permissionSets: Array.from({ length: size }, (_, index) => set(`users.p${Math.floor(index / 10)}-${index % 10}${'-a'.repeat(10)}A.get`))
    });
    const analysis = await expectLinearTime(500, async size => {
      const root = repository({ 'pom.xml': pom('mod-users', restVerticleBuild), [TEMPLATE]: JSON.stringify(descriptor(size)) });
      return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
    }, async evidence => evaluateB007(evidence));
    expect(analysis.findings.filter(finding => finding.problem === 'undefined-required')).toHaveLength(2_000);
    expect(analysis.namingDeviations).toHaveLength(2_000);
  });

  it('summarizes one interface with many endpoints for the agent in linear time', async () => {
    const request = await expectLinearTime(2_000, async size => {
      const root = repository({ 'pom.xml': pom('mod-users', restVerticleBuild), [TEMPLATE]: JSON.stringify({ id: 'mod-users-1.0.0',
        provides: [{ id: 'users', version: '1.0', handlers: Array.from({ length: size }, (_, index) => ({ methods: ['GET'], pathPattern: `/u${index}`, permissionsRequired: ['users.collection.get'] })) }],
        permissionSets: [set('users.collection.get')] }) });
      return { root, analysis: evaluateB007(await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root)) };
    }, async ({ root, analysis }) => buildB007AgentReviewRequest(root, analysis, () => []));
    const summary = JSON.parse(request.files.find(file => file.repoRelativePath === '.criterion-agent/B007/evidence-summary.json')!.content);
    expect(summary.interfaces.items[0].endpoints.items.length).toBeGreaterThan(0);
  });

  describe('agent review', () => {
    const fakeConfig = (fields: Record<string, unknown>, enabledCriteria?: string[]): CriterionAgentReviewConfig => ({
      enabled: true, adapter: 'fake', modelLabel: 'fake-model', ...(enabledCriteria ? { enabledCriteria } : {}), fakeResult: {
        available: true, criterionId: 'B007', recommendation: 'needs_reviewer_judgment', confidence: 'medium', summary: 'One permission is too broad.',
        rationale: 'Read the template and the resource class.', evidenceReferences: [TEMPLATE], warnings: [], errors: [], ...fields
      } as CriterionAgentReviewConfig['fakeResult']
    });
    const assessment = (technologyId: string, fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
      technologyId, type: 'aligned_fact', summary: 'Fits.', evidenceReferences: [TEMPLATE], coverageDisposition: 'investigated', ...fields
    });
    const withImplementation = () => rmbModule({
      id: 'mod-users-1.0.0',
      provides: [{ id: 'users', version: '16.4', handlers: [{ methods: ['GET'], pathPattern: '/users', permissionsRequired: ['users.collection.get'] }] }],
      permissionSets: [set('users.collection.get')]
    }, {
      'ramls/users.raml': '#%RAML 1.0\ntitle: Users\n/users:\n  get:\n',
      'src/main/java/org/folio/rest/impl/UsersAPI.java': 'package org.folio.rest.impl;\npublic class UsersAPI implements org.folio.rest.jaxrs.resource.Users {\n}\n',
      'src/test/java/UsersTest.java': 'class UsersTest {}'
    });

    it('runs by default and attaches results to the checklist items, keeping the status', async () => {
      const { result } = await b007(rmbModule(manualDescriptor), fakeConfig({
        assessments: [assessment('B007-C1#1', { type: 'substantive_concern', summary: 'POST /users requires users.allops, broader than a write.' }),
          assessment('B007-C2#1', { coverageDisposition: undefined })],
        reviewerActions: []
      }));

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.agentReview?.available).toBe(true);
      const details = result.details!.split('\n');
      expect(details.slice(details.indexOf('  - B007-C1 Each endpoint\'s permission fits what it does: a read permission for a read and a write permission for a write, an item permission for one record and a collection permission for many.') + 4,
        details.indexOf('  - B007-C3 Each endpoint\'s modulePermissions cover every interface its implementation calls, without *.all permissions.'))).toEqual([
        '    - Agent: Potential problem — interface users (#/provides/1): POST /users requires users.allops, broader than a write.',
        '      - Sources:', `        - ${TEMPLATE}`, '      - Coverage judgment: Investigated directly',
        '    - No agent result: interface public-lookup (#/provides/2)',
        '  - B007-C2 Each endpoint without a permission is meant to be public, and exposes or changes no tenant data.',
        '    - Start with:',
        `      - ${TEMPLATE}:52 — GET /public/lookup: permissionsRequired is empty`,
        `      - ${TEMPLATE}:59 — GET /public/other: permissionsRequired is missing`,
        '    - Agent result dropped — interface public-lookup (#/provides/2): It gives no coverage judgment.'
      ]);
      expect(details).toContain(`Agent review scope: ${result.criterionDetails && (result.criterionDetails as B007Analysis).agentBrowseScope}`);
    });

    it('does not run for a fail, and says why', async () => {
      const { result } = await b007(rmbModule({ id: 'mod-users-1.0.0', provides: [{ id: 'users', version: '1.0', handlers: [
        { methods: ['GET'], pathPattern: '/users', permissionsRequired: ['users.all'] }] }], permissionSets: [set('users.all')] }), fakeConfig({}));
      expect(result.agentReview).toBeUndefined();
      expect(result.details?.split('\n').slice(-2)).toEqual(['Agent review:',
        '  - Not applied: agent review runs only for manual results; each *.all or undefined permission an endpoint requires must be replaced first']);
    });

    it('does not run when the list names other criteria', async () => {
      const { result } = await b007(rmbModule(manualDescriptor), fakeConfig({}, ['S004']));
      expect(result.agentReview).toBeUndefined();
      expect(result.details?.split('\n').slice(-2)).toEqual(['Agent review:', '  - Not applied: agent review is not enabled for B007']);
    });

    it('gives the agent each interface\'s endpoints with their permissions and implementing class, and browses production source only', async () => {
      const root = withImplementation();
      const { analysis } = await b007(root);
      const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
      const { evaluateB003 } = await import('../utils/b003-endpoint-implementations');
      const { getBackendApiSpecs } = await import('../utils/backend-api-specs');
      const { b007Implementations } = await import('../utils/b007-agent-review');
      const implementations = b007Implementations(evaluateB003(await getBackendEvidence(run, root), await getBackendApiSpecs(run, root)));
      const prepared = await prepareCriterionAgentReviewEvidence(buildB007AgentReviewRequest(root, analysis, implementations));
      const summary = JSON.parse(prepared.request.files.find(file => file.repoRelativePath === '.criterion-agent/B007/evidence-summary.json')!.content);

      expect(summary.interfaces.items).toEqual([{ interfaceId: 'users', pointer: '/provides/0', endpoints: { items: [{
        methods: ['GET'], path: '/users', line: 8, permissionsRequired: ['users.collection.get'], modulePermissions: [],
        implementedBy: ['src/main/java/org/folio/rest/impl/UsersAPI.java:2']
      }] } }]);
      expect([...prepared.availableSourcePaths].sort()).toEqual([TEMPLATE, 'pom.xml', 'ramls/users.raml', 'src/main/java/org/folio/rest/impl/UsersAPI.java']);
      expect(prepared.request.defaultTimeoutMs).toBe(600_000);
    });
  });
});
