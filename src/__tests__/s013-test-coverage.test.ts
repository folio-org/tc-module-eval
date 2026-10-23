import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { collectBuildTestEvidence } from '../utils/build-test-evidence';
import { loadFolioSharedWorkflows } from '../utils/folio-shared-workflows';
import { evaluateS013 } from '../utils/s013-evaluator';
import { CriterionResult, EvaluationStatus, S013Analysis } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { loadRemoteFixture, RecordedResponses, replayTransport } from './helpers/remote-replay';

class TestEvaluator extends SharedEvaluator {}

// Recorded from SonarCloud (org.folio:ui-users, branch master) by `yarn capture:remote-fixtures --sonar`: overall coverage 77.5%.
const UI_USERS = loadRemoteFixture('sonarcloud-ui-users');
const UI_USERS_COMMIT = '31d7f0f35f69c87fe1fa9fdf68c1c2f479e551b1';
const MEASURES_URL = (repo: string) => `https://sonarcloud.io/api/measures/component?component=org.folio%3A${repo}&metricKeys=coverage%2Cline_coverage%2Cbranch_coverage%2Clines_to_cover%2Cuncovered_lines%2Cconditions_to_cover%2Cuncovered_conditions%2Cduplicated_lines_density&branch=master`;
const COMPONENT_URL = (repo: string) => `https://sonarcloud.io/api/components/show?component=org.folio%3A${repo}`;

/**
 * The recorded ui-users responses as another project's, with the measures replaced. Absent measures are left out
 * of the response, as SonarCloud does for a metric it has no value for.
 */
function sonarResponses(repo: string, measures?: Record<string, string>): RecordedResponses {
  const responses: RecordedResponses = JSON.parse(JSON.stringify(UI_USERS).split('ui-users').join(repo));
  if (measures) {
    const body = responses[MEASURES_URL(repo)].body as { component: { measures: unknown[] } };
    body.component.measures = Object.entries(measures).map(([metric, value]) => ({ metric, value }));
  }
  return responses;
}

const FULL_MEASURES = (coverage: string, linesToCover = '1000'): Record<string, string> => ({
  coverage, line_coverage: '90.0', branch_coverage: '70.0', lines_to_cover: linesToCover,
  uncovered_lines: '100', conditions_to_cover: '200', uncovered_conditions: '60'
});

const JEST_LOCKFILE = `# yarn lockfile v1


"@folio/jest-config-stripes@^3.1.0":
  version "3.1.0"

"@testing-library/react@^14.3.1":
  version "14.3.1"

jest-cli@^29.7.0:
  version "99.0.0"

jest@^29.7.0:
  version "29.7.0"
`;

describe('S013 unit test coverage and test technologies', () => {
  let root: string;
  let unrecorded: string[];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 's013-'));
    unrecorded = [];
  });
  afterEach(async () => {
    await fs.remove(root);
    expect(unrecorded).toEqual([]);
  });

  async function repository(name: string, files: Record<string, string | object>): Promise<string> {
    const repo = path.join(root, name);
    for (const [file, content] of Object.entries(files)) {
      await fs.outputFile(path.join(repo, file), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return repo;
  }

  async function uiRepo(name = 'ui-users', lockfile: string = JEST_LOCKFILE): Promise<string> {
    return repository(name, {
      'package.json': { name: '@folio/users', stripes: { type: 'app' }, devDependencies: { '@folio/jest-config-stripes': '^3.1.0', react: '^18.2.0' } },
      'yarn.lock': lockfile
    });
  }

  async function evaluate(
    repo: string,
    options: { responses?: RecordedResponses; commit?: string; language?: 'java' | 'javascript' } = {}
  ): Promise<CriterionResult & { criterionDetails: S013Analysis; requested: string[] }> {
    const language = options.language ?? (fs.existsSync(path.join(repo, 'package.json')) ? 'javascript' : 'java');
    const replay = options.responses ? replayTransport(options.responses) : undefined;
    const run = createEvaluationRun({
      repositoryPath: repo,
      repositoryName: path.basename(repo),
      language,
      criteriaFilter: ['S013'],
      remoteLookups: replay?.transport,
      repositoryCommit: options.commit
    });
    const result = await new TestEvaluator(language).evaluateCriterion('S013', repo, run);
    unrecorded.push(...(replay?.unrecorded ?? []));
    return { ...result, criterionDetails: result.criterionDetails as S013Analysis, requested: replay?.requested ?? [] };
  }

  describe('on the recorded ui-users analysis', () => {
    it('fails 77.5% overall coverage even though line coverage is 82.7%, and finds Jest and RTL through the stripes Jest config', async () => {
      const result = await evaluate(await uiRepo(), { responses: UI_USERS, commit: UI_USERS_COMMIT });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe('S013 fail: SonarCloud reports 77.5% test coverage, below the required 80%. The tests use Jest, which is an officially supported technology.');
      expect(result.details).toContain([
        "What to do: Add tests until SonarCloud's overall coverage reaches 80%. Branch coverage is the weaker part.",
        'Coverage (SonarCloud org.folio:ui-users, branch master, analysed 2026-10-22, commit 31d7f0f, the commit evaluated here):',
        '  - Overall: 77.5% (lines 82.7%, branches 67.1%)',
        '  - Lines: 9,359 to cover, 1,620 uncovered',
        '  - Conditions: 4,688 to cover, 1,544 uncovered',
        '  - The 80% rule uses the overall figure, which combines lines and branches.',
        'Not counted in the coverage figure (for review; this does not change the result):',
        '  - None set in the repository or CI',
        "  - Exclusions set in SonarCloud's project settings were not checked (reading them needs a SonarCloud admin token).",
        'Test technologies:',
        // Versions come from the jest and @testing-library/react entries, not jest-cli or the config package.
        '  - Jest 29.7.0 (@folio/jest-config-stripes in package.json, devDependencies): supported ("Jest should be 29 or greater")',
        '  - React Testing Library 14.3.1 (@folio/jest-config-stripes in package.json, devDependencies): supported ("RTL should be 14 or greater")',
        'Policy: Officially Supported Technologies (ACCEPTED, exported 2026-07-14), config/officially-supported-technologies.json',
        'Sources:'
      ].join('\n'));
      // Every request of the shared snapshot, plus the re-read of the latest analysis and the analysis queue.
      expect(result.criterionDetails.remoteEvidence).toHaveLength(14);
      expect(result.criterionDetails.remoteEvidence.every(record => record.status === 200 && record.sha256)).toBe(true);
    });

    it('is manual, not failed, when the analysis is of another commit or the evaluated commit is unknown', async () => {
      const repo = await uiRepo();
      const other = await evaluate(repo, { responses: UI_USERS, commit: 'a'.repeat(40) });
      expect(other.status).toBe(EvaluationStatus.MANUAL);
      expect(other.evidence).toBe("S013 manual: SonarCloud's coverage cannot be used: SonarCloud's latest analysis of branch master (2026-10-22) is of commit 31d7f0f, not the evaluated commit aaaaaaa, so its findings may not apply. The tests use Jest, which is an officially supported technology.");
      expect(other.details).toContain('not confirmed as the commit evaluated here');

      const unknown = await evaluate(repo, { responses: UI_USERS });
      expect(unknown.status).toBe(EvaluationStatus.MANUAL);
      expect(unknown.criterionDetails.coverage.reason).toBe('stale');

      // The analysis is of the evaluated commit, but a newer one of the branch is still being processed.
      const pending = sonarResponses('ui-users');
      const queue = Object.keys(pending).find(url => url.startsWith('https://sonarcloud.io/api/ce/component?'))!;
      pending[queue] = { status: 200, body: { queue: [{ id: 'task', type: 'REPORT', status: 'PENDING', branch: 'master' }] } };
      const processing = await evaluate(repo, { responses: pending, commit: UI_USERS_COMMIT });
      expect(processing.status).toBe(EvaluationStatus.MANUAL);
      expect(processing.evidence).toContain("SonarCloud's coverage cannot be used: SonarCloud was processing a new analysis of branch master");

      // SonarCloud answers the re-read of the latest analysis with a different one.
      const reanalysed = sonarResponses('ui-users');
      const analyses = Object.keys(reanalysed).find(url => url.startsWith('https://sonarcloud.io/api/project_analyses/search?'))!;
      const first = reanalysed[analyses];
      let reads = 0;
      const replay = replayTransport(reanalysed);
      const getJson = replay.transport.getJson.bind(replay.transport);
      replay.transport.getJson = async (url: string) => {
        if (url === analyses && reads++ > 0) {
          reanalysed[analyses] = { status: 200, body: { analyses: [{ key: 'newer', date: '2026-10-23T10:00:00+0000', revision: 'b'.repeat(40) }] } };
        }
        const answer = await getJson(url);
        reanalysed[analyses] = first;
        return answer;
      };
      const run = createEvaluationRun({ repositoryPath: repo, repositoryName: 'ui-users', language: 'javascript', criteriaFilter: ['S013'], remoteLookups: replay.transport, repositoryCommit: UI_USERS_COMMIT });
      const twice = await new TestEvaluator('javascript').evaluateCriterion('S013', repo, run);
      expect(twice.status).toBe(EvaluationStatus.MANUAL);
      expect(twice.evidence).toContain('SonarCloud analysed the project again while the tool was reading it');
    });

    it('is manual and does not claim a missing project when SonarCloud cannot be read, and names a branch it fell back from', async () => {
      const responses = sonarResponses('ui-users');
      responses[COMPONENT_URL('ui-users')] = { status: 503, body: {} };
      const unreadable = await evaluate(await uiRepo(), { responses: { [COMPONENT_URL('ui-users')]: responses[COMPONENT_URL('ui-users')] }, commit: UI_USERS_COMMIT });
      expect(unreadable.status).toBe(EvaluationStatus.MANUAL);
      expect(unreadable.criterionDetails.coverage.reason).toBe('unreadable');
      expect(unreadable.evidence).toContain('No coverage figure is available: SonarCloud could not be read: HTTP 503.');
      expect(unreadable.details).not.toContain('has no project');
      expect(unreadable.details).not.toContain('Not counted in the coverage figure');

      // --branch names a branch SonarCloud has not analysed, so its main branch is read and the report says so.
      const repo = await uiRepo('ui-users-branch');
      const replay = replayTransport(sonarResponses('ui-users-branch'));
      const run = createEvaluationRun({ repositoryPath: repo, repositoryName: 'ui-users-branch', language: 'javascript', criteriaFilter: ['S013'], remoteLookups: replay.transport, repositoryCommit: UI_USERS_COMMIT, requestedBranch: 'feature-x' });
      const fallback = await new TestEvaluator('javascript').evaluateCriterion('S013', repo, run);
      expect(replay.unrecorded).toEqual([]);
      expect(fallback.status).toBe(EvaluationStatus.FAIL);
      expect(fallback.details).toContain('  - SonarCloud has no analysis of branch feature-x, so its main branch was read.');
    });

    it('is manual without --allow-remote-lookups, makes no request, and still lists the test technologies', async () => {
      const result = await evaluate(await uiRepo());

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('S013 manual: Coverage was not checked: remote lookups are off. Rerun with --allow-remote-lookups to read it from SonarCloud. The tests use Jest, which is an officially supported technology.');
      expect(result.details).toContain('Coverage: not checked (remote lookups are off)');
      expect(result.details).toContain('  - Jest 29.7.0 (@folio/jest-config-stripes in package.json, devDependencies): supported');
      expect(result.criterionDetails.remoteEvidence).toEqual([]);
    });
  });

  describe('coverage figures', () => {
    it.each([
      ['79.95', EvaluationStatus.FAIL, 'SonarCloud reports 79.95% test coverage, below the required 80%.'],
      ['80.0', EvaluationStatus.PASS, 'SonarCloud reports 80.0% test coverage, meeting the required 80%.']
    ])('judges %s against 80 without rounding', async (coverage, status, sentence) => {
      const result = await evaluate(await uiRepo(), { responses: sonarResponses('ui-users', FULL_MEASURES(coverage)), commit: UI_USERS_COMMIT });
      expect(result.status).toBe(status);
      expect(result.evidence).toBe(`S013 ${status}: ${sentence} The tests use Jest, which is an officially supported technology.`);
    });

    it('fails a reported 0.0% with a hint to check that CI uploads coverage', async () => {
      const result = await evaluate(await uiRepo(), { responses: sonarResponses('ui-users', FULL_MEASURES('0.0')), commit: UI_USERS_COMMIT });
      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('SonarCloud reports 0.0% test coverage, below the required 80%. If the module has tests, check that CI uploads its coverage report to SonarCloud.');
      expect(result.details).toContain('What to do: If the module has tests, make sure CI uploads its coverage report to SonarCloud');
    });

    it.each([
      ['nothing to cover', FULL_MEASURES('0.0', '0'), 'nothing-to-cover'],
      ['no coverage figure', { lines_to_cover: '1000', line_coverage: '10.0' }, 'no-measures'],
      ['no lines-to-cover figure', { coverage: '10.0', line_coverage: '10.0' }, 'no-measures']
    ])('is manual, never failed or passed, with %s', async (_label, measures, reason) => {
      const result = await evaluate(await uiRepo(), { responses: sonarResponses('ui-users', measures), commit: UI_USERS_COMMIT });
      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.criterionDetails.coverage.reason).toBe(reason);
    });

    it('shows a missing measure as not reported rather than 0', async () => {
      const result = await evaluate(await uiRepo(), { responses: sonarResponses('ui-users', { lines_to_cover: '1000' }), commit: UI_USERS_COMMIT });
      expect(result.evidence).toContain("SonarCloud's analysis of the evaluated commit reports no coverage figure");
      expect(result.details).toContain('  - Overall: not reported (lines not reported, branches not reported)');
    });
  });

  describe('backend test technologies', () => {
    const GRADLE_WORKFLOW = `jobs:
  gradle:
    uses: folio-org/.github/.github/workflows/gradle.yml@v1
`;

    it('explains a missing SonarCloud project by the gradle.yml workflow and leaves Spock to a reviewer', async () => {
      const repo = await repository('mod-agreements', {
        'service/build.gradle': `dependencies {
  // testImplementation "org.junit.jupiter:junit-jupiter" is commented out
  testImplementation("org.mockito:mockito-core")
  testImplementation( "com.athaydes:spock-reports:$spockReportsVersion" ) {
    transitive = false
  }
}`,
        '.github/workflows/build.yml': GRADLE_WORKFLOW
      });
      const result = await evaluate(repo, { responses: { [COMPONENT_URL('mod-agreements')]: { status: 404, body: { errors: [{ msg: 'not found' }] } } }, commit: UI_USERS_COMMIT });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe("S013 manual: No coverage figure is available: SonarCloud has no project for this module (org.folio:mod-agreements), and its CI uses FOLIO's gradle.yml@v1 workflow, which does not run SonarCloud. The tests use Spock, which the supported-technologies page does not list.");
      expect(result.details).toContain('  - Spock (com.athaydes:spock-reports in service/build.gradle, testImplementation): not listed on the supported-technologies page');
      expect(result.details).toContain('  - Mockito (org.mockito:mockito-core in service/build.gradle, testImplementation): testing helper, not covered by the supported-technologies page');
      expect(result.details).toMatch(/components\/show\?component=org\.folio%3Amod-agreements \(fetched [^;]+; HTTP 404\.\)$/m);
      // The commented-out JUnit declaration does not count.
      expect(result.details).not.toContain('  - JUnit');
      // Without a project there is no figure to qualify, so the repository is not scanned for exclusions.
      expect(result.details).not.toContain('Not counted in the coverage figure');
    });

    it('lists what the coverage figure leaves out, with workflow inputs replacing the defaults, without changing the result', async () => {
      const repo = await repository('mod-scope', {
        'pom.xml': `<project><properties>
  <sonar.coverage.exclusions>**/dto/**\n(evidence: x.java:1)</sonar.coverage.exclusions>
  <sonar.cpd.exclusions>**/generated/**</sonar.cpd.exclusions>
</properties><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><scope>test</scope></dependency></dependencies></project>`,
        '.github/workflows/maven.yml': `jobs:
  maven:
    uses: folio-org/.github/.github/workflows/maven.yml@v1
    with:
      sonar-exclusions: '**/*.md,src/main/java/org/folio/Legacy.java'
`
      });
      const result = await evaluate(repo, { responses: sonarResponses('mod-scope', FULL_MEASURES('85.0')), commit: UI_USERS_COMMIT });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.details).toContain([
        'Not counted in the coverage figure (for review; this does not change the result):',
        '  - Files excluded from coverage (sonar.coverage.exclusions, pom.xml:2): **/dto/** [evidence: x.java:1)',
        // The caller's list replaces maven.yml's default (**/*.md, .github/**, **/*.json), so the default is not shown.
        "  - Files FOLIO's maven.yml@v1 workflow excludes from analysis (set in .github/workflows/maven.yml, replacing its default): **/*.md, src/main/java/org/folio/Legacy.java",
        "  - Exclusions set in SonarCloud's project settings were not checked (reading them needs a SonarCloud admin token).",
        'Test technologies:'
      ].join('\n'));
      // Duplication exclusions do not change what coverage counts.
      expect(result.details).not.toContain('sonar.cpd.exclusions');
    });

    it.each([
      ['ui.yml defaults', 'ui.yml@v1', {}, [
        "  - Source folders FOLIO's ui.yml@v1 workflow analyses (its default): ./src",
        "  - Files FOLIO's ui.yml@v1 workflow excludes from analysis (its default): docs/**, examples/**"
      ]],
      ['a sources input', 'ui.yml@v1', { 'sonar-sources': './lib' }, [
        "  - Source folders FOLIO's ui.yml@v1 workflow analyses (set in .github/workflows/ci.yml, replacing its default): ./lib"
      ]],
      ['an unknown ref', 'ui.yml@master', {}, [
        "  - FOLIO's ui.yml@master workflow (.github/workflows/ci.yml) is not in the shared-workflow table, so the exclusions it passes to SonarCloud are not known."
      ]],
      ['the scan switched off', 'ui.yml@v1', { 'sonar-enabled': 'false' }, ['  - None set in the repository or CI']]
    ] as Array<[string, string, Record<string, string>, string[]]>)('lists the shared workflow scope for %s', async (_label, workflow, inputs, expected) => {
      const repo = await uiRepo('ui-scope');
      const withLines = Object.entries(inputs).map(([key, value]) => `\n      ${key}: '${value}'`).join('');
      await fs.outputFile(path.join(repo, '.github/workflows/ci.yml'),
        `jobs:\n  ui:\n    uses: folio-org/.github/.github/workflows/${workflow}${withLines ? `\n    with:${withLines}` : ''}\n`);
      const result = await evaluate(repo, { responses: sonarResponses('ui-scope', FULL_MEASURES('85.0')), commit: UI_USERS_COMMIT });
      expect(result.status).toBe(EvaluationStatus.PASS);
      for (const row of expected) expect(result.details).toContain(row);
      if (workflow === 'ui.yml@master' || inputs['sonar-enabled']) expect(result.details).not.toContain('excludes from analysis');
    });

    it('warns that exclusions may be missing only when a file that can set them was not scanned', async () => {
      const big = `class Big {}\n${'// padding\n'.repeat(160_000)}`;
      const source = await evaluate(await repository('mod-big-source', { 'pom.xml': '<project/>', 'src/main/java/Big.java': big }), {
        responses: sonarResponses('mod-big-source', FULL_MEASURES('85.0')), commit: UI_USERS_COMMIT
      });
      expect(source.details).not.toContain('other exclusions may be missing');
      const properties = await evaluate(await repository('mod-big-properties', { 'pom.xml': '<project/>', 'sonar-project.properties': big }), {
        responses: sonarResponses('mod-big-properties', FULL_MEASURES('85.0')), commit: UI_USERS_COMMIT
      });
      expect(properties.details).toContain('  - Some build or CI files could not be scanned, so other exclusions may be missing.');
    });

    it('passes JUnit declared only in a module the root POM builds, and is manual when another runner is unlisted', async () => {
      const files = {
        'pom.xml': '<project><modules><module>server/</module></modules><dependencies><dependency><groupId>org.mockito</groupId><artifactId>mockito-core</artifactId><scope>test</scope></dependency></dependencies></project>',
        'server/pom.xml': '<project><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><scope>test</scope></dependency></dependencies></project>'
      };
      const passing = await evaluate(await repository('mod-x', files), { responses: sonarResponses('mod-x', FULL_MEASURES('85.0')), commit: UI_USERS_COMMIT });
      expect(passing.status).toBe(EvaluationStatus.PASS);
      expect(passing.evidence).toBe('S013 pass: SonarCloud reports 85.0% test coverage, meeting the required 80%. The tests use JUnit, which is an officially supported technology.');
      expect(passing.details).toContain('  - JUnit (org.junit.jupiter:junit-jupiter in server/pom.xml, test scope): supported');
      expect(passing.details).not.toContain('What to do');

      const withTestNg = await evaluate(await repository('mod-y', {
        ...files,
        'server/pom.xml': files['server/pom.xml'].replace('</dependencies>', '<dependency><groupId>org.testng</groupId><artifactId>testng</artifactId><scope>test</scope></dependency></dependencies>')
      }), { responses: sonarResponses('mod-y', FULL_MEASURES('85.0')), commit: UI_USERS_COMMIT });
      expect(withTestNg.status).toBe(EvaluationStatus.MANUAL);
      expect(withTestNg.evidence).toContain('The tests use JUnit and TestNG, and the supported-technologies page does not list TestNG.');
    });

    it('never fails a module only for having no tests: it is manual unless its coverage fails', async () => {
      const files = { 'pom.xml': '<project><artifactId>mod-z</artifactId></project>' };
      const meets = await evaluate(await repository('mod-z', files), { responses: sonarResponses('mod-z', FULL_MEASURES('90.0')), commit: UI_USERS_COMMIT });
      expect(meets.status).toBe(EvaluationStatus.MANUAL);
      expect(meets.evidence).toContain('No unit-test runner was found in the build files');
      expect(meets.details).toContain('Test technologies: none found in the build files');

      const below = await evaluate(await repository('mod-w', files), { responses: sonarResponses('mod-w', FULL_MEASURES('12.0')), commit: UI_USERS_COMMIT });
      expect(below.status).toBe(EvaluationStatus.FAIL);
    });
  });

  describe('incomplete and advisory evidence', () => {
    it('is manual when a module or subproject that could declare another runner was not read, and keeps S012 to its own reads', async () => {
      const repo = await repository('mod-multi', {
        'pom.xml': `<project>
  <modules><module>server</module><module>../outside</module><module>missing</module></modules>
  <profiles><profile><modules><module>extra</module></modules></profile></profiles>
</project>`,
        'server/pom.xml': '<project><modules><module>nested</module></modules><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><scope>test</scope></dependency></dependencies></project>',
        'nested/pom.xml': '<project><dependencies><dependency><groupId>org.testng</groupId><artifactId>testng</artifactId></dependency></dependencies></project>'
      });
      const evidence = await collectBuildTestEvidence(repo);
      expect(evidence.testComplete).toBe(false);
      expect(evidence.testDiagnostics.map(item => [item.path, item.message])).toEqual([
        ['pom.xml', 'Lists modules inside a profile, whose test dependencies were not read.'],
        ['pom.xml', 'Lists the module "../outside", which is not a plain folder name, so its test dependencies were not read.'],
        ['server/pom.xml', 'Lists modules of its own, whose test dependencies were not read.'],
        ['missing/pom.xml', 'Is the POM of a module the root pom.xml lists, but it is not a file in the repository, so its test dependencies were not read.']
      ]);
      // S012 reads only the root POM and sees none of this.
      expect(evidence.filesRead).toEqual(['pom.xml']);
      expect(evidence.complete).toBe(true);

      const result = await evaluate(repo, { responses: sonarResponses('mod-multi', FULL_MEASURES('90.0')), commit: UI_USERS_COMMIT });
      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('The tests use JUnit, but some build files could not be read (see Warnings), so a test runner may be missing.');

      const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S012'] });
      const s012 = await new TestEvaluator('java').evaluateCriterion('S012', repo, run);
      expect(Object.keys((s012.criterionDetails as { evidence: object }).evidence)).not.toContain('testTechnologies');

      const gradle = await repository('mod-gradle', {
        'build.gradle': 'dependencies { testImplementation "org.junit.jupiter:junit-jupiter" }',
        'settings.gradle': "rootProject.name = 'x'\ninclude 'api'\n"
      });
      expect((await collectBuildTestEvidence(gradle)).testDiagnostics.map(item => item.path)).toEqual(['settings.gradle']);
    });

    it('keeps yarn.lock versions and dependency names inside their report rows', async () => {
      const repo = await repository('ui-odd', {
        'package.json': { name: '@folio/odd', devDependencies: { jest: '^29.7.0', '@bigtest/x\n(evidence: fake.js:1)': '1.0.0' } },
        'yarn.lock': '# yarn lockfile v1\n\njest@^29.7.0:\n  version "29.7.0\\n(evidence: lock.js:1)"\n'
      });
      const result = await evaluate(repo);
      const rows = result.details!.split('\n');
      expect(rows.some(row => /^\s*\(evidence/.test(row))).toBe(false);
      expect(rows).toContain('  - Jest 29.7.0 ↵ [evidence: lock.js:1) (jest in package.json, devDependencies): supported ("Jest should be 29 or greater")');
      expect(rows.some(row => row.startsWith('  - BigTest (@bigtest/x ↵ [evidence: fake.js:1) in package.json'))).toBe(true);
    });

    it('is manual when SonarCloud\'s measures or the policy could not be read', async () => {
      const responses = sonarResponses('ui-users');
      responses[MEASURES_URL('ui-users')] = { status: 500, body: {} };
      const measures = await evaluate(await uiRepo(), { responses, commit: UI_USERS_COMMIT });
      expect(measures.status).toBe(EvaluationStatus.MANUAL);
      expect(measures.evidence).toContain("No coverage figure is available: SonarCloud's measures could not be read: HTTP 500.");

      const repo = await uiRepo('ui-policy');
      const analysis = evaluateS013({
        language: 'javascript',
        policyLoad: { ok: false, sourcePath: 'config/officially-supported-technologies.json', diagnostics: [{ code: 'schema', message: 'broken' } as never] },
        tableLoad: await loadFolioSharedWorkflows(),
        evidence: await collectBuildTestEvidence(repo),
        remoteLookups: false
      });
      expect(analysis.status).toBe(EvaluationStatus.MANUAL);
      expect(analysis.technologies.outcome).toBe('manual');
      expect(analysis.summary).toContain('could not be loaded, so the test technologies were not checked.');
    });

    it('is manual when a build file with test dependencies could not be read, without changing S012\'s evidence', async () => {
      const repo = await repository('mod-big', {
        'build.gradle': `dependencies {\n  testImplementation "org.junit.jupiter:junit-jupiter"\n}\n${'// padding\n'.repeat(110_000)}`
      });
      const result = await evaluate(repo, { responses: sonarResponses('mod-big', FULL_MEASURES('90.0')), commit: UI_USERS_COMMIT });
      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('Some build files could not be read (see Warnings), so a test runner may be missing.');
      expect(result.details).toContain('  - build.gradle: Is larger than 1 MB, so it was not read.');

      const evidence = await collectBuildTestEvidence(repo);
      expect(evidence.complete).toBe(true);
      expect(evidence.diagnostics).toEqual([]);
    });

    it('treats an unreadable yarn.lock and an old Jest as advice only', async () => {
      const oversized = await evaluate(await uiRepo('ui-big', `# yarn lockfile v1\n${'#\n'.repeat(600_000)}`), {
        responses: sonarResponses('ui-big', FULL_MEASURES('90.0')), commit: UI_USERS_COMMIT
      });
      expect(oversized.status).toBe(EvaluationStatus.PASS);
      expect(oversized.details).toContain('  - Jest (@folio/jest-config-stripes in package.json, devDependencies): supported');
      expect(oversized.details).toContain('  - yarn.lock: Is larger than 1 MB, so it was not read.');

      const old = await evaluate(await uiRepo('ui-old', JEST_LOCKFILE.replace('version "29.7.0"', 'version "27.5.1"')), {
        responses: sonarResponses('ui-old', FULL_MEASURES('90.0')), commit: UI_USERS_COMMIT
      });
      expect(old.status).toBe(EvaluationStatus.PASS);
      expect(old.details).toContain('    - Recommendation (advisory): Use Jest 29 or greater. yarn.lock resolves Jest 27.5.1.');
    });
  });
});
