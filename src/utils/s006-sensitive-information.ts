import { createHmac, randomBytes } from 'crypto';

import {
  S006DetectorId,
  S006DetectorRegistryEntry,
  S006FindingConfidence,
  S006FindingContext,
  S006FindingSeverity,
  S006RedactedDetectorMatch,
  S006RunLocalValueFingerprint,
  S006ValueClassification
} from '../types';

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
