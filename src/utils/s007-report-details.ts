import { CriterionAgentReviewResult, S007AnalysisResult } from '../types';

export function buildS007CriterionDetails(analysis: S007AnalysisResult): S007AnalysisResult {
  return analysis;
}

export function renderS007HumanDetails(
  analysis: S007AnalysisResult,
  agentReview?: CriterionAgentReviewResult
): string {
  const lines = [analysis.summary];
  if (analysis.policyFormatVersion) {
    lines.push(`Policy format: ${analysis.policyFormatVersion}`);
  }

  if (analysis.findings.length > 0) {
    lines.push('Technology findings:');
    for (const finding of analysis.findings) {
      const evidence = finding.evidence.length > 0
        ? finding.evidence.map(item => {
          const details = [
            item.detail,
            item.declaredVersion ? `declared=${item.declaredVersion}` : undefined,
            item.resolvedVersion ? `resolved=${item.resolvedVersion}` : undefined,
            item.versionSourcePath ? `version source=${item.versionSourcePath}` : undefined
          ].filter((detail): detail is string => Boolean(detail));
          return `${item.path} (${details.join('; ')})`;
        }).join(', ')
        : 'none';
      const policy = finding.matchedPolicy
        ? `${finding.matchedPolicy.sectionId}/${finding.matchedPolicy.entryId}; strength=${finding.matchedPolicy.strength}`
        : 'no matched OST entry';
      lines.push(
        `- ${finding.displayName} (${finding.technologyId}): ${finding.classification}; `
        + `contribution=${finding.contribution}; evidence=${evidence}; policy=${policy}. ${finding.rationale}`
      );
      for (const advisory of finding.advisories) {
        lines.push(`  Advisory: ${advisory}`);
      }
    }
  }

  for (const diagnostic of analysis.policyDiagnostics) {
    lines.push(`Policy diagnostic: ${diagnostic.message}`);
  }
  for (const diagnostic of analysis.evidenceDiagnostics) {
    lines.push(`Evidence diagnostic${diagnostic.path ? ` (${diagnostic.path})` : ''}: ${diagnostic.message}`);
  }
  if (agentReview?.available) {
    lines.push(
      'Agent review:',
      `Advisory recommendation: ${agentReview.recommendation}`,
      `Confidence: ${agentReview.confidence}`,
      `Summary: ${agentReview.summary}`,
      `Rationale: ${agentReview.rationale}`
    );
  } else if (analysis.agentReviewUnavailableReason) {
    lines.push('Agent review:', `Unavailable: ${analysis.agentReviewUnavailableReason}`);
  }
  return lines.join('\n');
}
