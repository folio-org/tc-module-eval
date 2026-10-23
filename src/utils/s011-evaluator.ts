import {
  CriterionAgentReviewResult,
  EvaluationRun,
  EvaluationStatus,
  RemoteEvidenceRecord,
  S011Analysis,
  S011ScopeSetting,
  S011Suppression,
  S011SuppressionScan,
  SonarCloudSnapshot,
  SonarHotspotQuery,
  SonarRule
} from '../types';
import { renderAgentReviewLines } from './agent-review-report';
import { collectBuildTestEvidence } from './build-test-evidence';
import { loadFolioSharedWorkflows } from './folio-shared-workflows';
import { sourceLine } from './remote-evidence';
import { reportPath, reportText } from './report-text';
import { groupS011ReviewItems, scanS011Suppressions, suppressionFlags } from './s011-suppressions';
import { getSonarCloudSnapshot, lookupSonarRules, sonarSnapshotFreshness } from './sonarcloud-snapshot';

const DUPLICATION_LIMIT = 3.0;
const RERUN_HINT = 'Rerun with --allow-remote-lookups';
const SETTINGS_UNREAD = 'Exclusions set in SonarCloud\'s project settings could not be read without a SonarCloud admin token';
const MAX_RULE_ROWS = 10;
const MAX_ROWS = 15;

export interface S011Inputs {
  remoteLookups: boolean;
  repositoryCommit?: string;
  snapshot?: SonarCloudSnapshot;
  scan: S011SuppressionScan;
  rules: Record<string, SonarRule>;
  rulesRecord?: RemoteEvidenceRecord;
  /** Shared FOLIO workflows the CI calls that do not run SonarCloud (gradle.yml), when none that does is called. */
  workflowsWithoutSonar: string[];
}

/** Gathers S011's local and remote evidence for one evaluation and evaluates it. */
export async function analyzeS011(repoPath: string, run: EvaluationRun): Promise<S011Analysis> {
  const [ci, table] = await Promise.all([
    run.getOrCreateArtifact('buildTestEvidence', () => collectBuildTestEvidence(repoPath)),
    loadFolioSharedWorkflows()
  ]);
  const workflows = table.ok ? table.table : undefined;
  // Made once per run: S013 lists the coverage settings from the same scan.
  const scan = await run.getOrCreateArtifact('s011SuppressionScan', async () => scanS011Suppressions(repoPath, ci, workflows));
  const sonarFlags = scan.sharedWorkflows.map(name => workflows?.workflows[name]?.sonar);
  const inputs: S011Inputs = {
    remoteLookups: Boolean(run.remoteLookups),
    repositoryCommit: run.repositoryCommit,
    scan,
    rules: {},
    workflowsWithoutSonar: sonarFlags.includes(true) ? [] : scan.sharedWorkflows.filter((_, index) => sonarFlags[index] === false)
  };
  const lookups = run.remoteLookups;
  if (!lookups) return evaluateS011(inputs);
  inputs.snapshot = await getSonarCloudSnapshot(run, repoPath);
  const keys = [...ruleKeysIn(inputs.snapshot), ...scan.suppressions.flatMap(item => item.rule ? [item.rule] : [])];
  const { rules, record } = await lookupSonarRules(lookups, keys);
  inputs.rules = rules;
  inputs.rulesRecord = record;
  return evaluateS011(inputs);
}

function ruleKeysIn(snapshot: SonarCloudSnapshot | undefined): string[] {
  if (!snapshot) return [];
  return [
    ...(snapshot.highIssues.rules ?? []).slice(0, MAX_RULE_ROWS).map(item => item.rule),
    ...snapshot.securityIssues.examples.map(item => item.rule),
    ...snapshot.ignoredIssues.examples.map(item => item.rule),
    ...[snapshot.hotspotsToReview, snapshot.hotspotsReviewed].flatMap(query => query.examples.flatMap(item => item.rule ? [item.rule] : []))
  ];
}

export function evaluateS011(inputs: S011Inputs): S011Analysis {
  const { snapshot, scan, rules } = inputs;
  const { remoteEvidence: snapshotEvidence = [], ...snapshotDetails } = snapshot ?? {};
  const base: S011Analysis = {
    criterionId: 'S011',
    status: EvaluationStatus.MANUAL,
    summary: '',
    remoteLookups: inputs.remoteLookups,
    projectKey: snapshot?.projectKey,
    repositoryCommit: inputs.repositoryCommit,
    snapshot: snapshot ? snapshotDetails as S011Analysis['snapshot'] : undefined,
    violations: [],
    manualReasons: [],
    scan,
    reviewGroups: groupS011ReviewItems(scan, rules),
    rules,
    remoteEvidence: [...snapshotEvidence, ...(inputs.rulesRecord ? [inputs.rulesRecord] : [])]
  };
  const result = (status: EvaluationStatus, summary: string, gate?: string): S011Analysis =>
    ({ ...base, status, summary: `S011 ${status}: ${summary}`, ...(gate ? { gate } : {}) });
  const local = localSentence(scan);

  if (!inputs.remoteLookups || !snapshot) {
    return result(EvaluationStatus.MANUAL, `Not checked: remote lookups are off. ${RERUN_HINT} to read the module's SonarCloud analysis.${local}`, 'remote-lookups-off');
  }
  const key = reportText(snapshot.projectKey);
  if (snapshot.projectFound === false) {
    const why = inputs.workflowsWithoutSonar.length
      ? ` Its CI uses FOLIO's ${inputs.workflowsWithoutSonar.map(reportText).join(' and ')} workflow, which does not run SonarCloud, so`
      : ' So';
    return result(EvaluationStatus.MANUAL, `SonarCloud has no project for this module (${key}).${why} the security, severity, and duplication checks could not be made.${local}`, 'no-project');
  }
  if (snapshot.problem || !snapshot.analysis) {
    return result(EvaluationStatus.MANUAL, `${reportText(snapshot.problem ?? 'SonarCloud has no analysis of the project.')} A reviewer needs to check the module in SonarCloud (${key}).${local}`, 'sonarcloud-unavailable');
  }
  const freshness = sonarSnapshotFreshness(snapshot, inputs.repositoryCommit);
  if (!freshness.fresh) {
    return result(EvaluationStatus.MANUAL, `${reportText(freshness.message)} Rerun once SonarCloud has analysed the evaluated commit, or check SonarCloud by hand.${local}`, 'stale-analysis');
  }

  // Each fail rule is judged from its own evidence, whatever else could not be read.
  const security = maxDefined(snapshot.securityIssues.total, snapshot.vulnerabilities.total);
  const hotspots = snapshot.hotspotsToReview.total;
  const high = snapshot.highIssues.total;
  const duplication = snapshot.measures.duplicated_lines_density;
  if (security) base.violations.push(`${count(security, 'open security issue')}`);
  if (high) base.violations.push(`${count(high, 'open issue')} of high or blocker severity`);
  if (hotspots) base.violations.push(`${count(hotspots, 'security hotspot')} that nobody has reviewed`);
  if (duplication !== undefined && duplication > DUPLICATION_LIMIT) base.violations.push(`${percent(duplication)} duplicated lines, over the 3% limit`);
  if (base.violations.length) {
    const duplicationNote = duplication === undefined ? ' SonarCloud did not report duplication.'
      : duplication > DUPLICATION_LIMIT ? '' : ` Duplication is ${percent(duplication)}, under the 3% limit.`;
    return result(EvaluationStatus.FAIL, `SonarCloud reports ${list(base.violations)}.${duplicationNote}`);
  }

  const missing = [
    security === undefined || snapshot.securityIssues.total === undefined || snapshot.vulnerabilities.total === undefined ? 'open security issues' : undefined,
    high === undefined ? 'open high or blocker issues' : undefined,
    hotspots === undefined ? 'security hotspots to review' : undefined,
    duplication === undefined ? 'duplication' : undefined
  ].filter((item): item is string => Boolean(item));
  const suppressions = scan.suppressions.length;
  const scope = scan.scope.filter(item => item.affectsS011);
  const ignoredIssues = snapshot.ignoredIssues.total;
  const reviewedHotspots = snapshot.hotspotsReviewed.total;
  const customProfiles = snapshot.qualityProfiles?.filter(profile => !profile.isDefault) ?? [];
  const projectSettings = snapshot.settings.values.filter(item => item.key !== 'sonar.coverage.exclusions');
  const ignored = [
    suppressions ? `the module has ${count(suppressions, 'suppression')} of Sonar rules in its code` : undefined,
    scope.length ? `the repository or CI ${scope.length === 1 ? 'sets 1 Sonar analysis-scope setting' : `sets ${scope.length} Sonar analysis-scope settings`} (exclusions or source roots)` : undefined,
    projectSettings.length ? `SonarCloud's project settings set ${count(projectSettings.length, 'analysis-scope value')}` : undefined,
    ignoredIssues ? `${count(ignoredIssues, 'issue')} ${ignoredIssues === 1 ? 'is' : 'are'} accepted or marked false positive in SonarCloud` : undefined,
    reviewedHotspots ? `${count(reviewedHotspots, 'security hotspot')} ${reviewedHotspots === 1 ? 'was' : 'were'} reviewed as safe or fixed in SonarCloud but still found by analysis` : undefined,
    customProfiles.length ? `the project uses ${customProfiles.length === 1 ? 'a quality profile' : 'quality profiles'} other than the organization default (${customProfiles.map(item => `${reportText(item.name)} for ${reportText(item.language)}`).join(', ')})` : undefined
  ].filter((item): item is string => Boolean(item));
  const unknown = [
    ignoredIssues === undefined ? 'issues accepted or marked false positive' : undefined,
    reviewedHotspots === undefined ? 'security hotspots closed by review' : undefined,
    snapshot.qualityProfiles ? undefined : 'the project\'s quality profiles'
  ].filter((item): item is string => Boolean(item));
  base.manualReasons.push(...missing.map(item => `SonarCloud did not report ${item}.`), ...ignored.map(item => `${capitalize(item)}.`),
    ...unknown.map(item => `SonarCloud did not report ${item}.`));
  if (!scan.complete) base.manualReasons.push('Some repository files could not be scanned for suppressions.');
  if (!snapshot.settings.read) base.manualReasons.push(`${SETTINGS_UNREAD}.`);

  const found = [
    snapshot.securityIssues.total === 0 && snapshot.vulnerabilities.total === 0 ? 'no security issues' : undefined,
    high === 0 ? 'no high or blocker issues' : undefined,
    hotspots === 0 ? 'no security hotspots to review' : undefined,
    duplication !== undefined ? `${percent(duplication)} duplication` : undefined
  ].filter((item): item is string => Boolean(item));
  const foundText = found.length ? `SonarCloud found ${list(found)}` : 'SonarCloud reported no violations';
  if (!base.manualReasons.length) {
    return result(EvaluationStatus.PASS, `${foundText} on the evaluated commit, and nothing is ignored in the repository, its CI or SonarCloud's project settings.`);
  }
  const sentences = [ignored.length
    ? `${foundText}, but ${list(ignored)}. A reviewer must decide whether each is justified.`
    : `${foundText}${scan.complete && !unknown.length && !missing.length ? ', and nothing is ignored in the repository or CI' : ''}.`];
  if (missing.length) sentences.push(`SonarCloud did not report ${list(missing)}, so the tool cannot confirm there are none.`);
  if (unknown.length) sentences.push(`SonarCloud did not report ${list(unknown)}.`);
  if (!scan.complete) sentences.push('Some repository files could not be scanned for suppressions.');
  if (!ignored.length && !snapshot.settings.read) {
    sentences.push(`${SETTINGS_UNREAD}, so a reviewer must check them (Administration > Analysis Scope).`);
  }
  return result(EvaluationStatus.MANUAL, sentences.join(' '));
}

function localSentence(scan: S011SuppressionScan): string {
  const parts = [
    scan.suppressions.length ? count(scan.suppressions.length, 'suppression') + ' of Sonar rules' : undefined,
    scan.scope.some(item => item.affectsS011) ? count(scan.scope.filter(item => item.affectsS011).length, 'analysis-scope setting') : undefined
  ].filter(Boolean);
  return parts.length ? ` The repository has ${parts.join(' and ')}, listed below for a reviewer.` : '';
}

export function renderS011HumanDetails(analysis: S011Analysis, agentReview?: CriterionAgentReviewResult): string {
  const lines: string[] = [];
  const snapshot = analysis.snapshot;
  if (snapshot?.analysis) lines.push(...analysisLines(analysis), ...findingLines(analysis));
  else if (snapshot) lines.push('SonarCloud analysis:', `  - Project: ${reportText(snapshot.projectKey)}${snapshot.projectFound === false ? ', not found' : ''}`);
  lines.push(...ignoredLines(analysis));
  if (analysis.scan.eslintDisableCount) {
    lines.push(`eslint-disable comments: ${analysis.scan.eslintDisableCount} (ESLint, not Sonar, so not counted)`);
  }
  if (analysis.scan.diagnostics.length) {
    lines.push('Not scanned:', ...analysis.scan.diagnostics.map(item => `  - ${item.path ? `${reportPath(item.path)}: ` : ''}${reportText(item.message)}`));
  }
  const action = whatToDo(analysis);
  if (action) lines.push(`What to do: ${action}`);
  if (analysis.remoteEvidence.length) lines.push('Sources:', ...analysis.remoteEvidence.map(sourceLine));
  if (agentReview?.available) {
    lines.push(...renderAgentReviewLines(agentReview, s011AgentReviewNames(analysis)), '  - The automated result is unchanged.');
  } else if (analysis.agentReviewUnavailableReason) {
    lines.push('Agent review:', `  - Not applied: ${reportText(analysis.agentReviewUnavailableReason)}`);
  }
  return lines.join('\n');
}

function analysisLines(analysis: S011Analysis): string[] {
  const snapshot = analysis.snapshot!;
  const run = snapshot.analysis!;
  const commit = run.revision ? `commit ${reportText(run.revision.slice(0, 7))}` : 'no commit recorded';
  const evaluated = !analysis.repositoryCommit ? ' (the evaluated commit is not known)'
    : run.revision === analysis.repositoryCommit ? ' (the commit evaluated here)'
      : ` (the evaluated commit is ${reportText(analysis.repositoryCommit.slice(0, 7))})`;
  const lines = [
    'SonarCloud analysis:',
    `  - Project: ${reportText(snapshot.projectKey)}, branch ${reportText(snapshot.branch ?? '')}`,
    `  - Analysis: ${reportText(run.date.slice(0, 10))}, ${commit}${evaluated}`
  ];
  if (snapshot.requestedBranchNotAnalysed) {
    lines.push(`  - SonarCloud has no analysis of branch ${reportText(snapshot.requestedBranchNotAnalysed)}, so the main branch was read`);
  }
  if (snapshot.recheck?.key && snapshot.recheck.key !== run.key) {
    lines.push(`  - SonarCloud analysed again while the tool was reading it (${reportText((snapshot.recheck.date ?? '').slice(0, 10))}, ${reportText((snapshot.recheck.revision ?? '').slice(0, 7))})`);
  }
  return lines;
}

function findingLines(analysis: S011Analysis): string[] {
  const snapshot = analysis.snapshot!;
  const rules = analysis.rules;
  const lines: string[] = [];
  if (analysis.gate) {
    lines.push('Findings: not judged, because the analysis is not of the evaluated commit or could not be read completely');
    return lines;
  }
  const security = maxDefined(snapshot.securityIssues.total, snapshot.vulnerabilities.total);
  lines.push('Security:', `  - Open security issues: ${countText(snapshot.securityIssues.total === undefined || snapshot.vulnerabilities.total === undefined ? undefined : security)}`);
  for (const issue of snapshot.securityIssues.examples.slice(0, 5)) lines.push(`    - ${issueRow(issue, rules)}`);
  lines.push(`  - Security hotspots to review: ${hotspotText(snapshot.hotspotsToReview)}`);
  const high = snapshot.highIssues;
  if (high.total === undefined) lines.push(`High or blocker issues: not reported (${reportText(high.problem ?? 'unavailable')})`);
  else if (!high.total) lines.push('High or blocker issues: none open');
  else {
    const partial = high.listed !== undefined && high.listed < high.total ? `, split from the first ${high.listed}` : '';
    lines.push(`High or blocker issues: ${high.total} open (${high.mainCount} in main code, ${high.testCount} in test code${partial})`);
    for (const rule of (high.rules ?? []).slice(0, MAX_RULE_ROWS)) lines.push(`  - ${ruleLabel(rule.rule, rules)}: ${rule.count}`);
    if ((high.rules?.length ?? 0) > MAX_RULE_ROWS) lines.push(`  - ... ${high.rules!.length - MAX_RULE_ROWS} more`);
  }
  const duplication = snapshot.measures.duplicated_lines_density;
  lines.push(`Duplication: ${duplication === undefined ? 'not reported' : `${percent(duplication)} of lines`} (limit 3%)`);
  return lines;
}

function ignoredLines(analysis: S011Analysis): string[] {
  const { scan, rules, snapshot } = analysis;
  const rows: string[] = [];
  const byRule = new Map<string, S011Suppression[]>();
  for (const item of scan.suppressions) {
    const key = item.kind === 'annotation' ? item.rule! : item.kind;
    byRule.set(key, [...(byRule.get(key) ?? []), item]);
  }
  for (const [key, items] of [...byRule].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))) {
    const example = items.find(item => !item.comment) ?? items[0];
    const where = `${reportPath(example.path)}:${example.line}`;
    if (key === 'nosonar') {
      rows.push(`  - ${count(items.length, 'NOSONAR comment')}, which FOLIO guidance says not to use, for example ${where}`);
      continue;
    }
    if (key === 'all') {
      rows.push(`  - ${count(items.length, 'suppression')} of all rules (@SuppressWarnings("all")), which FOLIO guidance says not to use, for example ${where}`);
      continue;
    }
    const uncommented = items.filter(item => !item.comment).length;
    const flags = [...new Set(items.flatMap(item => suppressionFlags(item, rules)).filter(flag => flag !== 'no comment'))];
    const comment = uncommented === items.length ? (items.length === 1 ? ' with no comment explaining why' : ', none with a comment explaining why')
      : uncommented ? `, ${uncommented} with no comment explaining why` : '';
    const label = items[0].appliesTo ? `"${reportText(key)}" (a javac warning name that also hides Sonar rule${items[0].appliesTo.length === 1 ? '' : 's'} ${items[0].appliesTo.join(', ')})` : ruleLabel(key, rules);
    rows.push(`  - ${count(items.length, 'suppression')} of ${label}${comment}${flags.length ? ` [${flags.join(', ')}]` : ''}, for example ${where}`);
  }
  if (rows.length > MAX_ROWS) rows.splice(MAX_ROWS, rows.length - MAX_ROWS, `  - ... ${rows.length - MAX_ROWS} more`);
  for (const setting of scan.scope) rows.push(`  - ${scopeRow(setting)}`);
  if (snapshot?.analysis && !analysis.gate) {
    const ignored = snapshot.ignoredIssues;
    rows.push(`  - Issues accepted or marked false positive in SonarCloud: ${countText(ignored.total)}`);
    for (const issue of ignored.examples.slice(0, 5)) rows.push(`    - ${issueRow(issue, rules)}`);
    const reviewed = snapshot.hotspotsReviewed.total;
    rows.push(`  - Security hotspots closed by review in SonarCloud (safe, or fixed but still found): ${countText(reviewed)}`);
    const custom = snapshot.qualityProfiles?.filter(profile => !profile.isDefault);
    rows.push(`  - Quality profiles: ${!snapshot.qualityProfiles ? 'not reported'
      : custom!.length ? custom!.map(item => `${reportText(item.name)} for ${reportText(item.language)} is not the organization default`).join('; ')
        : 'the organization defaults for every language'}`);
  }
  if (snapshot?.analysis) {
    if (snapshot.settings.read) {
      rows.push(`  - SonarCloud project settings: ${snapshot.settings.values.length
        ? snapshot.settings.values.map(item => `${reportText(item.key)} = ${reportText(item.value)} (${reportText(item.origin.toLowerCase())})`).join('; ')
        : 'no analysis-scope values set'}`);
    } else {
      rows.push(`  - ${SETTINGS_UNREAD}.`);
    }
  }
  if (!rows.length) return ['Ignored rules: none found in the repository or CI'];
  return ['Ignored rules (a reviewer must decide whether each is justified):', ...rows];
}

const SCOPE_LABELS: Array<[RegExp, string]> = [
  [/^sonar\.exclusions$/, 'Files excluded from analysis'],
  [/^sonar\.test\.exclusions$/, 'Test files excluded from analysis'],
  [/^sonar\.cpd\.exclusions$/, 'Files excluded from duplication checks'],
  [/^sonar\.coverage\.exclusions$/, 'Files excluded from coverage only (not counted for S011)'],
  [/^sonar\.sources$/, 'Source folders analysed'],
  [/^sonar\.(test\.)?inclusions$/, 'Files analysis is limited to'],
  [/^sonar\.issue\.ignore\./, 'Issues ignored by rule or file']
];
const SCOPE_SOURCES: Record<S011ScopeSetting['source'], string> = {
  pom: '', gradle: '', properties: '', 'workflow-input': 'CI input ', 'command-line': 'command line '
};

// Not "key: value" or "path:line" at the start, so the HTML report keeps it one readable row.
function scopeRow(setting: S011ScopeSetting): string {
  const label = SCOPE_LABELS.find(([pattern]) => pattern.test(setting.key))?.[1] ?? 'Analysis scope';
  const note = setting.note ? `, ${reportText(setting.note)}` : '';
  return `${label} (${reportText(setting.key)}, ${SCOPE_SOURCES[setting.source]}${reportPath(setting.path)}:${setting.line}${note}): ${reportText(setting.value)}`;
}

function issueRow(issue: { rule: string; path?: string; line?: number; severity?: string; message?: string }, rules: Record<string, SonarRule>): string {
  const where = issue.path ? ` at ${reportPath(issue.path)}${issue.line ? `:${issue.line}` : ''}` : '';
  return `${ruleLabel(issue.rule, rules)}${issue.severity ? ` (${reportText(issue.severity.toLowerCase())})` : ''}${where}`;
}

function ruleLabel(rule: string, rules: Record<string, SonarRule>): string {
  const known = Object.prototype.hasOwnProperty.call(rules, rule) ? rules[rule] : undefined;
  return known ? `${reportText(rule)} "${reportText(known.name)}"` : reportText(rule);
}

function hotspotText(query: SonarHotspotQuery): string {
  if (query.total === undefined) return `not reported (${reportText(query.problem ?? 'unavailable')})`;
  if (!query.total) return 'none';
  const of = query.listed !== undefined && query.listed < query.total ? `; of the first ${query.listed}: ` : ' (';
  const groups = query.groups.map(group => `${group.count} ${reportText(group.probability.toLowerCase())} probability: ${reportText(group.category.replace(/-/g, ' '))}`).join(', ');
  return groups ? `${query.total}${of}${groups}${of === ' (' ? ')' : ''}` : String(query.total);
}

function whatToDo(analysis: S011Analysis): string | undefined {
  if (analysis.status === EvaluationStatus.PASS) return undefined;
  const link = analysis.projectKey ? ` (https://sonarcloud.io/project/overview?id=${encodeURIComponent(analysis.projectKey)})` : '';
  const suppressions = analysis.scan.suppressions.length || analysis.scan.scope.some(item => item.affectsS011)
    ? ' For each suppression, add a comment naming the rule and explaining why it does not apply, or remove it; justify or remove each exclusion.' : '';
  switch (analysis.gate) {
    case 'remote-lookups-off': return `${RERUN_HINT} so the tool can read the module's SonarCloud analysis, or check it in SonarCloud by hand.${suppressions}`;
    case 'no-project': return `Check by hand that the module has no security issues, no high or blocker issues and no more than 3% duplication, for example by running SonarCloud on it.${suppressions}`;
    case 'stale-analysis': return `Rerun once SonarCloud has analysed the evaluated commit, or review the findings in SonarCloud${link} by hand.${suppressions}`;
    case 'sonarcloud-unavailable': return `Rerun later, or review the module in SonarCloud${link} by hand.${suppressions}`;
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    return `Fix or review the open security issues, high and blocker issues and security hotspots, and reduce duplication to 3% or less, in SonarCloud${link}.${suppressions}`;
  }
  return `Decide whether each ignored rule and exclusion above is justified${analysis.snapshot?.settings.read ? '' : ', and check the project\'s Administration > Analysis Scope settings in SonarCloud'}${link}.${suppressions}`;
}

/** Names for the agent review's group IDs, matching the report's own wording. */
export function s011AgentReviewNames(analysis: S011Analysis): Record<string, string> {
  return Object.fromEntries(analysis.reviewGroups.map(group => {
    const file = reportPath(group.path);
    const name = group.appliesTo ? `@SuppressWarnings("${group.rule}") in ${file}`
      : group.kind === 'suppression' ? `${group.rule} suppressions in ${file}`
      : group.kind === 'nosonar' ? `NOSONAR comments in ${file}`
        : group.kind === 'all' ? `@SuppressWarnings("all") in ${file}`
          : `Sonar analysis scope in ${file}`;
    return [group.id, name];
  }));
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length ? Math.max(...defined) : undefined;
}


function countText(value: number | undefined): string {
  return value === undefined ? 'not reported' : value ? String(value) : 'none';
}

function percent(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(1) : String(value)}%`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function list(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
