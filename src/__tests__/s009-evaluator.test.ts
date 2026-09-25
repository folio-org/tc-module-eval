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
    const details = renderS009HumanDetails(evaluateS009(loadedLedger(), input));
    expect(details).toContain('sha256:ledger');
    expect(details).toContain('package.json');
    expect(details).toContain('@folio/accepted-js');
  });

  it('retains observed coordinates in human details when policy is unavailable', () => {
    const result = evaluateS009({
      ok: false,
      sourcePath: 'ledger.json',
      diagnostics: [{ code: 'ledger_not_authoritative', message: 'Not reviewed' }]
    }, evidence([observation('npm', '@folio/unclassified', '^2')]));

    expect(renderS009HumanDetails(result)).toContain('@folio/unclassified ^2');
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
