import {
  AcceptanceLedger,
  EvaluationStatus,
  S008PolicyLoadResult,
  S009AnalysisResult,
  S009DependencyEvidence,
  S009Finding
} from '../types';
import { displayPolicyPath, libraryCoordinateKey } from './acceptance-ledger';
import { reportPath, reportText } from './report-text';

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
      summary: 'No Maven, Gradle, npm, or Yarn project was found, so there are no library dependencies to check.'
    };
  }

  if (!ledgerLoad.ok) {
    return {
      ...base,
      status: EvaluationStatus.MANUAL,
      summary: "The evaluator's list of approved FOLIO libraries could not be loaded, so the module's FOLIO library dependencies were not checked.",
      policyDiagnostics: ledgerLoad.diagnostics
    };
  }

  const findings = evidence.observations.map(observation => finding(observation, ledgerLoad.value));
  const failures = findings.filter(item => item.classification === 'unaccepted');
  const indeterminate = findings.filter(item => item.classification === 'indeterminate-locality');
  const status = failures.length
    ? EvaluationStatus.FAIL
    : indeterminate.length || !evidence.complete
      ? EvaluationStatus.MANUAL
      : EvaluationStatus.PASS;

  return {
    ...base,
    status,
    summary: summarize(evidence, failures, indeterminate),
    ledger: { sourcePath: displayPolicyPath(ledgerLoad.sourcePath), digest: ledgerLoad.digest },
    findings
  };
}

function summarize(evidence: S009DependencyEvidence, failures: S009Finding[], indeterminate: S009Finding[]): string {
  const failureNames = distinctCoordinateNames(failures.map(item => item.observation));
  if (failureNames.length) {
    return `${countLibraries(failureNames.length)} ${failureNames.length === 1 ? 'is' : 'are'} not approved: ${nameList(failureNames)}. `
      + `Remove ${failureNames.length === 1 ? 'it' : 'them'} or ask the Technical Council to approve ${failureNames.length === 1 ? 'it' : 'them'}.`;
  }
  const indeterminateNames = distinctCoordinateNames(indeterminate.map(item => item.observation));
  if (indeterminateNames.length) {
    return `${nameList(indeterminateNames)} ${indeterminateNames.length === 1 ? 'is' : 'are'} not approved but also built in this repository, `
      + 'and the declared version does not show whether the build uses the local copy. A reviewer needs to check.';
  }
  if (!evidence.complete) {
    return 'No unapproved FOLIO library was found, but some dependency declarations could not be read, so a reviewer needs to check them.';
  }
  const coordinateCount = distinctCoordinates(evidence.observations).size;
  if (coordinateCount) {
    return coordinateCount === 1
      ? 'The module declares 1 FOLIO library as a production dependency, and it is approved.'
      : `The module declares ${coordinateCount} FOLIO libraries as production dependencies, and all are approved.`;
  }
  return 'The module declares no FOLIO library (org.folio, org.folio.*, or @folio package) as a production dependency.';
}

function finding(
  observation: S009DependencyEvidence['observations'][number],
  ledger: Readonly<AcceptanceLedger>
): S009Finding {
  const mapping = ledger.libraryCoordinates.find(item => libraryCoordinateKey(item) === `${observation.ecosystem}:${observation.coordinate}`);
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

function distinctCoordinates(observations: S009DependencyEvidence['observations']): Set<string> {
  return new Set(observations.map(item => `${item.ecosystem}\0${item.coordinate}`));
}

function distinctCoordinateNames(observations: S009DependencyEvidence['observations']): string[] {
  return [...new Map(observations.map(item => [`${item.ecosystem}\0${item.coordinate}`, reportText(item.coordinate)])).values()];
}

function countLibraries(count: number): string {
  return `${count} FOLIO ${count === 1 ? 'library' : 'libraries'}`;
}

function nameList(names: string[], max = 3): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? '';
}

const DECLARATION_KINDS: Record<string, string> = {
  compile: 'dependency',
  runtime: 'runtime dependency',
  provided: 'provided dependency',
  dependencies: 'dependency',
  optionalDependencies: 'optional dependency',
  peerDependencies: 'peer dependency',
  bundledDependencies: 'bundled dependency',
  bundleDependencies: 'bundled dependency'
};
const MAX_WARNING_PATHS = 5;

export function renderS009HumanDetails(analysis: S009AnalysisResult): string {
  if (!analysis.evidence.hasDependencyProject) return 'Project files: none found (pom.xml, build.gradle, build.gradle.kts, or package.json)';
  const lines: string[] = [];
  const ledgerPath = analysis.ledger?.sourcePath ?? 'config/acceptance-ledger.json';
  const has = (classification: S009Finding['classification']) => analysis.findings.some(item => item.classification === classification);
  const incomplete = !analysis.evidence.complete;

  if (analysis.policyDiagnostics.length || (analysis.status === EvaluationStatus.MANUAL && !analysis.ledger)) {
    lines.push("What to do: Fix the evaluator's approved-library list (problems below) and run the evaluation again.");
  } else if (has('unaccepted')) {
    lines.push(`What to do: Remove the libraries that are not approved, or ask the Technical Council to approve them. Approved libraries are listed in the evaluator's ${ledgerPath}.${incomplete ? ' Also check the declarations listed under Warnings.' : ''}`);
  } else if (has('indeterminate-locality')) {
    lines.push('What to do: Check that the build uses the copy built in this repository. To let the evaluator see this, declare a Maven module with the version of this build (for example ${project.version}), or an npm workspace with a workspace: or file: reference or a range its version satisfies.');
  } else if (incomplete) {
    lines.push('What to do: Check the declarations listed under Warnings by hand. They must not add a FOLIO library that is not approved.');
  }

  if (analysis.findings.length) {
    appendFindingSection(lines, 'Not approved:', analysis.findings.filter(item => item.classification === 'unaccepted'));
    appendFindingSection(lines, 'Also built in this repository (needs review):', analysis.findings.filter(item => item.classification === 'indeterminate-locality'));
    appendFindingSection(lines, 'Approved:', analysis.findings.filter(item => item.classification === 'accepted'));
  } else if (analysis.evidence.observations.length) {
    appendFindingSection(lines, 'Not checked:', analysis.evidence.observations.map(observation => ({ observation, classification: 'unaccepted' })), true);
  }

  if (analysis.policyDiagnostics.length) {
    lines.push('Approved-list problems:');
    for (const diagnostic of analysis.policyDiagnostics) lines.push(`  - ${reportText(diagnostic.message)}`);
  }
  appendDiagnostics(lines, 'Warnings:', analysis.evidence.diagnostics.filter(item => item.material));
  appendDiagnostics(lines, 'Notes:', analysis.evidence.diagnostics.filter(item => !item.material));

  if (analysis.evidence.projectFiles.length) {
    lines.push('Files checked:');
    for (const projectFile of analysis.evidence.projectFiles) {
      const digest = analysis.evidence.fileHashes[projectFile];
      lines.push(`  - ${reportPath(projectFile)} (${digest ? reportText(digest) : 'not read'})`);
    }
  }
  lines.push(analysis.ledger
    ? `Approved list: ${reportText(analysis.ledger.sourcePath)} (${reportText(analysis.ledger.digest)})`
    : 'Approved list: not loaded');
  return lines.join('\n');
}

// One row per library and version; repeated declarations are listed together.
function appendFindingSection(lines: string[], heading: string, findings: S009Finding[], unchecked = false): void {
  if (!findings.length) return;
  const groups = new Map<string, S009Finding[]>();
  for (const item of findings) {
    const key = [item.observation.ecosystem, item.observation.coordinate, item.observation.declaredVersion ?? ''].join('\0');
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  lines.push(heading);
  for (const group of groups.values()) {
    const reason = unchecked ? '' : `${findingReason(group[0])}. `;
    const declarations = group.map(item => declaration(item.observation)).join('; ');
    lines.push(`  - ${libraryLabel(group[0].observation)} - ${reason}Declared as ${declarations}.`);
  }
}

function findingReason(item: S009Finding): string {
  if (item.classification === 'accepted' && item.acceptance) {
    const family = reportText(item.familyDisplayName || item.familyId || 'its family');
    const reference = reportText(item.acceptance.reference);
    return {
      'approved-tcr': `${family}, approved by the Technical Council (${reference})`,
      'provisional-tcr': `${family}, provisionally approved by the Technical Council (${reference})`,
      'legacy-baseline': `${family}, approved in the platform baseline (${reference})`,
      exception: `${family}, allowed by a Technical Council exception (${reference})`
    }[item.acceptance.kind];
  }
  if (item.acceptance?.kind === 'exception' && item.acceptance.scope === 'S008') {
    return `Its family, ${reportText(item.familyDisplayName || item.familyId || '')}, has an exception for S008 only, not for S009`;
  }
  return item.classification === 'indeterminate-locality'
    ? 'Not on the approved list. A module or workspace with this name is built in this repository, but the declared version does not show whether the build uses it'
    : 'Not on the approved list';
}

function libraryLabel(observation: S009DependencyEvidence['observations'][number]): string {
  const name = reportText(observation.coordinate);
  if (!observation.declaredVersion) return name;
  return `${name}${observation.ecosystem === 'maven' ? ':' : '@'}${reportText(observation.declaredVersion)}`;
}

function declaration(observation: S009DependencyEvidence['observations'][number]): string {
  const kind = DECLARATION_KINDS[observation.scope] ?? `${reportText(observation.scope)} dependency`;
  const profile = /^profiles\.profile\[(\d+)\]/.exec(observation.sourceField);
  const where = profile ? `profile ${Number(profile[1]) + 1} of ${reportText(observation.sourcePath)}` : reportText(observation.sourcePath);
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} in ${where}`;
}

// Warnings with the same message are merged into one row that lists every location.
function appendDiagnostics(lines: string[], heading: string, diagnostics: S009DependencyEvidence['diagnostics']): void {
  if (!diagnostics.length) return;
  const groups = new Map<string, string[]>();
  for (const diagnostic of diagnostics) {
    const message = reportText(diagnostic.message);
    const paths = groups.get(message) ?? [];
    const location = diagnostic.path && locationPath(diagnostic.path);
    if (location && !paths.includes(location)) paths.push(location);
    groups.set(message, paths);
  }
  lines.push(heading);
  for (const [message, paths] of groups) {
    const shown = paths.slice(0, MAX_WARNING_PATHS).join(', ');
    const more = paths.length > MAX_WARNING_PATHS ? ` and ${paths.length - MAX_WARNING_PATHS} more` : '';
    lines.push(`  - ${shown ? `${shown}${more}: ` : ''}${message}`);
  }
}

// A diagnostic location is a file path, optionally followed by the ":line" the evaluator adds.
function locationPath(value: string): string {
  const line = /^(.*):(\d+)$/.exec(value);
  return line ? `${reportPath(line[1])}:${line[2]}` : reportPath(value);
}
