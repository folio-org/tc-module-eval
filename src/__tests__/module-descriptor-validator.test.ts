import { validateModuleDescriptorJson } from '../utils/module-descriptor-validator';

describe('module-descriptor-validator', () => {
  it('should validate a minimal descriptor with required id', () => {
    const result = validateModuleDescriptorJson(JSON.stringify({ id: 'mod-example-1.0.0' }));

    expect(result.valid).toBe(true);
    expect(result.schemaBaseline).toContain('folio-org/okapi');
  });

  it('should return parse evidence for malformed JSON', () => {
    const result = validateModuleDescriptorJson('{ bad json');

    expect(result.valid).toBe(false);
    expect(result.parseError).toBeDefined();
    expect(result.errors).toEqual([]);
  });

  it('should report missing required id', () => {
    const result = validateModuleDescriptorJson(JSON.stringify({ name: 'example' }));

    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.keyword === 'required')).toBe(true);
  });

  it('should resolve nested InterfaceReference schema errors', () => {
    const result = validateModuleDescriptorJson(JSON.stringify({
      id: 'mod-example-1.0.0',
      requires: [{ version: '1.0' }]
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.schemaPath.includes('InterfaceReference'))).toBe(true);
  });

  it('should reject unsupported top-level properties', () => {
    const result = validateModuleDescriptorJson(JSON.stringify({
      id: 'mod-example-1.0.0',
      extra: true
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.keyword === 'additionalProperties')).toBe(true);
  });
});
