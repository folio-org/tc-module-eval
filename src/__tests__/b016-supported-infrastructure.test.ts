import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B016Analysis, EvaluationStatus } from '../types';
import { evaluateB016 } from '../utils/b016-supported-infrastructure';
import { createEvaluationRun } from '../utils/evaluation-run';
import { loadS007Policy } from '../utils/s007-policy';
import { dependency, pom, repository, restVerticleBuild } from './helpers/backend-repository';

async function b016(files: Record<string, string>) {
  const root = repository(files);
  const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
  const result = await new BackendEvaluator().evaluateCriterion('B016', root, run);
  return { result, analysis: result.criterionDetails as B016Analysis };
}

const dependencies = (...items: string[]) => `<dependencies>${items.join('')}</dependencies>`;
const template = JSON.stringify({ id: 'mod-example-1.0.0', provides: [] });
const CHECKED = 'Checked: direct production dependencies in 1 build file (pom.xml), storage evidence, configuration keys and environment variables. '
  + 'Transitive dependencies are not visible without running the build, and server versions are not checked.';
const POLICY = 'Officially Supported Technologies: exported 2026-07-14, sections infrastructure and fast-moving-infrastructure';

describe('B016 supported infrastructure', () => {
  it('passes when every infrastructure is on the list, noting advisory entries and aliases', async () => {
    const { result, analysis } = await b016({
      'pom.xml': pom('mod-example', `${restVerticleBuild}${dependencies(
        dependency('folio-kafka-wrapper'), dependency('folio-s3-client'), dependency('keycloak-admin-client', 'org.keycloak'))}`),
      'descriptors/ModuleDescriptor-template.json': template,
      'src/main/resources/templates/db_scripts/schema.json': '{}'
    });

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('B016 pass: Every infrastructure found is on the Officially Supported Technologies list: PostgreSQL, Apache Kafka, '
      + 'S3 object storage (listed as MinIO, an advisory entry), and Keycloak (listed as FOLIO Keycloak, an advisory entry).');
    expect(result.details?.split('\n')).toEqual([
      POLICY,
      CHECKED,
      'On the list:',
      '  - PostgreSQL — "PostgreSQL 16" (required)',
      '    - storage evidence: RMB database schema src/main/resources/templates/db_scripts/schema.json',
      '  - Apache Kafka — "Kafka 4.2 with matching MSK where possible" (required)',
      '    - pom.xml — dependency org.folio:folio-kafka-wrapper',
      '  - S3 object storage (listed as MinIO, an advisory entry) — "Current MinIO compatible with S3" (required)',
      '    - pom.xml — dependency org.folio:folio-s3-client',
      '  - Keycloak (listed as FOLIO Keycloak, an advisory entry) — "FOLIO Keycloak latest-version guidance" (required)',
      '    - pom.xml — dependency org.keycloak:keycloak-admin-client'
    ]);
    expect(analysis.technologies.map(technology => [technology.id, technology.listedAs?.id, technology.listedAs?.section])).toEqual([
      ['postgresql', 'postgresql', 'infrastructure'],
      ['kafka', 'kafka', 'infrastructure'],
      ['s3', 'minio-storage', 'infrastructure'],
      ['keycloak', 'folio-keycloak', 'fast-moving-infrastructure']
    ]);
    expect(analysis.checklist.items).toEqual([]);
  });

  it('fails on a required infrastructure that is not on the list, even when other evidence needs review', async () => {
    const { result, analysis } = await b016({
      'pom.xml': pom('mod-example', dependencies(dependency('jedis', 'redis.clients'), dependency('vault-java-driver', 'com.bettercloud'))),
      'descriptors/ModuleDescriptor-template.json': template,
      'build.gradle': 'dependencies {\n  implementation libs.lettuce\n}\n',
      'src/main/resources/application.yml': 'spring:\n  rabbitmq:\n    host: queue\n'
    });

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toBe('B016 fail: The module requires Redis (dependency redis.clients:jedis in pom.xml) and HashiCorp Vault '
      + '(dependency com.bettercloud:vault-java-driver in pom.xml), which are not on the Officially Supported Technologies list. '
      + 'The configuration names RabbitMQ (configuration spring.rabbitmq.host in src/main/resources/application.yml), which is not on the '
      + 'Officially Supported Technologies list, but no client library for it is a direct dependency. '
      + 'The tool could not read 1 dependency declaration or configuration file, so it may have missed infrastructure.');
    expect(result.details?.split('\n')).toEqual([
      POLICY,
      'Checked: direct production dependencies in 2 build files (build.gradle and pom.xml), storage evidence, configuration keys and environment variables. '
        + 'Transitive dependencies are not visible without running the build, and server versions are not checked.',
      'Not on the list, required:',
      '  - Redis',
      '    - pom.xml — dependency redis.clients:jedis',
      '  - HashiCorp Vault',
      '    - pom.xml — dependency com.bettercloud:vault-java-driver',
      'Not on the list, named only in configuration:',
      '  - RabbitMQ',
      '    - src/main/resources/application.yml — configuration spring.rabbitmq.host',
      'What the tool could not read:',
      '  - build.gradle:2 — a dependency that is not a plain "group:name" string, such as a version catalog entry or a variable',
      'What to do:',
      '  - Replace each infrastructure listed under "Not on the list, required" with one on the Officially Supported Technologies list, or ask the Technical Council to add it to the list.',
      'Checklist for the reviewer:',
      '  - B016-C1 Each infrastructure the module requires is on the Officially Supported Technologies list, or the Technical Council has accepted it.',
      '    - Start with:',
      '      - pom.xml — Redis: dependency redis.clients:jedis',
      '      - pom.xml — HashiCorp Vault: dependency com.bettercloud:vault-java-driver',
      '  - B016-C3 Each infrastructure that only the configuration names is unused, or is on the list or accepted by the Technical Council.',
      '    - Start with:',
      '      - src/main/resources/application.yml — RabbitMQ: configuration spring.rabbitmq.host',
      '  - B016-C4 The dependencies and configuration the tool could not read add no infrastructure outside the Officially Supported Technologies list.',
      '    - Start with:',
      '      - build.gradle:2 — a dependency that is not a plain "group:name" string, such as a version catalog entry or a variable'
    ]);
    expect(analysis.checklist.items.map(item => item.id)).toEqual(['B016-C1', 'B016-C3', 'B016-C4']);
  });

  it('escapes repository text in report rows', async () => {
    const { result } = await b016({
      'pom.xml': pom('mod-example'),
      'descriptors/ModuleDescriptor-template.json': template,
      'src/main/resources/my config.yml': '"spring.rabbitmq.host\\n  - forged row": queue\n'
    });

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B016 manual: The configuration names RabbitMQ (configuration spring.rabbitmq.host ↵   - forged row in src/main/resources/my%20config.yml), '
      + 'which is not on the Officially Supported Technologies list, but no client library for it is a direct dependency. A reviewer must check it.');
    expect(result.details?.split('\n').slice(2)).toEqual([
      'Not on the list, named only in configuration:',
      '  - RabbitMQ',
      '    - src/main/resources/my%20config.yml — configuration spring.rabbitmq.host ↵   - forged row',
      'Checklist for the reviewer:',
      '  - B016-C3 Each infrastructure that only the configuration names is unused, or is on the list or accepted by the Technical Council.',
      '    - Start with:',
      '      - src/main/resources/my%20config.yml — RabbitMQ: configuration spring.rabbitmq.host ↵   - forged row'
    ]);
  });

  it('leaves edge-common\'s Vault and AWS SSM secure stores to the reviewer (Q10)', async () => {
    const { result } = await b016({
      'pom.xml': pom('edge-example', dependencies(dependency('edge-common'), dependency('ssm', 'software.amazon.awssdk'), dependency('vault-java-driver', 'com.bettercloud'))),
      'descriptors/ModuleDescriptor-template.json': template,
      'src/main/resources/vault.properties': 'secureStore.type=Vault\n'
    });

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B016 manual: The module can use AWS Systems Manager Parameter Store and HashiCorp Vault, which are not on the '
      + 'Officially Supported Technologies list, as options (edge-common secure store, chosen with secure_store; the default is Ephemeral). '
      + 'A reviewer must check them.');
    expect(result.details?.split('\n').slice(2)).toEqual([
      'Not on the list, optional:',
      '  - AWS Systems Manager Parameter Store',
      '    - pom.xml — dependency software.amazon.awssdk:ssm (edge-common secure store, chosen with secure_store; the default is Ephemeral)',
      '  - HashiCorp Vault',
      '    - pom.xml — dependency com.bettercloud:vault-java-driver (edge-common secure store, chosen with secure_store; the default is Ephemeral)',
      '    - src/main/resources/vault.properties — configuration secureStore.type=Vault (edge-common secure store, chosen with secure_store; the default is Ephemeral)',
      'Checklist for the reviewer:',
      '  - B016-C2 Each optional backend that is not on the list stays optional: the module works with a supported option, and the documentation names it.',
      '    - Start with:',
      '      - pom.xml — AWS Systems Manager Parameter Store: dependency software.amazon.awssdk:ssm (edge-common secure store, chosen with secure_store; the default is Ephemeral)',
      '      - pom.xml — HashiCorp Vault: dependency com.bettercloud:vault-java-driver (edge-common secure store, chosen with secure_store; the default is Ephemeral)',
      '      - src/main/resources/vault.properties — HashiCorp Vault: configuration secureStore.type=Vault (edge-common secure store, chosen with secure_store; the default is Ephemeral)'
    ]);
  });

  it.each([
    ['a library with no infrastructure', { 'pom.xml': pom('folio-spring-base', dependencies(dependency('caffeine', 'com.github.ben-manes.caffeine'))) },
      EvaluationStatus.PASS, 'infrastructure-checked',
      'B016 pass: No infrastructure was found in the direct dependencies, storage evidence, configuration or environment variables.'],
    ['a test-scoped unlisted client', { 'pom.xml': pom('mod-example', dependencies('<dependency><groupId>org.mongodb</groupId><artifactId>bson</artifactId><scope>test</scope></dependency>')) },
      EvaluationStatus.PASS, 'infrastructure-checked',
      'B016 pass: No infrastructure was found in the direct dependencies, storage evidence, configuration or environment variables.'],
    ['an unlisted infrastructure named only by environment variables', {
      'pom.xml': pom('mod-example', dependencies(dependency('folio-kafka-wrapper'))),
      'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: 'mod-example-1.0.0', launchDescriptor: { env: [{ name: 'REDIS_HOST' }, { name: 'REDIS_PORT' }] } })
    }, EvaluationStatus.MANUAL, 'infrastructure-checked',
    'B016 manual: The configuration names Redis (environment variables REDIS_HOST and REDIS_PORT in descriptors/ModuleDescriptor-template.json), which is not on '
      + 'the Officially Supported Technologies list, but no client library for it is a direct dependency. On the list: Apache Kafka. A reviewer must check it.'],
    ['a Maven profile dependency', { 'pom.xml': pom('mod-example', `<profiles><profile><id>cache</id>${dependencies(dependency('jedis', 'redis.clients'))}</profile></profiles>`), 'descriptors/ModuleDescriptor-template.json': template },
      EvaluationStatus.MANUAL, 'infrastructure-checked',
      'B016 manual: The module can use Redis, which is not on the Officially Supported Technologies list, as an option (declared in the Maven profile cache). A reviewer must check it.'],
    ['a dependency declaration the tool cannot read', {
      'build.gradle': 'dependencies {\n  implementation "org.apache.kafka:kafka-clients:4.2.0"\n  implementation libs.cache\n}\n',
      'descriptors/ModuleDescriptor-template.json': template
    }, EvaluationStatus.MANUAL, 'infrastructure-checked',
    'B016 manual: The tool could not read 1 dependency declaration or configuration file, so it may have missed infrastructure. On the list: Apache Kafka. A reviewer must check it.'],
    ['committed source the tool could not read completely', {
      'pom.xml': pom('mod-example', dependencies(dependency('folio-kafka-wrapper'))),
      'descriptors/ModuleDescriptor-template.json': template,
      'src/main/resources/large.json': `"${'x'.repeat(1024 * 1024 + 1)}"`
    }, EvaluationStatus.MANUAL, 'infrastructure-checked',
    'B016 manual: The committed source was not read completely, so the tool may have missed infrastructure. On the list: Apache Kafka. A reviewer must check it.'],
    ['no build file', { 'src/main/java/org/example/Main.java': 'class Main {}' }, EvaluationStatus.MANUAL, 'no-build-file',
      'B016 manual: No pom.xml or build.gradle was found, so the tool could not read the dependencies. A reviewer must check them.']
  ])('decides %s', async (_name, files, status, basis, evidence) => {
    const { result, analysis } = await b016(files);

    expect(result.status).toBe(status);
    expect(analysis.basis).toBe(basis);
    expect(result.evidence).toBe(evidence);
  });

  it('leaves the result to the reviewer when the policy cannot be read or gives B016 no sections', async () => {
    const infrastructure = {
      items: [{ id: 'redis' as const, name: 'Redis', usage: 'required' as const, signals: [{ kind: 'dependency' as const, detail: 'redis.clients:jedis', path: 'pom.xml' }] }],
      buildFiles: ['pom.xml'], diagnostics: [], sourceDiagnostics: []
    };
    const missing = evaluateB016('backend-module', infrastructure, await loadS007Policy('/nonexistent/officially-supported-technologies.json'));
    const policyLoad = await loadS007Policy();
    if (!policyLoad.ok) throw new Error('the committed policy must load');
    const withoutSections = evaluateB016('backend-module', infrastructure, { ...policyLoad, policy: { ...policyLoad.policy, sections: policyLoad.policy.sections
      .map(section => section.consumer === 'b016' ? { ...section, consumer: 'future' as const } : section) } });

    expect(missing.status).toBe(EvaluationStatus.MANUAL);
    expect(missing.summary).toBe('B016 manual: The Officially Supported Technologies list could not be read (The officially supported technologies list was not found at '
      + '/nonexistent/officially-supported-technologies.json.), so the tool could not compare the infrastructure with it. A reviewer must check it.');
    expect(withoutSections.status).toBe(EvaluationStatus.MANUAL);
    expect(withoutSections.summary).toBe('B016 manual: The Officially Supported Technologies list has no infrastructure sections, so the tool could not compare the infrastructure with it. A reviewer must check it.');
    expect(withoutSections.checklist.items.map(item => [item.id, item.startingPoints])).toEqual([['B016-C1', [{ path: 'pom.xml', note: 'Redis: dependency redis.clients:jedis' }]]]);
  });
});
