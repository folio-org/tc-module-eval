import { EvaluationStatus } from '../types';
import { parseS005PersonalDataDisclosureMarkdown } from '../utils/s005-personal-data-disclosure';

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
