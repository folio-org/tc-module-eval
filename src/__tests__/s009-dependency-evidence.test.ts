import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { collectS009DependencyEvidence } from '../utils/s009-dependency-evidence';

describe('S009 dependency evidence', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 's009-evidence-'));
  });

  afterEach(async () => {
    await fs.remove(repo);
  });

  it('collects included Maven scopes from every module and profile while excluding build metadata and tests', async () => {
    await fs.outputFile(path.join(repo, 'pom.xml'), `
      <project>
        <properties><folio.group>org.folio</folio.group></properties>
        <parent><groupId>org.folio</groupId><artifactId>parent</artifactId><version>1</version></parent>
        <dependencyManagement><dependencies>
          <dependency><groupId>org.folio</groupId><artifactId>managed-only</artifactId><version>1</version></dependency>
        </dependencies></dependencyManagement>
        <dependencies>
          <dependency><groupId>\${folio.group}</groupId><artifactId>compile-lib</artifactId><version>1</version></dependency>
          <dependency><groupId>org.folio</groupId><artifactId>runtime-lib</artifactId><version>2</version><scope>runtime</scope></dependency>
          <dependency><groupId>org.folio</groupId><artifactId>provided-lib</artifactId><scope>provided</scope></dependency>
          <dependency><groupId>org.folio</groupId><artifactId>test-lib</artifactId><scope>test</scope></dependency>
        </dependencies>
        <profiles><profile><id>later</id><properties><profile.group>org.folio</profile.group></properties><dependencies>
          <dependency><groupId>\${profile.group}</groupId><artifactId>profile-lib</artifactId><version>3</version></dependency>
        </dependencies></profile></profiles>
        <build><plugins><plugin><dependencies>
          <dependency><groupId>org.folio</groupId><artifactId>plugin-lib</artifactId><version>1</version></dependency>
        </dependencies></plugin></plugins></build>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'child/pom.xml'), `
      <project><dependencies>
        <dependency><groupId>org.folio</groupId><artifactId>child-lib</artifactId><version>4</version></dependency>
      </dependencies></project>
    `);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(true);
    expect(evidence.projectFiles).toEqual(['child/pom.xml', 'pom.xml']);
    expect(evidence.observations.map(item => `${item.coordinate}:${item.scope}`).sort()).toEqual([
      'org.folio:child-lib:compile',
      'org.folio:compile-lib:compile',
      'org.folio:profile-lib:compile',
      'org.folio:provided-lib:provided',
      'org.folio:runtime-lib:runtime'
    ]);
  });

  it('collects supported Gradle configurations from root and subprojects without executing build logic', async () => {
    await fs.outputFile(path.join(repo, 'build.gradle'), `
      dependencies {
        implementation 'org.folio:root-lib:1.0.0'
        if (providers.gradleProperty('feature').isPresent()) {
          runtimeOnly("org.folio:conditional-lib:\${folioVersion}")
        }
        testImplementation 'org.folio:test-lib:1.0.0'
        // implementation 'org.folio:commented-lib:1.0.0'
      }
    `);
    await fs.outputFile(path.join(repo, 'feature/build.gradle.kts'), `
      dependencies {
        api(group = "org.folio", name = "api-lib", version = "1.0.0")
        compileOnly("org.folio:compile-lib:2.0.0")
      }
    `);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(true);
    expect(evidence.observations.map(item => item.coordinate).sort()).toEqual([
      'org.folio:api-lib',
      'org.folio:compile-lib',
      'org.folio:conditional-lib',
      'org.folio:root-lib'
    ]);
  });

  it('does not mistake Gradle strings, configuration references, or known local helpers for unresolved dependencies', async () => {
    await fs.outputFile(path.join(repo, 'settings.gradle'), `rootProject.name = 'mod-foo-api'`);
    await fs.outputFile(path.join(repo, 'build.gradle.kts'), `
      val text = "implementation api runtimeOnly compileOnly"
      configurations.implementation {
        exclude(group = "example")
      }
      dependencies {
        implementation(project(":mod-foo-api"))
        implementation(kotlin("stdlib"))
        implementation(files("local.jar"))
      }
    `);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(true);
    expect(evidence.observations).toEqual([]);
    expect(evidence.diagnostics).toEqual([]);
  });

  it('retains unresolved Gradle declarations and distinct declaration evidence', async () => {
    await fs.outputFile(path.join(repo, 'build.gradle'), `dependencies {
      implementation(libs.folio.core)
      add("runtimeOnly", libs.folio.runtime)
      api "org.folio:repeated:1"
      api "org.folio:repeated:1"
    }`);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(false);
    expect(evidence.diagnostics.filter(item => item.code === 'gradle_dependency_unresolved')).toHaveLength(2);
    expect(evidence.observations.filter(item => item.coordinate === 'org.folio:repeated')).toHaveLength(2);
    expect(new Set(evidence.observations.map(item => item.sourceField)).size).toBe(2);
  });

  it('collects every comma-separated Gradle dependency argument', async () => {
    await fs.outputFile(path.join(repo, 'build.gradle'), `dependencies {
      implementation 'com.google.guava:guava:33.0.0-jre', 'org.folio:folio-unapproved-lib:1.0.0'
      runtimeOnly('com.example:ordinary:1', 'org.folio:second-unapproved:2')
    }`);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(true);
    expect(evidence.observations.map(item => item.coordinate)).toEqual([
      'org.folio:folio-unapproved-lib',
      'org.folio:second-unapproved'
    ]);
  });

  it('ignores trailing Gradle dependency configuration closures', async () => {
    await fs.outputFile(path.join(repo, 'build.gradle'), `dependencies {
      implementation 'org.folio:edge-common:5.1.1', { transitive = false }
      runtimeOnly('org.folio:folio-s3-client:3.0.2') { transitive = false }
    }`);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(true);
    expect(evidence.diagnostics).toEqual([]);
    expect(evidence.observations.map(item => item.coordinate)).toEqual([
      'org.folio:edge-common',
      'org.folio:folio-s3-client'
    ]);
  });

  it('ignores a dynamic Gradle artifact when a literal group proves it is outside FOLIO', async () => {
    await fs.outputFile(path.join(repo, 'build.gradle'), `dependencies {
      implementation group: 'com.example', name: externalArtifact, version: externalVersion
    }`);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(true);
    expect(evidence.observations).toEqual([]);
  });

  it('collects production npm declarations from declared workspaces and normalizes npm aliases', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), {
      name: 'root',
      workspaces: ['packages/*'],
      dependencies: { '@folio/root-lib': '^1.0.0', alias: 'npm:@folio/aliased-lib@^2.0.0' },
      optionalDependencies: { '@folio/optional-lib': '3.0.0' },
      peerDependencies: { '@folio/peer-lib': '^4' },
      devDependencies: { '@folio/dev-lib': '1.0.0' }
    });
    await fs.outputJson(path.join(repo, 'packages/a/package.json'), {
      name: '@folio/a',
      dependencies: { '@folio/workspace-lib': '5.0.0' },
      bundledDependencies: ['@folio/workspace-lib']
    });
    await fs.outputJson(path.join(repo, 'examples/not-a-workspace/package.json'), {
      dependencies: { '@folio/example-lib': '1.0.0' }
    });

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(true);
    expect(evidence.projectFiles).toEqual(['package.json', 'packages/a/package.json']);
    expect([...new Set(evidence.observations.map(item => item.coordinate))].sort()).toEqual([
      '@folio/aliased-lib',
      '@folio/optional-lib',
      '@folio/peer-lib',
      '@folio/root-lib',
      '@folio/workspace-lib'
    ]);
  });

  it('excludes compatible local npm workspaces but retains incompatible and explicitly external references', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), {
      name: 'root',
      workspaces: ['packages/*'],
      dependencies: {
        '@folio/local-compatible': '^1.0.0',
        '@folio/local-incompatible': '^2.0.0',
        externalAlias: 'npm:@folio/local-compatible@^1.0.0'
      }
    });
    await fs.outputJson(path.join(repo, 'packages/compatible/package.json'), {
      name: '@folio/local-compatible', version: '1.2.0'
    });
    await fs.outputJson(path.join(repo, 'packages/incompatible/package.json'), {
      name: '@folio/local-incompatible', version: '1.2.0'
    });

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.observations.map(item => item.coordinate).sort()).toEqual([
      '@folio/local-compatible',
      '@folio/local-incompatible'
    ]);
    expect(evidence.observations.find(item => item.coordinate === '@folio/local-compatible')?.sourceField)
      .toBe('dependencies.externalAlias');
  });

  it('resolves local Maven parents, aliases, managed scopes, and sibling module identities', async () => {
    await fs.outputFile(path.join(repo, 'pom.xml'), `
      <project>
        <modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>root</artifactId><version>1.2.0</version>
        <properties><managed.scope>test</managed.scope></properties>
        <dependencyManagement><dependencies>
          <dependency>
            <groupId>org.folio</groupId><artifactId>managed-test</artifactId>
            <version>1</version><scope>\${managed.scope}</scope>
          </dependency>
          <dependency>
            <groupId>org.folio</groupId><artifactId>managed-explicit</artifactId>
            <version>1</version><scope>test</scope>
          </dependency>
          <dependency>
            <groupId>org.folio</groupId><artifactId>managed-test-jar</artifactId>
            <version>1</version><type>test-jar</type><scope>test</scope>
          </dependency>
        </dependencies></dependencyManagement>
        <modules><module>client</module><module>server</module></modules>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'client/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.folio</groupId><artifactId>root</artifactId><version>1.2.0</version></parent>
        <artifactId>mod-foo-client</artifactId>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'server/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.folio</groupId><artifactId>root</artifactId><version>1.2.0</version></parent>
        <artifactId>mod-foo-server</artifactId>
        <dependencies>
          <dependency><groupId>\${project.parent.groupId}</groupId><artifactId>mod-foo-client</artifactId><version>\${project.version}</version></dependency>
          <dependency><groupId>org.folio</groupId><artifactId>managed-test</artifactId></dependency>
          <dependency><groupId>org.folio</groupId><artifactId>managed-explicit</artifactId><scope>compile</scope></dependency>
          <dependency><groupId>org.folio</groupId><artifactId>managed-test-jar</artifactId></dependency>
          <dependency><groupId>org.folio</groupId><artifactId>external</artifactId><version>3</version></dependency>
        </dependencies>
      </project>
    `);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(true);
    expect(evidence.observations.map(item => item.coordinate)).toEqual([
      'org.folio:external',
      'org.folio:managed-explicit',
      'org.folio:managed-test-jar'
    ]);
  });

  it('does not let undeclared Maven fixture projects establish locality and marks version ranges ambiguous', async () => {
    await fs.outputFile(path.join(repo, 'pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>root</artifactId><version>1.0.0</version>
        <modules><module>client</module><module>server</module></modules>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'client/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.folio</groupId><artifactId>root</artifactId><version>1.0.0</version></parent>
        <artifactId>client</artifactId>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'server/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.folio</groupId><artifactId>root</artifactId><version>1.0.0</version></parent>
        <artifactId>server</artifactId>
        <dependencies>
          <dependency><groupId>org.folio</groupId><artifactId>client</artifactId><version>[1,2)</version></dependency>
          <dependency><groupId>org.folio</groupId><artifactId>fixture</artifactId><version>1.0.0</version></dependency>
        </dependencies>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'examples/fixture/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>fixture</artifactId><version>1.0.0</version>
      </project>
    `);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ coordinate: 'org.folio:client', locality: 'ambiguous' }),
      expect.objectContaining({ coordinate: 'org.folio:fixture', locality: undefined })
    ]));
  });

  it('marks a sibling Maven dependency ambiguous when the local module version is unresolved', async () => {
    await fs.outputFile(path.join(repo, 'pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>root</artifactId><version>\${revision}</version>
        <modules><module>client</module><module>server</module></modules>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'client/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.folio</groupId><artifactId>root</artifactId><version>\${revision}</version></parent>
        <artifactId>client</artifactId>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'server/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <parent><groupId>org.folio</groupId><artifactId>root</artifactId><version>\${revision}</version></parent>
        <artifactId>server</artifactId>
        <dependencies>
          <dependency><groupId>org.folio</groupId><artifactId>client</artifactId><version>\${revision}</version></dependency>
        </dependencies>
      </project>
    `);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.observations).toEqual([
      expect.objectContaining({ coordinate: 'org.folio:client', locality: 'ambiguous' })
    ]);
  });

  it('resolves a Maven parent relativePath that names a directory', async () => {
    await fs.outputFile(path.join(repo, 'pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>root</artifactId><version>1</version>
        <modules><module>parent</module><module>child</module></modules>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'parent/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <groupId>org.folio</groupId><artifactId>local-parent</artifactId><version>1</version>
        <dependencyManagement><dependencies><dependency>
          <groupId>org.folio</groupId><artifactId>test-helper</artifactId><version>1</version><scope>test</scope>
        </dependency></dependencies></dependencyManagement>
      </project>
    `);
    await fs.outputFile(path.join(repo, 'child/pom.xml'), `
      <project><modelVersion>4.0.0</modelVersion>
        <parent>
          <groupId>org.folio</groupId><artifactId>local-parent</artifactId><version>1</version>
          <relativePath>../parent</relativePath>
        </parent>
        <artifactId>child</artifactId>
        <dependencies><dependency>
          <groupId>org.folio</groupId><artifactId>test-helper</artifactId>
        </dependency></dependencies>
      </project>
    `);

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.complete).toBe(true);
    expect(evidence.observations).toEqual([]);
  });

  it('always includes the root package manifest even when recursive discovery is capped', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), {
      dependencies: { '@folio/not-approved': '1.0.0' }
    });
    for (let index = 0; index < 129; index += 1) {
      await fs.outputJson(path.join(repo, `a-${String(index).padStart(3, '0')}/package.json`), { private: true });
    }

    const evidence = await collectS009DependencyEvidence(repo);

    expect(evidence.hasDependencyProject).toBe(true);
    expect(evidence.complete).toBe(false);
    expect(evidence.projectFiles).toContain('package.json');
    expect(evidence.observations).toEqual([
      expect.objectContaining({ coordinate: '@folio/not-approved' })
    ]);
    expect(evidence.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'manifest_limit', material: true })
    ]));
  });

  it('marks unresolved production dependency syntax incomplete and distinguishes no project', async () => {
    await fs.outputFile(path.join(repo, 'build.gradle'), `dependencies {
      implementation 'com.example:known:1'; implementation(libs.folio.core)
      runtimeOnly "\${folioGroup}:dynamic-group:1"
    }`);
    const unresolved = await collectS009DependencyEvidence(repo);
    expect(unresolved.hasDependencyProject).toBe(true);
    expect(unresolved.complete).toBe(false);
    expect(unresolved.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gradle_dependency_unresolved', material: true }),
      expect.objectContaining({ code: 'gradle_coordinate_unresolved', material: true })
    ]));

    await fs.remove(path.join(repo, 'build.gradle'));
    const empty = await collectS009DependencyEvidence(repo);
    expect(empty.hasDependencyProject).toBe(false);
    expect(empty.complete).toBe(true);
  });

  it('does not treat lockfile-only transitive packages as direct dependencies or require a lockfile', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: { 'ordinary-package': '^1.0.0' } });
    await fs.writeJson(path.join(repo, 'package-lock.json'), {
      packages: { 'node_modules/@folio/transitive-only': { version: '1.0.0' } }
    });

    const withLock = await collectS009DependencyEvidence(repo);
    expect(withLock.complete).toBe(true);
    expect(withLock.observations).toEqual([]);

    await fs.remove(path.join(repo, 'package-lock.json'));
    const withoutLock = await collectS009DependencyEvidence(repo);
    expect(withoutLock.complete).toBe(true);
    expect(withoutLock.observations).toEqual([]);
  });
});
