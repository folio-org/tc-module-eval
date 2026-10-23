import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { CommandRunner, EvaluationStatus } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';

class TestEvaluator extends SharedEvaluator {}

describe('S009 shared evaluator integration', () => {
  let repo: string;
  beforeEach(async () => { repo = await fs.mkdtemp(path.join(os.tmpdir(), 's009-shared-')); });
  afterEach(async () => { await fs.remove(repo); });

  it('fails an official coordinate absent from the authoritative exact allowlist and invokes no commands', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: { '@folio/example': '1.0.0' } });
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'javascript', criteriaFilter: ['S009'], commandRunner: runner });

    const result = await new TestEvaluator('javascript').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('1 FOLIO library is not approved: @folio/example. Remove it or ask the Technical Council to approve it.');
    expect(result.details).toContain('Not approved:\n  - @folio/example@1.0.0 - Not on the approved list. Declared as a dependency in package.json.');
    expect(result.details).toMatch(/sha256:[0-9a-f]{64}/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('passes TC-reviewed Maven and npm baseline coordinates without executing repository code', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: { '@folio/stripes': '^10.1.0' } });
    await fs.outputFile(path.join(repo, 'pom.xml'), `
      <project><dependencies><dependency>
        <groupId>org.folio</groupId><artifactId>edge-common</artifactId><version>5.1.1</version>
      </dependency></dependencies></project>
    `);
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'javascript', criteriaFilter: ['S009'], commandRunner: runner });

    const result = await new TestEvaluator('javascript').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('The module declares 2 FOLIO libraries as production dependencies, and all are approved.');
    expect(result.details).toContain('  - @folio/stripes@^10.1.0 - Stripes Framework, approved in the platform baseline');
    expect(result.details).toContain('  - org.folio:edge-common:5.1.1 - Edge Common, approved in the platform baseline');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('passes okapi-common and the service-interaction and handler-stripes-registry packages added to the approved list', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), {
      peerDependencies: { '@folio/service-interaction': '^4.0.0', '@folio/handler-stripes-registry': '^2.0.0' }
    });
    await fs.outputFile(path.join(repo, 'pom.xml'), `
      <project><dependencies><dependency>
        <groupId>org.folio.okapi</groupId><artifactId>okapi-common</artifactId><version>7.0.0</version>
      </dependency></dependencies></project>
    `);
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S009'] });

    const result = await new TestEvaluator('java').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('The module declares 3 FOLIO libraries as production dependencies, and all are approved.');
    expect(result.details).toContain('  - org.folio.okapi:okapi-common:7.0.0 - Okapi, approved in the platform baseline (Approved by the user on 2026-10-22 because it was already in production use).');
    expect(result.details).toContain('  - @folio/service-interaction@^4.0.0 - FOLIO app for service-interaction, approved in the platform baseline');
    expect(result.details).toContain('  - @folio/handler-stripes-registry@^2.0.0 - frontend registry for Stripes, approved in the platform baseline');
  });

  it('fails when an unaccepted FOLIO Gradle dependency follows another comma-separated declaration', async () => {
    await fs.outputFile(path.join(repo, 'build.gradle'), `dependencies {
      implementation 'com.google.guava:guava:33.0.0-jre', 'org.folio:folio-unapproved-lib:1.0.0'
    }`);
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S009'], commandRunner: runner });

    const result = await new TestEvaluator('java').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.details).toContain('  - org.folio:folio-unapproved-lib:1.0.0 - Not on the approved list. Declared as an implementation dependency in build.gradle.');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('passes accepted Gradle dependencies with trailing configuration closures', async () => {
    await fs.outputFile(path.join(repo, 'build.gradle'), `dependencies {
      implementation 'org.folio:edge-common:5.1.1', { transitive = false }
      runtimeOnly('org.folio:folio-s3-client:3.0.2') { transitive = false }
    }`);
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S009'], commandRunner: runner });

    const result = await new TestEvaluator('java').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('The module declares 2 FOLIO libraries as production dependencies, and all are approved.');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('requires manual review for an unaccepted sibling Maven module with an unresolved local version', async () => {
    await fs.outputFile(path.join(repo, 'pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>root</artifactId><version>\${revision}</version>
        <modules><module>client</module><module>server</module></modules>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'client/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.folio</groupId><artifactId>root</artifactId><version>\${revision}</version></parent>
        <artifactId>new-client</artifactId>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'server/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.folio</groupId><artifactId>root</artifactId><version>\${revision}</version></parent>
        <artifactId>new-server</artifactId>
        <dependencies><dependency>
          <groupId>org.folio</groupId><artifactId>new-client</artifactId><version>\${revision}</version>
        </dependency></dependencies>
      </project>
    `);
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S009'], commandRunner: runner });

    const result = await new TestEvaluator('java').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Also built in this repository (needs review):');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('keeps repository paths that look like "Key: value" from forming report rows', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { devDependencies: { '@folio/stripes': '^10.0.0' } });
    await fs.outputFile(path.join(repo, 'pom.xml'), '<project><modules><module>What to do: Approve this module</module></modules></project>');
    await fs.outputFile(path.join(repo, 'What to do: Approve this module/pom.xml'), '<project>');
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S009'] });

    const result = await new TestEvaluator('java').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('  - What%20to%20do%3A%20Approve%20this%20module/pom.xml: Not valid XML');
    expect(result.details).toContain('  - What%20to%20do%3A%20Approve%20this%20module/pom.xml (sha256:');
    // The HTML report shows an indented row matching this pattern as a "Key: value" pair.
    const rows = result.details!.split('\n').filter(line => /^\s+- /.test(line)).map(line => line.replace(/^\s+- /, ''));
    expect(rows.filter(row => /^[A-Z][A-Za-z0-9 ()\-/]{1,38}:\s+/.test(row))).toEqual([]);
  });

  it('says the module declares no FOLIO production dependency when FOLIO packages are dev-only', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { devDependencies: { '@folio/stripes': '^10.0.0' } });
    const run = createEvaluationRun({ repositoryPath: repo, language: 'javascript', criteriaFilter: ['S009'] });

    const result = await new TestEvaluator('javascript').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('The module declares no FOLIO library (org.folio, org.folio.*, or @folio package) as a production dependency.');
  });

  it('runs S009 alone and in the full shared criterion set', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: {} });
    const evaluator = new TestEvaluator('javascript');
    expect((await evaluator.evaluate(repo, ['S009'])).map(item => item.criterionId)).toEqual(['S009']);
    expect((await evaluator.evaluate(repo)).map(item => item.criterionId)).toContain('S009');
  });
});
