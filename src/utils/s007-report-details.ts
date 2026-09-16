import { S007AnalysisResult } from '../types';

export function buildS007CriterionDetails(analysis: S007AnalysisResult): S007AnalysisResult {
  return analysis;
}

export function renderS007HumanDetails(analysis: S007AnalysisResult): string {
  const lines = [analysis.summary];
  if (analysis.policyFormatVersion) {
    lines.push(`Policy format: ${analysis.policyFormatVersion}`);
  }

  if (analysis.findings.length > 0) {
    lines.push('Technology findings:');
    for (const finding of analysis.findings) {
      const evidence = finding.evidence.length > 0
        ? finding.evidence.map(item => `${item.path} (${item.detail})`).join(', ')
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
  return lines.join('\n');
}
