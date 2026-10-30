import {
  B016Analysis,
  B016Basis,
  B016Technology,
  BackendInfrastructureEvidence,
  BackendInfrastructureSignal,
  BackendRepositoryKind,
  EvaluationStatus,
  FrontendChecklistItem,
  S007PolicyArea,
  S007PolicyLoadResult
} from '../types';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { capitalize, count, listText, overflowLine, reportPath, reportText, unique } from './report-text';
import { findPolicyEntry, policySections } from './s007-policy';

const MAX_ROWS = 20;
const MAX_SIGNALS = 5;
const POLICY_AREAS: S007PolicyArea[] = ['infrastructure', 'fast-moving-infrastructure'];
const LIST = 'the Officially Supported Technologies list';

/**
 * B016 (only OST-listed infrastructure) compares the infrastructure found in the committed source with the
 * infrastructure sections of the committed Officially Supported Technologies policy.
 */
export function evaluateB016(kind: BackendRepositoryKind, infrastructure: BackendInfrastructureEvidence, policyLoad: S007PolicyLoadResult): B016Analysis {
  const subject = kind === 'library' ? 'The library' : kind === 'ambiguous' ? 'The repository' : 'The module';
  const sections = policyLoad.ok ? POLICY_AREAS.flatMap(area => policySections(policyLoad.policy, 'b016', area)) : [];
  const technologies: B016Technology[] = infrastructure.items.map(item => {
    const listed = policyLoad.ok ? findPolicyEntry(sections, item.id) : undefined;
    return {
      id: item.id,
      name: item.name,
      usage: item.usage,
      ...(listed ? { listedAs: { id: listed.entry.id, displayName: listed.entry.displayName, sourceStatement: listed.entry.sourceStatement, strength: listed.entry.strength, section: listed.section.id } } : {}),
      signals: item.signals
    };
  });
  const base = {
    criterionId: 'B016' as const,
    kind,
    ...(policyLoad.ok ? { policy: { exportDate: policyLoad.policy.source?.exportDate, sections: sections.map(section => section.id) } } : {}),
    policyDiagnostics: policyLoad.diagnostics,
    technologies,
    buildFiles: infrastructure.buildFiles,
    diagnostics: infrastructure.diagnostics,
    sourceDiagnostics: infrastructure.sourceDiagnostics
  };
  const result = (status: EvaluationStatus, basis: B016Basis, sentences: string[], items: FrontendChecklistItem[]): B016Analysis =>
    ({ ...base, status, basis, summary: `B016 ${status}: ${sentences.join(' ')}`, checklist: frontendChecklist(status, items) });

  if (!policyLoad.ok || !sections.length) {
    const reason = policyLoad.ok ? 'has no infrastructure sections' : `could not be read (${reportText(policyLoad.diagnostics[0]?.message ?? 'no diagnostic')})`;
    return result(EvaluationStatus.MANUAL, 'policy-unreadable', [
      `${capitalize(LIST)} ${reason}, so the tool could not compare the infrastructure with it.`, 'A reviewer must check it.'
    ], [requiredItem(technologies), ...(infrastructure.diagnostics.length || infrastructure.sourceDiagnostics.length ? [unreadItem(infrastructure)] : [])]);
  }
  if (!infrastructure.buildFiles.length) {
    return result(EvaluationStatus.MANUAL, 'no-build-file', [
      'No pom.xml or build.gradle was found, so the tool could not read the dependencies.', 'A reviewer must check them.'
    ], [unreadItem(infrastructure)]);
  }

  const unlisted = (usage: B016Technology['usage']) => technologies.filter(technology => !technology.listedAs && technology.usage === usage);
  const required = unlisted('required');
  const optional = unlisted('optional');
  const configurationOnly = unlisted('configuration-only');
  const listed = technologies.filter(technology => technology.listedAs);
  const unread = infrastructure.diagnostics.length + (infrastructure.sourceDiagnostics.length ? 1 : 0);
  const be = (list: unknown[]) => list.length === 1 ? 'is' : 'are';

  const sentences: string[] = [];
  if (required.length) {
    sentences.push(`${subject} requires ${listText(required.map(technology => `${technology.name} (${signalBrief(technology)})`))}, which ${be(required)} not on ${LIST}.`);
  }
  if (optional.length) {
    const reasons = unique(optional.flatMap(technology => technology.signals.flatMap(signal => signal.optional ? [signal.optional] : [])));
    sentences.push(`${subject} can use ${listText(optional.map(technology => technology.name))}, which ${be(optional)} not on ${LIST}, as ${optional.length === 1 ? 'an option' : 'options'} (${listText(reasons.map(reportText))}).`);
  }
  if (configurationOnly.length) {
    sentences.push(`The configuration names ${listText(configurationOnly.map(technology => `${technology.name} (${signalBrief(technology)})`))}, which ${be(configurationOnly)} not on ${LIST}, but no client library for ${configurationOnly.length === 1 ? 'it' : 'them'} is a direct dependency.`);
  }
  if (infrastructure.diagnostics.length) {
    sentences.push(`The tool could not read ${count(infrastructure.diagnostics.length, 'dependency declaration or configuration file')}, so it may have missed infrastructure.`);
  }
  if (infrastructure.sourceDiagnostics.length) sentences.push('The committed source was not read completely, so the tool may have missed infrastructure.');

  const toReview = optional.length + configurationOnly.length + unread;
  const status = required.length ? EvaluationStatus.FAIL : toReview ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  if (status === EvaluationStatus.PASS) {
    sentences.push(listed.length
      ? `Every infrastructure found is on ${LIST}: ${everyItem(listed.map(listedLabel))}.`
      : 'No infrastructure was found in the direct dependencies, storage evidence, configuration or environment variables.');
  } else {
    if (listed.length) sentences.push(`On the list: ${everyItem(listed.map(listedLabel))}.`);
    if (status === EvaluationStatus.MANUAL) sentences.push(`A reviewer must check ${toReview === 1 ? 'it' : 'them'}.`);
  }

  const items: FrontendChecklistItem[] = [];
  if (required.length) items.push(requiredItem(required));
  if (optional.length) {
    items.push({ id: 'B016-C2', title: 'Each optional backend that is not on the list stays optional: the module works with a supported option, and the documentation names it.', startingPoints: startingPoints(optional), reviewerOnly: true, obligations: [] });
  }
  if (configurationOnly.length) {
    items.push({ id: 'B016-C3', title: 'Each infrastructure that only the configuration names is unused, or is on the list or accepted by the Technical Council.', startingPoints: startingPoints(configurationOnly), reviewerOnly: true, obligations: [] });
  }
  if (unread) items.push(unreadItem(infrastructure));

  return result(status, 'infrastructure-checked', sentences, items);
}

export function renderB016HumanDetails(analysis: B016Analysis): string {
  const lines: string[] = [];
  if (analysis.policy) {
    lines.push(`Officially Supported Technologies: ${analysis.policy.exportDate ? `exported ${reportText(analysis.policy.exportDate)}, ` : ''}sections ${listText(analysis.policy.sections.map(reportText))}`);
  } else {
    lines.push('Officially Supported Technologies: could not be read', ...analysis.policyDiagnostics.map(diagnostic => `  - ${reportText(diagnostic.message)}`));
  }
  lines.push(analysis.buildFiles.length
    ? `Checked: direct production dependencies in ${count(analysis.buildFiles.length, 'build file')} (${listText(analysis.buildFiles.map(reportPath))}), storage evidence, configuration keys and environment variables. Transitive dependencies are not visible without running the build, and server versions are not checked.`
    : 'Checked: no pom.xml or build.gradle found');

  const section = (heading: string, list: B016Technology[], label: (technology: B016Technology) => string) => {
    if (!list.length) return;
    lines.push(`${heading}:`);
    for (const technology of list.slice(0, MAX_ROWS)) {
      lines.push(`  - ${label(technology)}`, ...technology.signals.slice(0, MAX_SIGNALS).map(signal => `    - ${signalRow(signal)}`),
        ...overflowLine(technology.signals.length, MAX_SIGNALS, '    '));
    }
    lines.push(...overflowLine(list.length, MAX_ROWS, '  '));
  };
  if (analysis.basis === 'policy-unreadable') {
    section('Infrastructure found (not compared)', analysis.technologies, technology => technology.name);
  } else {
    const unlisted = (usage: B016Technology['usage']) => analysis.technologies.filter(technology => !technology.listedAs && technology.usage === usage);
    section('On the list', analysis.technologies.filter(technology => technology.listedAs), technology =>
      `${listedLabel(technology)} — "${reportText(technology.listedAs!.sourceStatement)}" (${USAGE_TEXT[technology.usage]})`);
    section('Not on the list, required', unlisted('required'), technology => technology.name);
    section('Not on the list, optional', unlisted('optional'), technology => technology.name);
    section('Not on the list, named only in configuration', unlisted('configuration-only'), technology => technology.name);
  }
  if (analysis.diagnostics.length || analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:',
      ...analysis.diagnostics.slice(0, MAX_ROWS).map(diagnostic => `  - ${reportPath(diagnostic.path)}${diagnostic.line ? `:${diagnostic.line}` : ''} — ${reportText(diagnostic.message)}`),
      ...overflowLine(analysis.diagnostics.length, MAX_ROWS, '  '),
      ...analysis.sourceDiagnostics.map(diagnostic => `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    lines.push('What to do:', '  - Replace each infrastructure listed under "Not on the list, required" with one on the Officially Supported Technologies list, or ask the Technical Council to add it to the list.');
  }
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  return lines.join('\n');
}

const USAGE_TEXT: Record<B016Technology['usage'], string> = {
  required: 'required',
  optional: 'optional',
  'configuration-only': 'named only in configuration'
};

function everyItem(items: string[]): string {
  return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function startingPoints(list: B016Technology[]): FrontendChecklistItem['startingPoints'] {
  return list.flatMap(technology => technology.signals.flatMap(signal => signal.path ? [{
    path: signal.path, ...(signal.line ? { line: signal.line } : {}),
    note: `${technology.name}: ${KIND_LABELS[signal.kind]} ${signal.detail}${signal.optional ? ` (${signal.optional})` : ''}`
  }] : []));
}

function requiredItem(list: B016Technology[]): FrontendChecklistItem {
  return {
    id: 'B016-C1',
    title: 'Each infrastructure the module requires is on the Officially Supported Technologies list, or the Technical Council has accepted it.',
    startingPoints: startingPoints(list),
    reviewerOnly: true,
    obligations: []
  };
}

function unreadItem(infrastructure: BackendInfrastructureEvidence): FrontendChecklistItem {
  return {
    id: 'B016-C4',
    title: 'The dependencies and configuration the tool could not read add no infrastructure outside the Officially Supported Technologies list.',
    startingPoints: [
      ...infrastructure.diagnostics.map(diagnostic => ({ path: diagnostic.path, ...(diagnostic.line ? { line: diagnostic.line } : {}), note: diagnostic.message })),
      ...infrastructure.sourceDiagnostics.flatMap(diagnostic => diagnostic.path ? [{ path: diagnostic.path, note: diagnostic.message }] : [])
    ],
    reviewerOnly: true,
    obligations: []
  };
}

function listedLabel(technology: B016Technology): string {
  const entry = technology.listedAs!;
  const strength = entry.strength === 'normative' ? '' : `${entry.strength === 'advisory' ? 'an' : 'a'} ${entry.strength} entry`;
  const notes = [...(entry.displayName === technology.name ? [] : [`listed as ${reportText(entry.displayName)}`]), ...(strength ? [strength] : [])];
  return notes.length ? `${technology.name} (${notes.join(', ')})` : technology.name;
}

function signalBrief(technology: B016Technology): string {
  const signal = technology.signals.find(candidate => !candidate.optional && (candidate.kind === 'dependency' || candidate.kind === 'storage')) ?? technology.signals[0];
  return signalText(signal);
}

const KIND_LABELS: Record<BackendInfrastructureSignal['kind'], string> = {
  dependency: 'dependency',
  storage: 'storage evidence:',
  configuration: 'configuration',
  environment: 'environment variables'
};

function signalText(signal: BackendInfrastructureSignal): string {
  return `${KIND_LABELS[signal.kind]} ${reportText(signal.detail)}${signal.path && signal.kind !== 'storage' ? ` in ${reportPath(signal.path)}` : ''}`;
}

function signalRow(signal: BackendInfrastructureSignal): string {
  const location = signal.path ? `${reportPath(signal.path)}${signal.line ? `:${signal.line}` : ''} — ` : '';
  return `${location}${KIND_LABELS[signal.kind]} ${reportText(signal.detail)}${signal.optional ? ` (${reportText(signal.optional)})` : ''}`;
}
