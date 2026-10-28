import * as fs from 'fs';
import * as path from 'path';
import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B001Analysis, EvaluationStatus } from '../types';
import { getBackendEvidence } from '../utils/backend-evidence';
import { createEvaluationRun } from '../utils/evaluation-run';
import { dependency, git, pom, repository, restVerticleBuild } from './helpers/backend-repository';

async function b001(root: string, run = createEvaluationRun({ repositoryPath: root, language: 'java' })) {
  const result = await new BackendEvaluator().evaluateCriterion('B001', root, run);
  return { result, analysis: result.criterionDetails as B001Analysis };
}

describe('B001 module descriptor template', () => {
  it('resolves Maven placeholders, including the parent version and properties built from other properties', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', '<parent><groupId>org.folio</groupId><artifactId>parent</artifactId><version>5.0.0</version></parent>'
        + '<properties><api.major>2</api.major><api.version>${api.major}.1</api.version></properties>'),
      'descriptors/ModuleDescriptor-template.json': JSON.stringify({
        id: '${artifactId}-${version}',
        provides: [{ id: 'example', version: '${api.version}', handlers: [] }],
        launchDescriptor: { dockerImage: '${artifactId}:${project.version}' }
      })
    });

    const { result, analysis } = await b001(root);
    const evidence = await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B001 pass: descriptors/ModuleDescriptor-template.json matches the Okapi ModuleDescriptor schema '
      + '(checked with build placeholders such as ${artifactId} replaced). S002 checks the descriptor the build produces.');
    // The later B criteria read the parsed template with the build's values in place.
    expect(evidence.template?.descriptor).toEqual({
      id: 'mod-example-5.0.0',
      provides: [{ id: 'example', version: '2.1', handlers: [] }],
      launchDescriptor: { dockerImage: 'mod-example:5.0.0' }
    });
    expect(analysis.template?.placeholders).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '${version}', value: '5.0.0', source: 'pom.xml <version>' }),
      expect.objectContaining({ text: '${api.version}', value: '2.1', source: 'pom.xml <properties>' })
    ]));
    expect(analysis.checklist.items).toEqual([]);
  });

  it('resolves a Grails template from the nearest gradle.properties and leaves undefined placeholders in strings as written', async () => {
    const root = repository({
      'gradle.properties': 'okapiInterfaceVersion=1.0\n',
      'service/gradle.properties': 'appName=mod-example\nokapiInterfaceVersion=7.5\n',
      'service/build.gradle': 'apply plugin: "org.grails.grails-web"\n',
      'service/grails-app/domain/org/example/Thing.groovy': 'class Thing implements MultiTenant<Thing> {}\n',
      'service/grails-app/conf/application.yml': 'dataSource:\n  url: jdbc:postgresql://localhost/db\n',
      'service/src/main/okapi/ModuleDescriptor-template.json': JSON.stringify({
        id: '${info.app.name}-${info.app.version}',
        provides: [{ id: 'erm', version: '${okapiInterfaceVersion}' }]
      })
    });

    const { result, analysis } = await b001(root);
    const evidence = await getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(evidence.template?.descriptor).toEqual({ id: '${info.app.name}-${info.app.version}', provides: [{ id: 'erm', version: '7.5' }] });
    expect(analysis.template?.placeholders).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '${info.app.name}', value: undefined, pointers: ['/id'] }),
      expect.objectContaining({ text: '${okapiInterfaceVersion}', value: '7.5', source: 'service/gradle.properties' })
    ]));
    expect(result.evidence).toContain('${info.app.name} and ${info.app.version} left as written, because the build properties do not define them');
    expect(evidence.framework.name).toBe('grails');
    expect(evidence.storage.present).toBe(true);
  });

  it('leaves a property cycle, and a property built from an undefined one, unresolved without exponential work', async () => {
    // Each level refers to the one below twice and p0 is undefined: without a cache, resolving p40 takes 2^40 steps.
    const levels = Array.from({ length: 40 }, (_level, index) => `<p${index + 1}>\${p${index}}\${p${index}}</p${index + 1}>`).join('');
    const root = repository({
      'pom.xml': pom('mod-example', `<properties>${levels}<a>\${b}</a><b>\${a}</b></properties>`),
      'descriptors/ModuleDescriptor-template.json': '{"id": "${a}", "name": "${p40}"}'
    });

    const { result, analysis } = await b001(root);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(analysis.template?.placeholders).toEqual([
      expect.objectContaining({ text: '${a}', value: undefined, pointers: ['/id'] }),
      expect.objectContaining({ text: '${p40}', value: undefined, pointers: ['/name'] })
    ]);
  }, 10_000);

  it.each([
    // A resolved value would make it valid JSON, but the build decides what is written there.
    ['a placeholder in a number position', pom('mod-example', '<properties><timeout>3000</timeout></properties>'),
      '{"id": "${artifactId}", "launchDescriptor": {"timeout": ${timeout}}}', EvaluationStatus.MANUAL, 'template-placeholders-outside-strings'],
    ['JSON that is invalid after substitution', pom('mod-example'), '{"id": "${artifactId}",}', EvaluationStatus.FAIL, 'template-invalid-json'],
    ['a schema problem', pom('mod-example'), '{"id": "${artifactId}", "provides": "example"}', EvaluationStatus.FAIL, 'template-schema-errors']
  ])('decides on %s', async (_name, pomXml, template, status, basis) => {
    const root = repository({ 'pom.xml': pomXml, 'descriptors/ModuleDescriptor-template.json': template });

    const { result, analysis } = await b001(root);

    expect(result.status).toBe(status);
    expect(analysis.basis).toBe(basis);
    expect(analysis.checklist.items.map(item => item.id)).toEqual(['B001-C1']);
    if (basis === 'template-schema-errors') {
      expect(analysis.schemaProblems).toEqual(['Field "provides" must be an array or null']);
    }
  });

  it('needs review when several descriptor candidates are committed', async () => {
    const root = repository({
      'pom.xml': pom('mod-example'),
      'descriptors/ModuleDescriptor-template.json': '{"id": "a"}',
      'ModuleDescriptor.json': '{"id": "b"}'
    });

    const { result, analysis } = await b001(root);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.checklist.items[0].startingPoints.map(point => point.path))
      .toEqual(['ModuleDescriptor.json', 'descriptors/ModuleDescriptor-template.json', 'pom.xml']);
  });

  it.each([
    // An edge module is recognised by its artifactId and its edge-common dependency, so without a template it fails.
    ['an edge module without a template', pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      EvaluationStatus.FAIL, 'edge-module'],
    ['an edge-common-spring module without a template', pom('edge-example', `<dependencies>${dependency('edge-common-spring')}</dependencies>`),
      EvaluationStatus.FAIL, 'edge-module'],
    // An edge- name alone is not enough.
    ['an edge- artifactId without an edge-common dependency', pom('edge-example', `<dependencies>${dependency('vertx-core', 'io.vertx')}</dependencies>`),
      EvaluationStatus.MANUAL, 'ambiguous'],
    // edge-common is a shared library, not an edge module without a descriptor.
    ['edge-common', pom('edge-common', `<dependencies>${dependency('vertx-core', 'io.vertx')}</dependencies>`), EvaluationStatus.NOT_APPLICABLE, 'library'],
    ['edge-common-spring', pom('edge-common-spring', `<dependencies>${dependency('folio-spring-base')}</dependencies>`), EvaluationStatus.NOT_APPLICABLE, 'library'],
    ['a Java repository that is neither a known library nor has a descriptor', pom('mod-example'), EvaluationStatus.MANUAL, 'ambiguous']
  ])('classifies %s', async (_name, pomXml, status, kind) => {
    const root = repository({ 'pom.xml': pomXml, 'src/main/java/org/example/App.java': 'class App {}\n' });

    const { result, analysis } = await b001(root);

    expect(result.status).toBe(status);
    expect(analysis.kind).toBe(kind);
    if (kind === 'ambiguous') {
      expect(result.evidence).toBe('B001 manual: No module descriptor was found, and the repository is not a known shared library. '
        + 'A module must have one; a library need not.');
      expect(analysis.checklist.items.map(item => item.id)).toEqual(['B001-C2']);
    }
    if (kind === 'edge-module') {
      expect(result.evidence).toBe('B001 fail: edge-example is an edge module, but it has no module descriptor template. '
        + 'Commit one at descriptors/ModuleDescriptor-template.json.');
    }
  });

  it('passes an edge module with a valid template', async () => {
    const root = repository({
      'pom.xml': pom('edge-example', `<dependencies>${dependency('edge-common')}</dependencies>`),
      'descriptors/ModuleDescriptor-template.json': '{"id": "${artifactId}-1.0.0", "provides": []}'
    });

    const { result, analysis } = await b001(root);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(analysis.kind).toBe('edge-module');
    expect(analysis.framework.name).toBe('edge');
  });

  it('reports S002\'s generated descriptor without deciding on it', async () => {
    const root = repository({ 'pom.xml': pom('mod-example'), 'descriptors/ModuleDescriptor-template.json': '{"id": "${artifactId}-1.0.0"}' });
    const generated = path.join(root, 'target', 'ModuleDescriptor.json');
    fs.mkdirSync(path.dirname(generated));
    fs.writeFileSync(generated, '{"provides": "x"}');
    const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
    run.artifacts.moduleDescriptor = {
      status: 'produced', strategy: 'maven-generation', descriptorPath: 'target/ModuleDescriptor.json', absolutePath: generated, warnings: [], errors: []
    };

    const { result } = await b001(root, run);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.details).toContain('Generated descriptor: target/ModuleDescriptor.json, generated by the build for S002, has 2 schema problems '
      + '(S002 reports it; B001 checks the committed template)');
  });
});

describe('backend evidence', () => {
  const evidenceFor = (root: string) => getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);

  it('detects RMB from RestVerticle as the main verticle in a multi-module layout, without schema.json', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', '<modules><module>mod-example-server</module></modules>'),
      'mod-example-server/pom.xml': pom('mod-example-server', `<dependencies>${dependency('domain-models-runtime')}</dependencies>${restVerticleBuild}`),
      'mod-example-server/src/main/java/org/example/ExampleApi.java':
        'import org.folio.rest.persist.PgUtil;\nclass ExampleApi {\n  void get() { PgUtil.get(null, null); }\n}\n',
      'descriptors/ModuleDescriptor-template.json': '{"id": "${artifactId}"}'
    });

    const evidence = await evidenceFor(root);

    expect(evidence.framework).toEqual({ name: 'rmb', evidence: ['mod-example-server/pom.xml sets org.folio.rest.RestVerticle as the main verticle'] });
    expect(evidence.storage).toEqual({ present: true, evidence: ['PostgresClient or PgUtil used in mod-example-server/src/main/java/org/example/ExampleApi.java'] });
  });

  it('does not count a domain-models-runtime dependency as RMB or storage (mod-circulation)', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', `<dependencies>${dependency('domain-models-runtime')}</dependencies>`
        + '<build><plugins><plugin><configuration><manifestEntries><Main-Class>org.folio.example.Launcher</Main-Class></manifestEntries></configuration></plugin></plugins></build>'),
      'src/main/java/org/folio/example/ExampleVerticle.java':
        'import org.folio.rest.tools.utils.LogHelper;\nimport org.folio.rest.persist.PostgresClient;\npublic class ExampleVerticle extends AbstractVerticle {}\n',
      'src/main/resources/application.yml': 'kafka:\n  host: localhost\n',
      'descriptors/ModuleDescriptor-template.json': '{"id": "${artifactId}"}'
    });

    const evidence = await evidenceFor(root);

    expect(evidence.framework.name).toBe('vertx');
    expect(evidence.storage).toEqual({ present: false, evidence: [] });
  });

  it('reads only the paths the B criteria use, so test binaries and submodules leave the evidence complete', async () => {
    const root = repository({
      'pom.xml': pom('mod-example'),
      'descriptors/ModuleDescriptor-template.json': '{"id": "${artifactId}"}',
      'src/test/resources/large.jpg': Buffer.concat([Buffer.from([0xff, 0xd8, 0]), Buffer.alloc(300 * 1024)]),
      'docs/diagram.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]),
      'docs/API/paths/items.yaml': 'get:\n  summary: items\n',
      'src/main/java/org/example/App.java': 'class App {}\n',
      'reference-data/groups/staff.json': '{"group": "staff"}',
      'src/main/resources/ref-data/addresstypes-1.0.0/home.json': '{"addressType": "Home"}'
    });
    // RMB modules include shared RAML as git submodules: raml-util, and acq-models in the acquisitions modules.
    for (const submodule of ['ramls/raml-util', 'ramls/acq-models']) {
      git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD')},${submodule}`);
    }
    git(root, 'commit', '-qm', 'submodules');

    const evidence = await evidenceFor(root);

    expect(evidence.snapshot.complete).toBe(true);
    expect(evidence.snapshot.files.map(file => file.path))
      .toEqual(['descriptors/ModuleDescriptor-template.json', 'docs/API/paths/items.yaml', 'pom.xml', 'src/main/java/org/example/App.java']);
    // Reference data is listed for the criteria that need its folder names, not read.
    expect(evidence.snapshot.listedPaths).toEqual(['reference-data/groups/staff.json', 'src/main/resources/ref-data/addresstypes-1.0.0/home.json']);
  });

  it('reads files of up to 1 MB, since data and OpenAPI specs over 256 KB share folders, and counts a larger one', async () => {
    // Just under 1 MB; the real COUNTER_API.json is 816 KB.
    const spec = JSON.stringify({ openapi: '3.1.0', info: { title: 'COUNTER API', description: 'x'.repeat(1000 * 1024) }, paths: {} });
    const root = repository({
      'pom.xml': pom('mod-example'),
      'descriptors/ModuleDescriptor-template.json': '{"id": "${artifactId}"}',
      // mod-source-record-manager's MARC mapping rules and mod-erm-usage-counter's COUNTER_API.json.
      'mod-example-server/src/main/resources/rules/marc_bib_rules.json': JSON.stringify({ LDR: 'r'.repeat(600 * 1024) }),
      'src/main/resources/COUNTER_API.json': spec
    });

    const evidence = await evidenceFor(root);

    expect(evidence.snapshot.complete).toBe(true);
    expect(evidence.snapshot.diagnostics).toEqual([]);
    expect(evidence.snapshot.files.find(file => file.path === 'src/main/resources/COUNTER_API.json')?.content).toBe(spec);

    // A larger file could still be a spec, so it still makes the evidence incomplete.
    fs.writeFileSync(path.join(root, 'src/main/resources/openapi.yaml'), `openapi: 3.0.0\ninfo:\n  description: ${'y'.repeat(1024 * 1024)}\n`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'larger spec');

    const larger = await evidenceFor(root);

    expect(larger.snapshot.complete).toBe(false);
    expect(larger.snapshot.diagnostics).toEqual([expect.objectContaining({ code: 'file-size', material: true, path: 'src/main/resources/openapi.yaml' })]);
  });

  it('detects Spring Boot from its application class and storage from Spring\'s default Liquibase changelog', async () => {
    const root = repository({
      'pom.xml': pom('mod-example', `<version>2.0.0</version><dependencies>${dependency('folio-spring-base')}</dependencies>`),
      'src/main/java/org/folio/example/ExampleApplication.java': '@SpringBootApplication\npublic class ExampleApplication {}\n',
      'src/main/resources/db/changelog/db.changelog-master.yaml': 'databaseChangeLog: []\n',
      'src/main/resources/application.yml': 'folio:\n  tenant:\n    validation:\n      enabled: true\n',
      'descriptors/ModuleDescriptor-template.json': '{"id": "@artifactId@-@version@", "name": "5\\" floppy for @artifactId@"}'
    });

    const evidence = await evidenceFor(root);
    const { result } = await b001(root);

    expect(evidence.framework).toEqual({ name: 'spring', evidence: [
      '@SpringBootApplication in src/main/java/org/folio/example/ExampleApplication.java', 'folio-spring-base in pom.xml'] });
    expect(evidence.storage.evidence).toEqual(['Liquibase changelog src/main/resources/db/changelog/db.changelog-master.yaml']);
    // An escaped quote does not end the string, so the @artifactId@ after it is still inside one.
    expect(evidence.template?.descriptor).toEqual({ id: 'mod-example-2.0.0', name: '5" floppy for mod-example' });
    expect(result.status).toBe(EvaluationStatus.PASS);
  });
});
