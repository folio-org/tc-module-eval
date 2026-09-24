import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { collectS008Declarations } from '../utils/s008-interface-declarations';

describe('S008 static declaration collector', () => {
  let repo: string;
  beforeEach(async () => { repo = await fs.mkdtemp(path.join(os.tmpdir(), 's008-declarations-')); });
  afterEach(async () => { await fs.remove(repo); });

  it('prefers a concrete backend descriptor, reads optional/system interfaces, and never generates', async () => {
    await fs.ensureDir(path.join(repo, 'descriptors'));
    await fs.writeJson(path.join(repo, 'descriptors/ModuleDescriptor-template.json'), { requires: [{ id: 'template', version: '1.0' }] });
    await fs.writeJson(path.join(repo, 'descriptors/ModuleDescriptor.json'), {
      requires: [{ id: '_tenant', version: '2.0' }], optional: [{ id: 'users', version: '1.0 2.0' }]
    });
    const evidence = collectS008Declarations(repo, 'backend-module');
    expect(evidence.complete).toBe(true);
    expect(evidence.sourcePaths).toEqual(['descriptors/ModuleDescriptor.json']);
    expect(evidence.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '_tenant', optional: false }),
      expect.objectContaining({ id: 'users', optional: true, version: '1.0 2.0' })
    ]));
  });

  it('accepts concrete template interfaces despite templated module metadata', async () => {
    await fs.ensureDir(path.join(repo, 'descriptors'));
    await fs.writeJson(path.join(repo, 'descriptors/ModuleDescriptor-template.json'), { id: '${artifactId}-${version}', requires: [{ id: 'users', version: '16.0' }] });
    expect(collectS008Declarations(repo, 'backend-module')).toMatchObject({ complete: true, declarations: [{ id: 'users', version: '16.0' }] });
  });

  it('reuses an available S002 artifact and diagnoses placeholders/unsupported syntax', async () => {
    const artifact = path.join(repo, 'generated.json');
    await fs.writeJson(artifact, { requires: [{ id: 'users', version: '${version}' }, { id: 'bad', version: '^1.0' }] });
    const evidence = collectS008Declarations(repo, 'backend-module', { status: 'produced', absolutePath: artifact, descriptorPath: 'generated.json', warnings: [], errors: [] });
    expect(evidence.complete).toBe(false);
    expect(evidence.declarations).toEqual([]);
    expect(evidence.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['incomplete_declaration', 'unsupported_version_syntax']));
  });

  it('reads frontend required/optional maps and treats absent sections as complete empty declarations', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { stripes: { okapiInterfaces: { users: '16.0' }, optionalOkapiInterfaces: { settings: '1.0 2.0' } } });
    const evidence = collectS008Declarations(repo, 'ui-module');
    expect(evidence.declarations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'users', optional: false }), expect.objectContaining({ id: 'settings', optional: true })
    ]));
    await fs.writeJson(path.join(repo, 'package.json'), { name: 'ui-empty', stripes: {} });
    expect(collectS008Declarations(repo, 'ui-module')).toMatchObject({ complete: true, declarations: [] });
  });

  it('marks unsupported frontend shapes incomplete', async () => {
    await fs.writeJson(path.join(repo, 'package.json'), { stripes: { okapiInterfaces: ['users'] } });
    expect(collectS008Declarations(repo, 'ui-module')).toMatchObject({ complete: false, diagnostics: [expect.objectContaining({ code: 'unsupported_declaration_shape' })] });
  });
});
