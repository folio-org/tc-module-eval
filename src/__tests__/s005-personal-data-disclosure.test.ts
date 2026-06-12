import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EvaluationStatus } from '../types';
import {
  discoverS005PersonalDataDisclosureArtifact,
  gatherS005PersonalDataEvidence,
  MAX_SIGNALS_PER_CATEGORY_SOURCE_CLASS,
  MAX_S005_EVIDENCE_TEXT_BYTES_PER_FILE,
  parseS005PersonalDataDisclosureMarkdown
} from '../utils/s005-personal-data-disclosure';

function createTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 's005-disclosure-'));
}

function writeRepoFile(repoPath: string, relativePath: string, content: string = '# Personal Data Disclosure\n'): void {
  const absolutePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function writeRepoBinaryFile(repoPath: string, relativePath: string, content: Buffer): void {
  const absolutePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

describe('S005 personal data disclosure parser', () => {
  it('parses a completed v1.1-like form with checked fields, sections, and version evidence', () => {
    const result = parseS005PersonalDataDisclosureMarkdown(`
# Personal Data Disclosure

Form Version: v1.1
Last Updated: 2026-05-31
Last Reviewed: 2026-06-01

## Personal data stored

- [x] First name
- [x] Email address
- [ ] Postal address

## Personal data processed or transmitted

- [x] User UUID is sent to the search service
- [ ] Payment card details
`);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.metadata.versionText).toBe('v1.1');
    expect(result.metadata.versionLineNumber).toBe(4);
    expect(result.metadata.templateIdentity).toBe('current-like');
    expect(result.checklistItems).toHaveLength(5);
    expect(result.checklistItems[0]).toMatchObject({
      checked: true,
      lineNumber: 10,
      order: 1,
      rawLabel: 'First name',
      normalizedCategory: 'name',
      sectionHeading: 'Personal data stored'
    });
    expect(result.checklistItems[2]).toMatchObject({
      checked: false,
      rawLabel: 'Postal address',
      normalizedCategory: 'address'
    });
    expect(result.checkedCategories).toEqual(expect.arrayContaining(['name', 'email', 'user_identifier']));
  });

  it('parses an older v1.0-like no-personal-data form as completed without current template identity', () => {
    const result = parseS005PersonalDataDisclosureMarkdown(`
# Personal Data Disclosure

Version: 1.0

## Personal data

- [x] This module does not store or process personal data.
- [ ] First name
- [ ] Email
`);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.metadata.versionText).toBe('1.0');
    expect(result.metadata.templateIdentity).toBe('older-or-custom');
    expect(result.completion.completed).toBe(true);
    expect(result.checkedCategories).toEqual(['no_personal_data']);
  });

  it('classifies a blank copied template as incomplete', () => {
    const result = parseS005PersonalDataDisclosureMarkdown(`
# Personal Data Disclosure

Form Version: v1.1
Last Updated: YYYY-MM-DD
Last Reviewed: YYYY-MM-DD

## Personal data stored

- [ ] This module does not store personal data.
- [ ] First name
- [ ] Email address

## Personal data processed or transmitted

- [ ] This module does not process personal data.
- [ ] User identifiers are transmitted to external systems.
`);

    expect(result.classification.status).toBe(EvaluationStatus.FAIL);
    expect(result.completion.completed).toBe(false);
    expect(result.classification.reason).toContain('No checked disclosure answers');
  });

  it('records contradictions when no-personal-data is checked alongside personal fields', () => {
    const result = parseS005PersonalDataDisclosureMarkdown(`
# Personal Data Disclosure

Version: v1.1

## Personal data stored

- [x] This module does not store personal data.
- [x] First name
- [x] Email address
- [x] Address
`);

    expect(result.classification.status).toBe(EvaluationStatus.MANUAL);
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]).toMatchObject({
      kind: 'no-personal-data-with-personal-fields'
    });
    expect(result.contradictions[0].conflictingCategories).toEqual(expect.arrayContaining(['name', 'email', 'address']));
  });

  it('records Last Updated and Last Reviewed placeholder evidence', () => {
    const result = parseS005PersonalDataDisclosureMarkdown(`
# Personal Data Disclosure

Form Version: v1.1
Last Updated: TODO
Last Reviewed: YYYY-MM-DD

## Personal data stored

- [x] This module does not store personal data.
`);

    expect(result.placeholders).toEqual([
      expect.objectContaining({ field: 'Last Updated', lineNumber: 5, placeholderText: 'TODO' }),
      expect.objectContaining({ field: 'Last Reviewed', lineNumber: 6, placeholderText: 'YYYY-MM-DD' })
    ]);
  });

  it('returns unparseable classification with a bounded parse error for malformed non-Markdown text', () => {
    const result = parseS005PersonalDataDisclosureMarkdown('not markdown\n'.repeat(200));

    expect(result.classification.status).toBe(EvaluationStatus.FAIL);
    expect(result.classification.parseState).toBe('unparseable');
    expect(result.parseError?.message).toContain('No Markdown headings or checklist items');
    expect(Buffer.byteLength(result.parseError?.excerpt ?? '')).toBeLessThanOrEqual(520);
  });

  it('preserves bounded and S005-redacted checklist labels with stable metadata', () => {
    const result = parseS005PersonalDataDisclosureMarkdown(`
# Personal Data Disclosure

## Personal data stored

- [x] Email address user@example.org with bearer token Bearer abc123456789 and ${'long free form '.repeat(80)}
`);

    const [item] = result.checklistItems;
    expect(item).toMatchObject({
      checked: true,
      lineNumber: 6,
      order: 1,
      sectionHeading: 'Personal data stored',
      normalizedCategory: 'email'
    });
    expect(item.rawLabel).toContain('[REDACTED_EMAIL]');
    expect(item.rawLabel).toContain('Bearer [REDACTED]');
    expect(item.rawLabel).toContain('[truncated to');
    expect(Buffer.byteLength(item.rawLabel)).toBeLessThanOrEqual(320);
  });
});

describe('S005 personal data disclosure artifact discovery', () => {
  let repoPath: string;

  afterEach(() => {
    jest.restoreAllMocks();
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('fails discovery and names a root-level PERSONAL_DATA_DISCOSURE.md attempt when exact file is missing', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'PERSONAL_DATA_DISCOSURE.md');

    const result = discoverS005PersonalDataDisclosureArtifact(repoPath);

    expect(result.status).toBe('missing');
    expect(result.artifact).toBeUndefined();
    expect(result.attempts).toEqual([
      {
        path: 'PERSONAL_DATA_DISCOSURE.md',
        reason: 'root-near-match'
      }
    ]);
  });

  it('selects the correct top-level file even when additional similar files exist', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'PERSONAL_DATA_DISCLOSURE.md', 'correct disclosure');
    writeRepoFile(repoPath, 'PERSONAL_DATA_DISCOSURE.md', 'typo disclosure');
    writeRepoFile(repoPath, 'docs/PERSONAL_DATA_DISCLOSURE.md', 'nested disclosure');

    const result = discoverS005PersonalDataDisclosureArtifact(repoPath);

    expect(result.status).toBe('found');
    expect(result.artifact).toMatchObject({
      path: 'PERSONAL_DATA_DISCLOSURE.md',
      content: 'correct disclosure'
    });
    expect(result.attempts).toEqual([
      {
        path: 'PERSONAL_DATA_DISCOSURE.md',
        reason: 'root-near-match'
      },
      {
        path: 'docs/PERSONAL_DATA_DISCLOSURE.md',
        reason: 'bounded-nested-near-match'
      }
    ]);
  });

  it('reports nested attempts below docs, doc, and documentation to bounded depth without satisfying S005', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'docs/PERSONAL_DATA_DISCLOSURE.md');
    writeRepoFile(repoPath, 'doc/review/PERSONAL_DATA_DISCOSURE.md');
    writeRepoFile(repoPath, 'documentation/privacy/forms/personal_data_disclosure.md');

    const result = discoverS005PersonalDataDisclosureArtifact(repoPath);

    expect(result.status).toBe('missing');
    expect(result.artifact).toBeUndefined();
    expect(result.attempts).toEqual([
      {
        path: 'docs/PERSONAL_DATA_DISCLOSURE.md',
        reason: 'bounded-nested-near-match'
      },
      {
        path: 'doc/review/PERSONAL_DATA_DISCOSURE.md',
        reason: 'bounded-nested-near-match'
      },
      {
        path: 'documentation/privacy/forms/personal_data_disclosure.md',
        reason: 'bounded-nested-near-match'
      }
    ]);
  });

  it('ignores disclosure-like files nested outside bounded attempted-evidence locations', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'src/docs/PERSONAL_DATA_DISCLOSURE.md');
    writeRepoFile(repoPath, 'examples/personal_data_disclosure.md');

    const result = discoverS005PersonalDataDisclosureArtifact(repoPath);

    expect(result.status).toBe('missing');
    expect(result.attempts).toEqual([]);
  });

  it('treats a case-only root personal_data_disclosure.md variant as attempted evidence, not compliant', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'personal_data_disclosure.md');

    const result = discoverS005PersonalDataDisclosureArtifact(repoPath);

    expect(result.status).toBe('missing');
    expect(result.artifact).toBeUndefined();
    expect(result.attempts).toEqual([
      {
        path: 'personal_data_disclosure.md',
        reason: 'root-near-match'
      }
    ]);
  });

  it('fails unreadable exact files with bounded read error and attempted-file evidence', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'PERSONAL_DATA_DISCLOSURE.md');
    writeRepoFile(repoPath, 'PERSONAL_DATA_DISCOSURE.md');
    fs.chmodSync(path.join(repoPath, 'PERSONAL_DATA_DISCLOSURE.md'), 0o000);

    const result = discoverS005PersonalDataDisclosureArtifact(repoPath);

    expect(result.status).toBe('unreadable');
    expect(result.artifact).toBeUndefined();
    expect(result.readError).toContain('permission denied');
    expect(Buffer.byteLength(result.readError ?? '')).toBeLessThanOrEqual(320);
    expect(result.attempts).toEqual([
      {
        path: 'PERSONAL_DATA_DISCOSURE.md',
        reason: 'root-near-match'
      },
      {
        path: 'PERSONAL_DATA_DISCLOSURE.md',
        reason: 'exact-file-read-error'
      }
    ]);
  });
});

describe('S005 bounded personal-data evidence scanner', () => {
  let repoPath: string;

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('emits strong direct-contract signals for schema and RAML personal fields', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'src/main/resources/schemas/user.json', JSON.stringify({
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        emailAddress: { type: 'string' },
        phone: { type: 'string' },
        addressLine1: { type: 'string' },
        patronId: { type: 'string' }
      }
    }, null, 2));
    writeRepoFile(repoPath, 'ramls/users.raml', `
#%RAML 1.0
/users:
  post:
    body:
      application/json:
        example:
          userId: 11111111-1111-1111-1111-111111111111
          email: user@example.org
`);

    const result = gatherS005PersonalDataEvidence(repoPath);

    expect(result.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'name',
        path: 'src/main/resources/schemas/user.json',
        sourceClass: 'direct_contract',
        strength: 'strong'
      }),
      expect.objectContaining({
        category: 'email',
        path: 'src/main/resources/schemas/user.json',
        sourceClass: 'direct_contract',
        strength: 'strong'
      }),
      expect.objectContaining({
        category: 'phone',
        sourceClass: 'direct_contract',
        strength: 'strong'
      }),
      expect.objectContaining({
        category: 'address',
        sourceClass: 'direct_contract',
        strength: 'strong'
      }),
      expect.objectContaining({
        category: 'user_identifier',
        path: 'ramls/users.raml',
        sourceClass: 'direct_contract',
        strength: 'strong'
      })
    ]));
    expect(result.signals.find(signal => signal.path === 'ramls/users.raml' && signal.category === 'email')?.excerpt)
      .toContain('[REDACTED_EMAIL]');
  });

  it('treats UI and documentation evidence as candidate or context instead of persistence proof', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'translations/en.json', JSON.stringify({
      'ui-users.firstName': 'First name',
      'ui-users.emailAddress': 'Email address',
      'ui-users.addressLine1': 'Address line 1'
    }, null, 2));
    writeRepoFile(repoPath, 'README.md', `
# mod-source-record-manager

This module may display requester patron details and email addresses in import logs for review.
`);

    const result = gatherS005PersonalDataEvidence(repoPath);

    expect(result.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'name',
        path: 'translations/en.json',
        sourceClass: 'ui',
        strength: 'candidate'
      }),
      expect.objectContaining({
        category: 'email',
        path: 'translations/en.json',
        sourceClass: 'ui',
        strength: 'candidate'
      }),
      expect.objectContaining({
        category: 'patron_data',
        path: 'README.md',
        sourceClass: 'documentation',
        strength: 'context'
      })
    ]));
    expect(result.signals.filter(signal => signal.sourceClass === 'ui').every(signal => signal.strength !== 'strong')).toBe(true);
  });

  it('detects logging, event transmission, cache, and external profile-picture storage in source', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'src/main/java/org/folio/UserEventsProducer.java', `
class UserEventsProducer {
  private static final Logger log = LoggerFactory.getLogger(UserEventsProducer.class);
  void send(User user) {
    log.info("publishing userId={} email=user@example.org apiToken=super-secret", user.userId());
    kafkaProducer.publish("user.updated", user.userId());
    profilePictureBucket.put(user.profilePicture);
    redisCache.put(user.userId(), user.emailAddress());
  }
}
`);

    const result = gatherS005PersonalDataEvidence(repoPath);

    expect(result.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'logging', sourceClass: 'implementation', strength: 'strong' }),
      expect.objectContaining({ category: 'transmission', sourceClass: 'implementation', strength: 'strong' }),
      expect.objectContaining({ category: 'storage', sourceClass: 'implementation', strength: 'strong' }),
      expect.objectContaining({ category: 'profile_picture', sourceClass: 'implementation', strength: 'strong' }),
      expect.objectContaining({ category: 'cache', sourceClass: 'implementation', strength: 'strong' })
    ]));

    const loggingSignal = result.signals.find(signal => signal.category === 'logging' && signal.excerpt.includes('publishing'));
    expect(loggingSignal?.excerpt).toContain('[REDACTED_EMAIL]');
    expect(loggingSignal?.excerpt).toContain('apiToken=[REDACTED]');
  });

  it('keeps test fixtures and sample payloads at context strength and redacts risky examples', () => {
    repoPath = createTempRepo();
    writeRepoFile(repoPath, 'src/test/resources/fixtures/users.json', `
{
  "firstName": "Jane Doe",
  "emailAddress": "jane.doe@example.org",
  "phone": "312-555-0199",
  "notes": "${'sensitive patron note '.repeat(20)}"
}
`);

    const result = gatherS005PersonalDataEvidence(repoPath);

    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.every(signal => signal.sourceClass === 'test_sample')).toBe(true);
    expect(result.signals.every(signal => signal.strength === 'context')).toBe(true);
    expect(result.signals.map(signal => signal.excerpt).join('\n')).not.toContain('jane.doe@example.org');
    expect(result.signals.map(signal => signal.excerpt).join('\n')).not.toContain('312-555-0199');
    expect(result.signals.map(signal => signal.excerpt).join('\n')).not.toContain('Jane Doe');
    expect(result.signals.map(signal => signal.excerpt).join('\n')).toContain('[REDACTED_LONG_TEXT]');
  });

  it('bounds large and binary files, skips dependency/build/report folders, and reports retention caps', () => {
    repoPath = createTempRepo();
    writeRepoFile(
      repoPath,
      'src/main/resources/schemas/many-users.json',
      Array.from({ length: MAX_SIGNALS_PER_CATEGORY_SOURCE_CLASS + 3 }, (_, index) => `"emailAddress${index}": "user${index}@example.org"`).join('\n')
    );
    writeRepoFile(repoPath, 'src/main/java/org/folio/LargeUser.java', `String firstName = "Ada";\n${'x'.repeat(MAX_S005_EVIDENCE_TEXT_BYTES_PER_FILE + 1024)}`);
    writeRepoBinaryFile(repoPath, 'src/main/resources/schemas/binary-user.json', Buffer.from([0, 1, 2, 3, 4, 5]));
    writeRepoFile(repoPath, 'node_modules/package/schemas/user.json', '"emailAddress": "dependency@example.org"');
    writeRepoFile(repoPath, 'build/schemas/user.json', '"emailAddress": "build@example.org"');
    writeRepoFile(repoPath, 'coverage/schemas/user.json', '"emailAddress": "coverage@example.org"');
    writeRepoFile(repoPath, 'generated-reports/schemas/user.json', '"emailAddress": "report@example.org"');

    const result = gatherS005PersonalDataEvidence(repoPath);

    const retainedDirectEmailSignals = result.signals.filter(signal =>
      signal.category === 'email' && signal.sourceClass === 'direct_contract'
    );
    expect(retainedDirectEmailSignals).toHaveLength(MAX_SIGNALS_PER_CATEGORY_SOURCE_CLASS);
    expect(result.skippedFiles).toEqual(expect.arrayContaining([
      {
        path: 'src/main/resources/schemas/binary-user.json',
        reason: 'binary'
      }
    ]));
    expect(result.scannedFiles).not.toEqual(expect.arrayContaining([
      'node_modules/package/schemas/user.json',
      'build/schemas/user.json',
      'coverage/schemas/user.json',
      'generated-reports/schemas/user.json'
    ]));
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining(`category "email" and source class "direct_contract"`),
      expect.stringContaining(`truncated src/main/java/org/folio/LargeUser.java to ${MAX_S005_EVIDENCE_TEXT_BYTES_PER_FILE} bytes per file`)
    ]));
  });
});
