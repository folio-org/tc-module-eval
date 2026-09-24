import { AcceptanceLedger, EvaluationStatus, S008Catalog, S008DeclarationResult, S008PolicyLoadResult } from '../types';
import { evaluateS008, renderS008HumanDetails } from '../utils/s008-evaluator';
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
    componentCatalog.eurekaComponents = [{ familyId: 'mgr-tenant-entitlements', moduleIdentities: ['component'] }];
    expect(evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(componentCatalog), declarations('users', '1.0')).status).toBe(EvaluationStatus.PASS);
  });

  it.each([
    ['compatible but unaccepted', 'other', 'users', '1.2', 'users', '1.0', 'unaccepted'],
    ['same-ID incompatible', 'accepted', 'users', '1.0', 'users', '2.0', 'incompatible'],
    ['missing', 'accepted', 'settings', '1.0', 'users', '1.0', 'missing']
  ])('fails %s providers', (_name, identity, providedId, providedVersion, requiredId, requiredVersion, classification) => {
    const result = evaluateS008(kind, 'official', ok(ledger('approved-tcr')), ok(catalog(identity, providedId, providedVersion)), declarations(requiredId, requiredVersion));
    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.summary).toBe('1 declared interface lacks a compatible eligible provider in the official catalog.');
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

  it('applies applicability before invalid policy and reports provenance', () => {
    const failed = { ok: false as const, sourcePath: 'missing', diagnostics: [{ code: 'policy_missing', message: 'missing' }] };
    expect(evaluateS008({ kind: 'library', evidence: [], warnings: [] }, 'official', failed, failed, declarations('x', '1.0')).status).toBe(EvaluationStatus.NOT_APPLICABLE);
    expect(evaluateS008({ kind: 'ambiguous', evidence: [], warnings: [] }, 'official', failed, failed, declarations('x', '1.0')).status).toBe(EvaluationStatus.MANUAL);
    const result = analyze('users', '1.2', 'approved-tcr');
    expect(renderS008HumanDetails(result)).toMatch(/Platform baseline:.*@a{40}/);
    expect(result.ledger?.digest).toContain('sha256:');
  });

  it('retains S008 baseline and digest provenance in JSON and rendered HTML details', () => {
    const analysis = analyze('users', '1.2', 'approved-tcr');
    const criterion = { criterionId: 'S008', status: analysis.status, evidence: analysis.summary, details: renderS008HumanDetails(analysis), criterionDetails: analysis };
    const report = { repositoryUrl: 'https://example.test/mod', moduleName: 'mod', language: 'Java', evaluatedAt: new Date('2026-01-01T00:00:00Z'), criteria: [criterion] };
    const renderer = new EvaluationReportRenderer();
    expect(renderer.renderJson(report)).toContain(`sha256:${'e'.repeat(64)}`);
    expect(renderer.renderJson(report)).toContain('platformCommit');
    expect(renderer.renderHtml(report)).toContain(`Platform baseline: folio-org/platform-lsp@${'a'.repeat(40)}`);
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
