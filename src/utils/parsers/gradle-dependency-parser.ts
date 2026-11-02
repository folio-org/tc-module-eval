/**
 * Gradle-specific dependency parsing utilities
 *
 * Handles extraction of third-party dependencies from Gradle projects. The evaluator applies the
 * jk1 dependency-license-report plugin through an init script (FOLIO projects do not apply it
 * themselves) and parses its JSON report.
 *
 * PARSER CONTRACT IMPLEMENTATION:
 * This parser fulfills the license-compliance.ts contract by:
 * 1. Extracting licenses as arrays from JSON license reports
 * 2. Normalizing license names via license-policy.normalizeLicenseName()
 * 3. Returning licenses as string arrays in Dependency objects; several licenses of one module form
 *    one set that all apply, unless config/license-dual-licensed.json lists the module as offering a
 *    choice of them
 * 4. No splitting needed - the report lists each license of a module separately
 *
 * SECURITY WARNING: This module executes Gradle build commands on untrusted repositories.
 * Security measures implemented:
 * - Path validation and sanitization via validateRepoPath()
 * - Command timeout enforcement (5 minutes)
 * - Repository path is validated before command execution
 *
 * Remaining risks:
 * - Malicious build.gradle files can execute arbitrary Groovy/Kotlin code
 * - Build scripts in the repository run with the permissions of the evaluator process
 * - Network access during Gradle dependency resolution
 * - Gradle wrapper scripts (gradlew) may contain malicious code
 *
 * Production deployment should use containerization, sandboxing, or isolated environments.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandRunner, Dependency, DependencyExtractionResult, DependencyExtractionError, EvaluationRun } from '../../types';
import { isNonEmptyString, isValidDependency } from '../type-guards';
import { commandError, validateRepoPath } from './common';
import { isWithinRepo, readBoundedFileBytes } from '../repo-files';
import { isDualLicensed, isListedLicenseName, normalizeLicenseName } from '../license-policy';
import { getLogger } from '../logger';
import { defaultCommandRunner } from '../command-runner';
import { GRADLE_NETWORK_POLICY } from '../build-tool-policies';

const COMMAND_TIMEOUT = 300000; // 300 seconds (5 minutes), as for Maven: the first run downloads Gradle and all dependencies
const LICENSE_REPORT_DIR_PROPERTY = 'tcModuleEval.licenseReportDir';
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_DEPENDENCIES = 10000;
const MAX_POM_DEPTH = 32;
const MAX_POM_BYTES = 1024 * 1024;
const MAX_LICENSES = 128;
const MAX_LICENSE_NAME_LENGTH = 4096;
const MAX_BUNDLED_COMPONENTS = 128;
const MAX_ARCHIVE_ENTRIES = 50000;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_BUNDLED_POM_BYTES = 8 * 1024 * 1024;
const MAX_LICENSE_ALTERNATIVES = 256;
const MAX_COMBINED_LICENSES = 128;
// A license name combining several licenses, which normalization would cut down to its first part.
const LICENSE_EXPRESSION = /\||\s(?:OR|AND|WITH)\s/;

const GRADLE_BUILD_FILES = ['build.gradle', 'build.gradle.kts'];

// Where the Gradle build may live: the repository root, or `service/` as in FOLIO's Grails modules
// (mod-agreements, mod-licenses, mod-serials-management).
const GRADLE_PROJECT_DIRS = ['', 'service'];

// The evaluator's Gradle init script. It applies the jk1 license report plugin to the root project
// (whose report covers its subprojects) unless the build applies it already. Init scripts must apply
// plugins by class.
//
// ASF policy covers what the module distributes, so every project's license report is limited to
// the runtime classpath and test configurations are not checked. The root report is written as
// index.json, listing every license of each module and leaving out BOMs (which only manage
// versions), to the evaluator's own directory given by LICENSE_REPORT_DIR_PROPERTY. jk1 merges all
// ancestors when the own POM has no licenses, even with unionParentPomLicenses=false, and its JSON
// loses POM/manifest/license-file provenance. Resolve published POMs separately through Gradle and
// attach their nearest-first declarations. Distinct components' embedded Maven POMs supply bundled
// code's licenses; manifest and license-file keyword matches are never used for compliance.
//
// Everything is configured in projectsEvaluated, which runs after every project's own afterEvaluate
// callbacks, so it overrides what the build sets, even late. The renderer is loaded through the
// applied plugin's classloader so that it also matches a copy of the plugin the build applies itself.
const LICENSE_REPORT_INIT_SCRIPT = `initscript {
  repositories { gradlePluginPortal() }
  dependencies { classpath 'com.github.jk1:gradle-license-report:3.1.4' }
}

gradle.projectsEvaluated {
  def root = gradle.rootProject
  if (!root.plugins.hasPlugin('com.github.jk1.dependency-license-report')) {
    root.pluginManager.apply(com.github.jk1.license.LicenseReportPlugin)
  }
  root.allprojects { project ->
    project.plugins.withId('com.github.jk1.dependency-license-report') {
      project.licenseReport.configurations = ['runtimeClasspath'] as String[]
    }
  }

  def report = root.licenseReport
  def loader = report.getClass().classLoader
  def renderer = loader.loadClass('com.github.jk1.license.render.JsonReportRenderer')
    .getConstructor(String, boolean).newInstance('index.json', false)
  def renderers = java.lang.reflect.Array.newInstance(loader.loadClass('com.github.jk1.license.render.ReportRenderer'), 1)
  renderers[0] = renderer
  report.renderers = renderers
  report.outputDir = gradle.startParameter.systemPropertiesArgs['${LICENSE_REPORT_DIR_PROPERTY}']
  report.excludeBoms = true
  if (report.hasProperty('unionParentPomLicenses')) {
    report.unionParentPomLicenses = false
  }

  root.tasks.named('generateLicenseReport').configure {
    doLast {
      def file = new File(report.absoluteOutputDir, 'index.json')
      if (file.length() > ${MAX_REPORT_BYTES}) throw new GradleException('Gradle license report exceeds ${MAX_REPORT_BYTES} bytes')
      def json = new groovy.json.JsonSlurper().parse(file)
      if (!(json.dependencies instanceof List) || json.dependencies.size() > ${MAX_DEPENDENCIES}) {
        throw new GradleException('Gradle license report must list at most ${MAX_DEPENDENCIES} dependencies')
      }
      if (report.projects.length > 128) throw new GradleException('Gradle license report exceeds 128 projects')
      def pomCache = [:]
      def parsePom = { byte[] bytes, List key ->
        def parser = loader.loadClass('groovy.xml.XmlSlurper').getConstructor(boolean, boolean).newInstance(false, false)
        def pom = parser.parse(new ByteArrayInputStream(bytes))
        def licenses = pom.licenses.license.collect { [name: it.name.text().trim()] }
        if (licenses.size() > ${MAX_LICENSES} || licenses.any { it.name.length() > ${MAX_LICENSE_NAME_LENGTH} }) {
          throw new GradleException('POM license declarations exceed limits: ' + key.join(':'))
        }
        def parent = pom.parent
        def coordinates = [pom.groupId.text().trim() ?: parent.groupId.text().trim(), pom.artifactId.text().trim(),
          pom.version.text().trim() ?: parent.version.text().trim()]
        [pom: key.join(':'), coordinates: coordinates, licenses: licenses, parent: parent.size() ?
          [parent.groupId.text().trim(), parent.artifactId.text().trim(), parent.version.text().trim()] : null]
      }
      def readPom = { String group, String name, String version ->
        def key = [group, name, version]
        if (!pomCache.containsKey(key)) {
          def artifacts = report.projects.findResult { project ->
            def results = project.dependencies.createArtifactResolutionQuery()
              .forModule(group, name, version)
              .withArtifacts(org.gradle.maven.MavenModule, org.gradle.maven.MavenPomArtifact)
              .execute().resolvedComponents.collectMany { it.getArtifacts(org.gradle.maven.MavenPomArtifact) }
              .findAll { it instanceof org.gradle.api.artifacts.result.ResolvedArtifactResult }
            results ?: null
          }
          if (!artifacts || artifacts.size() != 1) throw new GradleException('No unique published POM for ' + key.join(':'))
          def bytes = artifacts.first().file.withInputStream { it.readNBytes(${MAX_POM_BYTES + 1}) }
          if (bytes.length > ${MAX_POM_BYTES}) throw new GradleException('POM exceeds ${MAX_POM_BYTES} bytes: ' + key.join(':'))
          pomCache[key] = parsePom(bytes, key)
        }
        pomCache[key]
      }
      def resolveChain = { target, List coordinates, initialPom ->
        target.pomLicenseChain = []
        if (initialPom?.licenses) target.pomLicenseChain << [pom: coordinates.join(':'), licenses: initialPom.licenses]
        try {
          def seen = new HashSet()
          while (coordinates) {
            if (coordinates.size() != 3 || coordinates.any { !it || it.length() > ${MAX_LICENSE_NAME_LENGTH} || it.contains('$' + '{') }) {
              throw new GradleException('Unresolved POM coordinates')
            }
            if (initialPom?.licenses) break
            if (!seen.add(coordinates) || seen.size() > ${MAX_POM_DEPTH}) throw new GradleException('POM parent cycle or depth exceeds ${MAX_POM_DEPTH}')
            def pom = initialPom ?: readPom(*coordinates)
            initialPom = null
            target.pomLicenseChain << [pom: coordinates.join(':'), licenses: pom.licenses]
            coordinates = pom.licenses ? null : pom.parent
          }
        } catch (Exception error) {
          target.pomLicenseError = (error.message ?: error.class.simpleName).take(${MAX_LICENSE_NAME_LENGTH})
        }
      }
      def archiveFiles = [:].withDefault { new LinkedHashSet() }
      report.projects.each { project ->
        def configuration = project.configurations.findByName('runtimeClasspath')
        if (configuration && configuration.canBeResolved) {
          def artifacts = configuration.resolvedConfiguration.resolvedArtifacts
          if (artifacts.size() > ${MAX_DEPENDENCIES}) throw new GradleException('Gradle runtime artifacts exceed ${MAX_DEPENDENCIES}')
          artifacts.each { artifact -> archiveFiles[artifact.moduleVersion.id.toString()] << artifact.file }
        }
      }
      json.dependencies.each { dependency ->
        resolveChain(dependency, dependency.moduleName.tokenize(':') + [dependency.moduleVersion], null)
        dependency.bundledComponents = []
        def seenComponents = new HashSet()
        long totalPomBytes = 0
        def archives = archiveFiles[dependency.moduleName + ':' + dependency.moduleVersion]
        if (archives.size() > 8) {
          dependency.bundleLicenseError = 'More than 8 runtime artifacts for one dependency'
          archives = archives.take(8)
        }
        archives.each { archive ->
          if (!['.jar', '.zip', '.war', '.aar'].any { archive.name.toLowerCase().endsWith(it) }) return
          try {
            if (archive.length() > ${MAX_ARCHIVE_BYTES}) throw new GradleException('Archive exceeds ${MAX_ARCHIVE_BYTES} bytes')
            new java.util.zip.ZipFile(archive).withCloseable { zip ->
              def entries = zip.entries()
              int count = 0
              while (entries.hasMoreElements()) {
                if (++count > ${MAX_ARCHIVE_ENTRIES}) throw new GradleException('Archive exceeds ${MAX_ARCHIVE_ENTRIES} entries')
                def entry = entries.nextElement()
                if (entry.name.length() > ${MAX_LICENSE_NAME_LENGTH}) throw new GradleException('Archive entry path exceeds ${MAX_LICENSE_NAME_LENGTH} characters')
                if (!entry.isDirectory() && ['.jar', '.zip', '.war', '.aar'].any { entry.name.toLowerCase().endsWith(it) }) {
                  dependency.bundleLicenseError = 'Nested archives require manual license review'
                }
                def marker = 'META-INF/maven/'
                int start = entry.name.lastIndexOf(marker)
                if (entry.isDirectory() || start < 0 || (start > 0 && entry.name.charAt(start - 1) != '/')) continue
                def parts = entry.name.substring(start + marker.length()).split('/')
                if (parts.length != 3 || parts[2] != 'pom.xml') continue
                def componentName = parts[0] + ':' + parts[1]
                if (dependency.bundledComponents.size() >= ${MAX_BUNDLED_COMPONENTS}) throw new GradleException('Bundled POMs exceed ${MAX_BUNDLED_COMPONENTS} components')
                def component = [moduleName: componentName, moduleVersion: 'unknown', pomPath: entry.name, pomLicenseChain: []]
                try {
                  def bytes = zip.getInputStream(entry).withCloseable { it.readNBytes(${MAX_POM_BYTES + 1}) }
                  totalPomBytes += bytes.length
                  if (bytes.length > ${MAX_POM_BYTES} || totalPomBytes > ${MAX_BUNDLED_POM_BYTES}) throw new GradleException('Bundled POM byte limit exceeded')
                  def pom = parsePom(bytes, [parts[0], parts[1]])
                  component.moduleVersion = pom.coordinates[2] ?: 'unknown'
                  if (componentName == dependency.moduleName && component.moduleVersion == dependency.moduleVersion) continue
                  resolveChain(component, pom.coordinates, pom)
                  if (pom.coordinates.take(2) != parts.take(2).toList()) throw new GradleException('Embedded POM coordinates do not match its Maven path')
                } catch (Exception error) {
                  component.pomLicenseError = (error.message ?: error.class.simpleName).take(${MAX_LICENSE_NAME_LENGTH})
                }
                def identity = groovy.json.JsonOutput.toJson([component.moduleName, component.moduleVersion, component.pomLicenseChain, component.pomLicenseError])
                if (seenComponents.add(identity)) dependency.bundledComponents << component
                if (totalPomBytes > ${MAX_BUNDLED_POM_BYTES}) throw new GradleException('Bundled POM byte limit exceeded')
              }
            }
          } catch (Exception error) {
            dependency.bundleLicenseError = (error.message ?: error.class.simpleName).take(${MAX_LICENSE_NAME_LENGTH})
          }
        }
      }
      def output = groovy.json.JsonOutput.toJson(json)
      if (output.getBytes('UTF-8').length > ${MAX_REPORT_BYTES}) throw new GradleException('Gradle license report exceeds ${MAX_REPORT_BYTES} bytes')
      file.setText(output, 'UTF-8')
    }
  }
}
`;

/**
 * Runs `command` with the init script and an empty report directory in a fresh private temp
 * directory outside the repository, so concurrent evaluations don't share them, no pre-existing
 * path is written through, and no earlier report can be read. The directory is removed afterwards.
 */
async function withLicenseReportInitScript<T>(command: (initScript: string, reportDir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-module-eval-s003-gradle-'));
  try {
    const initScript = path.join(dir, 'license-report.gradle');
    fs.writeFileSync(initScript, LICENSE_REPORT_INIT_SCRIPT, { encoding: 'utf-8', flag: 'wx' });
    return await command(initScript, path.join(dir, 'report'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Parse a component using the POM declarations attached by the init script.
 * The nearest POM declaring any licenses supplies the entire set, even if a name is missing.
 * @param dep - Dependency object from license report
 * @returns Parsed dependency or null if invalid
 */
function parsePomLicenseDependency(dep: any, warnings: DependencyExtractionError[]): Dependency | null {
  if (!dep || typeof dep !== 'object') {
    return null;
  }

  const name = dep.moduleName;
  const version = dep.moduleVersion;

  if (!isNonEmptyString(name) || !isNonEmptyString(version)) {
    return null;
  }

  if (!Array.isArray(dep.pomLicenseChain) || dep.pomLicenseChain.length > MAX_POM_DEPTH) {
    throw new Error(`Missing or oversized POM license provenance for ${name}`);
  }
  let licenseNames: string[] = [];
  for (const pom of dep.pomLicenseChain) {
    if (!Array.isArray(pom?.licenses) || pom.licenses.length > MAX_LICENSES ||
        pom.licenses.some((license: any) => typeof license?.name !== 'string' || license.name.length > MAX_LICENSE_NAME_LENGTH)) {
      throw new Error(`Invalid or oversized POM license declarations for ${name}`);
    }
    if (pom.licenses.length > 0) {
      licenseNames = pom.licenses.map((license: { name: string }) => license.name);
      break;
    }
  }
  if (dep.pomLicenseError) {
    warnings.push({ source: 'gradle-parser', message: `POM licenses could not be resolved for ${name}: ${String(dep.pomLicenseError).slice(0, MAX_LICENSE_NAME_LENGTH)}` });
  }
  // Expressions are kept as reported so the compliance check flags them instead of passing their first license.
  const licenses = [...new Set(licenseNames.map(license => license.trim() || 'Unnamed POM license').map(license =>
    LICENSE_EXPRESSION.test(license) && !isListedLicenseName(license) ? license : normalizeLicenseName(license)
  ))];
  const moduleName = name.trim();

  return {
    name: moduleName,
    version: version.trim(),
    // A POM can list one license per bundled component (Jersey lists Apache-2.0 for its bundled Guava),
    // so the licenses all apply unless the dependency is known to offer a choice of them.
    licenses: dep.pomLicenseError && licenses.length > 0
      ? (licenses.length > 1 && isDualLicensed(moduleName) ? licenses : [licenses]).map(alternative =>
        [...(Array.isArray(alternative) ? alternative : [alternative]), 'Unresolved POM license evidence'])
      : licenses.length > 1 && !isDualLicensed(moduleName) ? [licenses] : licenses
  };
}

function parseGradleLicenseReportDependency(dep: any, warnings: DependencyExtractionError[]): Dependency[] {
  const host = parsePomLicenseDependency(dep, warnings);
  if (!host || !isValidDependency(host)) throw new Error('Gradle license report contains an invalid dependency');
  const parts = [host];
  let incomplete = dep.bundleLicenseError ? String(dep.bundleLicenseError).slice(0, MAX_LICENSE_NAME_LENGTH) : '';
  if (!Array.isArray(dep.bundledComponents)) {
    incomplete ||= 'Missing bundled POM inventory';
  } else {
    if (dep.bundledComponents.length > MAX_BUNDLED_COMPONENTS) incomplete ||= `Bundled POMs exceed ${MAX_BUNDLED_COMPONENTS} components`;
    const seen = new Set<string>();
    for (const component of dep.bundledComponents.slice(0, MAX_BUNDLED_COMPONENTS)) {
      try {
        const parsed = parsePomLicenseDependency(component, warnings);
        if (!parsed || !isValidDependency(parsed)) throw new Error('Invalid bundled POM identity');
        const key = JSON.stringify(parsed);
        if (!seen.has(key) && (parsed.name !== host.name || parsed.version !== host.version)) parts.push(parsed);
        seen.add(key);
      } catch (error) {
        incomplete ||= error instanceof Error ? error.message : 'Invalid bundled POM provenance';
      }
    }
  }
  if (incomplete) warnings.push({ source: 'gradle-parser', message: `Bundled POM licenses could not be resolved for ${host.name}: ${incomplete}` });
  if (parts.length === 1 && !incomplete) return [host];

  for (const part of parts) {
    part.licenses = part.licenses?.map(alternative => {
      const names = (Array.isArray(alternative) ? alternative : [alternative]).map(license => {
        if (!isListedLicenseName(license) && LICENSE_EXPRESSION.test(license)) {
          warnings.push({ source: 'gradle-parser', message: `Unresolved POM license expression for ${part.name}: ${license}` });
          return 'Unresolved POM license expression';
        }
        return license;
      });
      return Array.isArray(alternative) ? names : names[0];
    });
  }

  // Dependency alternatives are OR; each array is AND. Compose per-component choices rather than
  // making a permissive host's license an alternative to a bundled component's required license.
  let alternatives: string[][] = [[]];
  for (const part of parts) {
    const choices = part.licenses?.length ? part.licenses : [`Unresolved POM license evidence for ${part.name}`];
    const combined = new Map<string, string[]>();
    for (const previous of alternatives) {
      for (const choice of choices) {
        const names = [...new Set([...previous, ...(Array.isArray(choice) ? choice : [choice])])];
        combined.set(JSON.stringify([...names].sort()), names);
        if (combined.size > MAX_LICENSE_ALTERNATIVES || names.length > MAX_COMBINED_LICENSES) {
          warnings.push({ source: 'gradle-parser', message: `Bundled POM license combinations exceed limits for ${host.name}; components reported separately` });
          // Retaining component rows preserves proven B/X even when the host cannot be represented
          // within the bounded OR-of-ANDs API. The host itself must still require manual review.
          const own = host.licenses?.length ? host.licenses : [[]];
          return [{ ...host, licenses: own.map(license => [...(Array.isArray(license) ? license : [license]), 'Unresolved bundled POM license combinations']) }, ...parts.slice(1)];
        }
      }
    }
    alternatives = [...combined.values()];
  }
  if (incomplete) alternatives = alternatives.map(names => [...names, 'Unresolved bundled POM license evidence']);
  return [{ ...host, licenses: alternatives.map(names => names.length === 1 ? names[0] : names) }];
}

function parseGradleLicenseReport(content: string, warnings: DependencyExtractionError[]): Dependency[] {
  const report = JSON.parse(content);
  const dependencies: Dependency[] = [];
  if (!Array.isArray(report?.dependencies) || report.dependencies.length > MAX_DEPENDENCIES) {
    throw new Error(`Gradle license report must list at most ${MAX_DEPENDENCIES} dependencies`);
  }
  for (const dep of report.dependencies) {
    dependencies.push(...parseGradleLicenseReportDependency(dep, warnings));
  }
  return dependencies;
}

/**
 * Check if a Gradle project exists in the repository root or its `service/` folder
 * @param repoPath - Path to repository
 * @returns Promise resolving to true if Gradle project exists
 */
export async function hasGradleProject(repoPath: string): Promise<boolean> {
  return isNonEmptyString(repoPath) && findGradleProjectDir(repoPath) !== undefined;
}

/**
 * Directory holding the Gradle build (the repository root or `service/`), or undefined if there is none.
 * A `service/` symlink that leads outside the repository is ignored.
 */
export function findGradleProjectDir(repoPath: string): string | undefined {
  return GRADLE_PROJECT_DIRS
    .map(dir => path.join(repoPath, dir))
    .find(dir => GRADLE_BUILD_FILES.some(file => fs.existsSync(path.join(dir, file))) && isWithinRepo(repoPath, dir));
}

export function getGradleCommand(repoPath: string): { command: string; argsPrefix: string[] } {
  const wrapper = path.join(repoPath, 'gradlew');
  if (fs.existsSync(wrapper)) {
    return { command: wrapper, argsPrefix: [] };
  }
  return { command: 'gradle', argsPrefix: [] };
}

export async function getGradleDependencies(
  repoPath: string,
  evaluationRun?: EvaluationRun,
  commandRunner: CommandRunner = evaluationRun?.commandRunner ?? defaultCommandRunner
): Promise<DependencyExtractionResult> {
  const errors: DependencyExtractionError[] = [];
  const warnings: DependencyExtractionError[] = [];

  // SECURITY: Validate and sanitize repository path before executing commands
  const validatedPath = validateRepoPath(repoPath);
  if (!validatedPath) {
    errors.push({
      source: 'gradle-parser',
      message: `Invalid repository path: ${repoPath}`,
      error: new Error('Path validation failed')
    });
    return { dependencies: [], errors, warnings };
  }

  const projectDir = findGradleProjectDir(validatedPath) ?? validatedPath;

  try {
    const gradle = getGradleCommand(projectDir);
    const { licenseCommand, licenseContent } = await withLicenseReportInitScript(async (initScript, reportDir) => {
      const licenseCommand = await commandRunner.run({
        command: gradle.command,
        // The init script registers the root task in projectsEvaluated, which configure-on-demand runs only
        // after selecting tasks. Only the root report (covering all projects) is the evaluator's.
        args: [
          ...gradle.argsPrefix, '--init-script', initScript, `-D${LICENSE_REPORT_DIR_PROPERTY}=${reportDir}`,
          '--no-configure-on-demand', ':generateLicenseReport'
        ],
        cwd: projectDir,
        timeoutMs: COMMAND_TIMEOUT,
        requiresIsolation: true,
        networkPolicy: GRADLE_NETWORK_POLICY
      }, evaluationRun);
      const reportFile = path.join(reportDir, 'index.json');
      let licenseContent: string | null = null;
      if (fs.existsSync(reportFile)) {
        const bytes = readBoundedFileBytes(reportFile, MAX_REPORT_BYTES + 1);
        if (bytes.length > MAX_REPORT_BYTES) throw new Error(`Gradle license report exceeds ${MAX_REPORT_BYTES} bytes`);
        licenseContent = bytes.toString('utf-8');
      }
      return { licenseCommand, licenseContent };
    });

    getLogger().info('Gradle license plugin output:', licenseCommand.stdout);

    if (licenseCommand.status !== 'success') {
      errors.push(commandError('gradle-parser', 'Gradle', licenseCommand));
      return { dependencies: [], errors, warnings };
    }

    if (licenseContent) {
      const dependencies = parseGradleLicenseReport(licenseContent, warnings);
      return { dependencies, errors, warnings };
    }

    errors.push({
      source: 'gradle-parser',
      message: 'Gradle ran but did not write its license report, so the dependencies could not be listed.',
      error: new Error('Gradle license report missing')
    });
    return { dependencies: [], errors, warnings };

  } catch (error) {
    errors.push({
      source: 'gradle-parser',
      message: 'Gradle could not list the dependencies',
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
