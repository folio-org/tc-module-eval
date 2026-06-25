import {
  EvaluationStatus,
  S006DetectorRegistryEntry,
  S006FindingConfidence,
  S006FindingContext,
  S006FindingStatusImpact,
  S006ScanCoverage,
  S006ScanWarning,
  S006SensitiveInformationAnalysisResult,
  S006SensitiveInformationFinding,
  S006ValueClassification
} from '../types';
import {
  buildS006RedactedDetectorMatch,
  createS006FingerprintRun,
  getS006DetectorById,
  getS006Severity,
  S006_DETECTOR_REGISTRY,
  S006FingerprintRun
} from './s006-detectors';
import {
  buildS006Warning,
  scanS006RepositoryCandidates,
  S006ScannedCandidateTextFile
} from './s006-scanner';

export const S006_CONTEXT_LABELS: ReadonlyArray<S006FindingContext> = [
  'production_source_or_configuration',
  'ci_or_deployment_configuration',
  'documentation',
  'test_fixture',
  'sample_or_example',
  'local_docker_defaults',
  'generated_content',
  'unknown'
];

export const MAX_S006_RETAINED_FINDINGS = 100;

interface S006LineWithOffset {
  text: string;
  lineNumber: number;
  offset: number;
}

interface S006PrivateKeyRange {
  start: number;
  end: number;
}

export function extractS006SensitiveInformationFindings(
  files: ReadonlyArray<S006ScannedCandidateTextFile>,
  fingerprintRun: S006FingerprintRun = createS006FingerprintRun()
): { findings: S006SensitiveInformationFinding[]; warnings: S006ScanWarning[] } {
  const findings: S006SensitiveInformationFinding[] = [];
  const warnings: S006ScanWarning[] = [];
  const dedupeKeys = new Set<string>();
  let findingLimitReached = false;

  for (const file of files) {
    const context = classifyS006SourceContext(file.path, file.text);
    const privateKeyRanges = extractS006PrivateKeyFindings(file, context, fingerprintRun, findings, dedupeKeys);
    if (findings.length >= MAX_S006_RETAINED_FINDINGS) {
      findingLimitReached = true;
      break;
    }

    const lines = splitS006Lines(file.text);
    for (const line of lines) {
      const occupiedLineRanges: Array<{ start: number; end: number }> = [];
      for (const detector of S006_DETECTOR_REGISTRY) {
        if (detector.id === 'private-key-block') {
          continue;
        }

        const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line.text)) !== null) {
          const rawMatch = match[0];
          const matchStart = match.index;
          const matchEnd = matchStart + rawMatch.length;
          const absoluteStart = line.offset + matchStart;
          const absoluteEnd = line.offset + matchEnd;

          if (
            rawMatch.length === 0 ||
            occupiedLineRanges.some(range => rangesOverlap(matchStart, matchEnd, range.start, range.end)) ||
            privateKeyRanges.some(range => rangesOverlap(absoluteStart, absoluteEnd, range.start, range.end))
          ) {
            continue;
          }

          const finding = buildS006Finding(file.path, context, detector, rawMatch, fingerprintRun, line.lineNumber);
          if (retainS006Finding(findings, dedupeKeys, finding)) {
            occupiedLineRanges.push({ start: matchStart, end: matchEnd });
          }
          if (findings.length >= MAX_S006_RETAINED_FINDINGS) {
            findingLimitReached = true;
            break;
          }
        }

        if (findingLimitReached) {
          break;
        }
      }

      if (findingLimitReached) {
        break;
      }
    }

    if (findingLimitReached) {
      break;
    }
  }

  if (findingLimitReached) {
    warnings.push(buildS006Warning(
      'finding-limit',
      `S006 detector extraction retained first ${MAX_S006_RETAINED_FINDINGS} findings; additional findings were omitted.`,
      true
    ));
  }

  return { findings, warnings };
}

export function analyzeS006SensitiveInformation(repoPath: string): S006SensitiveInformationAnalysisResult {
  const scan = scanS006RepositoryCandidates(repoPath);
  const extraction = extractS006SensitiveInformationFindings(scan.files);
  const warnings = [...scan.warnings, ...extraction.warnings];
  const coverage = {
    ...scan.coverage,
    warnings,
    materiallyWeakened: scan.coverage.materiallyWeakened || extraction.warnings.some(warning => warning.materialToCoverage),
    complete: scan.coverage.complete && extraction.warnings.every(warning => !warning.materialToCoverage)
  };
  const classification = classifyS006DeterministicResult(extraction.findings, coverage);

  return {
    criterionId: 'S006',
    findings: extraction.findings,
    coverage,
    classification,
    warnings
  };
}

export function classifyS006SourceContext(relativePath: string, boundedContent: string = ''): S006FindingContext {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const contentCue = boundedContent.slice(0, 4000).toLowerCase();

  if (/(^|\/)(dist|build|target|coverage|generated|gen|reports?|test-results)(\/|$)|(?:^|\/).*generated.*\./.test(normalized)) {
    return 'generated_content';
  }
  if (/\b(?:auto-generated|autogenerated|generated by|do not edit|codegen|openapi generator)\b/.test(contentCue)) {
    return 'generated_content';
  }
  if (/(^|\/)(docs?|documentation)(\/|$)|(?:^|\/)(readme|changelog|contributing|license)(?:\.[^.]+)?$/.test(normalized)) {
    return 'documentation';
  }
  if (/(^|\/)(fixtures?|__fixtures__|__tests__|tests?|spec)(\/|$)|(?:test|spec|fixture)\.[^.\/]+$/.test(normalized)) {
    return 'test_fixture';
  }
  if (/\b(?:test fixture|fixture data|for tests only|generated test token|mock token|fake password|dummy password)\b/.test(contentCue)) {
    return 'test_fixture';
  }
  if (/(^|\/)(examples?|samples?)(\/|$)|(?:example|sample|template)\.[^.\/]+$/.test(normalized)) {
    return 'sample_or_example';
  }
  if (/\b(?:example only|sample only|sample configuration|example configuration|template value|replace with your)\b/.test(contentCue)) {
    return 'sample_or_example';
  }
  if (/(^|\/)(\.github|\.gitlab|\.circleci|ci|buildkite|jenkins|deploy|deployment|helm|k8s|kubernetes|terraform)(\/|$)|(?:^|\/)(jenkinsfile|gitlab-ci\.ya?ml|docker-compose\.ci\.ya?ml)$/.test(normalized)) {
    return 'ci_or_deployment_configuration';
  }
  if (/(^|\/)(docker-compose(?:\.[\w-]+)?\.ya?ml|compose(?:\.[\w-]+)?\.ya?ml|dockerfile(?:\.[\w-]+)?|docker\/|dev\/docker\/)|(?:^|\/)\.env(?:\.local|\.docker)?$/.test(normalized)) {
    return 'local_docker_defaults';
  }
  if (
    /(?:^|\/)\.env(?:[.\w-]*)?$/.test(normalized) ||
    /(?:^|\/)(?:application|bootstrap|module-descriptor|package|pom|settings|config|configuration|service|server)(?:[.\w-]*)?\.(?:json|ya?ml|properties|xml|toml|ini|conf|cfg|env|pem|key|crt|tf|tfvars)$/.test(normalized) ||
    /(^|\/)(src|conf|config|configuration|resources?|properties|profiles?|terraform)(\/|$)|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|\.(?:java|js|ts|tsx|jsx|json|ya?ml|properties|xml|sql|sh|conf|cfg|ini|pem|key|crt|tf|tfvars)$/.test(normalized)
  ) {
    return 'production_source_or_configuration';
  }

  return 'unknown';
}

function extractS006PrivateKeyFindings(
  file: S006ScannedCandidateTextFile,
  context: S006FindingContext,
  fingerprintRun: S006FingerprintRun,
  findings: S006SensitiveInformationFinding[],
  dedupeKeys: Set<string>
): S006PrivateKeyRange[] {
  const detector = getS006DetectorById('private-key-block');
  const privateKeyRanges: S006PrivateKeyRange[] = [];
  const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(file.text)) !== null) {
    const rawMatch = match[0];
    if (rawMatch.length === 0) {
      continue;
    }

    const line = getS006LineForOffset(file.text, match.index);
    const finding = buildS006Finding(file.path, context, detector, rawMatch, fingerprintRun, line);
    if (retainS006Finding(findings, dedupeKeys, finding)) {
      privateKeyRanges.push({ start: match.index, end: match.index + rawMatch.length });
    }
    if (findings.length >= MAX_S006_RETAINED_FINDINGS) {
      break;
    }
  }

  return privateKeyRanges;
}

function buildS006Finding(
  filePath: string,
  context: S006FindingContext,
  detector: S006DetectorRegistryEntry,
  rawMatch: string,
  fingerprintRun: S006FingerprintRun,
  line: number
): S006SensitiveInformationFinding {
  const redacted = buildS006RedactedDetectorMatch(detector, rawMatch, fingerprintRun, line);
  const confidence = adjustS006FindingConfidenceForContext(detector, redacted.valueClassification, redacted.confidence, context);
  const baseFinding: Omit<S006SensitiveInformationFinding, 'rationale' | 'statusImpact'> = {
    path: filePath,
    line,
    endLine: redacted.redactedExcerpt.endLine,
    detectorId: redacted.detectorId,
    category: redacted.category,
    context,
    valueClassification: redacted.valueClassification,
    confidence,
    severity: getS006Severity(detector, confidence),
    redactedExcerpt: redacted.redactedExcerpt,
    valueFingerprint: redacted.valueFingerprint
  };
  const statusImpact: S006FindingStatusImpact = isS006DeterministicFailFinding(baseFinding)
    ? 'deterministic_fail'
    : 'manual_review';
  const finding: Omit<S006SensitiveInformationFinding, 'rationale'> = {
    ...baseFinding,
    statusImpact
  };
  return {
    ...finding,
    rationale: buildS006FindingRationale(finding, detector)
  };
}

function retainS006Finding(
  findings: S006SensitiveInformationFinding[],
  dedupeKeys: Set<string>,
  finding: S006SensitiveInformationFinding
): boolean {
  const dedupeKey = [
    finding.detectorId,
    finding.path,
    finding.line ?? '',
    finding.endLine ?? '',
    finding.valueFingerprint.value
  ].join('\0');
  if (dedupeKeys.has(dedupeKey)) {
    return false;
  }
  if (findings.length >= MAX_S006_RETAINED_FINDINGS) {
    return false;
  }

  dedupeKeys.add(dedupeKey);
  findings.push(finding);
  return true;
}

function splitS006Lines(text: string): S006LineWithOffset[] {
  const lines: S006LineWithOffset[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === '' && match.index === text.length) {
      break;
    }
    lines.push({
      text: match[1],
      lineNumber: lines.length + 1,
      offset: match.index
    });
    if (match[2] === '') {
      break;
    }
  }

  return lines;
}

function getS006LineForOffset(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === '\n') {
      line += 1;
    }
  }
  return line;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function formatS006FindingReference(finding: S006SensitiveInformationFinding): string {
  return `${finding.path}${finding.line === undefined ? '' : `:${finding.line}`}:${finding.detectorId}`;
}

function classifyS006DeterministicResult(
  findings: S006SensitiveInformationFinding[],
  coverage: S006ScanCoverage
): S006SensitiveInformationAnalysisResult['classification'] {
  const findingReferences = findings.map(finding => formatS006FindingReference(finding));
  const failFindings = findings.filter(isS006DeterministicFailFinding);

  if (failFindings.length > 0) {
    return {
      status: EvaluationStatus.FAIL,
      reason: `S006 found ${failFindings.length} high-confidence live-looking secret finding${failFindings.length === 1 ? '' : 's'} in production or CI/deployment context.`,
      findingReferences,
      materiallyWeakenedCoverage: coverage.materiallyWeakened
    };
  }

  if (findings.length > 0) {
    return {
      status: EvaluationStatus.MANUAL,
      reason: `S006 retained ${findings.length} sensitive or environment-specific finding${findings.length === 1 ? '' : 's'} that require reviewer judgment based on context, confidence, severity, and redacted evidence.`,
      findingReferences,
      materiallyWeakenedCoverage: coverage.materiallyWeakened
    };
  }

  if (coverage.materiallyWeakened) {
    const materialWarnings = coverage.warnings.filter(warning => warning.materialToCoverage);
    return {
      status: EvaluationStatus.MANUAL,
      reason: `S006 found no retained findings, but scan coverage was materially weakened by ${materialWarnings.length || 'one or more'} bounded traversal, reading, or truncation warning${materialWarnings.length === 1 ? '' : 's'}.`,
      findingReferences,
      materiallyWeakenedCoverage: true
    };
  }

  return {
    status: EvaluationStatus.PASS,
    reason: `S006 found no retained sensitive or environment-specific findings after scanning ${coverage.scannedFiles} of ${coverage.candidateFiles} candidate file${coverage.candidateFiles === 1 ? '' : 's'} (${coverage.scannedBytes} bytes) with no material coverage warnings.`,
    findingReferences,
    materiallyWeakenedCoverage: false
  };
}

function isS006DeterministicFailFinding(
  finding: Pick<S006SensitiveInformationFinding, 'detectorId' | 'confidence' | 'valueClassification' | 'context'>
): boolean {
  const detector = getS006DetectorById(finding.detectorId);
  return (
    detector.statusContributionByConfidence[finding.confidence] === 'fail_candidate' &&
    finding.confidence === 'high' &&
    finding.valueClassification === 'live-looking' &&
    isS006FailCapableContext(finding.context)
  );
}

function isS006FailCapableContext(context: S006FindingContext): boolean {
  return context === 'production_source_or_configuration' || context === 'ci_or_deployment_configuration';
}

function buildS006FindingRationale(
  finding: Omit<S006SensitiveInformationFinding, 'rationale'>,
  detector: S006DetectorRegistryEntry
): string {
  const statusImpact = finding.statusImpact === 'deterministic_fail'
    ? 'deterministic failure candidate'
    : 'manual review candidate';
  const contextNote = isS006FailCapableContext(finding.context)
    ? 'production or CI/deployment context can elevate high-confidence live-looking secrets'
    : 'context limits deterministic failure and preserves the finding for reviewer judgment';

  return `${detector.label} is a ${statusImpact}: category=${finding.category}, context=${finding.context}, confidence=${finding.confidence}, severity=${finding.severity}, valueClassification=${finding.valueClassification}; ${contextNote}; detector-local redaction was applied before retaining evidence.`;
}

function adjustS006FindingConfidenceForContext(
  detector: S006DetectorRegistryEntry,
  valueClassification: S006ValueClassification,
  confidence: S006FindingConfidence,
  context: S006FindingContext
): S006FindingConfidence {
  if (
    detector.id === 'password-secret-assignment' &&
    valueClassification !== 'live-looking' &&
    isS006ContextualManualContext(context)
  ) {
    return 'low';
  }

  return confidence;
}

function isS006ContextualManualContext(context: S006FindingContext): boolean {
  return (
    context === 'documentation' ||
    context === 'test_fixture' ||
    context === 'sample_or_example' ||
    context === 'local_docker_defaults' ||
    context === 'generated_content'
  );
}
