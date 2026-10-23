import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  ModuleKindResult,
  S005PersonalDataCategory,
  S005PersonalDataDisclosureAttempt,
  S005PersonalDataDisclosureAnalysisResult,
  S005PersonalDataDisclosureChecklistItem,
  S005PersonalDataDisclosureContradiction,
  S005PersonalDataDisclosureMetadata,
  S005PersonalDataDisclosureParseResult,
  S005PersonalDataDisclosureParseState,
  S005PersonalDataDisclosureTemplateIdentity,
  S005PersonalDataDisclosurePlaceholderEvidence,
  S005PersonalDataEvidenceAssessment,
  S005PersonalDataEvidenceScanResult,
  S005PersonalDataEvidenceSignal,
  S005PersonalDataEvidenceSourceClass,
  S005PersonalDataPossibleMismatch
} from '../types';
import {
  REQUIRED_DISCLOSURE_FILENAME,
  S005_CATEGORY_TITLES,
  S005_SOURCE_CLASS_TAGS,
  boundS005Text
} from './s005-personal-data-disclosure';
import { evidenceStrengthRank } from './evidence-strength';
import { reportPath, reportText } from './report-text';

const MAX_REPORT_LIST_ITEMS = 8;
const MAX_REPORT_ANSWER_ITEMS = 60;
const FORM_STATUS_LABELS: Record<S005PersonalDataDisclosureParseState, string> = {
  completed: 'complete',
  incomplete: 'incomplete',
  unparseable: 'could not be read as a disclosure form',
  not_parsed: 'not read'
};
const TEMPLATE_LABELS: Record<S005PersonalDataDisclosureTemplateIdentity, string> = {
  'current-like': 'current template',
  'older-or-custom': 'older or custom template',
  unknown: 'not recognized'
};
const MAX_CRITERION_DETAIL_REFERENCES = 16;
const MAX_CRITERION_DETAIL_FILES = 40;
const MAX_REPORT_DETAILS_BYTES = 12_000;

export function formatS005Evidence(
  analysis: S005PersonalDataDisclosureAnalysisResult,
  moduleKind: ModuleKindResult,
  agentReview?: CriterionAgentReviewResult
): { evidence: string; details: string } {
  const evidence = `S005 ${analysis.classification.status}: ${analysis.classification.reason}`;
  const parseResult = analysis.parseResult;
  const evidenceScan = analysis.evidenceScan;
  const disclosurePath = analysis.discovery.artifact?.path ?? REQUIRED_DISCLOSURE_FILENAME;
  const supportingLines: Array<string | undefined> = [
    'Artifact mechanics:',
    `  - Repository kind: ${moduleKind.kind}`,
    ...moduleKind.evidence.map(evidenceItem => `  - Module-kind evidence: ${reportText(evidenceItem)}`),
    `  - Required file: ${REQUIRED_DISCLOSURE_FILENAME}`,
    `  - Discovery status: ${analysis.discovery.status}`,
    analysis.discovery.status === 'found' ? `  - Disclosure artifact: ${reportText(disclosurePath)}` : `  - Missing exact file: ${REQUIRED_DISCLOSURE_FILENAME}`,
    analysis.discovery.status !== 'found' && analysis.discovery.artifact ? `  - Analyzed near match: ${reportText(disclosurePath)}` : undefined,
    analysis.discovery.readError ? `  - Read error: ${reportText(analysis.discovery.readError)}` : undefined,
    ...formatAttemptLines(analysis.discovery.attempts),
    '',
    'Disclosure form:',
    `  - Form status: ${FORM_STATUS_LABELS[analysis.classification.parseState]}`,
    parseResult ? `  - Form template: ${TEMPLATE_LABELS[parseResult.metadata.templateIdentity]}` : undefined,
    parseResult?.metadata.versionText ? `  - Form version: ${reportText(parseResult.metadata.versionText)}` : undefined,
    parseResult?.metadata.lastUpdatedText ? `  - Last updated: ${reportText(parseResult.metadata.lastUpdatedText)}` : undefined,
    parseResult?.metadata.lastReviewedText ? `  - Last reviewed: ${reportText(parseResult.metadata.lastReviewedText)}` : undefined,
    ...(parseResult ? formatAnswerLines('Checked answers:', parseResult.checklistItems.filter(item => item.checked)) : []),
    ...(parseResult ? formatAnswerLines('Unchecked answers:', analysis.uncheckedAnswerDetails) : []),
    ...formatPlaceholderLines(analysis.placeholders),
    ...formatParseErrorLines(parseResult),
    '',
    'Evidence from the code:',
    evidenceScan
      ? `  - Files scanned: ${evidenceScan.scannedFiles.length}`
      : '  - Files scanned: none (the code is scanned only when the form is complete)',
    evidenceScan ? `  - Matches found: ${evidenceScan.signals.length}` : undefined,
    ...formatAssessmentLines('Answers confirmed by the code:', analysis.matchingEvidence),
    ...formatAssessmentLines('Other evidence:', analysis.supportingEvidence),
    ...formatSignalLines(evidenceScan?.signals ?? [], analysis)
  ];
  const findingsLines: string[] = [
    '',
    'Possible mismatches:',
    ...formatContradictionLines(analysis.contradictions, disclosurePath),
    ...formatMismatchLines(analysis.possibleMismatches),
    ...(analysis.contradictions.length || analysis.possibleMismatches.length ? [] : ['  - none'])
  ];
  const warningLines = formatWarningLines(analysis.warnings);
  const agentLines: Array<string | undefined> = [];
  appendAgentReviewLines(agentLines, analysis, agentReview);

  const allLines = [...supportingLines, ...findingsLines, ...warningLines, ...agentLines]
    .filter((line): line is string => line !== undefined);
  const fullDetails = allLines.join('\n');

  if (Buffer.byteLength(fullDetails, 'utf8') <= MAX_REPORT_DETAILS_BYTES) {
    return {
      evidence: boundS005Text(evidence, 700),
      details: fullDetails
    };
  }

  const findingsText = boundS005Text(formatBoundedFindings(analysis).join('\n'), 2_000);
  const warningsText = boundS005Text(warningLines.join('\n'), 500);
  const agentText = boundS005Text(formatBoundedAgentReview(analysis, agentReview).join('\n'), 4_000);
  const tail = [findingsText, warningsText, agentText].filter(Boolean).join('\n');
  const separator = tail ? '\n' : '';
  const supportBudget = MAX_REPORT_DETAILS_BYTES - Buffer.byteLength(separator + tail, 'utf8');
  const details = wholeLinePreview(
    supportingLines.filter((line): line is string => line !== undefined),
    supportBudget
  ) + separator + tail;

  return {
    evidence: boundS005Text(evidence, 700),
    details
  };
}

function wholeLinePreview(lines: string[], maxBytes: number): string {
  const included: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const candidate = [...included, lines[index]].join('\n');
    const omitted = lines.length - index - 1;
    const marker = omitted > 0 ? `\n  - Preview rows included: ${index + 1}; omitted: ${omitted}` : '';
    if (Buffer.byteLength(candidate + marker, 'utf8') > maxBytes) {
      break;
    }
    included.push(lines[index]);
  }
  const omitted = lines.length - included.length;
  return included.join('\n') + (omitted > 0
    ? `${included.length ? '\n' : ''}  - Preview rows included: ${included.length}; omitted: ${omitted}`
    : '');
}

function formatBoundedFindings(analysis: S005PersonalDataDisclosureAnalysisResult): string[] {
  return [
    '',
    'Possible mismatches:',
    ...(analysis.contradictions.length ? [
      '  - Contradictions:',
      ...analysis.contradictions.slice(0, MAX_REPORT_LIST_ITEMS).map(contradiction =>
        `    - ${boundS005Text(reportText(contradiction.message), 500)}${formatBoundedReferences(contradiction.lineNumbers.map(line => `${reportPath(analysis.discovery.artifact?.path ?? REQUIRED_DISCLOSURE_FILENAME)}:${line}`))}`
      ),
      ...overflowLine(analysis.contradictions.length, MAX_REPORT_LIST_ITEMS)
    ] : []),
    ...(analysis.possibleMismatches.length ? [
      '  - Mismatch signals:',
      ...analysis.possibleMismatches.slice(0, MAX_REPORT_LIST_ITEMS).map(mismatch =>
        `    - ${mismatchTitle(mismatch)}: ${boundS005Text(reportText(mismatch.message), 500)}${formatBoundedReferences(mismatch.evidenceReferences)}`
      ),
      ...overflowLine(analysis.possibleMismatches.length, MAX_REPORT_LIST_ITEMS)
    ] : []),
    ...(analysis.contradictions.length || analysis.possibleMismatches.length ? [] : ['  - none'])
  ];
}

function formatBoundedReferences(references: string[]): string {
  if (!references.length) {
    return '';
  }
  // Same bound as the criterionDetails copy, so the HTML report can match the list against it.
  const visible = references.slice(0, MAX_REPORT_LIST_ITEMS)
    .map(reference => boundS005Text(reference));
  return ` (evidence: ${visible.join(', ')}${references.length > MAX_REPORT_LIST_ITEMS ? `, ... ${references.length - MAX_REPORT_LIST_ITEMS} more` : ''})`;
}

function formatBoundedAgentReview(
  analysis: S005PersonalDataDisclosureAnalysisResult,
  agentReview?: CriterionAgentReviewResult
): string[] {
  if (agentReview?.available) {
    return [
      '',
      'Agent review:',
      ...(agentReview.recommendation ? [`  - Advisory recommendation: ${agentReview.recommendation}`] : []),
      ...(agentReview.confidence ? [`  - Confidence: ${agentReview.confidence}`] : []),
      ...(agentReview.summary ? [`  - Summary: ${boundS005Text(reportText(agentReview.summary), 900)}`] : []),
      ...(agentReview.rationale ? [`  - Rationale: ${boundS005Text(reportText(agentReview.rationale), 1_800)}`] : []),
      ...(agentReview.warnings.length ? [`  - Warnings: ${boundS005Text(reportText(agentReview.warnings.join('; ')), 200)}`] : []),
      ...(agentReview.errors.length ? [`  - Errors: ${boundS005Text(reportText(agentReview.errors.join('; ')), 200)}`] : []),
      ...(agentReview.metadata ? [`  - Adapter: ${boundS005Text(agentReview.metadata.adapter, 100)}`] : []),
      ...(agentReview.metadata?.modelLabel ? [`  - Model label: ${boundS005Text(agentReview.metadata.modelLabel, 200)}`] : [])
    ];
  }

  if ((analysis.nearMatchStatus ?? analysis.classification.status) !== EvaluationStatus.MANUAL) {
    return [];
  }

  const reason = analysis.agentReviewUnavailableReason ?? 'agent review is disabled or unconfigured';
  return [
    '',
    'Agent review:',
    `  - Not applied: ${boundS005Text(reportText(reason), 1_000)}`,
    ...(agentReview?.errors.length ? [`  - Errors: ${boundS005Text(reportText(agentReview.errors.join('; ')), 200)}`] : []),
    ...(agentReview?.warnings.length ? [`  - Warnings: ${boundS005Text(reportText(agentReview.warnings.join('; ')), 200)}`] : []),
    ...(agentReview?.metadata ? [`  - Adapter: ${boundS005Text(agentReview.metadata.adapter, 100)}`] : []),
    ...(agentReview?.metadata?.modelLabel ? [`  - Model label: ${boundS005Text(agentReview.metadata.modelLabel, 200)}`] : [])
  ];
}

export function buildS005CriterionDetails(analysis: S005PersonalDataDisclosureAnalysisResult): unknown {
  return {
    discovery: {
      status: analysis.discovery.status,
      artifact: analysis.discovery.artifact
        ? {
            path: analysis.discovery.artifact.path,
            sizeBytes: Buffer.byteLength(analysis.discovery.artifact.content, 'utf-8')
          }
        : undefined,
      attempts: analysis.discovery.attempts.map(boundS005Attempt),
      readError: analysis.discovery.readError,
      warnings: analysis.discovery.warnings.map(warning => boundS005Text(warning))
    },
    parseResult: analysis.parseResult
      ? {
          metadata: boundS005Metadata(analysis.parseResult.metadata),
          checklistItems: analysis.parseResult.checklistItems.map(summarizeS005ChecklistItem),
          checkedCategories: analysis.parseResult.checkedCategories,
          uncheckedCategories: analysis.parseResult.uncheckedCategories,
          completion: analysis.parseResult.completion,
          placeholders: analysis.parseResult.placeholders.map(boundS005Placeholder),
          contradictions: analysis.parseResult.contradictions,
          classification: analysis.parseResult.classification,
          parseError: analysis.parseResult.parseError
            ? {
                message: boundS005Text(analysis.parseResult.parseError.message),
                excerpt: analysis.parseResult.parseError.excerpt
              }
            : undefined,
          warnings: analysis.parseResult.warnings.map(warning => boundS005Text(warning))
        }
      : undefined,
    evidenceScan: analysis.evidenceScan
      ? {
          signalCount: analysis.evidenceScan.signals.length,
          // Scanner retention is already bounded by category/source-class caps; preserve it all.
          signals: analysis.evidenceScan.signals.map(boundS005SignalReference),
          scannedFileCount: analysis.evidenceScan.scannedFiles.length,
          scannedFiles: analysis.evidenceScan.scannedFiles.slice(0, MAX_CRITERION_DETAIL_FILES).map(filePath => boundS005Text(filePath)),
          scannedFilesIncludedCount: Math.min(analysis.evidenceScan.scannedFiles.length, MAX_CRITERION_DETAIL_FILES),
          scannedFilesOmittedCount: Math.max(analysis.evidenceScan.scannedFiles.length - MAX_CRITERION_DETAIL_FILES, 0),
          skippedFileCount: analysis.evidenceScan.skippedFiles.length,
          skippedFiles: analysis.evidenceScan.skippedFiles.slice(0, MAX_CRITERION_DETAIL_FILES).map(boundS005SkippedFile),
          skippedFilesIncludedCount: Math.min(analysis.evidenceScan.skippedFiles.length, MAX_CRITERION_DETAIL_FILES),
          skippedFilesOmittedCount: Math.max(analysis.evidenceScan.skippedFiles.length - MAX_CRITERION_DETAIL_FILES, 0),
          warnings: analysis.evidenceScan.warnings.map(warning => boundS005Text(warning))
        }
      : undefined,
    classification: analysis.classification,
    nearMatchStatus: analysis.nearMatchStatus,
    agentReviewUnavailableReason: analysis.agentReviewUnavailableReason,
    possibleMismatches: analysis.possibleMismatches.map(boundS005MismatchDetails),
    matchingEvidence: analysis.matchingEvidence.map(boundS005AssessmentDetails),
    supportingEvidence: analysis.supportingEvidence.map(boundS005AssessmentDetails),
    uncheckedAnswerDetails: analysis.uncheckedAnswerDetails.map(summarizeS005ChecklistItem),
    placeholders: analysis.placeholders.map(boundS005Placeholder),
    contradictions: analysis.contradictions,
    warnings: analysis.warnings.map(warning => boundS005Text(warning))
  };
}

function boundS005MismatchDetails(mismatch: S005PersonalDataPossibleMismatch): unknown {
  return {
    ...mismatch,
    evidenceReferenceCount: mismatch.evidenceReferences.length,
    evidenceReferences: mismatch.evidenceReferences.slice(0, MAX_CRITERION_DETAIL_REFERENCES).map(reference => boundS005Text(reference))
  };
}

function boundS005AssessmentDetails(assessment: S005PersonalDataEvidenceAssessment): unknown {
  return {
    ...assessment,
    evidenceReferenceCount: assessment.evidenceReferences.length,
    evidenceReferences: assessment.evidenceReferences.slice(0, MAX_CRITERION_DETAIL_REFERENCES).map(reference => boundS005Text(reference))
  };
}

function formatAttemptLines(attempts: S005PersonalDataDisclosureAttempt[]): string[] {
  if (!attempts.length) {
    return [];
  }

  return [
    '  - Attempted disclosure artifacts:',
    ...attempts.slice(0, MAX_REPORT_LIST_ITEMS).map(attempt => `    - ${boundS005Text(reportPath(attempt.path))} (${attempt.reason})`),
    ...overflowLine(attempts.length, MAX_REPORT_LIST_ITEMS)
  ];
}

function formatPlaceholderLines(placeholders: S005PersonalDataDisclosurePlaceholderEvidence[]): string[] {
  if (!placeholders.length) {
    return [];
  }

  return [
    '  - Placeholder/incomplete evidence:',
    ...placeholders.slice(0, MAX_REPORT_LIST_ITEMS).map(placeholder =>
      `    - ${reportText(placeholder.field)} line ${placeholder.lineNumber}: ${reportText(placeholder.placeholderText)}`
    ),
    ...overflowLine(placeholders.length, MAX_REPORT_LIST_ITEMS)
  ];
}

// Answers use the form's own wording; several questions share one category, so category names alone are ambiguous.
function formatAnswerLines(heading: string, items: S005PersonalDataDisclosureChecklistItem[]): string[] {
  if (!items.length) {
    return [`  - ${heading} none`];
  }

  return [
    `  - ${heading}`,
    ...items.slice(0, MAX_REPORT_ANSWER_ITEMS).map(item => `    - ${reportText(item.rawLabel)} (line ${item.lineNumber})`),
    ...overflowLine(items.length, MAX_REPORT_ANSWER_ITEMS)
  ];
}

function formatParseErrorLines(parseResult?: S005PersonalDataDisclosureParseResult): string[] {
  if (!parseResult?.parseError) {
    return [];
  }

  return [
    `  - Parse error: ${reportText(parseResult.parseError.message)}`,
    '  - Parse excerpt: omitted from report details'
  ];
}

function formatAssessmentLines(
  heading: string,
  assessments: S005PersonalDataEvidenceAssessment[]
): string[] {
  if (!assessments.length) {
    return [`  - ${heading} none`];
  }

  return [
    `  - ${heading}`,
    ...assessments.slice(0, MAX_REPORT_LIST_ITEMS).map(assessment =>
      `    - ${assessment.category ? S005_CATEGORY_TITLES[assessment.category] : 'Evidence'}: ${reportText(assessment.message)}${formatReferences(assessment.evidenceReferences)}`
    ),
    ...overflowLine(assessments.length, MAX_REPORT_LIST_ITEMS)
  ];
}

function formatSignalLines(signals: S005PersonalDataEvidenceSignal[], analysis: S005PersonalDataDisclosureAnalysisResult): string[] {
  if (!signals.length) {
    return ['  - Strongest examples: none'];
  }

  return [
    '  - Strongest examples:',
    ...strongestS005Signals(signals, [
      ...analysis.possibleMismatches.flatMap(mismatch => mismatch.category ? [mismatch.category] : []),
      ...analysis.matchingEvidence.flatMap(assessment => assessment.category ? [assessment.category] : [])
    ]).map(signal =>
      `    - ${boundS005Text(reportPath(signal.path))}${signal.line ? `:${signal.line}` : ''} [${S005_SOURCE_CLASS_TAGS[signal.sourceClass]}] ${reportText(signal.label)}: ${reportText(signal.excerpt)}`
    )
  ];
}

function formatContradictionLines(contradictions: S005PersonalDataDisclosureContradiction[], disclosurePath: string): string[] {
  if (!contradictions.length) {
    return [];
  }

  return [
    '  - Contradictions:',
    ...contradictions.slice(0, MAX_REPORT_LIST_ITEMS).map(contradiction =>
      `    - ${reportText(contradiction.message)}${formatReferences(contradiction.lineNumbers.map(line => `${reportPath(disclosurePath)}:${line}`))}`
    ),
    ...overflowLine(contradictions.length, MAX_REPORT_LIST_ITEMS)
  ];
}

function formatMismatchLines(mismatches: S005PersonalDataPossibleMismatch[]): string[] {
  if (!mismatches.length) {
    return [];
  }

  return [
    '  - Mismatch signals:',
    ...mismatches.slice(0, MAX_REPORT_LIST_ITEMS).map(mismatch =>
      `    - ${mismatchTitle(mismatch)}: ${reportText(mismatch.message)}${formatReferences(mismatch.evidenceReferences)}`
    ),
    ...overflowLine(mismatches.length, MAX_REPORT_LIST_ITEMS)
  ];
}

function formatWarningLines(warnings: string[]): string[] {
  if (!warnings.length) {
    return [];
  }

  return [
    '',
    'Warnings:',
    ...warnings.slice(0, MAX_REPORT_LIST_ITEMS).map(warning => `  - ${boundS005Text(reportText(warning))}`),
    ...overflowLine(warnings.length, MAX_REPORT_LIST_ITEMS, '  ')
  ];
}

function appendAgentReviewLines(
  lines: Array<string | undefined>,
  analysis: S005PersonalDataDisclosureAnalysisResult,
  agentReview?: CriterionAgentReviewResult
): void {
  if (agentReview?.available) {
    lines.push(
      '',
      'Agent review:',
      agentReview.recommendation ? `  - Advisory recommendation: ${agentReview.recommendation}` : undefined,
      agentReview.confidence ? `  - Confidence: ${agentReview.confidence}` : undefined,
      agentReview.summary ? `  - Summary: ${reportText(agentReview.summary)}` : undefined,
      agentReview.rationale ? `  - Rationale: ${reportText(agentReview.rationale)}` : undefined,
      agentReview.warnings.length ? `  - Warnings: ${reportText(agentReview.warnings.join('; '))}` : undefined,
      agentReview.errors.length ? `  - Errors: ${reportText(agentReview.errors.join('; '))}` : undefined,
      agentReview.metadata ? `  - Adapter: ${agentReview.metadata.adapter}` : undefined,
      agentReview.metadata?.modelLabel ? `  - Model label: ${agentReview.metadata.modelLabel}` : undefined
    );
    return;
  }

  if ((analysis.nearMatchStatus ?? analysis.classification.status) !== EvaluationStatus.MANUAL) {
    return;
  }

  const reason = analysis.agentReviewUnavailableReason ?? 'agent review is disabled or unconfigured';
  lines.push(
    '',
    'Agent review:',
    `  - Not applied: ${reportText(reason)}`,
    agentReview?.errors.length ? `  - Errors: ${reportText(agentReview.errors.join('; '))}` : undefined,
    agentReview?.warnings.length ? `  - Warnings: ${reportText(agentReview.warnings.join('; '))}` : undefined,
    agentReview?.metadata ? `  - Adapter: ${agentReview.metadata.adapter}` : undefined,
    agentReview?.metadata?.modelLabel ? `  - Model label: ${agentReview.metadata.modelLabel}` : undefined
  );
}

// Takes the best example from each category in turn, mismatched categories first, so the examples
// back up the findings instead of all coming from whichever file sorts first.
function strongestS005Signals(
  signals: S005PersonalDataEvidenceSignal[],
  priorityCategories: S005PersonalDataCategory[]
): S005PersonalDataEvidenceSignal[] {
  const sourceRank: Record<S005PersonalDataEvidenceSourceClass, number> = {
    direct_contract: 0,
    implementation: 1,
    ui: 2,
    documentation: 3,
    test_sample: 4
  };

  const sorted = [...signals].sort((a, b) =>
    evidenceStrengthRank(a.strength) - evidenceStrengthRank(b.strength) ||
    sourceRank[a.sourceClass] - sourceRank[b.sourceClass] ||
    a.path.localeCompare(b.path) ||
    (a.line ?? 0) - (b.line ?? 0)
  );
  const picked: S005PersonalDataEvidenceSignal[] = [];
  // Context-only signals (docs, tests, samples) are used only after every stronger signal.
  for (const tier of [sorted.filter(signal => signal.strength !== 'context'), sorted.filter(signal => signal.strength === 'context')]) {
    const byCategory = new Map<S005PersonalDataCategory, S005PersonalDataEvidenceSignal[]>();
    for (const signal of tier) {
      byCategory.set(signal.category, [...(byCategory.get(signal.category) ?? []), signal]);
    }
    const categoryOrder = [...new Set([...priorityCategories, ...tier.map(signal => signal.category)])]
      .filter(category => byCategory.has(category));
    while (picked.length < MAX_REPORT_LIST_ITEMS && categoryOrder.some(category => byCategory.get(category)!.length)) {
      for (const category of categoryOrder) {
        const next = byCategory.get(category)!.shift();
        if (next && picked.length < MAX_REPORT_LIST_ITEMS) {
          picked.push(next);
        }
      }
    }
  }
  return picked;
}

function mismatchTitle(mismatch: S005PersonalDataPossibleMismatch): string {
  return mismatch.category ? S005_CATEGORY_TITLES[mismatch.category] : 'Possible mismatch';
}

function formatReferences(references: string[]): string {
  if (!references.length) {
    return '';
  }

  return ` (evidence: ${references.slice(0, MAX_REPORT_LIST_ITEMS).map(reference => boundS005Text(reference)).join(', ')}${references.length > MAX_REPORT_LIST_ITEMS ? `, ... ${references.length - MAX_REPORT_LIST_ITEMS} more` : ''})`;
}

// The overflow marker must be indented like the list items it follows, or it nests under the last item.
function overflowLine(total: number, visible: number, indent = '    '): string[] {
  return total > visible ? [`${indent}- ... ${total - visible} more`] : [];
}

function summarizeS005ChecklistItem(item: S005PersonalDataDisclosureChecklistItem): unknown {
  return {
    order: item.order,
    lineNumber: item.lineNumber,
    checked: item.checked,
    normalizedCategory: item.normalizedCategory,
    normalizedCategories: item.normalizedCategories ?? [item.normalizedCategory]
  };
}

function boundS005Placeholder(placeholder: S005PersonalDataDisclosurePlaceholderEvidence): S005PersonalDataDisclosurePlaceholderEvidence {
  return {
    ...placeholder,
    placeholderText: boundS005Text(placeholder.placeholderText)
  };
}

function boundS005Metadata(metadata: S005PersonalDataDisclosureMetadata): S005PersonalDataDisclosureMetadata {
  return {
    ...metadata,
    versionText: metadata.versionText ? boundS005Text(metadata.versionText) : undefined,
    lastUpdatedText: metadata.lastUpdatedText ? boundS005Text(metadata.lastUpdatedText) : undefined,
    lastReviewedText: metadata.lastReviewedText ? boundS005Text(metadata.lastReviewedText) : undefined
  };
}

function boundS005Attempt(attempt: S005PersonalDataDisclosureAttempt): S005PersonalDataDisclosureAttempt {
  return {
    ...attempt,
    path: boundS005Text(attempt.path)
  };
}

function boundS005SkippedFile(skippedFile: S005PersonalDataEvidenceScanResult['skippedFiles'][number]): S005PersonalDataEvidenceScanResult['skippedFiles'][number] {
  return {
    ...skippedFile,
    path: boundS005Text(skippedFile.path)
  };
}

function boundS005SignalReference(signal: S005PersonalDataEvidenceSignal): S005PersonalDataEvidenceSignal {
  return {
    ...signal,
    path: boundS005Text(signal.path),
    excerpt: boundS005Text(signal.excerpt)
  };
}
