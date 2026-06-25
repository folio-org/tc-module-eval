import type {
  S004InstallationDocumentationResult,
  S005PersonalDataDisclosureAnalysisResult,
  S006SensitiveInformationAnalysisResult
} from '../types';
import { EvaluationStatus } from '../types';
import {
  buildS006RedactedDetectorMatch,
  classifyS006SourceContext,
  createS006FingerprintRun,
  findFirstS006DetectorMatch,
  getS006DetectorById,
  S006_CONTEXT_LABELS,
  S006_DETECTOR_REGISTRY
} from '../utils/s006-sensitive-information';

describe('S006 detector vocabulary', () => {
  it('models provider-shaped API keys with category, detector id, confidence, and required redaction', () => {
    const detector = getS006DetectorById('provider-api-key');
    const rawMatch = findFirstS006DetectorMatch(detector, 'OPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnopqrstuvwxyz');

    expect(rawMatch).toBe('sk-proj-1234567890abcdefghijklmnopqrstuvwxyz');
    expect(detector).toMatchObject({
      id: 'provider-api-key',
      category: 'provider_api_key',
      defaultConfidence: 'high',
      redactionRequired: true
    });

    const redacted = buildS006RedactedDetectorMatch(detector, rawMatch!, createS006FingerprintRun());
    expect(redacted).toMatchObject({
      detectorId: 'provider-api-key',
      category: 'provider_api_key',
      confidence: 'high',
      severity: 'critical'
    });
    expect(redacted.redactedExcerpt.text).toBe('[REDACTED_PROVIDER_API_KEY]');
    expect(JSON.stringify(redacted)).not.toContain(rawMatch);
  });

  it('models private key blocks as high-confidence multiline secret evidence', () => {
    const detector = getS006DetectorById('private-key-block');
    const rawMatch = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const redacted = buildS006RedactedDetectorMatch(detector, rawMatch, createS006FingerprintRun(), 7);

    expect(findFirstS006DetectorMatch(detector, rawMatch)).toBe(rawMatch);
    expect(redacted).toMatchObject({
      detectorId: 'private-key-block',
      category: 'private_key',
      confidence: 'high',
      severity: 'critical',
      redactedExcerpt: {
        text: '[REDACTED_PRIVATE_KEY_BLOCK]',
        multiline: true,
        startLine: 7,
        endLine: 9
      }
    });
    expect(JSON.stringify(redacted)).not.toContain('MIIEvQIB');
  });

  it('distinguishes credential-bearing URLs from private URLs without credentials', () => {
    const credentialUrl = getS006DetectorById('credential-url');
    const privateUrl = getS006DetectorById('private-url');

    const rawCredentialUrl = 'https://admin:s3cr3t@10.0.0.12:9130/admin';
    const rawPrivateUrl = 'http://10.0.0.12:9130/okapi';

    expect(findFirstS006DetectorMatch(credentialUrl, rawCredentialUrl)).toBe(rawCredentialUrl);
    expect(findFirstS006DetectorMatch(privateUrl, rawCredentialUrl)).toBeUndefined();
    expect(findFirstS006DetectorMatch(privateUrl, rawPrivateUrl)).toBe(rawPrivateUrl);

    const run = createS006FingerprintRun();
    expect(buildS006RedactedDetectorMatch(credentialUrl, rawCredentialUrl, run)).toMatchObject({
      category: 'credential_url',
      confidence: 'high',
      severity: 'critical'
    });
    expect(buildS006RedactedDetectorMatch(privateUrl, rawPrivateUrl, run)).toMatchObject({
      category: 'private_url',
      confidence: 'medium',
      severity: 'medium'
    });
  });

  it('requires every detector to redact at least one matching calibration value before JSON serialization', () => {
    const run = createS006FingerprintRun();

    for (const detector of S006_DETECTOR_REGISTRY) {
      expect(detector.redactor).toEqual(expect.any(Function));
      expect(detector.statusContributionByConfidence).toMatchObject({
        low: expect.any(String),
        medium: expect.any(String),
        high: expect.any(String)
      });
      expect(detector.calibrationCases.length).toBeGreaterThanOrEqual(1);

      const rawMatch = findFirstS006DetectorMatch(detector, detector.calibrationCases[0].rawValue);
      expect(rawMatch).toBeDefined();

      const redacted = buildS006RedactedDetectorMatch(detector, rawMatch!, run);
      const serialized = JSON.stringify(redacted);
      expect(redacted.redactedExcerpt.text).toContain(detector.redactionPlaceholder);
      expect(serialized).not.toContain(rawMatch);
    }
  });

  it('runs table-driven detector calibration cases for classification, confidence, and severity', () => {
    for (const detector of S006_DETECTOR_REGISTRY) {
      for (const calibrationCase of detector.calibrationCases) {
        const rawMatch = findFirstS006DetectorMatch(detector, calibrationCase.rawValue);
        expect(rawMatch).toBeDefined();

        const redacted = buildS006RedactedDetectorMatch(detector, rawMatch!, createS006FingerprintRun());
        expect(redacted.valueClassification).toBe(calibrationCase.expectedValueClassification);
        if (calibrationCase.expectedConfidence) {
          expect(redacted.confidence).toBe(calibrationCase.expectedConfidence);
        }
        if (calibrationCase.expectedSeverity) {
          expect(redacted.severity).toBe(calibrationCase.expectedSeverity);
        }
      }
    }
  });
});

describe('S006 run-local fingerprints', () => {
  it('keeps fingerprints stable within one analysis run and unstable across separate runs', () => {
    const rawValue = 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz';
    const firstRun = createS006FingerprintRun();
    const secondRun = createS006FingerprintRun();

    expect(firstRun.fingerprint(rawValue)).toEqual(firstRun.fingerprint(rawValue));
    expect(firstRun.fingerprint(rawValue)).not.toEqual(secondRun.fingerprint(rawValue));
    expect(firstRun.fingerprint(rawValue)).toMatchObject({
      algorithm: 'hmac-sha256',
      scope: 'run-local',
      length: 24
    });
  });
});

describe('S006 context labels and type exports', () => {
  it('includes all planned context labels', () => {
    expect(S006_CONTEXT_LABELS).toEqual([
      'production_source_or_configuration',
      'ci_or_deployment_configuration',
      'documentation',
      'test_fixture',
      'sample_or_example',
      'local_docker_defaults',
      'generated_content',
      'unknown'
    ]);

    expect(classifyS006SourceContext('src/main/resources/application.yml')).toBe('production_source_or_configuration');
    expect(classifyS006SourceContext('.github/workflows/build.yml')).toBe('ci_or_deployment_configuration');
    expect(classifyS006SourceContext('docs/secrets.md')).toBe('documentation');
    expect(classifyS006SourceContext('src/__tests__/fixtures/token.json')).toBe('test_fixture');
    expect(classifyS006SourceContext('examples/env.ts')).toBe('sample_or_example');
    expect(classifyS006SourceContext('docker-compose.yml')).toBe('local_docker_defaults');
    expect(classifyS006SourceContext('generated/openapi.json')).toBe('generated_content');
    expect(classifyS006SourceContext('unclassified.file')).toBe('unknown');
  });

  it('exports S006 criterion details without weakening S004 or S005 type exports', () => {
    const s004: S004InstallationDocumentationResult = {
      candidates: [],
      classification: {
        status: EvaluationStatus.MANUAL,
        reason: 'needs review',
        strongestSignals: [],
        filesConsidered: [],
        warnings: []
      },
      warnings: []
    };
    const s005: S005PersonalDataDisclosureAnalysisResult = {
      discovery: { status: 'missing', attempts: [], warnings: [] },
      classification: {
        status: EvaluationStatus.FAIL,
        parseState: 'not_parsed',
        reason: 'missing disclosure'
      },
      possibleMismatches: [],
      matchingEvidence: [],
      supportingEvidence: [],
      uncheckedAnswerDetails: [],
      placeholders: [],
      contradictions: [],
      warnings: []
    };
    const s006: S006SensitiveInformationAnalysisResult = {
      criterionId: 'S006',
      findings: [],
      coverage: {
        scannedFiles: 0,
        scannedBytes: 0,
        candidateFiles: 0,
        skippedFiles: [],
        warnings: [],
        materiallyWeakened: false,
        complete: true
      },
      classification: {
        status: EvaluationStatus.PASS,
        reason: 'no findings',
        findingReferences: [],
        materiallyWeakenedCoverage: false
      },
      warnings: []
    };

    expect(s004.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(s005.classification.parseState).toBe('not_parsed');
    expect(s006.criterionId).toBe('S006');
  });
});
