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
    ['a library parent and its own non-library artifactId', pom('mod-example', { parent: 'folio-spring-base' }), 'ambiguous'],
    ['a non-library parent and its own library artifactId', pom('folio-spring-support', { parent: 'folio-spring-parent' }), 'library'],
    // Maven accepts <project>'s children in any order, so a dependency can come before the project's own artifactId.
    ['no parent and its own library artifactId after a dependency', pom('folio-kafka-wrapper', { dependency: 'vertx-core' }), 'library'],
    ['no parent and a library dependency before its own artifactId', pom('mod-example', { dependency: 'folio-spring-base' }), 'ambiguous']
  ])('classifies a pom.xml with %s', (_label, pomXml, kind) => {
    writeFile('pom.xml', pomXml);

    const result = classifyModuleKind(tempRoot);
    expect(result.kind).toBe(kind);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['is not well-formed', '<project><artifactId>folio-spring-base</artifactId>', 'Unable to parse pom.xml'],
    ['is over the 1 MiB read limit', pom('folio-spring-base').replace('<modelVersion>', `<!-- ${'x'.repeat(1024 * 1024)} --><modelVersion>`), 'larger than']
  ])('warns and does not classify a pom.xml that %s', (_label, pomXml, warning) => {
    writeFile('pom.xml', pomXml);

    const result = classifyModuleKind(tempRoot);
    expect(result.kind).toBe('ambiguous');
    expect(result.warnings).toEqual([expect.stringContaining(warning)]);
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

  function pom(artifactId: string, { parent, dependency }: { parent?: string; dependency?: string } = {}): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  ${parent ? `<parent><groupId>org.folio</groupId><artifactId>${parent}</artifactId><version>1.0.0</version></parent>` : ''}
  ${dependency ? `<dependencies><dependency><groupId>org.folio</groupId><artifactId>${dependency}</artifactId></dependency></dependencies>` : ''}
  <groupId>org.folio</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>1.0.0</version>
  <build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId></plugin></plugins></build>
</project>`;
  }

  function writeFile(relativePath: string, content: string): void {
    const absolutePath = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
});
