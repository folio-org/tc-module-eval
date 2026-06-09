import * as fs from 'fs';
import * as path from 'path';
import {
  OKAPI_MODULE_DESCRIPTOR_SCHEMA_SOURCE,
  okapiModuleDescriptorSchemas
} from '../schemas/okapi/module-descriptor';

const schemaDir = path.join(__dirname, '..', 'schemas', 'okapi', 'module-descriptor');

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (!value || typeof value !== 'object') {
    return refs;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectRefs(item, refs));
    return refs;
  }

  const objectValue = value as Record<string, unknown>;
  if (typeof objectValue.$ref === 'string') {
    refs.push(objectValue.$ref);
  }
  Object.values(objectValue).forEach(item => collectRefs(item, refs));
  return refs;
}

describe('Okapi schema bundle', () => {
  it('should include the root ModuleDescriptor schema', () => {
    const root = JSON.parse(fs.readFileSync(path.join(schemaDir, 'ModuleDescriptor.json'), 'utf-8'));

    expect(root.title).toBe('ModuleDescriptor');
    expect(root.id).toBe('ModuleDescriptor.json');
  });

  it('should resolve every sibling $ref in the bundled closure', () => {
    const bundledIds = new Set(okapiModuleDescriptorSchemas.map(schema => (schema as any).id));

    for (const schema of okapiModuleDescriptorSchemas) {
      for (const ref of collectRefs(schema)) {
        expect(bundledIds.has(ref)).toBe(true);
      }
    }
  });

  it('should document the upstream schema source baseline', () => {
    const readme = fs.readFileSync(path.join(schemaDir, 'README.md'), 'utf-8');

    expect(readme).toContain(OKAPI_MODULE_DESCRIPTOR_SCHEMA_SOURCE);
    expect(readme).toContain('retrieved 2026-06-08');
  });
});
