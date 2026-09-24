#!/usr/bin/env node
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { Command } from 'commander';
import { S008CatalogChannel } from '../types';
import { isSupportedEurekaVersionExpression } from '../utils/eureka-interface-compatibility';
import { importS008Catalog } from './import-s008-catalog';

const DEFAULT_PLATFORM_RAW_BASE = 'https://raw.githubusercontent.com/folio-org/platform-lsp';
const DEFAULT_FAR_URL = 'https://far.ci.folio.org';
const DEFAULT_REGISTRY_URL = 'https://folio-registry.dev.folio.org';
const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const DESCRIPTORLESS_COMPONENTS = new Set(['folio-keycloak', 'folio-kong', 'folio-module-sidecar']);
const COMPONENT_DESCRIPTOR_REPOSITORIES: Readonly<Record<string, string>> = {
  'mgr-applications': 'mgr-applications',
  'mgr-tenants': 'mgr-tenants',
  'mgr-tenant-entitlements': 'mgr-tenant-entitlements'
};
const COMPONENT_DESCRIPTOR_PATH = 'src/main/resources/descriptors/ModuleDescriptor.json';

export interface AcquireS008Options {
  platformCommit: string;
  channel: S008CatalogChannel;
  outputDir: string;
  farUrl?: string;
  registryUrl?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  concurrency?: number;
  platformRawBaseUrl?: string;
  githubApiBaseUrl?: string;
  githubRawBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface Diagnostic {
  code: string;
  material: boolean;
  message: string;
  source?: string;
}

interface ModuleReference {
  id: string;
  identity: string;
  version: string;
  sourceApplication?: string;
  component?: string;
  embedded?: unknown;
}

type ComponentDescriptorProvenance =
  { name: string; version: string; status: 'acquired'; kind: 'registry'; source: string }
  | { name: string; version: string; status: 'acquired'; kind: 'repository-tag'; repository: string; tag: string; commit: string; source: string };

interface AcquiredDescriptor {
  moduleId: string;
  moduleIdentity: string;
  descriptor: Record<string, unknown>;
  source: string;
  sources: Array<{ kind: 'application' | 'eureka-component'; name: string }>;
  componentProvenance?: ComponentDescriptorProvenance;
}

interface DiscoveryIdentity {
  moduleIdentity: string;
  observedModuleIds: string[];
  observedModules: Array<{ id: string; version: string }>;
  sources: Array<{ kind: 'application' | 'eureka-component'; name: string }>;
  descriptors: Array<{ moduleId: string; source: string; digest: string }>;
  suggestions: { familyId?: string; displayName?: string; canonicalRepositories?: string[] };
  descriptorStatus: 'acquired' | 'intentionally-descriptorless' | 'unresolved';
  unreviewed: true;
}

export async function acquireS008Catalog(options: AcquireS008Options): Promise<void> {
  validateCommit(options.platformCommit);
  if (!['official', 'development'].includes(options.channel)) throw new Error('channel must be official or development');
  const farBase = validateBaseUrl(options.farUrl ?? DEFAULT_FAR_URL, 'FAR');
  const registryBase = validateBaseUrl(options.registryUrl ?? DEFAULT_REGISTRY_URL, 'registry');
  const platformBase = validateBaseUrl(options.platformRawBaseUrl ?? DEFAULT_PLATFORM_RAW_BASE, 'Platform source');
  const githubApiBase = validateBaseUrl(options.githubApiBaseUrl ?? DEFAULT_GITHUB_API_BASE, 'GitHub API');
  const githubRawBase = validateBaseUrl(options.githubRawBaseUrl ?? DEFAULT_GITHUB_RAW_BASE, 'GitHub raw source');
  const outputDir = path.resolve(options.outputDir);
  if (await fs.pathExists(outputDir)) throw new Error(`Output directory already exists: ${outputDir}`);
  const concurrency = positiveInteger(options.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency');

  const temporaryDir = `${outputDir}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const snapshotsDir = path.join(temporaryDir, 'snapshots');
  const diagnostics: Diagnostic[] = [];
  const fetchOptions: FetchOptions = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: positiveInteger(options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'request timeout'),
    maxBytes: positiveInteger(options.maxResponseBytes ?? DEFAULT_MAX_BYTES, 'maximum response bytes')
  };

  try {
    await fs.ensureDir(snapshotsDir);
    const platformUrl = new URL(`${options.platformCommit}/platform-descriptor.json`, ensureTrailingSlash(platformBase));
    const platform = await fetchJson(platformUrl, fetchOptions);
    const platformDescriptor = asRecord(platform.parsed, 'Platform descriptor');
    await writeStable(path.join(snapshotsDir, 'platform-descriptor.json'), platformDescriptor);

    const platformVersion = requiredString(platformDescriptor.version, 'Platform descriptor version');
    const applicationPins = collectApplicationPins(platformDescriptor, diagnostics);
    const componentPins = collectComponentPins(platformDescriptor, diagnostics);
    const applications = (await mapLimit(applicationPins, concurrency, async pin =>
      acquireApplication(pin, farBase, snapshotsDir, fetchOptions, diagnostics)
    )).filter((value): value is AcquiredApplication => Boolean(value));

    const references: ModuleReference[] = applications.flatMap(application => application.references);
    references.push(...componentPins.map(component => ({
      id: `${component.name}-${component.version}`,
      identity: component.name,
      version: component.version,
      component: component.name
    })));

    const acquired = (await mapLimit(references, concurrency, reference =>
      acquireDescriptor(reference, registryBase, githubApiBase, githubRawBase, fetchOptions, diagnostics)
    )).filter((value): value is AcquiredDescriptor => Boolean(value));
    const descriptors = deduplicateDescriptors(acquired, diagnostics);

    const descriptorDirectory = path.join(snapshotsDir, 'descriptors');
    await fs.ensureDir(descriptorDirectory);
    const providerManifest: Array<{ moduleIdentity: string; source: string; descriptorPath: string }> = [];
    for (const descriptor of descriptors) {
      const relativePath = `snapshots/descriptors/${safeName(descriptor.moduleId)}.json`;
      await writeStable(path.join(temporaryDir, relativePath), descriptor.descriptor);
      providerManifest.push({
        moduleIdentity: descriptor.moduleIdentity,
        source: descriptor.source,
        descriptorPath: relativePath
      });
    }

    const manifest = {
      channel: options.channel,
      platform: {
        repository: 'https://github.com/folio-org/platform-lsp',
        commit: options.platformCommit,
        descriptorVersion: platformVersion,
        descriptorPath: 'snapshots/platform-descriptor.json'
      },
      applications: applications.map(application => ({
        name: application.name,
        version: application.version,
        optional: application.optional,
        farSource: application.farSource,
        descriptorPath: application.snapshotPath
      })).sort(byJson),
      eurekaComponents: componentPins.map(component => ({
        familyId: component.name,
        moduleIdentities: [component.name]
      })).sort(byJson),
      componentSources: componentPins.map(component => componentSourceManifest(component, descriptors)).sort(byJson),
      providers: providerManifest.sort(byJson)
    };
    const manifestPath = path.join(temporaryDir, 'snapshot-manifest.json');
    await writeStable(manifestPath, manifest);
    const catalog = await importS008Catalog(manifestPath);
    catalog.authoritative = false;

    const discovery = buildDiscovery(references, descriptors);
    const diagnosticReport = {
      schemaVersion: '1.0',
      complete: !diagnostics.some(item => item.material),
      diagnostics: diagnostics.sort(byJson)
    };
    await writeStable(path.join(temporaryDir, 's008-catalog.json'), catalog);
    await writeStable(path.join(temporaryDir, 's008-discovered-identities.json'), {
      schemaVersion: '1.0', authoritative: false, reviewStatus: 'unreviewed', identities: discovery
    });
    await writeStable(path.join(temporaryDir, 'acquisition-diagnostics.json'), diagnosticReport);
    await fs.ensureDir(path.dirname(outputDir));
    await fs.rename(temporaryDir, outputDir);
  } catch (error) {
    await fs.remove(temporaryDir);
    throw error;
  }
}

interface ApplicationPin { name: string; version: string; optional: boolean }
interface ComponentPin { name: string; version: string }
interface AcquiredApplication extends ApplicationPin {
  farSource: string;
  snapshotPath: string;
  references: ModuleReference[];
}

async function acquireApplication(
  pin: ApplicationPin,
  farBase: URL,
  snapshotsDir: string,
  fetchOptions: FetchOptions,
  diagnostics: Diagnostic[]
): Promise<AcquiredApplication | undefined> {
  const exactId = `${pin.name}-${pin.version}`;
  const url = new URL('applications', ensureTrailingSlash(farBase));
  url.searchParams.set('query', `id==${exactId}`);
  url.searchParams.set('full', 'true');
  url.searchParams.set('limit', '2');
  let response: JsonResponse;
  try {
    response = await fetchJson(url, fetchOptions);
  } catch (error) {
    diagnostics.push(httpDiagnostic('far_request_failed', error, exactId));
    return undefined;
  }
  const envelope = asOptionalRecord(response.parsed);
  const records = Array.isArray(envelope?.applicationDescriptors) ? envelope!.applicationDescriptors : [];
  const totalRecords = typeof envelope?.totalRecords === 'number' ? envelope.totalRecords : records.length;
  if (records.length !== 1 || totalRecords !== 1) {
    diagnostics.push({ code: 'far_cardinality', material: true, message: `Expected exactly one FAR result for ${exactId}; received ${totalRecords}.`, source: url.toString() });
    return undefined;
  }
  const application = asOptionalRecord(records[0]);
  if (!application || application.id !== exactId || application.name !== pin.name || application.version !== pin.version) {
    diagnostics.push({ code: 'far_identity_mismatch', material: true, message: `FAR result did not exactly match ${exactId}.`, source: url.toString() });
    return undefined;
  }
  const snapshotPath = `snapshots/applications/${safeName(exactId)}.json`;
  await writeStable(path.join(path.dirname(snapshotsDir), snapshotPath), application);
  const references = [
    ...moduleReferences(application.modules, application.moduleDescriptors, exactId, 'moduleDescriptors', diagnostics),
    ...moduleReferences(application.uiModules, application.uiModuleDescriptors, exactId, 'uiModuleDescriptors', diagnostics)
  ];
  return { ...pin, farSource: url.toString(), snapshotPath, references };
}

function moduleReferences(
  rawReferences: unknown,
  rawEmbedded: unknown,
  applicationId: string,
  field: string,
  diagnostics: Diagnostic[]
): ModuleReference[] {
  if (rawReferences !== undefined && !Array.isArray(rawReferences)) diagnostics.push({
    code: 'invalid_module_references', material: true,
    message: `${applicationId} module references paired with ${field} must be an array.`
  });
  if (rawEmbedded !== undefined && !Array.isArray(rawEmbedded)) diagnostics.push({
    code: 'invalid_embedded_descriptors', material: true,
    message: `${applicationId} ${field} must be an array.`
  });
  const references = Array.isArray(rawReferences) ? rawReferences : [];
  const embedded = Array.isArray(rawEmbedded) ? rawEmbedded : [];
  const embeddedById = new Map<string, unknown>();
  const conflictingEmbedded = new Set<string>();
  for (const candidate of embedded) {
    const record = asOptionalRecord(candidate);
    if (!record || typeof record.id !== 'string') {
      diagnostics.push({ code: 'invalid_embedded_descriptor', material: true, message: `${applicationId} ${field} contains a descriptor without an exact ID.` });
      continue;
    }
    const existing = embeddedById.get(record.id);
    if (existing && stableStringify(existing) !== stableStringify(candidate)) {
      diagnostics.push({ code: 'conflicting_descriptor_bytes', material: true, message: `${applicationId} contains conflicting embedded descriptors for ${record.id}.` });
      conflictingEmbedded.add(record.id);
      embeddedById.delete(record.id);
    } else if (!conflictingEmbedded.has(record.id)) {
      embeddedById.set(record.id, candidate);
    }
  }
  const parsedReferences = references.flatMap(reference => {
    const record = asOptionalRecord(reference);
    if (!record || typeof record.id !== 'string') {
      diagnostics.push({ code: 'invalid_module_reference', material: true, message: `${applicationId} contains a module reference without an exact ID.` });
      return [];
    }
    const identity = moduleIdentity(record);
    if (!identity) {
      diagnostics.push({ code: 'unresolved_module_identity', material: true, message: `Unable to derive module identity for ${record.id}.`, source: applicationId });
      return [];
    }
    const version = typeof record.version === 'string' && record.version
      ? record.version
      : record.id.slice(identity.length + 1);
    if (!version || record.id !== `${identity}-${version}`) {
      diagnostics.push({ code: 'unresolved_module_version', material: true, message: `Unable to derive exact module version for ${record.id}.`, source: applicationId });
      return [];
    }
    const candidate = embeddedById.get(record.id);
    const embeddedRecord = asOptionalRecord(candidate);
    const usableEmbedded = embeddedRecord?.id === record.id ? candidate : undefined;
    if (candidate && !usableEmbedded) diagnostics.push({ code: 'embedded_descriptor_mismatch', material: true, message: `${field} entry did not match ${record.id}.`, source: applicationId });
    return [{ id: record.id, identity, version, sourceApplication: applicationId, embedded: usableEmbedded }];
  });
  const referenceIds = new Set(parsedReferences.map(reference => reference.id));
  for (const embeddedId of embeddedById.keys()) {
    if (!referenceIds.has(embeddedId)) diagnostics.push({
      code: 'embedded_descriptor_identity_mismatch', material: true,
      message: `${applicationId} ${field} contains unreferenced descriptor ${embeddedId}.`, source: applicationId
    });
  }
  return parsedReferences;
}

async function acquireDescriptor(
  reference: ModuleReference,
  registryBase: URL,
  githubApiBase: URL,
  githubRawBase: URL,
  fetchOptions: FetchOptions,
  diagnostics: Diagnostic[]
): Promise<AcquiredDescriptor | undefined> {
  const sources = reference.sourceApplication
    ? [{ kind: 'application' as const, name: reference.sourceApplication }]
    : [{ kind: 'eureka-component' as const, name: reference.component! }];
  if (reference.component && DESCRIPTORLESS_COMPONENTS.has(reference.component)) return undefined;
  if (reference.component && COMPONENT_DESCRIPTOR_REPOSITORIES[reference.component]) {
    return acquireComponentDescriptor(reference, githubApiBase, githubRawBase, fetchOptions, diagnostics);
  }
  if (reference.embedded) {
    const descriptor = asOptionalRecord(reference.embedded);
    if (descriptor?.id === reference.id) {
      if (!validProvides(descriptor)) {
        diagnostics.push({ code: 'invalid_provider_descriptor', material: true, message: `${reference.id} has non-concrete provides metadata.`, source: `FAR:${reference.sourceApplication}` });
        return undefined;
      }
      diagnoseProvideVersions(descriptor, reference.id, `FAR:${reference.sourceApplication}`, diagnostics);
      return { moduleId: reference.id, moduleIdentity: reference.identity, descriptor, source: `FAR:${reference.sourceApplication}`, sources };
    }
  }
  const url = new URL(`_/proxy/modules/${encodeURIComponent(reference.id)}`, ensureTrailingSlash(registryBase));
  try {
    const response = await fetchJson(url, fetchOptions);
    const descriptor = asRecord(response.parsed, `Registry descriptor ${reference.id}`);
    if (descriptor.id !== reference.id) {
      diagnostics.push({ code: 'registry_identity_mismatch', material: true, message: `Registry descriptor ID did not match ${reference.id}.`, source: url.toString() });
      return undefined;
    }
    if (!validProvides(descriptor)) {
      diagnostics.push({ code: 'invalid_provider_descriptor', material: true, message: `${reference.id} has non-concrete provides metadata.`, source: url.toString() });
      return undefined;
    }
    diagnoseProvideVersions(descriptor, reference.id, url.toString(), diagnostics);
    return {
      moduleId: reference.id, moduleIdentity: reference.identity, descriptor, source: url.toString(), sources,
      ...(reference.component ? { componentProvenance: { name: reference.component, version: reference.version, status: 'acquired' as const, kind: 'registry' as const, source: url.toString() } } : {})
    };
  } catch (error) {
    const code = reference.component ? 'unresolved_component_descriptor' : 'registry_request_failed';
    diagnostics.push(httpDiagnostic(code, error, reference.id));
    return undefined;
  }
}

async function acquireComponentDescriptor(
  reference: ModuleReference,
  githubApiBase: URL,
  githubRawBase: URL,
  fetchOptions: FetchOptions,
  diagnostics: Diagnostic[]
): Promise<AcquiredDescriptor | undefined> {
  const name = reference.component!;
  const repository = COMPONENT_DESCRIPTOR_REPOSITORIES[name];
  const tag = `v${reference.version}`;
  const tagUrl = new URL(`repos/folio-org/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, ensureTrailingSlash(githubApiBase));
  try {
    const tagResponse = asRecord((await fetchJson(tagUrl, fetchOptions)).parsed, `${name} release tag`);
    const tagObject = asRecord(tagResponse.object, `${name} release tag object`);
    let commit = requiredCommit(tagObject.sha, `${name} release tag`);
    if (tagObject.type === 'tag') {
      const annotatedTagUrl = new URL(`repos/folio-org/${repository}/git/tags/${commit}`, ensureTrailingSlash(githubApiBase));
      const annotatedTag = asRecord((await fetchJson(annotatedTagUrl, fetchOptions)).parsed, `${name} annotated tag`);
      const target = asRecord(annotatedTag.object, `${name} annotated tag target`);
      if (target.type !== 'commit') throw new Error(`${name} ${tag} does not resolve directly to a commit`);
      commit = requiredCommit(target.sha, `${name} annotated tag target`);
    } else if (tagObject.type !== 'commit') {
      throw new Error(`${name} ${tag} has unsupported Git object type: ${String(tagObject.type)}`);
    }

    const sourceUrl = new URL(`folio-org/${repository}/${commit}/${COMPONENT_DESCRIPTOR_PATH}`, ensureTrailingSlash(githubRawBase));
    const descriptor = asRecord((await fetchJson(sourceUrl, fetchOptions)).parsed, `${name} component descriptor`);
    if (typeof descriptor.id !== 'string' || !descriptor.id.startsWith(`${name}-`)) {
      diagnostics.push({ code: 'component_descriptor_identity_mismatch', material: true, message: `${name} ${tag} descriptor ID does not belong to the component family.`, source: sourceUrl.toString() });
      return undefined;
    }
    if (!validProvides(descriptor)) {
      diagnostics.push({ code: 'invalid_provider_descriptor', material: true, message: `${name} ${tag} has non-concrete provides metadata.`, source: sourceUrl.toString() });
      return undefined;
    }
    diagnoseProvideVersions(descriptor, descriptor.id, sourceUrl.toString(), diagnostics);
    return {
      moduleId: descriptor.id,
      moduleIdentity: name,
      descriptor,
      source: sourceUrl.toString(),
      sources: [{ kind: 'eureka-component', name }],
      componentProvenance: { name, version: reference.version, status: 'acquired', kind: 'repository-tag', repository: `folio-org/${repository}`, tag, commit, source: sourceUrl.toString() }
    };
  } catch (error) {
    diagnostics.push(httpDiagnostic('component_tag_descriptor_failed', error, `${name}@${tag}`));
    return undefined;
  }
}

function deduplicateDescriptors(descriptors: AcquiredDescriptor[], diagnostics: Diagnostic[]): AcquiredDescriptor[] {
  const byId = new Map<string, AcquiredDescriptor>();
  const conflicted = new Set<string>();
  for (const descriptor of descriptors.sort((a, b) => a.moduleId.localeCompare(b.moduleId))) {
    if (conflicted.has(descriptor.moduleId)) continue;
    const existing = byId.get(descriptor.moduleId);
    if (!existing) {
      byId.set(descriptor.moduleId, descriptor);
      continue;
    }
    if (stableStringify(existing.descriptor) !== stableStringify(descriptor.descriptor)) {
      diagnostics.push({ code: 'conflicting_descriptor_bytes', material: true, message: `Conflicting descriptors were acquired for ${descriptor.moduleId}.` });
      byId.delete(descriptor.moduleId);
      conflicted.add(descriptor.moduleId);
      continue;
    }
    existing.sources = uniqueByJson([...existing.sources, ...descriptor.sources]);
    existing.source = [...new Set([...existing.source.split('; '), descriptor.source])].sort().join('; ');
    existing.componentProvenance ??= descriptor.componentProvenance;
  }
  return [...byId.values()].sort((a, b) => `${a.moduleIdentity}\0${a.moduleId}`.localeCompare(`${b.moduleIdentity}\0${b.moduleId}`));
}

function buildDiscovery(references: ModuleReference[], descriptors: AcquiredDescriptor[]): DiscoveryIdentity[] {
  const identities = new Map<string, DiscoveryIdentity>();
  for (const reference of references) {
    const current = identities.get(reference.identity) ?? {
      moduleIdentity: reference.identity,
      observedModuleIds: [], observedModules: [], sources: [], descriptors: [],
      suggestions: { familyId: reference.identity },
      descriptorStatus: DESCRIPTORLESS_COMPONENTS.has(reference.identity) ? 'intentionally-descriptorless' as const : 'unresolved' as const,
      unreviewed: true as const
    };
    current.observedModuleIds.push(reference.id);
    current.observedModules.push({ id: reference.id, version: reference.version });
    current.sources.push(reference.sourceApplication
      ? { kind: 'application', name: reference.sourceApplication }
      : { kind: 'eureka-component', name: reference.component! });
    identities.set(reference.identity, current);
  }
  for (const descriptor of descriptors) {
    const current = identities.get(descriptor.moduleIdentity)!;
    current.descriptorStatus = 'acquired';
    current.descriptors.push({ moduleId: descriptor.moduleId, source: descriptor.source, digest: digest(stableStringify(descriptor.descriptor)) });
    if (!current.suggestions.displayName && typeof descriptor.descriptor.name === 'string') current.suggestions.displayName = descriptor.descriptor.name;
    const repository = repositoryHint(descriptor.descriptor);
    if (repository) current.suggestions.canonicalRepositories = [repository];
    identities.set(descriptor.moduleIdentity, current);
  }
  return [...identities.values()].map(identity => ({
    ...identity,
    observedModuleIds: [...new Set(identity.observedModuleIds)].sort(),
    observedModules: uniqueByJson(identity.observedModules),
    sources: uniqueByJson(identity.sources),
    descriptors: uniqueByJson(identity.descriptors)
  })).sort((a, b) => a.moduleIdentity.localeCompare(b.moduleIdentity));
}

function componentSourceManifest(component: ComponentPin, descriptors: AcquiredDescriptor[]): object {
  if (DESCRIPTORLESS_COMPONENTS.has(component.name)) return {
    name: component.name, version: component.version, status: 'intentionally-descriptorless'
  };
  const acquired = descriptors.find(descriptor => descriptor.componentProvenance?.name === component.name);
  return acquired?.componentProvenance
    ? { ...acquired.componentProvenance, descriptorHash: digest(stableStringify(acquired.descriptor)) }
    : { name: component.name, version: component.version, status: 'unresolved' };
}

function collectApplicationPins(platform: Record<string, unknown>, diagnostics: Diagnostic[]): ApplicationPin[] {
  const applications = asOptionalRecord(platform.applications);
  if (platform.applications !== undefined && !applications) {
    diagnostics.push({ code: 'invalid_application_container', material: true, message: 'Platform applications must be an object.' });
  }
  const groups: Array<{ values: unknown; optional: boolean }> = [
    { values: applications?.required, optional: false },
    { values: applications?.optional, optional: true }
  ];
  return groups.flatMap(group => parsePins(group.values, group.optional, 'application', diagnostics));
}

function collectComponentPins(platform: Record<string, unknown>, diagnostics: Diagnostic[]): ComponentPin[] {
  return parsePins(platform['eureka-components'], false, 'component', diagnostics).map(({ name, version }) => ({ name, version }));
}

function parsePins(values: unknown, optional: boolean, kind: string, diagnostics: Diagnostic[]): ApplicationPin[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    diagnostics.push({ code: `invalid_${kind}_pins`, material: true, message: `Platform ${kind} pins must be an array.` });
    return [];
  }
  return values.flatMap((value, index) => {
    const record = asOptionalRecord(value);
    if (!record || typeof record.name !== 'string' || typeof record.version !== 'string' || !record.name || !record.version) {
      diagnostics.push({ code: `invalid_${kind}_pin`, material: true, message: `Platform ${kind} pin ${index} lacks concrete name/version.` });
      return [];
    }
    return [{ name: record.name, version: record.version, optional }];
  }).sort(byJson);
}

interface FetchOptions { fetchImpl: typeof fetch; timeoutMs: number; maxBytes: number }
interface JsonResponse { parsed: unknown }

async function fetchJson(url: URL, options: FetchOptions): Promise<JsonResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 401 || response.status === 403 ? ' (authentication is not supported)' : ''} from ${url}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) throw new Error(`Response exceeds ${options.maxBytes} bytes: ${url}`);
    const chunks: Buffer[] = [];
    let received = 0;
    if (!response.body) throw new Error(`Empty response body from ${url}`);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > options.maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds ${options.maxBytes} bytes: ${url}`);
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, received);
    return { parsed: JSON.parse(bytes.toString('utf8')) };
  } finally {
    clearTimeout(timeout);
  }
}

function validateBaseUrl(value: string, label: string): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(`${label} URL must use HTTPS (HTTP is allowed only for loopback tests).`);
  if (url.username || url.password) throw new Error(`${label} URL must not contain credentials.`);
  return url;
}

function validateCommit(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value) || /^0+$/.test(value)) throw new Error('--platform-commit must be an explicit immutable 40-character lowercase commit SHA');
}

function moduleIdentity(reference: Record<string, unknown>): string | undefined {
  if (typeof reference.name === 'string' && reference.name) return reference.name;
  const id = reference.id as string;
  if (typeof reference.version === 'string' && id.endsWith(`-${reference.version}`)) {
    return id.slice(0, -reference.version.length - 1);
  }
  return undefined;
}

function repositoryHint(descriptor: Record<string, unknown>): string | undefined {
  const metadata = asOptionalRecord(descriptor.metadata);
  const candidate = metadata?.repository;
  if (typeof candidate === 'string' && /^https:\/\/github\.com\/folio-org\/[A-Za-z0-9_.-]+\/?$/.test(candidate)) return candidate.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  return undefined;
}

function validProvides(descriptor: Record<string, unknown>): boolean {
  if (descriptor.provides === undefined) return true;
  return Array.isArray(descriptor.provides) && descriptor.provides.every(item => {
    const provide = asOptionalRecord(item);
    return typeof provide?.id === 'string' && typeof provide.version === 'string';
  });
}

function diagnoseProvideVersions(descriptor: Record<string, unknown>, moduleId: string, source: string, diagnostics: Diagnostic[]): void {
  for (const item of (descriptor.provides as unknown[] | undefined) ?? []) {
    const provide = item as Record<string, string>;
    if (!isSupportedEurekaVersionExpression(provide.version, true)) diagnostics.push({
      code: 'unsupported_provider_version', material: true,
      message: `${moduleId} provides ${provide.id} with unsupported version syntax: ${provide.version}.`, source
    });
  }
}

function httpDiagnostic(code: string, error: unknown, source: string): Diagnostic {
  return { code, material: true, message: error instanceof Error ? error.message : String(error), source };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredCommit(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must resolve to a 40-character lowercase commit SHA`);
  return value;
}

function asRecord(value: unknown, label: string): Record<string, any> {
  const record = asOptionalRecord(value);
  if (!record) throw new Error(`${label} must be a JSON object`);
  return record;
}

function asOptionalRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

async function mapLimit<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]);
    }
  }));
  return output;
}

async function writeStable(filePath: string, value: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, stableStringify(value));
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortKeys(child)]));
}

function uniqueByJson<T>(values: T[]): T[] {
  return [...new Map(values.map(value => [JSON.stringify(value), value])).values()].sort(byJson);
}

function byJson(left: unknown, right: unknown): number { return JSON.stringify(left).localeCompare(JSON.stringify(right)); }
function digest(content: string): string { return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`; }
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '_'); }
function ensureTrailingSlash(url: URL): URL { return new URL(url.toString().replace(/\/?$/, '/')); }
function positiveInteger(value: number, label: string): number { if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); return value; }

if (require.main === module) {
  const program = new Command();
  program
    .requiredOption('--platform-commit <sha>', 'immutable 40-character Platform LSP commit')
    .requiredOption('--channel <channel>', 'official or development')
    .requiredOption('--output-dir <dir>', 'new directory for snapshots and generated artifacts')
    .option('--far-url <url>', 'trusted FAR base URL', DEFAULT_FAR_URL)
    .option('--registry-url <url>', 'trusted module registry base URL', DEFAULT_REGISTRY_URL)
    .option('--request-timeout-ms <ms>', 'per-request timeout', String(DEFAULT_TIMEOUT_MS))
    .option('--max-response-bytes <bytes>', 'maximum response size', String(DEFAULT_MAX_BYTES))
    .option('--concurrency <count>', 'maximum concurrent requests', String(DEFAULT_CONCURRENCY))
    .action(async raw => {
      await acquireS008Catalog({
        platformCommit: raw.platformCommit,
        channel: raw.channel,
        outputDir: raw.outputDir,
        farUrl: raw.farUrl,
        registryUrl: raw.registryUrl,
        requestTimeoutMs: Number(raw.requestTimeoutMs),
        maxResponseBytes: Number(raw.maxResponseBytes),
        concurrency: Number(raw.concurrency)
      });
    });
  program.parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
