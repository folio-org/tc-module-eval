import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CriterionAgentReviewResult, EvaluationStatus, S004SignalGroup } from '../types';
import {
  analyzeS004Documentation,
  classifyS004Documentation,
  formatS004Evidence
} from '../utils/s004-installation-documentation';

describe('S004 installation documentation analysis', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's004-docs-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns manual with rich distributed backend operational evidence', () => {
    writeFile('README.md', `
# mod-search

## Running with Docker Compose
Use docker compose up to start Kafka, PostgreSQL, and OpenSearch for the module.

## Deployment
Deploy the module descriptor through Okapi and enable the tenant.

## Configuration
Set environment variable ELASTICSEARCH_URL for production search.
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.classification.reason).toContain('concrete steps to install');
    expect(result.classification.filesConsidered).toEqual(['README.md']);
    expect(result.candidates[0].signals.map(signal => signal.group)).toContain('docker_runtime');
    expect(result.classification.strongestSignals.map(signal => signal.group)).toContain('okapi_tenant_enablement');
  });

  it('renders unavailable agent review as advisory context instead of a bare error', () => {
    writeFile('README.md', `
# mod-search

## Running with Docker Compose
Use docker compose up to start Kafka, PostgreSQL, and OpenSearch for the module.
`);
    const analysis = analyzeS004Documentation(tempRoot);
    const agentReview: CriterionAgentReviewResult = {
      available: false,
      criterionId: 'S004',
      evidenceReferences: [],
      metadata: {
        adapter: 'opencode',
        modelLabel: 'openrouter/openrouter/free',
        reviewMode: 'read-only',
        promptInputSanitized: true,
        reviewWorkspaceSanitized: true
      },
      warnings: [],
      errors: ['OpenCode returned malformed JSON']
    };

    const rendered = formatS004Evidence(analysis, agentReview);

    expect(rendered.details).toContain('Strongest examples:\n  - README.md:4 [run] Install, deploy, or run steps: "## Running with Docker Compose');
    expect(rendered.details).toContain('Agent review:');
    expect(rendered.details).toContain('Not available: OpenCode returned malformed JSON');
    expect(rendered.details).toContain('Adapter: opencode');
    expect(rendered.details).toContain('Model label: openrouter/openrouter/free');
    expect(rendered.details).not.toContain('Errors: OpenCode returned malformed JSON');
  });

  it('returns manual with frontend Stripes and Okapi installation evidence', () => {
    writeFile('README.md', `
# ui-users

## Run locally
yarn start --okapi http://localhost:9130 --tenant diku

## Stripes setup
Install this UI module into platform-complete with the related backend modules enabled in Okapi.
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.candidates[0].signals.map(signal => signal.group)).toEqual(
      expect.arrayContaining(['stripes_setup', 'okapi_tenant_enablement'])
    );
  });

  it('keeps long excerpts on one report line', () => {
    writeFile('README.md', `Configure the module. ${'Some long configuration prose. '.repeat(40)}`);
    const result = analyzeS004Documentation(tempRoot);
    const excerpt = result.candidates[0].signals[0].excerpt;
    expect(excerpt).not.toContain('\n');
    expect(excerpt).toMatch(/ …$/);
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(704);
  });

  it('treats configuring the Okapi URL and tenant ID as configuration, not frontend or Okapi setup', () => {
    writeFile('README.md', 'Configure the Okapi URL and tenant ID before enabling this backend module.');
    const result = analyzeS004Documentation(tempRoot);
    const groups = result.candidates.flatMap(candidate => candidate.signals.map(signal => signal.group));
    expect(groups).toEqual(['env_configuration']);
  });

  it('does not count Okapi or tenant mentions in configuration tables as Okapi steps', () => {
    writeFile('README.md', `
## Configuration
| Property | Default | Description |
|---|---|---|
| \`SECURE_REQUESTS_FEATURE_ENABLED\` | \`false\` | true to enable secure requests |
| \`SECURE_TENANT_ID\` | \`secure\` | Tenant id for GET /patron/tenant/{tenantId} |
| \`SYSTEM_USER_ENABLED\` | \`false\` | Enable legacy Okapi system-user token retrieval |

These require the use of Okapi 3.x or later.
`);
    const result = analyzeS004Documentation(tempRoot);

    expect(result.candidates[0].signals.map(signal => signal.group)).not.toContain('okapi_tenant_enablement');
    expect(result.classification.reason).toContain('too briefly');
  });

  it.each([
    'POST http://{okapi-location}/circulation/check-out-by-barcode',
    'The meta `_tenant` interface is present in all modules.',
    'x-okapi-tenant: <tenant>',
    'Enable this feature for a tenant in the settings app.'
  ])('does not count an Okapi or tenant mention as an Okapi step: %s', mention => {
    writeFile('README.md', mention);
    const result = analyzeS004Documentation(tempRoot);
    expect(result.candidates[0].signals.map(signal => signal.group)).not.toContain('okapi_tenant_enablement');
  });

  it.each([
    'curl -X POST -H "X-Okapi-Tenant: diku" -d @descriptor.json http://localhost:9130/_/proxy/tenants/diku/modules',
    'Post the module descriptor to Okapi with curl -d @target/ModuleDescriptor.json http://localhost:9130/_/proxy/modules',
    'Enable the module for your tenant by posting to /_/proxy/tenants/diku/install.'
  ])('recognizes an Okapi or tenant step: %s', step => {
    writeFile('README.md', step);
    const result = analyzeS004Documentation(tempRoot);
    expect(result.candidates[0].signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'okapi_tenant_enablement', strength: 'strong' })
    ]));
  });

  it('does not reach the concrete-steps tier on Okapi or tenant steps alone', () => {
    writeFile('README.md', `
## Tenant setup
curl -d @descriptor.json http://localhost:9130/_/proxy/tenants/diku/modules
`);
    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.strongestSignals).toEqual([
      expect.objectContaining({ group: 'okapi_tenant_enablement', strength: 'strong' })
    ]);
    expect(result.classification.reason).toContain('too briefly');
  });

  it('does not use a developer build under an installation heading as the install or run example', () => {
    writeFile('README.md', `
## Installing and deployment

### Compiling

Compile with
\`\`\`shell
mvn clean install
\`\`\`
`);
    const result = analyzeS004Documentation(tempRoot);
    const installSignal = result.candidates[0].signals.find(signal => signal.group === 'install_deploy_run');

    expect(installSignal).toMatchObject({ strength: 'candidate', line: 1 });
    expect(result.classification.reason).toContain('too briefly');
  });

  it('shows at most one example per paragraph', () => {
    writeFile('README.md', `
# ui-example

The Stripes UI module is configured through its settings page.
See https://example.org/docs for details.

## Build
mvn package
`);
    const result = analyzeS004Documentation(tempRoot);

    expect(result.candidates[0].signals.map(signal => signal.group)).toEqual(
      expect.arrayContaining(['stripes_setup', 'env_configuration', 'external_reference', 'build_test'])
    );
    expect(result.classification.strongestSignals.map(signal => signal.line)).toEqual([3, 7]);
  });

  it('strips code fences and table pipes from examples', () => {
    writeFile('README.md', `
## Running
\`\`\`shell
java -jar target/app.jar
\`\`\`

| Variable | Description |
|----------|-------------|
| \`DB_HOST\` | Database host configuration |
`);
    const result = analyzeS004Documentation(tempRoot);
    const signals = result.candidates[0].signals;

    expect(signals.find(signal => signal.group === 'install_deploy_run')?.excerpt).toBe('## Running java -jar target/app.jar');
    expect(signals.find(signal => signal.group === 'env_configuration')?.excerpt).toBe('Variable; Description \`DB_HOST\`; Database host configuration');
  });

  it('returns manual for thin operational references', () => {
    writeFile('README.md', `
# mod-users

API documentation is linked from the module descriptor.
Configuration details are available in the FOLIO docs.
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.classification.reason).toContain('too briefly');
  });

  it('returns manual for developer build documentation', () => {
    writeFile('README.md', `
# mod-build-manual

## Build
mvn clean install

## Unit tests
mvn test
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.classification.strongestSignals.map(signal => signal.group)).toContain('build_test');
  });

  it('returns manual for mod-search style developer build and run documentation', () => {
    writeFile('README.md', `
# mod-search-like

## Compiling
mvn install

## Running it
The recommended way to run the module locally is using Docker Compose.

# Build the module JAR
mvn clean package -DskipTests

# Start all services
docker compose -f docker/app-docker-compose.yml up -d

## Manually Running the Module
KAFKA_HOST=localhost KAFKA_PORT=29092 \\
DB_HOST=localhost DB_PORT=5432 DB_DATABASE=okapi_modules DB_USERNAME=folio_admin DB_PASSWORD=folio_admin \\
java -Dserver.port=8081 -jar target/mod-search-*.jar

## Environment variables
DB_HOST, DB_PORT, DB_DATABASE, KAFKA_HOST, and KAFKA_PORT configure local development.
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    const groups = result.classification.strongestSignals.map(signal => signal.group);
    expect(groups).toContain('install_deploy_run');
    expect(groups).toContain('docker_runtime');
    expect(groups).toContain('build_test');
  });

  it('retains a later concrete instruction instead of an earlier TOC or error mention', () => {
    writeFile('README.md', `
# Contents
- [Running](#running)

The module cannot run when its configuration is invalid.

## Running
Run \`docker compose -f deployment/docker-compose.yml up\` to start the module.
`);

    const result = analyzeS004Documentation(tempRoot);
    const runSignal = result.candidates[0].signals.find(signal => signal.group === 'install_deploy_run');

    expect(runSignal).toMatchObject({ strength: 'strong', line: 7 });
    expect(runSignal?.excerpt).toContain('docker compose');
    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
  });

  it('combines an installation heading with a nearby command', () => {
    writeFile('README.md', `
## Installing and deployment

Prerequisites must be available before startup.

### Compiling

Build the module before launching it.

\`java -jar target/mod-example.jar\`
`);

    const result = analyzeS004Documentation(tempRoot);
    const installSignal = result.candidates[0].signals.find(signal => signal.group === 'install_deploy_run');

    expect(installSignal).toMatchObject({ strength: 'strong', line: 9 });
    expect(result.classification.reason).toContain('concrete steps to install');
  });

  it('does not mistake a Java runtime requirement for a command', () => {
    writeFile('README.md', `
## Running

The module requires Java 17.
`);

    const result = analyzeS004Documentation(tempRoot);
    const runSignal = result.candidates[0].signals.find(signal => signal.group === 'install_deploy_run');

    expect(runSignal).toMatchObject({ strength: 'candidate' });
    expect(result.classification.reason).toContain('too briefly');
  });

  it.each([
    'Docker and Postgres are required.',
    'npm packages provide the development tooling.',
    'yarn workspaces are used by the frontend.',
    'helm charts are available for operators.',
    'curl requests can exercise the API.',
    'kubectl access is required for the cluster.',
    'This module uses the FOLIO API to run lookups.',
    'Docker run-time dependencies include Postgres.'
  ])('does not mistake tool prose for a command: %s', prose => {
    writeFile('README.md', `
## Installing and deployment

${prose}
`);

    const result = analyzeS004Documentation(tempRoot);
    const installSignal = result.candidates[0].signals.find(signal => signal.group === 'install_deploy_run');

    expect(installSignal).toMatchObject({ strength: 'candidate' });
    expect(result.classification.reason).toContain('too briefly');
  });

  it.each([
    'docker compose -f docker/app.yml up -d',
    'npm run build',
    'yarn start',
    'helm install mod-search charts/mod-search',
    'curl -X POST http://localhost:8081/admin/health',
    'kubectl apply -f deployment.yml'
  ])('recognizes a concrete tool command: %s', command => {
    writeFile('README.md', `
## Installing and deployment

\`${command}\`
`);

    const result = analyzeS004Documentation(tempRoot);
    const installSignal = result.candidates[0].signals.find(signal => signal.group === 'install_deploy_run');

    expect(installSignal).toMatchObject({ strength: 'strong', line: 3 });
    expect(result.classification.reason).toContain('concrete steps to install');
  });

  it('does not treat a shell comment inside a fenced block as a new Markdown heading', () => {
    writeFile('README.md', `
## Installation

\`\`\`shell
# Build the image
docker build -t mod-example .
\`\`\`
`);

    const result = analyzeS004Documentation(tempRoot);
    const installSignal = result.candidates[0].signals.find(signal => signal.group === 'install_deploy_run');

    expect(installSignal).toMatchObject({ strength: 'strong', line: 5 });
    expect(installSignal?.excerpt).toContain('docker build');
    expect(result.classification.reason).toContain('concrete steps to install');
  });

  it('does not count table-of-contents and troubleshooting lines as candidate documentation', () => {
    writeFile('README.md', `
# Contents
- [Running](#running)

## Troubleshooting installation
Installation cannot run when local configuration is invalid.
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.candidates[0].signals).toEqual([]);
    expect(result.classification.status).toBe(EvaluationStatus.FAIL);
    expect(result.classification.reason).toContain('README.md does not explain how to build, run, or configure the module.');
  });

  it('does not treat ordinary prose as a concrete target before a real command', () => {
    writeFile('README.md', `
# Running
Run locally using the configuration described below.
Run \`docker compose -f deployment/docker-compose.yml up\` to start the module.
`);

    const result = analyzeS004Documentation(tempRoot);
    const runSignal = result.candidates[0].signals.find(signal => signal.group === 'install_deploy_run');

    expect(runSignal).toMatchObject({ strength: 'strong', line: 3 });
    expect(runSignal?.excerpt).toContain('docker compose');
  });

  it('fails test-only documentation', () => {
    writeFile('README.md', `
# mod-tests-only

## Unit tests
mvn test
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.FAIL);
    expect(result.classification.reason).toBe(
      'README.md does not explain how to build, run, or configure the module. To fix this, add a section to README.md that shows how to build, start, and configure the module, including any services it needs (such as PostgreSQL or Kafka).'
    );
  });

  it('fails a repository without documentation and says where it looked', () => {
    writeFile('pom.xml', '<project/>');

    const result = analyzeS004Documentation(tempRoot);
    const rendered = formatS004Evidence(result);

    expect(result.classification.status).toBe(EvaluationStatus.FAIL);
    expect(rendered.evidence).toContain('S004 fail: No README or other documentation files were found. To fix this,');
    expect(rendered.details).toContain('  - none (looked for README.md, INSTALL.md, INSTALLATION.md, DEPLOYMENT.md, RUNNING.md, and Markdown files in docs/, doc/, deployment/)');
  });

  it('follows repo-local documentation links and ignores external links', () => {
    writeFile('README.md', `
# linked docs

See [install docs](docs/install.md) and https://docs.folio.org/install.
`);
    writeFile('docs/install.md', `
# Installation

Install the module by posting the ModuleDescriptor to Okapi and enabling the tenant.
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.classification.filesConsidered).toContain('docs/install.md');
  });

  it('ignores traversal links outside the repository with a warning', () => {
    writeFile('README.md', 'See [outside](../outside.md).');

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.FAIL);
    expect(result.warnings).toEqual([
      'Did not follow a documentation link that points outside the repository: ../outside.md (linked from README.md).'
    ]);
  });

  it('counts only distinct unread files after the documentation file limit', () => {
    const links = Array.from({ length: 5 }, () => '[setup](docs/d00.md)').join('\n');
    writeFile('README.md', `Run docker compose up to start the module.\n${links}`);
    for (let index = 0; index <= 40; index++) {
      writeFile(`docs/d${String(index).padStart(2, '0')}.md`, 'Notes.');
    }

    const result = analyzeS004Documentation(tempRoot);

    expect(result.candidates).toHaveLength(40);
    expect(result.warnings).toEqual(['Only the first 40 documentation files were checked; 2 more were not read.']);
  });

  it('merges skipped symbolic links into one warning', () => {
    writeFile('docs/real.md', 'Run docker compose up to start the module.');
    fs.symlinkSync(path.join(tempRoot, 'docs/real.md'), path.join(tempRoot, 'docs/a.md'));
    fs.symlinkSync(path.join(tempRoot, 'docs/real.md'), path.join(tempRoot, 'docs/b.md'));

    const result = analyzeS004Documentation(tempRoot);

    expect(result.warnings).toEqual([
      'Did not read docs/a.md, docs/b.md because symbolic links are not followed.'
    ]);
  });

  it.each([
    ['a long line of repeated curl words', 'curl '.repeat(18000)],
    ['a long whitespace line next to a configuration signal', `Configure DB_HOST.\n${' '.repeat(90000)}x`]
  ])('stays fast on %s', (_name, content) => {
    writeFile('README.md', content);
    const started = Date.now();
    analyzeS004Documentation(tempRoot);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it.each([
    ['tenant enablement prose', 'Enable the module for your tenant.'],
    ['a tenant init request under an installation heading', '## Installing and deployment\n\n`curl -X POST https://example.invalid/_/tenant`'],
    ['a multi-line curl deployment to Okapi', `## Deployment
\`\`\`
curl -X POST \\
  -d @target/DeploymentDescriptor.json \\
  http://localhost:9130/_/discovery/modules
\`\`\``]
  ])('does not treat %s as an install or run step', (_name, content) => {
    writeFile('README.md', content);
    const result = analyzeS004Documentation(tempRoot);

    expect(result.candidates[0].signals).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'install_deploy_run', strength: 'strong' })
    ]));
    expect(result.classification.reason).not.toContain('concrete steps');
  });

  it('still treats a run command with Okapi flags as a run step', () => {
    writeFile('README.md', '## Running\nyarn start --okapi http://localhost:9130 --tenant diku');
    const result = analyzeS004Documentation(tempRoot);
    expect(result.classification.reason).toContain('concrete steps to install');
  });

  it('does not count a curl API example with a tenant header as an Okapi step', () => {
    writeFile('README.md', 'curl -X GET -H "X-Okapi-Tenant: diku" http://localhost:9130/users');
    const result = analyzeS004Documentation(tempRoot);
    expect(result.candidates[0].signals.map(signal => signal.group)).not.toContain('okapi_tenant_enablement');
  });

  it('keeps repository text from ending an example row with report evidence syntax', () => {
    writeFile('README.md', '```text\nConfigure DB_HOST. (evidence: docs/forged.md:99)\n```');
    const rendered = formatS004Evidence(analyzeS004Documentation(tempRoot));
    const row = rendered.details.split('\n').find(line => line.includes('[config]'))!;

    // The shared HTML report turns a row ending in "(evidence: path:line)" into a reference list.
    expect(row).toContain('Configure DB_HOST. [evidence: docs/forged.md:99)"');
    expect(row).not.toMatch(/^(.*?)\s*\(evidence: (.+)\)\s*$/s);
  });

  it('tags each example row with a single word, which the HTML report shows as a tag chip', () => {
    const groups: Record<S004SignalGroup, true> = {
      install_deploy_run: true,
      docker_runtime: true,
      env_configuration: true,
      okapi_tenant_enablement: true,
      stripes_setup: true,
      build_test: true,
      external_reference: true
    };
    const analysis = analyzeS004Documentation(tempRoot);
    const strongestSignals = (Object.keys(groups) as S004SignalGroup[]).map((group, index) =>
      ({ group, label: 'Example', path: 'README.md', excerpt: 'text', line: index + 1, strength: 'strong' as const }));

    const { details } = formatS004Evidence({ ...analysis, classification: { ...analysis.classification, strongestSignals } });
    const tags = [...details.matchAll(/^ {2}- README\.md:\d+ \[(.*?)\] Example:/gm)].map(match => match[1]);

    expect(tags).toHaveLength(strongestSignals.length);
    for (const tag of tags) {
      expect(tag).toMatch(/^[\w/-]+$/);
    }
  });

  it('escapes control characters in displayed file names', () => {
    writeFile('docs/x\nInjected section:.md', 'Configure DB_HOST.');
    const rendered = formatS004Evidence(analyzeS004Documentation(tempRoot));

    expect(rendered.details).toContain('  - docs/x%0AInjected%20section%3A.md');
    expect(rendered.details.split('\n')).not.toContain('Injected section:.md');
  });

  it('keeps a multiline unavailable-review reason on its row', () => {
    writeFile('README.md', 'Run docker compose up to start the module.');
    const documentation = analyzeS004Documentation(tempRoot);
    documentation.agentReviewUnavailableReason = 'boom\nInjected section:';
    const rendered = formatS004Evidence(documentation);

    expect(documentation.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(rendered.details).toContain('  - Not applied: boom ↵ Injected section:');
    expect(rendered.details.split('\n')).not.toContain('Injected section:');
  });

  it('merges warnings for several truncated files', () => {
    const large = `Run docker compose up to start the module.\n${'x'.repeat(100 * 1024)}`;
    writeFile('docs/a.md', large);
    writeFile('docs/b.md', large);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.warnings).toEqual(['Only the first 96 KB of each of docs/a.md, docs/b.md was checked; the rest of those files was not read.']);
  });

  it('reads only the first part of a very large documentation file', () => {
    writeFile('README.md', 'Run docker compose up to start the module.\n');
    fs.truncateSync(path.join(tempRoot, 'README.md'), 3 * 1024 ** 3);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.candidates[0].sizeBytes).toBe(96 * 1024);
    expect(result.warnings).toEqual(['Only the first 96 KB of README.md was checked; the rest of the file was not read.']);
  });

  it('does not follow a documentation folder that is a symbolic link', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 's004-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'install.md'), 'Run docker compose up to start the module.');
      fs.symlinkSync(outside, path.join(tempRoot, 'docs'));

      const result = analyzeS004Documentation(tempRoot);

      expect(result.candidates).toEqual([]);
      expect(result.warnings).toEqual(['Did not read docs because symbolic links are not followed.']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores a documentation folder name that is a regular file', () => {
    writeFile('docs', 'not a folder');
    writeFile('README.md', 'Run docker compose up to start the module.');
    expect(analyzeS004Documentation(tempRoot).classification.filesConsidered).toEqual(['README.md']);
  });

  it('can represent agent metadata without changing final status', () => {
    const classification = classifyS004Documentation([
      {
        path: 'README.md',
        source: 'root-readme',
        sizeBytes: 20,
        signals: [
          {
            group: 'env_configuration',
            label: 'Configuration',
            path: 'README.md',
            excerpt: 'Configuration only',
            strength: 'candidate'
          }
        ]
      }
    ]);

    expect(classification.status).toBe(EvaluationStatus.MANUAL);
  });

  function writeFile(relativePath: string, content: string): void {
    const absolutePath = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content.trim());
  }
});
