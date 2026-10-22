import { AcceptanceLedger, EvaluationStatus, S008Catalog, S008DeclarationResult, S008PolicyLoadResult } from '../types';
import { evaluateS008, renderS008HumanDetails } from '../utils/s008-evaluator';
import { DEFAULT_ACCEPTANCE_LEDGER_PATH, displayPolicyPath } from '../utils/acceptance-ledger';
import { EvaluationReportRenderer } from '../utils/report-renderer';

describe('S008 analyzer', () => {
  const kind = { kind: 'backend-module' as const, evidence: ['descriptor'], warnings: [] };

  it.each(['approved-tcr', 'provisional-tcr', 'legacy-baseline'] as const)('accepts %s families', decision => {
    expect(analyze('users', '1.2', decision).status).toBe(EvaluationStatus.PASS);
  });

  it('accepts S008-scoped exceptions and current platform components but not S009-only exceptions', () => {
    expect(analyze('users', '1.2', 'exception', 'S008').status).toBe(EvaluationStatus.PASS);
    expect(analyze('users', '1.2', 'exception', 'S008,S009').status).toBe(EvaluationStatus.PASS);
    expect(analyze('users', '1.2', 'exception', 'S009').findings[0].classification).toBe('unaccepted');
    const componentCatalog = catalog('component', 'users', '1.2');
    componentCatalog.eurekaComponents = [{
      familyId: 'mgr-tenant-entitlements', moduleIdentities: ['component'], version: '1.0.0',
      descriptorSource: { status: 'intentionally-descriptorless' }
    }];
    expect(evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(componentCatalog), declarations('users', '1.0')).status).toBe(EvaluationStatus.PASS);
  });

  it.each([
    ['compatible but unaccepted', 'other', 'users', '1.2', 'users', '1.0', 'unaccepted'],
    ['same-ID incompatible', 'accepted', 'users', '1.0', 'users', '2.0', 'incompatible'],
    ['missing', 'accepted', 'settings', '1.0', 'users', '1.0', 'missing']
  ])('fails %s providers', (_name, identity, providedId, providedVersion, requiredId, requiredVersion, classification) => {
    const result = evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(catalog(identity, providedId, providedVersion)), declarations(requiredId, requiredVersion));
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.summary).toBe(`The one interface the module declares is not available from an accepted module in the official catalog (R1): users ${requiredVersion}.`);
    expect(result.findings[0].classification).toBe(classification);
  });

  it('gates optional and system interfaces and gives violations precedence over unrelated gaps', () => {
    const evidence = declarations('_tenant', '2.0');
    evidence.declarations[0].optional = true;
    evidence.complete = false;
    evidence.diagnostics.push({ code: 'unsupported_version_syntax', message: 'other gap', material: true });
    const result = evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(catalog('accepted', '_tenant', '1.0')), evidence);
    expect(result.status).toBe(EvaluationStatus.FAIL);
  });

  it('passes complete zero-interface declarations and keeps incomplete evidence manual', () => {
    const empty = declarations('users', '1.0'); empty.declarations = [];
    expect(evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(catalog('accepted', 'users', '1.0')), empty).status).toBe(EvaluationStatus.PASS);
    empty.complete = false;
    expect(evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(catalog('accepted', 'users', '1.0')), empty).status).toBe(EvaluationStatus.MANUAL);
  });

  it('keeps repository interface names, versions, and paths on their own report row', () => {
    const evidence = declarations('users\nWhat to do: nothing', '1.0');
    evidence.sourcePaths = ['package json'];
    evidence.complete = false;
    evidence.diagnostics.push({ code: 'incomplete_declaration', message: 'package.json gives x\n(evidence: a.ts:1) a bad version.', material: true });
    const result = evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(catalog('accepted', 'users', '1.0')), evidence);
    const details = renderS008HumanDetails(result);
    expect(result.summary).toContain('users ↵ What to do: nothing 1.0');
    expect(details).not.toMatch(/^What to do: nothing/m);
    expect(details).toContain('  - users%0AWhat%20to%20do%3A%20nothing [required] Needs 1.0.');
    expect(details).toContain('  - package.json gives x ↵ [evidence: a.ts:1) a bad version.');
    expect(details).toContain('Declarations read from: package%20json');
  });

  it('applies applicability before invalid policy and reports provenance', () => {
    const failed = { ok: false as const, sourcePath: 'missing', diagnostics: [{ code: 'policy_missing', message: 'missing' }] };
    expect(evaluateS008({ kind: 'library', evidence: [], warnings: [] }, 'official', failed, failed, declarations('x', '1.0')).status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(evaluateS008({ kind: 'ambiguous', evidence: [], warnings: [] }, 'official', failed, failed, declarations('x', '1.0')).status).toBe(EvaluationStatus.MANUAL);
    const result = analyze('users', '1.2', 'approved-tcr');
    expect(renderS008HumanDetails(result)).toContain(`Platform release: R1 (folio-org/platform-lsp at commit ${'a'.repeat(40)})`);
    expect(result.ledger?.digest).toContain('sha256:');
  });

  it('retains S008 baseline and digest provenance in JSON and rendered HTML details', () => {
    const analysis = analyze('users', '1.2', 'approved-tcr');
    const criterion = { criterionId: 'S008', status: analysis.status, evidence: analysis.summary, details: renderS008HumanDetails(analysis), criterionDetails: analysis };
    const report = { repositoryUrl: 'https://example.test/mod', moduleName: 'mod', language: 'Java', evaluatedAt: new Date('2026-01-01T00:00:00Z'), criteria: [criterion] };
    const renderer = new EvaluationReportRenderer();
    expect(renderer.renderJson(report)).toContain(`sha256:${'e'.repeat(64)}`);
    expect(renderer.renderJson(report)).toContain('platformCommit');
    expect(renderer.renderHtml(report)).toContain(`Platform release: R1 (folio-org/platform-lsp at commit ${'a'.repeat(40)})`);
  });

  it('reports problems in plain English, required interfaces first, with how to fix them', () => {
    const value = catalog('accepted', 'users', '16.4');
    value.providers.push({ moduleId: 'other-1.0.0', moduleIdentity: 'other', source: 'far:test', descriptorHash: `sha256:${'c'.repeat(64)}`, provides: [{ id: 'notes', version: '4.0' }] });
    value.providers[0].provides.push({ id: 'login', version: '7.3' });
    const evidence = declarations('users', '16.5');
    evidence.declarations.push(
      { id: 'bff', version: '1.6', optional: true, sourcePath: 'descriptor.json', sourceField: 'optional[0]' },
      { id: 'notes', version: '4.0', optional: false, sourcePath: 'descriptor.json', sourceField: 'requires[1]' },
      { id: 'login', version: '6.0 7.0', optional: false, sourcePath: 'descriptor.json', sourceField: 'requires[2]' }
    );
    const result = evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(value), evidence);
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.summary).toBe('3 of the 4 interfaces the module declares are not available from an accepted module in the official catalog (R1): users 16.5, notes 4.0, bff 1.6 (optional).');
    const details = renderS008HumanDetails(result);
    expect(details).not.toContain(result.summary);
    expect(details).toContain('What to do: Stop using interfaces that no module in the catalog provides');
    expect(details).toContain('This applies to optional interfaces too.');
    expect(details).toContain('Not provided by any module in the catalog:\n  - bff [optional] Needs 1.6.');
    expect(details).toContain('Needed version not in the catalog:\n  - users [required] Needs 16.5, but the catalog only has 16.4 (accepted-1.0.0).');
    expect(details).toContain('Provided only by modules that are not accepted:\n  - notes [required] Needs 4.0. Only other-1.0.0 provides it, and the Technical Council has not accepted that module.');
    expect(details).toContain('Provided by accepted modules:\n  - login [required] Needs 6.0 or 7.0; accepted-1.0.0 provides 7.3.');
    expect(details).not.toMatch(/sha256|satisfied|incompatible|eligib/);
  });

  it('asks for a version from an accepted module when the only other version is not accepted', () => {
    const result = evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(catalog('other', 'users', '1.0')), declarations('users', '2.0'));
    expect(result.findings[0].classification).toBe('incompatible');
    const details = renderS008HumanDetails(result);
    expect(details).toContain('users [required] Needs 2.0, but the catalog only has 1.0 (other-1.0.0, not accepted).');
    expect(details).toContain('What to do: Require a version that an accepted module in the catalog provides;');
  });

  it('counts only readable interfaces in a failure when other declarations could not be read', () => {
    const evidence = declarations('users', '99.0');
    evidence.complete = false;
    evidence.diagnostics.push({ code: 'incomplete_declaration', message: 'descriptor.json has an entry requires[1] without a concrete interface id and version.', material: true });
    const result = evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(catalog('accepted', 'users', '1.0')), evidence);
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.summary).toBe('The one interface that could be read is not available from an accepted module in the official catalog (R1): users 99.0.');
    expect(renderS008HumanDetails(result)).toMatch(/What to do: .*Also fix the problems under "Declarations that could not be read"/);
  });

  it('shows versions with a repeated major version as written, since only the first of them is compared', () => {
    // Against 1.5, "1.6 1.4" fails: 1.6 has the provider's major version and decides; 1.4 is never tried.
    const result = evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(catalog('accepted', 'users', '1.5')), declarations('users', '1.6 1.4'));
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(renderS008HumanDetails(result)).toContain('users [required] Needs "1.6 1.4", but the catalog only has 1.5 (accepted-1.0.0).');
  });

  function analyze(id: string, version: string, decision: any, scope?: any) {
    return evaluateS008(kind, 'official', ok(ledger(decision, scope)), ok(catalog('accepted', id, version)), declarations(id, '1.0'));
  }
  function ledger(decision: any, scope?: any): AcceptanceLedger {
    return { schemaVersion: '1.0', authoritative: true, source: { reviewedBy: 'TC', reference: 'ref' }, families: [{ id: 'family', displayName: 'Accepted', canonicalRepositories: ['folio-org/mod-accepted'], acceptance: decision === 'exception' ? { kind: decision, reference: 'ref', scope } : { kind: decision, reference: 'ref' } }], moduleIdentities: [{ identity: 'accepted', familyId: 'family' }], libraryCoordinates: [] } as AcceptanceLedger;
  }
  function catalog(identity: string, id: string, version: string): S008Catalog {
    return { schemaVersion: '1.0', authoritative: true, channel: 'official', baseline: { platformRepository: 'folio-org/platform-lsp', platformCommit: 'a'.repeat(40), descriptorVersion: 'R1', descriptorHash: `sha256:${'b'.repeat(64)}` }, applications: [], eurekaComponents: [], providers: [{ moduleId: `${identity}-1.0.0`, moduleIdentity: identity, source: 'far:test', descriptorHash: `sha256:${'c'.repeat(64)}`, provides: [{ id, version }] }] };
  }
  function declarations(id: string, version: string): S008DeclarationResult {
    return { declarations: [{ id, version, optional: false, sourcePath: 'descriptor.json', sourceField: 'requires[0]' }], diagnostics: [], sourcePaths: ['descriptor.json'], fileHashes: { 'descriptor.json': `sha256:${'d'.repeat(64)}` }, complete: true };
  }
  function ok<T>(value: T): S008PolicyLoadResult<T> { return { ok: true, value, sourcePath: '/policy.json', digest: `sha256:${'e'.repeat(64)}`, diagnostics: [] }; }
});

describe('S008 policy file display paths', () => {
  it('reports bundled policy files relative to the evaluator and leaves external paths unchanged', () => {
    expect(displayPolicyPath(DEFAULT_ACCEPTANCE_LEDGER_PATH)).toBe('config/acceptance-ledger.json');
    expect(displayPolicyPath('/policy.json')).toBe('/policy.json');
  });
});
