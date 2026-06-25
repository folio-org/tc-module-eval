import { createHmac, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  EvaluationStatus,
  S006DetectorId,
  S006DetectorRegistryEntry,
  S006FindingConfidence,
  S006FindingContext,
  S006FindingSeverity,
  S006RedactedDetectorMatch,
  S006RunLocalValueFingerprint,
  S006ScanCoverage,
  S006ScanWarning,
  S006SensitiveInformationAnalysisResult,
  S006SkippedFile,
  S006ValueClassification
} from '../types';
import { decodeBoundedUtf8, isWithinRepo, readBoundedFileBytes, realPath, relativePosixPath } from './repo-files';

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

const PLACEHOLDER_VALUE_PATTERN =
  /^(?:|""|''|``|todo|tbd|n\/a|null|undefined|none|changeme|change_me|replace_me|your[_-]?(?:key|token|secret|password)|<[^>]+>|\$\{[^}]+}|%[^%]+%|\{\{[^}]+}}|\*{3,}|x{3,})$/i;
const SYNTHETIC_VALUE_PATTERN = /\b(?:example|sample|dummy|fake|test|fixture|mock|localhost|localdev|changeme|replace-me)\b/i;

const BASE64ISH_PATTERN = /^[A-Za-z0-9._~+/=-]{20,}$/;
export const MAX_S006_SCAN_TRAVERSAL_ENTRIES = 5000;
export const MAX_S006_SCAN_CANDIDATE_FILES = 250;
export const MAX_S006_SCAN_BYTES_PER_FILE = 96 * 1024;
export const MAX_S006_SCAN_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_S006_EXCERPT_BYTES = 700;
export const MAX_S006_RETAINED_FINDINGS = 100;
const MAX_S006_RETAINED_SKIPPED_FILES = 250;
const S006_SKIPPED_DIRECTORY_REASONS: ReadonlyMap<string, S006SkippedFile['reason']> = new Map([
  ['.git', 'generated-artifact'],
  ['.hg', 'generated-artifact'],
  ['.svn', 'generated-artifact'],
  ['node_modules', 'dependency-directory'],
  ['bower_components', 'dependency-directory'],
  ['vendor', 'dependency-directory'],
  ['dist', 'generated-artifact'],
  ['build', 'generated-artifact'],
  ['target', 'generated-artifact'],
  ['out', 'generated-artifact'],
  ['.next', 'generated-artifact'],
  ['.turbo', 'generated-artifact'],
  ['.cache', 'generated-artifact'],
  ['.gradle', 'generated-artifact'],
  ['coverage', 'generated-artifact'],
  ['.nyc_output', 'generated-artifact'],
  ['reports', 'generated-artifact'],
  ['report', 'generated-artifact'],
  ['evaluation-reports', 'generated-artifact'],
  ['generated-reports', 'generated-artifact'],
  ['html-report', 'generated-artifact'],
  ['test-results', 'generated-artifact'],
  ['generated', 'generated-artifact'],
  ['gen', 'generated-artifact']
]);
const S006_SUPPORTED_TEXT_FILE_PATTERN =
  /\.(?:bash|cjs|cfg|conf|env|gradle|groovy|ini|java|js|json|jsx|kt|kts|md|mjs|properties|py|rb|sh|sql|toml|ts|tsx|txt|xml|yaml|yml|zsh)$/i;
const S006_SUPPORTED_SPECIAL_FILE_PATTERN =
  /(?:^|\/)(?:\.env(?:[.\w-]*)?|Dockerfile(?:\.[\w-]+)?|docker-compose(?:\.[\w-]+)?\.ya?ml|compose(?:\.[\w-]+)?\.ya?ml|Jenkinsfile|Makefile|\.gitlab-ci\.ya?ml)$/i;
const S006_HIGH_SIGNAL_PATH_PATTERN =
  /(?:^|\/)(?:\.env(?:[.\w-]*)?|\.github\/|\.gitlab\/|\.circleci\/|ci\/|buildkite\/|deploy(?:ment)?\/|helm\/|k8s\/|kubernetes\/|okapi\/|conf\/|config(?:uration)?\/|src\/main\/resources\/|src\/main\/config\/)|(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|docker-compose(?:\.[\w-]+)?\.ya?ml|compose(?:\.[\w-]+)?\.ya?ml|Jenkinsfile|Makefile|\.gitlab-ci\.ya?ml)$/i;
const S006_MATERIAL_TRUNCATED_PATH_PATTERN =
  /(?:^|\/)(?:\.env(?:[.\w-]*)?|\.github\/|\.gitlab\/|\.circleci\/|ci\/|buildkite\/|deploy(?:ment)?\/|helm\/|k8s\/|kubernetes\/|okapi\/|conf\/|config(?:uration)?\/|src\/main\/resources\/|src\/main\/config\/)|(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|docker-compose(?:\.[\w-]+)?\.ya?ml|compose(?:\.[\w-]+)?\.ya?ml|Jenkinsfile|\.gitlab-ci\.ya?ml)$|\.(?:ya?ml|properties)$/i;
const S006_GENERATED_REPORT_PATH_PATTERN =
  /(?:^|\/)(?:reports?|evaluation-reports?|generated-reports?|coverage|html-report|test-results?)(?:\/|$)/i;

export interface S006ScannedCandidateTextFile {
  path: string;
  text: string;
  bytesRead: number;
  truncated: boolean;
  materialToCoverage: boolean;
}

export interface S006RepositoryCandidateScanResult {
  files: S006ScannedCandidateTextFile[];
  coverage: S006ScanCoverage;
  warnings: S006ScanWarning[];
}

export const S006_DETECTOR_REGISTRY: ReadonlyArray<S006DetectorRegistryEntry> = [
  {
    id: 'provider-api-key',
    category: 'provider_api_key',
    label: 'Provider-shaped API key',
    pattern: /\b(?:sk-(?:proj-)?[A-Za-z0-9][A-Za-z0-9._-]{18,}|sk-or-v1-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g,
    redactionRequired: true,
    redactionPlaceholder: '[REDACTED_PROVIDER_API_KEY]',
    defaultConfidence: 'high',
    severityByConfidence: { low: 'medium', medium: 'high', high: 'critical' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
    redactor: () => '[REDACTED_PROVIDER_API_KEY]',
    classifyValue: rawMatch => classifySyntheticOrLive(rawMatch),
    calibrationCases: [
      {
        name: 'OpenAI-shaped project key',
        rawValue: 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
        expectedValueClassification: 'live-looking',
        expectedConfidence: 'high',
        expectedSeverity: 'critical'
      },
      {
        name: 'Synthetic provider key',
        rawValue: 'sk-test-1234567890abcdefghijklmnopqrstuvwxyz',
        expectedValueClassification: 'synthetic',
        expectedConfidence: 'medium',
        expectedSeverity: 'high'
      }
    ]
  },
  {
    id: 'private-key-block',
    category: 'private_key',
    label: 'Private key block',
    pattern: /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]+?-----END \1-----/g,
    redactionRequired: true,
    redactionPlaceholder: '[REDACTED_PRIVATE_KEY_BLOCK]',
    defaultConfidence: 'high',
    severityByConfidence: { low: 'medium', medium: 'high', high: 'critical' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
    redactor: () => '[REDACTED_PRIVATE_KEY_BLOCK]',
    classifyValue: rawMatch => classifySyntheticOrLive(rawMatch),
    calibrationCases: [
      {
        name: 'PEM private key block',
        rawValue: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
        expectedValueClassification: 'live-looking',
        expectedConfidence: 'high',
        expectedSeverity: 'critical'
      }
    ]
  },
  {
    id: 'bearer-or-jwt-token',
    category: 'bearer_or_jwt_token',
    label: 'Bearer or JWT-like token',
    pattern: /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    redactionRequired: true,
    redactionPlaceholder: '[REDACTED_TOKEN]',
    defaultConfidence: 'high',
    severityByConfidence: { low: 'low', medium: 'medium', high: 'high' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
    redactor: rawMatch => (rawMatch.startsWith('Bearer ') ? 'Bearer [REDACTED_TOKEN]' : '[REDACTED_JWT]'),
    classifyValue: rawMatch => classifySyntheticOrLive(rawMatch),
    calibrationCases: [
      {
        name: 'Bearer token',
        rawValue: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
        expectedValueClassification: 'live-looking',
        expectedConfidence: 'high',
        expectedSeverity: 'high'
      }
    ]
  },
  {
    id: 'password-secret-assignment',
    category: 'password_or_secret_assignment',
    label: 'Password, token, or secret assignment',
    pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|refresh[_-]?token)\b\s*[:=]\s*(?:"[^"\n]{1,200}"|'[^'\n]{1,200}'|[^\s"'`,;#]{1,200})/gi,
    redactionRequired: true,
    redactionPlaceholder: '[REDACTED_SECRET_ASSIGNMENT]',
    defaultConfidence: 'medium',
    severityByConfidence: { low: 'low', medium: 'high', high: 'critical' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
    redactor: rawMatch =>
      rawMatch.replace(
        /^(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|refresh[_-]?token)\b\s*[:=]\s*)(?:"[^"\n]{1,200}"|'[^'\n]{1,200}'|[^\s"'`,;#]{1,200})$/i,
        '$1[REDACTED_SECRET_ASSIGNMENT]'
      ),
    classifyValue: rawMatch => classifyAssignmentValue(rawMatch),
    calibrationCases: [
      {
        name: 'Concrete password assignment',
        rawValue: 'password="CorrectHorseBatteryStaple"',
        expectedValueClassification: 'live-looking',
        expectedConfidence: 'medium',
        expectedSeverity: 'high'
      },
      {
        name: 'Placeholder secret assignment',
        rawValue: 'secret=CHANGE_ME',
        expectedValueClassification: 'placeholder',
        expectedConfidence: 'low',
        expectedSeverity: 'low'
      }
    ]
  },
  {
    id: 'credential-url',
    category: 'credential_url',
    label: 'Credential-bearing URL',
    pattern: /\bhttps?:\/\/[^:\s/@]+:[^@\s/]+@[^\s"'`<>)]*/gi,
    redactionRequired: true,
    redactionPlaceholder: '[REDACTED_CREDENTIAL_URL]',
    defaultConfidence: 'high',
    severityByConfidence: { low: 'medium', medium: 'high', high: 'critical' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
    redactor: () => '[REDACTED_CREDENTIAL_URL]',
    classifyValue: rawMatch => classifySyntheticOrLive(rawMatch),
    calibrationCases: [
      {
        name: 'Authenticated internal URL',
        rawValue: 'https://admin:s3cr3t@10.0.0.12:9130/admin',
        expectedValueClassification: 'live-looking',
        expectedConfidence: 'high',
        expectedSeverity: 'critical'
      }
    ]
  },
  {
    id: 'private-url',
    category: 'private_url',
    label: 'Private URL without embedded credentials',
    pattern: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|[^/\s"'`<>)]*\.(?:internal|local|corp|lan))(?::\d+)?(?:\/[^\s"'`<>)]*)?/gi,
    redactionRequired: true,
    redactionPlaceholder: '[REDACTED_PRIVATE_URL]',
    defaultConfidence: 'medium',
    severityByConfidence: { low: 'info', medium: 'medium', high: 'high' },
    statusContributionByConfidence: { low: 'pass_neutral', medium: 'manual_candidate', high: 'manual_candidate' },
    redactor: () => '[REDACTED_PRIVATE_URL]',
    classifyValue: rawMatch => classifySyntheticOrLive(rawMatch),
    calibrationCases: [
      {
        name: 'Private RFC1918 URL without credentials',
        rawValue: 'http://10.0.0.12:9130/okapi',
        expectedValueClassification: 'live-looking',
        expectedConfidence: 'medium',
        expectedSeverity: 'medium'
      },
      {
        name: 'Localhost development URL',
        rawValue: 'http://localhost:9130/okapi',
        expectedValueClassification: 'synthetic',
        expectedConfidence: 'medium',
        expectedSeverity: 'medium'
      }
    ]
  },
  {
    id: 'environment-file',
    category: 'environment_file',
    label: 'Environment file path',
    pattern: /(?:^|\/)\.env(?:[.\w-]*)?/g,
    redactionRequired: true,
    redactionPlaceholder: '[REDACTED_ENV_FILE_PATH]',
    defaultConfidence: 'low',
    severityByConfidence: { low: 'low', medium: 'medium', high: 'high' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
    redactor: () => '[REDACTED_ENV_FILE_PATH]',
    classifyValue: rawMatch => (/\b(?:example|sample|template|dist)\b/i.test(rawMatch) ? 'synthetic' : 'live-looking'),
    calibrationCases: [
      {
        name: 'Production env file',
        rawValue: '.env.production',
        expectedValueClassification: 'live-looking',
        expectedConfidence: 'low',
        expectedSeverity: 'low'
      },
      {
        name: 'Example env file',
        rawValue: '.env.example',
        expectedValueClassification: 'synthetic',
        expectedConfidence: 'low',
        expectedSeverity: 'low'
      }
    ]
  },
  {
    id: 'tenant-host-endpoint',
    category: 'tenant_or_host_endpoint',
    label: 'Tenant or host endpoint',
    pattern: /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:okapi|folio|tenant|prod|stage|staging|kafka|postgres|redis|database|db)[a-z0-9.-]*\.(?:edu|org|com|net|internal|local)(?::\d+)?(?:\/[^\s"'`<>)]*)?/gi,
    redactionRequired: true,
    redactionPlaceholder: '[REDACTED_TENANT_OR_HOST_ENDPOINT]',
    defaultConfidence: 'medium',
    severityByConfidence: { low: 'low', medium: 'medium', high: 'high' },
    statusContributionByConfidence: { low: 'pass_neutral', medium: 'manual_candidate', high: 'manual_candidate' },
    redactor: () => '[REDACTED_TENANT_OR_HOST_ENDPOINT]',
    classifyValue: rawMatch => classifySyntheticOrLive(rawMatch),
    calibrationCases: [
      {
        name: 'Production-looking Okapi endpoint',
        rawValue: 'https://okapi-prod.library.example.edu',
        expectedValueClassification: 'synthetic',
        expectedConfidence: 'medium',
        expectedSeverity: 'medium'
      }
    ]
  },
  {
    id: 'local-absolute-path',
    category: 'local_absolute_path',
    label: 'Local absolute path',
    pattern: /(?:\/Users\/[A-Za-z0-9._/-]+|\/home\/[A-Za-z0-9._/-]+|\/var\/[A-Za-z0-9._/-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._\\-]+)/g,
    redactionRequired: true,
    redactionPlaceholder: '[REDACTED_LOCAL_ABSOLUTE_PATH]',
    defaultConfidence: 'low',
    severityByConfidence: { low: 'low', medium: 'medium', high: 'medium' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'manual_candidate' },
    redactor: () => '[REDACTED_LOCAL_ABSOLUTE_PATH]',
    classifyValue: rawMatch => classifySyntheticOrLive(rawMatch),
    calibrationCases: [
      {
        name: 'Mac user path',
        rawValue: '/Users/alice/work/folio/private-config.yml',
        expectedValueClassification: 'live-looking',
        expectedConfidence: 'low',
        expectedSeverity: 'low'
      }
    ]
  }
];

export function getS006DetectorById(detectorId: S006DetectorId): S006DetectorRegistryEntry {
  const detector = S006_DETECTOR_REGISTRY.find(entry => entry.id === detectorId);
  if (!detector) {
    throw new Error(`Unknown S006 detector: ${detectorId}`);
  }
  return detector;
}

export function findFirstS006DetectorMatch(detector: S006DetectorRegistryEntry, input: string): string | undefined {
  const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
  const match = pattern.exec(input);
  return match?.[0];
}

export interface S006FingerprintRun {
  fingerprint(rawValue: string): S006RunLocalValueFingerprint;
}

export function createS006FingerprintRun(key: Buffer = randomBytes(32)): S006FingerprintRun {
  return {
    fingerprint(rawValue: string): S006RunLocalValueFingerprint {
      const value = createHmac('sha256', key).update(rawValue).digest('hex').slice(0, 24);
      return {
        algorithm: 'hmac-sha256',
        scope: 'run-local',
        value,
        length: value.length
      };
    }
  };
}

export function buildS006RedactedDetectorMatch(
  detector: S006DetectorRegistryEntry,
  rawMatch: string,
  fingerprintRun: S006FingerprintRun,
  startLine?: number
): S006RedactedDetectorMatch {
  const valueClassification = detector.classifyValue(rawMatch);
  const confidence = getS006Confidence(detector, valueClassification);
  const redactedText = detector.redactor(rawMatch);
  const lineSpan = rawMatch.split(/\r?\n/).length;

  return {
    detectorId: detector.id,
    category: detector.category,
    valueClassification,
    confidence,
    severity: getS006Severity(detector, confidence),
    redactedExcerpt: {
      text: redactedText,
      placeholder: detector.redactionPlaceholder,
      multiline: lineSpan > 1,
      startLine,
      endLine: startLine === undefined ? undefined : startLine + lineSpan - 1
    },
    valueFingerprint: fingerprintRun.fingerprint(rawMatch)
  };
}

export function scanS006RepositoryCandidates(repoPath: string): S006RepositoryCandidateScanResult {
  const repoRoot = realPath(repoPath);
  if (!repoRoot) {
    const warning = buildS006Warning(
      'traversal-limit',
      'Unable to resolve repository path while scanning S006 candidate files.',
      true
    );
    const coverage = buildS006Coverage(0, 0, 0, [], [warning], true, false);
    return { files: [], coverage, warnings: [warning] };
  }

  const discovery = collectBoundedS006EvidenceCandidates(repoRoot);
  const warnings = [...discovery.warnings];
  const skippedFiles = [...discovery.skippedFiles];
  const candidateFiles = discovery.files.slice(0, MAX_S006_SCAN_CANDIDATE_FILES);
  const files: S006ScannedCandidateTextFile[] = [];
  let scannedBytes = 0;
  let stoppedByByteLimit = false;

  if (discovery.files.length > MAX_S006_SCAN_CANDIDATE_FILES) {
    const truncatedCandidates = discovery.files.slice(MAX_S006_SCAN_CANDIDATE_FILES);
    const material = truncatedCandidates.some(candidatePath => isS006HighSignalPath(relativePosixPath(repoRoot, candidatePath)));
    warnings.push(buildS006Warning(
      'candidate-limit',
      `S006 candidate discovery retained first ${MAX_S006_SCAN_CANDIDATE_FILES} supported files; additional candidates were not scanned.`,
      material || discovery.truncatedBeforePriorityComplete
    ));
  }

  for (let index = 0; index < candidateFiles.length; index++) {
    const candidatePath = candidateFiles[index];
    const relativePath = relativePosixPath(repoRoot, candidatePath);
    if (!isWithinRepo(repoRoot, candidatePath)) {
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'outside-repository',
        materialToCoverage: true
      });
      continue;
    }

    if (scannedBytes >= MAX_S006_SCAN_TOTAL_BYTES) {
      stoppedByByteLimit = true;
      const material = candidateFiles.slice(index).some(laterCandidate =>
        isS006HighSignalPath(relativePosixPath(repoRoot, laterCandidate))
      );
      warnings.push(buildS006Warning(
        'byte-limit',
        `S006 candidate reading stopped at the ${MAX_S006_SCAN_TOTAL_BYTES}-byte total scan cap.`,
        material
      ));
      break;
    }

    const readResult = readBoundedS006CandidateText(
      candidatePath,
      relativePath,
      MAX_S006_SCAN_TOTAL_BYTES - scannedBytes
    );

    if (readResult.status === 'binary') {
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'binary',
        materialToCoverage: false
      });
      continue;
    }

    if (readResult.status === 'read-error') {
      const materialToCoverage = isS006MaterialCoveragePath(relativePath);
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'read-error',
        message: readResult.message,
        materialToCoverage
      });
      warnings.push(buildS006Warning(
        'unreadable-file',
        `Unable to read S006 candidate file ${relativePath}.`,
        materialToCoverage,
        relativePath
      ));
      continue;
    }

    if (readResult.status === 'empty') {
      files.push({
        path: relativePath,
        text: '',
        bytesRead: 0,
        truncated: false,
        materialToCoverage: false
      });
      continue;
    }

    scannedBytes += readResult.bytesRead;
    files.push({
      path: relativePath,
      text: readResult.text,
      bytesRead: readResult.bytesRead,
      truncated: readResult.truncated,
      materialToCoverage: readResult.materialToCoverage
    });

    if (readResult.truncated) {
      warnings.push(buildS006Warning(
        'file-truncated',
        `S006 candidate scanning truncated ${relativePath} to ${readResult.bytesRead} bytes.`,
        readResult.materialToCoverage,
        relativePath
      ));
    }

    if (readResult.totalCapReached) {
      stoppedByByteLimit = true;
      const material = candidateFiles.slice(index + 1).some(laterCandidate =>
        isS006HighSignalPath(relativePosixPath(repoRoot, laterCandidate))
      ) || readResult.materialToCoverage;
      warnings.push(buildS006Warning(
        'byte-limit',
        `S006 candidate reading stopped at the ${MAX_S006_SCAN_TOTAL_BYTES}-byte total scan cap.`,
        material
      ));
      break;
    }
  }

  const materiallyWeakened = warnings.some(warning => warning.materialToCoverage) ||
    skippedFiles.some(skippedFile => skippedFile.materialToCoverage);
  const complete = !discovery.truncated &&
    discovery.files.length <= MAX_S006_SCAN_CANDIDATE_FILES &&
    !stoppedByByteLimit &&
    !materiallyWeakened;

  const coverage = buildS006Coverage(
    files.length,
    scannedBytes,
    discovery.files.length,
    skippedFiles,
    warnings,
    materiallyWeakened,
    complete
  );

  return {
    files,
    coverage,
    warnings
  };
}

export function analyzeS006SensitiveInformation(repoPath: string): S006SensitiveInformationAnalysisResult {
  const scan = scanS006RepositoryCandidates(repoPath);
  const status = scan.coverage.complete ? EvaluationStatus.PASS : EvaluationStatus.MANUAL;

  return {
    criterionId: 'S006',
    findings: [],
    coverage: scan.coverage,
    classification: {
      status,
      reason: scan.coverage.complete
        ? 'No S006 detector findings were produced by the bounded candidate scan.'
        : scan.coverage.materiallyWeakened
        ? 'S006 scan coverage was materially weakened by bounded candidate discovery or reading limits.'
        : 'S006 scan coverage was incomplete after bounded candidate discovery or reading limits.',
      findingReferences: [],
      materiallyWeakenedCoverage: scan.coverage.materiallyWeakened
    },
    warnings: scan.warnings
  };
}

export function getS006Confidence(
  detector: S006DetectorRegistryEntry,
  valueClassification: S006ValueClassification
): S006FindingConfidence {
  if (valueClassification === 'placeholder') {
    return 'low';
  }
  if (valueClassification === 'synthetic' && detector.defaultConfidence === 'high') {
    return 'medium';
  }
  return detector.defaultConfidence;
}

export function getS006Severity(
  detector: S006DetectorRegistryEntry,
  confidence: S006FindingConfidence
): S006FindingSeverity {
  return detector.severityByConfidence[confidence];
}

export function classifyS006SourceContext(relativePath: string): S006FindingContext {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();

  if (/(^|\/)(dist|build|target|coverage|generated|gen|reports?|test-results)(\/|$)|(?:^|\/).*generated.*\./.test(normalized)) {
    return 'generated_content';
  }
  if (/(^|\/)(docs?|documentation)(\/|$)|(?:^|\/)(readme|changelog|contributing|license)(?:\.[^.]+)?$/.test(normalized)) {
    return 'documentation';
  }
  if (/(^|\/)(fixtures?|__fixtures__|__tests__|tests?|spec)(\/|$)|(?:test|spec|fixture)\.[^.\/]+$/.test(normalized)) {
    return 'test_fixture';
  }
  if (/(^|\/)(examples?|samples?)(\/|$)|(?:example|sample|template)\.[^.\/]+$/.test(normalized)) {
    return 'sample_or_example';
  }
  if (/(^|\/)(\.github|\.gitlab|\.circleci|ci|buildkite|jenkins|deploy|deployment|helm|k8s|kubernetes|terraform)(\/|$)|(?:^|\/)(jenkinsfile|gitlab-ci\.ya?ml|docker-compose\.ci\.ya?ml)$/.test(normalized)) {
    return 'ci_or_deployment_configuration';
  }
  if (/(^|\/)(docker-compose\.ya?ml|dockerfile|docker\/|dev\/docker\/)|(?:^|\/)\.env(?:\.local|\.docker)?$/.test(normalized)) {
    return 'local_docker_defaults';
  }
  if (/(^|\/)(src|conf|config|configuration|resources?|properties|profiles?)(\/|$)|\.(?:java|js|ts|tsx|jsx|json|ya?ml|properties|xml|sql|sh|conf|cfg|ini)$/.test(normalized)) {
    return 'production_source_or_configuration';
  }

  return 'unknown';
}

function collectBoundedS006EvidenceCandidates(repoPath: string): {
  files: string[];
  truncated: boolean;
  truncatedBeforePriorityComplete: boolean;
  skippedFiles: S006SkippedFile[];
  warnings: S006ScanWarning[];
} {
  const files: string[] = [];
  const skippedFiles: S006SkippedFile[] = [];
  const warnings: S006ScanWarning[] = [];
  let truncated = false;
  let visitedEntries = 0;

  const walk = (currentPath: string): void => {
    if (visitedEntries >= MAX_S006_SCAN_TRAVERSAL_ENTRIES) {
      truncated = true;
      return;
    }
    visitedEntries += 1;

    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch {
      const relativePath = relativePosixPath(repoPath, currentPath);
      const materialToCoverage = isS006MaterialCoveragePath(relativePath);
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'read-error',
        message: 'Unable to inspect path while discovering S006 candidate files.',
        materialToCoverage
      });
      return;
    }

    const relativePath = relativePosixPath(repoPath, currentPath);
    if (stats.isSymbolicLink()) {
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'unsupported-file',
        message: 'Symbolic links are not followed during S006 candidate scanning.',
        materialToCoverage: false
      });
      return;
    }

    if (stats.isFile()) {
      const candidateDecision = classifyS006CandidatePath(relativePath);
      if (candidateDecision.eligible) {
        files.push(currentPath);
        return;
      }
      if (candidateDecision.materialUnsupported) {
        pushS006SkippedFile(skippedFiles, {
          path: relativePath,
          reason: 'unsupported-file',
          message: 'Unsupported high-signal S006 candidate path.',
          materialToCoverage: true
        });
        warnings.push(buildS006Warning(
          'unsupported-high-signal-file',
          `Unsupported high-signal S006 candidate file ${relativePath} was not scanned.`,
          true,
          relativePath
        ));
      }
      return;
    }

    if (!stats.isDirectory()) {
      return;
    }

    const directoryName = path.basename(currentPath);
    const skippedReason = S006_SKIPPED_DIRECTORY_REASONS.get(directoryName);
    if (skippedReason && currentPath !== repoPath) {
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: skippedReason,
        materialToCoverage: isS006HighSignalPath(relativePath)
      });
      return;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(currentPath).sort((left, right) => left.localeCompare(right));
    } catch {
      const materialToCoverage = isS006MaterialCoveragePath(relativePath);
      pushS006SkippedFile(skippedFiles, {
        path: relativePath,
        reason: 'read-error',
        message: 'Unable to read directory while discovering S006 candidate files.',
        materialToCoverage
      });
      if (materialToCoverage) {
        warnings.push(buildS006Warning(
          'unreadable-file',
          `Unable to read high-signal S006 candidate directory ${relativePath}.`,
          true,
          relativePath
        ));
      }
      return;
    }

    for (const entry of entries) {
      walk(path.join(currentPath, entry));
      if (truncated) {
        return;
      }
    }
  };

  walk(repoPath);
  if (truncated) {
    warnings.push(buildS006Warning(
      'traversal-limit',
      `S006 candidate discovery reached the ${MAX_S006_SCAN_TRAVERSAL_ENTRIES}-entry traversal cap; additional paths were not inspected.`,
      true
    ));
  }

  const prioritizedFiles = prioritizeS006Candidates(repoPath, files);
  const truncatedBeforePriorityComplete = prioritizedFiles
    .slice(MAX_S006_SCAN_CANDIDATE_FILES)
    .some(filePath => isS006HighSignalPath(relativePosixPath(repoPath, filePath)));

  return {
    files: prioritizedFiles,
    truncated,
    truncatedBeforePriorityComplete,
    skippedFiles,
    warnings
  };
}

function classifyS006CandidatePath(relativePath: string): { eligible: boolean; materialUnsupported: boolean } {
  const normalized = relativePath.replace(/\\/g, '/');
  if (S006_GENERATED_REPORT_PATH_PATTERN.test(normalized)) {
    return { eligible: false, materialUnsupported: false };
  }
  if (S006_SUPPORTED_SPECIAL_FILE_PATTERN.test(normalized) || S006_SUPPORTED_TEXT_FILE_PATTERN.test(normalized)) {
    return { eligible: true, materialUnsupported: false };
  }

  return {
    eligible: false,
    materialUnsupported: isS006HighSignalPath(normalized)
  };
}

function prioritizeS006Candidates(repoPath: string, files: string[]): string[] {
  return files
    .map(filePath => {
      const relativePath = relativePosixPath(repoPath, filePath);
      return {
        filePath,
        relativePath,
        priority: s006CandidatePriority(relativePath)
      };
    })
    .sort((left, right) => left.priority - right.priority || left.relativePath.localeCompare(right.relativePath))
    .map(candidate => candidate.filePath);
}

function s006CandidatePriority(relativePath: string): number {
  const normalized = relativePath.replace(/\\/g, '/');
  if (/(?:^|\/)\.env(?:[.\w-]*)?$/i.test(normalized)) {
    return 0;
  }
  if (/(?:^|\/)(?:\.github\/|\.gitlab\/|\.circleci\/|ci\/|buildkite\/|Jenkinsfile|\.gitlab-ci\.ya?ml)/i.test(normalized)) {
    return 1;
  }
  if (/(?:^|\/)(?:deploy(?:ment)?\/|helm\/|k8s\/|kubernetes\/|okapi\/|conf\/|config(?:uration)?\/|src\/main\/resources\/|src\/main\/config\/)/i.test(normalized)) {
    return 2;
  }
  if (/(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|docker-compose(?:\.[\w-]+)?\.ya?ml|compose(?:\.[\w-]+)?\.ya?ml)$/i.test(normalized)) {
    return 2;
  }
  if (/(?:^|\/)(?:src\/|lib\/|app\/)/i.test(normalized)) {
    return 3;
  }
  if (/(?:^|\/)(?:docs?|documentation|README(?:\.[^.]+)?$)/i.test(normalized)) {
    return 4;
  }
  return 5;
}

function readBoundedS006CandidateText(
  filePath: string,
  relativePath: string,
  remainingTotalBytes: number
): { status: 'text'; text: string; bytesRead: number; truncated: boolean; totalCapReached: boolean; materialToCoverage: boolean } |
  { status: 'empty' } |
  { status: 'binary' } |
  { status: 'read-error'; message: string } {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size === 0 || remainingTotalBytes <= 0) {
      return { status: 'empty' };
    }

    const bytesToRead = Math.min(stats.size, MAX_S006_SCAN_BYTES_PER_FILE, remainingTotalBytes);
    const slice = readBoundedFileBytes(filePath, bytesToRead);
    if (isS006BinaryBuffer(slice)) {
      return { status: 'binary' };
    }

    const truncated = stats.size > bytesToRead;
    const materialToCoverage = truncated && isS006MaterialCoveragePath(relativePath);
    return {
      status: 'text',
      text: decodeBoundedUtf8(slice, truncated),
      bytesRead: slice.length,
      truncated,
      totalCapReached: stats.size > remainingTotalBytes,
      materialToCoverage
    };
  } catch (error) {
    return {
      status: 'read-error',
      message: boundedS006Message(error instanceof Error ? error.message : String(error))
    };
  }
}

function isS006HighSignalPath(relativePath: string): boolean {
  return S006_HIGH_SIGNAL_PATH_PATTERN.test(relativePath.replace(/\\/g, '/'));
}

function isS006MaterialCoveragePath(relativePath: string): boolean {
  return S006_MATERIAL_TRUNCATED_PATH_PATTERN.test(relativePath.replace(/\\/g, '/'));
}

function isS006BinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 1024);
  for (let index = 0; index < sampleLength; index++) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function pushS006SkippedFile(skippedFiles: S006SkippedFile[], skippedFile: S006SkippedFile): void {
  if (skippedFiles.length >= MAX_S006_RETAINED_SKIPPED_FILES) {
    return;
  }
  skippedFiles.push(skippedFile);
}

function buildS006Warning(
  kind: S006ScanWarning['kind'],
  message: string,
  materialToCoverage: boolean,
  warningPath?: string
): S006ScanWarning {
  return {
    kind,
    message: boundedS006Message(message),
    path: warningPath,
    materialToCoverage
  };
}

function buildS006Coverage(
  scannedFiles: number,
  scannedBytes: number,
  candidateFiles: number,
  skippedFiles: S006SkippedFile[],
  warnings: S006ScanWarning[],
  materiallyWeakened: boolean,
  complete: boolean
): S006ScanCoverage {
  return {
    scannedFiles,
    scannedBytes,
    candidateFiles,
    skippedFiles,
    warnings,
    materiallyWeakened,
    complete
  };
}

function boundedS006Message(input: string): string {
  return input.length > MAX_S006_EXCERPT_BYTES ? `${input.slice(0, MAX_S006_EXCERPT_BYTES)}...` : input;
}

function classifyAssignmentValue(rawMatch: string): S006ValueClassification {
  const value = rawMatch.replace(/^[^:=]+[:=]\s*/, '').replace(/^["']|["']$/g, '').trim();
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) {
    return 'placeholder';
  }
  if (SYNTHETIC_VALUE_PATTERN.test(value) || value.length < 8) {
    return 'synthetic';
  }
  if (BASE64ISH_PATTERN.test(value)) {
    return 'live-looking';
  }
  return 'live-looking';
}

function classifySyntheticOrLive(rawMatch: string): S006ValueClassification {
  const normalized = rawMatch.trim();
  if (PLACEHOLDER_VALUE_PATTERN.test(normalized)) {
    return 'placeholder';
  }
  if (SYNTHETIC_VALUE_PATTERN.test(normalized)) {
    return 'synthetic';
  }
  return 'live-looking';
}
