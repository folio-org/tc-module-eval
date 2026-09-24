import {
  CriterionAgentReviewResult,
  S007AnalysisResult,
  S007FindingClassification,
  S007TechnologyFinding
} from '../types';

interface S007FindingGroup {
  technologyId: string;
  displayName: string;
  findings: S007TechnologyFinding[];
  firstIndex: number;
}

const CLASSIFICATION_SUMMARIES: Record<S007FindingClassification, string> = {
  compliant: 'Complies with applicable policy',
  'normative-violation': 'Violates a mandatory rule',
  'advisory-only': 'Needs review: policy guidance is advisory',
  'advisory-mismatch': 'Needs review: differs from advisory guidance',
  provisional: 'Needs review: policy guidance is provisional',
  contested: 'Needs review: policy wording is contested or time-bound',
  'unlisted-framework': 'Needs review: technology is not listed in policy',
  unresolved: 'Needs review: evidence or policy applicability is unresolved',
  conflicting: 'Needs review: repository declarations conflict',
  'coverage-incomplete': 'Needs review: repository evidence coverage is incomplete'
};

export function buildS007CriterionDetails(analysis: S007AnalysisResult): S007AnalysisResult {
  return analysis;
}

export function renderS007HumanDetails(
  analysis: S007AnalysisResult,
  agentReview?: CriterionAgentReviewResult
): string {
  const lines: string[] = [];

  if (analysis.findings.length > 0) {
    lines.push('Technology findings:');
    for (const group of groupFindings(analysis.findings)) {
      lines.push(...renderFindingGroup(group));
    }
    appendAgentReviewLines(lines, analysis, agentReview);
  }

  for (const diagnostic of analysis.policyDiagnostics) {
    lines.push(`Policy diagnostic: ${diagnostic.message}`);
  }
  for (const diagnostic of analysis.evidenceDiagnostics) {
    lines.push(`Evidence diagnostic${diagnostic.path ? ` (${diagnostic.path})` : ''}: ${diagnostic.message}`);
  }
  if (analysis.findings.length === 0) {
    appendAgentReviewLines(lines, analysis, agentReview);
  }
  return lines.join('\n');
}

function appendAgentReviewLines(
  lines: string[],
  analysis: S007AnalysisResult,
  agentReview?: CriterionAgentReviewResult
): void {
  if (agentReview?.available) {
    lines.push(
      'Agent review:',
      `  - Advisory recommendation: ${agentReview.recommendation}`,
      `  - Confidence: ${agentReview.confidence}`,
      `  - Summary: ${agentReview.summary}`,
      `  - Rationale: ${agentReview.rationale}`
    );
    if (agentReview.assessments?.length) {
      lines.push('  - Practical assessments:');
      for (const assessment of agentReview.assessments) {
        lines.push(
          `    - ${assessment.technologyId} — ${assessment.type.replace(/_/g, ' ')}: ${assessment.summary}`,
          `      - Evidence: ${assessment.evidenceReferences.join(', ')}`
        );
      }
    }
    if (agentReview.reviewerActions?.length) {
      lines.push('  - Reviewer actions:');
      for (const action of agentReview.reviewerActions) {
        lines.push(
          `    - ${action.action}`,
          `      - Evidence: ${action.evidenceReferences.join(', ')}`
        );
      }
    }
    lines.push(`  - Deterministic result remains ${capitalize(analysis.status)}.`);
  } else if (analysis.agentReviewUnavailableReason) {
    lines.push('Agent review:', `  - Not applied: ${analysis.agentReviewUnavailableReason}`);
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
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
  return 2;
}

function renderFindingGroup(group: S007FindingGroup): string[] {
  const isCoverage = group.technologyId === 'evidence-coverage';
  const heading = isCoverage ? group.displayName : `${group.displayName} (${group.technologyId})`;
  const impact = groupImpact(group);
  const summary = groupSummary(group);
  const lines = [`- ${heading}: ${summary}.${impact ? ` ${impact}.` : ''}`];

  group.findings.forEach((finding, index) => {
    const observationLabel = findingLabel(finding, index, isCoverage);
    lines.push(
      `  - ${observationLabel} — ${CLASSIFICATION_SUMMARIES[finding.classification]}`,
      `    - Classification: ${finding.classification}`,
      `    - Result contribution: ${finding.contribution}`,
      `    - Rationale: ${finding.rationale}`
    );
    if (finding.matchedPolicy) {
      lines.push(
        `    - Policy entry: ${finding.matchedPolicy.sectionId}/${finding.matchedPolicy.entryId}`,
        `    - Rule strength: ${finding.matchedPolicy.strength}`,
        `    - Policy statement: ${finding.matchedPolicy.sourceStatement}`
      );
    } else {
      lines.push('    - Policy entry: no matched OST entry');
    }
    for (const advisory of finding.advisories) {
      lines.push(`    - Advisory: ${advisory}`);
    }
    if (finding.evidence.length > 0) {
      lines.push('    - Evidence:');
      for (const evidence of finding.evidence) {
        lines.push(`      - ${evidence.path} — ${evidence.detail}`);
        if (evidence.declaredVersion) lines.push(`        - Declared version: ${evidence.declaredVersion}`);
        if (evidence.resolvedVersion) lines.push(`        - Resolved version: ${evidence.resolvedVersion}`);
        if (evidence.versionSourcePath) lines.push(`        - Version source: ${evidence.versionSourcePath}`);
        if (evidence.resolutionSource === 'maven-effective-pom') {
          lines.push('        - Resolution method: Maven effective POM');
        }
      }
    }
  });
  return lines;
}

function findingLabel(finding: S007TechnologyFinding, index: number, isCoverage: boolean): string {
  if (isCoverage) return 'Coverage limitation';
  const declarations = [...new Set(finding.evidence.map(evidence => evidence.detail).filter(Boolean))];
  if (declarations.length === 0) return `Observation ${index + 1}`;
  return declarations.length === 1
    ? declarations[0]
    : `${declarations[0]} (+${declarations.length - 1} more declarations)`;
}

function groupImpact(group: S007FindingGroup): string | undefined {
  const determining = group.findings.filter(finding => finding.statusDetermining);
  if (determining.some(finding => finding.contribution === 'fail')) return 'Determines overall result: Fail';
  if (determining.some(finding => finding.contribution === 'manual')) return 'Determines overall result: Manual review';
  if (determining.some(finding => finding.contribution === 'pass')) return 'Supports overall result: Pass';
  return undefined;
}

function groupSummary(group: S007FindingGroup): string {
  const classifications = [...new Set(group.findings.map(finding => finding.classification))];
  if (classifications.length === 1) return CLASSIFICATION_SUMMARIES[classifications[0]];

  const counts = {
    fail: group.findings.filter(finding => finding.contribution === 'fail').length,
    manual: group.findings.filter(finding => finding.contribution === 'manual').length,
    pass: group.findings.filter(finding => finding.contribution === 'pass').length
  };
  const parts = [
    counts.fail ? (counts.fail === 1 ? '1 violates a mandatory rule' : `${counts.fail} violate mandatory rules`) : undefined,
    counts.manual ? (counts.manual === 1 ? '1 needs review' : `${counts.manual} need review`) : undefined,
    counts.pass ? (counts.pass === 1 ? '1 complies' : `${counts.pass} comply`) : undefined
  ].filter((part): part is string => Boolean(part));
  return `Mixed results: ${parts.join(', ')}`;
}
