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
    expect(find(result, 'folio-spring-base')).toMatchObject({ declaredVersion: '8.2.1', sourcePath: 'pom.xml', versionSourcePath: 'pom.xml' });
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

  it('reuses resolved Maven parent properties across sibling modules', async () => {
    await write('pom.xml', `
      <project><modules><module>first</module><module>second</module></modules></project>
    `);
    await write('shared-parent/pom.xml', `
      <project><properties>
        <java.version>21</java.version>
        <lombok.version>1.18.32</lombok.version>
      </properties></project>
    `);
    for (const moduleName of ['first', 'second']) {
      await write(`${moduleName}/pom.xml`, `
        <project>
          <parent>
            <groupId>org.example</groupId><artifactId>shared-parent</artifactId><version>1</version>
            <relativePath>../shared-parent/pom.xml</relativePath>
          </parent>
          <dependencies><dependency>
            <groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><version>\${lombok.version}</version>
          </dependency></dependencies>
        </project>
      `);
    }

    const result = await collectS007TechnologyEvidence(repoPath, 'java');
    const secondLombok = result.observations.find(observation =>
      observation.identityCandidates.includes('lombok') && observation.sourcePath === 'second/pom.xml'
    );

    expect(secondLombok).toMatchObject({ declaredVersion: '1.18.32', confidence: 'confident' });
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'version_unresolved', path: 'second/pom.xml' })
    ]));
  });

  it('re-resolves inherited Maven dependency management with child property overrides', async () => {
    await write('pom.xml', `
      <project>
        <properties><java.version>21</java.version><vertx.version>4.5.0</vertx.version></properties>
        <dependencyManagement><dependencies><dependency>
          <groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>\${vertx.version}</version>
        </dependency></dependencies></dependencyManagement>
        <modules><module>child</module></modules>
      </project>
    `);
    await write('child/pom.xml', `
      <project>
        <parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version></parent>
        <properties><vertx.version>5.0.1</vertx.version></properties>
        <dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId></dependency></dependencies>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');
    const childVertx = result.observations.find(observation =>
      observation.identityCandidates.includes('vertx') && observation.sourcePath === 'child/pom.xml'
    );

    expect(childVertx).toMatchObject({ declaredVersion: '5.0.1', confidence: 'confident' });
  });

  it('resolves local Maven properties in dependency coordinates', async () => {
    await write('pom.xml', `
      <project>
        <properties><java.version>21</java.version><folio.group>org.folio</folio.group></properties>
        <dependencies>
          <dependency><groupId>\${folio.group}</groupId><artifactId>raml-module-builder</artifactId><version>34.0.0</version></dependency>
        </dependencies>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'raml-module-builder')).toMatchObject({ declaredVersion: '34.0.0' });
    expect(result.complete).toBe(true);
  });

  it('reads the Java version from Maven compiler-plugin configuration', async () => {
    await write('pom.xml', `
      <project>
        <properties><compiler.java>17</compiler.java></properties>
        <build><plugins><plugin>
          <groupId>org.apache.maven.plugins</groupId>
          <artifactId>maven-compiler-plugin</artifactId>
          <configuration><release>\${compiler.java}</release></configuration>
        </plugin></plugins></build>
        <dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>5.0.2</version></dependency></dependencies>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({
      declaredVersion: '17',
      sourceDetail: 'maven-compiler-plugin.configuration.release',
      versionSourcePath: 'pom.xml'
    });
  });

  it('does not claim complete coverage for Maven compiler pluginManagement', async () => {
    await write('pom.xml', `
      <project>
        <properties><java.version>21</java.version></properties>
        <build>
          <pluginManagement><plugins><plugin>
            <groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId>
            <configuration><release>17</release></configuration>
          </plugin></plugins></pluginManagement>
          <plugins><plugin><artifactId>maven-compiler-plugin</artifactId></plugin></plugins>
        </build>
        <dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>5.0.1</version></dependency></dependencies>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({ declaredVersion: '17' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'version_unresolved',
        material: true,
        message: expect.stringContaining('pluginManagement')
      })
    ]));
    expect(result.complete).toBe(false);
  });

  it('marks conflicting Maven compiler execution settings incomplete', async () => {
    await write('pom.xml', `
      <project>
        <build><plugins><plugin>
          <artifactId>maven-compiler-plugin</artifactId>
          <configuration><release>21</release></configuration>
          <executions><execution><id>default-compile</id><configuration><release>17</release></configuration></execution></executions>
        </plugin></plugins></build>
        <dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>5.0.1</version></dependency></dependencies>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({ declaredVersion: '17' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'version_unresolved',
        material: true,
        message: expect.stringContaining('Conflicting Maven compiler settings')
      })
    ]));
    expect(result.complete).toBe(false);
  });

  it('resolves chained Maven properties transitively', async () => {
    await write('pom.xml', `
      <project>
        <properties>
          <java.version>21</java.version>
          <revision>5.0.2</revision>
          <vertx.version>\${revision}</vertx.version>
        </properties>
        <dependencies><dependency>
          <groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>\${vertx.version}</version>
        </dependency></dependencies>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toMatchObject({
      declaredVersion: '5.0.2',
      confidence: 'confident',
      versionSourcePath: 'pom.xml'
    });
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'version_unresolved' })
    ]));
    expect(result.complete).toBe(true);
  });

  it('marks cyclic Maven properties unresolved without exposing a placeholder as a version', async () => {
    await write('pom.xml', `
      <project>
        <properties>
          <java.version>21</java.version>
          <vertx.version>\${revision}</vertx.version>
          <revision>\${vertx.version}</revision>
        </properties>
        <dependencies><dependency>
          <groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>\${vertx.version}</version>
        </dependency></dependencies>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toMatchObject({ declaredVersion: undefined, confidence: 'partial' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'version_unresolved', material: true, path: 'pom.xml' })
    ]));
    expect(result.complete).toBe(false);
  });

  it('does not replace an explicit unresolved Maven version with dependency management', async () => {
    await write('pom.xml', `
      <project>
        <properties><java.version>21</java.version></properties>
        <dependencyManagement><dependencies><dependency>
          <groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>5.0.2</version>
        </dependency></dependencies></dependencyManagement>
        <dependencies><dependency>
          <groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>\${missing.version}</version>
        </dependency></dependencies>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toMatchObject({ declaredVersion: undefined, confidence: 'partial' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'version_unresolved', material: true, path: 'pom.xml' })
    ]));
    expect(result.complete).toBe(false);
  });

  it('marks Maven profiles as incomplete static coverage', async () => {
    await write('pom.xml', `
      <project>
        <properties><java.version>21</java.version></properties>
        <dependencies><dependency><groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>5.0.2</version></dependency></dependencies>
        <profiles><profile><id>legacy</id><dependencies><dependency>
          <groupId>io.vertx</groupId><artifactId>vertx-web</artifactId><version>4.5.0</version>
        </dependency></dependencies></profile></profiles>
      </project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'version_unresolved',
        material: true,
        path: 'pom.xml',
        message: expect.stringContaining('Maven profiles')
      })
    ]));
    expect(result.complete).toBe(false);
  });

  it('marks Maven coverage incomplete when relevant evidence has no Java version', async () => {
    await write('pom.xml', `
      <project><dependencies><dependency>
        <groupId>io.vertx</groupId><artifactId>vertx-core</artifactId><version>5.0.2</version>
      </dependency></dependencies></project>
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toBeDefined();
    expect(find(result, 'java')).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'version_unresolved',
        path: 'pom.xml',
        message: expect.stringContaining('Maven Java version')
      })
    ]));
    expect(result.complete).toBe(false);
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
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'version_unresolved', path: 'build.gradle' })
    ]));
  });

  it('resolves local Gradle properties interpolated in dependency coordinates', async () => {
    await write('build.gradle', `
      def folioGroup = "org.folio"
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      dependencies { implementation "\${folioGroup}:raml-module-builder:34.0.0" }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'raml-module-builder')).toMatchObject({ declaredVersion: '34.0.0' });
    expect(result.complete).toBe(true);
  });

  it('marks unresolved Gradle coordinate interpolation as incomplete', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      dependencies { implementation "\${folioGroup}:raml-module-builder:34.0.0" }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'raml-module-builder')).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gradle_dynamic_expression', material: true, path: 'build.gradle' })
    ]));
    expect(result.complete).toBe(false);
  });

  it('does not interpolate Groovy single-quoted dependency coordinates', async () => {
    await write('build.gradle', `
      def folioGroup = "org.folio"
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      dependencies { implementation '\${folioGroup}:raml-module-builder:34.0.0' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'raml-module-builder')).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gradle_dynamic_expression', material: true, path: 'build.gradle' })
    ]));
    expect(result.complete).toBe(false);
  });

  it('ignores composite builds and commented-out Gradle includes', async () => {
    await write('settings.gradle', `
      includeBuild('../shared-lib')
      include('service')
      // include('old-module')
      /*
       * include('retired-module')
       */
    `);
    await write('build.gradle', 'java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n');
    await write('service/build.gradle', `
      dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toMatchObject({ sourcePath: 'service/build.gradle' });
    expect(result.manifestPaths).toEqual(expect.arrayContaining(['build.gradle', 'service/build.gradle', 'settings.gradle']));
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'local_module_missing' }),
      expect.objectContaining({ code: 'local_module_outside_repository' })
    ]));
  });

  it('ignores commented Gradle properties, dependencies, plugins, and dynamic references', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      def vertxVersion = '5.0.3'
      // def vertxVersion = '4.5.0'
      plugins { id 'org.springframework.boot' version '4.0.1' }
      dependencies {
        implementation 'io.vertx:vertx-core:' + vertxVersion
        // implementation 'io.vertx:vertx-core:4.5.0'
      }
      /*
        plugins { id 'org.springframework.boot' version '3.5.0' }
        dependencies { implementation libs.vertx.core }
      */
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toMatchObject({ declaredVersion: '5.0.3', confidence: 'confident' });
    expect(find(result, 'spring-boot')).toMatchObject({ declaredVersion: '4.0.1', confidence: 'confident' });
    expect(result.observations.filter(item => item.identityCandidates.includes('vertx'))).toHaveLength(1);
    expect(result.observations.filter(item => item.identityCandidates.includes('spring-boot'))).toHaveLength(1);
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'conflicting_versions' }),
      expect.objectContaining({ code: 'gradle_dynamic_expression' })
    ]));
  });

  it('resolves Gradle plugin versions from local properties', async () => {
    await write('gradle.properties', 'grailsVersion=7.0.0\n');
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
      plugins { id 'org.grails.grails-web' version grailsVersion }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'grails')).toMatchObject({
      declaredVersion: '7.0.0',
      sourceDetail: 'plugin org.grails.grails-web',
      confidence: 'confident'
    });
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gradle_dynamic_expression' })
    ]));
    expect(result.complete).toBe(true);
  });

  it('retains unresolved Gradle plugin declarations as incomplete evidence', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      plugins { id 'org.grails.grails-web' version grailsVersion }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'grails')).toMatchObject({ confidence: 'partial' });
    expect(find(result, 'grails').declaredVersion).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gradle_dynamic_expression', material: true, path: 'build.gradle' })
    ]));
    expect(result.complete).toBe(false);
  });

  it('resolves versionless Gradle plugins from local plugin management', async () => {
    await write('settings.gradle', `
      pluginManagement { plugins { id 'org.grails.grails-web' version '7.0.0' } }
    `);
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
      plugins { id 'org.grails.grails-web' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'grails')).toMatchObject({ declaredVersion: '7.0.0', confidence: 'confident' });
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gradle_dynamic_expression' })
    ]));
    expect(result.complete).toBe(true);
  });

  it('marks versionless Gradle plugins and applied scripts unresolved when no local version is available', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
      plugins { id 'org.grails.grails-web' }
      apply from: 'gradle/framework.gradle'
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'grails')).toMatchObject({ declaredVersion: undefined, confidence: 'partial' });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gradle_dynamic_expression', material: true }),
      expect.objectContaining({ code: 'gradle_build_logic', material: true })
    ]));
    expect(result.complete).toBe(false);
  });

  it('resolves bare Gradle dependency coordinate variables', async () => {
    await write('gradle.properties', 'vertxCoordinates=io.vertx:vertx-core:5.0.2\n');
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      dependencies { implementation vertxCoordinates }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toMatchObject({ declaredVersion: '5.0.2', confidence: 'confident' });
    expect(result.complete).toBe(true);
  });

  it('marks unresolved bare Gradle dependency expressions incomplete', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      dependencies { implementation vertxCoordinates }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'gradle_dynamic_expression',
        material: true,
        message: expect.stringContaining('vertxCoordinates')
      })
    ]));
    expect(result.complete).toBe(false);
  });

  it('ignores local Gradle project dependencies in the external technology scan', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      dependencies { implementation project(':core') }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gradle_dynamic_expression' })
    ]));
    expect(result.complete).toBe(true);
  });

  it('reads legacy Gradle buildscript classpath framework versions', async () => {
    await write('build.gradle', `
      buildscript { dependencies { classpath 'org.grails:grails-gradle-plugin:7.0.0' } }
      java { sourceCompatibility = JavaVersion.VERSION_17 }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'grails')).toMatchObject({ declaredVersion: '7.0.0', confidence: 'confident' });
  });

  it('reads Groovy map-style dependency declarations in any key order', async () => {
    await write('gradle.properties', 'vertxVersion=5.0.2\n');
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      dependencies {
        implementation version: vertxVersion, name: 'vertx-core', group: 'io.vertx'
      }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toMatchObject({ declaredVersion: '5.0.2', confidence: 'confident' });
    expect(result.complete).toBe(true);
  });

  it('reads Kotlin DSL named-argument dependency declarations', async () => {
    await write('build.gradle.kts', `
      java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }
      plugins { id("org.grails.grails-web") version "7.0.0" }
      dependencies {
        implementation(group = "io.vertx", name = "vertx-core", version = "4.5.0")
      }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toMatchObject({ declaredVersion: '4.5.0', confidence: 'confident' });
  });

  it('does not parse dependency-like text inside Gradle string literals', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      plugins { id 'org.grails.grails-web' version '7.0.0' }
      def migrationNote = "replace implementation 'io.vertx:vertx-core:4.5.0' next quarter"
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toBeUndefined();
    expect(find(result, 'grails')).toMatchObject({ declaredVersion: '7.0.0' });
    expect(result.complete).toBe(true);
  });

  it('resumes Gradle parsing after a string ending in an escaped backslash', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      plugins { id 'org.grails.grails-web' version '7.0.0' }
      def outputDir = "C:\\\\temp\\\\"
      dependencies { implementation 'io.vertx:vertx-core:4.5.0' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'vertx')).toMatchObject({ declaredVersion: '4.5.0' });
    expect(result.complete).toBe(true);
  });

  it('does not use a Grails plugin artifact version as the framework version', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
      plugins { id 'org.grails.grails-web' version '7.0.0' }
      dependencies { implementation group: 'org.grails.plugins', name: 'database-migration', version: '5.0.0' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');
    const grails = result.observations.filter(observation => observation.identityCandidates.includes('grails'));

    expect(grails).toHaveLength(1);
    expect(grails[0]).toMatchObject({
      declaredVersion: '7.0.0',
      sourceDetail: 'plugin org.grails.grails-web'
    });
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'version_unresolved',
        message: expect.stringContaining('org.grails.plugins:database-migration')
      })
    ]));
  });

  it('keeps Grails plugin artifacts as versionless presence evidence when no framework version is available', async () => {
    await write('build.gradle', `
      java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
      dependencies { implementation 'org.grails.plugins:database-migration:5.0.0' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'grails')).toMatchObject({ confidence: 'partial' });
    expect(find(result, 'grails').declaredVersion).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'version_unresolved',
        material: true,
        message: expect.stringContaining('proves Grails presence but not the Grails framework version')
      })
    ]));
    expect(result.complete).toBe(false);
  });

  it('prefers a Gradle Java toolchain over compatibility declarations regardless of order', async () => {
    await write('build.gradle', `
      java {
        sourceCompatibility = JavaVersion.VERSION_17
        toolchain { languageVersion = JavaLanguageVersion.of(21) }
        targetCompatibility = JavaVersion.VERSION_11
      }
      dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({
      declaredVersion: '21',
      sourceDetail: 'Gradle Java toolchain',
      confidence: 'confident'
    });
  });

  it('does not mistake task-specific Java launchers for the project toolchain', async () => {
    await write('build.gradle', `
      java { sourceCompatibility = JavaVersion.VERSION_17 }
      tasks.register('runOnNewerJava', JavaExec) {
        javaLauncher = javaToolchains.launcherFor {
          languageVersion = JavaLanguageVersion.of(21)
        }
      }
      dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({
      declaredVersion: '17',
      sourceDetail: 'Gradle sourceCompatibility'
    });
  });

  it('does not treat an unrelated custom toolchain block as the Java project toolchain', async () => {
    await write('build.gradle', `
      customRuntime { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
      java { sourceCompatibility = JavaVersion.VERSION_17 }
      dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({
      declaredVersion: '17',
      sourceDetail: 'Gradle sourceCompatibility'
    });
  });

  it('reads a qualified Java toolchain block', async () => {
    await write('build.gradle', `
      java.toolchain { languageVersion = JavaLanguageVersion.of(21) }
      dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({
      declaredVersion: '21',
      sourceDetail: 'Gradle Java toolchain'
    });
  });

  it('reads assignment-free Groovy source compatibility declarations', async () => {
    await write('build.gradle', `
      sourceCompatibility JavaVersion.VERSION_11
      dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({
      declaredVersion: '11',
      sourceDetail: 'Gradle sourceCompatibility',
      confidence: 'confident'
    });
  });

  it('normalizes legacy Gradle Java version constants', async () => {
    await write('build.gradle', `
      targetCompatibility JavaVersion.VERSION_1_8
      dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({
      declaredVersion: '8',
      sourceDetail: 'Gradle targetCompatibility',
      confidence: 'confident'
    });
  });

  it('resolves Gradle Java compatibility from gradle.properties', async () => {
    await write('gradle.properties', 'javaVersion=17\n');
    await write('build.gradle', `
      sourceCompatibility = javaVersion
      dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toMatchObject({
      declaredVersion: '17',
      sourceDetail: 'Gradle sourceCompatibility',
      confidence: 'confident'
    });
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'version_unresolved' })
    ]));
  });

  it('marks unresolved Gradle Java expressions as incomplete evidence', async () => {
    await write('build.gradle', `
      sourceCompatibility = javaVersion
      dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'java')).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'version_unresolved', material: true, path: 'build.gradle' })
    ]));
    expect(result.complete).toBe(false);
  });

  it('resolves relevant JavaScript declarations from Yarn Classic and ignores ordinary libraries', async () => {
    await writeJson('package.json', {
      dependencies: {
        '@folio/stripes': '^10.1.0',
        '@folio/stripes-core': '^11.0.0',
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

      "@folio/stripes@^10.1.0":
        version "10.1.2"

      "@folio/stripes-core@^11.0.0":
        version "11.0.1"

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
    expect(result.observations.some(observation => observation.identityCandidates.includes('@folio/stripes-core'))).toBe(false);
    expect(find(result, 'react')).toMatchObject({ declaredVersion: '^18.2.0', resolvedVersion: '18.2.0' });
    for (const id of ['express', 'vue', 'angular', 'svelte', 'nestjs']) {
      expect(find(result, id)).toMatchObject({ unlistedFrameworkCandidate: true });
    }
    expect(result.observations.some(observation => observation.identityCandidates.includes('lodash'))).toBe(false);
    expect(result.complete).toBe(true);
  });

  it('does not treat a peer compatibility range as a second installed version', async () => {
    await writeJson('package.json', {
      devDependencies: { react: '^18.3.0' },
      peerDependencies: { react: '>=16' }
    });
    await write('yarn.lock', `
      # yarn lockfile v1

      "react@^18.3.0":
        version "18.3.1"

    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'javascript');
    const react = result.observations.filter(observation => observation.identityCandidates.includes('react'));

    expect(react).toEqual([
      expect.objectContaining({ sourceDetail: 'devDependencies.react', declaredVersion: '^18.3.0', resolvedVersion: '18.3.1' })
    ]);
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'conflicting_versions' })
    ]));
  });

  it('marks a declared dependency unresolved when a valid lockfile lacks its selector', async () => {
    await writeJson('package.json', { dependencies: { react: '>=16' } });
    await write('yarn.lock', `
      # yarn lockfile v1

      "left-pad@^1.3.0":
        version "1.3.0"
    `);

    const result = await collectS007TechnologyEvidence(repoPath, 'javascript');

    expect(find(result, 'react')).toMatchObject({ declaredVersion: '>=16', resolvedVersion: undefined });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'version_unresolved',
        material: true,
        path: 'yarn.lock',
        message: expect.stringContaining('react@>=16')
      })
    ]));
    expect(result.complete).toBe(false);
  });

  it('does not require a lockfile selector for peer-only compatibility ranges', async () => {
    await writeJson('package.json', { peerDependencies: { react: '^18.2.0' } });

    const result = await collectS007TechnologyEvidence(repoPath, 'javascript');

    expect(find(result, 'react')).toMatchObject({ declaredVersion: '^18.2.0', resolvedVersion: undefined });
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'yarn_lock_missing' }),
      expect.objectContaining({ code: 'version_unresolved', path: 'yarn.lock' })
    ]));
    expect(result.complete).toBe(true);
  });

  it('bounds and deduplicates Gradle manifest traversal', async () => {
    const modules = Array.from({ length: 70 }, (_, index) => `module-${index}`);
    await write('settings.gradle', `include ${modules.map(module => `'${module}'`).join(', ')}\n`);
    await write('build.gradle', 'java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n');
    for (const [index, module] of modules.entries()) {
      await write(`${module}/build.gradle`, `dependencies { implementation 'io.vertx:vertx-core:5.0.${index}' }\n`);
    }

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(result.manifestPaths.length).toBeLessThanOrEqual(64);
    expect(result.manifestPaths).not.toContain('module-69/build.gradle');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'traversal_limit', material: true })
    ]));
    expect(result.complete).toBe(false);
  });

  it('bounds missing Maven module candidates before resolving every declared path', async () => {
    const modules = Array.from({ length: 1000 }, (_, index) => `missing-${index}`);
    await write('pom.xml', `<project><modules>${modules.map(module => `<module>${module}</module>`).join('')}</modules></project>`);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(result.diagnostics.filter(item => item.code === 'local_module_missing')).toHaveLength(64);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'traversal_limit', material: true })
    ]));
  });

  it('bounds missing Gradle module candidates before resolving every declared path', async () => {
    const modules = Array.from({ length: 1000 }, (_, index) => `missing-${index}`);
    await write('settings.gradle', `include ${modules.map(module => `'${module}'`).join(', ')}`);
    await write('build.gradle', 'java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n');

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(result.diagnostics.filter(item => item.code === 'local_module_missing')).toHaveLength(64);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'traversal_limit', material: true, path: 'settings.gradle' })
    ]));
  });

  it('bounds relevant observations collected from one manifest', async () => {
    const dependencies = Array.from({ length: 1100 }, (_, index) => [
      '<dependency><groupId>io.vertx</groupId>',
      `<artifactId>vertx-component-${index}</artifactId>`,
      '<version>5.0.2</version></dependency>'
    ].join(''));
    await write('pom.xml', `<project><properties><java.version>21</java.version></properties><dependencies>${dependencies.join('')}</dependencies></project>`);

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(result.observations.length).toBeLessThanOrEqual(1024);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'traversal_limit', material: true })
    ]));
  });

  it('rejects direct symlinked and oversized manifests', async () => {
    await write('target-package.json', '{"dependencies":{"react":"^18.2.0"}}');
    try {
      await fs.symlink(path.join(repoPath, 'target-package.json'), path.join(repoPath, 'package.json'));
      const symlinkResult = await collectS007TechnologyEvidence(repoPath, 'javascript');
      expect(symlinkResult.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'local_module_symlink', material: true, path: 'package.json' })
      ]));
    } finally {
      await fs.remove(path.join(repoPath, 'package.json'));
    }

    await fs.writeFile(path.join(repoPath, 'package.json'), `{${' '.repeat(1024 * 1024)}}`);
    const oversizedResult = await collectS007TechnologyEvidence(repoPath, 'javascript');
    expect(oversizedResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'manifest_too_large', material: true, path: 'package.json' })
    ]));
  });

  it('does not spend the Gradle manifest budget twice on repeated includes', async () => {
    await write('settings.gradle', `include ${Array.from({ length: 70 }, () => "'shared'").join(', ')}, 'final'\n`);
    await write('build.gradle', 'java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n');
    await write('shared/build.gradle', "dependencies { implementation 'io.vertx:vertx-core:5.0.1' }\n");
    await write('final/build.gradle', "dependencies { implementation 'org.projectlombok:lombok:1.18.32' }\n");

    const result = await collectS007TechnologyEvidence(repoPath, 'java');

    expect(find(result, 'lombok')).toMatchObject({ sourcePath: 'final/build.gradle' });
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'traversal_limit' })
    ]));
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

  it('rejects Gradle modules that escape through an ancestor symlink', async () => {
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 's007-outside-'));
    try {
      await fs.outputFile(path.join(outsidePath, 'service', 'build.gradle'), `
        java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
        dependencies { implementation 'io.vertx:vertx-core:5.0.2' }
      `);
      await write('settings.gradle', "include 'linked:service'\n");
      await write('build.gradle', 'plugins { id \'java\' }\n');
      await fs.symlink(outsidePath, path.join(repoPath, 'linked'), 'dir');

      const result = await collectS007TechnologyEvidence(repoPath, 'java');

      expect(find(result, 'vertx')).toBeUndefined();
      expect(result.manifestPaths).not.toContain('linked/service/build.gradle');
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'local_module_outside_repository', material: true, path: 'settings.gradle' })
      ]));
    } finally {
      await fs.remove(outsidePath);
    }
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
