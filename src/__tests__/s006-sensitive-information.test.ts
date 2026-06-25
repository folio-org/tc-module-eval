import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  MAX_S006_SCAN_BYTES_PER_FILE,
  MAX_S006_SCAN_CANDIDATE_FILES,
  MAX_S006_SCAN_TOTAL_BYTES,
  scanS006RepositoryCandidates,
  S006_CONTEXT_LABELS,
  S006_DETECTOR_REGISTRY
} from '../utils/s006-sensitive-information';

function createTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 's006-sensitive-'));
}

function writeRepoFile(repoPath: string, relativePath: string, content: string = ''): void {
  const absolutePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function writeRepoBinaryFile(repoPath: string, relativePath: string, content: Buffer): void {
  const absolutePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

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

describe('S006 bounded repository candidate scanning', () => {
  let repoPath: string;

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('scans a small supported repository with complete coverage data and repo-relative paths', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'README.md', '# Clean module\n');
    writeRepoFile(repoPath, 'src/main/java/org/folio/App.java', 'class App {}\n');
    writeRepoFile(repoPath, 'src/main/resources/application.yml', 'server:\n  port: 8081\n');
    writeRepoFile(repoPath, 'package.json', '{"scripts":{"test":"jest"}}\n');

    const result = scanS006RepositoryCandidates(repoPath);
    const scannedPaths = result.files.map(file => file.path);

    expect(result.coverage).toMatchObject({
      scannedFiles: 4,
      candidateFiles: 4,
      materiallyWeakened: false,
      complete: true
    });
    expect(scannedPaths).toEqual([
      'src/main/resources/application.yml',
      'src/main/java/org/folio/App.java',
      'README.md',
      'package.json'
    ]);
    expect(result.coverage.scannedBytes).toBeGreaterThan(0);
    expect([...scannedPaths, ...result.coverage.skippedFiles.map(file => file.path)]
      .every(scannedPath => !path.isAbsolute(scannedPath))).toBe(true);
  });

  it('treats common S006 text, config, Docker, CI, Compose, and env files as eligible candidates', () => {
    repoPath = createTempRepo();
    const expectedPaths = [
      '.env',
      '.github/workflows/build.yml',
      'Dockerfile',
      'docker-compose.yml',
      'README.md',
      'src/main/java/org/folio/App.java',
      'src/main/js/app.js',
      'src/main/ts/app.ts',
      'src/main/resources/config.json',
      'src/main/resources/application.yaml',
      'src/main/resources/log4j.xml',
      'src/main/resources/application.properties',
      'sql/init.sql',
      'scripts/start.sh'
    ];
    for (const candidatePath of expectedPaths) {
      writeRepoFile(repoPath, candidatePath, `${candidatePath}\n`);
    }

    const result = scanS006RepositoryCandidates(repoPath);

    expect(result.files.map(file => file.path).sort()).toEqual(expectedPaths.sort());
    expect(result.coverage.complete).toBe(true);
  });

  it('skips binary files, symlinks, dependency directories, build output, coverage output, VCS metadata, and generated reports', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'src/main/resources/application.yml', 'okapi: http://localhost:9130\n');
    writeRepoBinaryFile(repoPath, 'src/main/resources/binary.yml', Buffer.from([0, 1, 2, 3]));
    writeRepoFile(repoPath, 'node_modules/pkg/config.yml', 'ignored: true\n');
    writeRepoFile(repoPath, 'build/config.yml', 'ignored: true\n');
    writeRepoFile(repoPath, 'coverage/config.yml', 'ignored: true\n');
    writeRepoFile(repoPath, '.git/config', '[core]\n');
    writeRepoFile(repoPath, 'generated-reports/config.yml', 'ignored: true\n');
    try {
      fs.symlinkSync(path.join(repoPath, 'src/main/resources/application.yml'), path.join(repoPath, 'linked.yml'));
    } catch {
      // Some filesystems disable symlink creation in tests; the rest of this test still covers skip safety.
    }

    const result = scanS006RepositoryCandidates(repoPath);
    const scannedPaths = result.files.map(file => file.path);

    expect(scannedPaths).toEqual(['src/main/resources/application.yml']);
    expect(result.coverage.skippedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/main/resources/binary.yml', reason: 'binary', materialToCoverage: false }),
      expect.objectContaining({ path: 'node_modules', reason: 'dependency-directory', materialToCoverage: false }),
      expect.objectContaining({ path: 'build', reason: 'generated-artifact', materialToCoverage: false }),
      expect.objectContaining({ path: 'coverage', reason: 'generated-artifact', materialToCoverage: false }),
      expect.objectContaining({ path: '.git', reason: 'generated-artifact', materialToCoverage: false }),
      expect.objectContaining({ path: 'generated-reports', reason: 'generated-artifact', materialToCoverage: false })
    ]));
    if (fs.existsSync(path.join(repoPath, 'linked.yml'))) {
      expect(result.coverage.skippedFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'linked.yml', reason: 'unsupported-file', materialToCoverage: false })
      ]));
    }
  });

  it('truncates oversized text files without replacement-character corruption and marks high-signal truncation material', () => {
    repoPath = createTempRepo();
    const prefix = Buffer.alloc(MAX_S006_SCAN_BYTES_PER_FILE - 1, 'a');
    const splitCharacter = Buffer.from('€');
    const suffix = Buffer.from('tail');
    const absolutePath = path.join(repoPath, '.env.production');
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, Buffer.concat([prefix, splitCharacter, suffix]));

    const result = scanS006RepositoryCandidates(repoPath);
    const file = result.files.find(candidate => candidate.path === '.env.production');

    expect(file).toMatchObject({
      path: '.env.production',
      bytesRead: MAX_S006_SCAN_BYTES_PER_FILE,
      truncated: true,
      materialToCoverage: true
    });
    expect(file?.text).not.toContain('�');
    expect(result.coverage).toMatchObject({
      materiallyWeakened: true,
      complete: false
    });
    expect(result.coverage.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file-truncated',
        path: '.env.production',
        materialToCoverage: true
      })
    ]));
  });

  it('prioritizes high-signal candidates before applying candidate caps and reports incomplete capped coverage', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, '.env', 'LOCAL_ONLY=true\n');
    writeRepoFile(repoPath, '.github/workflows/build.yml', 'name: build\n');
    for (let index = 0; index < MAX_S006_SCAN_CANDIDATE_FILES + 12; index++) {
      writeRepoFile(repoPath, `docs/page-${String(index).padStart(3, '0')}.md`, '# docs\n');
    }

    const result = scanS006RepositoryCandidates(repoPath);
    const scannedPaths = result.files.map(file => file.path);

    expect(result.coverage.candidateFiles).toBeGreaterThan(MAX_S006_SCAN_CANDIDATE_FILES);
    expect(result.files).toHaveLength(MAX_S006_SCAN_CANDIDATE_FILES);
    expect(scannedPaths.slice(0, 2)).toEqual(['.env', '.github/workflows/build.yml']);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'candidate-limit' })
    ]));
  });

  it('reports material candidate truncation when priority scan cannot retain every high-signal path', () => {
    repoPath = createTempRepo();
    for (let index = 0; index < MAX_S006_SCAN_CANDIDATE_FILES + 5; index++) {
      writeRepoFile(repoPath, `config/service-${String(index).padStart(3, '0')}.yml`, 'enabled: true\n');
    }

    const result = scanS006RepositoryCandidates(repoPath);

    expect(result.coverage.materiallyWeakened).toBe(true);
    expect(result.coverage.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'candidate-limit',
        materialToCoverage: true
      })
    ]));
  });

  it('stops at the total byte cap and marks coverage material when high-signal candidates remain unread', () => {
    repoPath = createTempRepo();
    for (let index = 0; index < 30; index++) {
      writeRepoFile(
        repoPath,
        `config/service-${String(index).padStart(3, '0')}.yml`,
        `${'x'.repeat(MAX_S006_SCAN_BYTES_PER_FILE + 1024)}\n`
      );
    }

    const result = scanS006RepositoryCandidates(repoPath);

    expect(result.coverage.scannedBytes).toBeLessThanOrEqual(MAX_S006_SCAN_TOTAL_BYTES);
    expect(result.files.length).toBeLessThan(30);
    expect(result.coverage.materiallyWeakened).toBe(true);
    expect(result.coverage.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'byte-limit',
        materialToCoverage: true
      })
    ]));
  });

  it('records read errors as skipped-file evidence and continues scanning later candidates', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'config/unreadable.yml', 'secret: value\n');
    writeRepoFile(repoPath, 'src/main/resources/application.yml', 'server:\n  port: 8081\n');
    const unreadablePath = path.join(repoPath, 'config/unreadable.yml');
    fs.chmodSync(unreadablePath, 0o000);

    try {
      const result = scanS006RepositoryCandidates(repoPath);

      expect(result.files.map(file => file.path)).toContain('src/main/resources/application.yml');
      expect(result.coverage.skippedFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'config/unreadable.yml',
          reason: 'read-error',
          materialToCoverage: true
        })
      ]));
      expect(result.coverage.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'unreadable-file',
          path: 'config/unreadable.yml',
          materialToCoverage: true
        })
      ]));
    } finally {
      fs.chmodSync(unreadablePath, 0o600);
    }
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
