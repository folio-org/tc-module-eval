import {
  CriterionResult, EvaluationResult, EvaluationStatus, HtmlReportItem, HtmlReportNode, PreparedHtmlReport,
  S006ReportDetails, S007AnalysisResult, S010Analysis, S011Analysis
} from '../types';
import { agentReviewRunCost, agentReviewUsageText, renderAgentReviewLines } from './agent-review-report';
import { redactEvaluatorSecretsInValue } from './redaction';
import { reportText } from './report-text';
import { s010AgentReviewNames } from './s010-report-details';
import { s011AgentReviewNames } from './s011-evaluator';
import { citedTrackedFiles } from '../module-evaluator';
import { AGENT_REVIEW_CRITERIA } from './criterion-agent-review';
import { HUMAN_REVIEW_DETAILS, getAcceptanceCriterionDefinition } from '../criteria-definitions';
import { CHECKLIST_HEADING, frontendChecklistOf, renderFrontendAgentReviewLines, renderFrontendChecklistLines } from './frontend-checklist';

const CRITERION_TITLES: Record<string, string> = {
  A001: 'Product Council approval',
  S001: 'Open-source license',
  S002: 'Module descriptor',
  S003: 'Third-party licenses',
  S004: 'Installation documentation',
  S005: 'Personal data disclosure',
  S006: 'Sensitive information',
  S007: 'Officially supported technologies',
  S008: 'FOLIO interface usage',
  S009: 'FOLIO library dependencies',
  S010: 'Third-party system resilience',
  S011: 'SonarQube findings',
  S012: 'Officially supported build tools',
  S013: 'Unit test coverage and technologies',
  S014: 'Application assignment',
  F001: 'Consumed interfaces declared',
  F002: 'End-to-end tests',
  F003: 'Internationalization',
  F004: 'WCAG 2.1 AA accessibility',
  F005: 'Stripes version',
  F006: 'UI layouts and patterns',
  F007: 'Works in the latest Chrome',
  B001: 'Module descriptor template',
  B002: 'Consumed interfaces declared',
  B003: 'Endpoint implementations',
  B004: 'Environment variables',
  B005: 'Interface naming',
  B006: 'API documentation',
  B007: 'Endpoint permissions',
  B008: 'Reference data',
  B009: 'API tests',
  B010: 'Tenant data segregation',
  B011: 'Other modules\' database schemas',
  B012: 'Dependencies declared in README',
  B013: 'Tenant selection',
  B014: 'Health check endpoint',
  B015: 'High availability',
  B016: 'Supported infrastructure'
};

const CATEGORIES: Record<string, string> = { A: 'Administrative', S: 'Shared', B: 'Backend', F: 'Frontend' };

/**
 * Prepares the HTML report of an evaluation: the criteria as the report shows them and the report its
 * "Download JSON" button saves. Secrets are masked and repository URL credentials removed from both.
 */
export function prepareHtmlReport(result: EvaluationResult, { createdAt = new Date() }: { createdAt?: Date } = {}): PreparedHtmlReport {
  const safeResult = redactEvaluatorSecretsInValue({ ...result, repositoryUrl: repositoryUrlWithoutCredentials(result.repositoryUrl) });
  const citedSourcePaths = safeResult.provenance?.citedSourcePaths ?? [];
  const sourceBase = pinnedSourceBase(safeResult);
  const items = safeResult.criteria.map((criterion, index) =>
    // Rows link only to files this criterion cites in its structured data, so text copied from the
    // repository (build output, license names) cannot link to a file another criterion cites.
    htmlReportItem(criterion, { cited: citedTrackedFiles([result.criteria[index]], citedSourcePaths), sourceBase }));
  const firstReview = items.find(item => item.triage === 'review');
  if (firstReview) firstReview.open = true;
  const cost = agentReviewRunCost(safeResult.criteria.map(criterion => criterion.agentReview));
  return {
    view: {
      meta: {
        module: safeResult.moduleName,
        language: safeResult.language,
        repo: safeResult.repositoryUrl,
        evaluatedAt: safeResult.evaluatedAt.toLocaleString(),
        createdAt: createdAt.toLocaleString(),
        commit: safeResult.provenance?.repositoryCommit,
        evaluator: safeResult.provenance?.evaluator,
        agentReviewModel: safeResult.provenance?.agentReviewModel,
        agentReviewCost: cost && `$${cost.costUsd.toFixed(2)} for ${cost.reviews} ${cost.reviews === 1 ? 'review' : 'reviews'}${cost.unpriced ? `, ${cost.unpriced} not priced` : ''}`
      },
      items
    },
    download: {
      ...safeResult,
      criteria: safeResult.criteria.map(criterion => ({
        ...criterion,
        details: criterion.agentReview ? reportDetailLines(criterion).join('\n') : criterion.details,
        agentReview: criterion.agentReview ? { ...criterion.agentReview, metadata: undefined } : undefined
      }))
    }
  };
}

interface SourceLinks {
  cited: string[];
  sourceBase?: string;
}

function htmlReportItem(criterion: CriterionResult, links: SourceLinks): HtmlReportItem {
  const id = criterion.criterionId;
  const rows = htmlDetailLines(criterion);
  // Criteria without an automated check have exactly this details text; a prefix or evidence suffix could be repository text.
  const human = criterion.status === EvaluationStatus.MANUAL && rows.length === 1 && rows[0] === HUMAN_REVIEW_DETAILS;
  const tree = human ? [] : criterionTree(id, rows);
  let evidence = criterion.evidence.replace(/^[SFB]\d+ manual:\s*/, '');
  const licenses = dependencyLicenses(criterion);
  if (licenses) {
    evidence = licenses.summary;
    tree.push({ text: 'Dependency licenses', countText: String(licenses.count), children: licenses.groups.map(group => ({
      text: group.name, unit: group.dependencies.length === 1 ? 'dep' : 'deps',
      children: group.dependencies.map(text => ({ text, children: [] }))
    })) });
  }
  const title = criterionTitle(id, criterion.evidence);
  const description = getAcceptanceCriterionDefinition(id)?.summary;
  return {
    id,
    title,
    description,
    status: criterion.status,
    evidence,
    subtitle: id === 'A001' ? criterion.evidence : '',
    category: CATEGORIES[id.charAt(0)] || '',
    triage: criterion.status === EvaluationStatus.PASS ? 'passed' : criterion.status === EvaluationStatus.NOT_APPLICABLE ? 'not-applicable' : human ? 'human' : 'review',
    search: `${id} ${title} ${description || ''} ${criterion.evidence} ${rows.join(' ')}`.toLowerCase(),
    // The agent badge comes only from the structured review, never from details text.
    recommendation: criterion.agentReview?.available ? criterion.agentReview.recommendation : undefined,
    reviewItems: (frontendChecklistOf(id, criterion.criterionDetails)?.items ?? [])
      .map(item => ({ id: reportText(item.id), title: reportText(item.title) })),
    tree: tree.map(node => displayNode(node, 0, links))
  };
}

function criterionTitle(id: string, evidence: string): string {
  return CRITERION_TITLES[id]
    || evidence.replace(/ - evaluation logic not yet implemented$/, '');
}

function repositoryUrlWithoutCredentials(repositoryUrl: string): string {
  try {
    const parsed = new URL(repositoryUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || (!parsed.username && !parsed.password)) {
      return repositoryUrl;
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return repositoryUrl;
  }
}

function pinnedSourceBase(result: EvaluationResult): string | undefined {
  const match = result.repositoryUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
  const commit = result.provenance?.repositoryCommit;
  return match && commit && /^[0-9a-f]{40}$/i.test(commit)
    ? `https://github.com/${match[1]}/${match[2]}/blob/${commit}/`
    : undefined;
}

function diagnosticLines(values: string[]): string[] {
  const seen = new Set<string>();
  // Review errors and warnings can quote repository text, so each stays on one row.
  return values
    .map(value => reportText(value.trim().replace(/^[-•]\s*/, '').replace(/^(?:Not applied|Errors|Warnings):\s*/i, '')))
    // The report names no adapter or model; the reason already says which run failed.
    .filter(value => !/^(?:Adapter|Model label):/.test(value))
    .filter(value => value && !seen.has(value) && seen.add(value))
    .map(value => value.length > 500 ? `${value.slice(0, 497)}...` : value);
}

// The rows from a "Heading:" row through its indented rows removed.
function withoutSection(lines: string[], heading: string | ((row: string) => boolean)): string[] {
  const matches = typeof heading === 'string' ? (row: string) => row.trim() === heading : heading;
  let inSection = false;
  return lines.filter(line => {
    if (!/^\s/.test(line) && matches(line)) inSection = true;
    else if (inSection && line.trim() && !/^\s/.test(line)) inSection = false;
    return !inSection;
  });
}

// The end of the top-level row at `start` and its indented rows.
function sectionEnd(lines: string[], start: number): number {
  let end = start + 1;
  while (end < lines.length && /^\s/.test(lines[end])) end++;
  return end;
}

const AGENT_REVIEW_HEADING = 'Agent review (advisory):';
const KEY_VALUE_ROW = /^[A-Z][A-Za-z0-9 ()\-/]{1,38}:\s/;

// Sections the HTML report leaves out so the reviewer sees what to act on; the JSON report keeps them.
const HTML_OMITTED_SECTIONS: Record<string, Array<string | ((row: string) => boolean)>> = {
  S005: ['Artifact mechanics:', 'Disclosure form:', 'Evidence from the code:', 'Possible mismatches:'],
  B005: [row => /^Routes found in the source: \d+$/.test(row),
    'Names that differ from the first segment of their handler paths (information only):']
};

// The HTML report's rows: "What to do" right after the agent review and any opening sentence, and per-criterion
// sections left out (see HTML_OMITTED_SECTIONS).
function htmlDetailLines(criterion: CriterionResult): string[] {
  let lines = reportDetailLines(criterion);
  const start = lines.findIndex(line => /^What to do:/.test(line));
  if (start >= 0) {
    const block = lines.slice(start, sectionEnd(lines, start));
    const rest = [...lines.slice(0, start), ...lines.slice(start + block.length)];
    let at = rest[0]?.trim() === AGENT_REVIEW_HEADING ? sectionEnd(rest, 0) : 0;
    while (at < rest.length && rest[at].trim() && !/^\s/.test(rest[at]) && !rest[at].trim().endsWith(':')
      && !KEY_VALUE_ROW.test(rest[at]) && !/^\s/.test(rest[at + 1] ?? '')) at++;
    lines = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  }
  for (const section of HTML_OMITTED_SECTIONS[criterion.criterionId] ?? []) lines = withoutSection(lines, section);
  if (criterion.criterionId === 'S006') {
    // Coverage and skipped files follow the strongest examples.
    const examples = lines.findIndex(line => /^Strongest examples\b.*:$/.test(line));
    if (examples >= 0) lines = lines.slice(0, sectionEnd(lines, examples));
  }
  if (criterion.criterionId === 'B015') {
    // Only what the tool found, and whether it listed every site.
    const found = lines.indexOf('What the tool found:');
    if (found >= 0) {
      const end = sectionEnd(lines, found);
      const kept = lines.slice(found + 1, end).filter(line =>
        !/^\s+- (?:Source read|Agent review scope): /.test(line) && !/^\s+- [^:]+: none found$/.test(line));
      lines = [...lines.slice(0, found), ...(kept.length ? ['What the tool found:', ...kept] : []), ...lines.slice(end)];
    }
  }
  return lines;
}

// Use structured advice as the HTML source of truth, not criterion-specific prose copies.
function reportDetailLines(criterion: CriterionResult): string[] {
  const original = criterion.details?.split('\n') ?? [];
  // Criteria with agent review write an "Agent review:" section even without a structured review; elsewhere such a
  // line can only come from repository text, so it stays an ordinary row.
  if (!criterion.agentReview && !AGENT_REVIEW_CRITERIA.has(criterion.criterionId)) return original;
  // The agent review comes first for every criterion; F and B criteria then show what the tool found and the checklist.
  const checklist = frontendChecklistOf(criterion.criterionId, criterion.criterionDetails);
  let inReview = false;
  let hadReview = false;
  const legacyReview: string[] = [];
  const details = original.filter(line => {
    if (/^Agent review(?: \(advisory\))?:$/.test(line.trim())) {
      inReview = true;
      hadReview = true;
      return false;
    }
    if (inReview && line.trim() && !/^\s/.test(line)) inReview = false;
    if (inReview) legacyReview.push(line);
    return !inReview && !/^\s+- Agent review:/.test(line);
  });
  const review = criterion.agentReview;
  if (!review && !hadReview) return original;
  const usage = review?.metadata?.usage ? [`  - Cost: ${agentReviewUsageText(review.metadata.usage)}`] : [];
  if (!review?.available) {
    const diagnostics = diagnosticLines([...(review?.errors ?? []), ...(review?.warnings ?? []), ...legacyReview]);
    const reason = diagnostics.join(' ');
    const skippedForEvidence = /no candidate evidence was available for agent review/i.test(reason);
    const skippedForCriterion = /agent review is not enabled for [SFB]\d+/i.test(reason);
    const skippedForConfiguration = /agent review is disabled|disabled or unconfigured/i.test(reason);
    const skipped = skippedForEvidence || skippedForCriterion || skippedForConfiguration;
    const failed = review || /failed|failure|error|incomplete|unavailable|timed out|exceeded (?:its )?time limit/i.test(reason);
    const status = skipped ? 'Skipped' : failed ? 'Unavailable' : 'Not run';
    const explanation = skippedForEvidence
      ? 'Skipped because no candidate evidence was available for review.'
      : skippedForCriterion
        ? 'Skipped because agent review is not enabled for this criterion.'
        : skippedForConfiguration
          ? 'Skipped because agent review is disabled or unconfigured.'
          : failed
            ? 'No usable advisory review was returned.'
            : 'Agent review was not run.';
    // The adapter's run diagnosis says why the run failed, so it gets its own row.
    const diagnosis = diagnostics.find(value => value.startsWith('OpenCode run diagnosis: '));
    const others = diagnostics.filter(value => value !== diagnosis);
    const diagnosticDetails = skipped || !others.length ? [] : [
      `  - Reason: ${others[0]}`,
      ...(diagnosis ? [`  - Diagnosis: ${diagnosis.slice('OpenCode run diagnosis: '.length)}`] : []),
      ...(others.length > 1
        ? ['  - Additional diagnostics:', ...others.slice(1, 6).map(value => `    - ${value}`)]
        : []),
      ...(others.length > 6 ? [`    - ... ${others.length - 6} more in the downloaded JSON report`] : [])
    ];
    const block = ['Agent review (advisory):', `  - Status: ${status}`, `  - Summary: ${explanation}`, ...diagnosticDetails, ...usage];
    return [...block, ...details];
  }
  if (checklist) {
    // Each checklist item carries the agent's results for its obligations; the review section keeps the rest.
    return [
      ...renderFrontendAgentReviewLines(checklist, review),
      ...usage,
      ...withoutSection(details, CHECKLIST_HEADING),
      ...renderFrontendChecklistLines(checklist, review)
    ];
  }
  // The subject names each criterion's own report uses, so the rows match the rest of its details.
  const names = criterion.criterionId === 'S007'
    ? Object.fromEntries(((criterion.criterionDetails as S007AnalysisResult | undefined)?.findings ?? [])
      .map(finding => [finding.technologyId, finding.displayName]))
    : criterion.criterionId === 'S006'
      ? (criterion.criterionDetails as S006ReportDetails | undefined)?.agentReviewSubjectNames ?? {}
      : criterion.criterionId === 'S010' && criterion.criterionDetails
        ? s010AgentReviewNames(criterion.criterionDetails as S010Analysis)
        : criterion.criterionId === 'S011' && criterion.criterionDetails
          ? s011AgentReviewNames(criterion.criterionDetails as S011Analysis)
          : {};
  return [...renderAgentReviewLines(review, names), '  - Advisory only; the criterion status is unchanged.', ...usage, ...details];
}

// S003 dependencies grouped by license, from the structured dependency list rather than the evidence text,
// whose license names may contain the separators the text uses.
function dependencyLicenses(criterion: CriterionResult) {
  const dependencies = (criterion.criterionDetails as { dependencies?: Array<{ name: string; version: string; licenses: string[] }> } | undefined)
    ?.dependencies;
  if (criterion.criterionId !== 'S003' || !Array.isArray(dependencies)) return undefined;
  const groups = new Map<string, string[]>();
  for (const { name, version, licenses } of dependencies) {
    // Merge only exact spellings of Apache 2.0 and MIT; other, combined, or unknown names stay verbatim.
    let license = licenses.length ? licenses.join(', ') : 'No license reported';
    if (/^(?:the )?apache(?: software)?(?: license)?[ ,-]*(?:version )?2(?:\.0)?$/i.test(license)) license = 'Apache 2.0';
    else if (/^(?:the )?mit(?: license)?(?: \(mit\))?$/i.test(license)) license = 'MIT';
    groups.set(license, [...(groups.get(license) ?? []), `${name}:${version}`]);
  }
  const count = dependencies.length;
  return {
    summary: `Found ${count === 1 ? '1 dependency' : `${count} dependencies`}. License groups are listed below the flagged items.`,
    count,
    groups: [...groups].map(([name, members]) => ({ name, dependencies: members }))
      .sort((left, right) => right.dependencies.length - left.dependencies.length)
  };
}

// A details row and the rows indented below it, with how the report presents them.
interface DetailNode {
  text: string;
  children: DetailNode[];
  hidden?: number;
  unit?: string;
  countText?: string;
  hideCount?: boolean;
  openByDefault?: boolean;
  showAll?: boolean;
  showFullText?: boolean;
}

// Details rows nest by indentation; a "-" or "•" bullet marks a list row and a blank row ends every list.
function detailTree(lines: string[]): DetailNode[] {
  const root: DetailNode = { text: '', children: [] };
  let stack = [{ indent: -1, node: root }];
  for (const raw of lines) {
    if (!raw.trim()) {
      stack = [stack[0]];
      continue;
    }
    const bullet = /^\s*[-•]\s/.test(raw);
    const leading = raw.match(/^\s*/)![0].length;
    const node: DetailNode = { text: raw.replace(/^\s*(?:[-•]\s+)?/, ''), children: [] };
    if (!bullet && leading === 0) {
      root.children.push(node);
      stack = [stack[0], { indent: 0, node }];
      continue;
    }
    const indent = raw.trim().charAt(0) === '•' ? 2 : leading + 2;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  // "... N more" list markers become a hidden-item count on their parent instead of a fake list entry.
  const collapseOverflow = (node: DetailNode): void => {
    node.children = node.children.filter(child => {
      const more = !child.children.length && child.text.match(/^\.\.\. (\d+) more$/);
      if (more) node.hidden = (node.hidden || 0) + Number(more[1]);
      return !more;
    });
    node.children.forEach(collapseOverflow);
  };
  collapseOverflow(root);
  return root.children;
}

const plural = (count: number, singular: string) => count === 1 ? singular : `${singular}s`;

function criterionTree(id: string, rows: string[]): DetailNode[] {
  const tree = detailTree(rows);
  if (id === 'S007' || id === 'F005') {
    // F005 shows S007's Stripes rows under its own heading.
    const technologyFindings = tree.find(node => /^(?:Technology findings|S007's Stripes finding):?$/.test(node.text));
    technologyFindings?.children.forEach(node => {
      node.unit = plural(node.children.length, /^Repository evidence coverage:/.test(node.text) ? 'limitation' : 'observation');
      node.children.forEach(observation => { observation.hideCount = true; });
    });
  }
  if (id === 'S009') {
    const hideNestedCounts = (node: DetailNode): void => node.children.forEach(child => {
      if (child.children.length) child.hideCount = true;
      hideNestedCounts(child);
    });
    tree.forEach(hideNestedCounts);
  }
  // An F or B criterion's checklist items, and where to start on each, are what the reviewer works through.
  const checklist = /^[FB]\d+$/.test(id) && tree.find(node => node.text === CHECKLIST_HEADING);
  if (checklist) checklist.children.forEach(checkItem => {
    checkItem.openByDefault = true;
    checkItem.hideCount = true;
    checkItem.children.forEach(node => {
      if (node.text === 'Start with:') {
        node.openByDefault = true;
        node.hideCount = true;
      }
    });
  });
  // reportDetailLines puts the only real agent-review section first; a heading anywhere else is repository text.
  const agent = tree[0]?.text === AGENT_REVIEW_HEADING ? tree[0] : undefined;
  if (agent) {
    // Its rows are the review's fields, so none is hidden behind "Show more", as for a card's sections.
    agent.hideCount = true;
    agent.showAll = true;
    for (const node of agent.children) {
      const prose = node.text.match(/^(?:Summary|Rationale):\s+(.+)$/s);
      node.showFullText = !!prose && prose[1].trim().split(/\s+/).length <= 100;
      if (node.text === 'Sources:') node.unit = plural(node.children.length, 'source');
    }
    for (const group of agent.children) {
      if (!/^(Findings|What to verify|Dropped from this review):?$/.test(group.text)) continue;
      group.openByDefault = true;
      group.unit = /^Findings/.test(group.text) ? plural(group.children.length, 'finding')
        : /^Dropped/.test(group.text) ? plural(group.children.length, 'item')
          : plural(group.children.length, 'check');
      for (const finding of group.children) {
        finding.hideCount = true;
        for (const detail of finding.children) {
          if (detail.text === 'Sources:') detail.unit = plural(detail.children.length, 'source');
        }
      }
    }
  }
  return tree;
}

const FIELD_ROW = /^([A-Z][A-Za-z0-9 ()\-/]{1,38}):\s+(.+)$/s;

// A top-level row with rows below it is a section; any other top-level row is a field or a sentence. Below a
// section, a "Name: value" row without rows below it is a field and every other row a list row.
function displayNode(node: DetailNode, depth: number, links: SourceLinks): HtmlReportNode {
  const entries = node.children.length + (node.hidden || 0);
  const children = node.children.map(child => displayNode(child, depth + 1, links));
  const expandable = { open: true, showAll: node.showAll || undefined, hidden: node.hidden || undefined, children };
  if (depth === 0 && entries) {
    return { kind: 'section', text: node.text.replace(/:$/, ''), count: node.hideCount ? undefined : node.countText || String(entries), ...expandable };
  }
  const field = !entries && node.text.match(FIELD_ROW);
  if (field) return { kind: 'field', key: field[1], text: field[2], fullText: node.showFullText || undefined, children };
  if (depth === 0) return { kind: 'paragraph', text: node.text, children };
  const parts = rowParts(node.text.replace(/:$/, entries ? '' : ':'), links.cited);
  return {
    kind: 'row',
    text: parts.text,
    lead: parts.lead || undefined,
    href: (parts.lead && rowHref(parts, links)) || undefined,
    tag: parts.tag || undefined,
    count: entries && !node.hideCount ? `${entries}${node.unit ? ` ${node.unit}` : ''}` : undefined,
    ...expandable,
    open: entries && node.openByDefault ? true : undefined
  };
}

interface RowParts {
  lead: string;
  tag: string;
  text: string;
}

// A row's leading file, path or Maven coordinate, and its "[tag]" or "kind/kind:" label.
function segments(text: string): RowParts {
  let lead = '';
  let tag = '';
  let remaining = text;
  let match = remaining.match(/^([\w.\-]+:[\w.\-]+:[\w.\-]+)(\s+-\s+|$)/)
    || remaining.match(/^((?:[\w.\-/%]*\.[A-Za-z]\w*|[\w.\-/%]+)(?::\d+(?:-\d+)?)?)(\s*\|\s*|\s+|$)/);
  if (match && (((/[./]/.test(match[1]) || /:\d+(?:-\d+)?$/.test(match[1])) && /[/.:]/.test(match[1]) && !/^\w+\.$/.test(match[1]))
    || /^\[[\w/-]+\]/.test(remaining.slice(match[0].length)))) {
    lead = match[1];
    remaining = remaining.slice(match[0].length);
  }
  match = remaining.match(/^\[([\w/-]+)\]\s*/);
  if (match) {
    tag = match[1];
    remaining = remaining.slice(match[0].length);
  } else if (!lead) {
    match = remaining.match(/^([a-z_]+\/[a-z_]+):\s*/);
    if (match) {
      tag = match[1];
      remaining = remaining.slice(match[0].length);
    }
  }
  return { lead, tag, text: remaining.replace(/\s\|\s/g, ' · ') };
}

// A row that is exactly a file this criterion cites (such as "Dockerfile" in agent-review sources) is that file.
function rowParts(text: string, cited: string[]): RowParts {
  const parts = segments(text);
  if (parts.lead || parts.tag) return parts;
  let file: string;
  try {
    file = decodeURIComponent(text);
  } catch {
    return parts;
  }
  return cited.includes(file) ? { lead: text, tag: '', text: '' } : parts;
}

// A path shortened to the reference budget names a different file than its cited prefix, so it gets no link.
function rowHref(parts: RowParts, links: SourceLinks): string | undefined {
  return /^\[truncated to \d+ bytes\]/.test(parts.text) ? undefined : sourceHref(parts.lead, links);
}

function sourceHref(reference: string, { cited, sourceBase }: SourceLinks): string | undefined {
  if (!sourceBase) return undefined;
  const match = reference.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/);
  if (!match) return undefined;
  const [, encoded, line, endLine] = match;
  let file: string;
  // Criteria percent-encode unusual characters in paths (reportPath), so decode before matching cited files.
  try {
    file = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (!file || file.charAt(0) === '/' || file.split('/').includes('..') || !cited.includes(file)) return undefined;
  return sourceBase + file.split('/').map(encodeURIComponent).join('/') + (line ? `#L${line}${endLine ? `-L${endLine}` : ''}` : '');
}
