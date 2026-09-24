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
  S005PersonalDataDisclosurePlaceholderEvidence,
  S005PersonalDataEvidenceAssessment,
  S005PersonalDataEvidenceScanResult,
  S005PersonalDataEvidenceSignal,
  S005PersonalDataEvidenceSourceClass,
  S005PersonalDataEvidenceStrength,
  S005PersonalDataPossibleMismatch
} from '../types';
import {
  REQUIRED_DISCLOSURE_FILENAME,
  redactS005PersonalDataPath,
  redactS005PersonalDataText
} from './s005-personal-data-disclosure';

const MAX_REPORT_LIST_ITEMS = 8;
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
  const supportingLines: Array<string | undefined> = [
    'Artifact mechanics:',
    `  - Repository kind: ${moduleKind.kind}`,
    ...moduleKind.evidence.map(evidenceItem => `  - Module-kind evidence: ${evidenceItem}`),
    `  - Required file: ${REQUIRED_DISCLOSURE_FILENAME}`,
    `  - Discovery status: ${analysis.discovery.status}`,
    analysis.discovery.artifact?.path ? `  - Disclosure artifact: ${analysis.discovery.artifact.path}` : `  - Missing exact file: ${REQUIRED_DISCLOSURE_FILENAME}`,
    analysis.discovery.readError ? `  - Read error: ${analysis.discovery.readError}` : undefined,
    ...formatAttemptLines(analysis.discovery.attempts),
    '',
    'Parsed disclosure fields:',
    `  - Parse state: ${analysis.classification.parseState}`,
    parseResult ? `  - Template identity: ${parseResult.metadata.templateIdentity}` : undefined,
    parseResult?.metadata.versionText ? `  - Form version: ${parseResult.metadata.versionText}` : undefined,
    parseResult?.metadata.lastUpdatedText ? `  - Last updated: ${parseResult.metadata.lastUpdatedText}` : undefined,
    parseResult?.metadata.lastReviewedText ? `  - Last reviewed: ${parseResult.metadata.lastReviewedText}` : undefined,
    parseResult ? `  - Checked answers: ${formatCategoryList(parseResult.checkedCategories)}` : undefined,
    parseResult ? `  - Unchecked answers: ${formatCategoryList(parseResult.uncheckedCategories)}` : undefined,
    ...formatPlaceholderLines(analysis.placeholders),
    ...formatUncheckedAnswerLines(analysis.uncheckedAnswerDetails),
    ...formatParseErrorLines(parseResult),
    '',
    'Deterministic evidence:',
    evidenceScan ? `  - Evidence files scanned: ${evidenceScan.scannedFiles.length}` : '  - Evidence files scanned: not applied',
    evidenceScan ? `  - Evidence signals found: ${evidenceScan.signals.length}` : undefined,
    ...formatAssessmentLines('Matching disclosure/source evidence:', analysis.matchingEvidence),
    ...formatAssessmentLines('Supporting deterministic evidence:', analysis.supportingEvidence),
    ...formatSignalLines(evidenceScan?.signals ?? [])
  ];
  const findingsLines: string[] = [
    '',
    'Possible mismatches:',
    ...formatContradictionLines(analysis.contradictions),
    ...formatMismatchLines(analysis.possibleMismatches),
    ...(analysis.contradictions.length || analysis.possibleMismatches.length ? [] : ['  - none'])
  ];
  const warningLines = formatWarningLines(analysis.warnings);
  const agentLines: Array<string | undefined> = [];
  appendAgentReviewLines(agentLines, analysis, agentReview);

  const allLines = [...supportingLines, ...findingsLines, ...warningLines, ...agentLines]
    .filter((line): line is string => line !== undefined);
  const unredactedDetails = allLines.join('\n');
  const fullyRedactedDetails = redactS005PersonalDataText(
    unredactedDetails,
    Buffer.byteLength(unredactedDetails, 'utf8') * 4 + MAX_REPORT_DETAILS_BYTES
  );

  if (Buffer.byteLength(fullyRedactedDetails, 'utf8') <= MAX_REPORT_DETAILS_BYTES) {
    return {
      evidence: redactS005PersonalDataText(evidence, 700),
      details: fullyRedactedDetails
    };
  }

  const findingsText = redactS005PersonalDataText(formatBoundedFindings(analysis).join('\n'), 2_000);
  const warningsText = redactS005PersonalDataText(warningLines.join('\n'), 500);
  const agentText = redactS005PersonalDataText(formatBoundedAgentReview(analysis, agentReview).join('\n'), 4_000);
  const tail = [findingsText, warningsText, agentText].filter(Boolean).join('\n');
  const separator = tail ? '\n' : '';
  const supportBudget = MAX_REPORT_DETAILS_BYTES - Buffer.byteLength(separator + tail, 'utf8');
  const details = redactS005PersonalDataText(
    supportingLines.filter((line): line is string => line !== undefined).join('\n'),
    supportBudget
  ) + separator + tail;

  return {
    evidence: redactS005PersonalDataText(evidence, 700),
    details
  };
}

function formatBoundedFindings(analysis: S005PersonalDataDisclosureAnalysisResult): string[] {
  return [
    '',
    'Possible mismatches:',
    ...(analysis.contradictions.length ? [
      '  - Contradictions:',
      ...analysis.contradictions.slice(0, MAX_REPORT_LIST_ITEMS).map(contradiction =>
        `    - ${redactS005PersonalDataText(contradiction.message, 500)}${formatBoundedReferences(contradiction.lineNumbers.map(line => `${REQUIRED_DISCLOSURE_FILENAME}:${line}`))}`
      ),
      ...overflowLine(analysis.contradictions.length, MAX_REPORT_LIST_ITEMS)
    ] : []),
    ...(analysis.possibleMismatches.length ? [
      '  - Mismatch signals:',
      ...analysis.possibleMismatches.slice(0, MAX_REPORT_LIST_ITEMS).map(mismatch =>
        `    - ${mismatch.kind}${mismatch.category ? `/${mismatch.category}` : ''}: ${redactS005PersonalDataText(mismatch.message, 500)}${formatBoundedReferences(mismatch.evidenceReferences)}`
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
  const visible = references.slice(0, MAX_REPORT_LIST_ITEMS)
    .map(reference => redactS005PersonalDataPath(reference, 160));
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
      ...(agentReview.summary ? [`  - Summary: ${redactS005PersonalDataText(agentReview.summary, 900)}`] : []),
      ...(agentReview.rationale ? [`  - Rationale: ${redactS005PersonalDataText(agentReview.rationale, 1_800)}`] : []),
      ...(agentReview.warnings.length ? [`  - Warnings: ${redactS005PersonalDataText(agentReview.warnings.join('; '), 200)}`] : []),
      ...(agentReview.errors.length ? [`  - Errors: ${redactS005PersonalDataText(agentReview.errors.join('; '), 200)}`] : []),
      ...(agentReview.metadata ? [`  - Adapter: ${redactS005PersonalDataText(agentReview.metadata.adapter, 100)}`] : []),
      ...(agentReview.metadata?.modelLabel ? [`  - Model label: ${redactS005PersonalDataText(agentReview.metadata.modelLabel, 200)}`] : [])
    ];
  }

  if (analysis.classification.status !== EvaluationStatus.MANUAL) {
    return [];
  }

  const reason = analysis.agentReviewUnavailableReason ?? 'agent review is disabled or unconfigured';
  return [
    '',
    'Agent review:',
    `  - Not applied: ${redactS005PersonalDataText(reason, 1_000)}`,
    ...(agentReview?.errors.length ? [`  - Errors: ${redactS005PersonalDataText(agentReview.errors.join('; '), 200)}`] : []),
    ...(agentReview?.warnings.length ? [`  - Warnings: ${redactS005PersonalDataText(agentReview.warnings.join('; '), 200)}`] : []),
    ...(agentReview?.metadata ? [`  - Adapter: ${redactS005PersonalDataText(agentReview.metadata.adapter, 100)}`] : []),
    ...(agentReview?.metadata?.modelLabel ? [`  - Model label: ${redactS005PersonalDataText(agentReview.metadata.modelLabel, 200)}`] : [])
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
      attempts: analysis.discovery.attempts.map(redactS005Attempt),
      readError: analysis.discovery.readError,
      warnings: analysis.discovery.warnings.map(redactS005Warning)
    },
    parseResult: analysis.parseResult
      ? {
          metadata: redactS005Metadata(analysis.parseResult.metadata),
          checklistItems: analysis.parseResult.checklistItems.map(summarizeS005ChecklistItem),
          checkedCategories: analysis.parseResult.checkedCategories,
          uncheckedCategories: analysis.parseResult.uncheckedCategories,
          completion: analysis.parseResult.completion,
          placeholders: analysis.parseResult.placeholders.map(redactS005Placeholder),
          contradictions: analysis.parseResult.contradictions,
          classification: analysis.parseResult.classification,
          parseError: analysis.parseResult.parseError
            ? { message: analysis.parseResult.parseError.message }
            : undefined,
          warnings: analysis.parseResult.warnings.map(redactS005Warning)
        }
      : undefined,
    evidenceScan: analysis.evidenceScan
      ? {
          signalCount: analysis.evidenceScan.signals.length,
          signals: strongestS005Signals(analysis.evidenceScan.signals).map(redactS005SignalReference),
          scannedFileCount: analysis.evidenceScan.scannedFiles.length,
          scannedFiles: analysis.evidenceScan.scannedFiles.slice(0, MAX_CRITERION_DETAIL_FILES).map(filePath => redactS005PersonalDataPath(filePath)),
          skippedFiles: analysis.evidenceScan.skippedFiles.slice(0, MAX_CRITERION_DETAIL_FILES).map(redactS005SkippedFile),
          warnings: analysis.evidenceScan.warnings.map(redactS005Warning)
        }
      : undefined,
    classification: analysis.classification,
    agentReviewUnavailableReason: analysis.agentReviewUnavailableReason,
    possibleMismatches: analysis.possibleMismatches.map(boundS005MismatchDetails),
    matchingEvidence: analysis.matchingEvidence.map(boundS005AssessmentDetails),
    supportingEvidence: analysis.supportingEvidence.map(boundS005AssessmentDetails),
    uncheckedAnswerDetails: analysis.uncheckedAnswerDetails.map(summarizeS005ChecklistItem),
    placeholders: analysis.placeholders.map(redactS005Placeholder),
    contradictions: analysis.contradictions,
    warnings: analysis.warnings.map(redactS005Warning)
  };
}

function boundS005MismatchDetails(mismatch: S005PersonalDataPossibleMismatch): unknown {
  return {
    ...mismatch,
    evidenceReferenceCount: mismatch.evidenceReferences.length,
    evidenceReferences: mismatch.evidenceReferences.slice(0, MAX_CRITERION_DETAIL_REFERENCES).map(reference => redactS005PersonalDataPath(reference))
  };
}

function boundS005AssessmentDetails(assessment: S005PersonalDataEvidenceAssessment): unknown {
  return {
    ...assessment,
    evidenceReferenceCount: assessment.evidenceReferences.length,
    evidenceReferences: assessment.evidenceReferences.slice(0, MAX_CRITERION_DETAIL_REFERENCES).map(reference => redactS005PersonalDataPath(reference))
  };
}

function formatAttemptLines(attempts: S005PersonalDataDisclosureAttempt[]): string[] {
  if (!attempts.length) {
    return [];
  }

  return [
    '  - Attempted disclosure artifacts:',
    ...attempts.slice(0, MAX_REPORT_LIST_ITEMS).map(attempt => `    - ${redactS005PersonalDataPath(attempt.path)} (${attempt.reason})`),
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
      `    - ${placeholder.field} line ${placeholder.lineNumber}: ${placeholder.placeholderText}`
    ),
    ...overflowLine(placeholders.length, MAX_REPORT_LIST_ITEMS)
  ];
}

function formatUncheckedAnswerLines(items: S005PersonalDataDisclosureChecklistItem[]): string[] {
  if (!items.length) {
    return [];
  }

  return [
    '  - Unchecked answer evidence:',
    ...items.slice(0, MAX_REPORT_LIST_ITEMS).map(item =>
      `    - line ${item.lineNumber} [${item.normalizedCategory}]`
    ),
    ...overflowLine(items.length, MAX_REPORT_LIST_ITEMS)
  ];
}

function formatParseErrorLines(parseResult?: S005PersonalDataDisclosureParseResult): string[] {
  if (!parseResult?.parseError) {
    return [];
  }

  return [
    `  - Parse error: ${parseResult.parseError.message}`,
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
      `    - ${assessment.kind}${assessment.category ? `/${assessment.category}` : ''}: ${assessment.message}${formatReferences(assessment.evidenceReferences)}`
    ),
    ...overflowLine(assessments.length, MAX_REPORT_LIST_ITEMS)
  ];
}

function formatSignalLines(signals: S005PersonalDataEvidenceSignal[]): string[] {
  if (!signals.length) {
    return ['  - Strongest signals: none'];
  }

  return [
    '  - Strongest signals:',
    ...strongestS005Signals(signals).map(signal =>
      `    - ${redactS005PersonalDataPath(signal.path)}${signal.line ? `:${signal.line}` : ''} [${signal.sourceClass}/${signal.strength}/${signal.category}] ${signal.label}: ${signal.excerpt}`
    )
  ];
}

function formatContradictionLines(contradictions: S005PersonalDataDisclosureContradiction[]): string[] {
  if (!contradictions.length) {
    return [];
  }

  return [
    '  - Contradictions:',
    ...contradictions.slice(0, MAX_REPORT_LIST_ITEMS).map(contradiction =>
      `    - ${contradiction.message}${formatReferences(contradiction.lineNumbers.map(line => `${REQUIRED_DISCLOSURE_FILENAME}:${line}`))}`
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
      `    - ${mismatch.kind}${mismatch.category ? `/${mismatch.category}` : ''}: ${mismatch.message}${formatReferences(mismatch.evidenceReferences)}`
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
    ...warnings.slice(0, MAX_REPORT_LIST_ITEMS).map(warning => `  - ${redactS005Warning(warning)}`),
    ...overflowLine(warnings.length, MAX_REPORT_LIST_ITEMS)
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
      agentReview.summary ? `  - Summary: ${agentReview.summary}` : undefined,
      agentReview.rationale ? `  - Rationale: ${agentReview.rationale}` : undefined,
      agentReview.warnings.length ? `  - Warnings: ${agentReview.warnings.join('; ')}` : undefined,
      agentReview.errors.length ? `  - Errors: ${agentReview.errors.join('; ')}` : undefined,
      agentReview.metadata ? `  - Adapter: ${agentReview.metadata.adapter}` : undefined,
      agentReview.metadata?.modelLabel ? `  - Model label: ${agentReview.metadata.modelLabel}` : undefined
    );
    return;
  }

  if (analysis.classification.status !== EvaluationStatus.MANUAL) {
    return;
  }

  const reason = analysis.agentReviewUnavailableReason ?? 'agent review is disabled or unconfigured';
  lines.push(
    '',
    'Agent review:',
    `  - Not applied: ${reason}`,
    agentReview?.errors.length ? `  - Errors: ${agentReview.errors.join('; ')}` : undefined,
    agentReview?.warnings.length ? `  - Warnings: ${agentReview.warnings.join('; ')}` : undefined,
    agentReview?.metadata ? `  - Adapter: ${agentReview.metadata.adapter}` : undefined,
    agentReview?.metadata?.modelLabel ? `  - Model label: ${agentReview.metadata.modelLabel}` : undefined
  );
}

function strongestS005Signals(signals: S005PersonalDataEvidenceSignal[]): S005PersonalDataEvidenceSignal[] {
  const strengthRank: Record<S005PersonalDataEvidenceStrength, number> = {
    strong: 0,
    candidate: 1,
    context: 2
  };
  const sourceRank: Record<S005PersonalDataEvidenceSourceClass, number> = {
    direct_contract: 0,
    implementation: 1,
    ui: 2,
    documentation: 3,
    test_sample: 4
  };

  return [...signals]
    .sort((a, b) =>
      strengthRank[a.strength] - strengthRank[b.strength] ||
      sourceRank[a.sourceClass] - sourceRank[b.sourceClass] ||
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0)
    )
    .slice(0, MAX_REPORT_LIST_ITEMS);
}

function formatCategoryList(categories: S005PersonalDataCategory[]): string {
  if (!categories.length) {
    return 'none';
  }

  const visible = categories.slice(0, MAX_REPORT_LIST_ITEMS).join(', ');
  const hiddenCount = categories.length - MAX_REPORT_LIST_ITEMS;
  return hiddenCount > 0 ? `${visible}, ... ${hiddenCount} more` : visible;
}

function formatReferences(references: string[]): string {
  if (!references.length) {
    return '';
  }

  return ` (evidence: ${references.slice(0, MAX_REPORT_LIST_ITEMS).map(reference => redactS005PersonalDataPath(reference)).join(', ')}${references.length > MAX_REPORT_LIST_ITEMS ? `, ... ${references.length - MAX_REPORT_LIST_ITEMS} more` : ''})`;
}

function overflowLine(total: number, visible: number): string[] {
  return total > visible ? [`    - ... ${total - visible} more`] : [];
}

function summarizeS005ChecklistItem(item: S005PersonalDataDisclosureChecklistItem): unknown {
  return {
    order: item.order,
    lineNumber: item.lineNumber,
    checked: item.checked,
    normalizedCategory: item.normalizedCategory
  };
}

function redactS005Placeholder(placeholder: S005PersonalDataDisclosurePlaceholderEvidence): S005PersonalDataDisclosurePlaceholderEvidence {
  return {
    ...placeholder,
    placeholderText: redactS005PersonalDataText(placeholder.placeholderText)
  };
}

function redactS005Metadata(metadata: S005PersonalDataDisclosureMetadata): S005PersonalDataDisclosureMetadata {
  return {
    ...metadata,
    versionText: metadata.versionText ? redactS005PersonalDataText(metadata.versionText) : undefined,
    lastUpdatedText: metadata.lastUpdatedText ? redactS005PersonalDataText(metadata.lastUpdatedText) : undefined,
    lastReviewedText: metadata.lastReviewedText ? redactS005PersonalDataText(metadata.lastReviewedText) : undefined
  };
}

function redactS005Warning(warning: string): string {
  return redactS005PersonalDataPath(warning);
}

function redactS005Attempt(attempt: S005PersonalDataDisclosureAttempt): S005PersonalDataDisclosureAttempt {
  return {
    ...attempt,
    path: redactS005PersonalDataPath(attempt.path)
  };
}

function redactS005SkippedFile(skippedFile: S005PersonalDataEvidenceScanResult['skippedFiles'][number]): S005PersonalDataEvidenceScanResult['skippedFiles'][number] {
  return {
    ...skippedFile,
    path: redactS005PersonalDataPath(skippedFile.path)
  };
}

function redactS005SignalReference(signal: S005PersonalDataEvidenceSignal): S005PersonalDataEvidenceSignal {
  return {
    ...signal,
    path: redactS005PersonalDataPath(signal.path),
    excerpt: redactS005PersonalDataText(signal.excerpt)
  };
}
