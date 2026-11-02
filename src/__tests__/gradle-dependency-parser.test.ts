import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGradleDependencies, hasGradleProject } from '../utils/parsers/gradle-dependency-parser';
import { CommandExecutionRequest, CommandExecutionResult, CommandRunner, LicenseIssueType } from '../types';
import { checkLicenseCompliance } from '../utils/license-compliance';
import { NoopLogger, resetLogger, setLogger } from '../utils/logger';
import { expectLinearTime } from './helpers/linear-time';

// jk1's JSON fields are retained for diagnostics, not used as license provenance.
const JK1_REPORT = {
  dependencies: [
    {
      moduleName: 'org.javassist:javassist',
      moduleVersion: '3.30.2-GA',
      moduleUrls: ['https://www.javassist.org/'],
      pomLicenseChain: [{ licenses: [{ name: 'Apache License 2.0' }, { name: 'LGPL 2.1' }, { name: 'MPL 1.1' }] }],
      moduleLicenses: [
        { moduleLicense: 'Apache License 2.0', moduleLicenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0' },
        { moduleLicense: 'LGPL 2.1', moduleLicenseUrl: 'https://www.gnu.org/licenses/lgpl-2.1.html' },
        { moduleLicense: 'MPL 1.1', moduleLicenseUrl: 'https://www.mozilla.org/en-US/MPL/1.1/' }
      ]
    },
    {
      moduleName: 'org.glassfish.jersey.core:jersey-common',
      moduleVersion: '2.48',
      moduleUrls: ['https://www.eclipse.org/org/foundation/'],
      pomLicenseChain: [{ licenses: [
        { name: 'Apache License, 2.0' },
        { name: 'EPL 2.0' },
        { name: 'Public Domain' },
        { name: 'The GNU General Public License (GPL), Version 2, With Classpath Exception' }
      ] }],
      moduleLicenses: [
        { moduleLicense: 'Apache License, 2.0', moduleLicenseUrl: 'http://www.apache.org/licenses/LICENSE-2.0.html' },
        { moduleLicense: 'EPL 2.0', moduleLicenseUrl: 'http://www.eclipse.org/legal/epl-2.0' },
        { moduleLicense: 'Eclipse Public License - v 2.0', moduleLicenseUrl: 'https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.txt' },
        { moduleLicense: 'Public Domain', moduleLicenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' },
        {
          moduleLicense: 'The GNU General Public License (GPL), Version 2, With Classpath Exception',
          moduleLicenseUrl: 'https://www.gnu.org/software/classpath/license.html'
        }
      ]
    },
    {
      moduleName: 'ch.qos.logback:logback-classic',
      moduleVersion: '1.2.13',
      moduleUrls: ['http://www.qos.ch'],
      pomLicenseChain: [{ licenses: [{ name: 'Eclipse Public License - v 1.0' }, { name: 'GNU Lesser General Public License' }] }],
      moduleLicenses: [
        { moduleLicense: 'Eclipse Public License - v 1.0', moduleLicenseUrl: 'http://www.eclipse.org/legal/epl-v10.html' },
        { moduleLicense: 'GNU Lesser General Public License', moduleLicenseUrl: 'http://www.gnu.org/licenses/old-licenses/lgpl-2.1.html' }
      ]
    },
    {
      moduleName: 'com.github.ben-manes.caffeine:caffeine',
      moduleVersion: '2.9.3',
      moduleUrls: [],
      pomLicenseChain: [{ licenses: [{ name: '  Apache License, Version 2.0 ' }] }],
      moduleLicenses: [
        { moduleLicense: null, moduleLicenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0' },
        { moduleLicense: '  Apache License, Version 2.0 ', moduleLicenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt' }
      ]
    },
    {
      moduleName: 'javax.servlet:javax.servlet-api',
      moduleVersion: '4.0.1',
      moduleUrls: [],
      pomLicenseChain: [{ licenses: [{ name: 'CDDL + GPLv2 with classpath exception' }] }],
      moduleLicenses: [
        { moduleLicense: 'CDDL + GPLv2 with classpath exception', moduleLicenseUrl: 'https://oss.oracle.com/licenses/CDDL+GPL-1.1' },
        { moduleLicense: 'COMMON DEVELOPMENT AND DISTRIBUTION LICENSE (CDDL) Version 1.0', moduleLicenseUrl: 'https://opensource.org/licenses/CDDL-1.0' }
      ]
    },
    { moduleName: 'com.k_int.okapi:grails-okapi', moduleVersion: '8.1.1', moduleUrls: [], moduleLicenses: [], pomLicenseChain: [{ licenses: [] }] },
    {
      moduleName: 'org.example:dual',
      moduleVersion: '1.0',
      moduleUrls: [],
      pomLicenseChain: [{ licenses: [{ name: '(MIT) AND (GPL-3.0)' }] }],
      moduleLicenses: [{ moduleLicense: '(MIT) AND (GPL-3.0)', moduleLicenseUrl: null }]
    },
    {
      moduleName: 'org.postgresql:postgresql',
      moduleUrl: 'https://jdbc.postgresql.org',
      moduleVersion: '42.7.11',
      pomLicenseChain: [{ licenses: [{ name: 'BSD-2-Clause' }] }],
      moduleLicense: 'BSD-2-Clause',
      moduleLicenseUrl: 'https://jdbc.postgresql.org/about/license.html'
    }
  ],
  importedModules: []
};

const EHCACHE_LICENSES = [
  'The Apache Software License, Version 2.0', 'BSD-3-Clause', 'Apache License 2.0',
  'GPL-2.0-only WITH Classpath-exception-2.0', 'EPL-2.0', 'CDDL-1.0', 'Apache Software License',
  'Eclipse Public License', 'BSD-2-Clause', 'Apache-2.0', 'Public Domain', 'jQuery license', 'MIT', 'W3C license',
  'Unresolved POM license evidence for org.terracotta:management-common-resources-v1',
  'Unresolved POM license evidence for org.terracotta:management-common-resources-v2',
  'Unresolved POM license evidence for org.terracotta:management-common-v1',
  'Unresolved POM license evidence for org.terracotta:management-common-v2',
  'Unresolved POM license evidence for org.terracotta:management-core-resources',
  'Unresolved POM license evidence for org.terracotta:management-core'
];

class ReportWritingRunner implements CommandRunner {
  request?: CommandExecutionRequest;
  initScript?: string;
  reportDir?: string;

  constructor(private readonly report: unknown = JK1_REPORT) {}

  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify(request);
  }

  async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    this.request = request;
    const args = request.args ?? [];
    this.initScript = fs.readFileSync(args[args.indexOf('--init-script') + 1], 'utf-8');
    // The init script points the report at the directory passed as a -D system property.
    const reportDir = args.find(arg => arg.startsWith('-DtcModuleEval.licenseReportDir='))!.split('=')[1];
    this.reportDir = reportDir;
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'index.json'), typeof this.report === 'string' ? this.report : JSON.stringify(this.report,
      (key, value) => key === 'dependencies' && Array.isArray(value)
        ? value.map(dependency => ({ bundledComponents: [], ...dependency })) : value));
    return {
      identity: this.normalize(request),
      command: request.command,
      args,
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

describe('getGradleDependencies', () => {
  let repo: string;

  beforeEach(() => {
    setLogger(new NoopLogger());
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle-parser-'));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    resetLogger();
  });

  it('applies the license report plugin in service/ and keeps all POM licenses together unless the module is known to be dual-licensed', async () => {
    const service = path.join(repo, 'service');
    fs.mkdirSync(service);
    fs.writeFileSync(path.join(service, 'build.gradle'), '');
    fs.writeFileSync(path.join(service, 'gradlew'), '');
    // A report left in the project's build directory must not be read instead of the new one.
    const staleReport = path.join(service, 'build', 'reports', 'dependency-license');
    fs.mkdirSync(staleReport, { recursive: true });
    fs.writeFileSync(path.join(staleReport, 'index.json'), JSON.stringify({
      dependencies: [{ moduleName: 'stale:dependency', moduleVersion: '1.0', moduleLicense: 'MIT' }]
    }));
    const runner = new ReportWritingRunner();

    const result = await getGradleDependencies(repo, undefined, runner);

    expect(runner.request).toMatchObject({ command: path.join(service, 'gradlew'), cwd: service });
    // Configure-on-demand would select tasks before the init script registers the root report task.
    expect(runner.request?.args).toEqual(expect.arrayContaining(['--no-configure-on-demand', ':generateLicenseReport']));
    expect(runner.request?.args).not.toContain('generateLicenseReport');
    const initScriptPath = runner.request!.args![runner.request!.args!.indexOf('--init-script') + 1];
    for (const evaluatorPath of [initScriptPath, runner.reportDir!]) {
      expect(evaluatorPath.startsWith(repo)).toBe(false);
      expect(fs.existsSync(evaluatorPath)).toBe(false);
    }
    expect(runner.initScript).toContain('pluginManager.apply(com.github.jk1.license.LicenseReportPlugin)');
    expect(runner.initScript).toContain("loadClass('com.github.jk1.license.render.JsonReportRenderer')");
    expect(runner.initScript).toContain("newInstance('index.json', false)");
    expect(runner.initScript).toContain("systemPropertiesArgs['tcModuleEval.licenseReportDir']");
    expect(runner.initScript).toContain('report.unionParentPomLicenses = false');
    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([
      // Listed in license-dual-licensed.json by exact name, so the licenses are a choice.
      { name: 'org.javassist:javassist', version: '3.30.2-GA', licenses: ['Apache License 2.0', 'LGPL-2.1', 'MPL-1.1'] },
      {
        // Jersey's POM lists Apache-2.0 and Public Domain for bundled components, next to Jersey's own licenses.
        name: 'org.glassfish.jersey.core:jersey-common',
        version: '2.48',
        licenses: [['Apache-2.0', 'EPL-2.0', 'Public Domain', 'GPL-2.0-only WITH Classpath-exception-2.0']]
      },
      {
        // Listed by groupId prefix.
        name: 'ch.qos.logback:logback-classic',
        version: '1.2.13',
        licenses: ['EPL-1.0', 'GNU Lesser General Public License']
      },
      { name: 'com.github.ben-manes.caffeine:caffeine', version: '2.9.3', licenses: ['Apache License 2.0'] },
      { name: 'javax.servlet:javax.servlet-api', version: '4.0.1', licenses: ['CDDL-1.0'] },
      { name: 'com.k_int.okapi:grails-okapi', version: '8.1.1', licenses: [] },
      // Normalizing would cut the expression down to "MIT"; it must reach the compliance check whole.
      { name: 'org.example:dual', version: '1.0', licenses: ['(MIT) AND (GPL-3.0)'] },
      { name: 'org.postgresql:postgresql', version: '42.7.11', licenses: ['BSD-2-Clause'] }
    ]);

    // Jersey's own code is EPL-2.0 or GPL-2.0 with Classpath exception, so its bundled components'
    // Category A licenses do not let it pass; Javassist passes under its Apache-2.0 choice.
    const issues = checkLicenseCompliance(result.dependencies, 'README').issues
      .map(issue => [issue.dependency.name, issue.issueType]);
    expect(issues).toEqual([
      ['org.glassfish.jersey.core:jersey-common', LicenseIssueType.UNDOCUMENTED_CATEGORY_B],
      ['ch.qos.logback:logback-classic', LicenseIssueType.UNKNOWN_LICENSE],
      ['javax.servlet:javax.servlet-api', LicenseIssueType.UNDOCUMENTED_CATEGORY_B],
      ['com.k_int.okapi:grails-okapi', LicenseIssueType.NO_LICENSE_INFO],
      ['org.example:dual', LicenseIssueType.PARSER_ERROR]
    ]);
  });

  it('removes all ten reported false Category B entries using POM provenance, while retaining ehcache, JBoss and Sisu Category B licenses', async () => {
    // Selected entries captured from mod-agreements 2f6bd141ee5ff9254136693970c26746619669fe,
    // Gradle 7.6.6 and jk1 3.1.4, retaining the original aggregated fields for comparison.
    const report = fs.readFileSync(path.join(__dirname, 'fixtures/gradle-pom-license-report.json'), 'utf-8');
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner(report));

    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([
      { name: 'com.sun.activation:jakarta.activation', version: '1.2.2', licenses: ['BSD-3-Clause'] },
      { name: 'com.sun.istack:istack-commons-runtime', version: '3.0.12', licenses: ['BSD-3-Clause'] },
      { name: 'com.sun.xml.bind:jaxb-core', version: '4.0.5', licenses: ['BSD-3-Clause'] },
      { name: 'com.sun.xml.bind:jaxb-impl', version: '4.0.5', licenses: ['BSD-3-Clause'] },
      { name: 'jakarta.activation:jakarta.activation-api', version: '1.2.2', licenses: ['BSD-3-Clause'] },
      { name: 'jakarta.xml.bind:jakarta.xml.bind-api', version: '2.3.3', licenses: ['BSD-3-Clause'] },
      { name: 'net.sf.ehcache:ehcache', version: '2.10.9.2', licenses: [[...EHCACHE_LICENSES, 'Unresolved bundled POM license evidence']] },
      { name: 'org.apache.kafka:kafka-clients', version: '3.9.2', licenses: ['The Apache Software License, Version 2.0'] },
      { name: 'org.eclipse.angus:angus-activation', version: '2.0.2', licenses: ['BSD-3-Clause'] },
      { name: 'org.glassfish.jaxb:jaxb-runtime', version: '2.3.9', licenses: ['BSD-3-Clause'] },
      { name: 'org.glassfish.jaxb:txw2', version: '2.3.9', licenses: ['BSD-3-Clause'] },
      {
        name: 'org.jboss.spec.javax.transaction:jboss-transaction-api_1.2_spec', version: '1.1.1.Final',
        licenses: [['Common Development and Distribution License', 'GPL-2.0-only WITH Classpath-exception-2.0']]
      },
      { name: 'org.sonatype.sisu:sisu-inject-plexus', version: '2.6.0', licenses: ['Eclipse Public License 1.0'] }
    ]);
    expect(checkLicenseCompliance(result.dependencies, '').issues.map(issue => [issue.dependency.name, issue.issueType])).toEqual([
      ['net.sf.ehcache:ehcache', LicenseIssueType.UNDOCUMENTED_CATEGORY_B],
      ['org.jboss.spec.javax.transaction:jboss-transaction-api_1.2_spec', LicenseIssueType.UNDOCUMENTED_CATEGORY_B],
      ['org.sonatype.sisu:sisu-inject-plexus', LicenseIssueType.UNDOCUMENTED_CATEGORY_B]
    ]);
    expect(result.warnings).toEqual([
      ...[
        'management-common-resources-v1', 'management-common-resources-v2', 'management-common-v1',
        'management-common-v2', 'management-core-resources', 'management-core'
      ].map(name => ({ source: 'gradle-parser', message: `POM licenses could not be resolved for org.terracotta:${name}: No unique published POM for org.terracotta:management-common:2.1.25.3` })),
      { source: 'gradle-parser', message: 'Bundled POM licenses could not be resolved for net.sf.ehcache:ehcache: Nested archives require manual license review' }
    ]);
  });

  it('keeps captured ehcache evidence manual after documenting it, and fails if another bundled POM proves X', async () => {
    const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gradle-pom-license-report.json'), 'utf-8'));
    const ehcache = report.dependencies.find((dependency: { moduleName: string }) => dependency.moduleName === 'net.sf.ehcache:ehcache');
    const original = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [ehcache] }));

    expect(original.errors).toEqual([]);
    expect(original.dependencies).toEqual([{ name: 'net.sf.ehcache:ehcache', version: '2.10.9.2', licenses: [[...EHCACHE_LICENSES, 'Unresolved bundled POM license evidence']] }]);
    expect(checkLicenseCompliance(original.dependencies, 'net.sf.ehcache:ehcache').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.UNKNOWN_LICENSE]);

    ehcache.bundledComponents.push({ moduleName: 'example:bundled-x', moduleVersion: '1.0', pomLicenseChain: [{ licenses: [{ name: 'GPL-3.0' }] }] });
    const withX = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [ehcache] }));

    expect(withX.errors).toEqual([]);
    expect(withX.dependencies).toEqual([{ name: 'net.sf.ehcache:ehcache', version: '2.10.9.2', licenses: [[...EHCACHE_LICENSES, 'GPL-3.0', 'Unresolved bundled POM license evidence']] }]);
    expect(checkLicenseCompliance(withX.dependencies, 'net.sf.ehcache:ehcache').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.CATEGORY_X_VIOLATION]);
  });

  it.each([
    ['own POM', [[{ name: 'MIT' }, { name: 'GPL-3.0' }], [{ name: 'Apache-2.0' }]], [['MIT', 'GPL-3.0']], LicenseIssueType.CATEGORY_X_VIOLATION],
    ['nearest parent', [[], [{ name: 'MIT' }], [{ name: 'GPL-3.0' }]], ['MIT'], undefined],
    ['unnamed declaration', [[{ name: '' }], [{ name: 'MIT' }]], ['Unnamed POM license'], LicenseIssueType.UNKNOWN_LICENSE],
    ['no POM declaration', [[], []], [], LicenseIssueType.NO_LICENSE_INFO]
  ])('uses %s declarations, never aggregated manifest or license-file names', async (_case, declarations, licenses, issue) => {
    const report = { dependencies: [{
      moduleName: 'example:artifact', moduleVersion: '1.0',
      moduleLicenses: [{ moduleLicense: 'MIT' }], moduleLicense: 'Apache-2.0',
      pomLicenseChain: (declarations as Array<Array<{ name: string }>>).map(licenses => ({ licenses }))
    }] };
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner(report));

    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([{ name: 'example:artifact', version: '1.0', licenses }]);
    expect(checkLicenseCompliance(result.dependencies, '').issues.map(issue => issue.issueType)).toEqual(issue ? [issue] : []);
  });

  it.each(['POM parent cycle or depth exceeds 32', 'No unique published POM for example:artifact:1.0', 'POM exceeds 1048576 bytes: example:artifact:1.0'])('reports incomplete POM evidence without falling back to the aggregated report: %s', async reason => {
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'example:artifact', moduleVersion: '1.0', moduleLicenses: [{ moduleLicense: 'MIT' }],
      pomLicenseChain: [{ licenses: [] }], pomLicenseError: reason
    }] }));

    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([{ name: 'example:artifact', version: '1.0', licenses: [] }]);
    expect(result.warnings).toEqual([{ source: 'gradle-parser', message: `POM licenses could not be resolved for example:artifact: ${reason}` }]);
    expect(checkLicenseCompliance(result.dependencies, '').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.NO_LICENSE_INFO]);
  });

  it.each([
    ['complete', {}, [['MIT', 'GPL-3.0']], []],
    ['bounded archive', { bundleLicenseError: 'Archive exceeds 50000 entries' }, [['MIT', 'GPL-3.0', 'Unresolved bundled POM license evidence']],
      ['Bundled POM licenses could not be resolved for example:host: Archive exceeds 50000 entries']],
    ['nested archive', { bundleLicenseError: 'Nested archives require manual license review' }, [['MIT', 'GPL-3.0', 'Unresolved bundled POM license evidence']],
      ['Bundled POM licenses could not be resolved for example:host: Nested archives require manual license review']],
    ['missing inventory', { bundledComponents: undefined }, [['MIT', 'Unresolved bundled POM license evidence']],
      ['Bundled POM licenses could not be resolved for example:host: Missing bundled POM inventory']]
  ])('requires bundled licenses in addition to a permissive host: %s', async (_case, extra, licenses, messages) => {
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'example:host', moduleVersion: '1.0', pomLicenseChain: [{ licenses: [{ name: 'MIT' }] }],
      moduleLicenses: [{ moduleLicense: 'MIT' }],
      bundledComponents: [{ moduleName: 'example:bundled', moduleVersion: '2.0', pomLicenseChain: [{ licenses: [{ name: 'GPL-3.0' }] }] }], ...extra
    }] }));

    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([{ name: 'example:host', version: '1.0', licenses }]);
    expect(result.warnings.map(warning => warning.message)).toEqual(messages);
    expect(checkLicenseCompliance(result.dependencies, '').issues.map(issue => issue.issueType)).toEqual([
      _case === 'missing inventory' ? LicenseIssueType.UNKNOWN_LICENSE : LicenseIssueType.CATEGORY_X_VIOLATION
    ]);
  });

  it('keeps known B/X when another component has incomplete evidence, including after Category B is documented', async () => {
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'example:host', moduleVersion: '1.0', pomLicenseChain: [{ licenses: [{ name: 'MIT' }] }],
      bundledComponents: [
        { moduleName: 'example:known', moduleVersion: '2.0', pomLicenseChain: [{ licenses: [{ name: 'GPL-3.0' }, { name: 'EPL-2.0' }] }] },
        { moduleName: 'example:unknown', moduleVersion: '3.0', pomLicenseChain: [], pomLicenseError: 'Unresolved POM coordinates' }
      ]
    }] }));

    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([{ name: 'example:host', version: '1.0', licenses: [
      ['MIT', 'GPL-3.0', 'EPL-2.0', 'Unresolved POM license evidence for example:unknown']
    ] }]);
    expect(result.warnings.map(warning => warning.message)).toEqual(['POM licenses could not be resolved for example:unknown: Unresolved POM coordinates']);
    expect(checkLicenseCompliance(result.dependencies, 'example:host EPL-2.0').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.CATEGORY_X_VIOLATION]);

    const withoutX = result.dependencies.map(dependency => ({ ...dependency, licenses: [['MIT', 'EPL-2.0', 'Unresolved POM license evidence for example:unknown']] }));
    expect(checkLicenseCompliance(withoutX, '').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.UNDOCUMENTED_CATEGORY_B]);
    expect(checkLicenseCompliance(withoutX, 'example:host EPL-2.0').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.UNKNOWN_LICENSE]);
  });

  it('preserves independent configured dual-license choices without offering the host license instead of a required bundle license', async () => {
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'org.javassist:javassist', moduleVersion: '1.0', pomLicenseChain: [{ licenses: [{ name: 'MIT' }, { name: 'GPL-3.0' }] }],
      bundledComponents: [
        { moduleName: 'ch.qos.logback:logback-classic', moduleVersion: '2.0', pomLicenseChain: [{ licenses: [{ name: 'Apache-2.0' }, { name: 'EPL-2.0' }] }] },
        { moduleName: 'example:required', moduleVersion: '3.0', pomLicenseChain: [{ licenses: [{ name: 'GPL-2.0' }] }] }
      ]
    }] }));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.dependencies).toEqual([{ name: 'org.javassist:javassist', version: '1.0', licenses: [
      ['MIT', 'Apache-2.0', 'GPL-2.0'], ['MIT', 'EPL-2.0', 'GPL-2.0'],
      ['GPL-3.0', 'Apache-2.0', 'GPL-2.0'], ['GPL-3.0', 'EPL-2.0', 'GPL-2.0']
    ] }]);
    expect(checkLicenseCompliance(result.dependencies, '').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.CATEGORY_X_VIOLATION]);
  });

  it('retains directly proven X when that component also reports incomplete evidence', async () => {
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'example:host', moduleVersion: '1.0', pomLicenseChain: [{ licenses: [{ name: 'MIT' }] }],
      bundledComponents: [{ moduleName: 'example:bundled', moduleVersion: 'unknown',
        pomLicenseChain: [{ licenses: [{ name: 'GPL-3.0' }] }], pomLicenseError: 'Unresolved POM coordinates' }]
    }] }));

    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([{ name: 'example:host', version: '1.0', licenses: [['MIT', 'GPL-3.0', 'Unresolved POM license evidence']] }]);
    expect(checkLicenseCompliance(result.dependencies, '').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.CATEGORY_X_VIOLATION]);
  });

  it('does not let an ambiguous bundled expression hide an independently proven X', async () => {
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'example:host', moduleVersion: '1.0', pomLicenseChain: [{ licenses: [{ name: 'MIT' }] }],
      bundledComponents: [
        { moduleName: 'example:known', moduleVersion: '2.0', pomLicenseChain: [{ licenses: [{ name: 'GPL-3.0' }] }] },
        { moduleName: 'example:ambiguous', moduleVersion: '3.0', pomLicenseChain: [{ licenses: [{ name: 'MIT OR Apache-2.0' }] }] }
      ]
    }] }));

    expect(result.errors).toEqual([]);
    expect(result.warnings.map(warning => warning.message)).toEqual(['Unresolved POM license expression for example:ambiguous: MIT OR Apache-2.0']);
    expect(result.dependencies).toEqual([{ name: 'example:host', version: '1.0', licenses: [['MIT', 'GPL-3.0', 'Unresolved POM license expression']] }]);
    expect(checkLicenseCompliance(result.dependencies, '').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.CATEGORY_X_VIOLATION]);
  });

  it('uses the nearest license-bearing POM for a bundled component and excludes the host own embedded POM', async () => {
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'example:host', moduleVersion: '1.0', pomLicenseChain: [{ licenses: [{ name: 'MIT' }] }],
      bundledComponents: [
        { moduleName: 'example:host', moduleVersion: '1.0', pomLicenseChain: [{ licenses: [{ name: 'GPL-3.0' }] }] },
        { moduleName: 'example:bundled', moduleVersion: '2.0', pomLicenseChain: [
          { licenses: [] }, { licenses: [{ name: 'BSD-3-Clause' }] }, { licenses: [{ name: 'GPL-3.0' }] }
        ] }
      ]
    }] }));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.dependencies).toEqual([{ name: 'example:host', version: '1.0', licenses: [['MIT', 'BSD-3-Clause']] }]);
    expect(checkLicenseCompliance(result.dependencies, '').issues).toEqual([]);
  });

  it('bounds component evidence while preserving a proven X', async () => {
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'example:host', moduleVersion: '1.0', pomLicenseChain: [{ licenses: [{ name: 'MIT' }] }],
      bundledComponents: Array.from({ length: 129 }, (_, index) => ({
        moduleName: `example:bundled-${index}`, moduleVersion: '2.0', pomLicenseChain: [{ licenses: [{ name: index ? 'MIT' : 'GPL-3.0' }] }]
      }))
    }] }));

    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([{ name: 'example:host', version: '1.0', licenses: [['MIT', 'GPL-3.0', 'Unresolved bundled POM license evidence']] }]);
    expect(result.warnings.map(warning => warning.message)).toEqual(['Bundled POM licenses could not be resolved for example:host: Bundled POMs exceed 128 components']);
    expect(checkLicenseCompliance(result.dependencies, '').issues.map(issue => issue.issueType)).toEqual([LicenseIssueType.CATEGORY_X_VIOLATION]);
  });

  it('bounds license combinations with separate component rows instead of dropping proven X', async () => {
    const ownLicenses = ['MIT', ...Array.from({ length: 127 }, (_, index) => `Unknown-${index}`)];
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'org.javassist:javassist', moduleVersion: '1.0', pomLicenseChain: [{ licenses: ownLicenses.map(name => ({ name })) }],
      bundledComponents: [
        { moduleName: 'ch.qos.logback:logback-classic', moduleVersion: '2.0', pomLicenseChain: [{ licenses: [{ name: 'MIT' }, { name: 'Apache-2.0' }, { name: 'EPL-2.0' }] }] },
        { moduleName: 'example:required', moduleVersion: '3.0', pomLicenseChain: [{ licenses: [{ name: 'GPL-3.0' }] }] }
      ]
    }] }));

    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([
      { name: 'org.javassist:javassist', version: '1.0', licenses: ownLicenses.map(name => [name, 'Unresolved bundled POM license combinations']) },
      { name: 'ch.qos.logback:logback-classic', version: '2.0', licenses: ['MIT', 'Apache-2.0', 'EPL-2.0'] },
      { name: 'example:required', version: '3.0', licenses: ['GPL-3.0'] }
    ]);
    expect(result.warnings.map(warning => warning.message)).toEqual(['Bundled POM license combinations exceed limits for org.javassist:javassist; components reported separately']);
    expect(checkLicenseCompliance(result.dependencies, '').issues.map(issue => [issue.dependency.name, issue.issueType])).toEqual([
      ['org.javassist:javassist', LicenseIssueType.UNKNOWN_LICENSE], ['example:required', LicenseIssueType.CATEGORY_X_VIOLATION]
    ]);
  });

  it.each([
    ['missing provenance', undefined, 'Missing or oversized POM license provenance for example:artifact'],
    ['parent depth limit', Array.from({ length: 33 }, () => ({ licenses: [] })), 'Missing or oversized POM license provenance for example:artifact'],
    ['license count limit', [{ licenses: Array.from({ length: 129 }, () => ({ name: 'MIT' })) }], 'Invalid or oversized POM license declarations for example:artifact'],
    ['license length limit', [{ licenses: [{ name: 'x'.repeat(4097) }] }], 'Invalid or oversized POM license declarations for example:artifact'],
    ['invalid license', [{ licenses: [{ name: null }] }], 'Invalid or oversized POM license declarations for example:artifact']
  ])('diagnoses %s instead of accepting incomplete evidence', async (_case, pomLicenseChain, message) => {
    const result = await getGradleDependencies(repo, undefined, new ReportWritingRunner({ dependencies: [{
      moduleName: 'example:artifact', moduleVersion: '1.0', moduleLicenses: [{ moduleLicense: 'MIT' }], pomLicenseChain
    }] }));

    expect(result.dependencies).toEqual([]);
    expect(result.errors.map(error => error.error?.message)).toEqual([message]);
  });

  it.each([
    ['missing dependency list', {}, 'Gradle license report must list at most 10000 dependencies'],
    ['dependency count limit', { dependencies: Array(10001).fill({}) }, 'Gradle license report must list at most 10000 dependencies'],
    ['invalid dependency', { dependencies: [{}] }, 'Gradle license report contains an invalid dependency'],
    ['report size limit', ' '.repeat(16 * 1024 * 1024 + 1), 'Gradle license report exceeds 16777216 bytes']
  ])('diagnoses %s', async (_case, report, message) => {
    const runner = new ReportWritingRunner(report);
    const result = await getGradleDependencies(repo, undefined, runner);

    expect(result.dependencies).toEqual([]);
    expect(result.errors.map(error => error.error?.message)).toEqual([message]);
    expect(fs.existsSync(runner.reportDir!)).toBe(false);
  });

  it('scales linearly while scanning POM provenance and license text', async () => {
    const license = 'a '.repeat(1000).trim();
    const result = await expectLinearTime(200, size => JSON.stringify({ dependencies: Array.from({ length: size }, (_, index) => ({
      moduleName: `example:artifact-${index}`, moduleVersion: '1.0',
      bundledComponents: [{ moduleName: 'example:bundled', moduleVersion: '2.0', pomLicenseChain: [{ licenses: [{ name: 'MIT' }] }] }],
      pomLicenseChain: [{ licenses: [] }, { licenses: [{ name: license }] }]
    })) }), report => getGradleDependencies(repo, undefined, new ReportWritingRunner(report)));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.dependencies).toEqual(Array.from({ length: 800 }, (_, index) => ({
      name: `example:artifact-${index}`, version: '1.0', licenses: [[license, 'MIT']]
    })));
  });

  it('ignores a service/ symlink that leads outside the repository', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle-parser-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'build.gradle'), '');
      fs.symlinkSync(outside, path.join(repo, 'service'));

      expect(await hasGradleProject(repo)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
