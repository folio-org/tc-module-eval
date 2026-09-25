import {
  AcceptanceLedger,
  EvaluationStatus,
  S008PolicyLoadResult,
  S009AnalysisResult,
  S009DependencyEvidence,
  S009Finding
} from '../types';

export function evaluateS009(
  ledgerLoad: S008PolicyLoadResult<AcceptanceLedger>,
  evidence: S009DependencyEvidence
): S009AnalysisResult {
  const base = {
    criterionId: 'S009' as const,
    evidence,
    findings: [] as S009Finding[],
    policyDiagnostics: []
  };

  if (!evidence.hasDependencyProject) {
    return {
      ...base,
      status: EvaluationStatus.NOT_APPLICABLE,
      summary: 'S009 does not apply because no Maven, Gradle, npm, or Yarn dependency project was found.'
    };
  }

  if (!ledgerLoad.ok) {
    return {
      ...base,
      status: EvaluationStatus.MANUAL,
      summary: 'S009 requires a valid authoritative acceptance ledger.',
      policyDiagnostics: ledgerLoad.diagnostics
    };
  }

  const findings = evidence.observations.map(observation => finding(observation, ledgerLoad.value));
  const failures = findings.filter(item => item.classification === 'unaccepted');
  const status = failures.length
    ? EvaluationStatus.FAIL
    : evidence.complete
      ? EvaluationStatus.PASS
      : EvaluationStatus.MANUAL;
  const summary = failures.length
    ? `${failures.length} FOLIO library coordinate${failures.length === 1 ? '' : 's'} are not mapped to a family accepted for S009.`
    : !evidence.complete
      ? 'No proven S009 violation was found, but dependency evidence is incomplete.'
      : findings.length
        ? `All ${findings.length} declared FOLIO library coordinate${findings.length === 1 ? '' : 's'} are mapped to families accepted for S009.`
        : 'No direct production dependencies in the FOLIO package namespaces were found.';

  return {
    ...base,
    status,
    summary,
    ledger: { sourcePath: ledgerLoad.sourcePath, digest: ledgerLoad.digest },
    findings
  };
}

function finding(
  observation: S009DependencyEvidence['observations'][number],
  ledger: Readonly<AcceptanceLedger>
): S009Finding {
  const mapping = ledger.libraryCoordinates.find(item => coordinate(item) === `${observation.ecosystem}:${observation.coordinate}`);
  const family = mapping && ledger.families.find(item => item.id === mapping.familyId);
  const accepted = Boolean(family && (
    family.acceptance.kind !== 'exception'
    || family.acceptance.scope === 'S009'
    || family.acceptance.scope === 'S008,S009'
  ));

  return {
    observation,
    classification: accepted ? 'accepted' : 'unaccepted',
    familyId: family?.id,
    familyDisplayName: family?.displayName,
    acceptance: family?.acceptance
  };
}

function coordinate(value: AcceptanceLedger['libraryCoordinates'][number]): string {
  return value.ecosystem === 'maven'
    ? `maven:${value.groupId}:${value.artifactId}`
    : `npm:${value.packageName}`;
}

export function renderS009HumanDetails(analysis: S009AnalysisResult): string {
  const lines = [analysis.summary];
  if (analysis.ledger) lines.push(`Acceptance ledger: ${analysis.ledger.sourcePath} (${analysis.ledger.digest})`);
  for (const [sourcePath, digest] of Object.entries(analysis.evidence.fileHashes)) {
    lines.push(`Dependency source: ${sourcePath} (${digest})`);
  }
  if (analysis.findings.length) {
    lines.push('Library findings:');
    for (const item of analysis.findings) {
      const version = item.observation.declaredVersion ? ` ${item.observation.declaredVersion}` : '';
      const family = item.familyId ? `; family=${item.familyId}${item.familyDisplayName ? ` (${item.familyDisplayName})` : ''}` : '';
      const acceptance = item.acceptance ? `; acceptance=${item.acceptance.kind} (${item.acceptance.reference})` : '';
      lines.push(
        `  - ${item.observation.coordinate}${version}: ${item.classification}${family}${acceptance}; `
        + `source=${item.observation.sourcePath}#${item.observation.sourceField}; scope=${item.observation.scope}`
      );
    }
  } else if (analysis.evidence.observations.length) {
    lines.push('Observed FOLIO library coordinates (not classified because policy is unavailable):');
    for (const observation of analysis.evidence.observations) {
      const version = observation.declaredVersion ? ` ${observation.declaredVersion}` : '';
      lines.push(`  - ${observation.coordinate}${version}; source=${observation.sourcePath}#${observation.sourceField}; scope=${observation.scope}`);
    }
  }
  if (analysis.policyDiagnostics.length) {
    lines.push('Policy diagnostics:', ...analysis.policyDiagnostics.map(item => `  - ${item.code}: ${item.message}`));
  }
  if (analysis.evidence.diagnostics.length) {
    lines.push('Dependency diagnostics:', ...analysis.evidence.diagnostics.map(item => `  - ${item.code}: ${item.message}`));
  }
  return lines.join('\n');
}
