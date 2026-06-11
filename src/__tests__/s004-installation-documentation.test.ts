import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvaluationStatus } from '../types';
import { analyzeS004Documentation, classifyS004Documentation } from '../utils/s004-installation-documentation';

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
    expect(result.classification.reason).toContain('requires reviewer judgment');
    expect(result.classification.filesConsidered).toEqual(['README.md']);
    expect(result.classification.strongestSignals.map(signal => signal.group)).toContain('docker_runtime');
    expect(result.classification.strongestSignals.map(signal => signal.group)).toContain('okapi_tenant_enablement');
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
    expect(result.classification.strongestSignals.map(signal => signal.group)).toContain('stripes_setup');
  });

  it('returns manual for thin operational references', () => {
    writeFile('README.md', `
# mod-users

API documentation is linked from the module descriptor.
Configuration details are available in the FOLIO docs.
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.classification.reason).toContain('too thin');
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

  it('fails test-only documentation', () => {
    writeFile('README.md', `
# mod-tests-only

## Unit tests
mvn test
`);

    const result = analyzeS004Documentation(tempRoot);

    expect(result.classification.status).toBe(EvaluationStatus.FAIL);
    expect(result.classification.reason).toContain('No plausible developer build');
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
    expect(result.warnings.join('\n')).toContain('outside repository');
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
