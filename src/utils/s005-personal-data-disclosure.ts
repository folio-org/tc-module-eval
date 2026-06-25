import * as fs from 'fs';
import * as path from 'path';

import {
  EvaluationStatus,
  S005PersonalDataCategory,
  S005PersonalDataDisclosureAttempt,
  S005PersonalDataDisclosureAnalysisResult,
  S005PersonalDataDisclosureDiscoveryResult,
  S005PersonalDataDisclosureChecklistItem,
  S005PersonalDataDisclosureContradiction,
  S005PersonalDataDisclosureMetadata,
  S005PersonalDataDisclosureParseResult,
  S005PersonalDataDisclosurePlaceholderEvidence,
  S005PersonalDataEvidenceAssessment,
  S005PersonalDataEvidenceScanResult,
  S005PersonalDataEvidenceSignal,
  S005PersonalDataEvidenceSourceClass,
  S005PersonalDataEvidenceStrength,
  S005PersonalDataPossibleMismatch
} from '../types';
import { isBinaryBuffer, isWithinRepo, readBoundedFileBytes, realPath, relativePosixPath } from './repo-files';
import { redactSensitiveText } from './redaction';

export const REQUIRED_DISCLOSURE_FILENAME = 'PERSONAL_DATA_DISCLOSURE.md';
const MAX_CHECKLIST_LABEL_BYTES = 300;
const MAX_PARSE_ERROR_BYTES = 512;
const MAX_DISCOVERY_READ_ERROR_BYTES = 300;
const MAX_DISCLOSURE_FILE_BYTES = 512 * 1024;
const MAX_DISCLOSURE_CHECKLIST_ITEMS = 500;
const MAX_DISCLOSURE_PLACEHOLDERS = 100;
const MAX_S005_EVIDENCE_SCANNED_FILES = 200;
const MAX_S005_EVIDENCE_TOTAL_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_S005_EVIDENCE_TEXT_BYTES_PER_FILE = 96 * 1024;
export const MAX_S005_EVIDENCE_EXCERPT_BYTES = 700;
export const MAX_SIGNALS_PER_CATEGORY_SOURCE_CLASS = 8;
const BOUNDED_NESTED_ATTEMPT_DIRS = ['docs', 'doc', 'documentation'];
const MAX_BOUNDED_NESTED_ATTEMPT_DEPTH = 2;
const CHECKBOX_PATTERN = /^\s{0,6}[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const VERSION_PATTERN = /\b(?:form\s+version|template\s+version|version)\s*[:|-]\s*(.+)$/i;
const LAST_UPDATED_PATTERN = /\blast\s+updated\s*[:|-]\s*(.+)$/i;
const LAST_REVIEWED_PATTERN = /\blast\s+reviewed\s*[:|-]\s*(.+)$/i;
const PLACEHOLDER_PATTERN = /^(?:todo|tbd|n\/a|\[.*\]|<.*>|yyyy-mm-dd|mm\/dd\/yyyy|date|last updated|last reviewed)$/i;
const GENERATED_REPORT_DIRECTORY_PATTERN = /(?:^|\/)(?:reports?|evaluation-reports?|generated-reports?|coverage|html-report|test-results?)(?:\/|$)/i;
const TEXT_FILE_EXTENSION_PATTERN = /\.(?:avram|conf|cfg|ini|java|js|json|jsx|kt|md|mjs|properties|raml|sql|ts|tsx|txt|xml|yaml|yml)$/i;
const DIRECT_CONTRACT_FILE_PATTERN = /(?:^|\/)(?:schemas?|schema|ramls?|api|apis|descriptors?|interfaces?|module-descriptor)(?:\/|$)|(?:^|\/)(?:module-descriptor|package)\.json$|(?:openapi|swagger|raml|schema)\.(?:json|ya?ml|raml)$/i;
const DOCUMENTATION_FILE_PATTERN = /(?:^|\/)(?:readme|privacy|personal-data|data-handling)[^/]*\.md$|(?:^|\/)(?:docs?|documentation)(?:\/|$)/i;
const UI_FILE_PATTERN = /(?:^|\/)(?:translations|i18n|lang|ui|stripes|components?|routes?)(?:\/|$)|\.(?:jsx|tsx)$/i;
const TEST_SAMPLE_FILE_PATTERN = /(?:^|\/)(?:__tests__|tests?|spec|fixtures?|samples?|examples?)(?:\/|$)|(?:test|spec|fixture|sample|example)\.[^.\/]+$/i;
const AUTOMATION_CONFIG_FILE_PATTERN = /(?:^|\/)(?:\.github|\.gitlab|\.circleci|circleci|buildkite|ci|github\/workflows|workflows)(?:\/|$)|(?:^|\/)(?:Dockerfile|docker-compose\.ya?ml|Jenkinsfile|Makefile)$/i;
const HIGH_SIGNAL_PATH_PATTERN = /(?:schema|raml|openapi|swagger|module-descriptor|package\.json|readme|docs?|documentation|translation|i18n|lang|ui|stripes|component|route|persistence|database|migration|db\/|sql|log4j|logback|logging|logger|queue|event|kafka|pubsub|producer|consumer|cache|redis|s3|blob|bucket|profile|avatar|photo|api|example|sample|fixture)/i;
const HIGH_RISK_PERSONAL_EXAMPLE_PATTERN = /\b(?:john|jane)\s+doe\b|\b(?:ssn|social security number)\s*[:=]?\s*\d{3}[-\s]?\d{2}[-\s]?\d{4}\b|\b(?:credit card|card number)\s*[:=]?\s*(?:\d[ -]?){13,19}\b|\b\d{4}\s+[A-Z][a-z]+(?:\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln))\b/gi;
const LONG_FREE_FORM_VALUE_PATTERN = /(["'`])([^"'`\n]{180,})\1/g;
const PATH_SECRET_PATTERN = /\b(api[-_]?key|token|secret|password|passwd|pwd|credential|auth)([-_:=])[^/\\\s]+/gi;
const PERSONAL_FIELD_VALUE_PATTERN = new RegExp(
  '(["\']?\\b(?:firstName|first_name|lastName|last_name|middleName|middle_name|preferredName|preferred_name|displayName|display_name|fullName|full_name|personalName|personal_name|username|userName|user_name|loginName|login_name|userId|user_id|userUuid|user_uuid|patronId|patron_id|borrowerId|borrower_id|requesterId|requester_id|barcode|externalId|external_id|personalIdentifier|personal_identifier|emailAddress|email_address|email|phone|telephone|mobilePhone|mobile_phone|address|streetAddress|street_address|addressLine\\d*|address_line\\d*|postalCode|postal_code|zipCode|zip_code|city|province|country|location|dateOfBirth|date_of_birth|birthDate|birth_date|birthday|dob|ipAddress|ip_address|clientIp|client_ip|remoteAddr|remote_addr|macAddress|mac_address|notes?|comments?|staffInformation|staff_information|freeForm|free_form|message)["\']?\\s*[:=]\\s*)(?:"[^"\\n]{1,180}"|\'[^\'\\n]{1,180}\'|`[^`\\n]{1,180}`|[A-Za-z0-9._@+\\-:]{2,180})',
  'gi'
);
const NETWORK_IDENTIFIER_VALUE_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b(?:[0-9A-F]{1,4}:){2,7}[0-9A-F]{1,4}\b|\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/gi;
const S005_EVIDENCE_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.github',
  '.gitlab',
  '.idea',
  '.vscode',
  '.circleci',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.nyc_output',
  'reports',
  'report',
  'evaluation-reports',
  'generated-reports',
  'test-results'
]);
const MAX_S005_EVIDENCE_TRAVERSAL_ENTRIES = 5000;

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

const REVIEWABLE_DISCLOSURE_CATEGORIES = new Set<S005PersonalDataCategory>([
  ...PERSONAL_FIELD_CATEGORIES,
  'storage',
  'processing',
  'transmission',
  'cache',
  'logging'
]);
const CATEGORIES_WITHOUT_DETERMINISTIC_OVER_DISCLOSURE = new Set<S005PersonalDataCategory>([
  'processing'
]);

const S005_EVIDENCE_CATEGORY_PATTERNS: ReadonlyArray<{
  category: S005PersonalDataCategory;
  label: string;
  pattern: RegExp;
}> = [
  { category: 'email', label: 'email address field or value', pattern: /\b(?:e-?mail|emailAddress\w*|email_address\w*|emails?)\b/i },
  { category: 'phone', label: 'phone or telephone field', pattern: /\b(?:phone|telephone|mobilePhone|mobile_phone|fax)\b/i },
  { category: 'address', label: 'address or location field', pattern: /\b(?:address|streetAddress\w*|street_address\w*|addressLine\w*|address_line\w*|postalCode\w*|postal_code\w*|zipCode\w*|zip_code\w*|city|province|state|country|location)\b/i },
  { category: 'name', label: 'person name field', pattern: /\b(?:firstName|first_name|lastName|last_name|middleName|middle_name|preferredName|preferred_name|displayName|display_name|fullName|full_name|personalName|personal_name)\b/i },
  { category: 'username', label: 'username or login field', pattern: /\b(?:username|userName|user_name|loginName|login_name)\b/i },
  { category: 'user_identifier', label: 'user or patron identifier', pattern: /\b(?:userId|user_id|userUuid|user_uuid|patronId|patron_id|borrowerId|borrower_id|requesterId|requester_id|barcode|externalId|external_id|personalIdentifier|personal_identifier)\b/i },
  { category: 'birth_date', label: 'birth date field', pattern: /\b(?:dateOfBirth|date_of_birth|birthDate|birth_date|birthday|dob)\b/i },
  { category: 'patron_data', label: 'patron or borrower data', pattern: /\b(?:patron|borrower|requester|sponsor|proxyUser|proxy_user)\b/i },
  { category: 'free_form_notes', label: 'free-form note or comment field', pattern: /\b(?:notes?|comments?|staffInformation|staff_information|freeForm|free_form|message)\b/i },
  { category: 'profile_picture', label: 'profile picture or avatar data', pattern: /\b(?:profilePicture|profile_picture|profileImage|profile_image|avatar|photoUrl|photo_url|pictureUrl|picture_url)\b/i },
  { category: 'ip_or_mac_address', label: 'IP or MAC address field', pattern: /\b(?:ipAddress|ip_address|clientIp|client_ip|remoteAddr|remote_addr|macAddress|mac_address)\b/i },
  { category: 'financial_information', label: 'financial or payment data', pattern: /\b(?:payment|creditCard|credit_card|cardNumber|card_number|bankAccount|bank_account|invoice|fee|fine|financial)\b/i },
  { category: 'circulation_transactions', label: 'circulation transaction data', pattern: /\b(?:circulation|loan|checkout|checkin|check-in|checkin|renewal|holdRequest|hold_request|itemRequest|item_request)\b/i },
  { category: 'custom_fields', label: 'custom field data', pattern: /\b(?:customFields?|custom_fields?|customFieldValues?|custom_field_values?|userDefined|user_defined)\b/i },
  { category: 'logging', label: 'logging of user or personal data', pattern: /\b(?:log(?:ger|ging)?|log\.(?:info|warn|error|debug)|auditLog|audit_log|log4j|logback)\b/i },
  { category: 'transmission', label: 'queue, event, API, or external transmission', pattern: /\b(?:kafka|queue|eventProducer|event_producer|publish(?:er)?|producer|webhook|externalSystem|external_system|thirdParty|third_party|httpClient|http_client|okapi|export|import|searchIndex|search_index)\b/i },
  { category: 'storage', label: 'persistence or external storage', pattern: /\b(?:persist(?:ence)?|repository|database|db\.|create\s+table|alter\s+table|column|s3|\w*Bucket|bucket|blob|objectStorage|object_storage)\b/i },
  { category: 'cache', label: 'cache of user or personal data', pattern: /\b(?:\w*Cache|cache|cached|redis|caffeine|ehcache|hazelcast)\b/i }
];

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

  let rootEntries: string[];
  try {
    rootEntries = readSortedDir(repoRoot);
  } catch (error) {
    return {
      status: 'unreadable',
      attempts: [],
      readError: redactS005PersonalDataPath(
        error instanceof Error ? error.message : String(error),
        MAX_DISCOVERY_READ_ERROR_BYTES
      ),
      warnings
    };
  }

  const attempts = discoverS005AttemptedDisclosureFiles(repoRoot, rootEntries);
  const exactPath = path.join(repoRoot, REQUIRED_DISCLOSURE_FILENAME);

  if (!hasExactRootFileName(rootEntries, REQUIRED_DISCLOSURE_FILENAME)) {
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
        content: readBoundedDisclosureText(exactPath, warnings)
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
      readError: redactS005PersonalDataPath(
        error instanceof Error ? error.message : String(error),
        MAX_DISCOVERY_READ_ERROR_BYTES
      ),
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

    if (checklistItems.length >= MAX_DISCLOSURE_CHECKLIST_ITEMS) {
      if (!warnings.some(warning => warning.includes('checklist item cap'))) {
        warnings.push(`S005 disclosure parsing reached the ${MAX_DISCLOSURE_CHECKLIST_ITEMS}-item checklist item cap; additional checklist items were truncated.`);
      }
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
        reason: parseError.message
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
        : 'No checked disclosure answers were found for personal-data or processing questions.'
    },
    warnings
  };
}

export function gatherS005PersonalDataEvidence(repoPath: string): S005PersonalDataEvidenceScanResult {
  const repoRoot = realPath(repoPath);
  if (!repoRoot) {
    return {
      signals: [],
      scannedFiles: [],
      skippedFiles: [],
      warnings: ['Unable to resolve repository path while gathering S005 personal-data evidence.']
    };
  }

  const warnings: string[] = [];
  const skippedFiles: S005PersonalDataEvidenceScanResult['skippedFiles'] = [];
  const candidateDiscovery = collectBoundedS005EvidenceCandidates(repoRoot);
  const candidateFiles = candidateDiscovery.files;
  warnings.push(...candidateDiscovery.warnings);
  skippedFiles.push(...candidateDiscovery.skippedFiles);

  if (candidateDiscovery.truncated) {
    warnings.push(
      `S005 evidence scan reached the ${MAX_S005_EVIDENCE_SCANNED_FILES}-file scan cap; additional candidate files were not scanned.`
    );
  }

  const signals: S005PersonalDataEvidenceSignal[] = [];
  const retentionCounts = new Map<string, number>();
  const retentionWarnings = new Set<string>();
  const scannedFiles: string[] = [];
  let totalTextBytes = 0;
  let totalCapReached = false;

  for (const candidatePath of candidateFiles) {
    if (totalTextBytes >= MAX_S005_EVIDENCE_TOTAL_TEXT_BYTES) {
      totalCapReached = true;
      break;
    }

    const relativePath = relativePosixPath(repoRoot, candidatePath);
    if (!isWithinRepo(repoRoot, candidatePath)) {
      skippedFiles.push({ path: relativePath, reason: 'outside-repository' });
      continue;
    }

    if (looksLikeGeneratedReportPath(relativePath) || !TEXT_FILE_EXTENSION_PATTERN.test(relativePath)) {
      skippedFiles.push({ path: relativePath, reason: 'unsupported-file' });
      continue;
    }

    const readResult = readBoundedEvidenceText(candidatePath, relativePath, warnings, MAX_S005_EVIDENCE_TOTAL_TEXT_BYTES - totalTextBytes);
    if (readResult.status === 'binary') {
      skippedFiles.push({ path: relativePath, reason: 'binary' });
      continue;
    }
    if (readResult.status === 'read-error') {
      skippedFiles.push({
        path: relativePath,
        reason: 'read-error',
        message: readResult.message
      });
      continue;
    }
    if (readResult.status === 'empty') {
      scannedFiles.push(relativePath);
      continue;
    }

    scannedFiles.push(relativePath);
    totalTextBytes += readResult.bytesRead;
    if (readResult.totalCapReached) {
      totalCapReached = true;
    }

    const sourceClass = classifyS005EvidenceSourceClass(relativePath);
    for (const signal of extractS005EvidenceSignals(relativePath, readResult.text, sourceClass)) {
      const retentionKey = `${signal.category}:${signal.sourceClass}`;
      const retainedCount = retentionCounts.get(retentionKey) ?? 0;
      if (retainedCount >= MAX_SIGNALS_PER_CATEGORY_SOURCE_CLASS) {
        if (!retentionWarnings.has(retentionKey)) {
          retentionWarnings.add(retentionKey);
          warnings.push(
            `S005 evidence retained first ${MAX_SIGNALS_PER_CATEGORY_SOURCE_CLASS} signals for category "${signal.category}" and source class "${signal.sourceClass}"; additional signals were truncated.`
          );
        }
        continue;
      }

      retentionCounts.set(retentionKey, retainedCount + 1);
      signals.push(signal);
    }

    if (totalCapReached) {
      break;
    }
  }

  if (totalCapReached) {
    warnings.push(
      `S005 evidence scan stopped because the ${MAX_S005_EVIDENCE_TOTAL_TEXT_BYTES}-byte total text cap was reached.`
    );
  }

  return {
    signals,
    scannedFiles,
    skippedFiles,
    warnings
  };
}

export function analyzeS005PersonalDataDisclosure(repoPath: string): S005PersonalDataDisclosureAnalysisResult {
  const discovery = discoverS005PersonalDataDisclosureArtifact(repoPath);

  if (discovery.status === 'missing') {
    return unparsedS005DisclosureResult(
      discovery,
      'Required top-level PERSONAL_DATA_DISCLOSURE.md was not found.',
      discovery.warnings
    );
  }

  if (discovery.status === 'unreadable') {
    const warnings = discovery.warnings;
    return unparsedS005DisclosureResult(
      discovery,
      'Required top-level PERSONAL_DATA_DISCLOSURE.md could not be read.',
      warnings
    );
  }

  const parseResult = parseS005PersonalDataDisclosureMarkdown(discovery.artifact?.content ?? '');
  if (parseResult.classification.status === EvaluationStatus.FAIL) {
    const reason = parseResult.classification.parseState === 'unparseable'
      ? parseResult.classification.reason
      : incompleteDisclosureReason(parseResult);
    const warnings = [...discovery.warnings, ...parseResult.warnings];

    return {
      discovery,
      parseResult,
      classification: {
        status: EvaluationStatus.FAIL,
        parseState: parseResult.classification.parseState,
        reason
      },
      possibleMismatches: contradictionMismatches(parseResult.contradictions),
      matchingEvidence: [],
      supportingEvidence: [],
      uncheckedAnswerDetails: parseResult.checklistItems.filter(item => !item.checked),
      placeholders: parseResult.placeholders,
      contradictions: parseResult.contradictions,
      warnings
    };
  }

  const evidenceScan = gatherS005PersonalDataEvidence(repoPath);
  const classified = classifyCompletedS005PersonalDataDisclosure(parseResult, evidenceScan);
  const warnings = [...discovery.warnings, ...parseResult.warnings, ...evidenceScan.warnings, ...classified.warnings];

  return {
    discovery,
    parseResult,
    evidenceScan,
    classification: {
      status: EvaluationStatus.MANUAL,
      parseState: 'completed',
      reason: classified.reason
    },
    possibleMismatches: classified.possibleMismatches,
    matchingEvidence: classified.matchingEvidence,
    supportingEvidence: classified.supportingEvidence,
    uncheckedAnswerDetails: parseResult.checklistItems.filter(item => !item.checked),
    placeholders: parseResult.placeholders,
    contradictions: parseResult.contradictions,
    warnings
  };
}

function unparsedS005DisclosureResult(
  discovery: S005PersonalDataDisclosureDiscoveryResult,
  reason: string,
  warnings: string[]
): S005PersonalDataDisclosureAnalysisResult {
  return {
    discovery,
    classification: {
      status: EvaluationStatus.FAIL,
      parseState: 'not_parsed',
      reason
    },
    possibleMismatches: [],
    matchingEvidence: [],
    supportingEvidence: [],
    uncheckedAnswerDetails: [],
    placeholders: [],
    contradictions: [],
    warnings
  };
}

export {
  buildS005CriterionDetails,
  formatS005Evidence
} from './s005-personal-data-disclosure-report';

export function classifyCompletedS005PersonalDataDisclosure(
  parseResult: S005PersonalDataDisclosureParseResult,
  evidenceScan: S005PersonalDataEvidenceScanResult
): {
  reason: string;
  possibleMismatches: S005PersonalDataPossibleMismatch[];
  matchingEvidence: S005PersonalDataEvidenceAssessment[];
  supportingEvidence: S005PersonalDataEvidenceAssessment[];
  warnings: string[];
} {
  const checkedCategories = new Set(
    parseResult.checkedCategories.filter(category => REVIEWABLE_DISCLOSURE_CATEGORIES.has(category))
  );
  const noPersonalDataChecked = parseResult.checkedCategories.includes('no_personal_data');
  const signalsByCategory = groupSignalsByCategory(evidenceScan.signals);
  const possibleMismatches: S005PersonalDataPossibleMismatch[] = [
    ...contradictionMismatches(parseResult.contradictions)
  ];
  const matchingEvidence: S005PersonalDataEvidenceAssessment[] = [];
  const supportingEvidence: S005PersonalDataEvidenceAssessment[] = [];

  for (const category of uniqueCategories([
    ...Array.from(checkedCategories),
    ...Array.from(signalsByCategory.keys())
  ])) {
    if (!REVIEWABLE_DISCLOSURE_CATEGORIES.has(category)) {
      continue;
    }

    const signals = signalsByCategory.get(category) ?? [];
    const strongSignals = signals.filter(signal => signal.strength === 'strong');
    const candidateSignals = signals.filter(signal => signal.strength === 'candidate');
    const contextSignals = signals.filter(signal => signal.strength === 'context');
    const disclosureChecked = checkedCategories.has(category);

    if (disclosureChecked && (strongSignals.length || candidateSignals.length)) {
      matchingEvidence.push(evidenceAssessment(
        'likely_match',
        category,
        `Disclosure checks ${category} and deterministic source signals mention the same category.`,
        [...strongSignals, ...candidateSignals]
      ));
      continue;
    }

    if (disclosureChecked && contextSignals.length) {
      supportingEvidence.push(evidenceAssessment(
        'context_only',
        category,
        `Disclosure checks ${category}; only documentation, test, or sample context was found for this category.`,
        contextSignals
      ));
      continue;
    }

    if (disclosureChecked && !CATEGORIES_WITHOUT_DETERMINISTIC_OVER_DISCLOSURE.has(category)) {
      possibleMismatches.push({
        kind: 'possible_over_disclosure',
        category,
        message: `Disclosure checks ${category}, but deterministic source scanning did not find corresponding source signals.`,
        evidenceReferences: []
      });
      continue;
    }

    if (strongSignals.length) {
      possibleMismatches.push({
        kind: 'likely_omission',
        category,
        message: `Disclosure does not check ${category}, but direct contract or production implementation evidence mentions it.`,
        evidenceReferences: signalReferences(strongSignals),
        sourceClasses: uniqueSourceClasses(strongSignals),
        signalStrengths: uniqueStrengths(strongSignals)
      });
      continue;
    }

    if (candidateSignals.length) {
      possibleMismatches.push({
        kind: 'possible_omission',
        category,
        message: `Disclosure does not check ${category}, but UI evidence mentions it.`,
        evidenceReferences: signalReferences(candidateSignals),
        sourceClasses: uniqueSourceClasses(candidateSignals),
        signalStrengths: uniqueStrengths(candidateSignals)
      });
      continue;
    }

    if (contextSignals.length) {
      supportingEvidence.push(evidenceAssessment(
        'context_only',
        category,
        `Disclosure does not check ${category}; only documentation, test, or sample context was found.`,
        contextSignals
      ));
    }
  }

  const strongPersonalSignals = evidenceScan.signals.filter(signal =>
    PERSONAL_FIELD_CATEGORIES.has(signal.category) && signal.strength === 'strong'
  );

  if (noPersonalDataChecked && strongPersonalSignals.length) {
    possibleMismatches.push({
      kind: 'likely_omission',
      category: 'no_personal_data',
      message: 'No-personal-data answer is checked, but strong personal-data source signals were found.',
      evidenceReferences: signalReferences(strongPersonalSignals),
      sourceClasses: uniqueSourceClasses(strongPersonalSignals),
      signalStrengths: uniqueStrengths(strongPersonalSignals)
    });
  } else if (noPersonalDataChecked) {
    const supportSignals = evidenceScan.signals.filter(signal => signal.strength !== 'strong').slice(0, 8);
    supportingEvidence.push(evidenceAssessment(
      'supporting_no_personal_data',
      'no_personal_data',
      strongPersonalSignals.length
        ? 'No-personal-data answer is checked; strong signal review remains manual.'
        : 'No-personal-data answer is checked and deterministic scanning found no strong personal-data source signals.',
      supportSignals
    ));
  }

  return {
    reason: 'Completed S005 personal data disclosure form requires reviewer judgment; deterministic checks only classify mechanics, completion, and possible mismatches.',
    possibleMismatches: dedupeMismatches(possibleMismatches),
    matchingEvidence,
    supportingEvidence,
    warnings: []
  };
}

function incompleteDisclosureReason(parseResult: S005PersonalDataDisclosureParseResult): string {
  if (parseResult.placeholders.length) {
    return 'Disclosure form appears incomplete or blank because required review metadata still contains placeholder values and no meaningful answer is checked.';
  }

  return parseResult.classification.reason;
}

function contradictionMismatches(
  contradictions: S005PersonalDataDisclosureContradiction[]
): S005PersonalDataPossibleMismatch[] {
  return contradictions.map(contradiction => ({
    kind: 'contradiction',
    message: contradiction.message,
    category: 'no_personal_data',
    evidenceReferences: contradiction.lineNumbers.map(lineNumber => `PERSONAL_DATA_DISCLOSURE.md:${lineNumber}`),
    signalStrengths: [],
    sourceClasses: []
  }));
}

function groupSignalsByCategory(
  signals: S005PersonalDataEvidenceSignal[]
): Map<S005PersonalDataCategory, S005PersonalDataEvidenceSignal[]> {
  const grouped = new Map<S005PersonalDataCategory, S005PersonalDataEvidenceSignal[]>();
  for (const signal of signals) {
    const categorySignals = grouped.get(signal.category);
    if (categorySignals) {
      categorySignals.push(signal);
    } else {
      grouped.set(signal.category, [signal]);
    }
  }

  return grouped;
}

function evidenceAssessment(
  kind: S005PersonalDataEvidenceAssessment['kind'],
  category: S005PersonalDataCategory,
  message: string,
  signals: S005PersonalDataEvidenceSignal[]
): S005PersonalDataEvidenceAssessment {
  return {
    kind,
    category,
    message,
    evidenceReferences: signalReferences(signals),
    sourceClasses: uniqueSourceClasses(signals),
    signalStrengths: uniqueStrengths(signals)
  };
}

function signalReferences(signals: S005PersonalDataEvidenceSignal[]): string[] {
  return signals.map(signal => `${signal.path}${signal.line ? `:${signal.line}` : ''} [${signal.sourceClass}/${signal.strength}/${signal.category}]`);
}

function uniqueSourceClasses(signals: S005PersonalDataEvidenceSignal[]): S005PersonalDataEvidenceSourceClass[] {
  return [...new Set(signals.map(signal => signal.sourceClass))];
}

function uniqueStrengths(signals: S005PersonalDataEvidenceSignal[]): S005PersonalDataEvidenceStrength[] {
  return [...new Set(signals.map(signal => signal.strength))];
}

function dedupeMismatches(mismatches: S005PersonalDataPossibleMismatch[]): S005PersonalDataPossibleMismatch[] {
  const seen = new Set<string>();
  const deduped: S005PersonalDataPossibleMismatch[] = [];

  for (const mismatch of mismatches) {
    const key = `${mismatch.kind}:${mismatch.category ?? ''}:${mismatch.evidenceReferences.join('|')}:${mismatch.message}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(mismatch);
  }

  return deduped;
}

export function normalizeS005ChecklistCategory(label: string): S005PersonalDataCategory {
  const normalized = label.toLowerCase();

  // Checklist rows carry one category in reports; multi-category labels use the first specific match below.
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
      .replace(PERSONAL_FIELD_VALUE_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED_VALUE]`)
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]')
      .replace(NETWORK_IDENTIFIER_VALUE_PATTERN, '[REDACTED_NETWORK_IDENTIFIER]')
      .replace(HIGH_RISK_PERSONAL_EXAMPLE_PATTERN, '[REDACTED_PERSONAL_EXAMPLE]')
      .replace(LONG_FREE_FORM_VALUE_PATTERN, (_match, quote) => `${quote}[REDACTED_LONG_TEXT]${quote}`),
    maxBytes
  );
}

export function redactS005PersonalDataPath(input: string, maxBytes: number = MAX_CHECKLIST_LABEL_BYTES): string {
  return redactS005PersonalDataText(input.replace(PATH_SECRET_PATTERN, (_match, key: string, separator: string) => {
    return `${key}${separator}[REDACTED]`;
  }), maxBytes);
}

function redactS005EvidenceExcerpt(input: string): string {
  return redactS005PersonalDataText(input, MAX_S005_EVIDENCE_EXCERPT_BYTES);
}

function collectBoundedS005EvidenceCandidates(repoPath: string): {
  files: string[];
  truncated: boolean;
  skippedFiles: S005PersonalDataEvidenceScanResult['skippedFiles'];
  warnings: string[];
} {
  const files: string[] = [];
  const skippedFiles: S005PersonalDataEvidenceScanResult['skippedFiles'] = [];
  const warnings: string[] = [];
  let truncated = false;
  let visitedEntries = 0;

  const walk = (currentPath: string): void => {
    if (visitedEntries >= MAX_S005_EVIDENCE_TRAVERSAL_ENTRIES) {
      truncated = true;
      return;
    }
    visitedEntries += 1;

    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch {
      skippedFiles.push({
        path: redactS005PersonalDataPath(relativePosixPath(repoPath, currentPath)),
        reason: 'read-error',
        message: 'Unable to inspect path while discovering S005 evidence candidates.'
      });
      return;
    }

    if (stats.isSymbolicLink()) {
      return;
    }

    if (stats.isFile()) {
      if (isS005EvidenceCandidate(repoPath, currentPath)) {
        files.push(currentPath);
      }
      return;
    }

    if (!stats.isDirectory()) {
      return;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(currentPath).sort((left, right) => left.localeCompare(right));
    } catch {
      skippedFiles.push({
        path: redactS005PersonalDataPath(relativePosixPath(repoPath, currentPath)),
        reason: 'read-error',
        message: 'Unable to read directory while discovering S005 evidence candidates.'
      });
      return;
    }

    for (const entry of entries) {
      if (S005_EVIDENCE_SKIPPED_DIRS.has(entry)) {
        continue;
      }
      walk(path.join(currentPath, entry));
      if (truncated) {
        return;
      }
    }
  };

  walk(repoPath);
  if (files.length > MAX_S005_EVIDENCE_SCANNED_FILES) {
    truncated = true;
  }
  if (visitedEntries >= MAX_S005_EVIDENCE_TRAVERSAL_ENTRIES) {
    warnings.push(
      `S005 evidence discovery reached the ${MAX_S005_EVIDENCE_TRAVERSAL_ENTRIES}-entry traversal cap; additional paths were not inspected.`
    );
  }
  return {
    files: prioritizeS005EvidenceCandidates(repoPath, files).slice(0, MAX_S005_EVIDENCE_SCANNED_FILES),
    truncated,
    skippedFiles,
    warnings
  };
}

function isS005EvidenceCandidate(repoPath: string, candidatePath: string): boolean {
  if (!isWithinRepo(repoPath, candidatePath)) {
    return false;
  }

  const relativePath = relativePosixPath(repoPath, candidatePath);
  if (path.basename(relativePath) === REQUIRED_DISCLOSURE_FILENAME || looksLikeGeneratedReportPath(relativePath)) {
    return false;
  }

  if (!TEXT_FILE_EXTENSION_PATTERN.test(relativePath)) {
    return false;
  }

  if (AUTOMATION_CONFIG_FILE_PATTERN.test(relativePath)) {
    return false;
  }

  return (
    HIGH_SIGNAL_PATH_PATTERN.test(relativePath) ||
    /(?:^|\/)src\/.*\.(?:java|kt|js|jsx|ts|tsx|xml|properties|ya?ml)$/i.test(relativePath) ||
    /(?:^|\/)(?:package|module-descriptor)\.json$/i.test(relativePath)
  );
}

function prioritizeS005EvidenceCandidates(repoPath: string, files: string[]): string[] {
  return files
    .map(filePath => {
      const relativePath = relativePosixPath(repoPath, filePath);
      return {
        filePath,
        relativePath,
        priority: s005CandidatePriority(relativePath)
      };
    })
    .sort((left, right) => left.priority - right.priority || left.relativePath.localeCompare(right.relativePath))
    .map(candidate => candidate.filePath);
}

function s005CandidatePriority(relativePath: string): number {
  if (DOCUMENTATION_FILE_PATTERN.test(relativePath) || /\.md$/i.test(relativePath)) {
    return 3;
  }

  const sourceClass = classifyS005EvidenceSourceClass(relativePath);
  const priority: Record<S005PersonalDataEvidenceSourceClass, number> = {
    direct_contract: 0,
    implementation: 1,
    ui: 2,
    documentation: 3,
    test_sample: 4
  };
  return priority[sourceClass];
}

function looksLikeGeneratedReportPath(relativePath: string): boolean {
  return GENERATED_REPORT_DIRECTORY_PATTERN.test(relativePath);
}

function classifyS005EvidenceSourceClass(relativePath: string): S005PersonalDataEvidenceSourceClass {
  if (TEST_SAMPLE_FILE_PATTERN.test(relativePath)) {
    return 'test_sample';
  }
  if (AUTOMATION_CONFIG_FILE_PATTERN.test(relativePath)) {
    return 'documentation';
  }
  if (DIRECT_CONTRACT_FILE_PATTERN.test(relativePath)) {
    return 'direct_contract';
  }
  if (UI_FILE_PATTERN.test(relativePath)) {
    return 'ui';
  }
  if (DOCUMENTATION_FILE_PATTERN.test(relativePath)) {
    return 'documentation';
  }
  return 'implementation';
}

function evidenceStrengthForSourceClass(sourceClass: S005PersonalDataEvidenceSourceClass): S005PersonalDataEvidenceStrength {
  if (sourceClass === 'test_sample') {
    return 'context';
  }
  if (sourceClass === 'documentation') {
    return 'context';
  }
  if (sourceClass === 'ui') {
    return 'candidate';
  }
  return 'strong';
}

function extractS005EvidenceSignals(
  relativePath: string,
  text: string,
  sourceClass: S005PersonalDataEvidenceSourceClass
): S005PersonalDataEvidenceSignal[] {
  const signals: S005PersonalDataEvidenceSignal[] = [];
  const strength = evidenceStrengthForSourceClass(sourceClass);
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    const categoriesSeenOnLine = new Set<S005PersonalDataCategory>();
    for (const categoryPattern of S005_EVIDENCE_CATEGORY_PATTERNS) {
      if (!categoryPattern.pattern.test(line) || categoriesSeenOnLine.has(categoryPattern.category)) {
        continue;
      }

      categoriesSeenOnLine.add(categoryPattern.category);
      signals.push({
        category: categoryPattern.category,
        label: categoryPattern.label,
        path: relativePath,
        line: index + 1,
        excerpt: redactS005EvidenceExcerpt(line.trim()),
        sourceClass,
        strength
      });
    }
  }

  return signals;
}

function readBoundedEvidenceText(
  filePath: string,
  relativePath: string,
  warnings: string[],
  remainingTotalBytes: number
): { status: 'text'; text: string; bytesRead: number; totalCapReached: boolean } |
  { status: 'empty'; bytesRead: 0; totalCapReached: boolean } |
  { status: 'binary' } |
  { status: 'read-error'; message: string } {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return { status: 'empty', bytesRead: 0, totalCapReached: false };
    }
    if (stats.size === 0 || remainingTotalBytes <= 0) {
      return { status: 'empty', bytesRead: 0, totalCapReached: remainingTotalBytes <= 0 };
    }

    const bytesToRead = Math.min(stats.size, MAX_S005_EVIDENCE_TEXT_BYTES_PER_FILE, remainingTotalBytes);
    const slice = readBoundedFileBytes(filePath, bytesToRead);
    const bytesRead = slice.length;
    if (isBinaryBuffer(slice)) {
      return { status: 'binary' };
    }

    if (stats.size > MAX_S005_EVIDENCE_TEXT_BYTES_PER_FILE) {
      warnings.push(
        `S005 evidence scanning truncated ${relativePath} to ${MAX_S005_EVIDENCE_TEXT_BYTES_PER_FILE} bytes per file.`
      );
    }

    if (bytesRead === 0) {
      return {
        status: 'empty',
        bytesRead: 0,
        totalCapReached: stats.size > remainingTotalBytes
      };
    }

    return {
      status: 'text',
      text: slice.toString('utf-8').replace(/\uFFFD$/, ''),
      bytesRead,
      totalCapReached: stats.size > remainingTotalBytes
    };
  } catch (error) {
    return {
      status: 'read-error',
      message: redactS005PersonalDataText(error instanceof Error ? error.message : String(error), 240)
    };
  }
}

function readBoundedDisclosureText(filePath: string, warnings: string[]): string {
  const stats = fs.statSync(filePath);
  const bytesToRead = Math.min(stats.size, MAX_DISCLOSURE_FILE_BYTES);
  const buffer = readBoundedFileBytes(filePath, bytesToRead);
  if (stats.size > MAX_DISCLOSURE_FILE_BYTES) {
    warnings.push(
      `S005 disclosure artifact was truncated to ${MAX_DISCLOSURE_FILE_BYTES} bytes before parsing.`
    );
  }
  return buffer.toString('utf-8').replace(/\uFFFD$/, '');
}

function captureMetadata(
  line: string,
  lineNumber: number,
  metadata: S005PersonalDataDisclosureMetadata,
  placeholders: S005PersonalDataDisclosurePlaceholderEvidence[]
): void {
  const versionMatch = line.match(VERSION_PATTERN);
  if (versionMatch && !metadata.versionText) {
    metadata.versionText = redactS005PersonalDataText(stripInlineMarkdown(versionMatch[1]).trim(), 240);
    metadata.versionLineNumber = lineNumber;
  }

  const updatedMatch = line.match(LAST_UPDATED_PATTERN);
  if (updatedMatch && !metadata.lastUpdatedText) {
    metadata.lastUpdatedText = redactS005PersonalDataText(stripInlineMarkdown(updatedMatch[1]).trim(), 240);
    metadata.lastUpdatedLineNumber = lineNumber;
    addPlaceholderIfNeeded('Last Updated', metadata.lastUpdatedText, lineNumber, line, placeholders);
  }

  const reviewedMatch = line.match(LAST_REVIEWED_PATTERN);
  if (reviewedMatch && !metadata.lastReviewedText) {
    metadata.lastReviewedText = redactS005PersonalDataText(stripInlineMarkdown(reviewedMatch[1]).trim(), 240);
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
  if (placeholders.length >= MAX_DISCLOSURE_PLACEHOLDERS) {
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

function discoverS005AttemptedDisclosureFiles(repoPath: string, rootEntries: string[]): S005PersonalDataDisclosureAttempt[] {
  const attempts: S005PersonalDataDisclosureAttempt[] = [];

  for (const entry of rootEntries) {
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

function hasExactRootFileName(rootEntries: string[], fileName: string): boolean {
  return rootEntries.includes(fileName);
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
    return readSortedDir(directoryPath);
  } catch {
    return [];
  }
}

function readSortedDir(directoryPath: string): string[] {
  return fs.readdirSync(directoryPath).sort((left, right) => left.localeCompare(right));
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
