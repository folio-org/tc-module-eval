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
