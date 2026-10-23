import fs from 'fs';
import path from 'path';
import {
  ModuleKind,
  RemoteEvidenceRecord,
  RemoteLookups,
  S014ApplicationTier,
  S014ModuleName,
  S014PlatformApplication,
  S014PlatformSnapshot,
  S014TemplateCheck
} from '../types';
import {
  parseApplicationModuleReference,
  parseFarApplication,
  parsePlatformApplicationPins,
  PlatformParseDiagnostic
} from './platform-applications';
import { pomArtifactId } from './module-kind';
import { isWithinRepo, readBoundedFileBytes } from './repo-files';
import { isRecord } from './type-guards';

export const DEFAULT_PLATFORM_REF = 'snapshot';
const PLATFORM_TIERS: readonly S014ApplicationTier[] = ['required', 'optional', 'experimental'];
const TIER_RANK: Record<S014ApplicationTier, number> = { required: 0, optional: 1, experimental: 2 };
const MAX_LOCAL_FILE_BYTES = 1024 * 1024;
const BACKEND_DESCRIPTORS = [
  'descriptors/ModuleDescriptor-template.json',
  'descriptors/ModuleDescriptor.json',
  'ModuleDescriptor.json',
  'src/main/resources/descriptors/ModuleDescriptor.json',
  'service/src/main/okapi/ModuleDescriptor-template.json'
];

/** Module and application names used in remote lookups. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** A platform-lsp branch, tag or commit. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export function isValidRemoteName(value: string): boolean {
  return NAME_PATTERN.test(value);
}

export function isValidPlatformRef(value: string): boolean {
  return REF_PATTERN.test(value) && !value.includes('..') && !value.endsWith('/');
}

/**
 * The module's name as platform applications list it. Backend: the name part of the committed descriptor's
 * id, else the POM artifactId, else the repository name. UI: the package name, with @folio/x read as folio_x.
 */
export function resolveS014ModuleName(repoPath: string, kind: ModuleKind, repositoryName?: string): S014ModuleName {
  if (kind === 'ui-module') {
    const packageJson = readLocalJson(repoPath, 'package.json');
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name : undefined;
    const name = packageName?.replace(/^@([^/]+)\//, '$1_');
    if (name && isValidRemoteName(name)) return { name, source: 'package', path: 'package.json' };
    return { problem: packageName === undefined
      ? 'package.json is missing, unreadable or has no name, so the tool could not tell the module name.'
      : 'The name in package.json is not a FOLIO module name, so the tool could not tell the module name.' };
  }

  for (const descriptorPath of BACKEND_DESCRIPTORS) {
    const descriptor = readLocalJson(repoPath, descriptorPath);
    if (!descriptor) continue;
    const name = typeof descriptor.id === 'string' ? descriptorIdName(descriptor.id) : undefined;
    if (name) return { name, source: 'descriptor', path: descriptorPath };
    break;
  }
  const artifactId = projectArtifactId(readLocalText(repoPath, 'pom.xml'));
  if (artifactId && isValidRemoteName(artifactId)) return { name: artifactId, source: 'pom', path: 'pom.xml' };
  const repository = repositoryName ?? path.basename(repoPath);
  if (isValidRemoteName(repository)) return { name: repository, source: 'repository' };
  return { problem: 'Neither the module descriptor, pom.xml nor the repository name gives a FOLIO module name.' };
}

// The id is "<name>-<version>". The version is a whole dotted version or a build placeholder, so
// "mod-foo-2fa-1.0.0" names mod-foo-2fa and "mod-search-${version}" names mod-search; "@artifactId@-@version@"
// names nothing.
const DESCRIPTOR_ID = /^([a-z0-9][a-z0-9._-]{0,99}?)-(?:\d+\.\d+(?:\.\d+)?(?:[-+.][A-Za-z0-9.+-]{0,100})?|\$\{[^}]{1,100}\}|@[^@]{1,100}@)$/;

function descriptorIdName(id: string): string | undefined {
  const match = id.length <= 300 ? DESCRIPTOR_ID.exec(id) : null;
  return match && isValidRemoteName(match[1]) ? match[1] : undefined;
}

// The project's own artifactId, unless it is a ${...} placeholder. An unparsable POM names nothing.
function projectArtifactId(pom: string | undefined): string | undefined {
  const value = pom === undefined ? undefined : pomArtifactId(pom, []);
  return value && !value.includes('$') ? value : undefined;
}

function readLocalText(repoPath: string, relativePath: string): string | undefined {
  const absolute = path.join(repoPath, relativePath);
  try {
    if (!fs.lstatSync(absolute).isFile() || !isWithinRepo(repoPath, absolute)) return undefined;
    const bytes = readBoundedFileBytes(absolute, MAX_LOCAL_FILE_BYTES + 1);
    return bytes.length > MAX_LOCAL_FILE_BYTES ? undefined : bytes.toString('utf8');
  } catch {
    return undefined;
  }
}

function readLocalJson(repoPath: string, relativePath: string): Record<string, unknown> | undefined {
  const text = readLocalText(repoPath, relativePath);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the platform ref to a commit, reads platform-descriptor.json there, and reads each pinned
 * application of every tier from FAR. Anything that cannot be read is recorded as a problem, never as an
 * application without modules.
 */
export async function collectPlatformSnapshot(lookups: RemoteLookups, platformRef: string): Promise<S014PlatformSnapshot> {
  const remoteEvidence: RemoteEvidenceRecord[] = [];
  const snapshot: S014PlatformSnapshot = { platformRef, applications: [], remoteEvidence };
  const get = async (url: string) => {
    const result = await lookups.getJson(url);
    remoteEvidence.push(result.record);
    return result;
  };

  let commit = /^[0-9a-f]{40}$/.test(platformRef) ? platformRef : undefined;
  if (!commit) {
    const params = new URLSearchParams({ sha: platformRef, per_page: '1' });
    const result = await get(`https://api.github.com/repos/folio-org/platform-lsp/commits?${params}`);
    if (!result.ok) return { ...snapshot, problem: `The tool could not look up ${platformRef} in folio-org/platform-lsp: ${result.record.error}` };
    const sha = Array.isArray(result.json) ? (result.json[0] as { sha?: unknown } | undefined)?.sha : undefined;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      return { ...snapshot, problem: `GitHub did not return a commit for ${platformRef} in folio-org/platform-lsp.` };
    }
    commit = sha;
  }
  snapshot.platformCommit = commit;

  const platformResult = await get(`https://raw.githubusercontent.com/folio-org/platform-lsp/${commit}/platform-descriptor.json`);
  if (!platformResult.ok) return { ...snapshot, problem: `The platform descriptor could not be read: ${platformResult.record.error}` };
  const platform = platformResult.json;
  if (!platform || typeof platform !== 'object' || Array.isArray(platform)) {
    return { ...snapshot, problem: 'The platform descriptor is not a JSON object.' };
  }
  const record = platform as Record<string, unknown>;
  if (typeof record.version === 'string') snapshot.platformVersion = record.version;

  const diagnostics: PlatformParseDiagnostic[] = [];
  const pins = parsePlatformApplicationPins(record, PLATFORM_TIERS, diagnostics);
  if (!pins.length) {
    return { ...snapshot, problem: diagnostics.length
      ? 'The platform descriptor\'s application list is malformed.'
      : 'The platform descriptor lists no applications.' };
  }
  const applications = mergePins(pins);
  const containers = record.applications as Record<string, unknown>;
  for (const tier of PLATFORM_TIERS) {
    if (containers[tier] !== undefined && !Array.isArray(containers[tier])) {
      applications.push({ name: `The ${tier} application list`, problem: 'It is not a list, so its applications could not be checked.' });
    }
  }
  const unreadablePins = diagnostics.filter(diagnostic => diagnostic.code === 'invalid_application_pin').length;
  if (unreadablePins) {
    applications.push({
      name: `${unreadablePins} application ${unreadablePins === 1 ? 'entry' : 'entries'}`,
      problem: 'The platform descriptor gives no name and version, so the tool could not check them.'
    });
  }
  const read = await Promise.all(applications.map(application => application.problem || !application.version
    ? Promise.resolve({ application, record: undefined })
    : readFarApplication(application, lookups)));
  snapshot.applications = read.map(item => item.application);
  // Sources in platform order, not in the order the parallel requests finished.
  remoteEvidence.push(...read.flatMap(item => item.record ? [item.record] : []));
  return snapshot;
}

// A pin listed twice is one application; listed at two versions, it cannot be read reliably.
function mergePins(pins: Array<{ name: string; version: string; tier: S014ApplicationTier }>): S014PlatformApplication[] {
  const byName = new Map<string, S014PlatformApplication & { versions: Set<string> }>();
  for (const pin of pins) {
    const existing = byName.get(pin.name);
    if (!existing) {
      byName.set(pin.name, { name: pin.name, version: pin.version, tier: pin.tier, versions: new Set([pin.version]) });
      continue;
    }
    existing.versions.add(pin.version);
    if (TIER_RANK[pin.tier] < TIER_RANK[existing.tier!]) existing.tier = pin.tier;
  }
  return [...byName.values()].map(({ versions, ...application }) => versions.size > 1
    ? { ...application, version: undefined, problem: `The platform descriptor pins it at more than one version (${[...versions].join(', ')}).` }
    : application);
}

async function readFarApplication(
  application: S014PlatformApplication,
  lookups: RemoteLookups
): Promise<{ application: S014PlatformApplication; record: RemoteEvidenceRecord }> {
  const pin = { name: application.name, version: application.version! };
  const params = new URLSearchParams({ query: `id==${pin.name}-${pin.version}`, full: 'false', limit: '2' });
  const url = `https://far.ci.folio.org/applications?${params}`;
  const result = await lookups.getJson(url);
  const { record } = result;
  if (!result.ok) return { application: { ...application, problem: `FAR could not be read: ${record.error}` }, record };
  const diagnostics: PlatformParseDiagnostic[] = [];
  const descriptor = parseFarApplication(result.json, pin, url, diagnostics);
  if (!descriptor) {
    return { application: { ...application, problem: diagnostics[0]?.code === 'far_cardinality'
      ? 'FAR did not return exactly one descriptor for this version.'
      : 'FAR returned a descriptor for a different application or version.' }, record };
  }
  const modules: Array<{ name: string; version: string }> = [];
  let unreadable = 0;
  for (const field of ['modules', 'uiModules']) {
    const references = descriptor[field];
    if (references === undefined) continue;
    if (!Array.isArray(references)) {
      unreadable++;
      continue;
    }
    for (const reference of references) {
      const parsed = parseApplicationModuleReference(reference, `${pin.name}-${pin.version}`, diagnostics);
      if (parsed) modules.push({ name: parsed.identity, version: parsed.version });
      else unreadable++;
    }
  }
  return {
    application: unreadable
      ? { ...application, modules, problem: 'Its descriptor has module entries the tool could not read.' }
      : { ...application, modules },
    record
  };
}

/** Whether the named application's own repository template lists the module. */
export async function checkApplicationTemplate(lookups: RemoteLookups, application: string, moduleName: string): Promise<{ check: S014TemplateCheck; record?: RemoteEvidenceRecord }> {
  const url = `https://raw.githubusercontent.com/folio-org/${application}/HEAD/${application}.template.json`;
  if (!application.startsWith('app-') || !isValidRemoteName(application)) {
    return { check: { application, url, problem: 'Only folio-org app-* repositories are read.' } };
  }
  const result = await lookups.getJson(url);
  if (!result.ok) return { check: { application, url, problem: `The template could not be read: ${result.record.error}` }, record: result.record };
  const template = result.json as Record<string, unknown> | undefined;
  const lists = [template?.modules, template?.uiModules].filter(list => list !== undefined);
  if (!template || typeof template !== 'object' || !lists.length || !lists.every(Array.isArray)) {
    return { check: { application, url, problem: 'The template has no readable modules or uiModules list.' }, record: result.record };
  }
  const names = (lists as unknown[][]).flat().map(entry =>
    entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : undefined);
  if (names.includes(moduleName)) return { check: { application, url, listsModule: true }, record: result.record };
  // An entry without a name might be the module, so "does not list it" needs every entry readable.
  if (names.some(name => !name)) {
    return { check: { application, url, problem: 'The template has module entries without a name.' }, record: result.record };
  }
  return { check: { application, url, listsModule: false }, record: result.record };
}
