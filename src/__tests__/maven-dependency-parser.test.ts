import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getMavenDependencies } from '../utils/parsers/maven-dependency-parser';
import { CommandExecutionRequest, CommandExecutionResult, CommandRunner, LicenseIssueType } from '../types';
import { checkLicenseCompliance } from '../utils/license-compliance';
import { NoopLogger, resetLogger, setLogger } from '../utils/logger';

// Lines as license-maven-plugin's third-party-file.ftl writes them, taken from the
// THIRD-PARTY.txt files of folio-org/mod-search, mod-users and mod-inventory-storage and of a
// project depending on logback-classic, plus the template's "Unknown license" and "no url defined"
// fallbacks on a line that ends in CRLF.
const THIRD_PARTY = `
Lists of 8 third-party dependencies.
     (Unknown license) mod-example (org.folio:mod-example:1.0.0 - no url defined)\r
     (Apache License, Version 2.0) LZ4 Java Compression (at.yawk.lz4:lz4-java:1.10.1 - https://github.com/yawkat/lz4-java)
     (Apache-2.0) (LGPL-2.1-or-later) Java Native Access (net.java.dev.jna:jna:5.16.0 - https://github.com/java-native-access/jna)
     (Apache License 2.0) (LGPL 2.1) (MPL 1.1) Javassist (org.javassist:javassist:3.30.2-GA - https://www.javassist.org/)
     (Apache License, 2.0) (EPL 2.0) (The GNU General Public License (GPL), Version 2, With Classpath Exception) jersey-media-json-jackson (org.glassfish.jersey.media:jersey-media-json-jackson:2.48 - https://projects.eclipse.org/projects/ee4j.jersey/project/jersey-media-json-jackson)
     (Apache License, Version 2.0) Byte Buddy (without dependencies) (net.bytebuddy:byte-buddy:1.18.11 - https://bytebuddy.net/byte-buddy)
     (Eclipse Public License - v 1.0) (GNU Lesser General Public License) Logback Classic Module (ch.qos.logback:logback-classic:1.5.18 - http://logback.qos.ch/logback-classic)
     (Apache License, 2.0) (EPL 2.0) (Public Domain) (The GNU General Public License (GPL), Version 2, With Classpath Exception) jersey-core-common (org.glassfish.jersey.core:jersey-common:2.48 - https://projects.eclipse.org/projects/ee4j.jersey/jersey-common)
`;

class SuccessRunner implements CommandRunner {
  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify(request);
  }

  async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    return {
      identity: this.normalize(request),
      command: request.command,
      args: request.args ?? [],
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

describe('getMavenDependencies', () => {
  let repo: string;

  const parse = (thirdParty: string) => {
    fs.mkdirSync(path.join(repo, 'target', 'licenses'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'target', 'licenses', 'THIRD-PARTY.txt'), thirdParty);
    return getMavenDependencies(repo, undefined, new SuccessRunner());
  };

  beforeEach(() => {
    setLogger(new NoopLogger());
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'maven-parser-'));
    fs.writeFileSync(path.join(repo, 'pom.xml'), '<project><packaging>jar</packaging></project>');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    resetLogger();
  });

  it('reads the licenses of a known dual-licensed dependency as alternatives, and other license lists as licenses that all apply', async () => {
    const result = await parse(THIRD_PARTY);

    expect(result.errors).toEqual([]);
    expect(result.dependencies).toEqual([
      { name: 'org.folio:mod-example', version: '1.0.0', licenses: ['Unknown'] },
      { name: 'at.yawk.lz4:lz4-java', version: '1.10.1', licenses: ['Apache License 2.0'] },
      { name: 'net.java.dev.jna:jna', version: '5.16.0', licenses: ['Apache-2.0', 'LGPL-2.1+'] },
      { name: 'org.javassist:javassist', version: '3.30.2-GA', licenses: ['Apache License 2.0', 'LGPL-2.1', 'MPL-1.1'] },
      {
        // Jersey's POM lists Apache-2.0 for its bundled Jackson JAX-RS providers, next to Jersey's own licenses.
        name: 'org.glassfish.jersey.media:jersey-media-json-jackson',
        version: '2.48',
        licenses: [['Apache-2.0', 'EPL-2.0', 'GPL-2.0-only WITH Classpath-exception-2.0']]
      },
      { name: 'net.bytebuddy:byte-buddy', version: '1.18.11', licenses: ['Apache License 2.0'] },
      { name: 'ch.qos.logback:logback-classic', version: '1.5.18', licenses: ['EPL-1.0', 'GNU Lesser General Public License'] },
      {
        name: 'org.glassfish.jersey.core:jersey-common',
        version: '2.48',
        licenses: [['Apache-2.0', 'EPL-2.0', 'Public Domain', 'GPL-2.0-only WITH Classpath-exception-2.0']]
      }
    ]);

    // Jersey's own code is EPL-2.0 or GPL-2.0 with Classpath exception, so the bundled components'
    // Category A licenses do not let it pass; JNA and Javassist pass under their Apache-2.0 choice.
    const issues = checkLicenseCompliance(result.dependencies, 'README').issues
      .map(issue => [issue.dependency.name, issue.issueType]);
    expect(issues).toEqual([
      ['org.folio:mod-example', LicenseIssueType.UNKNOWN_LICENSE],
      ['org.glassfish.jersey.media:jersey-media-json-jackson', LicenseIssueType.UNDOCUMENTED_CATEGORY_B],
      ['ch.qos.logback:logback-classic', LicenseIssueType.UNKNOWN_LICENSE],
      ['org.glassfish.jersey.core:jersey-common', LicenseIssueType.UNDOCUMENTED_CATEGORY_B]
    ]);
  });

  it('reports dependency lines it cannot read instead of leaving the dependencies out', async () => {
    const unreadable = '(Apache License, Version 2.0 LZ4 Java Compression (at.yawk.lz4:lz4-java:1.10.1 - https://github.com/yawkat/lz4-java)';
    // Takes over 10 seconds to reject if the coordinate pattern backtracks over runs of colons.
    const longColonRun = `(MIT) Foo (${'a:'.repeat(3000)})`;

    const started = Date.now();
    const result = await parse(`${THIRD_PARTY}     ${unreadable}\n     ${longColonRun}\n`);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.dependencies).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({
      source: 'maven-parser',
      message: `Maven could not list the dependencies: ${path.join('target', 'licenses', 'THIRD-PARTY.txt')} has 2 dependency lines ` +
        `that could not be read, so the dependency list is incomplete. First unreadable line: ${unreadable}`
    })]);
  });
});
