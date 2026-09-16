import semver from 'semver';
import {
  EvaluationStatus,
  S007AnalysisResult,
  S007MatchedPolicyEntry,
  S007OfficiallySupportedTechnologiesPolicy,
  S007PolicyLoadResult,
  S007PolicySection,
  S007TechnologyEvidenceResult,
  S007TechnologyFinding,
  S007TechnologyObservation,
  S007TechnologyPolicyEntry,
  S007VersionConstraint
} from '../types';
import { normalizeS007PolicyVersionExpression } from './s007-policy';

type VersionComparison = 'compliant' | 'noncompliant' | 'overlap' | 'unresolved';

export function evaluateS007(
  policyLoad: S007PolicyLoadResult,
  evidence: S007TechnologyEvidenceResult,
  language: 'java' | 'javascript'
): S007AnalysisResult {
  if (!policyLoad.ok) {
    return {
      criterionId: 'S007',
      status: EvaluationStatus.MANUAL,
      summary: 'S007 manual: the current OST policy could not be loaded and validated.',
      findings: [],
      policyDiagnostics: policyLoad.diagnostics,
      evidenceDiagnostics: evidence.diagnostics
    };
  }

  const applicableSections = policyLoad.policy.sections.filter(section =>
    section.consumer === 's007' && section.area === (language === 'javascript' ? 'frontend' : 'backend')
  );
  const findings = evidence.observations.map(observation =>
    evaluateObservation(observation, applicableSections)
  );

  if (evidence.observations.length === 0) {
    findings.push(coverageFinding('No S007-relevant technology evidence was found.'));
  } else if (!evidence.complete) {
    const material = evidence.diagnostics.filter(diagnostic => diagnostic.material);
    findings.push(coverageFinding(
      material.length > 0
        ? `Static evidence coverage is incomplete: ${material.map(item => item.message).join(' ')}`
        : 'Static evidence coverage is incomplete.'
    ));
  }

  const status = classifyStatus(findings);
  for (const finding of findings) {
    finding.statusDetermining =
      (status === EvaluationStatus.FAIL && finding.contribution === 'fail')
      || (status === EvaluationStatus.MANUAL && finding.contribution === 'manual')
      || (status === EvaluationStatus.PASS && finding.contribution === 'pass');
  }

  return {
    criterionId: 'S007',
    status,
    summary: summaryFor(status),
    policyFormatVersion: policyLoad.policy.formatVersion,
    findings,
    policyDiagnostics: [],
    evidenceDiagnostics: evidence.diagnostics
  };
}

function evaluateObservation(
  observation: S007TechnologyObservation,
  sections: S007PolicySection[]
): S007TechnologyFinding {
  const match = findPolicyEntry(observation, sections);
  const base = {
    technologyId: observation.identityCandidates[0],
    displayName: observation.displayName,
    evidence: [{
      path: observation.sourcePath,
      detail: observation.sourceDetail,
      declaredVersion: observation.declaredVersion,
      resolvedVersion: observation.resolvedVersion
    }],
    advisories: [] as string[],
    statusDetermining: false
  };

  if (!match) {
    return {
      ...base,
      classification: observation.unlistedFrameworkCandidate ? 'unlisted-framework' : 'unresolved',
      contribution: 'manual',
      rationale: observation.unlistedFrameworkCandidate
        ? 'An explicit framework indicator is present, but the framework is not listed in the current OST policy.'
        : 'The technology could not be matched to an applicable OST entry.'
    };
  }

  const { entry, section } = match;
  const matchedPolicy = toMatchedPolicy(entry, section);
  const advisories = [
    ...(entry.deprecation ? [entry.deprecation.note] : []),
    ...(entry.recommendations ?? []),
    ...(entry.notes ?? [])
  ];

  if (observation.conflictPaths?.length) {
    return finding(base, matchedPolicy, advisories, 'conflicting', 'manual',
      `Conflicting declarations were found in ${observation.conflictPaths.join(', ')}.`);
  }
  if (entry.strength === 'contested') {
    return finding(base, matchedPolicy, advisories, 'contested', 'manual',
      'The matched OST statement is contested or time-bound and requires reviewer judgment.');
  }
  if (entry.strength === 'provisional' || entry.provisional) {
    return finding(base, matchedPolicy, advisories, 'provisional', 'manual',
      'The matched OST entry is provisional and cannot determine compliance automatically.');
  }

  const comparison = compareObservationToConstraint(observation, entry.constraint);
  if (entry.strength === 'advisory') {
    return comparison === 'noncompliant'
      ? finding(base, matchedPolicy, advisories, 'advisory-mismatch', 'manual',
        'Repository evidence differs from advisory OST guidance; advisory wording cannot cause failure.')
      : finding(base, matchedPolicy, advisories, 'advisory-only', 'manual',
        'The technology is covered only by advisory OST guidance and requires reviewer judgment.');
  }

  if (!entry.constraint) {
    return finding(base, matchedPolicy, advisories, 'compliant', 'pass',
      'The technology is listed by a definitive OST rule with no version comparison required.');
  }
  if (comparison === 'compliant') {
    return finding(base, matchedPolicy, advisories, 'compliant', 'pass',
      'Repository evidence complies with the matched normative OST rule.');
  }
  if (comparison === 'noncompliant') {
    return finding(base, matchedPolicy, advisories, 'normative-violation', 'fail',
      `Repository version ${displayVersion(observation)} violates ${entry.sourceStatement}.`);
  }
  return finding(base, matchedPolicy, advisories, 'unresolved', 'manual',
    comparison === 'overlap'
      ? 'The declared range overlaps both compliant and noncompliant versions and no exact local version resolves it.'
      : 'The relevant version or version semantics could not be resolved confidently from repository evidence.');
}

function compareObservationToConstraint(
  observation: S007TechnologyObservation,
  constraint?: S007VersionConstraint
): VersionComparison {
  if (!constraint) {
    return 'compliant';
  }
  if (constraint.kind === 'latest-lts') {
    return 'unresolved';
  }

  const allowed = constraintToRange(constraint);
  if (!allowed) {
    return 'unresolved';
  }

  if (observation.resolvedVersion) {
    const exact = normalizeExactVersion(observation.resolvedVersion);
    return exact ? (semver.satisfies(exact, allowed, { includePrerelease: true }) ? 'compliant' : 'noncompliant') : 'unresolved';
  }

  const declared = observation.declaredVersion?.trim();
  if (!declared) {
    return 'unresolved';
  }
  const exact = normalizeExactVersion(declared);
  if (exact) {
    return semver.satisfies(exact, allowed, { includePrerelease: true }) ? 'compliant' : 'noncompliant';
  }

  const translated = translateMavenRange(declared) ?? semver.validRange(declared, { includePrerelease: true });
  if (!translated) {
    return 'unresolved';
  }
  if (semver.subset(translated, allowed, { includePrerelease: true })) {
    return 'compliant';
  }
  if (!semver.intersects(translated, allowed, { includePrerelease: true })) {
    return 'noncompliant';
  }
  return 'overlap';
}

function constraintToRange(constraint: S007VersionConstraint): string | undefined {
  switch (constraint.kind) {
    case 'exact': {
      const exact = normalizeExactVersion(constraint.expression);
      return exact ? `=${exact}` : undefined;
    }
    case 'major-line':
    case 'minor-line':
      return semver.validRange(normalizeS007PolicyVersionExpression(constraint.expression)) ?? undefined;
    case 'minimum': {
      const minimum = normalizeExactVersion(constraint.expression);
      return minimum ? `>=${minimum}` : undefined;
    }
    case 'range':
      return translateMavenRange(constraint.expression)
        ?? semver.validRange(constraint.expression, { includePrerelease: true })
        ?? undefined;
    case 'latest-lts':
      return undefined;
  }
}

function normalizeExactVersion(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^v?\d+(?:\.\d+){0,2}$/.test(trimmed)) {
    const numeric = trimmed.replace(/^v/, '').split('.').map(Number);
    while (numeric.length < 3) numeric.push(0);
    return numeric.join('.');
  }
  return semver.valid(trimmed) ?? undefined;
}

function translateMavenRange(value: string): string | undefined {
  const match = /^([[(])\s*([^,]*)\s*,\s*([^\])]*?)\s*([\])])$/.exec(value);
  if (!match) return undefined;
  const [, lowerBracket, lowerRaw, upperRaw, upperBracket] = match;
  const lower = lowerRaw ? normalizeExactVersion(lowerRaw) : undefined;
  const upper = upperRaw ? normalizeExactVersion(upperRaw) : undefined;
  if ((lowerRaw && !lower) || (upperRaw && !upper)) return undefined;
  const parts = [
    lower ? `${lowerBracket === '[' ? '>=' : '>'}${lower}` : '',
    upper ? `${upperBracket === ']' ? '<=' : '<'}${upper}` : ''
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function findPolicyEntry(
  observation: S007TechnologyObservation,
  sections: S007PolicySection[]
): { entry: S007TechnologyPolicyEntry; section: S007PolicySection } | undefined {
  const identities = new Set(observation.identityCandidates.map(normalizeIdentity));
  for (const section of sections) {
    for (const entry of section.entries) {
      if ([entry.id, ...entry.aliases].map(normalizeIdentity).some(candidate => identities.has(candidate))) {
        return { entry, section };
      }
    }
  }
  return undefined;
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function toMatchedPolicy(entry: S007TechnologyPolicyEntry, section: S007PolicySection): S007MatchedPolicyEntry {
  return {
    sectionId: section.id,
    entryId: entry.id,
    displayName: entry.displayName,
    strength: entry.strength,
    sourceStatement: entry.sourceStatement,
    constraint: entry.constraint
  };
}

function finding(
  base: Pick<S007TechnologyFinding, 'technologyId' | 'displayName' | 'evidence' | 'statusDetermining'>,
  matchedPolicy: S007MatchedPolicyEntry,
  advisories: string[],
  classification: S007TechnologyFinding['classification'],
  contribution: S007TechnologyFinding['contribution'],
  rationale: string
): S007TechnologyFinding {
  return { ...base, matchedPolicy, advisories, classification, contribution, rationale };
}

function coverageFinding(rationale: string): S007TechnologyFinding {
  return {
    technologyId: 'evidence-coverage',
    displayName: 'Repository evidence coverage',
    classification: 'coverage-incomplete',
    contribution: 'manual',
    rationale,
    evidence: [],
    advisories: [],
    statusDetermining: false
  };
}

function classifyStatus(findings: S007TechnologyFinding[]): EvaluationStatus {
  if (findings.some(finding => finding.contribution === 'fail')) return EvaluationStatus.FAIL;
  if (findings.some(finding => finding.contribution === 'manual')) return EvaluationStatus.MANUAL;
  return findings.length > 0 ? EvaluationStatus.PASS : EvaluationStatus.MANUAL;
}

function summaryFor(status: EvaluationStatus): string {
  switch (status) {
    case EvaluationStatus.FAIL:
      return 'S007 fail: at least one detected technology conclusively violates a normative OST rule.';
    case EvaluationStatus.PASS:
      return 'S007 pass: all detected relevant technologies comply with the current OST policy.';
    default:
      return 'S007 manual: current repository evidence or policy semantics require reviewer judgment.';
  }
}

function displayVersion(observation: S007TechnologyObservation): string {
  return observation.resolvedVersion ?? observation.declaredVersion ?? 'unresolved';
}
