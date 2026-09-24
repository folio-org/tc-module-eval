#!/usr/bin/env node
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { S008Catalog, S008CatalogChannel, S008Provider } from '../types';

interface ImportManifest {
  channel: S008CatalogChannel;
  platform: {
    repository: string;
    commit: string;
    tag?: string;
    descriptorVersion: string;
    descriptorPath: string;
  };
  applications: Array<{ name: string; version: string; optional: boolean; farSource: string; descriptorPath: string }>;
  eurekaComponents: Array<{ familyId: string; moduleIdentities: string[] }>;
  providers: Array<{ moduleIdentity: string; source: string; descriptorPath: string }>;
}

export async function importS008Catalog(manifestPath: string): Promise<S008Catalog> {
  const manifest = await fs.readJson(manifestPath) as ImportManifest;
  if (!['official', 'development'].includes(manifest.channel)) throw new Error('channel must be official or development');
  if (!/^[0-9a-f]{40}$/.test(manifest.platform.commit) || /^0+$/.test(manifest.platform.commit)) {
    throw new Error('platform.commit must be an explicit immutable 40-character commit SHA');
  }
  const base = path.dirname(path.resolve(manifestPath));
  const read = async (relativePath: string): Promise<{ content: string; parsed: any; hash: string }> => {
    const absolutePath = path.resolve(base, relativePath);
    const content = await fs.readFile(absolutePath, 'utf8');
    return { content, parsed: JSON.parse(content), hash: hash(content) };
  };
  const platformDescriptor = await read(manifest.platform.descriptorPath);
  const applications = await Promise.all(manifest.applications.map(async app => ({
    name: app.name,
    version: app.version,
    optional: app.optional,
    farSource: app.farSource,
    descriptorHash: (await read(app.descriptorPath)).hash
  })));
  const providers: S008Provider[] = await Promise.all(manifest.providers.map(async provider => {
    const descriptor = await read(provider.descriptorPath);
    if (typeof descriptor.parsed.id !== 'string' || (descriptor.parsed.provides !== undefined && !Array.isArray(descriptor.parsed.provides))) {
      throw new Error(`${provider.descriptorPath} must contain a string id and, when present, an array of provides`);
    }
    const provides = (descriptor.parsed.provides ?? []).map((item: any) => {
      if (!item || typeof item.id !== 'string' || typeof item.version !== 'string') {
        throw new Error(`${provider.descriptorPath} contains a provide without string id/version`);
      }
      return { id: item.id, version: item.version, ...(typeof item.interfaceType === 'string' ? { interfaceType: item.interfaceType } : {}) };
    }).sort((a: any, b: any) => `${a.id}\0${a.version}\0${a.interfaceType ?? ''}`.localeCompare(`${b.id}\0${b.version}\0${b.interfaceType ?? ''}`));
    return { moduleId: descriptor.parsed.id, moduleIdentity: provider.moduleIdentity, source: provider.source, descriptorHash: descriptor.hash, provides };
  }));

  return {
    schemaVersion: '1.0', authoritative: false, channel: manifest.channel,
    baseline: {
      platformRepository: manifest.platform.repository,
      platformCommit: manifest.platform.commit,
      ...(manifest.platform.tag ? { platformTag: manifest.platform.tag } : {}),
      descriptorVersion: manifest.platform.descriptorVersion,
      descriptorHash: platformDescriptor.hash
    },
    applications: applications.sort((a, b) => `${a.optional}\0${a.name}\0${a.version}`.localeCompare(`${b.optional}\0${b.name}\0${b.version}`)),
    eurekaComponents: manifest.eurekaComponents.map(item => ({ familyId: item.familyId, moduleIdentities: [...item.moduleIdentities].sort() })).sort((a, b) => a.familyId.localeCompare(b.familyId)),
    providers: providers.sort((a, b) => `${a.moduleIdentity}\0${a.moduleId}`.localeCompare(`${b.moduleIdentity}\0${b.moduleId}`))
  };
}

function hash(content: string): string { return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`; }

if (require.main === module) {
  const [manifestPath, outputPath] = process.argv.slice(2);
  if (!manifestPath || !outputPath) throw new Error('Usage: import-s008-catalog <snapshot-manifest.json> <catalog-output.json>');
  importS008Catalog(manifestPath).then(catalog => fs.writeJson(outputPath, catalog, { spaces: 2 })).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
