#!/usr/bin/env node
// Maintainer tool: records the remote responses S014 reads so tests replay them without the network.
// Never run in CI. Usage: yarn capture:remote-fixtures [--platform-ref snapshot] [--template app-edge-locate ...]
import fs from 'fs-extra';
import path from 'path';
import { Command } from 'commander';
import { RemoteEvidenceTransport } from '../utils/remote-evidence';
import { checkApplicationTemplate, collectPlatformSnapshot, DEFAULT_PLATFORM_REF } from '../utils/s014-application-assignment';

export const REMOTE_FIXTURE_DIR = path.join(__dirname, '..', '__tests__', 'fixtures', 'remote');

export interface RemoteFixture {
  capturedAt: string;
  description: string;
  responses: Record<string, { status: number; body: unknown }>;
}

async function capture(platformRef: string, templates: string[], output: string): Promise<void> {
  const responses: RemoteFixture['responses'] = {};
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const text = await response.clone().text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* recorded as text */ }
    responses[String(input)] = { status: response.status, body };
    return response;
  };
  const transport = new RemoteEvidenceTransport({ fetchImpl: recordingFetch });
  const snapshot = await collectPlatformSnapshot(transport, platformRef);
  if (snapshot.problem || snapshot.applications.some(application => application.problem)) {
    throw new Error(`The platform could not be read completely: ${snapshot.problem ?? snapshot.applications.find(item => item.problem)!.problem}`);
  }
  for (const template of templates) await checkApplicationTemplate(transport, template, '');
  const fixture: RemoteFixture = {
    capturedAt: new Date().toISOString(),
    description: `folio-org/platform-lsp ${platformRef} at ${snapshot.platformCommit} (${snapshot.platformVersion}), its applications from FAR${templates.length ? `, and the templates of ${templates.join(', ')}` : ''}`,
    responses: Object.fromEntries(Object.entries(responses).sort(([left], [right]) => left.localeCompare(right)))
  };
  await fs.outputFile(output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(responses).length} responses to ${output}`);
}

if (require.main === module) {
  const program = new Command();
  program
    .option('--platform-ref <ref>', 'folio-org/platform-lsp branch, tag or commit', DEFAULT_PLATFORM_REF)
    .option('--template <application...>', 'application repositories whose template to record', [])
    .option('--output <file>', 'fixture file', path.join(REMOTE_FIXTURE_DIR, 'platform-lsp-snapshot.json'))
    .action(async options => capture(options.platformRef, options.template, options.output));
  program.parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
