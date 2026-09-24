import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { importS008Catalog } from '../tools/import-s008-catalog';

describe('S008 catalog snapshot importer', () => {
  it('requires immutable input and produces deterministic normalized output', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 's008-import-'));
    try {
      await fs.writeJson(path.join(dir, 'platform.json'), { applications: ['app-a'] });
      await fs.writeJson(path.join(dir, 'app.json'), { name: 'app-a' });
      await fs.writeJson(path.join(dir, 'provider.json'), { id: 'mod-a-2.0.0', provides: [{ id: 'z', version: '1.0' }, { id: 'a', version: '2.0', interfaceType: 'system' }] });
      const manifest = {
        channel: 'development',
        platform: { repository: 'folio-org/platform-lsp', commit: 'a'.repeat(40), descriptorVersion: 'dev', descriptorPath: 'platform.json' },
        applications: [{ name: 'app-a', version: '1.0.0', optional: false, farSource: 'far:app-a:1.0.0', descriptorPath: 'app.json' }],
        eurekaComponents: [{ familyId: 'component', moduleIdentities: ['z', 'a'] }],
        componentSources: [{ name: 'component', version: '2.0.0', status: 'intentionally-descriptorless' }],
        providers: [{ moduleIdentity: 'mod-a', source: 'far:mod-a:2.0.0', descriptorPath: 'provider.json' }]
      };
      const manifestPath = path.join(dir, 'manifest.json');
      await fs.writeJson(manifestPath, manifest);
      const first = await importS008Catalog(manifestPath);
      const second = await importS008Catalog(manifestPath);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.providers[0].provides.map(item => item.id)).toEqual(['a', 'z']);
      expect(first.eurekaComponents[0].moduleIdentities).toEqual(['a', 'z']);
      expect(first.eurekaComponents[0]).toMatchObject({ version: '2.0.0', descriptorSource: { status: 'intentionally-descriptorless' } });
      expect(first.baseline.descriptorHash).toMatch(/^sha256:/);
      const { componentSources: _componentSources, ...withoutComponentSources } = manifest;
      await fs.writeJson(manifestPath, withoutComponentSources);
      await expect(importS008Catalog(manifestPath)).rejects.toThrow('componentSources must be an array');
      await fs.writeJson(manifestPath, { ...manifest, componentSources: [] });
      await expect(importS008Catalog(manifestPath)).rejects.toThrow('exactly one componentSources entry for every Eureka component family');
      await fs.writeJson(manifestPath, {
        ...manifest,
        componentSources: [{ name: 'component', version: '2.0.0', status: 'acquired', kind: 'registry', source: 'registry:component' }]
      });
      await expect(importS008Catalog(manifestPath)).rejects.toThrow('componentSources[0] acquired provenance');
      await fs.writeJson(manifestPath, {
        ...manifest,
        componentSources: [{
          name: 'component', version: '2.0.0', status: 'acquired', kind: 'registrry',
          source: 'registry:component', descriptorHash: `sha256:${'a'.repeat(64)}`
        }]
      });
      await expect(importS008Catalog(manifestPath)).rejects.toThrow('componentSources[0] acquired provenance');
      await fs.writeJson(manifestPath, { ...manifest, platform: { ...manifest.platform, commit: '0'.repeat(40) } });
      await expect(importS008Catalog(manifestPath)).rejects.toThrow('explicit immutable');
    } finally { await fs.remove(dir); }
  });
});
