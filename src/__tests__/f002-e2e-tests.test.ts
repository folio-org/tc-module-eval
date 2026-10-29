import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionAgentAssessment, CriterionAgentReviewConfig, CriterionResult, EvaluationStatus, F002Analysis } from '../types';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { buildF002AgentReviewRequest } from '../utils/f002-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import * as s007Policy from '../utils/s007-policy';

const SHARED_UI_WORKFLOW = (inputs: string[]) => [
  'jobs:',
  '  ui:',
  '    uses: folio-org/.github/.github/workflows/ui.yml@v1',
  '    with:',
  ...inputs.map(input => `      ${input}`)
].join('\n');

describe('F002 end-to-end tests', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'f002-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('passes Cypress 13 from yarn.lock and states that the policy entry is provisional', async () => {
    // Tool names in paths and messages are not commands.
    writePackage({ devDependencies: { cypress: '^13.6.0' },
      scripts: { 'test:e2e': 'cypress run', clean: 'rm -rf wdio-logs && echo "nightwatch config is gone"' } });
    writeLock({ 'cypress@^13.6.0': '13.6.0' });
    write('cypress.config.js', 'module.exports = {};\n');
    write('cypress/e2e/login.cy.js', "it('logs in', () => {});\n");
    write('.github/workflows/e2e.yml', ['jobs:', '  e2e:', '    steps:', '      - uses: cypress-io/github-action@v6',
      '      - run: rm -rf testcafe-output'].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('F002 pass: The repository\'s end-to-end tests use Cypress 13.6.0 (yarn.lock), which meets the 12.0 minimum. '
      + 'The supported technologies page lists "Cypress 12.0, pending verification" (provisional); S007 would treat that entry as manual.');
    expect(analysis.frameworks.map(framework => framework.id)).toEqual(['cypress']);
    expect(analysis.frameworks[0].evidence).toEqual(expect.arrayContaining([
      { kind: 'ci', path: '.github/workflows/e2e.yml', line: 4, detail: 'job e2e uses cypress-io/github-action@v6' },
      { kind: 'directory', path: 'cypress/', detail: '1 file in cypress/' }
    ]));
    expect(analysis.checklist.items).toEqual([]);
    expect(result.details).toContain('Policy note:\n  - The officially supported technologies page marks Cypress as pending verification (provisional).');
  });

  it('leaves Cypress 10 to the reviewer as below the 12.0 minimum', async () => {
    writePackage({ devDependencies: { cypress: '^10.11.0' } });
    writeLock({ 'cypress@^10.11.0': '10.11.0' });
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('F002 manual: The repository\'s end-to-end tests use Cypress 10.11.0 (yarn.lock), which is below the 12.0 minimum.');
    expect(analysis.checklist.items[0].obligations).toEqual([{ id: 'F002-C1#1', subject: 'Cypress', path: 'package.json', line: 9 }]);
  });

  it.each([
    ['exactly 12.0.0', '12.0.0', undefined, EvaluationStatus.PASS, 'Cypress 12.0.0 (package.json, no yarn.lock), which meets the 12.0 minimum'],
    ['^12.0.0', '^12.0.0', undefined, EvaluationStatus.PASS, 'Cypress ^12.0.0 (package.json, no yarn.lock), which meets'],
    ['11.2.0, just below', '11.2.0', undefined, EvaluationStatus.MANUAL, 'Cypress 11.2.0 (package.json, no yarn.lock), which is below the 12.0 minimum'],
    ['9.7.0, which sorts after 12 as text', '9.7.0', undefined, EvaluationStatus.MANUAL, 'which is below the 12.0 minimum'],
    ['a range reaching below 12.0', '>=10.0.0', undefined, EvaluationStatus.MANUAL, 'Cypress >=10.0.0 (package.json, no yarn.lock), which allows versions below the 12.0 minimum'],
    ['the same range locked to 13.6.0', '>=10.0.0', '13.6.0', EvaluationStatus.PASS, 'Cypress 13.6.0 (yarn.lock), which meets'],
    ['^12.0.0 locked to 11.2.0', '^12.0.0', '11.2.0', EvaluationStatus.MANUAL, 'Cypress 11.2.0 (yarn.lock), which is below']
  ])('compares Cypress %s with the 12.0 minimum', async (_name, range, locked, status, text) => {
    writePackage({ devDependencies: { cypress: range } });
    if (locked) writeLock({ [`cypress@${range}`]: locked });
    commit();

    const { result } = await evaluate();

    expect(result.status).toBe(status);
    expect(result.evidence).toContain(text);
  });

  it('fails Playwright that only CI runs, even next to a passing Cypress', async () => {
    writePackage({ devDependencies: { cypress: '^13.6.0' } });
    writeLock({ 'cypress@^13.6.0': '13.6.0' });
    write('.github/workflows/smoke.yml', [
      'jobs:',
      '  smoke:',
      '    steps:',
      '      - run: |',
      '          # npx wdio run is not used any more',
      '          yarn install',
      '          npx playwright test --project chromium'
    ].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('F002 fail: The repository has end-to-end tests in Playwright, which is not on the officially supported technologies page '
      + '(it lists Cypress 12.0, pending verification).');
    expect(analysis.frameworks.map(framework => framework.id)).toEqual(['cypress', 'playwright']);
    expect(analysis.frameworks[1].evidence).toEqual([{ kind: 'ci', path: '.github/workflows/smoke.yml', line: 7,
      detail: 'job smoke runs npx playwright test --project chromium' }]);
    expect(analysis.checklist.items.map(item => item.id)).toEqual(['F002-C1', 'F002-C2']);
  });

  it('leaves Karma and BigTest to the reviewer, following FOLIO\'s shared workflow to the script CI runs', async () => {
    // stripes-cli runs Karma itself, so there is no karma dependency.
    writePackage({
      devDependencies: { '@bigtest/interactor': '^0.7.2', '@folio/stripes-cli': '^4.0.0' },
      scripts: { test: 'yarn test:jest && yarn test:bigtest', 'test:jest': 'jest', 'test:bigtest': 'stripes test karma' }
    });
    write('lib/Button/tests/Button-test.js', "describe('Button', () => {});\n");
    write('.github/workflows/ui.yml', SHARED_UI_WORKFLOW(['jest-test-command: yarn test:jest', 'bigtest-enabled: true']));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('F002 manual: The repository has browser tests that use Karma and BigTest. A reviewer must decide whether they are '
      + 'end-to-end tests; Karma and BigTest are not on the officially supported technologies page.');
    // The jest job runs Jest only; the BigTest job runs the default yarn test, which reaches Karma.
    expect(analysis.frameworks.find(framework => framework.id === 'karma')!.evidence.filter(item => item.kind === 'ci')).toEqual([{
      kind: 'ci', path: '.github/workflows/ui.yml', line: 6,
      detail: 'job ui (FOLIO\'s shared ui.yml, bigtest-enabled: true) runs yarn test (script test: yarn test:jest && yarn test:bigtest; script test:bigtest: stripes test karma)'
    }]);
    expect(analysis.checklist.items.flatMap(item => item.obligations)).toEqual([
      { id: 'F002-C1#1', subject: 'Karma', path: 'package.json', line: 15 },
      { id: 'F002-C1#2', subject: 'BigTest', path: 'package.json', line: 9 },
      { id: 'F002-C2#1' }
    ]);
  });

  it('does not count Jest component tests as end-to-end tests', async () => {
    writePackage({
      // Bare puppeteer and playwright are browser libraries, e.g. Chrome for Karma, not test frameworks.
      devDependencies: { '@folio/jest-config-stripes': '^3.0.0', '@testing-library/react': '^14.0.0', 'eslint-plugin-cypress': '^2.11.2',
        puppeteer: '^21.0.0', playwright: '^1.40.0' },
      scripts: { test: 'yarn run test:jest', 'test:jest': 'jest --ci --coverage' }
    });
    write('test/jest/Page.test.js', "it('renders', () => {});\n");
    write('.github/workflows/ui.yml', SHARED_UI_WORKFLOW(['jest-enabled: true', 'bigtest-enabled: false', 'bigtest-test-command: stripes test karma']));
    commit();

    const { result } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.evidence).toBe('F002 not applicable: The repository has no end-to-end tests. FOLIO\'s end-to-end tests for UI modules live in stripes-testing.');
  });

  it('reads what the Jenkinsfile runs outside comments, including buildNPM runTest', async () => {
    writePackage({ scripts: { test: 'stripes test karma' } });
    write('Jenkinsfile', [
      '/*',
      "sh 'npx playwright test'",
      '*/',
      'buildNPM {',
      '  runTest = true',
      "  // sh 'npx wdio run'",
      '}'
    ].join('\n'));
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.frameworks.map(framework => framework.id)).toEqual(['karma']);
    expect(analysis.frameworks[0].evidence.filter(item => item.kind === 'ci')).toEqual([{
      kind: 'ci', path: 'Jenkinsfile', line: 5, detail: 'runTest = true (runs yarn test) (script test: stripes test karma)'
    }]);
  });

  it.each([
    ['counts as the suite of the one framework found', true, EvaluationStatus.PASS, ['cypress']],
    ['alone is an unrecognized framework', false, EvaluationStatus.MANUAL, ['unrecognized']]
  ])('a test/e2e directory %s', async (_name, withCypress, status, ids) => {
    writePackage(withCypress ? { devDependencies: { cypress: '13.6.0' } } : {});
    write('test/e2e/login.spec.js', "it('logs in', () => {});\n");
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(status);
    expect(analysis.frameworks.map(framework => framework.id)).toEqual(ids);
    expect(analysis.frameworks[0].evidence).toContainEqual({ kind: 'directory', path: 'test/e2e/', detail: '1 file in test/e2e/' });
    if (!withCypress) expect(result.evidence).toContain('browser tests that use an unrecognized framework in test/e2e.');
  });

  it('falls back to the package.json range when yarn.lock cannot be read, without blocking a pass', async () => {
    writePackage({ devDependencies: { cypress: '^13.6.0' } });
    write('yarn.lock', '__metadata:\n  version: 6\n\n"cypress@npm:^13.6.0":\n  version: 13.6.0\n');
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toContain('Cypress ^13.6.0 (package.json; yarn.lock does not resolve it), which meets the 12.0 minimum');
    expect(analysis.unread).toEqual([{ path: 'yarn.lock', message: 'Is a Yarn 2+ lockfile, which the tool cannot read.', material: false }]);
  });

  it('leaves Cypress to the reviewer when its policy entry cannot be read', async () => {
    jest.spyOn(s007Policy, 'loadS007Policy').mockResolvedValue({
      ok: false, sourcePath: 'policy.json', diagnostics: [{ code: 'policy_missing', message: 'The policy file is missing.' }]
    });
    writePackage({ devDependencies: { cypress: '13.6.0' } });
    commit();

    const { result } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('F002 manual: The repository\'s end-to-end tests use Cypress 13.6.0 (package.json, no yarn.lock), '
      + 'but Cypress\'s policy entry could not be read (The policy file is missing.).');
  });

  it('does not call a repository without end-to-end tests not applicable when a workflow cannot be read', async () => {
    writePackage({ scripts: { test: 'jest' } });
    write('.github/workflows/ui.yml', 'jobs: [unclosed\n');
    commit();

    const { result, analysis } = await evaluate();

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.unread).toEqual([expect.objectContaining({ path: '.github/workflows/ui.yml', material: true })]);
  });

  describe('agent review', () => {
    beforeEach(() => {
      writePackage({ devDependencies: { karma: '^6.4.0', '@bigtest/interactor': '^0.7.2' }, scripts: { test: 'karma start' } });
      write('karma.conf.js', 'module.exports = () => {};\n');
      write('lib/Button/Button.js', 'export default () => null;\n');
      write('lib/Button/tests/Button-test.js', "describe('Button', () => {});\n");
      write('lib/Button/stories/Button.stories.js', 'export default {};\n');
      write('.github/workflows/ui.yml', SHARED_UI_WORKFLOW(['bigtest-enabled: true']));
      write('CHANGELOG.md', '# Change history\n');
      commit();
    });

    const karma = (fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
      technologyId: 'F002-C1#1', type: 'aligned_fact', summary: 'Button-test.js mounts Button alone with BigTest interactors; it is a component test.',
      evidenceReferences: ['karma.conf.js', 'lib/Button/tests/Button-test.js'], coverageDisposition: 'investigated', ...fields
    });
    const bigtest: CriterionAgentAssessment = { technologyId: 'F002-C1#2', type: 'aligned_fact', summary: 'The interactors drive mounted components only.',
      evidenceReferences: ['package.json', 'lib/Button/tests/Button-test.js'], coverageDisposition: 'investigated' };
    const ci: CriterionAgentAssessment = { technologyId: 'F002-C2#1', type: 'aligned_fact', summary: 'CI runs these Karma component tests and no end-to-end tests.',
      evidenceReferences: ['.github/workflows/ui.yml'], coverageDisposition: 'investigated' };
    const action = { action: 'Confirm that no suite needs a running FOLIO system.', evidenceReferences: ['lib/Button/tests/Button-test.js'] };

    it('gives the agent the test suites, CI and runner configuration, but not stories or the changelog', async () => {
      const { analysis } = await evaluate();
      const prepared = await prepareCriterionAgentReviewEvidence(buildF002AgentReviewRequest(repoPath, analysis));

      expect([...prepared.availableSourcePaths].sort()).toEqual(['.github/workflows/ui.yml', 'karma.conf.js', 'lib/Button/Button.js',
        'lib/Button/tests/Button-test.js', 'package.json']);
      expect(prepared.request.instructions).toContain('"Cypress 12.0, pending verification"');
    });

    it('runs by default when F002 is manual and attaches the results to the checklist, leaving the status unchanged', async () => {
      const config = fakeConfig({ assessments: [karma(), bigtest, ci], reviewerActions: [action] });
      delete config.enabledCriteria;

      const result = await evaluateWith(config);

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.agentReview?.available).toBe(true);
      expect(result.details).toContain('    - Agent: Supported by evidence — Karma: Button-test.js mounts Button alone with BigTest interactors; it is a component test.');
      expect(result.details).toContain('  - Agent review scope: ');
    });

    it.each([
      ['an unanswered CI obligation as having no agent result', [karma(), bigtest], 'F002-C2', ['    - No agent result']],
      ['an investigated suite that does not cite its own file as dropped', [karma({ evidenceReferences: ['lib/Button/tests/Button-test.js'] }), bigtest, ci], 'F002-C1',
        ['    - Agent result dropped — Karma: It is marked as investigated directly but does not cite the file it is about.',
          '    - Agent: Supported by evidence — BigTest: The interactors drive mounted components only.']]
    ])('keeps the rest of the review and shows %s', async (_name, assessments, itemId, rows) => {
      const result = await evaluateWith(fakeConfig({ assessments, reviewerActions: [action] }));
      const lines = (result.details ?? '').split('\n');
      const item = lines.findIndex(line => line.startsWith(`  - ${itemId} `));
      const next = lines.findIndex((line, index) => index > item && !line.startsWith('    '));

      expect(result.agentReview?.available).toBe(true);
      expect(result.agentReview?.assessments).toHaveLength(2);
      expect(lines.slice(item + 1, next).filter(line => /^ {4}- (?!Start with:)/.test(line))).toEqual(rows);
    });

    it('never reviews a fail, and says so', async () => {
      writePackage({ devDependencies: { '@playwright/test': '^1.40.0' } });
      commit();

      const result = await evaluateWith(fakeConfig({ assessments: [], reviewerActions: [action] }));

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.agentReview).toBeUndefined();
      expect(result.details).toContain('Agent review:\n  - Not applied: agent review runs only for manual results');
    });

    async function evaluateWith(config: CriterionAgentReviewConfig): Promise<CriterionResult> {
      return new FrontendEvaluator().evaluateCriterion('F002', repoPath, createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', agentReview: config }));
    }
    function fakeConfig(fields: Record<string, unknown>): CriterionAgentReviewConfig {
      return { enabled: true, enabledCriteria: ['F002'], adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
        available: true, criterionId: 'F002', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
        summary: 'The Karma suites look like component tests.', rationale: 'Read karma.conf.js and the Button tests.', evidenceReferences: ['karma.conf.js'],
        warnings: [], errors: [], ...fields
      } as CriterionAgentReviewConfig['fakeResult'] };
    }
  });

  async function evaluate(): Promise<{ result: CriterionResult; analysis: F002Analysis }> {
    const result = await new FrontendEvaluator().evaluateCriterion('F002', repoPath);
    return { result, analysis: result.criterionDetails as F002Analysis };
  }
  function writePackage(fields: Record<string, unknown>): void {
    write('package.json', JSON.stringify({ name: '@folio/example', stripes: { actsAs: ['app'] }, ...fields }, null, 2));
  }
  function writeLock(versions: Record<string, string>): void {
    write('yarn.lock', ['# yarn lockfile v1', '', ...Object.entries(versions).flatMap(([selector, version]) =>
      [`"${selector}":`, `  version "${version}"`, '']), ''].join('\n'));
  }
  function write(relativePath: string, content: string): void {
    const absolutePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repoPath });
  }
  function commit(): void {
    git('add', '.');
    git('commit', '-qm', 'fixture');
  }
});
