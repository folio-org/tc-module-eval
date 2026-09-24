import {
  AcceptanceLedger,
  EvaluationStatus,
  ModuleKindResult,
  S008AnalysisResult,
  S008Catalog,
  S008CatalogChannel,
  S008DeclarationResult,
  S008Finding,
  S008PolicyLoadResult,
  S008ProviderCandidate
} from '../types';
import { isEurekaInterfaceCompatible } from './eureka-interface-compatibility';

export function evaluateS008(
  moduleKind: ModuleKindResult,
  channel: S008CatalogChannel,
  ledgerLoad: S008PolicyLoadResult<AcceptanceLedger>,
  catalogLoad: S008PolicyLoadResult<S008Catalog>,
  declarations: S008DeclarationResult
): S008AnalysisResult {
  const base = { criterionId: 'S008' as const, moduleKind, channel, declarations, findings: [] as S008Finding[], policyDiagnostics: [] };
  if (moduleKind.kind === 'library') return { ...base, status: EvaluationStatus.NOT_APPLICABLE, summary: 'S008 does not apply to explicit FOLIO library repositories.' };
  if (moduleKind.kind === 'ambiguous') return { ...base, status: EvaluationStatus.MANUAL, summary: 'S008 applicability requires manual review because the repository kind is ambiguous.' };

  if (!ledgerLoad.ok || !catalogLoad.ok) {
    const diagnostics = [...(!ledgerLoad.ok ? ledgerLoad.diagnostics : []), ...(!catalogLoad.ok ? catalogLoad.diagnostics : [])];
    return { ...base, status: EvaluationStatus.MANUAL, summary: 'S008 requires valid authoritative acceptance ledger and interface catalog data.', policyDiagnostics: diagnostics };
  }

  const findings = declarations.declarations.map(declaration => finding(declaration, ledgerLoad.value, catalogLoad.value));
  const failures = findings.filter(item => item.classification !== 'satisfied');
  const status = failures.length ? EvaluationStatus.FAIL : !declarations.complete ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  const summary = failures.length
    ? `${failures.length} declared interface${failures.length === 1 ? ' lacks' : 's lack'} a compatible eligible provider in the ${channel} catalog.`
    : !declarations.complete
      ? 'No proven S008 violation was found, but declaration evidence is incomplete.'
      : `All ${findings.length} declared interface${findings.length === 1 ? '' : 's'} have compatible eligible providers in the ${channel} catalog.`;
  return {
    ...base,
    status,
    summary,
    ledger: { sourcePath: ledgerLoad.sourcePath, digest: ledgerLoad.digest },
    catalog: {
      sourcePath: catalogLoad.sourcePath,
      digest: catalogLoad.digest,
      baseline: catalogLoad.value.baseline,
      applications: catalogLoad.value.applications,
      eurekaComponents: catalogLoad.value.eurekaComponents
    },
    findings
  };
}

function finding(declaration: S008DeclarationResult['declarations'][number], ledger: Readonly<AcceptanceLedger>, catalog: Readonly<S008Catalog>): S008Finding {
  const candidates = catalog.providers.flatMap(provider => provider.provides
    .filter(provided => provided.id === declaration.id)
    .map(provided => candidate(provider, provided, declaration, ledger, catalog)));
  const satisfied = candidates.some(item => item.eligible && item.compatible);
  const classification = satisfied ? 'satisfied'
    : candidates.some(item => item.compatible && !item.eligible) ? 'unaccepted'
      : candidates.length ? 'incompatible' : 'missing';
  return { declaration, classification, candidates: candidates.sort((a, b) => `${a.moduleId}\0${a.version}`.localeCompare(`${b.moduleId}\0${b.version}`)) };
}

function candidate(
  provider: S008Catalog['providers'][number],
  provided: S008Catalog['providers'][number]['provides'][number],
  declaration: S008DeclarationResult['declarations'][number],
  ledger: Readonly<AcceptanceLedger>,
  catalog: Readonly<S008Catalog>
): S008ProviderCandidate {
  const { moduleId, moduleIdentity } = provider;
  const mapping = ledger.moduleIdentities.find(item => item.identity === moduleIdentity);
  const family = mapping && ledger.families.find(item => item.id === mapping.familyId);
  const accepted = Boolean(family && (family.acceptance.kind !== 'exception' || family.acceptance.scope === 'S008' || family.acceptance.scope === 'S008,S009'));
  const component = catalog.eurekaComponents.find(item => item.moduleIdentities.includes(moduleIdentity));
  const eligibility = accepted ? 'accepted-family' : component ? 'eureka-component' : 'unaccepted';
  return {
    moduleId,
    moduleIdentity,
    source: provider.source,
    descriptorHash: provider.descriptorHash,
    version: provided.version,
    interfaceType: provided.interfaceType,
    eligible: eligibility !== 'unaccepted',
    compatible: isEurekaInterfaceCompatible(provided, declaration),
    eligibility,
    familyId: accepted ? mapping!.familyId : component?.familyId
  };
}

export function renderS008HumanDetails(analysis: S008AnalysisResult): string {
  const lines = [analysis.summary, `Catalog channel: ${analysis.channel}`];
  if (analysis.ledger) lines.push(`Acceptance ledger: ${analysis.ledger.sourcePath} (${analysis.ledger.digest})`);
  if (analysis.catalog) {
    lines.push(`Interface catalog: ${analysis.catalog.sourcePath} (${analysis.catalog.digest})`);
    lines.push(`Platform baseline: ${analysis.catalog.baseline.platformRepository}@${analysis.catalog.baseline.platformCommit}`);
    lines.push(`Platform descriptor: ${analysis.catalog.baseline.descriptorVersion} (${analysis.catalog.baseline.descriptorHash})`);
    for (const app of analysis.catalog.applications) {
      lines.push(`Platform application: ${app.optional ? 'optional ' : ''}${app.name}@${app.version} from ${app.farSource} (${app.descriptorHash})`);
    }
    for (const component of analysis.catalog.eurekaComponents) {
      const source = component.descriptorSource.status === 'acquired' && component.descriptorSource.kind === 'repository-tag'
        ? `${component.descriptorSource.repository}@${component.descriptorSource.commit} (${component.descriptorSource.descriptorHash})`
        : component.descriptorSource.status === 'acquired'
          ? `${component.descriptorSource.source} (${component.descriptorSource.descriptorHash})`
        : component.descriptorSource.status;
      lines.push(`Eureka component family: ${component.familyId}@${component.version} [${component.moduleIdentities.join(', ')}]; descriptor=${source}`);
    }
  }
  for (const [sourcePath, digest] of Object.entries(analysis.declarations.fileHashes)) lines.push(`Declaration source: ${sourcePath} (${digest})`);
  if (analysis.findings.length) {
    lines.push('Interface findings:');
    for (const item of analysis.findings) {
      lines.push(`  - ${item.declaration.optional ? 'optional' : 'required'} ${item.declaration.id} ${item.declaration.version}: ${item.classification}`);
      for (const provider of item.candidates) lines.push(`    - ${provider.moduleId} ${provider.version}: ${provider.compatible ? 'compatible' : 'incompatible'}, ${provider.eligibility}${provider.familyId ? ` (${provider.familyId})` : ''}; source=${provider.source}; descriptor=${provider.descriptorHash}`);
    }
  }
  if (analysis.policyDiagnostics.length) lines.push('Policy diagnostics:', ...analysis.policyDiagnostics.map(item => `  - ${item.code}: ${item.message}`));
  if (analysis.declarations.diagnostics.length) lines.push('Declaration diagnostics:', ...analysis.declarations.diagnostics.map(item => `  - ${item.code}: ${item.message}`));
  return lines.join('\n');
}
