import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { collectS007TechnologyEvidence } from '../utils/s007-technology-evidence';

describe('S007 static technology evidence', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 's007-evidence-'));
  });

  afterEach(async () => {
    await fs.remove(repoPath);
  });

  it('resolves bounded local Maven evidence and reports remote resolution gaps', async () => {
    await write('pom.xml', `
      <project>
        <parent>
          <groupId>org.example</groupId><artifactId>parent</artifactId><version>1</version>
          <relativePath>parent/pom.xml</relativePath>
        </parent>
        <properties><java.version>21</java.version><vertx.version>5.0.2</vertx.version></properties>
        <dependencyManagement><dependencies>
          <dependency><groupId>org.folio</groupId><artifactId>folio-spring-base</artifactId><version>8.2.1</version></dependency>
          <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId><version>3.5.1</version><type>pom</type><scope>import</scope></dependency>
        </dependencies></dependencyManagement>
        <dependencies>
          <dependency><groupId>org.folio</groupId><artifactId>folio-spring-base</artifactId></dependency>
          <dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>\${vertx.version}</version></dependency>
          <dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><version>1.18.32</version></dependency>
        </dependencies>
        <modules><module>child</module></modules>
      </project>
    `);
    await write('parent/pom.xml', `
      <project>
        <properties><spring.version>7.0.1</spring.version></properties>
        <dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId><version>\${spring.version}</version></dependency></dependencies>
      </project>
    `);
    await write('child/pom.xml', `
      <project><dependencies><dependency><groupId>org.keycloak</groupId><artifactId>keycloak-admin-client</artifactId><version>26.1.0</version></dependency></dependencies></project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({ declaredVersion: '21', sourcePath: 'pom.xml' });
    expect(find(result, 'folio-spring-base')).toMatchObject({ declaredVersion: '8.2.1', sourcePath: 'pom.xml' });
    expect(find(result, 'vertx')).toMatchObject({ declaredVersion: '5.0.2', sourcePath: 'pom.xml' });
    expect(find(result, 'spring-framework')).toMatchObject({ declaredVersion: '7.0.1', sourcePath: 'parent/pom.xml' });
    expect(find(result, 'keycloak-admin-client')).toMatchObject({ declaredVersion: '26.1.0', sourcePath: 'child/pom.xml' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'maven_imported_bom', material: true, path: 'pom.xml' })
    ]));
    expect(result.complete).toBe(false);
  });

  it('keeps inherited Maven declarations visible when a remote parent is unavailable', async () => {
    await write('pom.xml', `
      <project>
        <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.5.0</version><relativePath /></parent>
        <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'spring-boot')).toMatchObject({ declaredVersion: undefined, sourcePath: 'pom.xml' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'maven_remote_parent', material: true }),
      expect.objectContaining({ code: 'version_unresolved', material: true })
    ]));
  });

  it('reads literal Groovy and Kotlin Gradle evidence while flagging dynamic coverage', async () => {
    await write('settings.gradle', "include 'service', '../outside'\n");
    await write('gradle.properties', 'lombokVersion=1.18.32\n');
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      plugins { id 'org.springframework.boot' version '4.0.1' }
      dependencies {
        implementation 'org.projectlombok:lombok:' + lombokVersion
        implementation libs.vertx.core
        implementation 'io.micronaut:micronaut-runtime:4.6.0'
        implementation 'io.helidon.microprofile:helidon-microprofile:4.1.0'
      }
    `);
    await write('service/build.gradle.kts', `
      plugins { id("io.quarkus") version "3.27.1" }
      java { sourceCompatibility = JavaVersion.VERSION_21 }
      dependencies { implementation("io.vertx:vertx-core:5.0.3") }
    `);
    await write('gradle/libs.versions.toml', '[versions]\nvertx = "5.0.3"\n');

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({ declaredVersion: '21', sourcePath: 'build.gradle' });
    expect(find(result, 'spring-boot')).toMatchObject({ declaredVersion: '4.0.1', sourcePath: 'build.gradle' });
    expect(find(result, 'quarkus')).toMatchObject({ declaredVersion: '3.27.1', sourcePath: 'service/build.gradle.kts' });
    expect(find(result, 'vertx')).toMatchObject({ declaredVersion: '5.0.3', sourcePath: 'service/build.gradle.kts' });
    expect(find(result, 'micronaut')).toMatchObject({ unlistedFrameworkCandidate: true });
    expect(find(result, 'helidon')).toMatchObject({ unlistedFrameworkCandidate: true });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gradle_version_catalog', material: true }),
      expect.objectContaining({ code: 'local_module_outside_repository', material: true })
    ]));
  });

  it('resolves relevant JavaScript declarations from Yarn Classic and ignores ordinary libraries', async () => {
    await writeJson('package.json', {
      dependencies: {
        '@folio/stripes-core': '^10.1.0',
        react: '^18.2.0',
        lodash: '^4.17.21',
        express: '^4.18.0',
        vue: '^3.4.0'
      },
      devDependencies: {
        typescript: '^5.4.0',
        '@angular/core': '^18.0.0',
        svelte: '^5.0.0',
        '@nestjs/core': '^10.0.0'
      }
    });
    await write('yarn.lock', `
      # yarn lockfile v1

      "@folio/stripes-core@^10.1.0":
        version "10.1.2"

      "react@^18.2.0", "react@>=18":
        version "18.2.0"

      "express@^4.18.0":
        version "4.18.3"

      "vue@^3.4.0":
        version "3.4.38"

      "@angular/core@^18.0.0":
        version "18.2.1"

      "svelte@^5.0.0":
        version "5.1.0"

      "@nestjs/core@^10.0.0":
        version "10.4.1"
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'javascript');

    expect(find(result, 'typescript')).toBeDefined();
    expect(find(result, 'stripes')).toMatchObject({ declaredVersion: '^10.1.0', resolvedVersion: '10.1.2' });
    expect(find(result, 'react')).toMatchObject({ declaredVersion: '^18.2.0', resolvedVersion: '18.2.0' });
    for (const id of ['express', 'vue', 'angular', 'svelte', 'nestjs']) {
      expect(find(result, id)).toMatchObject({ unlistedFrameworkCandidate: true });
    }
    expect(result.observations.some(observation => observation.identityCandidates.includes('lodash'))).toBe(false);
    expect(result.complete).toBe(true);
  });

  it.each([
    ['missing', undefined, 'yarn_lock_missing'],
    ['berry', '__metadata:\n  version: 8\n', 'yarn_lock_unsupported'],
    ['malformed', 'not: [valid', 'yarn_lock_malformed']
  ])('retains declarations when the Yarn lockfile is %s', async (_name, lockfile, code) => {
    await writeJson('package.json', { dependencies: { react: '^18.0.0' } });
    if (lockfile !== undefined) {
      await write('yarn.lock', lockfile);
    }

    const result = await collectS007TechnologyEvidence(repoPath, 'javascript');

    expect(find(result, 'react')).toMatchObject({ declaredVersion: '^18.0.0', resolvedVersion: undefined });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code, material: true })
    ]));
  });

  it('reports insufficient evidence and leaves the repository byte-for-byte unchanged', async () => {
    await write('README.md', 'nothing relevant\n');
    const before = await snapshot(repoPath);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'insufficient_evidence', material: true })
    ]));
    expect(await snapshot(repoPath)).toEqual(before);
  });

  it('retains conflicting versions without selecting one confidently', async () => {
    await write('pom.xml', '<project><modules><module>a</module><module>b</module></modules></project>');
    await write('a/pom.xml', '<project><dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>4.5.0</version></dependency></dependencies></project>');
    await write('b/pom.xml', '<project><dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>5.0.0</version></dependency></dependencies></project>');

    const result = await collectS007TechnologyEvidence(repoPath, 'java');
    const vertx = result.observations.filter(observation => observation.identityCandidates.includes('vertx'));

    expect(vertx).toHaveLength(2);
    expect(vertx.every(observation => observation.conflictPaths?.length === 2)).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'conflicting_versions', material: true })
    ]));
  });

  async function write(relativePath: string, content: string): Promise<void> {
    const target = path.join(repoPath, relativePath);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, dedent(content));
  }

  async function writeJson(relativePath: string, value: unknown): Promise<void> {
    const target = path.join(repoPath, relativePath);
    await fs.ensureDir(path.dirname(target));
    await fs.writeJson(target, value, { spaces: 2 });
  }
});

function find(result: { observations: Array<{ identityCandidates: string[] }> }, id: string): any {
  return result.observations.find(observation => observation.identityCandidates.includes(id));
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory)) {
      const fullPath = path.join(directory, entry);
      const stat = await fs.lstat(fullPath);
      if (stat.isDirectory()) {
        await walk(fullPath);
      } else if (stat.isFile()) {
        const relative = path.relative(root, fullPath).split(path.sep).join('/');
        result[relative] = crypto.createHash('sha256').update(await fs.readFile(fullPath)).digest('hex');
      }
    }
  }
  await walk(root);
  return result;
}

function dedent(content: string): string {
  const lines = content.replace(/^\n/, '').split('\n');
  const indentation = lines
    .filter(line => line.trim())
    .reduce((minimum, line) => Math.min(minimum, line.match(/^\s*/)?.[0].length ?? 0), Infinity);
  return lines.map(line => line.slice(Number.isFinite(indentation) ? indentation : 0)).join('\n');
}
