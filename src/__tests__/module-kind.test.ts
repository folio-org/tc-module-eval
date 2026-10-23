import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyModuleKind } from '../utils/module-kind';

describe('module kind classifier', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'module-kind-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('detects backend module descriptors', () => {
    writeFile('descriptors/ModuleDescriptor-template.json', '{"id":"mod-test-1.0.0"}');

    expect(classifyModuleKind(tempRoot).kind).toBe('backend-module');
  });

  it('detects backend descriptor templates kept in service/, as in FOLIO Grails modules', () => {
    writeFile('service/src/main/okapi/ModuleDescriptor-template.json', '{"id":"mod-test-1.0.0"}');

    expect(classifyModuleKind(tempRoot).kind).toBe('backend-module');
  });

  it('detects UI modules by package name', () => {
    writeFile('package.json', JSON.stringify({ name: 'ui-users' }));

    expect(classifyModuleKind(tempRoot).kind).toBe('ui-module');
  });

  it('detects explicit allowlisted libraries', () => {
    writeFile('package.json', JSON.stringify({ name: '@folio/stripes-components' }));

    expect(classifyModuleKind(tempRoot).kind).toBe('library');
  });

  it('checks the library allowlist before Stripes UI metadata', () => {
    writeFile('package.json', JSON.stringify({ name: '@folio/stripes-core', stripes: { actsAs: ['app'] } }));

    expect(classifyModuleKind(tempRoot).kind).toBe('library');
  });

  it('matches the allowlist by package name, not by the clone directory name', () => {
    const libraryClone = path.join(tempRoot, 'stripes-components', '1761200000000');
    writeFile('stripes-components/1761200000000/package.json', JSON.stringify({ name: '@folio/stripes-components', stripes: { actsAs: ['app'] } }));
    const moduleInLibraryNamedDir = path.join(tempRoot, 'stripes-core');
    writeFile('stripes-core/package.json', JSON.stringify({ name: '@folio/users', stripes: { actsAs: ['app', 'settings'] } }));

    expect(classifyModuleKind(libraryClone).kind).toBe('library');
    expect(classifyModuleKind(moduleInLibraryNamedDir).kind).toBe('ui-module');
  });

  it.each([
    ['missing', { type: 'components' }, 'library'],
    ['an empty list', { actsAs: [] }, 'library'],
    ['only empty strings', { actsAs: [''] }, 'library'],
    ['an empty string', { actsAs: '' }, 'library'],
    ['a role among empty strings', { actsAs: ['', 'handler'] }, 'ui-module'],
    ['a single role string', { actsAs: 'app' }, 'ui-module'],
    ['real roles', { actsAs: ['app', 'settings'] }, 'ui-module']
  ])('classifies a non-allowlisted Stripes package whose actsAs is %s', (_label, stripes, kind) => {
    writeFile('package.json', JSON.stringify({ name: '@folio/stripes-acq-components', stripes }));

    expect(classifyModuleKind(tempRoot).kind).toBe(kind);
  });

  it('classifies a Stripes package without a real actsAs as a library even when its name looks like a UI module', () => {
    writeFile('package.json', JSON.stringify({ name: '@folio/ui-example', stripes: { actsAs: [''] } }));

    expect(classifyModuleKind(tempRoot).kind).toBe('library');
  });

  it('lets stronger module markers override library-looking names', () => {
    writeFile('package.json', JSON.stringify({ name: '@folio/stripes-components' }));
    writeFile('descriptors/ModuleDescriptor-template.json', '{"id":"mod-test-1.0.0"}');

    expect(classifyModuleKind(tempRoot).kind).toBe('backend-module');
  });

  it('keeps broad package repositories applicable as ambiguous', () => {
    writeFile('package.json', JSON.stringify({ name: '@folio/some-package', dependencies: { react: '^18.0.0' } }));

    expect(classifyModuleKind(tempRoot).kind).toBe('ambiguous');
  });

  it('ignores descriptor marker paths that are not directories', () => {
    writeFile('descriptors', 'not a directory');

    expect(classifyModuleKind(tempRoot).kind).toBe('ambiguous');
  });

  function writeFile(relativePath: string, content: string): void {
    const absolutePath = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
});
