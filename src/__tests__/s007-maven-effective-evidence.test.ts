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
        message: expect.stringContaining('inherited S007-relevant dependency io.vertx:vertx-core')
      })
    ]));
    expect(enriched.complete).toBe(false);
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
      message: 'The org.grails.plugins:database-migration artifact proves Grails presence but not the Grails framework version.',
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
        message: `Version for ${coordinate} could not be resolved from local Maven metadata.`,
        material: true,
        path: sourcePath
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
