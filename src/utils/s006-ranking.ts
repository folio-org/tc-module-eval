import {
  S006FindingConfidence,
  S006FindingContext,
  S006FindingSeverity,
  S006SensitiveInformationFinding
} from '../types';

const DEFAULT_S006_REPORT_FINDING_LIMIT = 8;

const S006_SEVERITY_RANKS: Record<S006FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
};

const S006_CONFIDENCE_RANKS: Record<S006FindingConfidence, number> = {
  high: 0,
  medium: 1,
  low: 2
};

const S006_CONTEXT_RANKS: Record<S006FindingContext, number> = {
  production_source_or_configuration: 0,
  ci_or_deployment_configuration: 1,
  local_docker_defaults: 2,
  documentation: 3,
  test_fixture: 4,
  sample_or_example: 5,
  unknown: 6,
  generated_content: 7
};

export function strongestS006ReportFindings(
  findings: S006SensitiveInformationFinding[],
  limit: number = DEFAULT_S006_REPORT_FINDING_LIMIT
): S006SensitiveInformationFinding[] {
  return [...findings]
    .sort((left, right) =>
      rankS006FindingImpact(left) - rankS006FindingImpact(right) ||
      rankS006Severity(left.severity) - rankS006Severity(right.severity) ||
      rankS006Confidence(left.confidence) - rankS006Confidence(right.confidence) ||
      rankS006Context(left.context) - rankS006Context(right.context) ||
      left.path.localeCompare(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.detectorId.localeCompare(right.detectorId)
    )
    .slice(0, limit);
}

export function rankS006FindingImpact(finding: S006SensitiveInformationFinding): number {
  return finding.statusImpact === 'deterministic_fail' ? 0 : 1;
}

export function rankS006Severity(severity: S006FindingSeverity): number {
  return S006_SEVERITY_RANKS[severity];
}

export function rankS006Confidence(confidence: S006FindingConfidence): number {
  return S006_CONFIDENCE_RANKS[confidence];
}

export function rankS006Context(context: S006FindingContext): number {
  return S006_CONTEXT_RANKS[context];
}
