import {
  CommandRunner,
  EvaluationStatus,
  S006DetectorRegistryEntry,
  S006FindingConfidence,
  S006FindingContext,
  S006FindingSeverity,
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
  getCompiledS006DetectorPattern,
  getS006DetectorById,
  getS006Confidence,
  getS006Severity,
  S006FingerprintRun
} from './s006-detectors';
import { redactS006SensitiveInformationText } from './s006-detectors';
import {
  runS006GitleaksScan,
  S006GitleaksFinding
} from './s006-gitleaks';
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

export interface S006AnalysisOptions {
  commandRunner?: CommandRunner;
  gitleaksTimeoutMs?: number;
}

const S006_LOCAL_DETECTOR_IDS = ['tenant-host-endpoint', 'private-url', 'local-absolute-path'] as const;
const S006_LINE_DETECTORS = S006_LOCAL_DETECTOR_IDS
  .map(detectorId => getS006DetectorById(detectorId))
  .map(detector => ({
    detector,
    pattern: getCompiledS006DetectorPattern(detector)
  }));

export function extractS006SensitiveInformationFindings(
  files: ReadonlyArray<S006ScannedCandidateTextFile>,
  gitleaksFindings: ReadonlyArray<S006GitleaksFinding> = [],
  fingerprintRun: S006FingerprintRun = createS006FingerprintRun()
): { findings: S006SensitiveInformationFinding[]; warnings: S006ScanWarning[] } {
  const findings: S006SensitiveInformationFinding[] = [];
  const warnings: S006ScanWarning[] = [];
  const dedupeKeys = new Set<string>();
  const scannedTextByPath = new Map(files.map(file => [file.path, file.text]));
  let findingLimitReached = false;

  for (const gitleaksFinding of gitleaksFindings) {
    const finding = buildS006GitleaksFinding(gitleaksFinding, fingerprintRun, scannedTextByPath);
    if (!finding) {
      continue;
    }
    retainS006Finding(findings, dedupeKeys, finding);
    if (findings.length >= MAX_S006_RETAINED_FINDINGS) {
      findingLimitReached = true;
      break;
    }
  }

  for (const file of files) {
    if (findingLimitReached) {
      break;
    }
    const context = classifyS006SourceContext(file.path, file.text);

    const lines = splitS006Lines(file.text);
    for (const line of lines) {
      const occupiedLineRanges: Array<{ start: number; end: number }> = [];
      for (const { detector, pattern } of S006_LINE_DETECTORS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line.text)) !== null) {
          const rawMatch = match[0];
          const matchStart = match.index;
          const matchEnd = matchStart + rawMatch.length;

          if (
            rawMatch.length === 0 ||
            occupiedLineRanges.some(range => rangesOverlap(matchStart, matchEnd, range.start, range.end))
          ) {
            continue;
          }

          if (shouldSuppressS006LineFinding(file.path, context, detector, rawMatch, line.text)) {
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

export async function analyzeS006SensitiveInformation(
  repoPath: string,
  options: S006AnalysisOptions = {}
): Promise<S006SensitiveInformationAnalysisResult> {
  const scan = scanS006RepositoryCandidates(repoPath);
  const gitleaks = await runS006GitleaksScan(repoPath, {
    commandRunner: options.commandRunner,
    timeoutMs: options.gitleaksTimeoutMs
  });
  const extraction = extractS006SensitiveInformationFindings(scan.files, gitleaks.findings);
  const warnings = [...scan.warnings, ...gitleaks.warnings, ...extraction.warnings];
  const scannerWarning = gitleaks.warnings.find(warning => warning.kind === 'scanner-unavailable');
  const coverage = {
    ...scan.coverage,
    warnings: [...warnings],
    materiallyWeakened: scan.coverage.materiallyWeakened || [...gitleaks.warnings, ...extraction.warnings].some(warning => warning.materialToCoverage),
    complete: scan.coverage.complete && [...gitleaks.warnings, ...extraction.warnings].every(warning => !warning.materialToCoverage)
  };
  const classification = classifyS006DeterministicResult(extraction.findings, coverage);

  return {
    criterionId: 'S006',
    findings: extraction.findings,
    scanner: {
      name: 'Gitleaks',
      status: scannerWarning ? 'unavailable' : 'completed',
      findingCount: gitleaks.findings.length,
      warning: scannerWarning
    },
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
  if (/(^|\/)(docs?|documentation)(\/|$)|(?:^|\/)(?:readme|changelog|contributing|license|module_self_evaluation|personal_data_disclosure)(?:\.[^.]+)?$|^[^/]+\.md$/.test(normalized)) {
    return 'documentation';
  }
  if (/(^|\/)(fixtures?|__fixtures__|__tests__|tests?|spec)(\/|$)|(?:test|spec|fixture)\.[^.\/]+$/.test(normalized)) {
    return 'test_fixture';
  }
  if (/\b(?:test fixture|fixture data|for tests only|generated test token|mock token|fake password|dummy password)\b/.test(contentCue)) {
    return 'test_fixture';
  }
  if (/(^|\/)(examples?|samples?)(\/|$)|(?:^|\/)[^/]*(?:example|sample|template)[^/]*\.[^.\/]+$/.test(normalized)) {
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

function shouldSuppressS006LineFinding(
  filePath: string,
  context: S006FindingContext,
  detector: S006DetectorRegistryEntry,
  rawMatch: string,
  lineText: string
): boolean {
  void filePath;
  if (detector.id === 'private-url') {
    return shouldSuppressS006PrivateUrl(context, rawMatch);
  }
  if (detector.id === 'tenant-host-endpoint') {
    return shouldSuppressS006TenantHostEndpoint(rawMatch, lineText);
  }
  return false;
}

function shouldSuppressS006PrivateUrl(context: S006FindingContext, rawMatch: string): boolean {
  if (!['documentation', 'test_fixture', 'sample_or_example', 'local_docker_defaults'].includes(context)) {
    return false;
  }

  const url = parseS006UrlLike(rawMatch);
  const hostname = url?.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]';
}

function shouldSuppressS006TenantHostEndpoint(rawMatch: string, lineText: string): boolean {
  const normalizedMatch = rawMatch.toLowerCase();
  const trimmedLine = lineText.trim();

  if (/^(?:import\s+|package\s+)[a-z_][\w]*(?:\.[a-z_][\w]*){2,};?$/i.test(trimmedLine)) {
    return true;
  }
  if (isS006KnownJavaConfigReference(trimmedLine)) {
    return true;
  }
  if (isS006PublicReferenceUrl(rawMatch)) {
    return true;
  }
  if (/^https?:\/\/(?:dev|docs)\.folio\.org(?:\/|$)/i.test(normalizedMatch)) {
    return true;
  }
  if (/^https?:\/\/github\.com\/folio-org\//i.test(normalizedMatch)) {
    return true;
  }

  return false;
}

function isS006KnownJavaConfigReference(trimmedLine: string): boolean {
  const uncommentedLine = trimmedLine.replace(/^#\s*/, '');
  const keyValueMatch = uncommentedLine.match(/^([\w.-]+)\s*:\s*(.+)$/);
  if (!keyValueMatch) {
    return false;
  }

  const key = keyValueMatch[1];
  const value = keyValueMatch[2].trim();
  return /(?:^|[-_.])(?:serializer|deserializer)$/i.test(key) && isS006JavaPackageReference(value);
}

function isS006JavaPackageReference(value: string): boolean {
  return /^org\.(?:apache|folio|springframework)\.[a-z0-9_.]+;?$/i.test(value);
}

const S006_PUBLIC_REFERENCE_HOSTS = new Set([
  'dev.folio.org',
  'discuss.folio.org',
  'docs.folio.org',
  'folio-org.atlassian.net',
  'folio.org',
  'github.com',
  'issues.folio.org',
  'jdbc.postgresql.org',
  'maven.apache.org',
  'repository.folio.org',
  'wiki.folio.org',
  'www.apache.org'
]);

function isS006PublicReferenceUrl(rawMatch: string): boolean {
  const url = parseS006UrlLike(rawMatch);
  if (!url) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (!S006_PUBLIC_REFERENCE_HOSTS.has(hostname)) {
    return false;
  }

  if (hostname === 'github.com') {
    return /^\/folio-org(?:\/|$)/i.test(url.pathname);
  }

  return true;
}

function parseS006UrlLike(rawMatch: string): URL | null {
  const cleaned = rawMatch.trim().replace(/[.,;:]+$/, '');
  const candidate = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function buildS006GitleaksFinding(
  source: S006GitleaksFinding,
  fingerprintRun: S006FingerprintRun,
  scannedTextByPath: ReadonlyMap<string, string>
): S006SensitiveInformationFinding | undefined {
  const filePath = normalizeS006GitleaksPath(source.File);
  if (!filePath) {
    return undefined;
  }

  const detector = getS006GitleaksDetector(source);
  const context = classifyS006SourceContext(filePath, scannedTextByPath.get(filePath) ?? '');
  const excerptText = buildS006GitleaksRedactedExcerpt(source, detector.redactionPlaceholder);
  const valueClassification = classifyS006GitleaksValue(source, excerptText);
  const confidence = adjustS006FindingConfidenceForContext(
    detector,
    valueClassification,
    getS006GitleaksConfidence(detector, source, valueClassification),
    context
  );
  const severity = getS006Severity(detector, confidence);
  const line = normalizeS006PositiveInteger(source.StartLine);
  const endLine = normalizeS006PositiveInteger(source.EndLine);
  const baseFinding: Omit<S006SensitiveInformationFinding, 'rationale' | 'statusImpact'> = {
    path: filePath,
    line,
    endLine: endLine && line && endLine !== line ? endLine : undefined,
    detectorId: detector.id,
    category: detector.category,
    context,
    valueClassification,
    confidence,
    severity,
    redactedExcerpt: {
      text: excerptText,
      placeholder: detector.redactionPlaceholder,
      multiline: Boolean(endLine && line && endLine > line),
      startLine: line,
      endLine: endLine && line && endLine !== line ? endLine : line
    },
    valueFingerprint: fingerprintRun.fingerprint(source.Fingerprint || [
      source.RuleID,
      source.File,
      source.StartLine,
      source.EndLine,
      excerptText
    ].join(':'))
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
    rationale: buildS006GitleaksFindingRationale(finding, source, detector)
  };
}

function getS006GitleaksDetector(source: S006GitleaksFinding): S006DetectorRegistryEntry {
  if (source.RuleID === 'provider-api-key') {
    return getS006DetectorById('provider-api-key');
  }
  if (source.RuleID === 'private-key-block') {
    return getS006DetectorById('private-key-block');
  }
  if (source.RuleID === 'bearer-or-jwt-token') {
    return getS006DetectorById('bearer-or-jwt-token');
  }
  if (source.RuleID === 'password-secret-assignment') {
    return getS006DetectorById('password-secret-assignment');
  }
  if (source.RuleID === 'credential-url') {
    return getS006DetectorById('credential-url');
  }

  const ruleText = `${source.RuleID ?? ''} ${source.Description ?? ''}`.toLowerCase();
  const matchText = `${source.Match ?? ''} ${source.Secret ?? ''}`;

  if (/\b(?:private[-_ ]?key|pem|rsa|dsa|ecdsa|ed25519)\b/.test(ruleText)) {
    return getS006DetectorById('private-key-block');
  }
  if (/https?:\/\/[^:\s/@]+:[^@\s/]+@/i.test(matchText)) {
    return getS006DetectorById('credential-url');
  }
  if (/\b(?:openai|github|aws|amazon|google|gcp|azure|anthropic|openrouter|api[-_ ]?key|access[-_ ]?key)\b/.test(ruleText)) {
    return getS006DetectorById('provider-api-key');
  }
  if (/\b(?:bearer|jwt|token)\b/.test(ruleText)) {
    return getS006DetectorById('bearer-or-jwt-token');
  }
  return getS006DetectorById('password-secret-assignment');
}

function getS006GitleaksConfidence(
  detector: S006DetectorRegistryEntry,
  source: S006GitleaksFinding,
  valueClassification: S006ValueClassification
): S006FindingConfidence {
  if (valueClassification !== 'live-looking') {
    return getS006Confidence(detector, valueClassification);
  }
  if (source.Entropy !== undefined && source.Entropy < 3) {
    return detector.defaultConfidence === 'high' ? 'medium' : detector.defaultConfidence;
  }
  return detector.defaultConfidence;
}

function classifyS006GitleaksValue(source: S006GitleaksFinding, excerptText: string): S006ValueClassification {
  const valueText = `${source.RuleID ?? ''} ${source.Description ?? ''} ${excerptText}`.toLowerCase();
  if (source.Entropy !== undefined && source.Entropy < 3) {
    return 'synthetic';
  }
  if (/\b(?:example|sample|dummy|fake|test|fixture|mock|changeme|change[_-]?me|replace[_-]?me)\b/.test(valueText)) {
    return 'synthetic';
  }
  if (/\b(?:redacted|\*{3,}|x{3,})\b/i.test(excerptText)) {
    return 'live-looking';
  }
  return 'live-looking';
}

function buildS006GitleaksRedactedExcerpt(source: S006GitleaksFinding, fallbackPlaceholder: string): string {
  const preferred = source.Match || source.Secret || fallbackPlaceholder;
  if (/REDACTED/.test(preferred)) {
    return preferred;
  }
  const redacted = redactS006SensitiveInformationText(preferred, 700);
  if (!redacted || redacted === preferred) {
    return fallbackPlaceholder;
  }
  return redacted;
}

function normalizeS006GitleaksPath(filePath: string | undefined): string | undefined {
  const normalized = filePath?.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  return normalized || undefined;
}

function normalizeS006PositiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
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

function buildS006GitleaksFindingRationale(
  finding: Omit<S006SensitiveInformationFinding, 'rationale'>,
  source: S006GitleaksFinding,
  detector: S006DetectorRegistryEntry
): string {
  const statusImpact = finding.statusImpact === 'deterministic_fail'
    ? 'deterministic failure candidate'
    : 'manual review candidate';
  const rule = source.RuleID ? `; gitleaksRule=${source.RuleID}` : '';
  const description = source.Description ? `; gitleaksDescription=${source.Description}` : '';
  const contextNote = isS006FailCapableContext(finding.context)
    ? 'production or CI/deployment context can elevate high-confidence live-looking secrets'
    : 'context limits deterministic failure and preserves the finding for reviewer judgment';

  return `${detector.label} from Gitleaks is a ${statusImpact}: category=${finding.category}, context=${finding.context}, confidence=${finding.confidence}, severity=${finding.severity}, valueClassification=${finding.valueClassification}${rule}${description}; ${contextNote}; Gitleaks redaction was applied before retaining evidence.`;
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
    if (text[index] === '\n' || (text[index] === '\r' && text[index + 1] !== '\n')) {
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
    detector.contextualDowngradeWhenNonLive &&
    valueClassification !== 'live-looking' &&
    isS006ContextualManualContext(context)
  ) {
    return detector.contextualDowngradeWhenNonLive;
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
