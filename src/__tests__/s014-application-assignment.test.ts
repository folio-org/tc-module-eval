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
    await fs.outputJson(path.join(repo, 'package.json'), { name: packageName, stripes: { actsAs: ['app'] } });
    return repo;
  }

  async function evaluate(
    repo: string,
    options: { responses?: RecordedResponses; platformRef?: string; language?: 'java' | 'javascript' } = {}
  ): Promise<CriterionResult & { criterionDetails: S014Analysis; requested: string[] }> {
    const language = options.language ?? (fs.existsSync(path.join(repo, 'package.json')) ? 'javascript' : 'java');
    const replay = options.responses ? replayTransport(options.responses) : undefined;
    const run = createEvaluationRun({
      repositoryPath: repo,
      repositoryName: path.basename(repo),
      language,
      criteriaFilter: ['S014'],
      remoteLookups: replay?.transport,
      s014PlatformRef: options.platformRef
    });
    const result = await new TestEvaluator(language).evaluateCriterion('S014', repo, run);
    unrecorded.push(...(replay?.unrecorded ?? []));
    return { ...result, criterionDetails: result.criterionDetails as S014Analysis, requested: replay?.requested ?? [] };
  }

  describe('on the recorded platform-lsp snapshot', () => {
    it('passes mod-search in app-search, naming the module from its own artifactId rather than its parent', async () => {
      const result = await evaluate(await backendRepo('mod-search', { 'pom.xml': MOD_SEARCH_POM }), { responses: SNAPSHOT });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toBe('S014 pass: mod-search is assigned to exactly one application on the FOLIO LSP platform, app-search.');
      expect(result.details!.split('\n').slice(0, 2)).toEqual([
        'What to do: Nothing; the module is in exactly one platform application, app-search.',
        'Module name: mod-search (from the artifactId in pom.xml)'
      ]);
      expect(result.details).toContain([
        'Platform: folio-org/platform-lsp snapshot at f14ebae (R1-2027-SNAPSHOT.100200000003371)',
        'Applications checked: 41 (each read from FAR). Applications outside the platform, such as app-platform-full, are not counted.',
        'Listed in:',
        '  - app-search 1.1.0-SNAPSHOT.100200000012263 (optional): mod-search 6.1.0-SNAPSHOT.2817',
        'Sources:'
      ].join('\n'));
      // The ref resolution, the platform descriptor and one FAR read per application, each recorded with a digest.
      expect(result.criterionDetails.remoteEvidence).toHaveLength(43);
      expect(result.criterionDetails.remoteEvidence.every(record => record.status === 200 && /^sha256:[0-9a-f]{64}$/.test(record.sha256!))).toBe(true);
      expect(result.criterionDetails.platform).toMatchObject({ ref: 'snapshot', commit: 'f14ebaef59a40790dd43e8e9269ab1e228abdaa5' });
    });

    it('reads ui-users as folio_users, the name its application lists', async () => {
      const result = await evaluate(await uiRepo('ui-users', '@folio/users'), { responses: SNAPSHOT });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.criterionDetails.moduleName).toEqual({ name: 'folio_users', source: 'package', path: 'package.json' });
      expect(result.criterionDetails.memberships).toEqual([
        { application: 'app-platform-complete', version: '3.4.0-SNAPSHOT.100200000011276', tier: 'required', moduleVersion: expect.any(String) }
      ]);
    });

    it('counts an experimental application, which S008 leaves out', async () => {
      const result = await evaluate(await backendRepo('mod-rtac-cache'), { responses: SNAPSHOT });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.evidence).toContain('app-rtac-cache (an experimental application).');
      expect(result.details).toContain('  - app-rtac-cache 1.1.0-SNAPSHOT.100200000007986 (experimental): mod-rtac-cache');
    });

    it('passes edge-users, which app-platform-minimal lists, without counting app-edge-locate outside the platform', async () => {
      const result = await evaluate(await backendRepo('edge-users'), { responses: SNAPSHOT });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.criterionDetails.memberships.map(item => item.application)).toEqual(['app-platform-minimal']);
    });
  });

  describe('rules', () => {
    it('fails a module listed by two platform applications', async () => {
      const responses = syntheticPlatform([
        { name: 'app-a', modules: ['mod-x'] },
        { name: 'app-b', uiModules: ['mod-x'], tier: 'experimental' },
        { name: 'app-c', modules: ['mod-y'] }
      ]);
      const result = await evaluate(await backendRepo('mod-x'), { responses });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toBe('S014 fail: mod-x is in 2 applications on the FOLIO LSP platform: app-a and app-b (an experimental application). A module must be in exactly one application; remove it from all but one.');
    });

    it('fails two proven memberships even when another application could not be read', async () => {
      const responses = syntheticPlatform([
        { name: 'app-a', modules: ['mod-x'] },
        { name: 'app-b', modules: ['mod-x'] },
        { name: 'app-c', far: { status: 404, body: {} } }
      ]);
      const result = await evaluate(await backendRepo('mod-x'), { responses });

      expect(result.status).toBe(EvaluationStatus.FAIL);
      expect(result.evidence).toContain('1 other platform application could not be checked, but that cannot change this result.');
      expect(result.details).toContain('Applications checked: 3 (2 read from FAR, 1 could not be read).');
      expect(result.details).toContain('Could not check:\n  - app-c 1.0.0 (optional): FAR could not be read: HTTP 404.');
      // The transport's error already reads "HTTP 404."; the status is not repeated in front of it.
      expect(result.details).toMatch(/query=id%3D%3Dapp-c-1\.0\.0&full=false&limit=2 \(fetched [^;]+; HTTP 404\.\)$/m);
    });

    it('stays manual when one application lists the module but another could not be read', async () => {
      const responses = syntheticPlatform([
        { name: 'app-a', modules: ['mod-x'] },
        { name: 'app-b', far: { status: 200, body: { applicationDescriptors: [{ id: 'app-b-1.0.0', name: 'app-b', version: '1.0.0', modules: [{ name: 'mod-z' }] }], totalRecords: 1 } } },
        { name: 'app-c', modules: [] }
      ]);
      const result = await evaluate(await backendRepo('mod-x'), { responses });

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('S014 manual: mod-x is in app-a, but 1 other platform application could not be checked, so the tool cannot confirm that it is in no other application. A reviewer needs to check the applications listed under "Could not check".');
      expect(result.details).toContain('  - app-b 1.0.0 (optional): Its descriptor has module entries the tool could not read.');
    });

    it('stays manual, not fail, when no readable application lists the module but some could not be read', async () => {
      const responses = syntheticPlatform([
        { name: 'app-a', modules: ['mod-y'] },
        { name: 'app-b', far: { status: 200, body: { applicationDescriptors: [{ id: 'app-b-9.9.9', name: 'app-b', version: '9.9.9' }], totalRecords: 1 } } }
      ]);
      const result = await evaluate(await backendRepo('mod-x'), { responses });

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

    it('stays manual when the platform descriptor has no applications object', async () => {
      const responses = syntheticPlatform([], { name: 'platform-lsp', version: 'R1' });
      const result = await evaluate(await backendRepo('mod-x'), { responses });

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
      const result = await evaluate(await backendRepo('mod-x'), { responses });

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
      }), { responses: syntheticPlatform([{ name: 'app-a', modules: ['mod-x'] }]) });
      expect(named.criterionDetails.moduleName).toEqual({ name: 'mod-x', source: 'descriptor', path: 'descriptors/ModuleDescriptor-template.json' });
      expect(named.status).toBe(EvaluationStatus.PASS);

      // A name part that starts with a digit is still part of the name; only a whole version ends it.
      const digits = await evaluate(await backendRepo('mod-foo-2fa', {
        'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: 'mod-foo-2fa-1.0.0-SNAPSHOT' })
      }), { responses: syntheticPlatform([{ name: 'app-a', modules: ['mod-foo'] }, { name: 'app-b', modules: ['mod-foo-2fa'] }]) });
      expect(digits.criterionDetails.moduleName?.name).toBe('mod-foo-2fa');
      expect(digits.status).toBe(EvaluationStatus.PASS);

      const unnamed = await evaluate(await backendRepo('Not A Module'), { responses: {} });
      expect(unnamed.status).toBe(EvaluationStatus.MANUAL);
      expect(unnamed.requested).toEqual([]);
    });

    it.each([
      ['dependency', '<dependencies><dependency><groupId>org.folio</groupId><artifactId>mod-y</artifactId></dependency></dependencies>'],
      ['plugin', '<build><plugins><plugin><groupId>org.folio</groupId><artifactId>mod-y</artifactId></plugin></plugins></build>']
    ])('names the module from the project\'s own artifactId, not a %s declared before or after it', async (_label, declaration) => {
      const result = await evaluate(await backendRepo('repo-name', {
        'pom.xml': `<project><modelVersion>4.0.0</modelVersion>${declaration}<groupId>org.folio</groupId><artifactId>mod-x</artifactId>${declaration}</project>`
      }), { responses: syntheticPlatform([{ name: 'app-a', modules: ['mod-x'] }, { name: 'app-b', modules: ['mod-y'] }]) });

      expect(result.criterionDetails.moduleName).toEqual({ name: 'mod-x', source: 'pom', path: 'pom.xml' });
      expect(result.status).toBe(EvaluationStatus.PASS);
    });

    it('keeps FAR text inside its report row', async () => {
      const id = 'app-a-1.0.0';
      const responses = syntheticPlatform([{
        name: 'app-a',
        far: { status: 200, body: { applicationDescriptors: [{ id, name: 'app-a', version: '1.0.0', modules: [{ id: 'mod-x-1\n  - Fake row (evidence: x)', name: 'mod-x', version: '1\n  - Fake row (evidence: x)' }] }], totalRecords: 1 } }
      }]);
      const result = await evaluate(await backendRepo('mod-x'), { responses });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.details!.split('\n').filter(line => line.includes('Fake row'))).toEqual(['  - app-a 1.0.0 (optional): mod-x 1 ↵   - Fake row [evidence: x)']);
    });
  });

  describe('without remote evidence', () => {
    it('is manual with the rerun hint and makes no request when remote lookups are off', async () => {
      const repo = await backendRepo('mod-search', { 'pom.xml': MOD_SEARCH_POM });
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      try {
        const viaRun = await evaluate(repo);
        const direct = await new TestEvaluator('java').evaluateCriterion('S014', repo);

        for (const result of [viaRun, direct]) {
          expect(result.status).toBe(EvaluationStatus.MANUAL);
          expect(result.evidence).toBe('S014 manual: Not checked: remote lookups are off. Rerun with --allow-remote-lookups to check which FOLIO LSP platform applications list mod-search.');
        }
        expect(direct.details!.split('\n')[0]).toBe('What to do: Rerun with --allow-remote-lookups so the tool can read the platform-lsp descriptor and FAR, or check by hand that the module is in exactly one platform application.');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('is not applicable to an explicit FOLIO library, with or without remote lookups', async () => {
      const repo = path.join(root, 'stripes-components');
      await fs.outputJson(path.join(repo, 'package.json'), { name: '@folio/stripes-components' });

      for (const responses of [undefined, {}]) {
        const result = await evaluate(repo, { responses });
        expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
        expect(result.evidence).toBe('S014 not applicable: This repository is a FOLIO library, not a deployable module, so it is not assigned to an application.');
        expect(result.details).toBe('What to do: Nothing; S014 does not apply to FOLIO libraries.\nRepository kind: library');
        expect(result.requested).toEqual([]);
      }
    });

    it('reads a platform commit directly without asking GitHub to resolve it', async () => {
      const commit = 'd'.repeat(40);
      const responses = syntheticPlatform([{ name: 'app-a', modules: ['mod-x'] }]);
      responses[`https://raw.githubusercontent.com/folio-org/platform-lsp/${commit}/platform-descriptor.json`] =
        responses[`https://raw.githubusercontent.com/folio-org/platform-lsp/${'c'.repeat(40)}/platform-descriptor.json`];
      const result = await evaluate(await backendRepo('mod-x'), { responses, platformRef: commit });

      expect(result.status).toBe(EvaluationStatus.PASS);
      expect(result.requested.some(url => url.startsWith('https://api.github.com/'))).toBe(false);
    });
  });
});

