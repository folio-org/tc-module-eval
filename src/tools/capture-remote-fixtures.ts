#!/usr/bin/env node
// Maintainer tool: records the remote responses S014 and S011 read so tests replay them without the network.
// Never run in CI. Usage:
//   yarn capture:remote-fixtures [--platform-ref snapshot] [--template app-edge-locate ...]
//   yarn capture:remote-fixtures --sonar /path/to/mod-users /path/to/mod-agreements ... [--no-trim]
//   yarn capture:remote-fixtures --retrim src/__tests__/fixtures/remote/sonarcloud-mod-users.json ...
// --sonar takes local checkouts: S011 runs on each at its HEAD, so the rule-name lookup for its suppressions is
// recorded too; each becomes sonarcloud-<repository>.json, its bodies trimmed to the fields the evaluator reads
// (see sonarcloud-fixture-trim.ts) unless --no-trim is given. --retrim trims recorded fixtures again in place.
import fs from 'fs-extra';
import path from 'path';
import { Command } from 'commander';
import { execFileSync } from 'child_process';
import { RemoteEvidenceTransport } from '../utils/remote-evidence';
import { createEvaluationRun } from '../utils/evaluation-run';
import { analyzeS011 } from '../utils/s011-evaluator';
import { trimSonarCloudResponses } from './sonarcloud-fixture-trim';
import { checkApplicationTemplate, collectPlatformSnapshot, DEFAULT_PLATFORM_REF } from '../utils/s014-application-assignment';
import { errorMessage } from '../utils/type-guards';

export const REMOTE_FIXTURE_DIR = path.join(__dirname, '..', '__tests__', 'fixtures', 'remote');

export interface RemoteFixture {
  capturedAt: string;
  description: string;
  responses: Record<string, { status: number; body: unknown }>;
}

function recordingTransport(): { transport: RemoteEvidenceTransport; responses: RemoteFixture['responses'] } {
  const responses: RemoteFixture['responses'] = {};
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const text = await response.clone().text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* recorded as text */ }
    responses[String(input)] = { status: response.status, body };
    return response;
  };
  return { transport: new RemoteEvidenceTransport({ fetchImpl: recordingFetch }), responses };
}

async function writeFixture(output: string, description: string, responses: RemoteFixture['responses'], capturedAt = new Date().toISOString()): Promise<void> {
  const fixture: RemoteFixture = {
    capturedAt,
    description,
    responses: Object.fromEntries(Object.entries(responses).sort(([left], [right]) => left.localeCompare(right)))
  };
  await fs.outputFile(output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(responses).length} responses to ${output}`);
}

async function retrim(files: string[]): Promise<void> {
  for (const file of files) {
    const fixture: RemoteFixture = await fs.readJson(file);
    const trimmed = trimSonarCloudResponses(fixture.responses);
    const note = ', trimmed to the fields the evaluator reads';
    const changed = JSON.stringify(trimmed) !== JSON.stringify(fixture.responses);
    const description = !changed || fixture.description.endsWith(note) ? fixture.description : `${fixture.description}${note}`;
    await writeFixture(file, description, trimmed, fixture.capturedAt);
  }
}

async function captureSonar(checkouts: string[], directory: string, trim: boolean): Promise<void> {
  for (const checkout of checkouts) {
    const repositoryName = path.basename(path.resolve(checkout));
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
    const { transport, responses } = recordingTransport();
    const run = createEvaluationRun({
      repositoryPath: checkout, repositoryName, language: 'java', criteriaFilter: ['S011'], repositoryCommit: commit, remoteLookups: transport
    });
    const analysis = await analyzeS011(checkout, run);
    console.log(`${repositoryName}: ${analysis.summary}`);
    await writeFixture(path.join(directory, `sonarcloud-${repositoryName}.json`),
      `SonarCloud org.folio:${repositoryName} as S011 reads it, evaluated at ${repositoryName} commit ${commit}${trim ? ', trimmed to the fields the evaluator reads' : ''}`,
      trim ? trimSonarCloudResponses(responses) : responses);
  }
}

async function capture(platformRef: string, templates: string[], output: string): Promise<void> {
  const { transport, responses } = recordingTransport();
  const snapshot = await collectPlatformSnapshot(transport, platformRef);
  if (snapshot.problem || snapshot.applications.some(application => application.problem)) {
    throw new Error(`The platform could not be read completely: ${snapshot.problem ?? snapshot.applications.find(item => item.problem)!.problem}`);
  }
  for (const template of templates) await checkApplicationTemplate(transport, template, '');
  await writeFixture(output,
    `folio-org/platform-lsp ${platformRef} at ${snapshot.platformCommit} (${snapshot.platformVersion}), its applications from FAR${templates.length ? `, and the templates of ${templates.join(', ')}` : ''}`,
    responses);
}

if (require.main === module) {
  const program = new Command();
  program
    .option('--platform-ref <ref>', 'folio-org/platform-lsp branch, tag or commit', DEFAULT_PLATFORM_REF)
    .option('--template <application...>', 'application repositories whose template to record', [])
    .option('--output <file>', 'fixture file', path.join(REMOTE_FIXTURE_DIR, 'platform-lsp-snapshot.json'))
    .option('--sonar <checkout...>', 'record SonarCloud for these local module checkouts instead of the platform')
    .option('--no-trim', 'with --sonar, keep whole response bodies')
    .option('--retrim <fixture...>', 'trim recorded SonarCloud fixtures again, in place')
    .action(async options => options.retrim ? retrim(options.retrim)
      : options.sonar ? captureSonar(options.sonar, REMOTE_FIXTURE_DIR, options.trim)
        : capture(options.platformRef, options.template, options.output));
  program.parseAsync().catch(error => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
