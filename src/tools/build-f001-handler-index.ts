#!/usr/bin/env node
import fs from 'fs-extra';
import path from 'path';
import { Command } from 'commander';
import { F001HandlerIndex, S008Catalog } from '../types';
import { parseFarApplication, PlatformParseDiagnostic } from '../utils/platform-applications';
import { sha256Digest } from '../utils/repo-files';
import { unique } from '../utils/report-text';
import { errorMessage, isRecord } from '../utils/type-guards';
import { ensureTrailingSlash, fetchJson, FetchOptions, mapLimit, stableStringify, validateBaseUrl } from './acquire-s008-catalog';

const DEFAULT_CATALOG = path.resolve(__dirname, '../../config/s008-catalog-official.json');
const DEFAULT_OUTPUT = path.resolve(__dirname, '../../config/f001-handler-index.json');
const DEFAULT_FAR_URL = 'https://far.ci.folio.org';
const FAR_SOURCE = 'FAR:';

export interface BuildF001HandlerIndexOptions {
  catalogPath?: string;
  farUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * The F001 handler index for the S008 official catalog. Every provider's descriptor is fetched again from the source
 * the catalog records for it (a FAR application with `full=true`, or a manager's pinned descriptor URL) and must hash
 * to the catalog's descriptor hash, so the index describes exactly the descriptors S008 reviewed. That includes
 * providers outside the platform's own applications, such as mod-circulation-bff from app-requests-ecs. The catalog
 * itself is only read.
 */
export async function buildF001HandlerIndex(options: BuildF001HandlerIndexOptions = {}): Promise<F001HandlerIndex> {
  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG;
  const catalogText = await fs.readFile(catalogPath, 'utf8');
  const catalog = JSON.parse(catalogText) as S008Catalog;
  const farBase = ensureTrailingSlash(validateBaseUrl(options.farUrl ?? DEFAULT_FAR_URL, 'FAR'));
  const fetchOptions: FetchOptions = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.requestTimeoutMs ?? 30_000,
    maxBytes: options.maxResponseBytes ?? 8 * 1024 * 1024
  };

  // Each provider names its sources: `FAR:<application id>` (several joined by "; ") or a descriptor URL.
  const sources = unique(catalog.providers.flatMap(provider => provider.source.split('; '))).sort();
  const applicationIds = sources.filter(source => source.startsWith(FAR_SOURCE)).map(source => source.slice(FAR_SOURCE.length));
  const descriptorUrls = sources.filter(source => !source.startsWith(FAR_SOURCE));

  const descriptors = new Map<string, Record<string, unknown>[]>();
  const add = (descriptor: unknown) => {
    if (!isRecord(descriptor) || typeof descriptor.id !== 'string') return;
    descriptors.set(descriptor.id, [...descriptors.get(descriptor.id) ?? [], descriptor]);
  };
  await mapLimit(applicationIds, 4, async applicationId => {
    const pin = /^(.+)-(\d+\.\d+\.\d+.*)$/.exec(applicationId);
    if (!pin) throw new Error(`The catalog names a FAR source that is not an application id: ${applicationId}`);
    const url = new URL('applications', farBase);
    url.searchParams.set('query', `id==${applicationId}`);
    url.searchParams.set('full', 'true');
    url.searchParams.set('limit', '2');
    const diagnostics: PlatformParseDiagnostic[] = [];
    const application = parseFarApplication((await fetchJson(url, fetchOptions)).parsed, { name: pin[1], version: pin[2] }, url.toString(), diagnostics);
    if (!application) throw new Error(diagnostics.map(item => item.message).join('; ') || `FAR returned no application ${applicationId}`);
    for (const field of ['moduleDescriptors', 'uiModuleDescriptors']) {
      if (Array.isArray(application[field])) application[field].forEach(add);
    }
  });
  await mapLimit(descriptorUrls, 4, async source => {
    add((await fetchJson(validateBaseUrl(source, 'Descriptor source'), fetchOptions)).parsed);
  });

  const providers = catalog.providers.map(provider => {
    const descriptor = (descriptors.get(provider.moduleId) ?? [])
      .find(candidate => sha256Digest(stableStringify(candidate)) === provider.descriptorHash);
    if (!descriptor) {
      throw new Error(descriptors.has(provider.moduleId)
        ? `The descriptor of ${provider.moduleId} from ${provider.source} does not match the catalog's hash ${provider.descriptorHash}.`
        : `No descriptor of ${provider.moduleId} was found in ${provider.source}.`);
    }
    return { moduleId: provider.moduleId, descriptorHash: provider.descriptorHash, interfaces: providedInterfaces(descriptor, provider.moduleId) };
  });

  return {
    schemaVersion: '1.0',
    baseline: {
      platformRepository: catalog.baseline.platformRepository,
      platformCommit: catalog.baseline.platformCommit,
      descriptorVersion: catalog.baseline.descriptorVersion
    },
    s008Catalog: { path: path.relative(path.resolve(__dirname, '../..'), path.resolve(catalogPath)).split(path.sep).join('/'), digest: sha256Digest(catalogText) },
    providers: providers.sort((a, b) => a.moduleId.localeCompare(b.moduleId))
  };
}

function providedInterfaces(descriptor: Record<string, unknown>, moduleId: string): F001HandlerIndex['providers'][number]['interfaces'] {
  const provides = Array.isArray(descriptor.provides) ? descriptor.provides.filter(isRecord) : [];
  return provides.flatMap(provided => {
    const id = String(provided.id);
    const interfaceType = typeof provided.interfaceType === 'string' ? provided.interfaceType : undefined;
    if (id.startsWith('_') || interfaceType === 'system') return [];
    const handlers = (Array.isArray(provided.handlers) ? provided.handlers.filter(isRecord) : []).flatMap(handler => {
      if (typeof handler.pathPattern === 'string') {
        return [{
          methods: (Array.isArray(handler.methods) ? handler.methods.filter((method): method is string => typeof method === 'string') : []).sort(),
          pathPattern: handler.pathPattern
        }];
      }
      // Okapi's legacy prefix `path` would need its own matching; no descriptor of the release uses it.
      if (handler.path !== undefined) throw new Error(`${moduleId} provides ${id} with a handler that has a path but no pathPattern.`);
      return [];
    });
    return handlers.length ? [{ id, version: String(provided.version), ...(interfaceType ? { interfaceType } : {}), handlers }] : [];
  }).sort((a, b) => `${a.id}\0${a.version}`.localeCompare(`${b.id}\0${b.version}`));
}

if (require.main === module) {
  const program = new Command();
  program
    .option('--catalog <path>', 'S008 catalog whose providers to index', DEFAULT_CATALOG)
    .option('--output <path>', 'handler index to write', DEFAULT_OUTPUT)
    .option('--far-url <url>', 'trusted FAR base URL', DEFAULT_FAR_URL)
    .action(async raw => {
      const index = await buildF001HandlerIndex({ catalogPath: raw.catalog, farUrl: raw.farUrl });
      await fs.writeFile(raw.output, stableStringify(index));
    });
  program.parseAsync().catch(error => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
