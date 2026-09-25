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
  const indeterminate = findings.filter(item => item.classification === 'indeterminate-locality');
  const failureCount = distinctCoordinates(failures.map(item => item.observation)).size;
  const indeterminateCount = distinctCoordinates(indeterminate.map(item => item.observation)).size;
  const coordinateCount = distinctCoordinates(evidence.observations).size;
  const status = failures.length
    ? EvaluationStatus.FAIL
    : indeterminate.length || !evidence.complete
      ? EvaluationStatus.MANUAL
      : EvaluationStatus.PASS;
  const summary = failureCount
    ? `${failureCount} FOLIO library coordinate${failureCount === 1 ? ' is' : 's are'} not mapped to a family accepted for S009.`
    : indeterminateCount
      ? `${indeterminateCount} FOLIO library coordinate${indeterminateCount === 1 ? ' requires' : 's require'} review because same-repository resolution could not be established.`
    : !evidence.complete
      ? 'No proven S009 violation was found, but dependency evidence is incomplete.'
      : coordinateCount
        ? `All ${coordinateCount} declared FOLIO library coordinate${coordinateCount === 1 ? ' is' : 's are'} mapped to families accepted for S009.`
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
    classification: accepted
      ? 'accepted'
      : observation.locality === 'ambiguous'
        ? 'indeterminate-locality'
        : 'unaccepted',
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

function distinctCoordinates(observations: S009DependencyEvidence['observations']): Set<string> {
  return new Set(observations.map(item => `${item.ecosystem}\0${item.coordinate}`));
}

export function renderS009HumanDetails(analysis: S009AnalysisResult): string {
  const lines = [
    'Evidence coverage:',
    `  - Dependency project: ${analysis.evidence.hasDependencyProject ? 'Found' : 'Not found'}`,
    `  - Evidence completeness: ${analysis.evidence.complete ? 'Complete' : 'Incomplete'}`,
    `  - FOLIO coordinates observed: ${distinctCoordinates(analysis.evidence.observations).size}`
  ];
  const ambiguousCoordinates = distinctCoordinates(
    analysis.evidence.observations.filter(item => item.locality === 'ambiguous')
  ).size;
  if (ambiguousCoordinates) lines.push(`  - Local resolution ambiguities: ${ambiguousCoordinates}`);

  if (analysis.evidence.projectFiles.length) {
    lines.push('  - Project files:');
    for (const projectFile of analysis.evidence.projectFiles) lines.push(`    - ${inline(projectFile)}`);
  } else {
    lines.push('  - Project files: None found');
  }

  if (analysis.findings.length) {
    lines.push('Library findings:');
    const priority = { unaccepted: 0, 'indeterminate-locality': 1, accepted: 2 };
    const orderedFindings = [...analysis.findings].sort((left, right) => priority[left.classification] - priority[right.classification]);
    for (const item of orderedFindings) appendFinding(lines, item);
  } else if (analysis.evidence.observations.length) {
    lines.push('Library findings:');
    for (const observation of analysis.evidence.observations) {
      lines.push(
        `  - ${inline(observation.coordinate)}:`,
        '    - Classification: Not evaluated because the acceptance ledger is unavailable'
      );
      appendObservation(lines, observation);
    }
  } else {
    lines.push('Library findings: None');
  }

  if (analysis.policyDiagnostics.length) {
    lines.push('Policy diagnostics:');
    for (const diagnostic of analysis.policyDiagnostics) {
      lines.push(`  - ${inline(diagnostic.code)}:`, `    - Message: ${inline(diagnostic.message)}`);
      if (diagnostic.path) lines.push(`    - Diagnostic path: ${inline(diagnostic.path)}`);
    }
  }
  if (analysis.evidence.diagnostics.length) {
    lines.push('Dependency diagnostics:');
    for (const diagnostic of analysis.evidence.diagnostics) {
      lines.push(
        `  - ${inline(diagnostic.code)}:`,
        `    - Message: ${inline(diagnostic.message)}`,
        `    - Material to coverage: ${diagnostic.material ? 'Yes' : 'No'}`
      );
      if (diagnostic.path) lines.push(`    - Diagnostic path: ${inline(diagnostic.path)}`);
    }
  }

  lines.push('Provenance:');
  if (analysis.ledger) {
    lines.push(
      `  - Acceptance ledger: ${fileName(analysis.ledger.sourcePath)}`,
      `    - Full path: ${inline(analysis.ledger.sourcePath)}`,
      `    - SHA-256 digest: ${inline(analysis.ledger.digest)}`
    );
  } else {
    lines.push('  - Acceptance ledger: Unavailable');
  }
  const sourceHashes = Object.entries(analysis.evidence.fileHashes);
  if (sourceHashes.length) {
    lines.push('  - Source hashes:');
    for (const [sourcePath, digest] of sourceHashes) {
      lines.push(`    - ${inline(sourcePath)}:`, `      - SHA-256 digest: ${inline(digest)}`);
    }
  } else {
    lines.push('  - Source hashes: None recorded');
  }
  return lines.join('\n');
}

function appendFinding(lines: string[], item: S009Finding): void {
  const classifications = {
    accepted: 'Accepted for S009',
    unaccepted: 'Not accepted for S009',
    'indeterminate-locality': 'Manual review: local resolution is ambiguous'
  };
  lines.push(
    `  - ${inline(item.observation.coordinate)}:`,
    `    - Classification: ${classifications[item.classification]}`
  );
  if (item.familyId) {
    const displayName = item.familyDisplayName ? ` (${inline(item.familyDisplayName)})` : '';
    lines.push(`    - Family: ${inline(item.familyId)}${displayName}`);
  } else {
    lines.push('    - Family: No exact ledger mapping');
  }
  if (item.acceptance) {
    lines.push(
      `    - Acceptance: ${acceptanceLabel(item.acceptance.kind)}`,
      `    - Decision reference: ${inline(item.acceptance.reference)}`
    );
    if (item.acceptance.kind === 'exception') lines.push(`    - Exception scope: ${item.acceptance.scope}`);
  } else {
    lines.push('    - Acceptance: None');
  }
  if (item.classification === 'unaccepted') {
    lines.push(`    - Rejection reason: ${item.acceptance?.kind === 'exception' && item.acceptance.scope === 'S008'
      ? "This family's exception applies to S008 only, not S009."
      : 'This exact coordinate is not listed in the authoritative acceptance ledger.'}`);
  } else if (item.classification === 'indeterminate-locality') {
    lines.push('    - Review reason: The dependency matches a package produced in this repository, but static evidence cannot prove that the local package is used.');
  }
  appendObservation(lines, item.observation);
}

function appendObservation(lines: string[], observation: S009DependencyEvidence['observations'][number]): void {
  lines.push(
    '    - Evidence:',
    `      - Ecosystem: ${observation.ecosystem === 'maven' ? 'Maven' : 'npm'}`,
    `      - Declared version: ${observation.declaredVersion ? inline(observation.declaredVersion) : 'Not declared'}`,
    `      - Scope: ${scopeLabel(observation.scope)}`,
    `      - Source file: ${inline(observation.sourcePath)}`,
    `      - Declaration field: ${inline(observation.sourceField)}`
  );
}

function acceptanceLabel(kind: NonNullable<S009Finding['acceptance']>['kind']): string {
  return {
    'approved-tcr': 'Approved TCR',
    'provisional-tcr': 'Provisional TCR',
    'legacy-baseline': 'Legacy baseline',
    exception: 'Exception'
  }[kind];
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    compile: 'Production dependency',
    runtime: 'Production runtime dependency',
    dependencies: 'Production dependency',
    optionalDependencies: 'Optional production dependency',
    peerDependencies: 'Peer dependency'
  };
  return labels[scope] || inline(scope);
}

function fileName(sourcePath: string): string {
  return inline(sourcePath).split(/[\\/]/).pop() || inline(sourcePath);
}

function inline(value: string): string {
  return value.replace(/\r\n?|\n/g, ' ↵ ');
}
