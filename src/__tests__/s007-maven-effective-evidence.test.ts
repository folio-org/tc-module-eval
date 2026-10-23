import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  EvaluationStatus,
  EvaluationRun,
  S007TechnologyEvidenceResult
} from '../types';
import { evaluateS007 } from '../utils/s007-evaluator';
import { enrichS007WithMavenEffectivePom } from '../utils/s007-maven-effective-evidence';
import { loadS007Policy } from '../utils/s007-policy';
import { collectS007TechnologyEvidence } from '../utils/s007-technology-evidence';

class EffectivePomRunner implements CommandRunner {
  requests: CommandExecutionRequest[] = [];

  constructor(
    private readonly effectivePom?: string,
    private readonly status: CommandExecutionResult['status'] = 'success',
    private readonly symlinkOutput = false
  ) {}

  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify(request);
  }

  async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    this.requests.push(request);
    const outputArgument = request.args?.find(argument => argument.startsWith('-Doutput='));
    if (this.status === 'success' && this.effectivePom && outputArgument) {
      const outputPath = outputArgument.slice('-Doutput='.length);
      if (this.symlinkOutput) {
        const target = `${outputPath}.target`;
        await fs.writeFile(target, this.effectivePom);
        await fs.symlink(target, outputPath);
      } else {
        await fs.writeFile(outputPath, this.effectivePom);
      }
    }
    return {
      identity: this.normalize(request),
      command: request.command,
      args: request.args ?? [],
      cwd: request.cwd,
      commandExecutionEnvironment: 'local',
      localCommandsAllowed: true,
      status: this.status,
      exitCode: this.status === 'success' ? 0 : 1,
      durationMs: 1,
      stdout: '',
      stderr: '',
      sanitized: true
    };
  }
}

describe('S007 Maven effective-POM evidence', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 's007-effective-pom-'));
    await fs.writeFile(path.join(repoPath, 'pom.xml'), `
      <project>
        <modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>mod-example</artifactId><version>1.0.0</version>
      </project>
    `);
  });

  afterEach(async () => {
    await fs.remove(repoPath);
  });

  it('enriches exact unresolved dependencies and clears resolved model diagnostics', async () => {
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.springframework.boot', 'spring-boot-starter-web', '4.1.1'),
      dependency('org.projectlombok', 'lombok', '1.18.42')
    ]));
    const evidence = unresolvedEvidence([
      'org.springframework.boot:spring-boot-starter-web',
      'org.projectlombok:lombok'
    ]);

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceDetail: 'org.springframework.boot:spring-boot-starter-web',
        resolvedVersion: '4.1.1',
        resolutionSource: 'maven-effective-pom',
        provenance: 'shared-remote-resolution'
      }),
      expect.objectContaining({
        sourceDetail: 'org.projectlombok:lombok',
        resolvedVersion: '1.18.42',
        provenance: 'shared-remote-resolution'
      })
    ]));
    expect(enriched.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'maven_remote_parent' }),
      expect.objectContaining({ code: 'version_unresolved' })
    ]));
    expect(enriched.complete).toBe(true);
    expect(runner.requests[0]).toMatchObject({
      command: 'mvn',
      cwd: repoPath,
      requiresIsolation: true,
      networkPolicy: { default: 'deny' }
    });
    expect(runner.requests[0].args).toEqual(expect.arrayContaining([
      '-N',
      'org.apache.maven.plugins:maven-help-plugin:3.5.2:effective-pom'
    ]));
  });

  it('matches the full Maven key and retains coverage for unrepresented effective dependencies', async () => {
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.springframework.boot', 'spring-boot-loader-tools', '4.1.1', 'jar'),
      dependency('org.springframework.boot', 'spring-boot-loader-tools', '4.2.0', 'test-jar')
    ]));
    const evidence = unresolvedEvidence([
      'org.springframework.boot:spring-boot-loader-tools',
      'org.springframework.boot:spring-boot-not-managed'
    ]);

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched.observations[0]).toMatchObject({ resolvedVersion: '4.1.1' });
    expect(enriched.observations[1].resolvedVersion).toBeUndefined();
    expect(enriched.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'effective_model_unrepresented',
        message: expect.stringContaining('spring-boot-loader-tools:test-jar:')
      }),
      expect.objectContaining({
        code: 'version_unresolved',
        message: expect.stringContaining('spring-boot-not-managed')
      })
    ]));
    expect(enriched.complete).toBe(false);
  });

  it('retains incomplete coverage for an inherited relevant effective-model dependency', async () => {
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.projectlombok', 'lombok', '1.18.48'),
      dependency('io.vertx', 'vertx-core', '4.5.0')
    ]));
    const evidence = unresolvedEvidence(['org.projectlombok:lombok']);

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched.observations[0]).toMatchObject({ resolvedVersion: '1.18.48' });
    expect(enriched.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'effective_model_unrepresented',
        material: true,
        message: expect.stringContaining('includes io.vertx:vertx-core 4.5.0, which is not declared in the repository')
      })
    ]));
    expect(enriched.complete).toBe(false);
  });

  it('does not report an undeclared test-scoped effective-model dependency, which could not decide the status', async () => {
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.projectlombok', 'lombok', '1.18.48'),
      dependency('io.vertx', 'vertx-junit5', '4.5.0').replace('</dependency>', '<scope>test</scope></dependency>')
    ]));

    const enriched = await enrichS007WithMavenEffectivePom(
      repoPath, unresolvedEvidence(['org.projectlombok:lombok']), run(runner), runner
    );

    expect(enriched.diagnostics).toEqual([]);
    expect(enriched.complete).toBe(true);
  });

  it('clears a parent POM BOM warning once the module effective POM resolves every missing version', async () => {
    await fs.writeFile(path.join(repoPath, 'pom.xml'), `
      <project>
        <modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>mod-example-parent</artifactId><version>1.0.0</version>
        <properties><java.version>21</java.version></properties>
        <dependencyManagement><dependencies>
          <dependency><groupId>io.vertx</groupId><artifactId>vertx-stack-depchain</artifactId><version>5.0.4</version><type>pom</type><scope>import</scope></dependency>
        </dependencies></dependencyManagement>
        <modules><module>mod-example</module></modules>
      </project>
    `);
    await fs.outputFile(path.join(repoPath, 'mod-example/pom.xml'), `
      <project>
        <modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.folio</groupId><artifactId>mod-example-parent</artifactId><version>1.0.0</version></parent>
        <artifactId>mod-example</artifactId>
        <dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId></dependency></dependencies>
      </project>
    `);
    const staticEvidence = await collectS007TechnologyEvidence(repoPath, 'java');
    expect(staticEvidence.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'maven_imported_bom', path: 'pom.xml' })
    ]));
    const runner = new EffectivePomRunner(effectivePom([dependency('io.vertx', 'vertx-core', '5.0.4')]));

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, staticEvidence, run(runner), runner);

    expect(runner.requests).toHaveLength(1);
    expect(enriched.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: 'mod-example/pom.xml', resolvedVersion: '5.0.4' })
    ]));
    expect(enriched.diagnostics).toEqual([]);
    expect(enriched.complete).toBe(true);
  });

  it('enriches a module POM with a non-standard file name', async () => {
    await fs.outputFile(path.join(repoPath, 'tools/pom-tools.xml'), await fs.readFile(path.join(repoPath, 'pom.xml'), 'utf8'));
    const runner = new EffectivePomRunner(effectivePom([dependency('org.projectlombok', 'lombok', '1.18.42')]));

    const enriched = await enrichS007WithMavenEffectivePom(
      repoPath, unresolvedEvidence(['org.projectlombok:lombok'], 'tools/pom-tools.xml'), run(runner), runner
    );

    expect(runner.requests).toHaveLength(1);
    expect(enriched.observations[0]).toMatchObject({ resolvedVersion: '1.18.42' });
  });

  it('reports an unchecked effective-model dependency for each POM that has it', async () => {
    const pom = await fs.readFile(path.join(repoPath, 'pom.xml'), 'utf8');
    await fs.outputFile(path.join(repoPath, 'a/pom.xml'), pom);
    await fs.outputFile(path.join(repoPath, 'b/pom.xml'), pom);
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.projectlombok', 'lombok', '1.18.42'),
      dependency('io.vertx', 'vertx-core', '4.5.0')
    ]));
    const a = unresolvedEvidence(['org.projectlombok:lombok'], 'a/pom.xml');
    const b = unresolvedEvidence(['org.projectlombok:lombok'], 'b/pom.xml');
    const evidence = { ...a, observations: [...a.observations, ...b.observations], diagnostics: [...a.diagnostics, ...b.diagnostics] };

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched.diagnostics
      .filter(diagnostic => diagnostic.code === 'effective_model_unrepresented')
      .map(diagnostic => diagnostic.path)).toEqual(['a/pom.xml', 'b/pom.xml']);
  });

  (process.getuid?.() === 0 ? it.skip : it)('skips enrichment, keeping the evidence, when a POM cannot be read', async () => {
    await fs.chmod(path.join(repoPath, 'pom.xml'), 0o000);
    const runner = new EffectivePomRunner(effectivePom([dependency('org.projectlombok', 'lombok', '1.18.42')]));
    const evidence = unresolvedEvidence(['org.projectlombok:lombok']);

    try {
      const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

      expect(enriched).toBe(evidence);
      expect(runner.requests).toHaveLength(0);
    } finally {
      await fs.chmod(path.join(repoPath, 'pom.xml'), 0o644);
    }
  });

  it('marks a conflict introduced by an effective-POM version', async () => {
    const evidence = unresolvedEvidence(['org.grails:grails-datastore-core']);
    evidence.observations[0].identityCandidates = ['grails', 'org.grails:grails-datastore-core'];
    evidence.observations[0].displayName = 'Grails';
    evidence.observations.push({
      ...evidence.observations[0],
      sourceDetail: 'org.grails:grails-core',
      declaredVersion: '7.0.0',
      mavenDependency: {
        groupId: 'org.grails',
        artifactId: 'grails-core',
        type: 'jar',
        classifier: ''
      },
      confidence: 'confident'
    });
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.grails', 'grails-datastore-core', '7.0.1'),
      dependency('org.grails', 'grails-core', '7.0.0')
    ]));

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'conflicting_versions', material: true })
    ]));
    expect(enriched.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceDetail: 'org.grails:grails-datastore-core', conflictPaths: ['pom.xml'] }),
      expect.objectContaining({ sourceDetail: 'org.grails:grails-core', conflictPaths: ['pom.xml'] })
    ]));
    expect(enriched.complete).toBe(false);
  });

  it('suppresses Grails plugin presence after core becomes authoritative through enrichment', async () => {
    const evidence = unresolvedEvidence(['org.grails:grails-core']);
    evidence.observations[0].identityCandidates = ['grails', 'org.grails:grails-core'];
    evidence.observations[0].displayName = 'Grails';
    evidence.observations.push({
      ...evidence.observations[0],
      identityCandidates: ['grails', 'org.grails.plugins:database-migration'],
      sourceDetail: 'org.grails.plugins:database-migration',
      mavenDependency: {
        groupId: 'org.grails.plugins',
        artifactId: 'database-migration',
        type: 'jar',
        classifier: ''
      },
      versionResolutionEligible: false
    });
    evidence.diagnostics.push({
      code: 'version_unresolved',
      message: 'org.grails.plugins:database-migration shows that Grails is used, but its version is not the Grails version.',
      material: true,
      path: 'pom.xml'
    });
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.grails', 'grails-core', '7.0.0'),
      dependency('org.grails.plugins', 'database-migration', '5.0.0')
    ]));

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched.observations).toHaveLength(1);
    expect(enriched.observations[0]).toMatchObject({
      sourceDetail: 'org.grails:grails-core',
      resolvedVersion: '7.0.0'
    });
    expect(enriched.diagnostics).toEqual([]);
    expect(enriched.suppressedMavenDependencies).toEqual([
      expect.objectContaining({
        sourcePath: 'pom.xml',
        dependency: expect.objectContaining({ groupId: 'org.grails.plugins', artifactId: 'database-migration' })
      })
    ]);
    expect(enriched.complete).toBe(true);
  });

  it('does not promote a presence-only Grails plugin artifact into a framework version', async () => {
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.grails.plugins', 'database-migration', '5.0.0')
    ]));
    const evidence = unresolvedEvidence(['org.grails.plugins:database-migration']);
    evidence.observations[0].versionResolutionEligible = false;
    evidence.observations[0].identityCandidates = ['grails', 'org.grails.plugins:database-migration'];

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched).toEqual(evidence);
    expect(enriched.observations[0].resolvedVersion).toBeUndefined();
  });

  it.each(['blocked', 'failed', 'timed_out'] as const)(
    'preserves static evidence when Maven is %s',
    async status => {
      const runner = new EffectivePomRunner(undefined, status);
      const evidence = unresolvedEvidence(['org.springframework.boot:spring-boot-starter-web']);

      const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

      expect(enriched).toEqual(evidence);
    }
  );

  it.each([
    ['malformed XML', '<project>'],
    ['oversized XML', 'x'.repeat(2 * 1024 * 1024 + 1)]
  ])('preserves static evidence for %s output', async (_name, output) => {
    const runner = new EffectivePomRunner(output);
    const evidence = unresolvedEvidence(['org.projectlombok:lombok']);

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched).toEqual(evidence);
  });

  it('rejects an effective model containing a dependency without a version', async () => {
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.projectlombok', 'lombok', '1.18.48'),
      '<dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId></dependency>'
    ]));
    const evidence = unresolvedEvidence(['org.projectlombok:lombok']);

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched).toEqual(evidence);
  });

  it('rejects a symlinked effective-POM output', async () => {
    const runner = new EffectivePomRunner(
      effectivePom([dependency('org.projectlombok', 'lombok', '1.18.48')]),
      'success',
      true
    );
    const evidence = unresolvedEvidence(['org.projectlombok:lombok']);

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched).toEqual(evidence);
  });

  it('reads the project identity from the POM before Maven runs, not through a link the build left behind', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 's007-outside-'));
    const outsidePom = path.join(outside, 'pom.xml');
    await fs.writeFile(outsidePom, effectivePom([], 'other-project', '9.9.9', 'org.example'));
    class ReplacingRunner extends EffectivePomRunner {
      async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
        await fs.remove(path.join(repoPath, 'pom.xml'));
        await fs.symlink(outsidePom, path.join(repoPath, 'pom.xml'));
        return super.run(request);
      }
    }
    const runner = new ReplacingRunner(effectivePom([dependency('org.projectlombok', 'lombok', '1.18.42')]));

    try {
      const enriched = await enrichS007WithMavenEffectivePom(
        repoPath, unresolvedEvidence(['org.projectlombok:lombok']), run(runner), runner
      );

      expect(enriched.observations[0]).toMatchObject({ resolvedVersion: '1.18.42' });
    } finally {
      await fs.remove(outside);
    }
  });

  it('rejects an effective model for a different Maven project', async () => {
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.springframework.boot', 'spring-boot-starter-web', '4.1.1')
    ], 'different-module'));
    const evidence = unresolvedEvidence(['org.springframework.boot:spring-boot-starter-web']);

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched).toEqual(evidence);
  });

  it.each([
    ['another release', effectivePom([dependency('org.projectlombok', 'lombok', '1.18.48')], 'mod-example', '2.0.0')],
    ['a missing effective group ID', effectivePom([dependency('org.projectlombok', 'lombok', '1.18.48')], 'mod-example', '1.0.0', '')],
    ['a parent-inherited effective group ID', effectivePomWithParentIdentity('groupId')],
    ['a parent-inherited effective version', effectivePomWithParentIdentity('version')]
  ])('rejects an effective model for %s', async (_name, model) => {
    const runner = new EffectivePomRunner(model);
    const evidence = unresolvedEvidence(['org.projectlombok:lombok']);

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched).toEqual(evidence);
  });

  it('accounts for a suppressed Grails plugin while enriching and evaluating the repository evidence', async () => {
    await fs.writeFile(path.join(repoPath, 'pom.xml'), `
      <project>
        <modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>mod-example</artifactId><version>1.0.0</version>
        <properties><maven.compiler.release>17</maven.compiler.release></properties>
        <dependencies>
          ${dependency('org.grails', 'grails-core', '7.0.0')}
          ${dependency('org.grails.plugins', 'database-migration', '5.0.0')}
          <dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId></dependency>
        </dependencies>
      </project>
    `);
    const staticEvidence = await collectS007TechnologyEvidence(repoPath, 'java');
    const runner = new EffectivePomRunner(effectivePom([
      dependency('org.grails', 'grails-core', '7.0.0'),
      dependency('org.grails.plugins', 'database-migration', '5.0.0'),
      dependency('org.projectlombok', 'lombok', '1.18.48')
    ]));

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, staticEvidence, run(runner), runner);
    const policy = await loadS007Policy();
    const result = evaluateS007(policy, enriched, 'java');

    expect(enriched.diagnostics).toEqual([]);
    expect(enriched.complete).toBe(true);
    expect(enriched.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceDetail: 'org.grails.plugins:database-migration' })
    ]));
    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ technologyId: 'java', classification: 'compliant' }),
      expect.objectContaining({ technologyId: 'grails', classification: 'compliant' }),
      expect.objectContaining({ technologyId: 'lombok', classification: 'compliant' })
    ]));
  });

  it('never executes Maven for a POM path outside the repository', async () => {
    const runner = new EffectivePomRunner(effectivePom([]));
    const evidence = unresolvedEvidence(
      ['org.springframework.boot:spring-boot-starter-web'],
      '../outside/pom.xml'
    );

    const enriched = await enrichS007WithMavenEffectivePom(repoPath, evidence, run(runner), runner);

    expect(enriched).toEqual(evidence);
    expect(runner.requests).toHaveLength(0);
  });
});

function unresolvedEvidence(coordinates: string[], sourcePath = 'pom.xml'): S007TechnologyEvidenceResult {
  return {
    observations: coordinates.map(coordinate => {
      const [groupId, artifactId] = coordinate.split(':');
      const technology = groupId === 'org.projectlombok'
        ? { id: 'lombok', displayName: 'Lombok', technologyType: 'library' as const }
        : groupId === 'org.grails' || groupId === 'org.grails.plugins'
          ? { id: 'grails', displayName: 'Grails', technologyType: 'framework' as const }
          : groupId === 'io.vertx'
            ? { id: 'vertx', displayName: 'Eclipse Vert.x', technologyType: 'framework' as const }
            : { id: 'spring-boot', displayName: 'Spring Boot', technologyType: 'framework' as const };
      return {
        identityCandidates: [technology.id, coordinate, groupId],
        displayName: technology.displayName,
        ecosystem: 'java' as const,
        technologyType: technology.technologyType,
        evidenceKind: 'dependency-declaration' as const,
        sourcePath,
        sourceDetail: coordinate,
        mavenDependency: {
          groupId,
          artifactId,
          type: 'jar',
          classifier: ''
        },
        repositoryDeclared: true as const,
        confidence: 'partial' as const,
        provenance: 'repository-static' as const
      };
    }),
    diagnostics: [
      { code: 'maven_remote_parent', message: 'remote parent', material: true, path: sourcePath },
      ...coordinates.map(coordinate => ({
        code: 'version_unresolved' as const,
        message: `No version for ${coordinate} is set in the repository; it probably comes from a parent POM or BOM.`,
        material: true,
        path: sourcePath,
        subject: coordinate,
        listHeading: 'Versions not set in the repository (probably managed by a parent POM or BOM)'
      }))
    ],
    manifestPaths: [sourcePath],
    complete: false
  };
}

function effectivePom(
  dependencies: string[],
  artifactId = 'mod-example',
  version = '1.0.0',
  groupId = 'org.folio'
): string {
  return `
    <project>
      <modelVersion>4.0.0</modelVersion>
      ${groupId ? `<groupId>${groupId}</groupId>` : ''}<artifactId>${artifactId}</artifactId><version>${version}</version>
      <dependencies>${dependencies.join('')}</dependencies>
    </project>
  `;
}

function effectivePomWithParentIdentity(missing: 'groupId' | 'version'): string {
  return `
    <project>
      <modelVersion>4.0.0</modelVersion>
      <parent>
        <groupId>org.folio</groupId><artifactId>folio-parent</artifactId><version>1.0.0</version>
      </parent>
      ${missing === 'groupId' ? '' : '<groupId>org.folio</groupId>'}
      <artifactId>mod-example</artifactId>
      ${missing === 'version' ? '' : '<version>1.0.0</version>'}
      <dependencies>${dependency('org.projectlombok', 'lombok', '1.18.48')}</dependencies>
    </project>
  `;
}

function dependency(groupId: string, artifactId: string, version: string, type?: string): string {
  return `<dependency><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version>${type ? `<type>${type}</type>` : ''}</dependency>`;
}

function run(commandRunner: CommandRunner): EvaluationRun {
  return {
    repositoryPath: '',
    language: 'java',
    selectedCriteria: ['S007'],
    s008CatalogChannel: 'official',
    commandRunner,
    artifacts: {},
    commandObservations: new Map(),
    getOrCreateArtifact: async () => {
      throw new Error('not used');
    }
  };
}
