import { createHmac, randomBytes } from 'crypto';

import {
  S006DetectorId,
  S006DetectorRegistryEntry,
  S006FindingConfidence,
  S006FindingSeverity,
  S006DetectorMatch,
  S006RunLocalValueFingerprint,
  S006ValueClassification
} from '../types';
import {
  PRIVATE_KEY_BLOCK_PATTERN,
  PRIVATE_URL_PATTERN,
  URL_CREDENTIAL_PATTERN as CREDENTIAL_URL_PATTERN
} from './redaction';

const PLACEHOLDER_VALUE_PATTERN =
  /^(?:|""|''|``|todo|tbd|n\/a|null|undefined|none|changeme|change[_-]?me|replace[_-]?me|your[_-]?(?:key|token|secret|password)|<[^>]+>|\$\{[^}]+}|%[^%]+%|\{\{[^}]+}}|\*{3,}|x{3,})$/i;
const SYNTHETIC_VALUE_PATTERN = /\b(?:example|sample|dummy|fake|test|fixture|mock|localhost|localdev|changeme|replace-me)\b/i;
const DEFAULT_CREDENTIAL_VALUE_PATTERN = /^(?:admin|postgres|password|root|guest|test|demo)$/i;
const SECRET_ASSIGNMENT_KEY = '\\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|accesskey|refresh[_-]?token|refreshtoken|client[_-]?secret|clientsecret|secret[_-]?access[_-]?key|secretaccesskey)[A-Za-z0-9_.-]*\\b';
const SECRET_ASSIGNMENT_VALUE = `(?:"(?:\\\\.|[^"\\\\\\n]){1,200}"|'(?:\\\\.|[^'\\\\\\n]){1,200}'|[^\\r\\n"'\\\`,;#]{1,200})`;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(`${SECRET_ASSIGNMENT_KEY}\\s*[:=]\\s*${SECRET_ASSIGNMENT_VALUE}`, 'gi');

export const MAX_S006_EXCERPT_BYTES = 700;

export const S006_DETECTOR_REGISTRY: ReadonlyArray<S006DetectorRegistryEntry> = [
  {
    id: 'provider-api-key',
    category: 'provider_api_key',
    label: 'Provider-shaped API key',
    pattern: /\b(?:sk-(?:proj-)?[A-Za-z0-9][A-Za-z0-9._-]{18,}|sk-or-v1-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ya29\.[A-Za-z0-9_-]{20,})\b/g,
    defaultConfidence: 'high',
    severityByConfidence: { low: 'medium', medium: 'high', high: 'critical' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
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
    pattern: PRIVATE_KEY_BLOCK_PATTERN,
    defaultConfidence: 'high',
    severityByConfidence: { low: 'medium', medium: 'high', high: 'critical' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
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
    pattern: /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{20,}|(?:X-Okapi-Token|Okapi-Token)\s*[:=]\s*[A-Za-z0-9._~+/=-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gi,
    defaultConfidence: 'high',
    severityByConfidence: { low: 'low', medium: 'medium', high: 'high' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
    classifyValue: rawMatch => classifySyntheticOrLive(rawMatch),
    calibrationCases: [
      {
        name: 'Bearer token',
        rawValue: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
        expectedValueClassification: 'live-looking',
        expectedConfidence: 'high',
        expectedSeverity: 'high'
      },
      {
        name: 'Okapi token header',
        rawValue: 'X-Okapi-Token: abcdefghijklmnopqrstuvwxyz123456',
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
    pattern: SECRET_ASSIGNMENT_PATTERN,
    defaultConfidence: 'medium',
    severityByConfidence: { low: 'low', medium: 'high', high: 'critical' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
    contextualDowngradeWhenNonLive: 'low',
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
    pattern: CREDENTIAL_URL_PATTERN,
    defaultConfidence: 'high',
    severityByConfidence: { low: 'medium', medium: 'high', high: 'critical' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
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
    pattern: PRIVATE_URL_PATTERN,
    defaultConfidence: 'medium',
    severityByConfidence: { low: 'info', medium: 'medium', high: 'high' },
    statusContributionByConfidence: { low: 'pass_neutral', medium: 'manual_candidate', high: 'manual_candidate' },
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
    defaultConfidence: 'low',
    severityByConfidence: { low: 'low', medium: 'medium', high: 'high' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'fail_candidate' },
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
    defaultConfidence: 'medium',
    severityByConfidence: { low: 'low', medium: 'medium', high: 'high' },
    statusContributionByConfidence: { low: 'pass_neutral', medium: 'manual_candidate', high: 'manual_candidate' },
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
    defaultConfidence: 'low',
    severityByConfidence: { low: 'low', medium: 'medium', high: 'medium' },
    statusContributionByConfidence: { low: 'manual_candidate', medium: 'manual_candidate', high: 'manual_candidate' },
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
const S006_COMPILED_DETECTOR_PATTERNS = new Map(
  S006_DETECTOR_REGISTRY.map(detector => [
    detector.id,
    new RegExp(detector.pattern.source, detector.pattern.flags)
  ])
);

export function getS006DetectorById(detectorId: S006DetectorId): S006DetectorRegistryEntry {
  const detector = S006_DETECTOR_REGISTRY.find(entry => entry.id === detectorId);
  if (!detector) {
    throw new Error(`Unknown S006 detector: ${detectorId}`);
  }
  return detector;
}

export function findFirstS006DetectorMatch(detector: S006DetectorRegistryEntry, input: string): string | undefined {
  const pattern = getCompiledS006DetectorPattern(detector);
  pattern.lastIndex = 0;
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

export function buildS006DetectorMatch(
  detector: S006DetectorRegistryEntry,
  rawMatch: string,
  fingerprintRun: S006FingerprintRun,
  startLine?: number
): S006DetectorMatch {
  const valueClassification = detector.classifyValue(rawMatch);
  const confidence = getS006Confidence(detector, valueClassification);
  const excerptText = boundS006ExcerptText(rawMatch);
  const lineSpan = rawMatch.split(/\r\n|\n|\r/).length;

  return {
    detectorId: detector.id,
    category: detector.category,
    valueClassification,
    confidence,
    severity: getS006Severity(detector, confidence),
    excerpt: {
      text: excerptText,
      multiline: lineSpan > 1,
      startLine,
      endLine: startLine === undefined ? undefined : startLine + lineSpan - 1
    },
    valueFingerprint: fingerprintRun.fingerprint(getS006FingerprintSource(detector, rawMatch))
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

export function getCompiledS006DetectorPattern(detector: S006DetectorRegistryEntry): RegExp {
  const pattern = S006_COMPILED_DETECTOR_PATTERNS.get(detector.id);
  if (!pattern) {
    throw new Error(`Unknown S006 detector: ${detector.id}`);
  }
  return pattern;
}

export function boundS006ExcerptText(input: string): string {
  const buffer = Buffer.from(input);
  return buffer.length > MAX_S006_EXCERPT_BYTES
    ? `${buffer.subarray(0, MAX_S006_EXCERPT_BYTES).toString('utf-8').replace(/\uFFFD$/, '')}...`
    : input;
}

function getS006FingerprintSource(detector: S006DetectorRegistryEntry, rawMatch: string): string {
  if (detector.id === 'password-secret-assignment') {
    return rawMatch.replace(/^[^:=]+[:=]\s*/, '').replace(/^["']|["']$/g, '').trim();
  }
  if (detector.id === 'bearer-or-jwt-token' && /^Bearer\s+/i.test(rawMatch)) {
    return rawMatch.replace(/^Bearer\s+/i, '').trim();
  }
  if (detector.id === 'bearer-or-jwt-token' && /^(?:X-Okapi-Token|Okapi-Token)\s*[:=]/i.test(rawMatch)) {
    return rawMatch.replace(/^(?:X-Okapi-Token|Okapi-Token)\s*[:=]\s*/i, '').trim();
  }
  return rawMatch;
}

function classifyAssignmentValue(rawMatch: string): S006ValueClassification {
  const value = rawMatch.replace(/^[^:=]+[:=]\s*/, '').replace(/^["']|["']$/g, '').trim();
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) {
    return 'placeholder';
  }
  if (DEFAULT_CREDENTIAL_VALUE_PATTERN.test(value) || SYNTHETIC_VALUE_PATTERN.test(value) || value.length < 8) {
    return 'synthetic';
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
