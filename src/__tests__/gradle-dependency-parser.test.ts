import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGradleDependencies, hasGradleProject } from '../utils/parsers/gradle-dependency-parser';
import { CommandExecutionRequest, CommandExecutionResult, CommandRunner } from '../types';
import { NoopLogger, resetLogger, setLogger } from '../utils/logger';

// Report entries as written by jk1's JsonReportRenderer: with onlyOneLicensePerModule=false
// (`moduleLicenses`, which the evaluator's init script requests) and with the default true (`moduleLicense`).
const JK1_REPORT = {
  dependencies: [
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

  it('applies the license report plugin in service/ and parses every license from the jk1 JSON report, normalized', async () => {
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
    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([
      {
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
