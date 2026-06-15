import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  ModuleKindResult,
  S005PersonalDataCategory,
  S005PersonalDataDeterministicClassification,
  S005PersonalDataDisclosureAttempt,
  S005PersonalDataDisclosureAnalysisResult,
  S005PersonalDataDisclosureChecklistItem,
  S005PersonalDataDisclosureContradiction,
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

export function formatS005Evidence(
  analysis: S005PersonalDataDisclosureAnalysisResult,
  moduleKind: ModuleKindResult,
  agentReview?: CriterionAgentReviewResult
): { evidence: string; details: string } {
  const evidence = `S005 ${analysis.classification.status}: ${analysis.classification.reason}`;
  const parseResult = analysis.parseResult;
  const evidenceScan = analysis.evidenceScan;
  const lines: Array<string | undefined> = [
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
    ...formatSignalLines(evidenceScan?.signals ?? []),
    '',
    'Possible mismatches:',
    ...formatContradictionLines(analysis.contradictions),
    ...formatMismatchLines(analysis.possibleMismatches),
    ...(analysis.contradictions.length || analysis.possibleMismatches.length ? [] : ['  - none']),
    ...formatWarningLines(analysis.warnings)
  ];

  appendAgentReviewLines(lines, analysis, agentReview);

  return {
    evidence: redactS005PersonalDataText(evidence, 700),
    details: redactS005PersonalDataText(lines.filter((line): line is string => line !== undefined).join('\n'), 12_000)
  };
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
          metadata: analysis.parseResult.metadata,
          checklistItems: analysis.parseResult.checklistItems.map(summarizeS005ChecklistItem),
          checkedCategories: analysis.parseResult.checkedCategories,
          uncheckedCategories: analysis.parseResult.uncheckedCategories,
          completion: analysis.parseResult.completion,
          placeholders: analysis.parseResult.placeholders.map(redactS005Placeholder),
          contradictions: analysis.parseResult.contradictions,
          classification: redactS005Classification(analysis.parseResult.classification),
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
    classification: redactS005Classification(analysis.classification),
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
      agentReview.evidenceReferences.length ? `  - Evidence references: ${agentReview.evidenceReferences.join(', ')}` : undefined,
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

function redactS005Warning(warning: string): string {
  return redactS005PersonalDataPath(warning);
}

function redactS005Classification(
  classification: S005PersonalDataDeterministicClassification
): S005PersonalDataDeterministicClassification {
  return {
    ...classification,
    warnings: classification.warnings.map(redactS005Warning)
  };
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
