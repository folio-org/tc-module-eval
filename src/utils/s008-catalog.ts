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
  if (catalog.channel !== channel) diagnostics.push({ code: 'catalog_channel_mismatch', message: `The ${channel} catalog file says it is the ${catalog.channel} catalog.`, path: '/channel' });
  if (!catalog.authoritative) diagnostics.push({ code: 'catalog_not_authoritative', message: 'The catalog has not been marked as reviewed (authoritative is false).', path: '/authoritative' });
  duplicates(catalog.providers.map(item => item.moduleId), 'provider module ID', diagnostics);
  duplicates(catalog.eurekaComponents.map(item => item.familyId), 'Eureka component family ID', diagnostics);
  const componentIdentities = catalog.eurekaComponents.flatMap(item => item.moduleIdentities);
  duplicates(componentIdentities, 'Eureka component module identity', diagnostics);
  for (const [index, component] of catalog.eurekaComponents.entries()) {
    const descriptorSource = component.descriptorSource;
    if (descriptorSource.status === 'unresolved') diagnostics.push({
      code: 'catalog_unresolved_component',
      message: `The catalog does not say where the descriptor of Eureka component ${component.familyId} ${component.version} came from.`,
      path: `/eurekaComponents/${index}/descriptorSource`
    });
    if (descriptorSource.status === 'acquired' && !catalog.providers.some(provider =>
      component.moduleIdentities.includes(provider.moduleIdentity)
      && provider.descriptorHash === descriptorSource.descriptorHash
    )) diagnostics.push({
      code: 'catalog_component_provider_missing',
      message: `The catalog has no provider entry matching the descriptor of Eureka component ${component.familyId} ${component.version}.`,
      path: `/eurekaComponents/${index}/descriptorSource`
    });
  }
  for (const [providerIndex, provider] of catalog.providers.entries()) {
    for (const [interfaceIndex, provided] of provider.provides.entries()) {
      if (!isSupportedEurekaVersionExpression(provided.version, true)) {
        diagnostics.push({
          code: 'catalog_invalid_interface_version',
          message: `The catalog says ${provider.moduleId} provides ${provided.id} with the version "${provided.version}", which S008 cannot check.`,
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
    if (seen.has(value)) diagnostics.push({ code: 'duplicate_entry', message: `The catalog lists the ${label} ${value} more than once.` });
    seen.add(value);
  }
}
