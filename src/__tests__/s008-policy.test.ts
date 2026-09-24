import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { loadAcceptanceLedger } from '../utils/acceptance-ledger';
import { loadS008Catalog } from '../utils/s008-catalog';

describe('S008 trusted policy loaders', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 's008-policy-')); });
  afterEach(async () => { await fs.remove(dir); });

  it('loads, hashes, and freezes a valid shared ledger', async () => {
    const file = path.join(dir, 'ledger.json');
    await fs.writeJson(file, ledger());
    const loaded = await loadAcceptanceLedger(file);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Object.isFrozen(loaded.value.families)).toBe(true);
    }
  });

  it.each([
    ['duplicate module identity', { moduleIdentities: [{ identity: 'mod-a', familyId: 'a' }, { identity: 'mod-a', familyId: 'a' }] }, 'duplicate_entry'],
    ['duplicate package coordinate', { libraryCoordinates: [{ ecosystem: 'npm', packageName: '@folio/a', familyId: 'a' }, { ecosystem: 'npm', packageName: '@folio/a', familyId: 'a' }] }, 'duplicate_entry'],
    ['dangling family', { moduleIdentities: [{ identity: 'mod-x', familyId: 'missing' }] }, 'dangling_family_reference']
  ])('rejects %s', async (_name, override, code) => {
    const file = path.join(dir, 'ledger.json');
    await fs.writeJson(file, { ...ledger(), ...override });
    const loaded = await loadAcceptanceLedger(file);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.diagnostics.map(item => item.code)).toContain(code);
  });

  it('loads the checked-in authoritative ledger and rejects a missing selected development catalog', async () => {
    const checkedIn = await loadAcceptanceLedger(path.resolve(__dirname, '../../config/acceptance-ledger.json'));
    expect(checkedIn).toMatchObject({ ok: true });
    if (checkedIn.ok) {
      expect(checkedIn.value.authoritative).toBe(true);
      expect(checkedIn.value.source.reference).toBe('platform-lsp');
    }
    const missing = await loadS008Catalog('development', { development: path.join(dir, 'missing.json') });
    expect(missing).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'policy_missing' })] });
  });

  it('validates catalog channel, schema, and duplicate provider IDs', async () => {
    const file = path.join(dir, 'catalog.json');
    const value = catalog();
    value.providers.push({ ...value.providers[0] });
    await fs.writeJson(file, value);
    const loaded = await loadS008Catalog('official', { official: file });
    expect(loaded).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'duplicate_entry' })]) });
  });

  it('treats unsupported provider version syntax as invalid authoritative data', async () => {
    const file = path.join(dir, 'catalog.json');
    const value = catalog();
    value.providers[0].provides = [{ id: 'users', version: '^1.0' }];
    await fs.writeJson(file, value);
    const loaded = await loadS008Catalog('official', { official: file });
    expect(loaded).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'catalog_invalid_interface_version' })] });
  });

  function ledger(): any {
    return {
      schemaVersion: '1.0', authoritative: true, source: { reviewedBy: 'TC', reference: 'TCR-1' },
      families: [{ id: 'a', displayName: 'A', canonicalRepositories: ['folio-org/mod-a'], acceptance: { kind: 'approved-tcr', reference: 'TCR-1' } }],
      moduleIdentities: [{ identity: 'mod-a', familyId: 'a' }], libraryCoordinates: []
    };
  }
  function catalog(): any {
    return {
      schemaVersion: '1.0', authoritative: true, channel: 'official',
      baseline: { platformRepository: 'folio-org/platform-lsp', platformCommit: 'a'.repeat(40), descriptorVersion: '1', descriptorHash: `sha256:${'b'.repeat(64)}` },
      applications: [], eurekaComponents: [],
      providers: [{ moduleId: 'mod-a-1.0.0', moduleIdentity: 'mod-a', source: 'far:a', descriptorHash: `sha256:${'c'.repeat(64)}`, provides: [] }]
    };
  }
});
