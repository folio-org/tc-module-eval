import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { CriterionResult, EvaluationStatus, RemoteLookups, S011Analysis } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { SONAR_SCOPE_SETTING_KEYS } from '../utils/sonarcloud-snapshot';
import { SONARCLOUD_KEPT_FIELDS, sonarCloudEndpoint } from '../tools/sonarcloud-fixture-trim';
import { loadRemoteFixture, RecordedResponses, replayTransport } from './helpers/remote-replay';

class TestEvaluator extends SharedEvaluator {}

// Recorded from SonarCloud by `yarn capture:remote-fixtures --sonar <checkout>`; each at the commit below.
const MOD_SEARCH = loadRemoteFixture('sonarcloud-mod-search');
const MOD_USERS = loadRemoteFixture('sonarcloud-mod-users');
const MOD_AGREEMENTS = loadRemoteFixture('sonarcloud-mod-agreements');
const UI_AGREEMENTS = loadRemoteFixture('sonarcloud-ui-agreements');
const COMMITS: Record<string, string> = {
  'mod-search': '187df603d24a8e01115dc80085da6760ed3d2853',
  'mod-users': '81dc3f46cec3b8950585f9c71a7f7bbee5eceddf',
  'mod-agreements': '2f6bd141ee5ff9254136693970c26746619669fe',
  'ui-agreements': '802a80e929f1b8ef2cb65aa3685bb4434599754a'
};

/** The recorded responses with the one whose URL contains `fragment` replaced (or removed, for undefined). */
function patched(responses: RecordedResponses, fragment: string, replace: (body: any) => { status: number; body: unknown } | undefined): RecordedResponses {
  const keys = Object.keys(responses).filter(url => url.includes(fragment));
  expect(keys).toHaveLength(1);
  const copy = { ...responses };
  const next = replace(JSON.parse(JSON.stringify(responses[keys[0]].body)));
  if (next) copy[keys[0]] = next;
  else delete copy[keys[0]];
  return copy;
}

function withMeasures(responses: RecordedResponses, project: string, measures: Record<string, string>): RecordedResponses {
  return patched(responses, 'measures/component', body => ({
    status: 200,
    body: { component: { ...body.component, key: `org.folio:${project}`, measures: Object.entries(measures).map(([metric, value]) => ({ metric, value })) } }
  }));
}

/**
 * Lookups whose JSON answers record every field the evaluator reads, as `endpoint path` (array elements are
 * `[]`). Fields read but absent count too, so a read of a field the fixture trim drops is caught on trimmed
 * fixtures as well.
 */
function recordingReads(inner: RemoteLookups, reads: Set<string>): RemoteLookups {
  const watch = (value: unknown, endpoint: string, path: string): unknown => {
    if (!value || typeof value !== 'object') return value;
    const nested = (property: string) => Array.isArray(value) ? `${path}[]` : path ? `${path}.${property}` : property;
    return new Proxy(value as object, {
      // Listing an object's keys (Object.keys, spread, JSON.stringify) reads all of them.
      ownKeys(target) {
        if (!Array.isArray(target)) reads.add(`${endpoint} ${nested('*')}`);
        return Reflect.ownKeys(target);
      },
      has(target, property) {
        if (typeof property === 'string' && !Array.isArray(target)) reads.add(`${endpoint} ${nested(property)}`);
        return Reflect.has(target, property);
      },
      get(target, property, receiver) {
        const result = Reflect.get(target, property, receiver);
        if (typeof property === 'symbol') return result;
        const isArray = Array.isArray(target);
        if (isArray && !/^\d+$/.test(property)) return result;
        if (!isArray && !Object.prototype.hasOwnProperty.call(target, property) && property in Object.prototype) return result;
        const next = nested(property);
        reads.add(`${endpoint} ${next}`);
        return watch(result, endpoint, next);
      }
    });
  };
  return {
    records: inner.records,
    async getJson(url: string) {
      const answer = await inner.getJson(url);
      const endpoint = sonarCloudEndpoint(url);
      return answer.ok && endpoint ? { ...answer, json: watch(answer.json, endpoint, '') } : answer;
    }
  };
}

/** mod-users' responses with SonarCloud confirming that the token administers the project, and these project settings. */
function admin(responses: RecordedResponses, settings: unknown[], settingsResponse?: { status: number; body: unknown }): RecordedResponses {
  const params = new URLSearchParams({ component: 'org.folio:mod-users', keys: SONAR_SCOPE_SETTING_KEYS.join(',') });
  return {
    ...patched(responses, 'navigation/component', body => ({ status: 200, body: { ...body, configuration: { showSettings: true } } })),
    [`https://sonarcloud.io/api/settings/values?${params}`]: settingsResponse ?? { status: 200, body: { settings } }
  };
}

/** Without the rule-name lookup, for a repository with no suppressions. */
function clean(responses: RecordedResponses): RecordedResponses {
  return patched(responses, 'rules/search', () => undefined);
}

// mod-users' own suppressions, so the rule-name lookup asks for the same rules it was recorded with.
const MOD_USERS_FILES: Record<string, string> = {
  'src/main/java/org/folio/support/ProfilePictureHelper.java': `package org.folio.support;
public class ProfilePictureHelper {
  @SuppressWarnings("java:S5542")
  public static byte[] encrypt(byte[] data) { return data; }

  // AES/ECB is required by the stored format, see MODUSERS-1
  @SuppressWarnings("java:S5542")
  public static byte[] decrypt(byte[] data) { return data; }
}
`,
  'src/main/java/org/folio/rest/utils/BeanUtilsExtended.java': `package org.folio.rest.utils;
@SuppressWarnings({"java:S3011", "unchecked"})
public class BeanUtilsExtended {
  /**
   * Copies properties.
   */
  @SuppressWarnings("java:S3776")
  private static void copy(Object source) {}
}
`,
  'src/test/java/org/folio/rest/impl/CustomFieldIT.java': `class CustomFieldIT {
  @SuppressWarnings("squid:S2699")
  void runs() {}
}
`
};

describe('S011 SonarQube findings', () => {
  // Every field the tests below read from SonarCloud. The fixtures are trimmed by `yarn capture:remote-fixtures`,
  // so a field read here but dropped by the trim would make a recorded fixture answer differently from
  // SonarCloud. Checked after any order or subset of the tests.
  const reads = new Set<string>();
  afterAll(() => {
    const kept = (endpoint: string, path: string) => {
      const fields = SONARCLOUD_KEPT_FIELDS[endpoint];
      return !fields || fields.some(field => path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[]`)
        || (!path.endsWith('*') && (field.startsWith(`${path}.`) || field.startsWith(`${path}[]`))));
    };
    expect([...reads].filter(read => !kept(read.split(' ')[0], read.split(' ')[1]))).toEqual([]);
  });
  let root: string;
  let unrecorded: string[];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 's011-'));
    unrecorded = [];
  });
  afterEach(async () => {
    await fs.remove(root);
    expect(unrecorded).toEqual([]);
  });

  async function repo(name: string, files: Record<string, string> = {}): Promise<string> {
    const directory = path.join(root, name);
    await fs.ensureDir(directory);
    for (const [file, content] of Object.entries(files)) await fs.outputFile(path.join(directory, file), content);
    return directory;
  }

  async function evaluate(
    directory: string,
    options: { responses?: RecordedResponses; lookups?: (inner: RemoteLookups) => RemoteLookups; commit?: string | null; branch?: string } = {}
  ): Promise<CriterionResult & { criterionDetails: S011Analysis; requested: string[] }> {
    const name = path.basename(directory);
    const replay = options.responses ? replayTransport(options.responses) : undefined;
    const run = createEvaluationRun({
      repositoryPath: directory,
      repositoryName: name,
      language: 'java',
      criteriaFilter: ['S011'],
      repositoryCommit: options.commit === null ? undefined : options.commit ?? COMMITS[name],
      requestedBranch: options.branch,
      remoteLookups: replay && recordingReads(options.lookups ? options.lookups(replay.transport) : replay.transport, reads)
    });
    const result = await new TestEvaluator('java').evaluateCriterion('S011', directory, run);
    unrecorded.push(...(replay?.unrecorded ?? []));
    return { ...result, criterionDetails: result.criterionDetails as S011Analysis, requested: replay?.requested ?? [] };
  }

  describe('on recorded SonarCloud projects', () => {
    it('reads issue and hotspot fields the fixture trim keeps', async () => {
      await evaluate(await repo('mod-search'), { responses: MOD_SEARCH });

      expect([...reads]).toEqual(expect.arrayContaining([
        'issues/search issues[].component', 'issues/search issues[].impacts', 'issues/search issues[].rule',
        'hotspots/search hotspots[].ruleKey', 'qualityprofiles/search profiles[].isDefault'
      ]));
    });

    it('fails mod-search on its high issues and unreviewed hotspots, counting test code and impact severities', async () => {
      const result = await evaluate(await repo('mod-search', {
        'pom.xml': `<project><properties>
    <!-- <sonar.exclusions>commented/**</sonar.exclusions> -->
    <sonar.exclusions>
      src/main/java/org/folio/search/model/**
    </sonar.exclusions>
  </properties></project>`,
        'src/main/java/org/folio/search/StagingMigrationService.java': '@SuppressWarnings("java:S2077")\npublic class StagingMigrationService {}\n',
        'src/main/java/org/folio/search/utils/ShaUtils.java': 'class ShaUtils {\n  String sha(String v) {\n    return sha1Hex(v); // NOSONAR\n  }\n}\n'
      }), { responses: MOD_SEARCH });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe('S011 fail: SonarCloud reports 28 open issues of high or blocker severity and 18 security hotspots that nobody has reviewed. Duplication is 1.2%, under the 3% limit.');
      expect(result.details).toContain([
        'SonarCloud analysis:',
        '  - Project: org.folio:mod-search, branch master',
        '  - Analysis: 2026-10-15, commit 187df60 (the commit evaluated here)',
        'Security:',
        '  - Open security issues: none',
        '  - Security hotspots to review: 18 (18 high probability: sql injection)',
        'High or blocker issues: 28 open (24 in main code, 4 in test code)',
        '  - java:S3749 "Members of Spring components should be injected": 11',
        // A BLOCKER reliability impact on a rule whose legacy severity is MAJOR still counts.
        '  - javabugs:S2259 "A NULL object should not be accessed": 7'
      ].join('\n'));
      expect(result.details).toContain('  - 1 suppression of java:S2077 "SQL queries should not be dynamically formatted" with no comment explaining why [class level, security rule], for example src/main/java/org/folio/search/StagingMigrationService.java:1');
      expect(result.details).toContain('  - 1 NOSONAR comment, which FOLIO guidance says not to use, for example src/main/java/org/folio/search/utils/ShaUtils.java:3');
      expect(result.details).toContain('  - Files excluded from analysis (sonar.exclusions, pom.xml:3): src/main/java/org/folio/search/model/**');
      expect(result.details).not.toContain('commented/**');
      expect(result.details).toContain('  - Exclusions set in SonarCloud\'s project settings could not be read without a SonarCloud admin token.');
      // SonarCloud answers settings/values anonymously with an empty list, which proves nothing; it is not asked.
      expect(result.requested.some(url => url.includes('settings/values'))).toBe(false);
      expect(result.criterionDetails.remoteEvidence.map(record => record.sha256)).toEqual(expect.arrayContaining([expect.stringMatching(/^sha256:/)]));
    });

    it('fails ui-agreements on security issues, hotspots of any probability and duplication', async () => {
      const result = await evaluate(await repo('ui-agreements', { 'package.json': '{"name":"@folio/agreements"}' }), { responses: UI_AGREEMENTS });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe('S011 fail: SonarCloud reports 2 open security issues, 10 open issues of high or blocker severity, 62 security hotspots that nobody has reviewed and 36.8% duplicated lines, over the 3% limit.');
    });

    it('leaves mod-users manual for its suppressions and flags the security rule suppressed without a comment', async () => {
      const result = await evaluate(await repo('mod-users', MOD_USERS_FILES), { responses: MOD_USERS });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('S011 manual: SonarCloud found no security issues, no high or blocker issues, no security hotspots to review and 0.0% duplication, but the module has 5 suppressions of Sonar rules in its code. A reviewer must decide whether each is justified.');
      expect(result.details).toContain('  - 2 suppressions of java:S5542 "Encryption algorithms should be used with secure mode and padding scheme", 1 with no comment explaining why [security rule], for example src/main/java/org/folio/support/ProfilePictureHelper.java:3');
      // squid: is the old prefix of java: rules; its name is looked up under the current key.
      expect(result.details).toContain('  - 1 suppression of squid:S2699 "Tests should include assertions" with no comment explaining why, for example src/test/java/org/folio/rest/impl/CustomFieldIT.java:2');
      // Javadoc describes the method, not the suppression.
      expect(result.details).toContain('  - 1 suppression of java:S3776 "Cognitive Complexity of methods should not be too high" with no comment explaining why, for example');
      expect(result.details).toContain('  - 1 suppression of java:S3011 "Reflection should not be used to increase accessibility of classes, methods, or fields" with no comment explaining why [class level]');
      expect(result.criterionDetails.reviewGroups.map(group => group.id)).toEqual([
        'suppression:java:S3011:src/main/java/org/folio/rest/utils/BeanUtilsExtended.java',
        'suppression:java:S3776:src/main/java/org/folio/rest/utils/BeanUtilsExtended.java',
        'suppression:java:S5542:src/main/java/org/folio/support/ProfilePictureHelper.java',
        'suppression:squid:S2699:src/test/java/org/folio/rest/impl/CustomFieldIT.java'
      ]);
      expect(result.criterionDetails.reviewGroups[2]).toMatchObject({ lines: [3, 7], comments: ['AES/ECB is required by the stored format, see MODUSERS-1'], flags: ['security rule', 'no comment'] });
    });

    it('explains a missing project from the Gradle workflow, which does not run SonarCloud', async () => {
      const result = await evaluate(await repo('mod-agreements', {
        '.github/workflows/gradle.yml': 'jobs:\n  gradle:\n    uses: folio-org/.github/.github/workflows/gradle.yml@v1\n'
      }), { responses: MOD_AGREEMENTS });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('S011 manual: SonarCloud has no project for this module (org.folio:mod-agreements). Its CI uses FOLIO\'s gradle.yml workflow, which does not run SonarCloud, so the security, severity, and duplication checks could not be made.');
    });
  });

  it('is manual without remote lookups, still listing the suppressions it found', async () => {
    const result = await evaluate(await repo('mod-users', MOD_USERS_FILES));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('S011 manual: Not checked: remote lookups are off. Rerun with --allow-remote-lookups to read the module\'s SonarCloud analysis. The repository has 5 suppressions of Sonar rules, listed below for a reviewer.');
    expect(result.details).toContain('What to do: Rerun with --allow-remote-lookups');
    expect(result.details).toContain('  - 1 suppression of squid:S2699 with no comment explaining why');
  });

  describe('freshness', () => {
    it('does not fail a stale analysis even when it has failing findings', async () => {
      const result = await evaluate(await repo('mod-search'), { responses: MOD_SEARCH, commit: 'a'.repeat(40) });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('S011 manual: SonarCloud\'s latest analysis of branch master (2026-10-15) is of commit 187df60, not the evaluated commit aaaaaaa, so its findings may not apply. Rerun once SonarCloud has analysed the evaluated commit, or check SonarCloud by hand.');
    });

    it('treats an unknown evaluated commit as stale', async () => {
      const result = await evaluate(await repo('mod-search'), { responses: MOD_SEARCH, commit: null });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('the evaluated commit is not known');
    });

    it('is manual when SonarCloud re-analyses while the answers are being read', async () => {
      let analyses = 0;
      const result = await evaluate(await repo('mod-search'), {
        responses: MOD_SEARCH,
        lookups: inner => ({
          records: inner.records,
          async getJson(url: string) {
            const answer = await inner.getJson(url);
            if (!url.includes('project_analyses/search') || ++analyses === 1 || !answer.ok) return answer;
            const json = JSON.parse(JSON.stringify(answer.json));
            json.analyses[0] = { ...json.analyses[0], key: 'newer-analysis', date: '2026-10-16T08:00:00+0000' };
            return { ...answer, json };
          }
        })
      });

      expect(analyses).toBe(2);
      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('SonarCloud analysed the project again while the tool was reading it (2026-10-15 and 2026-10-16)');
    });

    it('is manual when SonarCloud is still processing an analysis of the branch', async () => {
      const responses = patched(MOD_SEARCH, 'ce/component', body => ({ status: 200, body: { ...body, queue: [{ status: 'IN_PROGRESS', branch: 'master' }] } }));
      const result = await evaluate(await repo('mod-search'), { responses });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('SonarCloud was processing a new analysis of branch master while the tool was reading it');
    });

    it('is manual when it cannot confirm SonarCloud did not re-analyse, and ignores tasks for other branches', async () => {
      const otherBranch = patched(MOD_SEARCH, 'ce/component', body => ({ status: 200, body: { ...body, queue: [{ status: 'PENDING', branch: 'release-1' }, { status: 'PENDING', pullRequest: '12' }] } }));
      const unreadable = patched(MOD_SEARCH, 'ce/component', () => ({ status: 403, body: {} }));

      expect((await evaluate(await repo('mod-search'), { responses: otherBranch })).status).toBe(EvaluationStatus.FAIL);
      const result = await evaluate(await repo('mod-search'), { responses: unreadable });
      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('could not confirm that SonarCloud did not re-analyse the project');
    });

    it('reads a requested branch SonarCloud has, sending it on every branch request', async () => {
      const onFeature = Object.fromEntries(Object.entries(MOD_SEARCH).map(([url, response]) => [url.replace('&branch=master', '&branch=feature-x'), response]));
      const responses = patched(onFeature, 'project_branches/list', body => ({ status: 200, body: { branches: [...body.branches, { name: 'feature-x', isMain: false }] } }));
      const result = await evaluate(await repo('mod-search'), { responses, branch: 'feature-x' });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.details).toContain('  - Project: org.folio:mod-search, branch feature-x');
      // The two analysis reads, measures, four issue queries and two hotspot queries.
      expect(result.requested.filter(url => url.includes('branch=feature-x'))).toHaveLength(9);
      expect(result.requested.some(url => url.includes('branch=master'))).toBe(false);
    });

    it('reads the main branch when SonarCloud has no analysis of the requested one, and says so', async () => {
      const result = await evaluate(await repo('mod-search'), { responses: MOD_SEARCH, branch: 'feature-x' });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.requested.every(url => !url.includes('feature-x'))).toBe(true);
      expect(result.details).toContain('  - SonarCloud has no analysis of branch feature-x, so the main branch was read');
    });
  });

  describe('rules', () => {
    it('allows exactly 3.0% duplication and fails 3.1%', async () => {
      const directory = await repo('mod-users');
      const at = await evaluate(directory, { responses: withMeasures(MOD_USERS, 'mod-users', { duplicated_lines_density: '3.0' }) });
      const over = await evaluate(directory, { responses: withMeasures(MOD_USERS, 'mod-users', { duplicated_lines_density: '3.1' }) });

      expect(at.status).toBe(EvaluationStatus.MANUAL);
      expect(at.evidence).toContain('3.0% duplication');
      expect(over.status).toBe(EvaluationStatus.FAIL);
      expect(over.evidence).toBe('S011 fail: SonarCloud reports 3.1% duplicated lines, over the 3% limit.');
    });

    it('fails on a security issue of low severity', async () => {
      const security = patched(MOD_USERS, 'impactSoftwareQualities=SECURITY', body => ({
        status: 200,
        body: { ...body, paging: { ...body.paging, total: 1 }, issues: [{
          rule: 'java:S4790', component: 'org.folio:mod-users:src/main/java/Hash.java', line: 4,
          impacts: [{ softwareQuality: 'SECURITY', severity: 'LOW' }]
        }] }
      }));
      const result = await evaluate(await repo('mod-users'), { responses: {
        ...patched(security, 'rules/search', () => undefined),
        'https://sonarcloud.io/api/rules/search?organization=folio-org&rule_keys=java%3AS4790&f=name&ps=100': {
          status: 200, body: { rules: [{ key: 'java:S4790', name: 'Using weak hashing algorithms is security-sensitive', type: 'SECURITY_HOTSPOT' }] }
        }
      } });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe('S011 fail: SonarCloud reports 1 open security issue. Duplication is 0.0%, under the 3% limit.');
      expect(result.details).toContain('    - java:S4790 "Using weak hashing algorithms is security-sensitive" (low) at src/main/java/Hash.java:4');
    });

    it('never reads a missing duplication figure as zero, yet still fails on a violation it can prove', async () => {
      const users = await evaluate(await repo('mod-users'), { responses: withMeasures(MOD_USERS, 'mod-users', { coverage: '91.2' }) });
      const search = await evaluate(await repo('mod-search'), { responses: withMeasures(MOD_SEARCH, 'mod-search', { coverage: '94.9' }) });

      expect(users.status).toBe(EvaluationStatus.MANUAL);
      expect(users.evidence).toContain('SonarCloud did not report duplication, so the tool cannot confirm there are none.');
      expect(users.details).toContain('Duplication: not reported (limit 3%)');
      expect(search.status).toBe(EvaluationStatus.FAIL);
      expect(search.evidence).toContain('SonarCloud did not report duplication.');
    });

it('fails on an open vulnerability even when no issue has a security impact', async () => {
      const responses = patched(MOD_USERS, 'types=VULNERABILITY', body => ({ status: 200, body: { ...body, paging: { ...body.paging, total: 1 } } }));
      const result = await evaluate(await repo('mod-users'), { responses: clean(responses) });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('SonarCloud reports 1 open security issue.');
    });

    it.each([
      ['an issue accepted in SonarCloud', 'issueStatuses=ACCEPTED', (body: any) => ({ ...body, paging: { ...body.paging, total: 1 } }),
        '1 issue is accepted or marked false positive in SonarCloud'],
      ['a hotspot closed by review', 'status=REVIEWED', (body: any) => ({ ...body, paging: { ...body.paging, total: 2 } }),
        '2 security hotspots were reviewed as safe or fixed in SonarCloud but still found by analysis'],
      ['a quality profile that is not the organization default', 'qualityprofiles/search', (body: any) => ({
        profiles: body.profiles.map((profile: any) => profile.language === 'java' ? { ...profile, name: 'Lenient', isDefault: false } : profile)
      }), 'the project uses a quality profile other than the organization default (Lenient for java)']
    ])('is manual, not a pass, for %s', async (_name, fragment, change, reason) => {
      const result = await evaluate(await repo('mod-users'), {
        responses: admin(clean(patched(MOD_USERS, fragment, body => ({ status: 200, body: change(body) }))), [])
      });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain(reason);
    });


    it('still fails on proven findings when the measures cannot be read', async () => {
      const result = await evaluate(await repo('mod-search'), { responses: patched(MOD_SEARCH, 'measures/component', () => ({ status: 503, body: 'down' })) });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('SonarCloud did not report duplication.');
    });

    it('does not claim "no security issues" when only one of the two security counts was read', async () => {
      const responses = patched(MOD_USERS, 'impactSoftwareQualities=SECURITY', () => ({ status: 503, body: 'down' }));
      const result = await evaluate(await repo('mod-users'), { responses: clean(responses) });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).not.toContain('no security issues');
      expect(result.evidence).toContain('SonarCloud did not report open security issues');
    });

    it('is manual when an issue count cannot be read', async () => {
      const responses = patched(MOD_USERS, 'impactSeverities=HIGH', () => ({ status: 503, body: 'unavailable' }));
      const result = await evaluate(await repo('mod-users'), { responses });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('SonarCloud did not report open high or blocker issues, so the tool cannot confirm there are none.');
    });
  });

  describe('SonarCloud project settings', () => {

    it('stays manual for a clean module when the token cannot administer the project', async () => {
      const result = await evaluate(await repo('mod-users'), { responses: clean(MOD_USERS) });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('S011 manual: SonarCloud found no security issues, no high or blocker issues, no security hotspots to review and 0.0% duplication, and nothing is ignored in the repository or CI. Exclusions set in SonarCloud\'s project settings could not be read without a SonarCloud admin token, so a reviewer must check them (Administration > Analysis Scope).');
    });

    it('passes a clean module only when SonarCloud confirms the token administers the project and its settings are empty', async () => {
      const result = await evaluate(await repo('mod-users'), { responses: admin(clean(MOD_USERS), [
        { key: 'sonar.exclusions', values: ['**/*.md'], inherited: true, parentOrigin: 'INSTANCE' }
      ]) });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toBe('S011 pass: SonarCloud found no security issues, no high or blocker issues, no security hotspots to review and 0.0% duplication on the evaluated commit, and nothing is ignored in the repository, its CI or SonarCloud\'s project settings.');
    });

    it('is manual when the project settings exclude code', async () => {
      const result = await evaluate(await repo('mod-users'), { responses: admin(clean(MOD_USERS), [
        { key: 'sonar.exclusions', values: ['src/main/java/legacy/**'], inherited: false }
      ]) });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('SonarCloud\'s project settings set 1 analysis-scope value');
      expect(result.details).toContain('  - SonarCloud project settings: sonar.exclusions = src/main/java/legacy/** (project)');
    });

    it.each([
      ['a project-level value inherited from the organization', [{ key: 'sonar.exclusions', values: ['src/legacy/**'], inherited: true, parentOrigin: 'ORGANIZATION' }], undefined,
        'SonarCloud\'s project settings set 1 analysis-scope value'],
      ['a language exclusion set on the project', [{ key: 'sonar.javascript.exclusions', value: 'src/**', inherited: false }], undefined,
        'SonarCloud\'s project settings set 1 analysis-scope value'],
      ['a setting in a shape the tool does not know', [{ key: 'sonar.exclusions', valueList: ['src/**'] }], undefined,
        'Exclusions set in SonarCloud\'s project settings could not be read'],
      ['a settings request that fails', [], { status: 503, body: 'unavailable' },
        'Exclusions set in SonarCloud\'s project settings could not be read']
    ])('is manual for %s', async (_name, settings, settingsResponse, reason) => {
      const result = await evaluate(await repo('mod-users'), { responses: admin(clean(MOD_USERS), settings, settingsResponse) });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain(reason);
    });

    it('does not trust an admin flag SonarCloud gives for another project', async () => {
      const responses = admin(clean(MOD_USERS), []);
      const navigation = Object.keys(responses).find(url => url.includes('navigation/component'))!;
      responses[navigation] = { status: 200, body: { ...(responses[navigation].body as object), key: 'org.folio:mod-other' } };
      const result = await evaluate(await repo('mod-users'), { responses: patched(responses, 'settings/values', () => undefined) });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('could not be read without a SonarCloud admin token');
    });
  });

  describe('suppression and scope scan', () => {
    it('counts Sonar rules, "all" and the javac names sonar-java honours, ignoring other names, eslint and commented-out code', async () => {
      const result = await evaluate(await repo('mod-users', {
        'src/main/java/A.java': [
          'class A {',
          '  @SuppressWarnings({"java:S1", "unchecked"})',
          '  int field;',
          '  // @SuppressWarnings("java:S9")',
          '  @SuppressWarnings(value = {"all"})',
          '  void method() {}',
          '  @SuppressWarnings({"null", "checkstyle:MethodLength", "squid:HiddenFieldCheck"}) void other() {}',
          '}'
        ].join('\n'),
        // A source package may be named build; only build output at a module root is skipped.
        'src/main/java/org/folio/build/B.java': 'class B {\n  @SuppressWarnings("java:S2")\n  void b() {}\n}\n',
        'target/classes/C.java': '@SuppressWarnings("java:S3") class C {}',
        'src/main/kotlin/K.kt': '@file:Suppress("kotlin:S100")\npackage k\n// "unused" is a javac name; Kotlin code is not filtered by it\n@Suppress("unused") fun k() {}\n',
        'src/components/View.js': '// eslint-disable-next-line no-console\nconsole.log(1); // NOSONAR\n/* eslint-disable */\n'
      }));
      const { scan } = result.criterionDetails;

      expect(scan.suppressions.map(item => [item.path, item.kind, item.rule, item.line, item.target, item.appliesTo])).toEqual([
        ['src/components/View.js', 'nosonar', undefined, 2, undefined, undefined],
        ['src/main/java/A.java', 'annotation', 'java:S1', 2, 'field', undefined],
        ['src/main/java/A.java', 'all', undefined, 5, 'method', undefined],
        ['src/main/java/A.java', 'annotation', 'null', 7, 'method', ['java:S2259']],
        ['src/main/java/A.java', 'annotation', 'squid:HiddenFieldCheck', 7, 'method', undefined],
        ['src/main/java/org/folio/build/B.java', 'annotation', 'java:S2', 2, 'method', undefined],
        ['src/main/kotlin/K.kt', 'annotation', 'kotlin:S100', 1, 'class', undefined]
      ]);
      expect(scan.eslintDisableCount).toBe(2);
      expect(result.details).toContain('eslint-disable comments: 2 (ESLint, not Sonar, so not counted)');
      expect(result.details).toContain('  - 1 suppression of "null" (a javac warning name that also hides Sonar rule java:S2259) with no comment explaining why');
    });

    it('counts only workflow exclusions FOLIO\'s shared workflow does not already pass, and not coverage-only exclusions', async () => {
      const result = await evaluate(await repo('ui-users', {
        '.github/workflows/ui.yml': [
          'jobs:',
          '  ui:',
          '    uses: folio-org/.github/.github/workflows/ui.yml@v1',
          '    with:',
          '      sonar-exclusions: >',
          '        docs/**,',
          '        **/*.md,',
          '        src/legacy/**',
          '      sonar-sources: ./src'
        ].join('\n'),
        'sonar-project.properties': 'sonar.coverage.exclusions=src/index.js\n# sonar.exclusions=ignored/**\n'
      }));
      const { scan } = result.criterionDetails;

      expect(scan.scope.map(item => [item.key, item.value, item.path, item.line, item.affectsS011])).toEqual([
        ['sonar.coverage.exclusions', 'src/index.js', 'sonar-project.properties', 1, false],
        ['sonar.exclusions', 'src/legacy/**', '.github/workflows/ui.yml', 5, true]
      ]);
      expect(result.criterionDetails.reviewGroups.map(group => group.id)).toEqual(['scope:.github/workflows/ui.yml']);
      expect(result.details).toContain('  - Files excluded from analysis (sonar.exclusions, CI input .github/workflows/ui.yml:5, in addition to the defaults of FOLIO\'s ui.yml): src/legacy/**');
    });
  });
});
