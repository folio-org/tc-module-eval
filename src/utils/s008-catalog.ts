import path from 'path';
import Ajv from 'ajv';
import schema from '../schemas/s008-interface-catalog.schema.json';
import { S008Catalog, S008CatalogChannel, S008PolicyDiagnostic, S008PolicyLoadResult } from '../types';
import { failure, readJson, schemaDiagnostic, success } from './acceptance-ledger';
import { isSupportedEurekaVersionExpression } from './eureka-interface-compatibility';

export const DEFAULT_S008_CATALOG_PATHS: Record<S008CatalogChannel, string> = {
  official: path.resolve(__dirname, '../../config/s008-catalog-official.json'),
  development: path.resolve(__dirname, '../../config/s008-catalog-development.json')
};
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

export async function loadS008Catalog(
  channel: S008CatalogChannel = 'official',
  catalogPaths: Partial<Record<S008CatalogChannel, string>> = DEFAULT_S008_CATALOG_PATHS
): Promise<S008PolicyLoadResult<S008Catalog>> {
  const sourcePath = catalogPaths[channel] ?? DEFAULT_S008_CATALOG_PATHS[channel];
  const loaded = await readJson(sourcePath);
  if (!loaded.ok) return loaded;
  if (!validate(loaded.parsed)) return failure(sourcePath, (validate.errors ?? []).map(schemaDiagnostic));

  const catalog = loaded.parsed as unknown as S008Catalog;
  const diagnostics: S008PolicyDiagnostic[] = [];
  if (catalog.channel !== channel) diagnostics.push({ code: 'catalog_channel_mismatch', message: `Selected ${channel} but catalog declares ${catalog.channel}.`, path: '/channel' });
  if (!catalog.authoritative) diagnostics.push({ code: 'catalog_not_authoritative', message: 'Catalog has not been marked reviewed.', path: '/authoritative' });
  duplicates(catalog.providers.map(item => item.moduleId), 'provider module ID', diagnostics);
  duplicates(catalog.eurekaComponents.map(item => item.familyId), 'Eureka component family ID', diagnostics);
  const componentIdentities = catalog.eurekaComponents.flatMap(item => item.moduleIdentities);
  duplicates(componentIdentities, 'Eureka component module identity', diagnostics);
  for (const [index, component] of catalog.eurekaComponents.entries()) {
    const descriptorSource = component.descriptorSource;
    if (descriptorSource.status === 'unresolved') diagnostics.push({
      code: 'catalog_unresolved_component',
      message: `Eureka component ${component.familyId}@${component.version} has unresolved descriptor provenance.`,
      path: `/eurekaComponents/${index}/descriptorSource`
    });
    if (descriptorSource.status === 'acquired' && !catalog.providers.some(provider =>
      component.moduleIdentities.includes(provider.moduleIdentity)
      && provider.descriptorHash === descriptorSource.descriptorHash
    )) diagnostics.push({
      code: 'catalog_component_provider_missing',
      message: `Eureka component ${component.familyId}@${component.version} has no provider matching its acquired descriptor provenance.`,
      path: `/eurekaComponents/${index}/descriptorSource`
    });
  }
  for (const [providerIndex, provider] of catalog.providers.entries()) {
    for (const [interfaceIndex, provided] of provider.provides.entries()) {
      if (!isSupportedEurekaVersionExpression(provided.version, true)) {
        diagnostics.push({
          code: 'catalog_invalid_interface_version',
          message: `Provider ${provider.moduleId} has unsupported version syntax for ${provided.id}: ${provided.version}`,
          path: `/providers/${providerIndex}/provides/${interfaceIndex}/version`
        });
      }
    }
  }
  if (diagnostics.length) return failure(sourcePath, diagnostics);
  return success(sourcePath, loaded.content, catalog);
}

function duplicates(values: string[], label: string, diagnostics: S008PolicyDiagnostic[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) diagnostics.push({ code: 'duplicate_entry', message: `Duplicate ${label}: ${value}` });
    seen.add(value);
  }
}
