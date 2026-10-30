import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B005Analysis, EvaluationStatus } from '../types';
import { evaluateB005 } from '../utils/b005-interface-naming';
import { getBackendEvidence } from '../utils/backend-evidence';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, pom, repository, restVerticleBuild } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b005(root: string, existingModule = false) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java', existingModule });
  const result = await new BackendEvaluator().evaluateCriterion('B005', root, run);
  return { result, analysis: result.criterionDetails as B005Analysis };
}

type Provided = { id: string; version: string; interfaceType?: string; handlers?: Array<[string[], string]> };

function template(provides: Provided[]): string {
  return JSON.stringify({
    id: '${artifactId}-1.0.0',
    provides: provides.map(({ handlers = [], ...provided }) => ({ ...provided, handlers: handlers.map(([methods, pathPattern]) => ({ methods, pathPattern })) }))
  });
}

const rmbModule = (provides: Provided[]) => repository({
  'pom.xml': pom('mod-example', restVerticleBuild),
  'descriptors/ModuleDescriptor-template.json': template(provides)
});

const grailsModule = (versionText: string, gradleProperties?: string) => repository({
  'service/build.gradle': '',
  ...(gradleProperties === undefined ? {} : { 'service/gradle.properties': gradleProperties }),
  'service/src/main/okapi/ModuleDescriptor-template.json': `{"id": "mod-example-1.0.0", "provides": [{"id": "erm", "version": ${versionText}, "handlers": [{"methods": ["GET"], "pathPattern": "/erm/sas"}]}]}`
});

const namingViolations: Provided[] = [
  { id: 'users', version: '16.6', handlers: [[['GET'], '/users']] },
  { id: 'users.settings', version: '2.0', handlers: [[['GET'], '/user/settings']] },
  { id: 'item_storage', version: '1.2.3', handlers: [[['GET'], '/item-storage/items']] },
  { id: 'loans', version: '1', handlers: [[['GET'], '/loans']] },
  { id: '_tenant', version: '2.0', interfaceType: 'system', handlers: [[['POST'], '/_/tenant']] },
  { id: '_jsonSchemas', version: '1.0', interfaceType: 'multiple' },
  { id: 'timer.x_y', version: '1', interfaceType: 'system' }
];

describe('B005 interface naming', () => {
  it('fails on dots, underscores and versions that are not major.minor, leaving system interfaces out', async () => {
    const { result, analysis } = await b005(rmbModule(namingViolations));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B005 fail: 2 interfaces use dots or underscores: "users.settings" (a dot) and "item_storage" (an underscore); interface names are words joined by hyphens. '
      + '2 interfaces have versions that are not major.minor (the first two parts of a semantic version): "item_storage" 1.2.3 and "loans" 1.');
    expect(result.details?.split('\n')).toEqual([
      'Evaluated as: a new module (the default)',
      'Interfaces: 4 in descriptors/ModuleDescriptor-template.json, without the system interfaces _tenant, _jsonSchemas, and timer.x_y',
      'Names with a dot or underscore:',
      '  - users.settings — a dot',
      '  - item_storage — an underscore',
      'Versions that are not major.minor:',
      '  - item_storage 1.2.3',
      '  - loans 1',
      'Routes found in the source: 0',
      'Names that differ from the first segment of their handler paths (information only):',
      '  - users.settings — /user',
      '  - item_storage — /item-storage',
      'What to do:',
      '  - Rename each interface listed under "Names with a dot or underscore" to words joined by hyphens, and give each interface listed under "Versions that are not major.minor" a major.minor version.'
    ]);
    expect(analysis.checklist.items).toEqual([]);
  });

  it('leaves the same violations to the reviewer in an existing-module evaluation', async () => {
    const { result, analysis } = await b005(rmbModule(namingViolations), true);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B005 manual: 2 interfaces use dots or underscores: "users.settings" (a dot) and "item_storage" (an underscore); interface names are words joined by hyphens. '
      + '2 interfaces have versions that are not major.minor (the first two parts of a semantic version): "item_storage" 1.2.3 and "loans" 1. '
      + 'In an existing-module evaluation (--existing-module) this is not a fail, because renaming an interface or changing its version breaks the modules that use it. A reviewer must check them.');
    expect(result.details?.split('\n')).toEqual([
      'Evaluated as: an existing module (--existing-module)',
      'Interfaces: 4 in descriptors/ModuleDescriptor-template.json, without the system interfaces _tenant, _jsonSchemas, and timer.x_y',
      'Names with a dot or underscore:',
      '  - users.settings — a dot',
      '  - item_storage — an underscore',
      'Versions that are not major.minor:',
      '  - item_storage 1.2.3',
      '  - loans 1',
      'Routes found in the source: 0',
      'Names that differ from the first segment of their handler paths (information only):',
      '  - users.settings — /user',
      '  - item_storage — /item-storage',
      'Checklist for the reviewer:',
      '  - B005-C2 Each interface listed for review has a name of words joined by hyphens and a major.minor version, or a reason to keep the ones it has.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json — users.settings: a dot',
      '      - descriptors/ModuleDescriptor-template.json — item_storage: an underscore and version not major.minor',
      '      - descriptors/ModuleDescriptor-template.json — loans: version not major.minor'
    ]);
    expect(analysis.existingModule).toBe(true);
  });

  it.each(['1.0', '0.13', '10.25'])('accepts the major.minor version %s', async version => {
    expect((await b005(rmbModule([{ id: 'item-storage', version }]))).result.status).toBe(EvaluationStatus.PASS);
  });

  it.each(['1.2.3', '1', '01.2', '1.02', 'v1.0', '1.0 ', '1.0-SNAPSHOT', ''])('fails the version %j', async version => {
    const { result } = await b005(rmbModule([{ id: 'item-storage', version }]));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe(`B005 fail: The interface "item-storage" has version ${version || '""'}, which is not major.minor (the first two parts of a semantic version).`);
  });

  it('leaves uppercase letters and other characters to the reviewer instead of failing', async () => {
    const { result, analysis } = await b005(rmbModule([
      { id: 'Users-Settings', version: '1.0' },
      { id: 'item storage', version: '1.0' },
      { id: 'loans-', version: '1.0' },
      { id: 'notes', version: '1.0' }
    ]));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B005 manual: The interface "Users-Settings" has uppercase letters; the naming guide does not say whether interface names must be lowercase. '
      + '2 interfaces are not made of letters and digits joined by single hyphens: "item storage" and "loans-". A reviewer must check them.');
    expect(result.details?.split('\n')).toEqual([
      'Evaluated as: a new module (the default)',
      'Interfaces: 4 in descriptors/ModuleDescriptor-template.json',
      'Names with uppercase letters:',
      '  - Users-Settings',
      'Names not made of letters and digits joined by single hyphens:',
      '  - item storage',
      '  - loans-',
      'Routes found in the source: 0',
      'Checklist for the reviewer:',
      '  - B005-C2 Each interface listed for review has a name of words joined by hyphens and a major.minor version, or a reason to keep the ones it has.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json — Users-Settings: uppercase letters',
      '      - descriptors/ModuleDescriptor-template.json — item storage: not letters and digits joined by single hyphens',
      '      - descriptors/ModuleDescriptor-template.json — loans-: not letters and digits joined by single hyphens'
    ]);
    expect(analysis.interfaces.map(provided => provided.problems)).toEqual([['uppercase'], ['other-characters'], ['other-characters'], []]);
  });

  it('still fails an uppercase name that also has a dot', async () => {
    const { result } = await b005(rmbModule([{ id: 'Users.Settings', version: '1.0' }]));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B005 fail: The interface "Users.Settings" uses a dot; interface names are words joined by hyphens. '
      + 'The interface "Users.Settings" has uppercase letters; the naming guide does not say whether interface names must be lowercase.');
    expect(result.details?.split('\n')).toEqual([
      'Evaluated as: a new module (the default)',
      'Interfaces: 1 in descriptors/ModuleDescriptor-template.json',
      'Names with a dot or underscore:',
      '  - Users.Settings — a dot',
      'Names with uppercase letters:',
      '  - Users.Settings',
      'Routes found in the source: 0',
      'What to do:',
      '  - Rename each interface listed under "Names with a dot or underscore" to words joined by hyphens.',
      'Checklist for the reviewer:',
      '  - B005-C2 Each interface listed for review has a name of words joined by hyphens and a major.minor version, or a reason to keep the ones it has.',
      '    - Start with:',
      '      - descriptors/ModuleDescriptor-template.json — Users.Settings: a dot and uppercase letters'
    ]);
  });

  it.each([
    ['7.5', EvaluationStatus.PASS, 'B005 pass: The interface "erm" in the module descriptor has a name of words joined by hyphens and a major.minor version.'],
    ['7.5.1', EvaluationStatus.FAIL, 'B005 fail: The interface "erm" has version 7.5.1, which is not major.minor (the first two parts of a semantic version).']
  ])('checks a version placeholder resolved from gradle.properties as %s', async (value, status, evidence) => {
    const { result } = await b005(grailsModule('"${okapiInterfaceVersion}"', `okapiInterfaceVersion=${value}\n`));

    expect(result.status).toBe(status);
    expect(result.evidence).toBe(evidence);
    expect(result.details?.split('\n').slice(0, 4)).toEqual([
      'Evaluated as: a new module (the default)',
      'Interfaces: 1 in service/src/main/okapi/ModuleDescriptor-template.json',
      ...(status === EvaluationStatus.FAIL ? ['Versions that are not major.minor:', `  - erm ${value}`] : [
        'Resolved from build properties:',
        `  - erm version ${value} from \${okapiInterfaceVersion} (service/gradle.properties)`
      ])
    ]);
  });

  it.each([
    ['a version placeholder the build properties do not define', () => grailsModule('"${okapiInterfaceVersion}"'),
      'B005 manual: The tool could not check the version of "erm" (${okapiInterfaceVersion}), because the build properties do not define the build placeholder ${okapiInterfaceVersion}. A reviewer must check it.'],
    ['an undefined placeholder outside a string', () => grailsModule('${okapiInterfaceVersion}'),
      'B005 manual: The tool could not check the version of "erm", because it is missing or not a string in the template (see B001). A reviewer must check it.'],
    ['an id placeholder whose name has dots', () => rmbModule([{ id: '${info.app.name}', version: '1.0' }]),
      'B005 manual: The tool could not check the id "${info.app.name}", because the build properties do not define the build placeholder ${info.app.name}. A reviewer must check it.']
  ])('leaves %s to the reviewer', async (_name, root, evidence) => {
    const { result, analysis } = await b005(root());

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe(evidence);
    expect(analysis.interfaces[0].problems).not.toContain('dot');
  });

  it('reads placeholders at the pointer of the interface they are in, after system interfaces', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', `<properties><storageInterface>loan-storage</storageInterface></properties>${restVerticleBuild}`),
      'descriptors/ModuleDescriptor-template.json': template([
        { id: '_tenant', version: '2.0', interfaceType: 'system' },
        { id: 'loans', version: '${loansVersion}' },
        { id: '${storageInterface}', version: '7.5' }
      ])
    });

    const { result, analysis } = await b005(root);

    expect(result.evidence).toBe('B005 manual: The tool could not check the version of "loans" (${loansVersion}), because the build properties do not define the build placeholder ${loansVersion}. A reviewer must check it.');
    expect(result.details?.split('\n').slice(1, 6)).toEqual([
      'Interfaces: 2 in descriptors/ModuleDescriptor-template.json, without the system interface _tenant',
      'Build placeholders the build properties do not define:',
      '  - loans — in the version ${loansVersion}',
      'Resolved from build properties:',
      '  - loan-storage id loan-storage from ${storageInterface} (pom.xml <properties>)'
    ]);
    expect(analysis.interfaces.map(provided => [provided.pointer, provided.problems])).toEqual([['/provides/1', ['version-placeholder']], ['/provides/2', []]]);
  });

  it.each([
    ['an entry that is not an object, as an undefined placeholder outside a string leaves it', '[{"id": "items", "version": "1.0"}, ${more}]',
      'B005 manual: The template\'s provides has an entry that is not an interface object (/provides/1), as when a build placeholder outside a JSON string has no value, so the tool could not check it (see B001). A reviewer must check it.'],
    ['a provides that is not a list', '${providesJson}',
      'B005 manual: The template\'s provides is not a list, so the tool could not read the interfaces (see B001). A reviewer must check it.'],
    ['an interface without an id', '[{"version": "1.0"}]',
      'B005 manual: The tool could not check the id at /provides/0, because it is missing or not a string in the template (see B001). A reviewer must check it.']
  ])('leaves %s to the reviewer', async (_name, provides, evidence) => {
    const { result } = await b005(repository({
      'pom.xml': pom('mod-example', restVerticleBuild),
      'descriptors/ModuleDescriptor-template.json': `{"id": "mod-example-1.0.0", "provides": ${provides}}`
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe(evidence);
  });

  it('lists routes that no provided interface covers, counting wildcard, legacy-path and system-interface handlers', async () => {
    const root = repository({
      'pom.xml': pom('mod-example'),
      'descriptors/ModuleDescriptor-template.json': JSON.stringify({
        id: 'mod-example-1.0.0',
        provides: [
          { id: 'items', version: '1.0', handlers: [
            { methods: ['GET'], pathPattern: '/items/{itemId}' },
            { methods: ['GET', 'POST'], pathPattern: '/groups*' },
            { methods: ['GET'], pathPattern: '/things/special' },
            { methods: ['*'], path: '/legacy' }
          ] },
          { id: '_tenant', version: '2.0', interfaceType: 'system', handlers: [{ methods: ['POST'], pathPattern: '/_/tenant' }] }
        ]
      }),
      'src/main/java/org/example/Routes.java': [
        'public class Routes {',
        '  void register(Router router) {',
        '    router.get("/items/:id").handler(h);',
        '    router.post("/groups/members").handler(h);',
        '    router.get("/things/:id").handler(h);',
        '    router.post("/_/tenant").handler(h);',
        '    router.get("/admin/health").handler(h);',
        '    router.route("/static/*").handler(h);',
        '    router.delete("/items/:id").handler(h);',
        '    router.get("/hidden").handler(h);',
        '    router.route("/legacy/sub").handler(h);',
        '    router.route("/nowhere").handler(h);',
        '    router.get(base + "/x").handler(h);',
        '    // router.get("/commented").handler(h);',
        '  }',
        '}'
      ].join('\n')
    });

    const { result } = await b005(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B005 manual: 3 routes registered in the source are in no interface the module provides: DELETE /items/{id}, GET /hidden, and * /nowhere. '
      + 'The tool could not read 1 route in the source, so it could not check that it is in a provided interface. A reviewer must check them.');
    expect(result.details?.split('\n')).toEqual([
      'Evaluated as: a new module (the default)',
      'Interfaces: 1 in descriptors/ModuleDescriptor-template.json, without the system interface _tenant',
      'Routes found in the source: 8',
      'Routes in no provided interface:',
      '  - DELETE /items/{id} — src/main/java/org/example/Routes.java:9',
      '  - GET /hidden — src/main/java/org/example/Routes.java:10',
      '  - * /nowhere — src/main/java/org/example/Routes.java:12',
      'Routes the tool could not read:',
      '  - src/main/java/org/example/Routes.java:13',
      'Checklist for the reviewer:',
      '  - B005-C1 Each route the module implements for other modules is in an interface in provides.',
      '    - Start with:',
      '      - src/main/java/org/example/Routes.java:9 — DELETE /items/{id}: in no provided interface',
      '      - src/main/java/org/example/Routes.java:10 — GET /hidden: in no provided interface',
      '      - src/main/java/org/example/Routes.java:12 — * /nowhere: in no provided interface',
      '      - src/main/java/org/example/Routes.java:13 — route whose path the tool could not read'
    ]);
  });

  it.each([
    ['long wildcard handlers', Array.from({ length: 10 }, (_item, index): [string[], string] => [['GET'], `/w${index}${'x'.repeat(10_000)}*`]),
      Array.from({ length: 500 }, (_item, index) => `router.get("/r${index}").handler(h);`), 499, 3, 'GET /r1, GET /r2, GET /r3'],
    ['parameter routes that walk many handlers', Array.from({ length: 1_500 }, (_item, index): [string[], string] => [['GET'], `/a/h${index}`]),
      Array.from({ length: 1_500 }, (_item, index) => `router.get("/a/:p/r${index}").handler(h);`), 1_500, 2, 'GET /a/{p}/r0, GET /a/{p}/r1, GET /a/{p}/r2']
  ])('leaves routes to the reviewer when matching them stops at the tool\'s limit: %s', async (_name, handlers, routes, unmatched, firstLine, firstLabels) => {
    const root = repository({
      'pom.xml': pom('mod-example'),
      'descriptors/ModuleDescriptor-template.json': template([{ id: 'items', version: '1.0', handlers: [[['GET'], '/r0'], ...handlers] }]),
      'src/main/java/org/example/Routes.java': `class Routes { void r() {\n${routes.join('\n')}\n} }\n`
    });

    const { result, analysis } = await b005(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.unprovidedRoutes).toEqual([]);
    expect(analysis.unmatchedRoutes).toHaveLength(unmatched);
    expect(result.evidence).toBe(`B005 manual: The descriptor's handlers and the source's routes are too many to match within the tool's limit, so it could not check whether ${unmatched} routes are in a provided interface: `
      + `${firstLabels}, and ${unmatched - 3} more. A reviewer must check them.`);
    expect(result.details?.split('\n').slice(2, 5)).toEqual([
      `Routes found in the source: ${routes.length}`,
      'Routes not matched against every handler (too many to match):',
      `  - ${firstLabels.split(', ')[0]} — src/main/java/org/example/Routes.java:${firstLine}`
    ]);
  });

  it('checks an edge module\'s interface names but not its routes', async () => {
    const root = repository({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      'descriptors/ModuleDescriptor-template.json': template([{ id: 'edge_example', version: '1.0' }]),
      'src/main/java/org/folio/edge/example/MainVerticle.java': 'class MainVerticle { void routes() { router.get("/example/accounts").handler(h); } }\n'
    });

    const { result } = await b005(root);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.details?.split('\n')).toEqual([
      'Evaluated as: a new module (the default)',
      'Interfaces: 1 in descriptors/ModuleDescriptor-template.json',
      'Names with a dot or underscore:',
      '  - edge_example — an underscore',
      'Routes: not checked, because an edge module\'s routes serve clients outside FOLIO',
      'What to do:',
      '  - Rename each interface listed under "Names with a dot or underscore" to words joined by hyphens.'
    ]);
  });

  const unprovidedRoute = { 'src/main/java/org/example/Routes.java': 'class Routes { void r() { router.get("/hidden").handler(h); } }\n' };
  const systemOnly = template([{ id: '_tenant', version: '2.0', interfaceType: 'system', handlers: [[['POST'], '/_/tenant']] }]);
  it.each([
    ['a shared library', { 'pom.xml': pom('folio-spring-base') }, EvaluationStatus.NOT_APPLICABLE, 'library',
      'B005 not_applicable: The repository is a shared library, which provides no interfaces of its own.'],
    ['a repository that is neither a module nor a known library', { 'pom.xml': pom('mod-example') }, EvaluationStatus.MANUAL, 'no-descriptor',
      'B005 manual: No module descriptor template was found, so the interfaces the module provides are not known (see B001).'],
    ['a module whose template is not valid JSON', { 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': '{"provides": [' },
      EvaluationStatus.MANUAL, 'no-descriptor', 'B005 manual: The module descriptor template could not be read, so the interfaces the module provides are not known (see B001).'],
    ['an edge module that provides nothing',
      { 'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`), 'descriptors/ModuleDescriptor-template.json': '{"id": "edge-example-1.0.0", "provides": []}', ...unprovidedRoute },
      EvaluationStatus.NOT_APPLICABLE, 'no-interfaces', 'B005 not_applicable: descriptors/ModuleDescriptor-template.json provides no interfaces other than system interfaces.'],
    ['a module that provides only system interfaces', { 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': systemOnly },
      EvaluationStatus.NOT_APPLICABLE, 'no-interfaces', 'B005 not_applicable: descriptors/ModuleDescriptor-template.json provides no interfaces other than system interfaces.'],
    ['a module with a route the tool could not read',
      { 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': template([{ id: 'items', version: '1.0' }]),
        'src/main/java/org/example/Routes.java': 'class Routes { void r() { router.get(base + "/x").handler(h); } }\n' },
      EvaluationStatus.MANUAL, 'interfaces-checked', 'B005 manual: The tool could not read 1 route in the source, so it could not check that it is in a provided interface. A reviewer must check it.'],
    ['a module whose committed source was not read completely',
      { 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': template([{ id: 'items', version: '1.0' }]),
        'src/main/resources/data.json': `"${'x'.repeat(1024 * 1024)}"` },
      EvaluationStatus.MANUAL, 'interfaces-checked', 'B005 manual: The committed source was not read completely, so the tool may have missed routes. A reviewer must check it.'],
    ['a module that provides only system interfaces but registers another route',
      { 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': systemOnly, ...unprovidedRoute },
      EvaluationStatus.MANUAL, 'no-interfaces', 'B005 manual: descriptors/ModuleDescriptor-template.json provides no interfaces other than system interfaces. '
        + '1 route registered in the source is in no interface the module provides: GET /hidden. A reviewer must check it.']
  ])('decides %s', async (_name, files, status, basis, evidence) => {
    const { result, analysis } = await b005(repository(files));

    expect(result.status).toBe(status);
    expect(analysis.basis).toBe(basis);
    expect(result.evidence).toBe(evidence);
  });

  it('checks names, versions, placeholders and routes in linear time', async () => {
    const evidence = async (size: number) => {
      const root = repository({
        'pom.xml': pom('mod-example', `<properties>${Array.from({ length: size * 10 }, (_item, index) => `<name${index}>n${index}</name${index}>`).join('')}</properties>`),
        'descriptors/ModuleDescriptor-template.json': template([
          { id: `${'a-'.repeat(size * 50)}!`, version: `${'1'.repeat(size * 50)}.${'1'.repeat(size * 50)}.`, handlers: [[['GET'], '/w*'], [['GET'], '/x*']] },
          { id: `${'B'.repeat(size * 50)}_`, version: `${'0.'.repeat(size * 50)}` },
          ...Array.from({ length: size }, (_item, index) => ({ id: `\${name${index}}`, version: `\${version${index}}` })),
          ...Array.from({ length: size }, (_item, index) => ({ id: `i${index}`, version: '1.0', handlers: [[['GET'], `/r${index}/{id}`] as [string[], string]] })),
          { id: 'many', version: Array.from({ length: size * 10 }, (_item, index) => `\${name${index}}`).join(''),
            handlers: Array.from({ length: size }, (_item, index): [string[], string] => [['GET'], `/a/h${index}`]) }
        ]),
        'src/main/java/org/example/Routes.java': `class Routes { void r() {\n${Array.from({ length: size }, (_item, index) => `router.get("/r${index}/:id").handler(h);\nrouter.get("/w/${index}").handler(h);\n`).join('')}${'router.get("/a/:p").handler(h);\n'.repeat(50)}} }\n`
      });
      return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
    };

    const analysis = await expectLinearTime(250, evidence, async backendEvidence => evaluateB005(backendEvidence, false));

    expect(analysis.routeCount).toBe(2_050);
    expect(analysis.unprovidedRoutes).toEqual([]);
    expect(analysis.interfaces.slice(0, 3).map(provided => [provided.problems, provided.resolved.length])).toEqual([
      [['other-characters', 'version-format'], 0],
      [['underscore', 'uppercase', 'other-characters', 'version-format'], 0],
      [['version-placeholder'], 1]
    ]);
    expect(analysis.interfaces[analysis.interfaces.length - 1].resolved).toHaveLength(10_000);
  }, 120_000);
});
