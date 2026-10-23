import semver from 'semver';
import {
  EvaluationStatus,
  S007AnalysisResult,
  S007MatchedPolicyEntry,
  S007PolicyLoadResult,
  S007PolicySection,
  S007TechnologyEvidenceResult,
  S007TechnologyFinding,
  S007TechnologyObservation,
  S007TechnologyPolicyEntry,
  S007VersionComparison,
  S007VersionConstraint
} from '../types';
import { CriterionLanguage } from '../criteria-definitions';
import { normalizeS007PolicyVersionExpression, policySections } from './s007-policy';
import { listText } from './report-text';

export function evaluateS007(
  policyLoad: S007PolicyLoadResult,
  evidence: S007TechnologyEvidenceResult,
  language: CriterionLanguage
): S007AnalysisResult {
  if (!policyLoad.ok) {
    return {
      criterionId: 'S007',
      status: EvaluationStatus.MANUAL,
      summary: 'S007 manual: The officially supported technologies list (config/officially-supported-technologies.json) could not be loaded, so no technology was checked. Fix the file and run the evaluation again.',
      findings: [],
      policyDiagnostics: policyLoad.diagnostics,
      evidenceDiagnostics: evidence.diagnostics
    };
  }

  const applicableSections = policySections(policyLoad.policy, 's007', language === 'javascript' ? 'frontend' : 'backend');
  const findings = evidence.observations.map(observation =>
    evaluateObservation(observation, applicableSections, evidence)
  );
  // Only production dependencies decide the status; test dependencies are listed as notes.
  const production = evidence.observations.filter(observation => !observation.testScope);

  if (production.length === 0) {
    findings.push(coverageFinding('No language or framework the tool recognizes was found in the build or package files.'));
  } else {
    const reasons = [
      production.some(observation => language === 'java'
        ? observation.identityCandidates[0] === 'java'
        : observation.technologyType === 'language')
        ? undefined
        : language === 'java' ? 'No Java version was found.' : 'No JavaScript or TypeScript indicator was found.',
      production.some(observation => observation.technologyType === 'framework')
        ? undefined
        : 'No framework was found.',
      evidence.complete ? undefined : 'Some versions or build settings could not be read from the repository.'
    ].filter((message): message is string => Boolean(message));
    if (reasons.length > 0) {
      findings.push(coverageFinding(reasons.join(' ')));
    }
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
    summary: summaryFor(status, findings),
    policyFormatVersion: policyLoad.policy.formatVersion,
    findings,
    policyDiagnostics: [],
    evidenceDiagnostics: evidence.diagnostics
  };
}

function evaluateObservation(
  observation: S007TechnologyObservation,
  sections: S007PolicySection[],
  evidence: S007TechnologyEvidenceResult
): S007TechnologyFinding {
  const match = findPolicyEntry(observation, sections);
  const base = {
    technologyId: observation.identityCandidates[0],
    displayName: observation.displayName,
    evidence: [{
      path: observation.sourcePath,
      detail: observation.sourceDetail,
      declaredVersion: observation.declaredVersion,
      resolvedVersion: observation.resolvedVersion,
      versionSourcePath: observation.versionSourcePath,
      resolutionSource: observation.resolutionSource,
      versionProperty: observation.versionProperty,
      ownVersionLine: observation.versionResolutionEligible === false ? true as const : undefined
    }],
    advisories: [] as string[],
    statusDetermining: false
  };

  if (observation.testScope) {
    return {
      ...base,
      matchedPolicy: match ? toMatchedPolicy(match.entry, match.section, {
        constraint: match.entry.constraint,
        strength: match.entry.strength,
        sourceStatement: match.entry.sourceStatement,
        unresolved: false
      }) : undefined,
      classification: 'test-dependency',
      contribution: 'note',
      rationale: 'Used only in tests, so it does not decide the result.'
    };
  }
  if (!match) {
    return {
      ...base,
      classification: observation.unlistedFrameworkCandidate ? 'unlisted-framework' : 'unresolved',
      contribution: 'manual',
      rationale: observation.unlistedFrameworkCandidate
        ? 'This framework is not in the officially supported technologies list, so a reviewer must decide whether it is acceptable.'
        : 'This technology does not match any entry in the officially supported technologies list for this kind of module.'
    };
  }

  const { entry, section } = match;
  const applicableRule = resolveApplicableRule(entry, sections, evidence, observation);
  const matchedPolicy = toMatchedPolicy(entry, section, applicableRule);
  const advisories = [
    ...(entry.deprecation ? [entry.deprecation.note] : []),
    ...(entry.recommendations ?? []),
    ...(entry.notes ?? [])
  ];

  // Different declared versions leave unclear which one is used, unless every one of them breaks the rule.
  const declaredVersions = evidence.observations.filter(candidate =>
    !candidate.testScope && candidate.identityCandidates[0] === observation.identityCandidates[0]);
  if (observation.conflictPaths?.length && !declaredVersions.every(candidate =>
    compareObservationToConstraint(candidate, applicableRule.constraint) === 'noncompliant')) {
    return finding(base, matchedPolicy, advisories, 'conflicting', 'manual',
      `Different versions are declared in ${observation.conflictPaths.join(', ')}, so it is not clear which one is used.`);
  }
  const baseComparison = compareObservationToConstraint(observation, entry.constraint);
  const exceptionOutcomeAgrees = applicableRule.unresolved
    && (baseComparison === 'compliant' || baseComparison === 'noncompliant')
    && [entry, ...(entry.exceptions ?? [])].every(rule =>
      rule.strength === 'normative'
      && compareObservationToConstraint(observation, rule.constraint) === baseComparison
    );
  if (applicableRule.unresolved && !exceptionOutcomeAgrees) {
    return finding(base, matchedPolicy, advisories, 'unresolved', 'manual',
      `The policy makes an exception (${(entry.exceptions ?? []).map(exception => `"${exception.sourceStatement}"`).join(', ')}), and the repository does not show whether it applies here.`);
  }
  if (exceptionOutcomeAgrees) {
    advisories.push('The tool could not tell whether the policy exception applies, but the result is the same either way.');
  }
  if (applicableRule.strength === 'contested') {
    return finding(base, matchedPolicy, advisories, 'contested', 'manual',
      'The policy rule is time-bound or disputed, so a reviewer must decide whether it applies now.');
  }
  if (applicableRule.strength === 'provisional' || entry.provisional) {
    return finding(base, matchedPolicy, advisories, 'provisional', 'manual',
      'The policy rule is provisional, so the tool does not pass or fail the module on it.');
  }
  if (
    observation.provenance !== 'repository-static' &&
    observation.resolutionSource !== 'maven-effective-pom'
  ) {
    return finding(base, matchedPolicy, advisories, 'unresolved', 'manual',
      'The version was found only outside the repository, so it is shown for information and does not decide the result.');
  }

  const comparison = compareObservationToConstraint(observation, applicableRule.constraint);
  if (applicableRule.strength === 'advisory') {
    return comparison === 'noncompliant'
      ? finding(base, matchedPolicy, advisories, 'advisory-mismatch', 'manual',
        `${versionSubject(observation)} differs from what the policy recommends. A recommendation cannot fail the module, but a reviewer should check it.`)
      : finding(base, matchedPolicy, advisories, 'advisory-only', 'manual',
        'The policy only recommends a version for this technology, so a reviewer must decide.');
  }

  if (!applicableRule.constraint) {
    return finding(base, matchedPolicy, advisories, 'compliant', 'pass',
      'The policy supports this technology without a version requirement.');
  }
  if (comparison === 'compliant') {
    return finding(base, matchedPolicy, advisories, 'compliant', 'pass',
      !observation.resolvedVersion && observation.declaredVersion && isRangeText(observation.declaredVersion)
        ? `Every version the declared range ${observation.declaredVersion} allows meets the policy rule.`
        : `${versionSubject(observation)} meets the policy rule.`);
  }
  if (comparison === 'noncompliant') {
    return finding(base, matchedPolicy, advisories, 'normative-violation', 'fail',
      `${versionSubject(observation)} is not allowed by the policy rule "${applicableRule.sourceStatement}". `
      + {
        older: 'Upgrade to a version the rule allows.',
        newer: 'It is newer than the rule allows: use a version the rule allows, or ask the Technical Council to update the policy.',
        unknown: 'Change it to a version the rule allows.'
      }[versionDirection(base.evidence[0], applicableRule.constraint)]);
  }
  return finding(base, matchedPolicy, advisories, 'unresolved', 'manual', unresolvedRationale(observation, comparison, applicableRule.constraint));
}

/**
 * How an observed version compares with a policy constraint. A resolved version wins over the declared one; a plain
 * number is an exact version (except in npm, where only a full version is), and a range is compliant only when every
 * version it allows is.
 */
export function compareObservationToConstraint(
  observation: Pick<S007TechnologyObservation, 'resolvedVersion' | 'declaredVersion' | 'ecosystem'>,
  constraint?: S007VersionConstraint
): S007VersionComparison {
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
    return exact
      ? (semver.satisfies(exact, allowed, { includePrerelease: true }) ? 'compliant' : 'noncompliant')
      : 'unresolved';
  }

  const declared = observation.declaredVersion?.trim();
  // npm ranges use npm semantics: a prerelease only matches a range that names one. includePrerelease would let
  // ^18.2 allow 18.2.0-0, below a ^18.2.0 policy. Then "<19.0.0-0" (how semver writes ^18) and "<19.0.0" are the
  // same set, so compare release bounds.
  const npm = observation.ecosystem === 'javascript';
  const releaseBounds = (range: string): string => npm ? range.replace(/<(\d+\.\d+\.\d+)-0(?![\w.-])/g, '<$1') : range;
  let declaredComparison: S007VersionComparison = 'unresolved';
  if (declared) {
    // In npm, "18" or "18.2" is a range, so only a full version is exact there.
    const exact = npm ? semver.valid(declared) ?? undefined : normalizeExactVersion(declared);
    if (exact) {
      declaredComparison = semver.satisfies(exact, allowed, { includePrerelease: true }) ? 'compliant' : 'noncompliant';
    }
  }
  if (declaredComparison === 'unresolved' && declared) {
    const options = { includePrerelease: !npm };
    const validRange = npm ? semver.validRange(declared, options) : translateMavenRange(declared) ?? semver.validRange(declared, options);
    const translated = validRange ? releaseBounds(validRange) : undefined;
    const policyRange = releaseBounds(allowed);
    if (translated) {
      if (semver.subset(translated, policyRange, options)) {
        declaredComparison = 'compliant';
      } else if (!semver.intersects(translated, policyRange, options)) {
        declaredComparison = 'noncompliant';
      } else {
        declaredComparison = 'overlap';
      }
    }
  }

  return declaredComparison;
}

/** The semver range a policy constraint allows, or undefined when it has none (latest-lts) or cannot be read. */
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
  // One unbounded group per part and trim afterwards: adjacent "\s*" and "[^,]*" runs made this cubic on long input.
  const match = /^([[(])([^,]*),([^\])]*)([\])])$/.exec(value);
  if (!match) return undefined;
  const [, lowerBracket, lowerText, upperText, upperBracket] = match;
  const lowerRaw = lowerText.trim();
  const upperRaw = upperText.trim();
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

interface ApplicableRule {
  constraint?: S007VersionConstraint;
  strength: S007TechnologyPolicyEntry['strength'];
  sourceStatement: string;
  unresolved: boolean;
}

function resolveApplicableRule(
  entry: S007TechnologyPolicyEntry,
  sections: S007PolicySection[],
  evidence: S007TechnologyEvidenceResult,
  observation: S007TechnologyObservation
): ApplicableRule {
  const base = {
    constraint: entry.constraint,
    strength: entry.strength,
    sourceStatement: entry.sourceStatement,
    unresolved: false
  };
  if (!entry.exceptions?.length) return base;

  for (const exception of entry.exceptions) {
    if (exception.appliesTo !== 'grails-modules') {
      return { ...base, unresolved: true };
    }

    const observationOwner = sourceOwner(observation.sourcePath);
    const grailsOwners = evidence.observations.filter(candidate =>
      !candidate.testScope
      && (candidate.provenance === 'repository-static' || candidate.repositoryDeclared === true)
      && findPolicyEntry(candidate, sections)?.entry.id === 'grails'
    ).map(candidate => sourceOwner(candidate.sourcePath));
    if (grailsOwners.includes(observationOwner)) {
      return {
        constraint: exception.constraint,
        strength: exception.strength,
        sourceStatement: exception.sourceStatement,
        unresolved: false
      };
    }
    const inheritedScopeIsAmbiguous = grailsOwners.some(owner =>
      owner === '' || observationOwner.startsWith(`${owner}/`)
    );
    if (inheritedScopeIsAmbiguous) {
      return { ...base, unresolved: true };
    }
  }

  return evidence.complete ? base : { ...base, unresolved: true };
}

function sourceOwner(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
}

function toMatchedPolicy(
  entry: S007TechnologyPolicyEntry,
  section: S007PolicySection,
  rule: ApplicableRule
): S007MatchedPolicyEntry {
  return {
    sectionId: section.id,
    entryId: entry.id,
    displayName: entry.displayName,
    strength: rule.strength,
    sourceStatement: rule.sourceStatement,
    constraint: rule.constraint
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
  return findings.some(finding => finding.contribution === 'pass') ? EvaluationStatus.PASS : EvaluationStatus.MANUAL;
}

const REVIEW_REASONS: Partial<Record<S007TechnologyFinding['classification'], string>> = {
  'advisory-only': 'the policy only recommends a version',
  'advisory-mismatch': 'differs from the recommended version',
  provisional: 'the policy rule is provisional',
  contested: 'the policy rule is time-bound or disputed',
  'unlisted-framework': 'not in the supported technologies list',
  unresolved: 'the version could not be checked',
  conflicting: 'different versions are declared',
  'coverage-incomplete': 'the tool could not read everything it needs'
};

function summaryFor(status: EvaluationStatus, findings: S007TechnologyFinding[]): string {
  if (status === EvaluationStatus.FAIL) {
    const failing = findings.filter(finding => finding.contribution === 'fail');
    // Several declarations of one version, such as RMB's domain-models-* artifacts, make one item.
    const items = [...new Set(failing.map(finding => {
      const evidence = finding.evidence[0];
      const version = evidence?.resolvedVersion ?? evidence?.declaredVersion;
      return `${finding.displayName}${version ? ` ${version}` : ''}${evidence ? ` in ${evidence.path}` : ''}`
        + ` (the policy allows "${finding.matchedPolicy?.sourceStatement}")`;
    }))];
    const directions = new Set(failing.map(finding => versionDirection(finding.evidence[0], finding.matchedPolicy?.constraint)));
    const one = items.length === 1;
    const direction = directions.size === 1 ? [...directions][0] : 'unknown';
    const fix = {
      older: `Upgrade ${one ? 'it to a version' : 'them to versions'} the policy allows.`,
      newer: `${one ? 'It is' : 'They are'} newer than the policy allows: use ${one ? 'a version' : 'versions'} the policy allows, or ask the Technical Council to update the policy.`,
      unknown: `Change ${one ? 'it to a version' : 'them to versions'} the policy allows.`
    }[direction];
    return one
      ? `S007 fail: ${items[0]} is not an officially supported version. ${fix}`
      : `S007 fail: ${listText(items)} are not officially supported versions. ${fix}`;
  }
  if (status === EvaluationStatus.PASS) {
    return `S007 pass: Every technology found is officially supported: ${listText([...new Set(findings
      .filter(finding => finding.contribution === 'pass')
      .map(finding => finding.displayName))])}.`;
  }
  const reviewItems = new Map<string, string>();
  for (const finding of findings.filter(candidate => candidate.contribution === 'manual')) {
    if (!reviewItems.has(finding.technologyId)) {
      reviewItems.set(finding.technologyId, finding.technologyId === 'evidence-coverage'
        ? 'gaps in what the tool could read from the repository'
        : `${finding.displayName} (${REVIEW_REASONS[finding.classification]})`);
    }
  }
  return `S007 manual: No definite policy violation was found, but a reviewer needs to check ${listText([...reviewItems.values()])}.`;
}

/**
 * Whether a failing version is below or above every version the rule allows, so the advice can say to upgrade or
 * to use an allowed version. A range counts only when its lowest and highest versions are on the same side; when
 * that cannot be established the advice stays neutral.
 */
function versionDirection(
  evidence: Pick<S007TechnologyFinding['evidence'][number], 'declaredVersion' | 'resolvedVersion'> | undefined,
  constraint?: S007VersionConstraint
): 'older' | 'newer' | 'unknown' {
  const allowed = constraint ? constraintToRange(constraint) : undefined;
  const version = evidence?.resolvedVersion ?? evidence?.declaredVersion;
  if (!allowed || !version) return 'unknown';
  const exact = normalizeExactVersion(version);
  if (exact) {
    if (semver.ltr(exact, allowed, { includePrerelease: true })) return 'older';
    return semver.gtr(exact, allowed, { includePrerelease: true }) ? 'newer' : 'unknown';
  }
  // A range is entirely older when it is below the lowest allowed version, and newer when its lowest version is
  // above the highest allowed version.
  const range = translateMavenRange(version) ?? semver.validRange(version);
  const lowest = range ? semver.minVersion(range)?.version : undefined;
  if (!lowest) return 'unknown';
  if (semver.gtr(lowest, allowed, { includePrerelease: true })) return 'newer';
  const allowedLowest = semver.minVersion(allowed)?.version;
  return allowedLowest && semver.subset(range!, `<${allowedLowest}`, { includePrerelease: true }) ? 'older' : 'unknown';
}

function versionSubject(observation: S007TechnologyObservation): string {
  if (observation.resolvedVersion) return `Version ${observation.resolvedVersion}`;
  if (!observation.declaredVersion) return 'The version';
  if (observation.versionProperty) {
    return `Version ${observation.declaredVersion} (inferred from the ${observation.versionProperty} property)`;
  }
  return isRangeText(observation.declaredVersion)
    ? `The declared range ${observation.declaredVersion}`
    : `Version ${observation.declaredVersion}`;
}

/** True for npm or Maven version ranges such as ^18.2.0, >=16 or [1.0,2.0), as opposed to one version. */
export function isRangeText(version: string): boolean {
  return !/^v?\d[\w.+-]*$/.test(version.trim()) || /(?:^|\.)[xX*](?:\.|$)/.test(version.trim());
}

function unresolvedRationale(
  observation: S007TechnologyObservation,
  comparison: S007VersionComparison,
  constraint?: S007VersionConstraint
): string {
  if (comparison === 'overlap') {
    return `The declared range ${observation.declaredVersion} allows both supported and unsupported versions, and no lockfile or exact version shows which one is used.`;
  }
  if (!observation.resolvedVersion && !observation.declaredVersion) {
    return 'No version was found in the repository, so it cannot be compared with the policy.';
  }
  return constraint?.kind === 'latest-lts'
    ? `The tool cannot tell whether ${versionSubject(observation).toLowerCase()} is a long-term support (LTS) release.`
    : `${versionSubject(observation)} could not be compared with the policy rule.`;
}
