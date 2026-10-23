import {
  CriterionAgentReviewResult,
  S007AnalysisResult,
  S007EvidenceDiagnostic,
  S007FindingClassification,
  S007FindingEvidence,
  S007RuleStrength,
  S007TechnologyFinding
} from '../types';
import { renderAgentReviewLines } from './agent-review-report';
import { reportPath, reportText } from './report-text';
import { isRangeText } from './s007-evaluator';

interface S007FindingGroup {
  technologyId: string;
  displayName: string;
  findings: S007TechnologyFinding[];
  firstIndex: number;
}

const COVERAGE_ID = 'evidence-coverage';

// The HTML report keys S007 groups off "Technology findings:" and the "Repository evidence coverage:" prefix.
const CLASSIFICATION_SUMMARIES: Record<S007FindingClassification, string> = {
  compliant: 'Meets the policy',
  'normative-violation': 'Fails: not an officially supported version',
  'advisory-only': 'Needs review: the policy only recommends a version',
  'advisory-mismatch': 'Needs review: differs from the version the policy recommends',
  provisional: 'Needs review: the policy rule is provisional',
  contested: 'Needs review: the policy rule is time-bound or disputed',
  'unlisted-framework': 'Needs review: not in the supported technologies list',
  unresolved: 'Needs review: the version could not be checked',
  conflicting: 'Needs review: different versions are declared',
  'coverage-incomplete': 'Needs review: the tool could not read everything it needs',
  'test-dependency': 'Used only in tests, so it does not decide the result'
};

const RULE_STRENGTHS: Record<S007RuleStrength, string> = {
  normative: '',
  advisory: ' (recommendation only)',
  provisional: ' (provisional)',
  contested: ' (time-bound or disputed)'
};

export function renderS007HumanDetails(
  analysis: S007AnalysisResult,
  agentReview?: CriterionAgentReviewResult
): string {
  const lines: string[] = [];

  if (analysis.findings.length > 0) {
    lines.push('Technology findings:');
    for (const group of groupFindings(analysis.findings)) {
      lines.push(...(group.technologyId === COVERAGE_ID
        ? renderCoverageGroup(group, analysis.evidenceDiagnostics)
        : renderFindingGroup(group)));
    }
  }
  appendAgentReviewLines(lines, analysis, agentReview);

  if (analysis.policyDiagnostics.length > 0) {
    lines.push('Problems with the officially supported technologies list:');
    lines.push(...analysis.policyDiagnostics.map(diagnostic => `  - ${reportText(diagnostic.message)}`));
  }
  // Without findings (the policy did not load) the diagnostics have no coverage group to sit in.
  if (analysis.findings.length === 0 && analysis.evidenceDiagnostics.length > 0) {
    lines.push('What the tool could not read:', ...diagnosticLines(analysis.evidenceDiagnostics, '  '));
  }
  return lines.join('\n');
}

function appendAgentReviewLines(
  lines: string[],
  analysis: S007AnalysisResult,
  agentReview?: CriterionAgentReviewResult
): void {
  if (agentReview?.available) {
    const subjectNames = Object.fromEntries(analysis.findings.map(finding => [finding.technologyId, finding.displayName]));
    lines.push(...renderAgentReviewLines(agentReview, subjectNames));
    lines.push('  - Advisory only; the criterion status is unchanged.');
  } else if (analysis.agentReviewUnavailableReason) {
    lines.push('Agent review:', `  - Not applied: ${reportText(analysis.agentReviewUnavailableReason)}`);
  }
}

function groupFindings(findings: S007TechnologyFinding[]): S007FindingGroup[] {
  const groups = new Map<string, S007FindingGroup>();
  findings.forEach((finding, index) => {
    const group = groups.get(finding.technologyId);
    if (group) {
      group.findings.push(finding);
    } else {
      groups.set(finding.technologyId, {
        technologyId: finding.technologyId,
        displayName: finding.displayName,
        findings: [finding],
        firstIndex: index
      });
    }
  });

  return [...groups.values()].sort((left, right) =>
    groupPriority(left) - groupPriority(right) || left.firstIndex - right.firstIndex
  );
}

function groupPriority(group: S007FindingGroup): number {
  if (group.findings.some(finding => finding.statusDetermining)) return 0;
  if (group.findings.some(finding => finding.contribution === 'manual')) return 1;
  return group.findings.every(finding => finding.contribution === 'note') ? 3 : 2;
}

function renderCoverageGroup(group: S007FindingGroup, diagnostics: S007EvidenceDiagnostic[]): string[] {
  return [
    `- Repository evidence coverage: Needs review. ${reportText(group.findings.map(finding => finding.rationale).join(' '))}`,
    ...diagnosticLines(diagnostics, '  ')
  ];
}

// One row per problem, with per-dependency problems from the same file merged into one list.
function diagnosticLines(diagnostics: S007EvidenceDiagnostic[], indent: string): string[] {
  const lines: string[] = [];
  const lists = new Map<string, { index: number; diagnostics: S007EvidenceDiagnostic[] }>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.subject && diagnostic.listHeading) {
      const key = JSON.stringify([diagnostic.path, diagnostic.listHeading]);
      const list = lists.get(key);
      if (list) {
        list.diagnostics.push(diagnostic);
        continue;
      }
      lists.set(key, { index: lines.length, diagnostics: [diagnostic] });
    }
    lines.push(`${indent}- ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`);
  }
  for (const { index, diagnostics: listed } of lists.values()) {
    if (listed.length > 1) {
      const [first] = listed;
      lines[index] = `${indent}- ${first.path ? `${reportPath(first.path)} — ` : ''}${first.listHeading}: `
        + `${reportText(listed.map(item => item.subject).join(', '))}.`;
    }
  }
  return lines;
}

function renderFindingGroup(group: S007FindingGroup): string[] {
  const lines = [`- ${reportText(group.displayName)}: ${groupSummary(group)}.`];

  for (const finding of consolidateConclusions(group.findings)) {
    lines.push(
      `  - ${reportText(findingLabel(finding))} — ${shortStatus(finding)}`,
      `    - Why: ${reportText(finding.rationale)}`
    );
    if (finding.matchedPolicy) {
      lines.push(`    - Policy rule: ${reportText(finding.matchedPolicy.sourceStatement)}${RULE_STRENGTHS[finding.matchedPolicy.strength]}`);
    }
    for (const advisory of finding.advisories) {
      lines.push(`    - Policy note: ${reportText(advisory)}`);
    }
    if (finding.evidence.length > 0) {
      // A rule without a version requirement needs no version, so "no version" would only add noise.
      const versionNeeded = finding.contribution !== 'note'
        && (Boolean(finding.matchedPolicy?.constraint) || finding.contribution !== 'pass');
      lines.push('    - Found in:', ...finding.evidence.map(evidence =>
        `      - ${evidenceLine(evidence, versionNeeded, finding.displayName)}`));
    }
  }
  return lines;
}

function evidenceLine(evidence: S007FindingEvidence, versionNeeded: boolean, technology: string): string {
  const source = evidence.resolutionSource === 'maven-effective-pom'
    ? ' from the Maven effective POM'
    : evidence.versionSourcePath && evidence.versionSourcePath !== evidence.path
      ? ` in ${evidence.versionSourcePath}`
      : '';
  const declared = evidence.declaredVersion
    ? `${isRangeText(evidence.declaredVersion) ? 'range' : 'version'} ${evidence.declaredVersion}`
    : undefined;
  let version: string | undefined;
  if (evidence.versionProperty && evidence.declaredVersion) {
    const where = evidence.versionSourcePath && evidence.versionSourcePath !== evidence.path ? ` in ${evidence.versionSourcePath}` : '';
    version = `version ${evidence.declaredVersion} inferred from the ${evidence.versionProperty} property${where} (Spring Boot convention)`;
  } else if (declared && evidence.resolvedVersion && evidence.declaredVersion !== evidence.resolvedVersion) {
    version = `${declared}, resolved to ${evidence.resolvedVersion}${source}`;
  } else if (declared) {
    version = `${declared}${source}`;
  } else if (evidence.resolvedVersion) {
    version = `version ${evidence.resolvedVersion}${source}`;
  } else if (evidence.ownVersionLine) {
    version = `its version is not the ${technology} version`;
  } else if (versionNeeded) {
    version = 'no version in the repository';
  }
  return `${reportPath(evidence.path)} — ${reportText(`${evidence.detail}${version ? `, ${version}` : ''}`)}`;
}

function shortStatus(finding: S007TechnologyFinding): string {
  if (finding.contribution === 'fail') return 'fails';
  if (finding.contribution === 'note') return 'test only';
  return finding.contribution === 'pass' ? 'meets the policy' : 'needs review';
}

function consolidateConclusions(findings: S007TechnologyFinding[]): S007TechnologyFinding[] {
  const conclusions = new Map<string, S007TechnologyFinding>();
  for (const finding of findings) {
    const policy = finding.matchedPolicy;
    const key = JSON.stringify([
      finding.classification, finding.contribution, finding.rationale, finding.statusDetermining,
      policy?.sectionId, policy?.entryId, policy?.strength, policy?.sourceStatement, finding.advisories
    ]);
    const existing = conclusions.get(key);
    if (existing) {
      existing.evidence.push(...finding.evidence);
    } else {
      conclusions.set(key, { ...finding, evidence: [...finding.evidence], advisories: [...finding.advisories] });
    }
  }
  return [...conclusions.values()];
}

function findingLabel(finding: S007TechnologyFinding): string {
  const declarations = [...new Set(finding.evidence.map(evidence => evidence.detail).filter(Boolean))];
  if (declarations.length === 0) return finding.displayName;
  return declarations.length === 1
    ? declarations[0]
    : `${declarations[0]} and ${declarations.length - 1} more`;
}

function groupSummary(group: S007FindingGroup): string {
  const classifications = [...new Set(group.findings.map(finding => finding.classification))];
  if (classifications.length === 1) return CLASSIFICATION_SUMMARIES[classifications[0]];

  const counts = {
    fail: group.findings.filter(finding => finding.contribution === 'fail').length,
    manual: group.findings.filter(finding => finding.contribution === 'manual').length,
    pass: group.findings.filter(finding => finding.contribution === 'pass').length,
    note: group.findings.filter(finding => finding.contribution === 'note').length
  };
  const parts = [
    counts.fail ? `${counts.fail} ${counts.fail === 1 ? 'fails' : 'fail'}` : undefined,
    counts.manual ? `${counts.manual} ${counts.manual === 1 ? 'needs' : 'need'} review` : undefined,
    counts.pass ? `${counts.pass} ${counts.pass === 1 ? 'meets' : 'meet'} the policy` : undefined,
    counts.note ? `${counts.note} used only in tests` : undefined
  ].filter((part): part is string => Boolean(part));
  return `Mixed results: ${parts.join(', ')}`;
}
