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

  it('detects UI modules by package name', () => {
    writeFile('package.json', JSON.stringify({ name: 'ui-users' }));

    expect(classifyModuleKind(tempRoot).kind).toBe('ui-module');
  });

  it('detects explicit allowlisted libraries', () => {
    writeFile('package.json', JSON.stringify({ name: '@folio/stripes-components' }));

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
