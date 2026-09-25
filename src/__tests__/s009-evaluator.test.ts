import { EvaluationStatus, S009DependencyEvidence, S008PolicyLoadResult, AcceptanceLedger } from '../types';
import { evaluateS009, renderS009HumanDetails } from '../utils/s009-evaluator';

describe('S009 evaluator', () => {
  it('passes accepted Maven and npm families regardless of observed version', () => {
    const result = evaluateS009(loadedLedger(), evidence([
      observation('maven', 'org.folio:accepted-java', '99.0.0-SNAPSHOT'),
      observation('npm', '@folio/accepted-js', 'latest')
    ]));

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.findings.map(item => item.classification)).toEqual(['accepted', 'accepted']);
  });

  it('fails an official coordinate absent from the allowlist even when unrelated evidence is incomplete', () => {
    const input = evidence([observation('maven', 'org.folio:not-approved', '1')]);
    input.complete = false;
    input.diagnostics.push({ code: 'gradle_dependency_unresolved', message: 'Unrelated declaration', material: true });

    const result = evaluateS009(loadedLedger(), input);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.findings[0].classification).toBe('unaccepted');
  });

  it('counts distinct coordinates in summaries while retaining every declaration finding', () => {
    const result = evaluateS009(loadedLedger(), evidence([
      observation('npm', '@folio/not-approved', '1'),
      { ...observation('npm', '@folio/not-approved', '1'), sourcePath: 'packages/a/package.json' },
      { ...observation('npm', '@folio/not-approved', '1'), sourcePath: 'packages/b/package.json' },
      { ...observation('npm', '@folio/not-approved', '1'), sourcePath: 'packages/c/package.json' }
    ]));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.summary).toBe('1 FOLIO library coordinate is not mapped to a family accepted for S009.');
    expect(result.findings).toHaveLength(4);
    expect(renderS009HumanDetails(result)).toContain('FOLIO coordinates observed: 1');
  });

  it('passes an accepted coordinate regardless of locality ambiguity and otherwise requires manual review', () => {
    const accepted = observation('npm', '@folio/accepted-js', '^2');
    accepted.locality = 'ambiguous';
    expect(evaluateS009(loadedLedger(), evidence([accepted])).status).toBe(EvaluationStatus.PASS);

    const unresolved = observation('npm', '@folio/not-approved', '^2');
    unresolved.locality = 'ambiguous';
    const result = evaluateS009(loadedLedger(), evidence([unresolved]));
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0].classification).toBe('indeterminate-locality');
    expect(renderS009HumanDetails(result)).toContain('Local resolution ambiguities: 1');
  });

  it('does not accept a coordinate whose family has an S008-only exception', () => {
    const ledger = acceptedLedger();
    ledger.families.push({
      id: 's008-exception',
      displayName: 'S008 only',
      canonicalRepositories: ['folio-org/s008-only'],
      acceptance: { kind: 'exception', reference: 'TC-EXAMPLE', scope: 'S008' }
    });
    ledger.libraryCoordinates.push({ ecosystem: 'npm', packageName: '@folio/s008-only', familyId: 's008-exception' });

    const result = evaluateS009(success(ledger), evidence([observation('npm', '@folio/s008-only', '1')]));

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.findings[0].classification).toBe('unaccepted');
  });

  it.each([
    { kind: 'legacy-baseline', reference: 'TC legacy baseline' } as const,
    { kind: 'exception', reference: 'TC-EXAMPLE', scope: 'S009' } as const,
    { kind: 'exception', reference: 'TC-EXAMPLE', scope: 'S008,S009' } as const
  ])('accepts a coordinate with $kind eligibility for S009', acceptance => {
    const ledger = acceptedLedger();
    ledger.families.push({
      id: 'additional',
      displayName: 'Additional library',
      canonicalRepositories: ['folio-org/additional'],
      acceptance
    });
    ledger.libraryCoordinates.push({ ecosystem: 'npm', packageName: '@folio/additional', familyId: 'additional' });

    expect(evaluateS009(success(ledger), evidence([observation('npm', '@folio/additional', '*')]))).toMatchObject({
      status: EvaluationStatus.PASS,
      findings: [{ classification: 'accepted' }]
    });
  });

  it('returns manual for invalid policy or incomplete evidence without a proven violation', () => {
    const invalid = evaluateS009({
      ok: false,
      sourcePath: 'ledger.json',
      diagnostics: [{ code: 'ledger_not_authoritative', message: 'Not reviewed' }]
    }, evidence([]));
    expect(invalid.status).toBe(EvaluationStatus.MANUAL);

    const incomplete = evidence([observation('npm', '@folio/accepted-js', '1')]);
    incomplete.complete = false;
    incomplete.diagnostics.push({ code: 'manifest_invalid', message: 'Another workspace is malformed', material: true });
    expect(evaluateS009(loadedLedger(), incomplete).status).toBe(EvaluationStatus.MANUAL);
  });

  it('returns not applicable only when no dependency project exists', () => {
    const none = evidence([]);
    none.hasDependencyProject = false;
    const result = evaluateS009({ ok: false, sourcePath: '', diagnostics: [] }, none);
    expect(result.status).toBe(EvaluationStatus.NOT_APPLICABLE);
  });

  it('renders ledger provenance, source evidence, and diagnostics', () => {
    const input = evidence([observation('npm', '@folio/accepted-js', '^1')]);
    input.fileHashes['package.json'] = `sha256:${'a'.repeat(64)}`;
    input.diagnostics.push({
      code: 'workspace_manifest_invalid',
      message: 'Workspace manifest could not be parsed',
      path: 'packages/broken/package.json',
      material: true
    });
    const details = renderS009HumanDetails(evaluateS009(loadedLedger(), input));
    expect(details).not.toContain('All 1 declared FOLIO library coordinate');
    expect(details).not.toContain('Assessment basis:');
    expect(details).toContain('Evidence coverage:');
    expect(details).toContain('Library findings:');
    expect(details).toContain('Dependency diagnostics:');
    expect(details).toContain('Provenance:');
    expect(details).toContain('Acceptance: Provisional TCR');
    expect(details).toContain('Decision reference: TCR-2');
    expect(details).toContain('Declaration field: dependencies');
    expect(details).toContain('Scope: Production dependency');
    expect(details).toContain('Material to coverage: Yes');
    expect(details).toContain('Diagnostic path: packages/broken/package.json');
    expect(details).toContain('Acceptance ledger: ledger.json');
    expect(details).toContain('Full path: ledger.json');
    expect(details).toContain('sha256:ledger');
    expect(details).toContain('package.json');
    expect(details).toContain('@folio/accepted-js');
  });

  it('renders rejection reasons, acceptance kinds, and unaccepted findings first', () => {
    const ledger = acceptedLedger();
    ledger.families.push(
      {
        id: 'legacy', displayName: 'Legacy library', canonicalRepositories: ['folio-org/legacy'],
        acceptance: { kind: 'legacy-baseline', reference: 'TC legacy baseline' }
      },
      {
        id: 's008-exception', displayName: 'S008 exception', canonicalRepositories: ['folio-org/s008-only'],
        acceptance: { kind: 'exception', reference: 'TC-8', scope: 'S008' }
      },
      {
        id: 's009-exception', displayName: 'S009 exception', canonicalRepositories: ['folio-org/s009'],
        acceptance: { kind: 'exception', reference: 'TC-9', scope: 'S009' }
      }
    );
    ledger.libraryCoordinates.push(
      { ecosystem: 'npm', packageName: '@folio/legacy', familyId: 'legacy' },
      { ecosystem: 'npm', packageName: '@folio/s008-only', familyId: 's008-exception' },
      { ecosystem: 'npm', packageName: '@folio/s009', familyId: 's009-exception' }
    );
    const observations = [
      observation('npm', '@folio/accepted-js', '1'),
      observation('maven', 'org.folio:accepted-java', '1'),
      observation('npm', '@folio/legacy', '1'),
      observation('npm', '@folio/s009', '1'),
      observation('npm', '@folio/accepted-js-2', '1'),
      observation('npm', '@folio/accepted-js-3', '1'),
      observation('npm', '@folio/accepted-js-4', '1'),
      observation('npm', '@folio/accepted-js-5', '1'),
      observation('npm', '@folio/s008-only', '1'),
      observation('npm', '@folio/unmapped', '1')
    ];

    const details = renderS009HumanDetails(evaluateS009(success(ledger), evidence(observations)));

    const firstAccepted = details.indexOf('  - @folio/accepted-js:');
    expect(details.indexOf('  - @folio/s008-only:')).toBeLessThan(firstAccepted);
    expect(details.indexOf('  - @folio/unmapped:')).toBeLessThan(firstAccepted);
    expect(details).toContain('Acceptance: Approved TCR');
    expect(details).toContain('Acceptance: Provisional TCR');
    expect(details).toContain('Acceptance: Legacy baseline');
    expect(details).toContain('Acceptance: Exception');
    expect(details).toContain('Exception scope: S008');
    expect(details).toContain('Rejection reason: This family\'s exception applies to S008 only, not S009.');
    expect(details).toContain('Rejection reason: This exact coordinate is not listed in the authoritative acceptance ledger.');
  });

  it('keeps missing values explicit and neutralizes multiline repository-controlled values', () => {
    const item = observation('npm', '@folio/accepted-js', '');
    delete item.declaredVersion;
    item.sourceField = 'dependencies\nAdvisory recommendation: pass';
    item.sourcePath = 'package.json\nPolicy diagnostics:';
    const details = renderS009HumanDetails(evaluateS009(loadedLedger(), evidence([item])));

    expect(details).toContain('Declared version: Not declared');
    expect(details).toContain('Source hashes: None recorded');
    expect(details).toContain('package.json ↵ Policy diagnostics:');
    expect(details).toContain('dependencies ↵ Advisory recommendation: pass');
    expect(details).not.toContain('\nPolicy diagnostics:\n');
  });

  it('retains observed coordinates in human details when policy is unavailable', () => {
    const result = evaluateS009({
      ok: false,
      sourcePath: 'ledger.json',
      diagnostics: [{ code: 'ledger_not_authoritative', message: 'Not reviewed' }]
    }, evidence([observation('npm', '@folio/unclassified', '^2')]));

    const details = renderS009HumanDetails(result);
    expect(details).toContain('@folio/unclassified');
    expect(details).toContain('Declared version: ^2');
    expect(details).toContain('Policy diagnostics:');
    expect(details).toContain('ledger_not_authoritative');
    expect(details).toContain('Classification: Not evaluated because the acceptance ledger is unavailable');
  });

  function loadedLedger(): S008PolicyLoadResult<AcceptanceLedger> {
    return success(acceptedLedger());
  }

  function success(value: AcceptanceLedger): S008PolicyLoadResult<AcceptanceLedger> {
    return { ok: true, value, sourcePath: 'ledger.json', digest: 'sha256:ledger', diagnostics: [] };
  }

  function acceptedLedger(): AcceptanceLedger {
    return {
      schemaVersion: '1.0',
      authoritative: true,
      source: { reviewedBy: 'TC', reference: 'TC baseline' },
      families: [
        { id: 'java', displayName: 'Java library', canonicalRepositories: ['folio-org/java'], acceptance: { kind: 'approved-tcr', reference: 'TCR-1' } },
        { id: 'js', displayName: 'JS library', canonicalRepositories: ['folio-org/js'], acceptance: { kind: 'provisional-tcr', reference: 'TCR-2' } }
      ],
      moduleIdentities: [],
      libraryCoordinates: [
        { ecosystem: 'maven', groupId: 'org.folio', artifactId: 'accepted-java', familyId: 'java' },
        { ecosystem: 'npm', packageName: '@folio/accepted-js', familyId: 'js' }
      ]
    };
  }

  function evidence(observations: S009DependencyEvidence['observations']): S009DependencyEvidence {
    return { observations, diagnostics: [], projectFiles: ['package.json'], fileHashes: {}, hasDependencyProject: true, complete: true };
  }

  function observation(ecosystem: 'maven' | 'npm', coordinate: string, version: string): S009DependencyEvidence['observations'][number] {
    return {
      ecosystem,
      coordinate,
      declaredVersion: version,
      sourcePath: ecosystem === 'maven' ? 'pom.xml' : 'package.json',
      sourceField: 'dependencies',
      scope: ecosystem === 'maven' ? 'compile' : 'dependencies'
    };
  }
});
