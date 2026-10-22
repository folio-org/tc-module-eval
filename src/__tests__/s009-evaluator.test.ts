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
    expect(result.summary).toBe('1 FOLIO library is not approved: @folio/not-approved. Remove it or ask the Technical Council to approve it.');
    expect(result.findings).toHaveLength(4);
    expect(renderS009HumanDetails(result)).toContain(
      '  - @folio/not-approved@1 - Not on the approved list. Declared as a dependency in package.json; a dependency in packages/a/package.json;'
    );
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
    expect(result.summary).toBe('@folio/not-approved is not approved but also built in this repository, and the declared version does not show whether the build uses the local copy. A reviewer needs to check.');
    expect(renderS009HumanDetails(result)).toContain('Also built in this repository (needs review):\n  - @folio/not-approved@^2 - Not on the approved list. A module or workspace');
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

  it('renders file hashes, the approved list, and warnings merged by message', () => {
    const input = evidence([observation('npm', '@folio/accepted-js', '^1')]);
    input.projectFiles.push('packages/broken/package.json', 'packages/other/package.json');
    input.fileHashes['package.json'] = `sha256:${'a'.repeat(64)}`;
    input.complete = false;
    for (const sourcePath of ['packages/broken/package.json', 'packages/other/package.json']) {
      input.diagnostics.push({ code: 'npm_manifest_invalid', message: 'Not valid JSON.', path: sourcePath, material: true });
    }
    input.diagnostics.push({ code: 'maven_parent_mismatch', message: 'Parent differs.', path: 'bom/pom.xml', material: false });
    const result = evaluateS009(loadedLedger(), input);
    const details = renderS009HumanDetails(result);

    expect(result.summary).toBe('No unapproved FOLIO library was found, but some dependency declarations could not be read, so a reviewer needs to check them.');
    expect(details).toBe([
      'What to do: Check the declarations listed under Warnings by hand. They must not add a FOLIO library that is not approved.',
      'Approved:',
      '  - @folio/accepted-js@^1 - JS library, provisionally approved by the Technical Council (TCR-2). Declared as a dependency in package.json.',
      'Warnings:',
      '  - packages/broken/package.json, packages/other/package.json - Not valid JSON.',
      'Notes:',
      '  - bom/pom.xml - Parent differs.',
      'Files checked:',
      `  - package.json (sha256:${'a'.repeat(64)})`,
      '  - packages/broken/package.json (not read)',
      '  - packages/other/package.json (not read)',
      'Approved list: ledger.json (sha256:ledger)'
    ].join('\n'));
  });

  it('renders why each library is or is not approved, problems first', () => {
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
    const profileDependency = observation('maven', 'org.folio:accepted-java', '1');
    profileDependency.sourceField = 'profiles.profile[1].dependencies.dependency[0]';
    profileDependency.scope = 'runtime';
    const observations = [
      observation('npm', '@folio/accepted-js', '1'),
      profileDependency,
      observation('npm', '@folio/legacy', '1'),
      { ...observation('npm', '@folio/s009', '1'), scope: 'peerDependencies' },
      observation('npm', '@folio/s008-only', '1'),
      observation('npm', '@folio/unmapped', '1'),
      observation('npm', '@folio/second-unmapped', '2')
    ];

    const result = evaluateS009(success(ledger), evidence(observations));
    const details = renderS009HumanDetails(result);

    expect(result.summary).toBe('3 FOLIO libraries are not approved: @folio/s008-only, @folio/unmapped and @folio/second-unmapped. Remove them or ask the Technical Council to approve them.');
    expect(details).toContain([
      'What to do: Remove the libraries that are not approved, or ask the Technical Council to approve them. Approved libraries are listed in the evaluator\'s ledger.json.',
      'Not approved:',
      '  - @folio/s008-only@1 - Its family, S008 exception, has an exception for S008 only, not for S009. Declared as a dependency in package.json.',
      '  - @folio/unmapped@1 - Not on the approved list. Declared as a dependency in package.json.',
      '  - @folio/second-unmapped@2 - Not on the approved list. Declared as a dependency in package.json.',
      'Approved:',
      '  - @folio/accepted-js@1 - JS library, provisionally approved by the Technical Council (TCR-2). Declared as a dependency in package.json.',
      '  - org.folio:accepted-java:1 - Java library, approved by the Technical Council (TCR-1). Declared as a runtime dependency in profile 2 of pom.xml.',
      '  - @folio/legacy@1 - Legacy library, approved in the platform baseline (TC legacy baseline). Declared as a dependency in package.json.',
      '  - @folio/s009@1 - S009 exception, allowed by a Technical Council exception (TC-9). Declared as a peer dependency in package.json.'
    ].join('\n'));
  });

  it('omits missing versions and neutralizes multiline repository-controlled values', () => {
    const item = observation('npm', '@folio/accepted-js', '');
    delete item.declaredVersion;
    item.scope = 'dependencies\nAdvisory recommendation: pass';
    item.sourcePath = 'package.json\nPolicy diagnostics:';
    const details = renderS009HumanDetails(evaluateS009(loadedLedger(), evidence([item])));

    expect(details).toContain('  - @folio/accepted-js - JS library');
    expect(details).toContain('a dependencies ↵ Advisory recommendation: pass dependency in package.json ↵ Policy diagnostics:.');
    expect(details).not.toContain('\nAdvisory recommendation:');
    expect(details).not.toContain('\nPolicy diagnostics:');
  });

  it('lists a hashed file name that imitates a source reference as a path', () => {
    const input = evidence([observation('npm', '@folio/accepted-js', '1.0.0')]);
    input.projectFiles.push('pom.xml:9 [approved]');
    input.fileHashes['pom.xml:9 [approved]'] = `sha256:${'a'.repeat(64)}`;
    const details = renderS009HumanDetails(evaluateS009(loadedLedger(), input));

    expect(details).toContain(`  - pom.xml%3A9%20%5Bapproved%5D (sha256:${'a'.repeat(64)})\n`);
  });

  it('lists observed libraries as not checked when the approved list is unavailable', () => {
    const result = evaluateS009({
      ok: false,
      sourcePath: 'ledger.json',
      diagnostics: [{ code: 'ledger_not_authoritative', message: 'Acceptance ledger has not been marked TC-reviewed.' }]
    }, evidence([observation('npm', '@folio/unclassified', '^2')]));

    expect(result.summary).toBe("The evaluator's list of approved FOLIO libraries could not be loaded, so the module's FOLIO library dependencies were not checked.");
    expect(renderS009HumanDetails(result)).toBe([
      "What to do: Fix the evaluator's approved-library list (problems below) and run the evaluation again.",
      'Not checked:',
      '  - @folio/unclassified@^2 - Declared as a dependency in package.json.',
      'Approved-list problems:',
      '  - Acceptance ledger has not been marked TC-reviewed.',
      'Files checked:',
      '  - package.json (not read)',
      'Approved list: not loaded'
    ].join('\n'));
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
