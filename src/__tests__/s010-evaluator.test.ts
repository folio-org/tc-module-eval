import {
  EvaluationStatus,
  S010Analysis,
  S010Evidence,
  S010ScenarioEvidence
} from '../types';
import { evaluateS010 } from '../utils/s010-evaluator';
import { renderS010HumanDetails } from '../utils/s010-report-details';

const moduleKind = (kind: S010Evidence['moduleKind']['kind']): S010Evidence['moduleKind'] => ({
  kind,
  evidence: [`fixture ${kind}`],
  warnings: []
});

const evidence = (overrides: Partial<S010Evidence> = {}): S010Evidence => ({
  moduleKind: moduleKind('backend-module'),
  runtimeKind: 'java',
  discoveryCoverage: 'complete',
  semanticCoverage: 'complete',
  scenarios: [],
  diagnostics: [],
  ...overrides
});

const scenario = (overrides: Partial<S010ScenarioEvidence> = {}): S010ScenarioEvidence => ({
  id: 'search/runtime-unavailable',
  dependencyId: 'search',
  requirement: 'optional',
  scenario: 'runtime-unavailable',
  proof: 'unresolved',
  sourceReferences: [{ path: 'src/SearchClient.java', detail: 'search request' }],
  boundedFailure: 'unknown',
  readiness: 'unknown',
  ...overrides
});

describe('S010 deterministic evaluator', () => {
  it('returns not applicable for explicit libraries', () => {
    const result = evaluateS010(evidence({ moduleKind: moduleKind('library') }));

    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(result.summary).toContain('library');
  });

  it.each(['node', 'mixed', 'unknown'] as const)('keeps %s runtimes manual', runtimeKind => {
    const result = evaluateS010(evidence({ runtimeKind }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0]).toMatchObject({ outcome: 'unresolved', statusDetermining: true });
  });

  it('passes a semantically complete empty dependency scope', () => {
    const result = evaluateS010(evidence());

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.findings[0]).toMatchObject({ outcome: 'satisfactory', dependencyId: 'dependency-scope' });
  });

  it('keeps detector-empty incomplete evidence manual', () => {
    const result = evaluateS010(evidence({ semanticCoverage: 'incomplete' }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0].rationale).toContain('does not show that there are none');
  });

  it('keeps satisfactory scenarios manual when semantic coverage is incomplete', () => {
    const result = evaluateS010(evidence({
      semanticCoverage: 'incomplete',
      scenarios: [scenario({
        proof: 'controlled-degradation',
        boundedFailure: 'proven',
        readiness: 'preserved'
      })]
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ dependencyId: 'evidence-coverage', outcome: 'unresolved', statusDetermining: true })
    ]));
  });

  it('accepts clear fail-fast handling for required configuration', () => {
    const result = evaluateS010(evidence({ scenarios: [scenario({
      requirement: 'required',
      scenario: 'configuration-absent',
      proof: 'clear-fail-fast',
      boundedFailure: 'not-applicable',
      readiness: 'not-applicable'
    })] }));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.findings[0].outcome).toBe('satisfactory');
  });

  it('accepts a bounded clear startup failure for a required dependency', () => {
    const result = evaluateS010(evidence({ scenarios: [scenario({
      requirement: 'required',
      scenario: 'startup-unavailable',
      proof: 'clear-fail-fast',
      boundedFailure: 'proven',
      readiness: 'not-applicable'
    })] }));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.findings[0].outcome).toBe('satisfactory');
  });

  it('keeps an unbounded required startup failure manual', () => {
    const result = evaluateS010(evidence({ scenarios: [scenario({
      requirement: 'required',
      scenario: 'startup-unavailable',
      proof: 'clear-fail-fast',
      boundedFailure: 'unknown',
      readiness: 'not-applicable'
    })] }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
  });

  it('accepts bounded controlled runtime loss of a required dependency even when readiness is not preserved', () => {
    const result = evaluateS010(evidence({ scenarios: [scenario({
      requirement: 'required',
      scenario: 'runtime-unavailable',
      proof: 'controlled-degradation',
      boundedFailure: 'proven',
      readiness: 'not-preserved'
    })] }));

    expect(result.status).toBe(EvaluationStatus.PASS);
  });

  it('fails an explicitly uncontrolled required dependency outage', () => {
    const result = evaluateS010(evidence({ scenarios: [scenario({
      requirement: 'required',
      scenario: 'runtime-unavailable',
      proof: 'uncontrolled-failure',
      boundedFailure: 'proven',
      readiness: 'not-preserved'
    })] }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
  });

  it('fails an explicit required configuration path that defers failure', () => {
    const result = evaluateS010(evidence({ scenarios: [scenario({
      id: 'search:SEARCH_URL/configuration-absent',
      requirement: 'required',
      scenario: 'configuration-absent',
      proof: 'uncontrolled-failure'
    })] }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.findings[0]).toMatchObject({ outcome: 'violation', statusDetermining: true });
    expect(result.summary).toBe('S010 fail: OpenSearch or Elasticsearch settings (SEARCH_URL), if missing at startup: '
      + 'Missing this required setting leads to an uncontrolled failure instead of a clear error at startup. Make startup stop with a clear error when the setting is missing.');
  });

  it('passes linked optional degradation with a bound and preserved readiness', () => {
    const result = evaluateS010(evidence({ scenarios: [scenario({
      proof: 'controlled-degradation',
      boundedFailure: 'proven',
      readiness: 'preserved'
    })] }));

    expect(result.status).toBe(EvaluationStatus.PASS);
  });

  it('fails an optional outage that explicitly makes the module unready', () => {
    const result = evaluateS010(evidence({ scenarios: [scenario({
      proof: 'controlled-degradation',
      boundedFailure: 'proven',
      readiness: 'not-preserved'
    })] }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
  });

  it('keeps missing visible handling manual', () => {
    const result = evaluateS010(evidence({ scenarios: [scenario()] }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0].outcome).toBe('unresolved');
  });

  it('lets a proven violation outrank an unrelated material diagnostic', () => {
    const result = evaluateS010(evidence({
      scenarios: [scenario({ proof: 'uncontrolled-failure' })],
      diagnostics: [{ code: 'unsupported-wrapper', message: 'another client is unresolved', material: true }]
    }));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.diagnostics).toHaveLength(1);
  });
});

describe('S010 human details', () => {
  it('keeps multiline advisory prose inside its report rows', () => {
    const analysis = evaluateS010(evidence({ semanticCoverage: 'incomplete' }));
    const details = renderS010HumanDetails(analysis, {
      available: true, criterionId: 'S010', recommendation: 'needs_reviewer_judgment', confidence: 'medium',
      summary: 'Required service.\nNot an optional feature.',
      rationale: 'Investigated startup.\n\nScope: tenant initialization.',
      evidenceReferences: ['src/Client.java'], warnings: [], errors: [],
      assessments: [{ technologyId: 'search', type: 'evidence_gap',
        summary: 'Bound unknown.\nReadiness unresolved.', evidenceReferences: ['src/Client.java'] }],
      reviewerActions: [{ action: 'Check failure bound.\nThen readiness.', evidenceReferences: ['src/Client.java'] }]
    });
    const advisory = details.slice(details.indexOf('Agent review (advisory):')).split('\n');
    expect(advisory.filter(line => !line.startsWith('  '))).toEqual(['Agent review (advisory):']);
    expect(advisory).toContain('  - Rationale: Investigated startup. Scope: tenant initialization.');
    expect(advisory).toContain('    - Search service — Needs verification:');
    expect(advisory).toContain('      - Finding: Bound unknown. Readiness unresolved.');
    expect(advisory).toContain('  - What to verify:');
    expect(advisory).toContain('    - Check failure bound. Then readiness.');
    expect(advisory).toContain('        - src/Client.java');
  });

  it('names the configuration keys for each scenario, groups rows by dependency, and cites each source once', () => {
    const finding = (id: string, dependencyId: string) => ({
      id, dependencyId, scenario: 'configuration-absent' as const, outcome: 'unresolved' as const,
      rationale: 'The code does not show what happens at startup when this configuration is missing.',
      evidence: [{ path: 'descriptors/ModuleDescriptor-template.json', detail: 'Environment variable not marked required' }],
      statusDetermining: true
    });
    const analysis = {
      criterionId: 'S010' as const, status: EvaluationStatus.MANUAL, summary: 'manual', diagnostics: [],
      evidence: { moduleKind: { kind: 'backend-module', evidence: [], warnings: [] }, runtimeKind: 'java', discoveryCoverage: 'complete', semanticCoverage: 'incomplete', scenarios: [], diagnostics: [] },
      findings: [
        finding('kafka:KAFKA_HOST/configuration-absent', 'kafka'),
        finding('okapi:OKAPI_URL/configuration-absent', 'okapi'),
        finding('database:DB_PORT/configuration-absent', 'database'),
        finding('kafka:KAFKA_PORT/configuration-absent', 'kafka'),
        finding('database:DB_HOST/configuration-absent', 'database')
      ]
    } as unknown as S010Analysis;

    const details = renderS010HumanDetails(analysis).split('\n');

    expect(details.slice(details.indexOf('Needs review (not confirmed problems):')).filter(line => line.startsWith('  - '))).toEqual([
      '  - Database settings (DB_HOST, DB_PORT), if missing at startup',
      '  - Kafka settings (KAFKA_HOST, KAFKA_PORT), if missing at startup',
      '  - Okapi settings (OKAPI_URL), if missing at startup'
    ]);
    expect(details).toContain('Needs review (not confirmed problems):');
    expect(details.filter(line => line.startsWith('    - descriptors/'))).toEqual(Array(3).fill(
      '    - descriptors/ModuleDescriptor-template.json [config] Environment variable not marked required'
    ));
  });

  it('shortens repository-made names in the summary and the row titles', () => {
    const name = `${'Q'.repeat(5_000)}_URL`;
    const analysis = evaluateS010(evidence({
      semanticCoverage: 'incomplete',
      scenarios: [scenario({ id: `qqq:${name}/configuration-absent`, dependencyId: 'qqq', scenario: 'configuration-absent', requirement: 'unresolved' })]
    }));

    const details = renderS010HumanDetails(analysis);

    expect(analysis.summary.length).toBeLessThan(500);
    expect(analysis.summary).toContain(`${'Q'.repeat(100)}…`);
    expect(details.split('\n').every(line => line.length < 1_000)).toBe(true);
  });

  it('merges repeated source-reading warnings into one row per kind', () => {
    const skipped = (code: string, filePath: string) => ({ code, message: 'raw', material: true, path: filePath });
    const analysis = evaluateS010(evidence({
      discoveryCoverage: 'incomplete',
      diagnostics: [
        skipped('file-size', 'src/a.json'), skipped('unsafe-entry', 'src/link'), skipped('file-size', 'src/b.json'),
        { code: 'unsupported-runtime-pattern', message: 'Uses Vert.x clients, which the tool cannot analyse.', material: true, path: 'src/C.java' }
      ]
    }));

    const details = renderS010HumanDetails(analysis);

    expect(details).toContain([
      'Warnings:',
      '  - src/C.java [unsupported] Uses Vert.x clients, which the tool cannot analyse.',
      '  - Files larger than 192 KB were not read (2 files):',
      '    - src/a.json',
      '    - src/b.json',
      '  - Symbolic links, submodules and unsafe paths were not read (1 file):',
      '    - src/link'
    ].join('\n'));
    expect(details).not.toContain('raw');
  });
});
