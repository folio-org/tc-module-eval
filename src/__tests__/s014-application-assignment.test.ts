import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { CriterionResult, EvaluationStatus, S014Analysis } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { loadRemoteFixture, RecordedResponses, replayTransport, syntheticPlatform } from './helpers/remote-replay';

class TestEvaluator extends SharedEvaluator {}

// Recorded from folio-org/platform-lsp `snapshot` (41 applications) and FAR by `yarn capture:remote-fixtures`.
const SNAPSHOT = loadRemoteFixture('platform-lsp-snapshot');
const MOD_SEARCH_POM = `<project>
  <!-- <artifactId>commented-out</artifactId> -->
  <parent><groupId>org.folio</groupId><artifactId>folio-spring-parent</artifactId><version>1.0</version></parent>
  <artifactId>mod-search</artifactId>
</project>`;

describe('S014 application assignment', () => {
  let root: string;
  let unrecorded: string[];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 's014-'));
    unrecorded = [];
  });
  afterEach(async () => {
    await fs.remove(root);
    expect(unrecorded).toEqual([]);
  });

  async function backendRepo(name: string, files: Record<string, string> = {}): Promise<string> {
    const repo = path.join(root, name);
    await fs.outputFile(path.join(repo, 'descriptors/ModuleDescriptor-template.json'), JSON.stringify({ id: '@artifactId@-@version@' }));
    for (const [file, content] of Object.entries(files)) await fs.outputFile(path.join(repo, file), content);
    return repo;
  }

  async function uiRepo(name: string, packageName: string): Promise<string> {
    const repo = path.join(root, name);
    await fs.outputJson(path.join(repo, 'package.json'), { name: packageName, stripes: { type: 'app' } });
    return repo;
  }

  async function evaluate(
    repo: string,
    options: { responses?: RecordedResponses; application?: string; platformRef?: string; language?: 'java' | 'javascript' } = {}
  ): Promise<CriterionResult & { criterionDetails: S014Analysis; requested: string[] }> {
    const language = options.language ?? (fs.existsSync(path.join(repo, 'package.json')) ? 'javascript' : 'java');
    const replay = options.responses ? replayTransport(options.responses) : undefined;
    const run = createEvaluationRun({
      repositoryPath: repo,
      repositoryName: path.basename(repo),
      language,
      criteriaFilter: ['S014'],
      remoteLookups: replay?.transport,
      s014Application: options.application,
      s014PlatformRef: options.platformRef
    });
    const result = await new TestEvaluator(language).evaluateCriterion('S014', repo, run);
    unrecorded.push(...(replay?.unrecorded ?? []));
    return { ...result, criterionDetails: result.criterionDetails as S014Analysis, requested: replay?.requested ?? [] };
  }

  describe('on the recorded platform-lsp snapshot', () => {
    it('passes mod-search in app-search, naming the module from its own artifactId rather than its parent', async () => {
      const result = await evaluate(await backendRepo('mod-search', { 'pom.xml': MOD_SEARCH_POM }), { responses: SNAPSHOT, application: 'app-search' });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toBe('S014 pass: mod-search is assigned to exactly one application on the FOLIO LSP platform, app-search, which is the application named for this evaluation.');
      expect(result.details).toContain('Module name: mod-search (from the artifactId in pom.xml)');
      expect(result.details).toContain([
        'Platform: folio-org/platform-lsp snapshot at f14ebae (R1-2027-SNAPSHOT.100200000003371)',
        'Applications checked: 41 (each read from FAR). Applications outside the platform, such as app-platform-full, are not counted.',
        'Named application: app-search (--application)',
        'Listed in:',
        '  - app-search 1.1.0-SNAPSHOT.100200000012263 (optional): mod-search 6.1.0-SNAPSHOT.2817',
        'Sources:'
      ].join('\n'));
      // The ref resolution, the platform descriptor and one FAR read per application, each recorded with a digest.
      expect(result.criterionDetails.remoteEvidence).toHaveLength(43);
      expect(result.criterionDetails.remoteEvidence.every(record => record.status === 200 && /^sha256:[0-9a-f]{64}$/.test(record.sha256!))).toBe(true);
      expect(result.criterionDetails.platform).toMatchObject({ ref: 'snapshot', commit: 'f14ebaef59a40790dd43e8e9269ab1e228abdaa5' });
    });

    it('fails mod-search when the evaluation names a different application', async () => {
      const result = await evaluate(await backendRepo('mod-search', { 'pom.xml': MOD_SEARCH_POM }), { responses: SNAPSHOT, application: 'app-platform-complete' });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe("S014 fail: mod-search is in app-search on the FOLIO LSP platform, but the application named for this evaluation is app-platform-complete. Move the module to app-platform-complete, or correct --application if the evaluation's Jira task names app-search.");
    });

    it('stays manual for mod-search without --application and names the application to confirm', async () => {
      const result = await evaluate(await backendRepo('mod-search', { 'pom.xml': MOD_SEARCH_POM }), { responses: SNAPSHOT });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe("S014 manual: mod-search is in exactly one platform application, app-search. Confirm that the evaluation's Jira task names app-search, or rerun with --application app-search.");
      expect(result.details).toContain('Named application: not given (--application)');
    });

    it('reads ui-users as folio_users, the name its application lists', async () => {
      const result = await evaluate(await uiRepo('ui-users', '@folio/users'), { responses: SNAPSHOT, application: 'app-platform-complete' });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.criterionDetails.moduleName).toEqual({ name: 'folio_users', source: 'package', path: 'package.json' });
      expect(result.criterionDetails.memberships).toEqual([
        { application: 'app-platform-complete', version: '3.4.0-SNAPSHOT.100200000011276', tier: 'required', moduleVersion: expect.any(String) }
      ]);
    });

    it('counts an experimental application, which S008 leaves out', async () => {
      const result = await evaluate(await backendRepo('mod-rtac-cache'), { responses: SNAPSHOT, application: 'app-rtac-cache' });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toContain('app-rtac-cache (an experimental application), which is the application named');
      expect(result.details).toContain('  - app-rtac-cache 1.1.0-SNAPSHOT.100200000007986 (experimental): mod-rtac-cache');
    });

    it('fails edge-users named for app-edge-locate, an application outside the platform, because the platform lists it in app-platform-minimal', async () => {
      const result = await evaluate(await backendRepo('edge-users'), { responses: SNAPSHOT, application: 'app-edge-locate' });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.criterionDetails.memberships.map(item => item.application)).toEqual(['app-platform-minimal']);
      expect(result.criterionDetails.applicationOnPlatform).toBe(false);
    });
  });

  describe('rules', () => {
    it('fails a module listed by two platform applications, even when one is the named application', async () => {
      const responses = syntheticPlatform([
        { name: 'app-a', modules: ['mod-x'] },
        { name: 'app-b', uiModules: ['mod-x'], tier: 'experimental' },
        { name: 'app-c', modules: ['mod-y'] }
      ]);
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-a' });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe('S014 fail: mod-x is in 2 applications on the FOLIO LSP platform: app-a and app-b (an experimental application). A module must be in exactly one application; remove it from all but app-a, the application named for this evaluation.');
    });

    it('fails two proven memberships even when another application could not be read', async () => {
      const responses = syntheticPlatform([
        { name: 'app-a', modules: ['mod-x'] },
        { name: 'app-b', modules: ['mod-x'] },
        { name: 'app-c', far: { status: 404, body: {} } }
      ]);
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-a' });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('1 other platform application could not be checked, but that cannot change this result.');
      expect(result.details).toContain('Applications checked: 3 (2 read from FAR, 1 could not be read).');
      expect(result.details).toContain('Could not check:\n  - app-c 1.0.0 (optional): FAR could not be read: HTTP 404.');
    });

    it('fails one membership in a different application even when another application could not be read', async () => {
      const responses = syntheticPlatform([
        { name: 'app-a', modules: ['mod-x'] },
        { name: 'app-b', far: { status: 200, body: { applicationDescriptors: [], totalRecords: 0 } } }
      ]);
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-b' });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toMatch(/^S014 fail: mod-x is in app-a on the FOLIO LSP platform, but the application named for this evaluation is app-b\./);
    });

    it('stays manual when one membership matches but another application could not be read', async () => {
      const responses = syntheticPlatform([
        { name: 'app-a', modules: ['mod-x'] },
        { name: 'app-b', far: { status: 200, body: { applicationDescriptors: [{ id: 'app-b-1.0.0', name: 'app-b', version: '1.0.0', modules: [{ name: 'mod-z' }] }], totalRecords: 1 } } },
        { name: 'app-c', modules: [] }
      ]);
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-a' });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('S014 manual: mod-x is in app-a, but 1 other platform application could not be checked, so the tool cannot confirm that it is in no other application. A reviewer needs to check the applications listed under "Could not check".');
      expect(result.details).toContain('  - app-b 1.0.0 (optional): Its descriptor has module entries the tool could not read.');
    });

    it('stays manual, not fail, when no readable application lists the module but some could not be read', async () => {
      const responses = syntheticPlatform([
        { name: 'app-a', modules: ['mod-y'] },
        { name: 'app-b', far: { status: 200, body: { applicationDescriptors: [{ id: 'app-b-9.9.9', name: 'app-b', version: '9.9.9' }], totalRecords: 1 } } }
      ]);
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-a' });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('mod-x is in none of the 1 FOLIO LSP platform applications the tool could check, and 1 application could not be checked.');
      expect(result.details).toContain('FAR returned a descriptor for a different application or version.');
    });

    it('fails a module no platform application lists', async () => {
      const responses = syntheticPlatform([{ name: 'app-a', modules: ['mod-y'] }, { name: 'app-b', modules: ['mod-xx', 'mod-x-extra'] }]);
      const result = await evaluate(await backendRepo('mod-x'), { responses });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe('S014 fail: mod-x is in none of the 2 applications on the FOLIO LSP platform. Add it to exactly one platform application.');
      expect(result.details).toContain('Listed in: no platform application\n');
    });

    it('stays manual when the named application is not on the platform but its own template lists the module', async () => {
      const responses: RecordedResponses = {
        ...syntheticPlatform([{ name: 'app-a', modules: ['mod-y'] }]),
        'https://raw.githubusercontent.com/folio-org/app-new/HEAD/app-new.template.json': { status: 200, body: { name: '${project.name}', modules: [{ name: 'mod-x', version: 'latest' }], uiModules: [] } }
      };
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-new' });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('It is assigned in app-new, the application named for this evaluation, which is not yet part of the platform.');
      expect(result.details).toContain('Named application template: app-new.template.json in folio-org/app-new lists mod-x');
    });

    it('fails when the named application is not on the platform and its template does not list the module', async () => {
      const responses: RecordedResponses = {
        ...syntheticPlatform([{ name: 'app-a', modules: ['mod-y'] }]),
        'https://raw.githubusercontent.com/folio-org/app-new/HEAD/app-new.template.json': { status: 200, body: { modules: [{ name: 'mod-y' }], uiModules: [{ name: 'mod-x-ui' }] } }
      };
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-new' });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('its own repository does not list the module either');
    });

    it('stays manual, not fail, when the named application\'s template has an entry without a name', async () => {
      const responses: RecordedResponses = {
        ...syntheticPlatform([{ name: 'app-a', modules: ['mod-y'] }]),
        'https://raw.githubusercontent.com/folio-org/app-new/HEAD/app-new.template.json': { status: 200, body: { modules: [{ name: 'mod-y' }, {}], uiModules: [] } }
      };
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-new' });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.criterionDetails.namedApplicationTemplate).toMatchObject({ problem: 'The template has module entries without a name.' });
    });

    it('stays manual when the named application is off the platform and its template cannot be read', async () => {
      const responses: RecordedResponses = {
        ...syntheticPlatform([{ name: 'app-a', modules: ['mod-y'] }]),
        'https://raw.githubusercontent.com/folio-org/app-new/HEAD/app-new.template.json': { status: 404, body: '404: Not Found' }
      };
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-new' });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toContain('the tool could not read its own repository');
    });

    it('stays manual when the platform descriptor has no applications object', async () => {
      const responses = syntheticPlatform([], { name: 'platform-lsp', version: 'R1' });
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-a' });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('S014 manual: The platform descriptor lists no applications. A reviewer needs to check which FOLIO LSP platform applications list mod-x.');
    });

    it('treats an application pinned twice at different versions as unreadable, and one pinned twice at the same version as one', async () => {
      const responses = syntheticPlatform([{ name: 'app-a', modules: ['mod-x'] }, { name: 'app-b', modules: ['mod-y'] }], {
        version: 'R1',
        applications: {
          required: [{ name: 'app-a', version: '1.0.0' }, { name: 'app-b', version: '1.0.0' }],
          optional: [{ name: 'app-a', version: '1.0.0' }, { name: 'app-b', version: '2.0.0' }]
        }
      });
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-a' });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.criterionDetails.memberships).toEqual([{ application: 'app-a', version: '1.0.0', tier: 'required', moduleVersion: '2.0.0' }]);
      expect(result.criterionDetails.unresolvedApplications).toEqual([
        { name: 'app-b', tier: 'required', problem: 'The platform descriptor pins it at more than one version (1.0.0, 2.0.0).' }
      ]);
      expect(result.requested.some(url => url.includes('app-b'))).toBe(false);
    });

    it('reads the descriptor id before the POM and stays manual when it cannot name the module', async () => {
      const named = await evaluate(await backendRepo('repo-name', {
        'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: 'mod-x-${project.version}' }),
        'pom.xml': '<project><artifactId>mod-other</artifactId></project>'
      }), { responses: syntheticPlatform([{ name: 'app-a', modules: ['mod-x'] }]), application: 'app-a' });
      expect(named.criterionDetails.moduleName).toEqual({ name: 'mod-x', source: 'descriptor', path: 'descriptors/ModuleDescriptor-template.json' });
      expect(named.status).toBe(EvaluationStatus.PASS);

      // A name part that starts with a digit is still part of the name; only a whole version ends it.
      const digits = await evaluate(await backendRepo('mod-foo-2fa', {
        'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: 'mod-foo-2fa-1.0.0-SNAPSHOT' })
      }), { responses: syntheticPlatform([{ name: 'app-a', modules: ['mod-foo'] }, { name: 'app-b', modules: ['mod-foo-2fa'] }]), application: 'app-b' });
      expect(digits.criterionDetails.moduleName?.name).toBe('mod-foo-2fa');
      expect(digits.status).toBe(EvaluationStatus.PASS);

      const unnamed = await evaluate(await backendRepo('Not A Module'), { responses: {}, application: 'app-a' });
      expect(unnamed.status).toBe(EvaluationStatus.MANUAL);
      expect(unnamed.requested).toEqual([]);
    });

    it('keeps FAR text inside its report row', async () => {
      const id = 'app-a-1.0.0';
      const responses = syntheticPlatform([{
        name: 'app-a',
        far: { status: 200, body: { applicationDescriptors: [{ id, name: 'app-a', version: '1.0.0', modules: [{ id: 'mod-x-1\n  - Fake row (evidence: x)', name: 'mod-x', version: '1\n  - Fake row (evidence: x)' }] }], totalRecords: 1 } }
      }]);
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-a' });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.details!.split('\n').filter(line => line.includes('Fake row'))).toEqual(['  - app-a 1.0.0 (optional): mod-x 1 ↵   - Fake row [evidence: x)']);
    });
  });

  describe('without remote evidence', () => {
    it('is manual with the rerun hint and makes no request when remote lookups are off', async () => {
      const repo = await backendRepo('mod-search', { 'pom.xml': MOD_SEARCH_POM });
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      try {
        const viaRun = await evaluate(repo, { application: 'app-search' });
        const direct = await new TestEvaluator('java').evaluateCriterion('S014', repo);

        for (const result of [viaRun, direct]) {
          expect(result.status).toBe(EvaluationStatus.MANUAL);
          expect(result.evidence).toBe('S014 manual: Not checked: remote lookups are off. Rerun with --allow-remote-lookups to check which FOLIO LSP platform applications list mod-search.');
        }
        expect(direct.details).toContain('What to do: Rerun with --allow-remote-lookups --application <the application the Jira task names>');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('is not applicable to an explicit FOLIO library, with or without remote lookups', async () => {
      const repo = path.join(root, 'stripes-components');
      await fs.outputJson(path.join(repo, 'package.json'), { name: '@folio/stripes-components' });

      for (const responses of [undefined, {}]) {
        const result = await evaluate(repo, { responses, application: 'app-a' });
        expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
        expect(result.evidence).toBe('S014 not applicable: This repository is a FOLIO library, not a deployable module, so it is not assigned to an application.');
        expect(result.requested).toEqual([]);
      }
    });

    it('reads a platform commit directly without asking GitHub to resolve it', async () => {
      const commit = 'd'.repeat(40);
      const responses = syntheticPlatform([{ name: 'app-a', modules: ['mod-x'] }]);
      responses[`https://raw.githubusercontent.com/folio-org/platform-lsp/${commit}/platform-descriptor.json`] =
        responses[`https://raw.githubusercontent.com/folio-org/platform-lsp/${'c'.repeat(40)}/platform-descriptor.json`];
      const result = await evaluate(await backendRepo('mod-x'), { responses, application: 'app-a', platformRef: commit });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.requested.some(url => url.startsWith('https://api.github.com/'))).toBe(false);
    });
  });
});

