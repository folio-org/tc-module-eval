import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

import type {
  CriterionAgentReviewResult,
  S004InstallationDocumentationResult,
  S005PersonalDataDisclosureAnalysisResult,
  S006SensitiveInformationAnalysisResult
} from '../types';
import { EvaluationStatus } from '../types';
import {
  analyzeS006SensitiveInformation,
  buildS006CriterionDetails,
  buildS006RedactedDetectorMatch,
  buildS006RedactedReportDetails,
  classifyS006SourceContext,
  createS006FingerprintRun,
  findFirstS006DetectorMatch,
  formatS006Evidence,
  getS006DetectorById,
  MAX_S006_SCAN_BYTES_PER_FILE,
  MAX_S006_SCAN_CANDIDATE_FILES,
  MAX_S006_SCAN_TOTAL_BYTES,
  MAX_S006_SCAN_TRAVERSAL_ENTRIES,
  MAX_S006_RETAINED_FINDINGS,
  scanS006RepositoryCandidates,
  strongestS006ReportFindings,
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

  it('marks coverage materially weakened when traversal reaches the entry cap', () => {
    repoPath = createTempRepo();
    for (let index = 0; index < MAX_S006_SCAN_TRAVERSAL_ENTRIES + 1; index++) {
      writeRepoFile(repoPath, `docs/page-${String(index).padStart(5, '0')}.md`, '# docs\n');
    }

    const result = scanS006RepositoryCandidates(repoPath);

    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.materiallyWeakened).toBe(true);
    expect(result.coverage.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'traversal-limit',
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
          message: 'Unable to read S006 candidate file.',
          materialToCoverage: true
        })
      ]));
      expect(JSON.stringify(result.coverage.skippedFiles)).not.toContain(repoPath);
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

describe('S006 sensitive information finding extraction', () => {
  let repoPath: string;

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('detects provider-shaped API keys in source config without returning raw key material', () => {
    repoPath = createTempRepo();
    const rawKey = 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile(repoPath, 'src/main/resources/application.yml', `OPENAI_API_KEY=${rawKey}\n`);

    const result = analyzeS006SensitiveInformation(repoPath);
    const providerFinding = result.findings.find(finding => finding.detectorId === 'provider-api-key');
    const serialized = JSON.stringify({
      analysis: result,
      report: buildS006RedactedReportDetails(result)
    });

    expect(providerFinding).toMatchObject({
      path: 'src/main/resources/application.yml',
      line: 1,
      context: 'production_source_or_configuration',
      category: 'provider_api_key',
      confidence: 'high',
      severity: 'critical',
      redactedExcerpt: expect.objectContaining({
        text: '[REDACTED_PROVIDER_API_KEY]'
      })
    });
    expect(serialized).not.toContain(rawKey);
  });

  it('caps retained findings and reports material finding-limit coverage', () => {
    repoPath = createTempRepo();
    const lines = Array.from({ length: MAX_S006_RETAINED_FINDINGS + 3 }, (_entry, index) =>
      `SERVICE_${index}_PASSWORD=CorrectHorseBatteryStaple${String(index).padStart(3, '0')}`
    );
    writeRepoFile(repoPath, 'src/main/resources/application.yml', `${lines.join('\n')}\n`);

    const result = analyzeS006SensitiveInformation(repoPath);
    const serialized = JSON.stringify(result);

    expect(result.findings).toHaveLength(MAX_S006_RETAINED_FINDINGS);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.materiallyWeakened).toBe(true);
    expect(result.coverage.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'finding-limit',
        materialToCoverage: true
      })
    ]));
    expect(serialized).not.toContain('CorrectHorseBatteryStaple');
  });

  it('detects multiline private key blocks with stable redacted placeholders', () => {
    repoPath = createTempRepo();
    const privateKeyBody = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
    writeRepoFile(
      repoPath,
      'config/key.txt',
      `before\n-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n-----END PRIVATE KEY-----\nafter\n`
    );

    const result = analyzeS006SensitiveInformation(repoPath);
    const finding = result.findings.find(candidate => candidate.detectorId === 'private-key-block');

    expect(finding).toMatchObject({
      detectorId: 'private-key-block',
      category: 'private_key',
      line: 2,
      endLine: 4,
      confidence: 'high',
      severity: 'critical',
      redactedExcerpt: {
        text: '[REDACTED_PRIVATE_KEY_BLOCK]',
        placeholder: '[REDACTED_PRIVATE_KEY_BLOCK]',
        multiline: true,
        startLine: 2,
        endLine: 4
      }
    });
    expect(JSON.stringify(result)).not.toContain(privateKeyBody);
  });

  it('marks truncated possible private key blocks as material uncertainty without leaking partial body lines', () => {
    repoPath = createTempRepo();
    const partialBody = 'PRIVATEKEYBODYSHOULDNOTLEAK';
    const prefix = 'a'.repeat(MAX_S006_SCAN_BYTES_PER_FILE - 45);
    writeRepoFile(
      repoPath,
      'docs/key.md',
      `${prefix}\n-----BEGIN PRIVATE KEY-----\n${partialBody}\n${'b'.repeat(1024)}`
    );

    const result = analyzeS006SensitiveInformation(repoPath);
    const serialized = JSON.stringify(result);

    expect(result.coverage.materiallyWeakened).toBe(true);
    expect(result.coverage.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file-truncated',
        path: 'docs/key.md',
        materialToCoverage: true
      })
    ]));
    expect(result.findings.some(finding => finding.detectorId === 'private-key-block')).toBe(false);
    expect(serialized).not.toContain(partialBody);
    expect(serialized).not.toContain('bbbbbbbb');
  });

  it('detects live-looking password and token assignments while downgrading empty and placeholder values', () => {
    repoPath = createTempRepo();
    writeRepoFile(
      repoPath,
      'config/application.properties',
      [
        'password=CorrectHorseBatteryStaple',
        'refresh_token=abcdefghijklmnopqrstuvwxyz123456',
        'token=TODO',
        'secret=<replace-me>',
        'password=',
        'Password:',
        'Token'
      ].join('\n')
    );

    const result = analyzeS006SensitiveInformation(repoPath);
    const assignments = result.findings.filter(finding => finding.detectorId === 'password-secret-assignment');

    expect(assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        line: 1,
        valueClassification: 'live-looking',
        confidence: 'medium',
        severity: 'high'
      }),
      expect.objectContaining({
        line: 2,
        valueClassification: 'live-looking',
        confidence: 'medium',
        severity: 'high'
      }),
      expect.objectContaining({
        line: 3,
        valueClassification: 'placeholder',
        confidence: 'low'
      }),
      expect.objectContaining({
        line: 4,
        valueClassification: 'placeholder',
        confidence: 'low'
      })
    ]));
    expect(assignments.some(finding => finding.line === 5 || finding.line === 6 || finding.line === 7)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('CorrectHorseBatteryStaple');
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('redacts credential URLs without preserving username, password, host, or the full URL', () => {
    repoPath = createTempRepo();
    const credentialUrl = 'https://admin:s3cr3t@10.0.0.12:9130/admin';
    writeRepoFile(repoPath, 'config/service.yml', `proxy: ${credentialUrl}\n`);

    const result = analyzeS006SensitiveInformation(repoPath);
    const finding = result.findings.find(candidate => candidate.detectorId === 'credential-url');
    const serialized = JSON.stringify(result);

    expect(finding).toMatchObject({
      category: 'credential_url',
      confidence: 'high',
      redactedExcerpt: expect.objectContaining({
        text: '[REDACTED_CREDENTIAL_URL]'
      })
    });
    expect(serialized).not.toContain('admin');
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toContain('10.0.0.12');
    expect(serialized).not.toContain(credentialUrl);
  });

  it('detects private URLs and local absolute paths as environment-specific findings', () => {
    repoPath = createTempRepo();
    writeRepoFile(
      repoPath,
      'src/main/resources/application.yml',
      'okapi: http://10.0.0.12:9130/okapi\nlocal: /Users/alice/work/private-config.yml\n'
    );

    const result = analyzeS006SensitiveInformation(repoPath);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detectorId: 'private-url',
        category: 'private_url',
        severity: 'medium'
      }),
      expect.objectContaining({
        detectorId: 'local-absolute-path',
        category: 'local_absolute_path',
        severity: 'low'
      })
    ]));
    expect(result.findings.find(finding => finding.detectorId === 'private-url')?.category).not.toBe('credential_url');
    expect(JSON.stringify(result)).not.toContain('10.0.0.12');
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
  });

  it('redacts access-key pairs, OAuth tokens, JWTs, Okapi tokens, and opaque bearer tokens by detector', () => {
    const run = createS006FingerprintRun();
    const cases = [
      {
        detectorId: 'provider-api-key' as const,
        raw: 'AKIA1234567890ABCDEF',
        absent: ['AKIA1234567890ABCDEF'],
        expected: '[REDACTED_PROVIDER_API_KEY]'
      },
      {
        detectorId: 'provider-api-key' as const,
        raw: 'ya29.abcdefghijklmnopqrstuvwxyz123456',
        absent: ['ya29.abcdefghijklmnopqrstuvwxyz123456'],
        expected: '[REDACTED_PROVIDER_API_KEY]'
      },
      {
        detectorId: 'password-secret-assignment' as const,
        raw: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY1234567890',
        absent: ['wJalrXUtnFEMI'],
        expected: '[REDACTED_SECRET_ASSIGNMENT]'
      },
      {
        detectorId: 'password-secret-assignment' as const,
        raw: 'refreshToken=abcdefghijklmnopqrstuvwxyz123456',
        absent: ['abcdefghijklmnopqrstuvwxyz123456'],
        expected: '[REDACTED_SECRET_ASSIGNMENT]'
      },
      {
        detectorId: 'bearer-or-jwt-token' as const,
        raw: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
        absent: ['abcdefghijklmnopqrstuvwxyz123456'],
        expected: 'Bearer [REDACTED_TOKEN]'
      },
      {
        detectorId: 'bearer-or-jwt-token' as const,
        raw: 'X-Okapi-Token: abcdefghijklmnopqrstuvwxyz123456',
        absent: ['abcdefghijklmnopqrstuvwxyz123456'],
        expected: '[REDACTED_TOKEN]'
      },
      {
        detectorId: 'bearer-or-jwt-token' as const,
        raw: 'eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkw.signatureABC123',
        absent: ['eyJhbGciOiJIUzI1NiIsInR5cCI'],
        expected: '[REDACTED_JWT]'
      }
    ];

    for (const testCase of cases) {
      const detector = getS006DetectorById(testCase.detectorId);
      const rawMatch = findFirstS006DetectorMatch(detector, testCase.raw);
      expect(rawMatch).toBeDefined();

      const redacted = buildS006RedactedDetectorMatch(detector, rawMatch!, run);
      expect(redacted.redactedExcerpt.text).toContain(testCase.expected);
      for (const absent of testCase.absent) {
        expect(JSON.stringify(redacted)).not.toContain(absent);
      }
    }
  });

  it('collapses duplicate detector hits for the same location and value fingerprint', () => {
    repoPath = createTempRepo();
    const repeated = 'abcdefghijklmnopqrstuvwxyz123456';
    writeRepoFile(repoPath, 'config/repeated.properties', `token=${repeated} token=${repeated}\n`);

    const result = analyzeS006SensitiveInformation(repoPath);
    const tokenFindings = result.findings.filter(finding => finding.detectorId === 'password-secret-assignment');

    expect(tokenFindings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(repeated);
  });

  it('does not expose default passwords as raw values or bare hashes in serialized output', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'docker-compose.yml', 'POSTGRES_PASSWORD=postgres\nADMIN_PASSWORD=admin\n');

    const result = analyzeS006SensitiveInformation(repoPath);
    const serialized = JSON.stringify(result);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detectorId: 'password-secret-assignment',
        valueClassification: 'synthetic'
      })
    ]));
    expect(serialized).not.toContain('postgres');
    expect(serialized).not.toContain('admin');
    expect(serialized).not.toContain(createHash('sha256').update('postgres').digest('hex'));
    expect(serialized).not.toContain(createHash('sha256').update('admin').digest('hex'));
  });

  it('redacts long bearer and JWT-like values in docs and tests before returned objects are inspectable', () => {
    repoPath = createTempRepo();
    const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkw.signatureABC123';
    writeRepoFile(repoPath, 'docs/auth.md', `curl -H "Authorization: ${bearer}"\n`);
    writeRepoFile(repoPath, 'src/__tests__/fixtures/token.txt', jwt);

    const result = analyzeS006SensitiveInformation(repoPath);
    const serialized = JSON.stringify(result);

    expect(result.findings.filter(finding => finding.detectorId === 'bearer-or-jwt-token')).toHaveLength(2);
    expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI');
    expect(serialized).toContain('[REDACTED_TOKEN]');
    expect(serialized).toContain('[REDACTED_JWT]');
  });

  it('keeps report details redacted as defense-in-depth without rescuing raw S006 detector values', () => {
    repoPath = createTempRepo();
    const rawKey = 'sk-proj-abcdef1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile(repoPath, '.env.production', `OPENAI_API_KEY=${rawKey}\n`);

    const result = analyzeS006SensitiveInformation(repoPath);
    const reportDetails = buildS006RedactedReportDetails(result);

    expect(JSON.stringify(result)).not.toContain(rawKey);
    expect(JSON.stringify(reportDetails)).not.toContain(rawKey);
    expect(JSON.stringify(reportDetails)).not.toContain('valueFingerprint');
    expect(reportDetails.findings[0].redactedExcerpt.text).toBe('[REDACTED_PROVIDER_API_KEY]');
  });
});

describe('S006 deterministic classification by context, confidence, and coverage', () => {
  let repoPath: string;

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('returns fail for a live-looking provider key in production configuration with reviewer-facing rationale', () => {
    repoPath = createTempRepo();
    const rawKey = 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile(repoPath, 'src/main/resources/application.yml', `OPENAI_API_KEY=${rawKey}\n`);

    const result = analyzeS006SensitiveInformation(repoPath);
    const finding = result.findings[0];

    expect(result.classification).toMatchObject({
      status: EvaluationStatus.FAIL,
      materiallyWeakenedCoverage: false,
      findingReferences: ['src/main/resources/application.yml:1:provider-api-key']
    });
    expect(result.classification.reason).toContain('high-confidence live-looking secret');
    expect(finding).toMatchObject({
      category: 'provider_api_key',
      context: 'production_source_or_configuration',
      confidence: 'high',
      severity: 'critical',
      redactedExcerpt: expect.objectContaining({
        text: '[REDACTED_PROVIDER_API_KEY]'
      })
    });
    expect(finding.rationale).toContain('deterministic failure candidate');
    expect(JSON.stringify(result)).not.toContain(rawKey);
  });

  it('returns manual for mod-search-style docker env defaults instead of failing local passwords', () => {
    repoPath = createTempRepo();
    writeRepoFile(
      repoPath,
      'docker/.env',
      [
        'DB_HOST=postgres',
        'POSTGRES_PASSWORD=postgres',
        'PGADMIN_DEFAULT_EMAIL=admin@example.com',
        'PGADMIN_DEFAULT_PASSWORD=admin'
      ].join('\n')
    );

    const result = analyzeS006SensitiveInformation(repoPath);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detectorId: 'password-secret-assignment',
        context: 'local_docker_defaults',
        valueClassification: 'synthetic'
      })
    ]));
    expect(result.findings.every(finding => finding.context === 'local_docker_defaults')).toBe(true);
  });

  it('returns manual for README Okapi token examples with documentation context', () => {
    repoPath = createTempRepo();
    const okapiToken = 'abcdefghijklmnopqrstuvwxyz123456';
    writeRepoFile(
      repoPath,
      'README.md',
      `Example request:\n\ncurl -H "X-Okapi-Token: ${okapiToken}" http://localhost:9130/users\n`
    );

    const result = analyzeS006SensitiveInformation(repoPath);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detectorId: 'bearer-or-jwt-token',
        context: 'documentation',
        confidence: 'high',
        severity: 'high'
      })
    ]));
    expect(JSON.stringify(result)).not.toContain(okapiToken);
  });

  it('keeps test credentials low impact or manual without deterministic failure', () => {
    repoPath = createTempRepo();
    const generatedTestToken = 'sk-test-1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile(
      repoPath,
      'src/__tests__/auth.fixture.ts',
      [
        'const headers = { token: abc };',
        'const password = "fake-password";',
        `const generated = "${generatedTestToken}";`
      ].join('\n')
    );

    const result = analyzeS006SensitiveInformation(repoPath);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detectorId: 'password-secret-assignment',
        line: 1,
        context: 'test_fixture',
        confidence: 'low',
        severity: 'low'
      }),
      expect.objectContaining({
        detectorId: 'provider-api-key',
        context: 'test_fixture',
        confidence: 'medium'
      })
    ]));
    expect(result.findings.some(finding => finding.rationale.includes('deterministic failure candidate'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(generatedTestToken);
  });

  it('retains provider-shaped and private-key findings under docs, samples, and tests as manual evidence', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'docs/provider.md', 'OPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnopqrstuvwxyz\n');
    writeRepoFile(
      repoPath,
      'samples/key.txt',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n'
    );
    writeRepoFile(repoPath, 'src/test/resources/provider.txt', 'OPENAI_API_KEY=sk-proj-abcdef1234567890abcdefghijklmnop\n');

    const result = analyzeS006SensitiveInformation(repoPath);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ detectorId: 'provider-api-key', path: 'docs/provider.md', context: 'documentation' }),
      expect.objectContaining({ detectorId: 'private-key-block', path: 'samples/key.txt', context: 'sample_or_example' }),
      expect.objectContaining({ detectorId: 'provider-api-key', path: 'src/test/resources/provider.txt', context: 'test_fixture' })
    ]));
  });

  it('routes an unusual production-looking fixture cue to manual rather than deterministic fail', () => {
    repoPath = createTempRepo();
    writeRepoFile(
      repoPath,
      'config/bootstrap.yml',
      '# Test fixture for parser coverage\nOPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnopqrstuvwxyz\n'
    );

    const result = analyzeS006SensitiveInformation(repoPath);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0]).toMatchObject({
      context: 'test_fixture',
      confidence: 'high',
      severity: 'critical'
    });
  });

  it('returns pass with scan coverage evidence when no findings remain and coverage is complete', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'README.md', '# Clean module\n');
    writeRepoFile(repoPath, 'src/main/resources/application.yml', 'server:\n  port: 8081\n');

    const result = analyzeS006SensitiveInformation(repoPath);

    expect(result.findings).toEqual([]);
    expect(result.coverage).toMatchObject({
      complete: true,
      materiallyWeakened: false
    });
    expect(result.classification.status).toBe(EvaluationStatus.PASS);
    expect(result.classification.reason).toContain('scanning 2 of 2 candidate files');
    expect(result.classification.reason).toContain('no material coverage warnings');
  });

  it('returns manual with coverage-warning evidence when material truncation weakens a no-finding scan', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, '.env.production', `COMMENT=${'x'.repeat(MAX_S006_SCAN_BYTES_PER_FILE + 1024)}\n`);

    const result = analyzeS006SensitiveInformation(repoPath);

    expect(result.findings).toEqual([]);
    expect(result.classification).toMatchObject({
      status: EvaluationStatus.MANUAL,
      materiallyWeakenedCoverage: true
    });
    expect(result.coverage.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file-truncated',
        path: '.env.production',
        materialToCoverage: true
      })
    ]));
    expect(result.classification.reason).toContain('materially weakened');
  });

  it('keeps private key blocks in fixtures manual while production-like private keys fail', () => {
    repoPath = createTempRepo();
    const privateKey = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
    writeRepoFile(repoPath, 'src/test/resources/key.txt', privateKey);

    let result = analyzeS006SensitiveInformation(repoPath);
    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0]).toMatchObject({
      detectorId: 'private-key-block',
      context: 'test_fixture'
    });

    fs.rmSync(repoPath, { recursive: true, force: true });
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'config/key.txt', privateKey);

    result = analyzeS006SensitiveInformation(repoPath);
    expect(result.classification.status).toBe(EvaluationStatus.FAIL);
    expect(result.findings[0]).toMatchObject({
      detectorId: 'private-key-block',
      context: 'production_source_or_configuration'
    });
  });

  it('fails credential-bearing URLs in CI while keeping the same shape manual in documentation', () => {
    const credentialUrl = 'https://ci-user:s3cr3t@10.0.0.12:9130/admin';

    repoPath = createTempRepo();
    writeRepoFile(repoPath, '.github/workflows/build.yml', `env:\n  ADMIN_URL: ${credentialUrl}\n`);
    let result = analyzeS006SensitiveInformation(repoPath);

    expect(result.classification.status).toBe(EvaluationStatus.FAIL);
    expect(result.findings[0]).toMatchObject({
      detectorId: 'credential-url',
      context: 'ci_or_deployment_configuration',
      confidence: 'high',
      severity: 'critical'
    });
    expect(JSON.stringify(result)).not.toContain(credentialUrl);

    fs.rmSync(repoPath, { recursive: true, force: true });
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'docs/ci.md', `Example admin URL: ${credentialUrl}\n`);
    result = analyzeS006SensitiveInformation(repoPath);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0]).toMatchObject({
      detectorId: 'credential-url',
      context: 'documentation'
    });
  });

  it('does not change status for paths or comments that only mention password, token, or secret names', () => {
    repoPath = createTempRepo();
    writeRepoFile(
      repoPath,
      'src/main/resources/password-token-secret-notes.yml',
      '# password token secret labels only\nname: no committed values here\n'
    );

    const result = analyzeS006SensitiveInformation(repoPath);

    expect(result.findings).toEqual([]);
    expect(result.classification.status).toBe(EvaluationStatus.PASS);
  });
});

describe('S006 report formatting and criterion details', () => {
  let repoPath: string;

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('formats fail details with deterministic production findings before manual documentation evidence', () => {
    repoPath = createTempRepo();
    const rawProductionKey = 'sk-proj-prod1234567890abcdefghijklmnopqrstuvwxyz';
    const rawDocumentationToken = 'abcdefghijklmnopqrstuvwxyz123456';
    writeRepoFile(repoPath, 'docs/auth.md', `curl -H "X-Okapi-Token: ${rawDocumentationToken}"\n`);
    writeRepoFile(repoPath, 'src/main/resources/application.yml', `OPENAI_API_KEY=${rawProductionKey}\n`);

    const analysis = analyzeS006SensitiveInformation(repoPath);
    const rendered = formatS006Evidence(analysis);
    const deterministicIndex = rendered.details.indexOf('src/main/resources/application.yml:1');
    const documentationIndex = rendered.details.indexOf('docs/auth.md:1');

    expect(analysis.classification.status).toBe(EvaluationStatus.FAIL);
    expect(deterministicIndex).toBeGreaterThanOrEqual(0);
    expect(documentationIndex).toBeGreaterThan(deterministicIndex);
    expect(rendered.details).toContain('[REDACTED_PROVIDER_API_KEY]');
    expect(rendered.details).toContain('X-Okapi-Token=[REDACTED]');
    expect(rendered.details).toContain('documentation evidence');
    expect(rendered.details).not.toContain(rawProductionKey);
    expect(rendered.details).not.toContain(rawDocumentationToken);
  });

  it('renders local Docker defaults with local-default context and reviewer rationale', () => {
    repoPath = createTempRepo();
    writeRepoFile(
      repoPath,
      'docker-compose.yml',
      [
        'services:',
        '  postgres:',
        '    environment:',
        '      POSTGRES_PASSWORD: postgres'
      ].join('\n')
    );

    const analysis = analyzeS006SensitiveInformation(repoPath);
    const rendered = formatS006Evidence(analysis);

    expect(analysis.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(rendered.details).toContain('local_docker_defaults');
    expect(rendered.details).toContain('local-default context');
    expect(rendered.details).toContain('verify values are not reused outside local development');
    expect(rendered.details).toContain('POSTGRES_PASSWORD=[REDACTED]');
    expect(rendered.details).not.toContain('postgres');
  });

  it('renders documentation snippets as manual evidence without raw token exposure', () => {
    repoPath = createTempRepo();
    const rawToken = 'abcdefghijklmnopqrstuvwxyz123456';
    writeRepoFile(repoPath, 'README.md', `Example: curl -H "Authorization: Bearer ${rawToken}"\n`);

    const analysis = analyzeS006SensitiveInformation(repoPath);
    const rendered = formatS006Evidence(analysis);

    expect(analysis.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(rendered.details).toContain('documentation evidence');
    expect(rendered.details).toContain('Bearer [REDACTED_TOKEN]');
    expect(rendered.details).not.toContain(rawToken);
  });

  it('reports pass scan coverage, skipped-file counts, and non-material warnings', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'README.md', '# Clean module\n');
    writeRepoFile(repoPath, 'node_modules/pkg/config.yml', 'ignored=true\n');
    for (let index = 0; index < MAX_S006_SCAN_CANDIDATE_FILES + 2; index++) {
      writeRepoFile(repoPath, `docs/page-${String(index).padStart(3, '0')}.md`, '# docs\n');
    }

    const analysis = analyzeS006SensitiveInformation(repoPath);
    const rendered = formatS006Evidence(analysis);
    const details = buildS006CriterionDetails(analysis);

    expect(analysis.classification.status).toBe(EvaluationStatus.PASS);
    expect(rendered.details).toContain('Files scanned:');
    expect(rendered.details).toContain('Skipped files: 1 (0 material, 1 non-material)');
    expect(rendered.details).toContain('Non-material coverage warnings:');
    expect(details.coverageSummary.skippedFileCount).toBe(1);
    expect(details.coverageSummary.materialSkippedFileCount).toBe(0);
    expect(details.coverageSummary.warningCount).toBeGreaterThan(0);
    expect(details.coverageSummary.scanLimitWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'candidate-limit', materialToCoverage: false })
    ]));
  });

  it('reports material scan-limit warnings and manual status rationale for incomplete scans', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, '.env.production', `COMMENT=${'x'.repeat(MAX_S006_SCAN_BYTES_PER_FILE + 1024)}\n`);

    const analysis = analyzeS006SensitiveInformation(repoPath);
    const rendered = formatS006Evidence(analysis);
    const details = buildS006CriterionDetails(analysis);

    expect(analysis.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(rendered.details).toContain('Status rationale:');
    expect(rendered.details).toContain('Material scan-limit warnings:');
    expect(rendered.details).toContain('file-truncated .env.production');
    expect(details.coverageSummary.materialWarningCount).toBeGreaterThan(0);
    expect(details.coverageSummary.scanLimitWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file-truncated', path: '.env.production', materialToCoverage: true })
    ]));
  });

  it('builds bounded redacted JSON criterionDetails without value fingerprints or raw secret values', () => {
    repoPath = createTempRepo();
    const rawKey = 'sk-proj-json1234567890abcdefghijklmnopqrstuvwxyz';
    writeRepoFile(repoPath, 'src/main/resources/application.yml', `OPENAI_API_KEY=${rawKey}\n`);
    writeRepoFile(repoPath, 'node_modules/pkg/config.yml', 'ignored=true\n');

    const analysis = analyzeS006SensitiveInformation(repoPath);
    const details = buildS006CriterionDetails(analysis);
    const serialized = JSON.stringify(details);

    expect(details.findingCount).toBe(1);
    expect(details.retainedFindingCount).toBe(1);
    expect(details.coverageSummary.skippedFileCount).toBe(1);
    expect(details.findings[0]).toMatchObject({
      path: 'src/main/resources/application.yml',
      redactedExcerpt: expect.objectContaining({ text: '[REDACTED_PROVIDER_API_KEY]' })
    });
    expect(serialized).not.toContain(rawKey);
    expect(serialized).not.toContain('valueFingerprint');
  });

  it('bounds strongest finding objects and keeps deterministic failures first for JSON consumers', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'src/main/resources/application.yml', 'OPENAI_API_KEY=sk-proj-json1234567890abcdefghijklmnopqrstuvwxyz\n');
    for (let index = 0; index < 25; index++) {
      writeRepoFile(repoPath, `docs/token-${String(index).padStart(2, '0')}.md`, `Bearer abcdefghijklmnopqrstuvwxyz${String(index).padStart(6, '0')}\n`);
    }

    const analysis = analyzeS006SensitiveInformation(repoPath);
    const details = buildS006CriterionDetails(analysis);
    const strongest = strongestS006ReportFindings(analysis.findings);

    expect(details.findingCount).toBeGreaterThan(16);
    expect(details.findings).toHaveLength(16);
    expect(details.findings[0].path).toBe('src/main/resources/application.yml');
    expect(strongest[0].context).toBe('production_source_or_configuration');
  });

  it('includes available agent-review state in human details', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'README.md', 'Example: Bearer abcdefghijklmnopqrstuvwxyz123456\n');
    const analysis = analyzeS006SensitiveInformation(repoPath);
    const agentReview: CriterionAgentReviewResult = {
      available: true,
      criterionId: 'S006',
      recommendation: 'needs_reviewer_judgment',
      confidence: 'medium',
      summary: 'Reviewer should inspect the docs token example.',
      rationale: 'Example contains private URL http://192.168.1.10/admin and token=secretish',
      evidenceReferences: ['README.md'],
      metadata: {
        adapter: 'fake',
        modelLabel: 'fake-model',
        reviewMode: 'read-only',
        promptInputSanitized: true,
        reviewWorkspaceSanitized: true
      },
      warnings: [],
      errors: []
    };

    const rendered = formatS006Evidence(analysis, agentReview);

    expect(rendered.details).toContain('Agent review:');
    expect(rendered.details).toContain('Advisory recommendation: needs_reviewer_judgment');
    expect(rendered.details).toContain('[REDACTED_PRIVATE_URL]');
    expect(rendered.details).toContain('token=[REDACTED]');
    expect(rendered.details).not.toContain('secretish');
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
