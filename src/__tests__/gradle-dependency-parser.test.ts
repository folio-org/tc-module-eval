import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGradleDependencies, hasGradleProject } from '../utils/parsers/gradle-dependency-parser';
import { CommandExecutionRequest, CommandExecutionResult, CommandRunner, LicenseIssueType } from '../types';
import { checkLicenseCompliance } from '../utils/license-compliance';
import { NoopLogger, resetLogger, setLogger } from '../utils/logger';

// Report entries as written by jk1's JsonReportRenderer: with onlyOneLicensePerModule=false
// (`moduleLicenses`, which the evaluator's init script requests) and with the default true (`moduleLicense`).
// Javassist and jersey-common come from jk1 3.1.4 with the init script's unionParentPomLicenses=false.
const JK1_REPORT = {
  dependencies: [
    {
      moduleName: 'org.javassist:javassist',
      moduleVersion: '3.30.2-GA',
      moduleUrls: ['https://www.javassist.org/'],
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
      moduleLicenses: [
        { moduleLicense: 'Eclipse Public License - v 1.0', moduleLicenseUrl: 'http://www.eclipse.org/legal/epl-v10.html' },
        { moduleLicense: 'GNU Lesser General Public License', moduleLicenseUrl: 'http://www.gnu.org/licenses/old-licenses/lgpl-2.1.html' }
      ]
    },
    {
      moduleName: 'com.github.ben-manes.caffeine:caffeine',
      moduleVersion: '2.9.3',
      moduleUrls: [],
      moduleLicenses: [
        { moduleLicense: null, moduleLicenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0' },
        { moduleLicense: '  Apache License, Version 2.0 ', moduleLicenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt' }
      ]
    },
    {
      moduleName: 'javax.servlet:javax.servlet-api',
      moduleVersion: '4.0.1',
      moduleUrls: [],
      moduleLicenses: [
        { moduleLicense: 'CDDL + GPLv2 with classpath exception', moduleLicenseUrl: 'https://oss.oracle.com/licenses/CDDL+GPL-1.1' },
        { moduleLicense: 'COMMON DEVELOPMENT AND DISTRIBUTION LICENSE (CDDL) Version 1.0', moduleLicenseUrl: 'https://opensource.org/licenses/CDDL-1.0' }
      ]
    },
    { moduleName: 'com.k_int.okapi:grails-okapi', moduleVersion: '8.1.1', moduleUrls: [], moduleLicenses: [] },
    {
      moduleName: 'org.example:dual',
      moduleVersion: '1.0',
      moduleUrls: [],
      moduleLicenses: [{ moduleLicense: '(MIT) AND (GPL-3.0)', moduleLicenseUrl: null }]
    },
    {
      moduleName: 'org.postgresql:postgresql',
      moduleUrl: 'https://jdbc.postgresql.org',
      moduleVersion: '42.7.11',
      moduleLicense: 'BSD-2-Clause',
      moduleLicenseUrl: 'https://jdbc.postgresql.org/about/license.html'
    }
  ],
  importedModules: []
};

class ReportWritingRunner implements CommandRunner {
  request?: CommandExecutionRequest;
  initScript?: string;
  reportDir?: string;

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
    fs.writeFileSync(path.join(reportDir, 'index.json'), JSON.stringify(JK1_REPORT));
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

  it('applies the license report plugin in service/ and parses every license from the jk1 JSON report, normalized, as licenses that all apply unless the module is known to be dual-licensed', async () => {
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
