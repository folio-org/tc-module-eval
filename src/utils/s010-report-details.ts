import * as path from 'path';
import {
  CriterionAgentReviewResult,
  ModuleKind,
  S010Analysis,
  S010Coverage,
  S010Diagnostic,
  S010Finding,
  S010RuntimeKind,
  S010SourceReference
} from '../types';
import { renderAgentReviewLines } from './agent-review-report';
import { reportPath, reportText } from './report-text';
import { S010_SOURCE_LIMITS } from './s010-evidence';

const MAX_SUBJECTS = 8;
const MAX_NAME_CHARS = 100;
const MAX_REFERENCES = 8;
const MAX_WARNING_PATHS = 5;

const SERVICE_NAMES: Record<string, string> = {
  database: 'Database',
  kafka: 'Kafka',
  search: 'OpenSearch or Elasticsearch',
  'object-storage': 'Object storage (S3)',
  okapi: 'Okapi'
};

const RUNTIME_LABELS: Record<S010RuntimeKind, string> = {
  java: 'Java',
  'stripes-react': 'Stripes/React UI',
  node: 'Node.js (not supported)',
  mixed: 'Java and JavaScript together (not supported)',
  unknown: 'not recognized'
};

const MODULE_KIND_LABELS: Record<ModuleKind, string> = {
  'backend-module': 'backend module',
  'ui-module': 'UI module',
  library: 'library',
  ambiguous: 'not recognized'
};

// Findings about the analysis itself rather than about one service; listed last.
const META_IDS = new Set(['evidence-coverage', 'dependency-scope', 'runtime-support']);

const OUTCOME_SECTIONS: Array<[S010Finding['outcome'], string]> = [
  ['violation', 'Problems found:'],
  ['unresolved', 'Needs review (not confirmed problems):'],
  ['satisfactory', 'Handled well:']
];

export function renderS010HumanDetails(
  analysis: S010Analysis,
  agentReview?: CriterionAgentReviewResult
): string {
  const lines = [
    'What the tool checked:',
    `  - Module type: ${MODULE_KIND_LABELS[analysis.evidence.moduleKind.kind]}`,
    `  - Code type: ${RUNTIME_LABELS[analysis.evidence.runtimeKind]}`,
    `  - Files read: ${analysis.evidence.discoveryCoverage === 'complete'
      ? 'all relevant committed files'
      : 'some files were not read (see Warnings)'}`,
    `  - Code analysis: ${coverageLabel(analysis.evidence.semanticCoverage)}`
  ];
  for (const [outcome, heading] of OUTCOME_SECTIONS) {
    const findings = analysis.findings
      .filter(finding => finding.outcome === outcome)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!findings.length) continue;
    lines.push(heading);
    const groups = groupFindings(findings).map(group => ({ group, title: s010FindingTitle(group) }))
      .sort((left, right) => Number(META_IDS.has(left.group[0].dependencyId)) - Number(META_IDS.has(right.group[0].dependencyId))
        || left.title.localeCompare(right.title, 'en', { sensitivity: 'base' }));
    for (const { group, title } of groups) {
      lines.push(`  - ${title}`, `    - ${reportText(group[0].rationale)}`, ...referenceLines(group));
    }
  }
  lines.push(...warningLines(analysis.diagnostics));
  if (agentReview?.available) {
    lines.push(...renderAgentReviewLines(agentReview, s010AgentReviewNames(analysis)));
    lines.push('  - The automated result stays Manual review.');
  } else if (analysis.agentReviewUnavailableReason) {
    lines.push('Agent review:', `  - Not applied: ${reportText(analysis.agentReviewUnavailableReason)}`);
  }
  return lines.join('\n');
}

/**
 * Short plain name of what a finding is about, for summaries: a known service, FOLIO interfaces,
 * a requested host, or undefined for findings about the analysis itself.
 */
export function s010ServiceName(finding: S010Finding): string | undefined {
  if (META_IDS.has(finding.dependencyId)) return undefined;
  if (groupKey(finding) === 'folio-interface') return 'FOLIO interfaces';
  if (SERVICE_NAMES[finding.dependencyId]) return SERVICE_NAMES[finding.dependencyId];
  if (finding.scenario === 'configuration-absent') return shorten(findingSubject(finding) || finding.dependencyId);
  return isClientFinding(finding) ? 'other service clients' : shorten(finding.dependencyId);
}

// Dependency ids can come from repository file and setting names, such as "constructor".
function isKnownService(dependencyId: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVICE_NAMES, dependencyId);
}

function serviceName(dependencyId: string): string {
  return isKnownService(dependencyId) ? SERVICE_NAMES[dependencyId] : dependencyId;
}

function coverageLabel(coverage: S010Coverage): string {
  switch (coverage) {
    case 'complete': return 'complete';
    case 'unsupported': return 'not supported for this code type';
    default: return 'incomplete (some services or clients could not be checked)';
  }
}

// Finding ids look like `dependency:subject/scenario`; the subject (config key, file, or
// interface) is what tells otherwise identical scenario rows apart.
function findingSubject(finding: Pick<S010Finding, 'id'>): string {
  return finding.id.match(/^[^:/]+:(.+)\/[^/]+$/)?.[1] ?? '';
}

// FOLIO interfaces share one row, and so do client classes; every other dependency gets its own.
function groupKey(finding: S010Finding): string {
  if (finding.dependencyId.startsWith('folio-interface:')) return 'folio-interface';
  return isClientFinding(finding) ? 'client' : finding.dependencyId;
}

// Java client scenarios are named after the class that uses the client, not after a known service.
function isClientFinding(finding: Pick<S010Finding, 'id' | 'dependencyId' | 'scenario'>): boolean {
  const subject = findingSubject(finding);
  return finding.scenario === 'runtime-unavailable' && subject !== '' && !/:\d+$/.test(subject)
    && !finding.dependencyId.startsWith('folio-interface:');
}

function groupFindings(findings: S010Finding[]): S010Finding[][] {
  const groups = new Map<string, S010Finding[]>();
  for (const finding of findings) {
    const key = JSON.stringify([groupKey(finding), finding.scenario, finding.rationale]);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }
  return [...groups.values()];
}

/** Plain title of a group of findings about the same dependency and scenario. */
export function s010FindingTitle(group: S010Finding[]): string {
  const finding = group[0];
  const subjects = [...new Set(group.map(findingSubject).filter(Boolean))];
  if (finding.dependencyId === 'evidence-coverage') return 'Services the tool may have missed';
  if (finding.dependencyId === 'dependency-scope') return 'External services';
  if (finding.dependencyId === 'runtime-support') return 'Code type';
  if (finding.scenario === 'configuration-absent') {
    const service = SERVICE_NAMES[finding.dependencyId];
    return `${service ? `${service} settings` : 'Settings'} (${list(subjects)}), if missing at startup`;
  }
  if (groupKey(finding) === 'folio-interface') {
    return `FOLIO interfaces (${list(subjects)}), if the modules behind them go down`;
  }
  if (subjects.length && subjects.every(subject => /:\d+$/.test(subject))) {
    return `Requests to ${shorten(finding.dependencyId)}, if the host goes down`;
  }
  if (isClientFinding(finding)) {
    return subjects.length === 1
      ? `Service called from ${shorten(path.basename(subjects[0]))}, if it goes down while the module runs`
      : `Services called from ${subjects.length} files, if they go down while the module runs`;
  }
  const name = shorten(serviceName(finding.dependencyId));
  return finding.scenario === 'startup-unavailable'
    ? `${name}, if it is down when the module starts`
    : `${name}, if it goes down while the module runs`;
}

// Names come from the repository (environment variables, hosts, file names): keep a crafted one from
// filling the report or breaking out of its row.
function shorten(value: string): string {
  return reportText(value.length > MAX_NAME_CHARS ? `${value.slice(0, MAX_NAME_CHARS)}…` : value);
}

function list(values: string[]): string {
  const shown = values.slice(0, MAX_SUBJECTS).map(shorten).join(', ');
  return values.length > MAX_SUBJECTS ? `${shown} +${values.length - MAX_SUBJECTS} more` : shown;
}

function referenceLines(group: S010Finding[]): string[] {
  const seen = new Set<string>();
  const references: Array<[S010Finding, S010SourceReference]> = [];
  for (const finding of group) {
    for (const reference of finding.evidence) {
      const key = JSON.stringify([reference.path, reference.line, reference.detail]);
      if (seen.has(key)) continue;
      seen.add(key);
      references.push([finding, reference]);
    }
  }
  return [
    ...references.slice(0, MAX_REFERENCES).map(([finding, reference]) =>
      `    - ${reportPath(reference.path)}${reference.line ? `:${reference.line}` : ''} [${referenceTag(finding, reference)}] ${reportText(reference.detail)}`),
    ...(references.length > MAX_REFERENCES ? [`    - ... ${references.length - MAX_REFERENCES} more`] : [])
  ];
}

function referenceTag(finding: S010Finding, reference: S010SourceReference): string {
  if (finding.scenario === 'configuration-absent' || /\.(?:ya?ml|properties)$/i.test(reference.path)) return 'config';
  if (/(?:^|\/)package\.json$/.test(reference.path)) return 'package';
  if (finding.dependencyId === 'database') return 'database';
  if (finding.dependencyId === 'search') return 'search';
  return /\.[cm]?[jt]sx?$/.test(reference.path) ? 'request' : 'client';
}

function warningLines(diagnostics: S010Diagnostic[]): string[] {
  if (!diagnostics.length) return [];
  const lines = ['Warnings:'];
  const merged = new Map<string, string[]>();
  for (const diagnostic of diagnostics) {
    const sourceWarning = sourceWarningText(diagnostic);
    if (!sourceWarning) {
      lines.push(`  - ${diagnostic.path ? `${reportPath(diagnostic.path)} [${diagnosticTag(diagnostic)}] ` : ''}${reportText(diagnostic.message)}`);
      continue;
    }
    const paths = merged.get(sourceWarning) ?? [];
    if (diagnostic.path) paths.push(diagnostic.path);
    merged.set(sourceWarning, paths);
  }
  for (const [text, paths] of merged) {
    const unique = [...new Set(paths)];
    if (!unique.length) {
      lines.push(`  - ${text}.`);
      continue;
    }
    lines.push(
      `  - ${text} (${unique.length} ${unique.length === 1 ? 'file' : 'files'}):`,
      ...unique.slice(0, MAX_WARNING_PATHS).map(item => `    - ${reportPath(item)}`),
      ...(unique.length > MAX_WARNING_PATHS ? [`    - ... ${unique.length - MAX_WARNING_PATHS} more`] : [])
    );
  }
  return lines;
}

function diagnosticTag(diagnostic: S010Diagnostic): string {
  return diagnostic.code === 'unsupported-runtime-pattern' ? 'unsupported' : 'unreadable';
}

// Warnings from reading the committed source tree, one line per kind instead of one per file.
function sourceWarningText(diagnostic: S010Diagnostic): string | undefined {
  const kilobytes = Math.round(S010_SOURCE_LIMITS.maxFileBytes / 1024);
  const megabytes = Math.round(S010_SOURCE_LIMITS.maxTotalBytes / (1024 * 1024));
  switch (diagnostic.code) {
    case 'file-size': return `Files larger than ${kilobytes} KB were not read`;
    case 'total-size': return `Files past the ${megabytes} MB reading limit were not read`;
    case 'file-limit': return `Only the first ${S010_SOURCE_LIMITS.maxFiles.toLocaleString('en-US')} matching files were read`;
    case 'binary': return 'Binary files were not read';
    case 'unsafe-entry': return 'Symbolic links, submodules and unsafe paths were not read';
    case 'entry-limit': return 'The repository has too many files to list in full, so some were not read';
    case 'tree-limit': return 'The repository file list was too long to read in full, so some files were not read';
    case 'git-error': return `Git could not read part of the repository (${reportText(diagnostic.message)})`;
    default: return undefined;
  }
}

/** Names for the dependency ids the agent assesses, as the rows above name them. */
export function s010AgentReviewNames(analysis: S010Analysis): Record<string, string> {
  const services = new Set<string>();
  const clientFiles = new Map<string, Set<string>>();
  for (const scenario of analysis.evidence.scenarios) {
    if (isClientFinding(scenario) && !isKnownService(scenario.dependencyId)) {
      clientFiles.set(scenario.dependencyId, (clientFiles.get(scenario.dependencyId) ?? new Set<string>())
        .add(path.basename(findingSubject(scenario))));
    } else {
      services.add(scenario.dependencyId);
    }
  }
  return Object.fromEntries([
    ['folio-interfaces', 'FOLIO interfaces'],
    ...[...services].map(id => [id, serviceName(id)]),
    // A client class's id is made from its file name, so name it by the file, as its row does.
    ...[...clientFiles].filter(([id]) => !services.has(id))
      .map(([id, files]) => [id, `${files.size === 1 ? 'Service' : 'Services'} called from ${list([...files])}`])
  ]);
}
