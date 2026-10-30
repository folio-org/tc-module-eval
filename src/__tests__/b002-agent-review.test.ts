import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B002Analysis, CriterionAgentAssessment, CriterionAgentReviewConfig, EvaluationStatus } from '../types';
import { buildB002AgentReviewRequest } from '../utils/b002-agent-review';
import { prepareCriterionAgentReviewEvidence } from '../utils/criterion-agent-review';
import { createEvaluationRun } from '../utils/evaluation-run';
import { loadF001HandlerIndex } from '../utils/f001-consumed-apis';
import { pom, repository } from './helpers/backend-repository';

const CLIENTS = 'src/main/java/org/folio/example/support/Clients.java';
const KEYCLOAK = 'src/main/java/org/folio/example/KeycloakClient.java';

function fixture(): string {
  return repository({
    'pom.xml': pom('mod-example'),
    'descriptors/ModuleDescriptor-template.json': JSON.stringify({ id: 'mod-example-1.0.0', requires: [{ id: 'users', version: '16.0' }] }),
    [CLIENTS]: [
      'package org.folio.example.support;',
      '',
      'public class Clients {',
      '  CollectionResourceClient users(OkapiHttpClient client) { return getCollectionResourceClient(client, "/users"); }',
      '  CollectionResourceClient configuration(OkapiHttpClient client) { return getCollectionResourceClient(client, "/configurations/entries"); }',
      '}'
    ].join('\n'),
    [KEYCLOAK]: [
      'package org.folio.example;',
      '',
      'public class KeycloakClient {',
      '  String certs(String keycloakUrl, String realm) { return keycloakUrl + String.format("/realms/%s/protocol/openid-connect/certs", realm); }',
      '}'
    ].join('\n'),
    'src/test/java/org/folio/example/ClientsTest.java': 'class ClientsTest { void test() { get("/configurations/entries"); } }'
  });
}

const deadCode = (fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
  technologyId: 'B002-C1#1', type: 'aligned_fact', summary: 'Nothing calls Clients.configuration, so the request is never sent.',
  evidenceReferences: [CLIENTS], coverageDisposition: 'investigated', ...fields
});
const keycloak = (fields: Partial<CriterionAgentAssessment> = {}): CriterionAgentAssessment => ({
  technologyId: 'B002-C2#1', type: 'aligned_fact', summary: 'The path goes to Keycloak at keycloakUrl, a service outside FOLIO.',
  evidenceReferences: [KEYCLOAK], coverageDisposition: 'investigated', ...fields
});
const action = { action: 'Remove the unused configuration client.', evidenceReferences: [CLIENTS] };

describe('B002 agent review', () => {
  it('gives the agent the undeclared interfaces first, then the unmapped paths, from production source with the index patterns of their first segment', async () => {
    const root = fixture();
    const analysis = (await new BackendEvaluator().evaluateCriterion('B002', root)).criterionDetails as B002Analysis;
    const index = loadF001HandlerIndex();
    if (!index.loaded) throw new Error(index.problem);
    const prepared = (await prepareCriterionAgentReviewEvidence(buildB002AgentReviewRequest(root, analysis, index.patterns))).request;
    const file = (name: string) => JSON.parse(prepared.files.find(item => item.repoRelativePath === `.criterion-agent/B002/${name}`)!.content);

    expect(analysis.status).toBe(EvaluationStatus.MANUAL);
    expect(prepared.files.map(item => item.repoRelativePath)).not.toContain('src/test/java/org/folio/example/ClientsTest.java');
    expect(prepared.files.map(item => item.repoRelativePath)).toContain(CLIENTS);
    expect(file('checklist.json').items.flatMap((item: any) => item.obligations)).toEqual([
      { id: 'B002-C1#1', subject: 'interface configuration', path: CLIENTS, line: 5, flag: 'manual' },
      { id: 'B002-C2#1', subject: '/realms/{}/protocol/openid-connect/certs', path: KEYCLOAK, line: 4 }
    ]);
    expect(Object.keys(file('handler-patterns.json').bySegment)).toEqual(['configurations', 'realms']);
    expect(file('handler-patterns.json').bySegment.configurations.patterns).toEqual(expect.arrayContaining([
      { interface: 'configuration', methods: ['GET'], pathPattern: '/configurations/entries' }
    ]));
    expect(prepared.instructions).toContain('descriptors/ModuleDescriptor-template.json declares users in requires or optional');
  });

  it('runs only when --criterion-agent-criteria lists B002', async () => {
    const config = fakeConfig({ assessments: [deadCode(), keycloak()], reviewerActions: [action] });
    delete config.enabledCriteria;

    const result = await evaluateWith(fixture(), config);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview).toBeUndefined();
    expect(result.details?.split('\n').slice(-2)).toEqual(['Agent review:', '  - Not applied: agent review for B002 runs only when listed in --criterion-agent-criteria']);
  });

  it('attaches an accepted review to the checklist and shows discovered requests on their own, leaving the status unchanged', async () => {
    const result = await evaluateWith(fixture(), fakeConfig({
      assessments: [deadCode(), keycloak(), { technologyId: 'discovered:interface:1', type: 'substantive_concern',
        summary: 'Clients.users is extended with /users/{id}/permissions, which `permissions` serves.', evidenceReferences: [CLIENTS], coverageDisposition: 'investigated' }],
      reviewerActions: [action]
    }));
    const lines = result.details!.split('\n');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.agentReview?.available).toBe(true);
    expect(lines.slice(lines.indexOf('Checklist for the reviewer:'), lines.indexOf('Agent review (advisory):'))).toEqual([
      'Checklist for the reviewer:',
      '  - B002-C1 Each interface under "Used but not declared" is called from code that runs, and is declared in requires, or in optional when the module works without it.',
      '    - Start with:',
      `      - ${CLIENTS}:5 — configuration: /configurations/entries`,
      '    - Agent: Supported by evidence — interface configuration: Nothing calls Clients.configuration, so the request is never sent.',
      '      - Sources:',
      `        - ${CLIENTS}`,
      '      - Coverage judgment: Investigated directly',
      '  - B002-C2 Each request the tool could not map to one interface, or whose path is not in the handler index, goes to an interface the descriptor declares, or to a service outside FOLIO.',
      '    - Start with:',
      `      - ${KEYCLOAK}:4 — /realms/{}/protocol/openid-connect/certs: not in the handler index`,
      '    - Agent: Supported by evidence — /realms/{}/protocol/openid-connect/certs: The path goes to Keycloak at keycloakUrl, a service outside FOLIO.',
      '      - Sources:',
      `        - ${KEYCLOAK}`,
      '      - Coverage judgment: Investigated directly'
    ]);
    const findings = lines.indexOf('  - Findings:');
    expect(lines.slice(findings, findings + 7)).toEqual([
      '  - Findings:',
      '    - Request found by the agent (1) — Potential problem:',
      '      - The reviewed source indicates a possible problem. Confirm its impact before making a decision.',
      '      - Finding: Clients.users is extended with /users/{id}/permissions, which `permissions` serves.',
      '      - Sources:',
      `        - ${CLIENTS}`,
      '      - Coverage judgment: Investigated directly'
    ]);
    expect(lines).toContain(`  - Agent review scope: ${'Java, Groovy and Kotlin sources and resources under src/main/ in any module folder (no reference or sample data), '
      + 'grails-app/, descriptors/ and the descriptor template, ramls/ (no raml-util), pom.xml and build.gradle files, and README, ENV_VARS.md, Dockerfile and docker-compose files at the root'}`);
  });

  it('drops a concern that names only a declared interface, and keeps the rest of the review', async () => {
    const result = await evaluateWith(fixture(), fakeConfig({
      assessments: [deadCode({ type: 'substantive_concern', summary: 'Production code sends this request through `users`.' }), keycloak()],
      reviewerActions: [action]
    }));
    const lines = result.details!.split('\n');
    const c1 = lines.findIndex(line => line.startsWith('  - B002-C1 '));

    expect(result.agentReview?.available).toBe(true);
    expect(result.agentReview?.assessments?.map(assessment => assessment.technologyId)).toEqual(['B002-C2#1']);
    expect(lines.slice(c1 + 3, c1 + 5)).toEqual([
      '    - Agent result dropped — interface configuration: The potential problem does not name, in backticks, an interface that the descriptor does not declare.',
      '  - B002-C2 Each request the tool could not map to one interface, or whose path is not in the handler index, goes to an interface the descriptor declares, or to a service outside FOLIO.'
    ]);
  });
});

function evaluateWith(root: string, config: CriterionAgentReviewConfig) {
  return new BackendEvaluator().evaluateCriterion('B002', root, createEvaluationRun({ repositoryPath: root, language: 'java', agentReview: config }));
}

function fakeConfig(fields: Record<string, unknown>): CriterionAgentReviewConfig {
  return { enabled: true, enabledCriteria: ['B002'], adapter: 'fake', modelLabel: 'fake-model', fakeResult: {
    available: true, criterionId: 'B002', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
    summary: 'One client is unused and one path goes outside FOLIO.', rationale: `Read ${CLIENTS}.`, evidenceReferences: [CLIENTS],
    warnings: [], errors: [], ...fields
  } as CriterionAgentReviewConfig['fakeResult'] };
}
