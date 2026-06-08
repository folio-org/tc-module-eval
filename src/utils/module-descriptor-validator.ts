import Ajv from 'ajv-draft-04';
import {
  OKAPI_MODULE_DESCRIPTOR_SCHEMA_BASELINE,
  okapiModuleDescriptorRootSchema,
  okapiModuleDescriptorSchemas
} from '../schemas/okapi/module-descriptor';

export interface ModuleDescriptorValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
}

export interface ModuleDescriptorValidationResult {
  valid: boolean;
  schemaBaseline: string;
  errors: ModuleDescriptorValidationError[];
  parseError?: string;
}

export function validateModuleDescriptorJson(content: string): ModuleDescriptorValidationResult {
  let descriptor: unknown;

  try {
    descriptor = JSON.parse(content);
  } catch (error) {
    return {
      valid: false,
      schemaBaseline: OKAPI_MODULE_DESCRIPTOR_SCHEMA_BASELINE,
      errors: [],
      parseError: error instanceof Error ? error.message : String(error)
    };
  }

  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateSchema: false
  });

  for (const schema of okapiModuleDescriptorSchemas) {
    ajv.addSchema(schema);
  }

  const validate = ajv.getSchema('ModuleDescriptor.json') ?? ajv.compile(okapiModuleDescriptorRootSchema);
  const valid = validate(descriptor) === true;

  return {
    valid,
    schemaBaseline: OKAPI_MODULE_DESCRIPTOR_SCHEMA_BASELINE,
    errors: (validate.errors ?? []).map(error => ({
      instancePath: error.instancePath || '',
      schemaPath: error.schemaPath,
      keyword: error.keyword,
      message: error.message ?? 'schema validation failed'
    }))
  };
}
