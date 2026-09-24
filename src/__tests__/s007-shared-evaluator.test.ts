import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { JavaScriptSharedEvaluator } from '../evaluators/javascript/javascript-shared-evaluator';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  CriterionAgentReviewConfig,
  EvaluationRun,
  EvaluationStatus,
  S007AnalysisResult,
  S007TechnologyEvidenceResult
} from '../types';
import * as EvaluationRunUtils from '../utils/evaluation-run';

class TestJavaSharedEvaluator extends SharedEvaluator {}

class EffectivePomRunner implements CommandRunner {
  requests: CommandExecutionRequest[] = [];

  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify(request);
  }

  async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    this.requests.push(request);
    const output = request.args?.find(argument => argument.startsWith('-Doutput='))?.slice('-Doutput='.length);
    if (output) {
      await fs.writeFile(output, `
        <project>
          <groupId>org.folio</groupId><artifactId>mod-example</artifactId><version>1</version>
          <dependencies>
            <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>4.1.1</version></dependency>
            <dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><version>1.18.42</version></dependency>
          </dependencies>
        </project>
      `);
    }
    return {
      identity: this.normalize(request),
      command: request.command,
      args: request.args ?? [],
      cwd: request.cwd,
      commandExecutionEnvironment: 'local',
      localCommandsAllowed: true,
      status: 'success',
      exitCode: 0,
      durationMs: 1,
      stdout: '',
      stderr: '',
      sanitized: true
    };
  }
}

describe('S007 shared evaluator', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 's007-shared-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(repoPath);
  });

  it('evaluates the current policy for Java and JavaScript without a policy selector', async () => {
    await write('pom.xml', `
      <project><properties><java.version>21</java.version></properties>
      <dependencies><dependency><groupId>org.folio</groupId><artifactId>raml-module-builder</artifactId><version>35.1.0</version></dependency></dependencies></project>
    `);
    const javaResult = await new TestJavaSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('java'));

    await fs.emptyDir(repoPath);
    await writeJson('package.json', {
      dependencies: { '@folio/stripes-core': '^10.1.0', react: '~18.2.0' },
      devDependencies: { typescript: '^5.0.0' }
    });
    await write('yarn.lock', `
      "@folio/stripes-core@^10.1.0":
        version "10.1.2"
      "react@~18.2.0":
        version "18.2.0"
    `);
    const jsResult = await new JavaScriptSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('javascript'));

    for (const result of [javaResult, jsResult]) {
      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).not.toContain('evaluation logic not yet implemented');
      expect(result.details).not.toMatch(/policy selector|policy release|flower release/i);
      expect(result.criterionDetails).toMatchObject({ criterionId: 'S007', policyFormatVersion: '1.0' });
    }
  });

  it('creates a criterion-scoped run when direct evaluation does not supply one', async () => {
    await writeJson('package.json', { dependencies: { react: '17.0.2' } });
    await write('yarn.lock', '"react@17.0.2":\n  version "17.0.2"\n');
    const spy = jest.spyOn(EvaluationRunUtils, 'createEvaluationRun');

    const result = await new JavaScriptSharedEvaluator().evaluateCriterion('S007', repoPath);

    expect(spy).toHaveBeenCalledWith({ repositoryPath: repoPath, language: 'javascript', criteriaFilter: ['S007'] });
    expect(result.status).toBe(EvaluationStatus.FAIL);
  });

  it.each([
    ['pass', { dependencies: { react: '~18.2.0' } }, '"react@~18.2.0":\n  version "18.2.1"\n', EvaluationStatus.PASS],
    ['fail', { dependencies: { react: '17.0.2' } }, '"react@17.0.2":\n  version "17.0.2"\n', EvaluationStatus.FAIL],
    ['manual', { dependencies: { react: '^18.0.0' } }, undefined, EvaluationStatus.MANUAL]
  ])('returns structured and human-readable %s rationale', async (_name, manifest, lockfile, expected) => {
    await writeJson('package.json', manifest);
    if (lockfile) await write('yarn.lock', lockfile);

    const result = await new JavaScriptSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('javascript'));
    const details = result.criterionDetails as S007AnalysisResult;

    expect(result.status).toBe(expected);
    expect(details.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        technologyId: 'react',
        evidence: [expect.objectContaining({ path: 'package.json' })],
        matchedPolicy: expect.objectContaining({ entryId: 'react' })
      })
    ]));
    expect(result.details).toContain('frontend-third-party-frameworks/react');
    expect(result.details).toContain('package.json');
  });

  it('keeps deterministic evidence before an unavailable advisory note', async () => {
    await writeJson('package.json', { dependencies: { vue: '^3.0.0' } });

    const result = await new JavaScriptSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('javascript'));
    const details = result.criterionDetails as S007AnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(details.agentReviewUnavailableReason).toContain('disabled or unconfigured');
    expect(result.details!.indexOf('Technology findings:')).toBeLessThan(result.details!.indexOf('Agent review:'));
    expect(result.details).toContain('Agent review:\n  - Not applied: agent review is disabled or unconfigured');
  });

  it('enriches unresolved Maven versions through the approved command runner', async () => {
    await write('pom.xml', `
      <project>
        <modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>4.1.1</version><relativePath /></parent>
        <groupId>org.folio</groupId><artifactId>mod-example</artifactId><version>1</version>
        <properties><java.version>21</java.version></properties>
        <dependencies>
          <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
          <dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId></dependency>
        </dependencies>
      </project>
    `);
    const runner = new EffectivePomRunner();

    const result = await new TestJavaSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('java', runner));
    const details = result.criterionDetails as S007AnalysisResult;

    expect(runner.requests).toHaveLength(1);
    expect(details.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        technologyId: 'spring-boot',
        classification: 'contested',
        evidence: [expect.objectContaining({
          resolvedVersion: '4.1.1',
          resolutionSource: 'maven-effective-pom'
        })]
      }),
      expect.objectContaining({
        technologyId: 'lombok',
        classification: 'compliant',
        evidence: [expect.objectContaining({ resolvedVersion: '1.18.42' })]
      })
    ]));
    expect(details.evidenceDiagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'maven_remote_parent' }),
      expect.objectContaining({ code: 'version_unresolved' })
    ]));
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.details).toContain('Resolution method: Maven effective POM');
  });

  it('attaches an available advisory end to end without changing manual status', async () => {
    await writeJson('package.json', { dependencies: { vue: '^3.0.0' } });
    await write('yarn.lock', '"vue@^3.0.0":\n  version "3.4.0"\n');
    const agentReview: CriterionAgentReviewConfig = {
      enabled: true,
      enabledCriteria: ['S007'],
      adapter: 'fake',
      modelLabel: 'fake-model',
      fakeResult: {
        available: true,
        criterionId: 'S007',
        recommendation: 'needs_reviewer_judgment',
        confidence: 'medium',
        summary: 'Vue is explicitly declared.',
        rationale: 'The manifest establishes an unlisted framework candidate.',
        evidenceReferences: ['package.json'],
        assessments: [{
          technologyId: 'vue',
          type: 'policy_question',
          summary: 'Vue is declared but has no matched policy entry.',
          evidenceReferences: ['package.json']
        }],
        reviewerActions: [{
          action: 'Confirm whether Vue is acceptable under the current policy.',
          evidenceReferences: ['package.json']
        }],
        warnings: [],
        errors: []
      }
    };

    const result = await new JavaScriptSharedEvaluator().evaluateCriterion(
      'S007',
      repoPath,
      createRun('javascript', undefined, agentReview)
    );

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toMatchObject({
      available: true,
      recommendation: 'needs_reviewer_judgment',
      evidenceReferences: ['package.json']
    });
    expect(result.details).toContain('Vue is explicitly declared.');
    expect(result.details).toContain('Practical assessments:');
    expect(result.details).toContain('Reviewer actions:');
    expect(result.details).toContain('Deterministic result remains Manual.');
  });

  it('preserves fail precedence and both contributions', async () => {
    await writeJson('package.json', { dependencies: { react: '17.0.2', vue: '^3.0.0' } });
    await write('yarn.lock', '"react@17.0.2":\n  version "17.0.2"\n"vue@^3.0.0":\n  version "3.4.0"\n');

    const result = await new JavaScriptSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('javascript'));
    const details = result.criterionDetails as S007AnalysisResult;

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(details.findings.map(finding => finding.contribution)).toEqual(expect.arrayContaining(['fail', 'manual']));
  });

  it('returns manual when a declared dependency has no matching lockfile selector', async () => {
    await writeJson('package.json', { dependencies: { react: '>=16' } });
    await write('yarn.lock', '"left-pad@^1.3.0":\n  version "1.3.0"\n');

    const result = await new JavaScriptSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('javascript'));
    const details = result.criterionDetails as S007AnalysisResult;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(details.evidenceDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'version_unresolved',
        material: true,
        message: expect.stringContaining('react@>=16')
      })
    ]));
  });

  it('uses the installed dependency despite a broader peer compatibility range', async () => {
    await writeJson('package.json', {
      devDependencies: { react: '^18.3.0' },
      peerDependencies: { react: '>=16' }
    });
    await write('yarn.lock', '"react@^18.3.0":\n  version "18.3.1"\n');

    const result = await new JavaScriptSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('javascript'));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect((result.criterionDetails as S007AnalysisResult).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ technologyId: 'react', classification: 'compliant' })
    ]));
  });

  it('keeps Maven profile-dependent evidence manual', async () => {
    await write('pom.xml', `
      <project>
        <properties><java.version>21</java.version></properties>
        <dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>5.0.2</version></dependency></dependencies>
        <profiles><profile><id>legacy</id><properties><vertx.version>4.5.0</vertx.version></properties></profile></profiles>
      </project>
    `);

    const result = await new TestJavaSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('java'));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect((result.criterionDetails as S007AnalysisResult).evidenceDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'version_unresolved', message: expect.stringContaining('Maven profiles') })
    ]));
  });

  it('resolves property-backed Gradle plugin versions before classification', async () => {
    await write('gradle.properties', 'grailsVersion=7.0.0\n');
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
      plugins { id 'org.grails.grails-web' version grailsVersion }
    `);

    const result = await new TestJavaSharedEvaluator().evaluateCriterion('S007', repoPath, createRun('java'));
    const details = result.criterionDetails as S007AnalysisResult;

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(details.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ technologyId: 'grails', classification: 'compliant' }),
      expect.objectContaining({ technologyId: 'java', classification: 'compliant' })
    ]));
  });

  it('reuses shared static evidence without commands and keeps remote-derived evidence manual', async () => {
    await writeJson('package.json', { dependencies: { react: '~18.2.0' } });
    await write('yarn.lock', '"react@~18.2.0":\n  version "18.2.0"\n');
    const runner: CommandRunner = { run: jest.fn(), normalize: jest.fn() };
    const run = createRun('javascript', runner);
    const sharedEvidence: S007TechnologyEvidenceResult = {
      observations: [{
        identityCandidates: ['react'],
        displayName: 'React',
        ecosystem: 'javascript',
        technologyType: 'framework',
        evidenceKind: 'dependency-declaration',
        sourcePath: 'package.json',
        sourceDetail: 'remote effective dependency model',
        declaredVersion: '~18.2.0',
        resolvedVersion: '18.2.0',
        confidence: 'confident',
        provenance: 'shared-remote-resolution'
      }],
      diagnostics: [],
      manifestPaths: ['package.json'],
      complete: true
    };
    run.artifacts.s007TechnologyEvidence = sharedEvidence;

    const result = await new JavaScriptSharedEvaluator().evaluateCriterion('S007', repoPath, run);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect((runner.run as jest.Mock)).not.toHaveBeenCalled();
    expect(run.commandObservations.size).toBe(0);
    expect(run.artifacts.s007TechnologyEvidence).toBe(sharedEvidence);
  });

  function createRun(
    language: 'java' | 'javascript',
    commandRunner?: CommandRunner,
    agentReview?: CriterionAgentReviewConfig
  ): EvaluationRun {
    return EvaluationRunUtils.createEvaluationRun({
      repositoryPath: repoPath,
      language,
      criteriaFilter: ['S007'],
      commandRunner,
      agentReview
    });
  }

  async function write(relativePath: string, content: string): Promise<void> {
    const target = path.join(repoPath, relativePath);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, dedent(content));
  }

  async function writeJson(relativePath: string, value: unknown): Promise<void> {
    await fs.writeJson(path.join(repoPath, relativePath), value, { spaces: 2 });
  }
});

function dedent(content: string): string {
  const lines = content.replace(/^\n/, '').split('\n');
  const indentation = lines.filter(line => line.trim()).reduce(
    (minimum, line) => Math.min(minimum, line.match(/^\s*/)?.[0].length ?? 0),
    Infinity
  );
  return lines.map(line => line.slice(Number.isFinite(indentation) ? indentation : 0)).join('\n');
}
