import { createHash } from 'crypto';
import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B009Analysis, EvaluationStatus } from '../types';
import { evaluateB009 } from '../utils/b009-api-tests';
import { createEvaluationRun } from '../utils/evaluation-run';
import { loadS007Policy } from '../utils/s007-policy';
import { dependency, pom, repository } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';
import { loadRemoteFixture, RecordedResponses, replayTransport } from './helpers/remote-replay';

const INTEGRATION_TESTS = loadRemoteFixture('folio-integration-tests');
const LISTING = 'https://api.github.com/repos/folio-org/folio-integration-tests/contents/';
const MOD_USERS_TREE = 'https://api.github.com/repos/folio-org/folio-integration-tests/git/trees/e77c67c63e490071a7e09649b24bcfda7584c276?recursive=1';
const MOD_USERS_FILES = [
  'mod-users/src/main/resources/vega/mod-users/features/profile-picture.feature',
  'mod-users/src/main/resources/vega/mod-users/features/users.feature',
  'mod-users/src/main/resources/vega/mod-users/features/util/initData.feature',
  'mod-users/src/main/resources/vega/mod-users/users-junit.feature'
];

let unrecorded: string[] = [];
afterEach(() => {
  expect(unrecorded).toEqual([]);
  unrecorded = [];
});

async function b009(root: string, options: { responses?: RecordedResponses; repositoryName?: string } = {}) {
  const replay = options.responses ? replayTransport(options.responses) : undefined;
  const run = createEvaluationRun({ repositoryPath: root, repositoryName: options.repositoryName, language: 'java', remoteLookups: replay?.transport });
  const result = await new BackendEvaluator().evaluateCriterion('B009', root, run);
  unrecorded.push(...(replay?.unrecorded ?? []));
  return { result, analysis: result.criterionDetails as B009Analysis, requested: replay?.requested ?? [], rows: rows(result.details) };
}

function rows(details: string | undefined): string[] {
  return (details ?? '').split('\n').map(row => row.replace(/\(fetched [^;]+;/, '(fetched <time>;'));
}

function digest(responses: RecordedResponses, url: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(responses[url].body)).digest('hex')}`;
}

const backendModule = (artifactId: string, files: Record<string, string> = {}) => repository({
  'pom.xml': pom(artifactId),
  'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: `${artifactId}-1.0.0`, provides: [] }),
  ...files
});

const KARATE_FEATURE = 'Feature: users\n\n  Background:\n    * url baseUrl\n\n  Scenario: get\n    Given path \'users\'\n    When method get\n    Then status 200\n';
const CUCUMBER_FEATURE = ['Feature: users', '  Scenario: a librarian finds a user', '    Given url is set to the users endpoint', '    And path /users exists', '    And header Content-Type is application/json',
  '    When request is sent to users', '    And method get is called', '    Then status code is 200', '    And match the user named Jane', ''].join('\n');

function withFolder(name: string, tree: unknown, listing: unknown[] = INTEGRATION_TESTS[LISTING].body as unknown[]): RecordedResponses {
  const sha = 'a'.repeat(40);
  return {
    [LISTING]: { status: 200, body: [...listing, { name, path: name, sha, type: 'dir' }] },
    [`https://api.github.com/repos/folio-org/folio-integration-tests/git/trees/${sha}?recursive=1`]: { status: 200, body: tree }
  };
}

describe('B009 API tests in a supported technology', () => {
  it('passes Karate feature files in the folio-integration-tests folder named after the module', async () => {
    const { result, requested, rows: details } = await b009(backendModule('mod-users'), { responses: INTEGRATION_TESTS });

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B009 pass: folio-integration-tests has Karate feature files in mod-users/ (4 .feature files and karate-config.js). '
      + '(Karate is listed as provisional on the supported technologies page.)');
    expect(requested).toEqual([LISTING, MOD_USERS_TREE]);
    expect(details).toEqual([
      'Evaluated as: a backend module',
      'Policy: Karate (provisional) under backend-integration-testing',
      'API tests in the repository:',
      '  - none (no Karate or other .feature files, and no Postman, Bruno or Insomnia collections)',
      'folio-integration-tests (only a folder named after the module is searched):',
      '  - Module name: mod-users (from descriptors/ModuleDescriptor-template.json)',
      '  - Karate (on the supported technologies page): 4 .feature files, with mod-users/src/main/resources/karate-config.js',
      ...MOD_USERS_FILES.map(file => `    - ${file}`),
      'Policy note:',
      '  - The officially supported technologies page lists Karate as provisional. B009 passes Karate API tests, as decided for this criterion.',
      'Sources:',
      `  - ${LISTING} (fetched <time>; HTTP 200, ${digest(INTEGRATION_TESTS, LISTING)})`,
      `  - ${MOD_USERS_TREE} (fetched <time>; HTTP 200, ${digest(INTEGRATION_TESTS, MOD_USERS_TREE)})`
    ]);
  });

  it('is not applicable without an entry of exactly the module\'s name, such as mod-user (a prefix of mod-users), and says other names are not searched', async () => {
    const { result, analysis, requested } = await b009(backendModule('mod-user'), { responses: INTEGRATION_TESTS });

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.evidence).toBe('B009 not applicable: The repository has no API tests, and folio-integration-tests has no folder named mod-user. '
      + 'The tool looks only for a folder named after the module, so tests kept under another name (such as erm/ for mod-agreements) are not seen.');
    expect(requested).toEqual([LISTING]);
    expect(analysis.checklist.items).toEqual([]);
  });

  it('is manual when the entry of the module\'s name is not a folder, such as the file "git"', async () => {
    const { result, requested } = await b009(backendModule('git'), { responses: INTEGRATION_TESTS });

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B009 manual: folio-integration-tests could not be checked: The entry named git in folio-integration-tests is not a folder. A reviewer must check the module\'s API tests.');
    expect(requested).toEqual([LISTING]);
  });

  it('is manual when remote lookups are on but the module has no usable name', async () => {
    const root = repository({ 'descriptors/ModuleDescriptor-template.json': '{"id": "@artifactId@-@version@", "provides": []}' });
    const { result, requested, rows: details } = await b009(root, { responses: INTEGRATION_TESTS, repositoryName: 'Not_A_Module' });

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B009 manual: folio-integration-tests could not be checked: Neither the module descriptor, pom.xml nor the repository name gives a FOLIO module name. '
      + 'A reviewer must check the module\'s API tests.');
    expect(requested).toEqual([]);
    expect(details.slice(4)).toEqual([
      'folio-integration-tests (only a folder named after the module is searched):',
      '  - Not checked: Neither the module descriptor, pom.xml nor the repository name gives a FOLIO module name.',
      'Checklist for the reviewer:',
      '  - B009-C2 The module\'s API tests, in the repository or outside it (such as in folio-integration-tests, in a folder under another name), use Karate.'
    ]);
  });

  it('names a Grails module whose descriptor id is a placeholder after the repository', async () => {
    const root = repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': '{"id": "${info.app.name}-${info.app.version}", "provides": []}'
    });
    const { result, rows: details } = await b009(root, { responses: INTEGRATION_TESTS, repositoryName: 'mod-agreements' });

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(details.slice(4, 7)).toEqual([
      'folio-integration-tests (only a folder named after the module is searched):',
      '  - Module name: mod-agreements (the repository name)',
      '  - No folder named mod-agreements; tests kept under another name, such as erm/ for mod-agreements, are not seen'
    ]);
  });

  it('is manual without remote lookups when the repository has no API tests (folio-integration-tests not checked)', async () => {
    const { result, analysis, rows: details } = await b009(backendModule('mod-users'));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B009 manual: The repository has no API tests; folio-integration-tests not checked, because remote lookups are off. '
      + 'Rerun with --allow-remote-lookups to look for a folder named mod-users there.');
    expect(analysis.basis).toBe('lookups-off');
    expect(details).toEqual([
      'Evaluated as: a backend module',
      'Policy: Karate (provisional) under backend-integration-testing',
      'API tests in the repository:',
      '  - none (no Karate or other .feature files, and no Postman, Bruno or Insomnia collections)',
      'folio-integration-tests (only a folder named after the module is searched):',
      '  - Module name: mod-users (from descriptors/ModuleDescriptor-template.json)',
      '  - Not checked: remote lookups are off',
      'What to do:',
      '  - Rerun with --allow-remote-lookups, or check folio-integration-tests by hand for the module\'s API tests.',
      'Checklist for the reviewer:',
      '  - B009-C2 The module\'s API tests, in the repository or outside it (such as in folio-integration-tests, in a folder named mod-users or under another name), use Karate.'
    ]);
  });

  it('makes no lookup for a shared library or a repository that is neither a module nor a known library', async () => {
    const library = await b009(repository({ 'pom.xml': pom('folio-spring-base') }), { responses: INTEGRATION_TESTS });
    expect(library.result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(library.result.evidence).toBe('B009 not applicable: The repository is a shared library, which has no API of its own to test.');
    expect(library.rows).toEqual(['Evaluated as: a shared library']);
    expect(library.requested).toEqual([]);

    const ambiguous = await b009(repository({ 'pom.xml': pom('mod-users'), 'tests/users.postman_collection.json': '{}' }), { responses: INTEGRATION_TESTS });
    expect(ambiguous.result.status).toBe(EvaluationStatus.MANUAL);
    expect(ambiguous.result.evidence).toBe('B009 manual: No module descriptor was found, and the repository is not a known shared library, so the tool could not tell whether it needs API tests (see B001). '
      + 'The repository has Postman tests (1 file).');
    expect(ambiguous.analysis.checklist.items.map(item => item.id)).toEqual(['B009-C1', 'B009-C2']);
    expect(ambiguous.requested).toEqual([]);
  });

  it('fails on API tests in an unlisted framework, even next to Karate tests and a Karate folder in folio-integration-tests', async () => {
    const root = backendModule('mod-users', {
      'src/test/resources/karate/users.feature': KARATE_FEATURE,
      'postman/Users API.postman_collection.json': '{}',
      'api-tests/bruno.json': '{}',
      'api-tests/users/get.bru': 'meta { name: get }'
    });
    const { result, analysis, rows: details } = await b009(root, { responses: INTEGRATION_TESTS });

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B009 fail: The repository has API tests in Postman and Bruno, which are not on the officially supported technologies page (it lists Karate for backend API tests).');
    expect(details).toEqual([
      'Evaluated as: a backend module',
      'Policy: Karate (provisional) under backend-integration-testing',
      'API tests in the repository:',
      '  - Karate (on the supported technologies page): 1 .feature file',
      '    - src/test/resources/karate/users.feature',
      '  - Postman (an API test framework not on the supported technologies page): 1 file',
      '    - postman/Users%20API.postman_collection.json',
      '  - Bruno (an API test framework not on the supported technologies page): 2 files',
      '    - api-tests/bruno.json',
      '    - api-tests/users/get.bru',
      'folio-integration-tests (only a folder named after the module is searched):',
      '  - Module name: mod-users (from descriptors/ModuleDescriptor-template.json)',
      '  - Karate (on the supported technologies page): 4 .feature files, with mod-users/src/main/resources/karate-config.js',
      ...MOD_USERS_FILES.map(file => `    - ${file}`),
      'What to do:',
      '  - Write the module\'s API tests in Karate, for example in folio-integration-tests, and remove the Postman and Bruno tests.',
      'Checklist for the reviewer:',
      '  - B009-C1 Each API test suite listed uses Karate, the framework the supported technologies page lists, or is not an API test suite.',
      '    - Start with:',
      '      - src/test/resources/karate/users.feature — Karate',
      '      - postman/Users%20API.postman_collection.json — Postman',
      '      - api-tests/bruno.json — Bruno',
      '      - api-tests/users/get.bru — Bruno',
      '      - mod-users/src/main/resources/karate-config.js — Karate in folio-integration-tests',
      ...MOD_USERS_FILES.map(file => `      - ${file} — Karate in folio-integration-tests`),
      'Sources:',
      `  - ${LISTING} (fetched <time>; HTTP 200, ${digest(INTEGRATION_TESTS, LISTING)})`,
      `  - ${MOD_USERS_TREE} (fetched <time>; HTTP 200, ${digest(INTEGRATION_TESTS, MOD_USERS_TREE)})`
    ]);
    expect(analysis.suites.map(suite => [suite.source, suite.framework, suite.support])).toEqual([
      ['repository', 'karate', 'supported'],
      ['repository', 'postman', 'unlisted'],
      ['repository', 'bruno', 'unlisted'],
      ['folio-integration-tests', 'karate', 'supported']
    ]);
  });

  it('reads Insomnia exports and its git-sync folder as Insomnia tests', async () => {
    const { result, analysis } = await b009(backendModule('mod-users', { '.insomnia/Request/req_1.yml': 'x', 'docs/Insomnia_2026-01-01.json': '{}' }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(analysis.suites).toEqual([{
      source: 'repository', framework: 'insomnia', displayName: 'Insomnia', support: 'unlisted',
      files: ['.insomnia/Request/req_1.yml', 'docs/Insomnia_2026-01-01.json'], fileCount: 2
    }]);
  });

  it('passes Karate in the repository without remote lookups, and tells Karate from other Gherkin by its steps or karate-config.js', async () => {
    const karate = await b009(backendModule('mod-users', { 'src/test/resources/users.feature': KARATE_FEATURE }));
    expect(karate.result.status).toBe(EvaluationStatus.PASS);
    expect(karate.result.evidence).toBe('B009 pass: The repository has Karate API tests (1 .feature file). (Karate is listed as provisional on the supported technologies page.) '
      + 'folio-integration-tests was not checked, because remote lookups are off.');

    const cucumber = await b009(backendModule('mod-users', { 'src/test/resources/users.feature': KARATE_FEATURE, 'src/test/resources/find.feature': CUCUMBER_FEATURE }));
    expect(cucumber.result.status).toBe(EvaluationStatus.MANUAL);
    expect(cucumber.result.evidence).toBe('B009 manual: The repository has Karate API tests (1 .feature file). '
      + 'The repository has 1 .feature file without Karate syntax or a karate-config.js, which may be Cucumber or Karate tests. A reviewer must check which framework the API tests use.');
    expect(cucumber.rows.slice(2, 7)).toEqual([
      'API tests in the repository:',
      '  - Karate (on the supported technologies page): 1 .feature file',
      '    - src/test/resources/users.feature',
      '  - Gherkin (framework unclear): 1 .feature file',
      '    - src/test/resources/find.feature'
    ]);

    const configured = await b009(backendModule('mod-users', { 'src/test/resources/find.feature': CUCUMBER_FEATURE, 'src/test/resources/karate-config.js': 'function fn() {}' }));
    expect(configured.result.status).toBe(EvaluationStatus.PASS);
    expect(configured.result.evidence).toBe('B009 pass: The repository has Karate API tests (1 .feature file and karate-config.js). (Karate is listed as provisional on the supported technologies page.) '
      + 'folio-integration-tests was not checked, because remote lookups are off.');
  });

  it('leaves a folder without karate-config.js or without .feature files to the reviewer', async () => {
    const tree = (paths: string[]) => ({ sha: 'a'.repeat(40), truncated: false, tree: paths.map(path => ({ path, type: 'blob' })) });

    const noConfig = await b009(backendModule('mod-x'), {
      responses: withFolder('mod-x', tree(['pom.xml', 'src/main/resources/x.feature', 'src/main/resources/karate-config.json', 'src/main/resources/my-karate-config.js']))
    });
    expect(noConfig.result.status).toBe(EvaluationStatus.MANUAL);
    expect(noConfig.result.evidence).toBe('B009 manual: folio-integration-tests has 1 .feature file in mod-x/ but no karate-config.js, so the tool could not tell whether they are Karate tests. '
      + 'A reviewer must check which framework the API tests use.');

    const empty = await b009(backendModule('mod-x'), {
      responses: withFolder('mod-x', { sha: 'a'.repeat(40), truncated: false, tree: [
        ...['pom.xml', 'src/main/resources/karate-config.js', 'x.feature/README.md'].map(path => ({ path, type: 'blob' })), { path: 'x.feature', type: 'tree' }
      ] })
    });
    expect(empty.result.status).toBe(EvaluationStatus.MANUAL);
    expect(empty.result.evidence).toBe('B009 manual: folio-integration-tests has a folder named mod-x, but it has no .feature files. A reviewer must check which framework the API tests use.');
    expect(empty.rows.slice(4, 7)).toEqual([
      'folio-integration-tests (only a folder named after the module is searched):',
      '  - Module name: mod-x (from descriptors/ModuleDescriptor-template.json)',
      '  - mod-x/ has no .feature files'
    ]);
  });

  it('is manual, never not applicable or pass, when folio-integration-tests cannot be read completely', async () => {
    const listing = INTEGRATION_TESTS[LISTING].body as unknown[];
    const cases: Array<[string, RecordedResponses, string]> = [
      ['rate limited', { [LISTING]: { status: 403, body: { message: 'API rate limit exceeded' } } },
        'The top-level listing of folio-integration-tests could not be read (HTTP 403.).'],
      ['at GitHub\'s listing limit', { [LISTING]: { status: 200, body: Array.from({ length: 1000 }, (_item, index) => listing[index % listing.length]) } },
        'The top-level listing of folio-integration-tests has 1000 entries, the most GitHub lists, so it may be incomplete.'],
      ['truncated', withFolder('mod-x', { sha: 'a'.repeat(40), truncated: true, tree: [{ path: 'a.feature', type: 'blob' }, { path: 'karate-config.js', type: 'blob' }] }),
        'GitHub listed the folder mod-x/ only in part (truncated).'],
      ['not a tree', withFolder('mod-x', [{ path: 'a.feature', type: 'blob' }]), 'The listing of the folder mod-x/ is not a git tree.'],
      ['without a tree id', { [LISTING]: { status: 200, body: [...listing, { name: 'mod-x', path: 'mod-x', sha: 'master', type: 'dir' }] } }, 'The listing gives no tree id for the folder mod-x/.'],
      ['not said to be complete', withFolder('mod-x', { sha: 'a'.repeat(40), tree: [{ path: 'a.feature', type: 'blob' }, { path: 'karate-config.js', type: 'blob' }] }),
        'GitHub listed the folder mod-x/ only in part (truncated).']
    ];
    for (const [, responses, problem] of cases) {
      const { result, analysis } = await b009(backendModule('mod-x'), { responses });
      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe(`B009 manual: folio-integration-tests could not be checked: ${problem} A reviewer must check the module's API tests.`);
      expect(analysis.checklist.items.map(item => item.id)).toEqual(['B009-C2']);
    }

    const karate = await b009(backendModule('mod-x', { 'src/test/resources/users.feature': KARATE_FEATURE }), { responses: cases[0][1] });
    expect(karate.result.status).toBe(EvaluationStatus.MANUAL);
    expect(karate.result.evidence).toBe(`B009 manual: The repository has Karate API tests (1 .feature file). folio-integration-tests could not be checked: ${cases[0][2]} A reviewer must check the module's API tests.`);
    expect(karate.rows).toContain(`  - ${LISTING} (fetched <time>; HTTP 403.)`);
  });

  it('is manual, not applicable only with every file read, when a .feature file in the repository cannot be read', async () => {
    const { result, rows: details } = await b009(backendModule('mod-user', { 'src/test/resources/big.feature': `Feature: big\n${'# x\n'.repeat(80_000)}` }), { responses: INTEGRATION_TESTS });

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B009 manual: The tool could not read every file in the repository that would show API tests. A reviewer must check the module\'s API tests.');
    expect(details.slice(details.indexOf('What the tool could not read:'), details.indexOf('What the tool could not read:') + 2)).toEqual([
      'What the tool could not read:',
      '  - src/test/resources/big.feature — Committed file exceeds the 262144-byte per-file limit'
    ]);
  });

  it('is manual when suites are found but the policy cannot be read', async () => {
    const analysis = evaluateB009({
      kind: 'backend-module',
      remoteLookups: false,
      policyLoad: await loadS007Policy('/nonexistent/officially-supported-technologies.json'),
      snapshot: { revision: 'r', complete: true, diagnostics: [], listedPaths: ['a.postman_collection.json'], files: [] },
      remoteEvidence: []
    });

    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.summary).toBe('B009 manual: The repository has Postman tests (1 file). The Karate entry of the officially supported technologies list could not be read '
      + '(The officially supported technologies list was not found at /nonexistent/officially-supported-technologies.json.).');
  });

  it('reads feature files and collection paths in linear time', async () => {
    const policyLoad = await loadS007Policy();
    const analysis = await expectLinearTime(20_000, size => {
      const content = [
        `* def ${'a'.repeat(size * 20)}`,
        `${' \t'.repeat(size * 10)}x`,
        ...Array.from({ length: size }, () => 'Given When Then * method fetch'),
        `${'*'.repeat(size * 10)} url`,
        `* url ${'a'.repeat(size * 20)}`,
        `* match ${'a'.repeat(size * 20)}${' '.repeat(size * 20)}=`,
        `* status ${'2'.repeat(size * 20)}`,
        `* method get${' '.repeat(size * 20)}x`
      ].join('\n');
      return {
        content,
        listedPaths: [`insomnia${'a.'.repeat(size * 10)}`, `${'x/'.repeat(size * 10)}insomnia.txt`, `${'.bru'.repeat(size * 10)}x`, `${'.postman_collection'.repeat(size * 10)}.js`]
      };
    }, async ({ content, listedPaths }) => evaluateB009({
      kind: 'backend-module',
      remoteLookups: false,
      policyLoad,
      snapshot: { revision: 'r', complete: true, diagnostics: [], listedPaths, files: [{ path: 'a.feature', oid: 'o', size: content.length, content }] },
      remoteEvidence: []
    }));

    expect(analysis.suites.map(suite => suite.framework)).toEqual(['feature-files']);
  });
});

describe('B009 on an edge module', () => {
  it('looks up the folder named after the edge module\'s artifactId', async () => {
    const root = repository({
      'pom.xml': pom('edge-x', `<dependencies>${dependency('edge-common')}</dependencies>`),
      'descriptors/ModuleDescriptor-template.json': '{"id": "@artifactId@-@version@", "provides": []}'
    });
    const { result, rows: details } = await b009(root, {
      responses: withFolder('edge-x', { sha: 'a'.repeat(40), truncated: false, tree: [{ path: 'src/main/resources/karate-config.js', type: 'blob' }, { path: 'src/main/resources/a.feature', type: 'blob' }] })
    });

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(details.slice(0, 1).concat(details.slice(4, 8))).toEqual([
      'Evaluated as: an edge module',
      'folio-integration-tests (only a folder named after the module is searched):',
      '  - Module name: edge-x (from pom.xml)',
      '  - Karate (on the supported technologies page): 1 .feature file, with edge-x/src/main/resources/karate-config.js',
      '    - edge-x/src/main/resources/a.feature'
    ]);
  });
});
