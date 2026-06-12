import {
  EvaluationStatus,
  S005PersonalDataCategory,
  S005PersonalDataDisclosureChecklistItem,
  S005PersonalDataDisclosureContradiction,
  S005PersonalDataDisclosureMetadata,
  S005PersonalDataDisclosureParseResult,
  S005PersonalDataDisclosurePlaceholderEvidence
} from '../types';
import { redactSensitiveText } from './redaction';

const MAX_CHECKLIST_LABEL_BYTES = 300;
const MAX_PARSE_ERROR_BYTES = 512;
const CHECKBOX_PATTERN = /^\s{0,6}[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const VERSION_PATTERN = /\b(?:form\s+version|template\s+version|version)\s*[:|-]\s*(.+)$/i;
const LAST_UPDATED_PATTERN = /\blast\s+updated\s*[:|-]\s*(.+)$/i;
const LAST_REVIEWED_PATTERN = /\blast\s+reviewed\s*[:|-]\s*(.+)$/i;
const PLACEHOLDER_PATTERN = /^(?:todo|tbd|n\/a|\[.*\]|<.*>|yyyy-mm-dd|mm\/dd\/yyyy|date|last updated|last reviewed)$/i;

const PERSONAL_FIELD_CATEGORIES = new Set<S005PersonalDataCategory>([
  'name',
  'username',
  'user_identifier',
  'email',
  'phone',
  'address',
  'birth_date',
  'patron_data',
  'free_form_notes',
  'profile_picture',
  'ip_or_mac_address',
  'financial_information',
  'circulation_transactions',
  'custom_fields'
]);

export function parseS005PersonalDataDisclosureMarkdown(content: string): S005PersonalDataDisclosureParseResult {
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/);
  const metadata: S005PersonalDataDisclosureMetadata = {
    templateIdentity: 'unknown'
  };
  const placeholders: S005PersonalDataDisclosurePlaceholderEvidence[] = [];
  const checklistItems: S005PersonalDataDisclosureChecklistItem[] = [];
  let sectionHeading: string | undefined;
  let headingCount = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    const headingMatch = line.match(HEADING_PATTERN);

    if (headingMatch) {
      headingCount += 1;
      sectionHeading = stripInlineMarkdown(headingMatch[2]);
    }

    captureMetadata(line, lineNumber, metadata, placeholders);

    const checkboxMatch = line.match(CHECKBOX_PATTERN);
    if (!checkboxMatch) {
      continue;
    }

    const rawLabel = redactS005PersonalDataText(stripInlineMarkdown(checkboxMatch[2]), MAX_CHECKLIST_LABEL_BYTES);
    checklistItems.push({
      order: checklistItems.length + 1,
      lineNumber,
      sectionHeading,
      rawLabel,
      checked: checkboxMatch[1].toLowerCase() === 'x',
      normalizedCategory: normalizeS005ChecklistCategory(checkboxMatch[2])
    });
  }

  metadata.templateIdentity = classifyTemplateIdentity(metadata, content);

  if (!checklistItems.length && !headingCount) {
    const parseError = {
      message: 'No Markdown headings or checklist items were found in the disclosure form.',
      excerpt: redactS005PersonalDataText(content, MAX_PARSE_ERROR_BYTES)
    };

    return {
      metadata,
      checklistItems,
      checkedCategories: [],
      uncheckedCategories: [],
      completion: {
        completed: false,
        checkedMeaningfulAnswers: 0,
        checkedCategories: [],
        uncheckedCategories: []
      },
      placeholders,
      contradictions: [],
      classification: {
        status: EvaluationStatus.FAIL,
        parseState: 'unparseable',
        reason: parseError.message,
        warnings
      },
      parseError,
      warnings
    };
  }

  const checkedCategories = uniqueCategories(checklistItems.filter(item => item.checked).map(item => item.normalizedCategory));
  const uncheckedCategories = uniqueCategories(checklistItems.filter(item => !item.checked).map(item => item.normalizedCategory));
  const checkedMeaningfulAnswers = checklistItems.filter(item => item.checked && item.normalizedCategory !== 'other').length;
  const completed = checkedMeaningfulAnswers > 0;
  const contradictions = detectContradictions(checklistItems);

  return {
    metadata,
    checklistItems,
    checkedCategories,
    uncheckedCategories,
    completion: {
      completed,
      checkedMeaningfulAnswers,
      checkedCategories,
      uncheckedCategories
    },
    placeholders,
    contradictions,
    classification: {
      status: completed ? EvaluationStatus.MANUAL : EvaluationStatus.FAIL,
      parseState: completed ? 'completed' : 'incomplete',
      reason: completed
        ? 'Disclosure form has at least one checked meaningful answer and requires reviewer judgment.'
        : 'No checked disclosure answers were found for personal-data or processing questions.',
      warnings
    },
    warnings
  };
}

export function normalizeS005ChecklistCategory(label: string): S005PersonalDataCategory {
  const normalized = label.toLowerCase();

  if (/\bdoes\s+not\b.*\b(?:store|process|collect|use|handle|contain|personal\s+data)\b/.test(normalized) ||
      /\bno\s+personal\s+data\b/.test(normalized)) {
    return 'no_personal_data';
  }
  if (/\b(e-?mail|email address)\b/.test(normalized)) {
    return 'email';
  }
  if (/\b(phone|telephone|mobile|fax)\b/.test(normalized)) {
    return 'phone';
  }
  if (/\b(address|street|city|state|province|postal|zip|country|location)\b/.test(normalized)) {
    return 'address';
  }
  if (/\b(first name|last name|middle name|preferred name|display name|full name|name)\b/.test(normalized)) {
    return 'name';
  }
  if (/\b(username|login name|user name)\b/.test(normalized)) {
    return 'username';
  }
  if (/\b(user id|user uuid|uuid|identifier|barcode|external id|patron id)\b/.test(normalized)) {
    return 'user_identifier';
  }
  if (/\b(date of birth|birth date|birthday|dob)\b/.test(normalized)) {
    return 'birth_date';
  }
  if (/\b(patron|borrower|requester|proxy|sponsor)\b/.test(normalized)) {
    return 'patron_data';
  }
  if (/\b(note|comment|description|free[- ]?form|message)\b/.test(normalized)) {
    return 'free_form_notes';
  }
  if (/\b(profile picture|photo|avatar|image)\b/.test(normalized)) {
    return 'profile_picture';
  }
  if (/\b(ip address|mac address|network address)\b/.test(normalized)) {
    return 'ip_or_mac_address';
  }
  if (/\b(payment|credit card|card details|financial|bank|invoice|fee|fine)\b/.test(normalized)) {
    return 'financial_information';
  }
  if (/\b(circulation|loan|checkout|check-out|checkin|check-in|renewal|request|hold)\b/.test(normalized)) {
    return 'circulation_transactions';
  }
  if (/\b(custom field|custom field value|user-defined)\b/.test(normalized)) {
    return 'custom_fields';
  }
  if (/\b(cache|cached)\b/.test(normalized)) {
    return 'cache';
  }
  if (/\b(log|logging|logged)\b/.test(normalized)) {
    return 'logging';
  }
  if (/\b(transmit|transmission|send|sent|external system|third[- ]party|api|export|import)\b/.test(normalized)) {
    return 'transmission';
  }
  if (/\b(process|processing|use|display|read|write)\b/.test(normalized)) {
    return 'processing';
  }
  if (/\b(store|storage|persist|database|saved)\b/.test(normalized)) {
    return 'storage';
  }

  return 'other';
}

export function redactS005PersonalDataText(input: string, maxBytes: number = MAX_CHECKLIST_LABEL_BYTES): string {
  return boundUtf8(
    redactSensitiveText(input)
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]'),
    maxBytes
  );
}

function captureMetadata(
  line: string,
  lineNumber: number,
  metadata: S005PersonalDataDisclosureMetadata,
  placeholders: S005PersonalDataDisclosurePlaceholderEvidence[]
): void {
  const versionMatch = line.match(VERSION_PATTERN);
  if (versionMatch && !metadata.versionText) {
    metadata.versionText = stripInlineMarkdown(versionMatch[1]).trim();
    metadata.versionLineNumber = lineNumber;
  }

  const updatedMatch = line.match(LAST_UPDATED_PATTERN);
  if (updatedMatch && !metadata.lastUpdatedText) {
    metadata.lastUpdatedText = stripInlineMarkdown(updatedMatch[1]).trim();
    metadata.lastUpdatedLineNumber = lineNumber;
    addPlaceholderIfNeeded('Last Updated', metadata.lastUpdatedText, lineNumber, line, placeholders);
  }

  const reviewedMatch = line.match(LAST_REVIEWED_PATTERN);
  if (reviewedMatch && !metadata.lastReviewedText) {
    metadata.lastReviewedText = stripInlineMarkdown(reviewedMatch[1]).trim();
    metadata.lastReviewedLineNumber = lineNumber;
    addPlaceholderIfNeeded('Last Reviewed', metadata.lastReviewedText, lineNumber, line, placeholders);
  }
}

function addPlaceholderIfNeeded(
  field: string,
  value: string,
  lineNumber: number,
  line: string,
  placeholders: S005PersonalDataDisclosurePlaceholderEvidence[]
): void {
  if (!PLACEHOLDER_PATTERN.test(value.trim())) {
    return;
  }

  placeholders.push({
    field,
    lineNumber,
    placeholderText: redactS005PersonalDataText(value, 120),
    excerpt: redactS005PersonalDataText(line, 240)
  });
}

function detectContradictions(
  checklistItems: S005PersonalDataDisclosureChecklistItem[]
): S005PersonalDataDisclosureContradiction[] {
  const checkedNoPersonalData = checklistItems.filter(item => item.checked && item.normalizedCategory === 'no_personal_data');
  if (!checkedNoPersonalData.length) {
    return [];
  }

  const conflictingItems = checklistItems.filter(item => item.checked && PERSONAL_FIELD_CATEGORIES.has(item.normalizedCategory));
  if (!conflictingItems.length) {
    return [];
  }

  return [
    {
      kind: 'no-personal-data-with-personal-fields',
      message: 'No-personal-data answer is checked alongside checked personal-data field answers.',
      lineNumbers: uniqueNumbers([...checkedNoPersonalData, ...conflictingItems].map(item => item.lineNumber)),
      conflictingCategories: uniqueCategories(conflictingItems.map(item => item.normalizedCategory))
    }
  ];
}

function classifyTemplateIdentity(metadata: S005PersonalDataDisclosureMetadata, content: string): S005PersonalDataDisclosureMetadata['templateIdentity'] {
  if (metadata.versionText && /\bv?1\.1\b/i.test(metadata.versionText)) {
    return 'current-like';
  }

  if (/last\s+updated\s*[:|-]/i.test(content) && /last\s+reviewed\s*[:|-]/i.test(content)) {
    return 'current-like';
  }

  if (metadata.versionText) {
    return 'older-or-custom';
  }

  return 'unknown';
}

function stripInlineMarkdown(input: string): string {
  return input
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function uniqueCategories(categories: S005PersonalDataCategory[]): S005PersonalDataCategory[] {
  return [...new Set(categories)];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function boundUtf8(input: string, maxBytes: number): string {
  const buffer = Buffer.from(input);
  if (buffer.length <= maxBytes) {
    return input;
  }

  const suffix = ` [truncated to ${maxBytes} bytes]`;
  const availableBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  const truncated = buffer.subarray(0, availableBytes).toString('utf-8').replace(/\uFFFD$/, '');
  return `${truncated}${suffix}`;
}
