import * as fs from 'fs';
import * as path from 'path';

import {
  EvaluationStatus,
  S005PersonalDataCategory,
  S005PersonalDataDisclosureAttempt,
  S005PersonalDataDisclosureDiscoveryResult,
  S005PersonalDataDisclosureChecklistItem,
  S005PersonalDataDisclosureContradiction,
  S005PersonalDataDisclosureMetadata,
  S005PersonalDataDisclosureParseResult,
  S005PersonalDataDisclosurePlaceholderEvidence
} from '../types';
import { isWithinRepo, realPath, relativePosixPath } from './repo-files';
import { redactSensitiveText } from './redaction';

const REQUIRED_DISCLOSURE_FILENAME = 'PERSONAL_DATA_DISCLOSURE.md';
const MAX_CHECKLIST_LABEL_BYTES = 300;
const MAX_PARSE_ERROR_BYTES = 512;
const MAX_DISCOVERY_READ_ERROR_BYTES = 300;
const BOUNDED_NESTED_ATTEMPT_DIRS = ['docs', 'doc', 'documentation'];
const MAX_BOUNDED_NESTED_ATTEMPT_DEPTH = 2;
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

export function discoverS005PersonalDataDisclosureArtifact(repoPath: string): S005PersonalDataDisclosureDiscoveryResult {
  const warnings: string[] = [];
  const repoRoot = realPath(repoPath);
  if (!repoRoot) {
    return {
      status: 'missing',
      attempts: [],
      warnings: ['Unable to resolve repository path while looking for PERSONAL_DATA_DISCLOSURE.md.']
    };
  }

  const attempts = discoverS005AttemptedDisclosureFiles(repoRoot);
  const exactPath = path.join(repoRoot, REQUIRED_DISCLOSURE_FILENAME);

  if (!hasExactRootFileName(repoRoot, REQUIRED_DISCLOSURE_FILENAME)) {
    return {
      status: 'missing',
      attempts,
      warnings
    };
  }

  if (!isWithinRepo(repoRoot, exactPath)) {
    return {
      status: 'missing',
      attempts,
      warnings: ['Skipped exact disclosure candidate because it is outside the repository.']
    };
  }

  try {
    return {
      status: 'found',
      artifact: {
        path: REQUIRED_DISCLOSURE_FILENAME,
        absolutePath: exactPath,
        content: fs.readFileSync(exactPath, 'utf-8')
      },
      attempts,
      warnings
    };
  } catch (error) {
    return {
      status: 'unreadable',
      attempts: addUniqueAttempt(attempts, {
        path: REQUIRED_DISCLOSURE_FILENAME,
        reason: 'exact-file-read-error'
      }),
      readError: boundUtf8(error instanceof Error ? error.message : String(error), MAX_DISCOVERY_READ_ERROR_BYTES),
      warnings
    };
  }
}

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

function discoverS005AttemptedDisclosureFiles(repoPath: string): S005PersonalDataDisclosureAttempt[] {
  const attempts: S005PersonalDataDisclosureAttempt[] = [];

  for (const entry of safeReadDir(repoPath)) {
    const absolutePath = path.join(repoPath, entry);
    if (!safeIsFile(absolutePath) || entry === REQUIRED_DISCLOSURE_FILENAME) {
      continue;
    }

    if (isDisclosureNearMatch(entry)) {
      attempts.push({
        path: relativePosixPath(repoPath, absolutePath),
        reason: 'root-near-match'
      });
    }
  }

  for (const directoryName of BOUNDED_NESTED_ATTEMPT_DIRS) {
    collectBoundedNestedAttempts(
      repoPath,
      path.join(repoPath, directoryName),
      0,
      attempts
    );
  }

  return attempts;
}

function hasExactRootFileName(repoPath: string, fileName: string): boolean {
  return safeReadDir(repoPath).includes(fileName);
}

function collectBoundedNestedAttempts(
  repoPath: string,
  directoryPath: string,
  depth: number,
  attempts: S005PersonalDataDisclosureAttempt[]
): void {
  if (depth > MAX_BOUNDED_NESTED_ATTEMPT_DEPTH || !safeIsDirectory(directoryPath) || !isWithinRepo(repoPath, directoryPath)) {
    return;
  }

  for (const entry of safeReadDir(directoryPath)) {
    const absolutePath = path.join(directoryPath, entry);
    if (safeIsDirectory(absolutePath)) {
      collectBoundedNestedAttempts(repoPath, absolutePath, depth + 1, attempts);
      continue;
    }

    if (safeIsFile(absolutePath) && isDisclosureNearMatch(entry)) {
      attempts.push({
        path: relativePosixPath(repoPath, absolutePath),
        reason: 'bounded-nested-near-match'
      });
    }
  }
}

function isDisclosureNearMatch(fileName: string): boolean {
  if (!/\.md$/i.test(fileName)) {
    return false;
  }

  const normalized = normalizeDisclosureFileName(fileName);
  const required = normalizeDisclosureFileName(REQUIRED_DISCLOSURE_FILENAME);

  return normalized.includes(required) || boundedEditDistance(normalized, required, 2) <= 2;
}

function normalizeDisclosureFileName(fileName: string): string {
  return fileName
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function safeReadDir(directoryPath: string): string[] {
  try {
    return fs.readdirSync(directoryPath).sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function safeIsDirectory(candidatePath: string): boolean {
  try {
    const stats = fs.lstatSync(candidatePath);
    return !stats.isSymbolicLink() && stats.isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(candidatePath: string): boolean {
  try {
    const stats = fs.lstatSync(candidatePath);
    return !stats.isSymbolicLink() && stats.isFile();
  } catch {
    return false;
  }
}

function addUniqueAttempt(
  attempts: S005PersonalDataDisclosureAttempt[],
  attempt: S005PersonalDataDisclosureAttempt
): S005PersonalDataDisclosureAttempt[] {
  if (attempts.some(existing => existing.path === attempt.path && existing.reason === attempt.reason)) {
    return attempts;
  }

  return [...attempts, attempt];
}

function boundedEditDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) {
    return maxDistance + 1;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    let rowMinimum = current[0];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const distance = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
      current[rightIndex] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }

    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }

    previous = current;
  }

  return previous[right.length];
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
