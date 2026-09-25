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
    expect(result.details).toContain('@folio/example:');
    expect(result.details).toContain('Classification: Not accepted for S009');
    expect(result.details).toContain('Declared version: 1.0.0');
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
    expect(result.details).toContain('@folio/stripes:');
    expect(result.details).toContain('Declared version: ^10.1.0');
    expect(result.details).toContain('org.folio:edge-common:');
    expect(result.details).toContain('Declared version: 5.1.1');
    expect(result.details?.match(/Classification: Accepted for S009/g)).toHaveLength(2);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('fails when an unaccepted FOLIO Gradle dependency follows another comma-separated declaration', async () => {
    await fs.outputFile(path.join(repo, 'build.gradle'), `dependencies {
      implementation 'com.google.guava:guava:33.0.0-jre', 'org.folio:folio-unapproved-lib:1.0.0'
    }`);
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S009'], commandRunner: runner });

    const result = await new TestEvaluator('java').evaluateCriterion('S009', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.details).toContain('org.folio:folio-unapproved-lib:');
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
    expect(result.details).toContain('Manual review: local resolution is ambiguous');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('runs S009 alone and in the full shared criterion set', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: {} });
    const evaluator = new TestEvaluator('javascript');
    expect((await evaluator.evaluate(repo, ['S009'])).map(item => item.criterionId)).toEqual(['S009']);
    expect((await evaluator.evaluate(repo)).map(item => item.criterionId)).toContain('S009');
  });
});
