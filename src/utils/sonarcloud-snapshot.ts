import * as path from 'path';
import {
  EvaluationRun,
  RemoteEvidenceRecord,
  RemoteJsonResult,
  RemoteLookups,
  SonarCloudSnapshot,
  SonarCount,
  SonarFreshness,
  SonarHighIssueQuery,
  SonarHotspotQuery,
  SonarIssueExample,
  SonarIssueQuery,
  SonarProjectSettings,
  SonarRule
} from '../types';
import { isValidRemoteName } from './s014-application-assignment';

// Reads one SonarCloud project's latest analysis through the remote-evidence transport. Every count comes
// from SonarCloud's own totals (paging.total or a facet), so the 10,000-result cap on listings only shortens
// the examples. Anything SonarCloud did not return is recorded as unavailable with a reason, never as 0.

const API = 'https://sonarcloud.io/api';
const ORGANIZATION = 'folio-org';
/** One fixed list for S011 and S013: an unknown metric key would fail the whole request. */
export const SONAR_METRICS = [
  'coverage', 'line_coverage', 'branch_coverage', 'lines_to_cover', 'uncovered_lines', 'conditions_to_cover',
  'uncovered_conditions', 'duplicated_lines_density'
] as const;
const OPEN = 'OPEN,CONFIRMED';
const HIGH_PAGE = 500;
const PAGE = 100;
const MAX_EXAMPLES = 20;
const SEVERITY_RANK: Record<string, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, BLOCKER: 4 };
/** Analysis-scope settings S011 reads from SonarCloud's project administration. */
export const SONAR_SCOPE_SETTING_KEYS = [
  'sonar.sources', 'sonar.inclusions', 'sonar.exclusions', 'sonar.test.exclusions', 'sonar.coverage.exclusions',
  'sonar.cpd.exclusions', 'sonar.issue.ignore.multicriteria', 'sonar.issue.ignore.allfile', 'sonar.issue.ignore.block'
] as const;
/** A Sonar rule key as SonarCloud and FOLIO code write it, for example java:S2077. */
export const SONAR_RULE_KEY = /^[a-z][a-z0-9_-]{0,39}:[A-Za-z0-9_-]{1,60}$/;

/** FOLIO's SonarCloud key for a repository, or undefined when the name is not one a lookup may use. */
export function sonarProjectKey(repositoryName: string | undefined): string | undefined {
  return repositoryName && isValidRemoteName(repositoryName) ? `org.folio:${repositoryName}` : undefined;
}

/**
 * The run's SonarCloud snapshot, read once and shared by S011 and S013. Undefined when remote lookups are off;
 * a snapshot with `problem` when the repository name cannot be a SonarCloud key.
 */
export async function getSonarCloudSnapshot(run: EvaluationRun, repoPath: string): Promise<SonarCloudSnapshot | undefined> {
  const lookups = run.remoteLookups;
  if (!lookups) return undefined;
  return run.getOrCreateArtifact('sonarCloudSnapshot', async () => {
    const name = run.repositoryName ?? path.basename(repoPath);
    const projectKey = sonarProjectKey(name);
    if (!projectKey) {
      return { ...emptySnapshot(`org.folio:${name.slice(0, 100)}`, []), problem: 'The repository name is not one a SonarCloud project key can be built from.' };
    }
    return collectSonarCloudSnapshot(lookups, projectKey, run.requestedBranch);
  });
}

/**
 * Whether the snapshot describes the evaluated commit. Stale data can neither pass nor fail: a newer commit may
 * already have fixed or introduced findings. An unknown commit (a direct evaluateCriterion call) is stale too.
 */
export function sonarSnapshotFreshness(snapshot: SonarCloudSnapshot, repositoryCommit: string | undefined): SonarFreshness {
  const analysis = snapshot.analysis;
  if (!analysis) return { fresh: false, reason: 'no-analysis', message: snapshot.problem ?? 'SonarCloud has no analysis to compare.' };
  const analysed = analysis.revision ? `commit ${analysis.revision.slice(0, 7)}` : 'an unrecorded commit';
  const on = `SonarCloud's latest analysis of branch ${snapshot.branch} (${analysis.date.slice(0, 10)}) is of ${analysed}`;
  if (!repositoryCommit) return { fresh: false, reason: 'unknown-commit', message: `${on}, and the evaluated commit is not known, so the tool cannot tell whether its findings apply.` };
  if (!analysis.revision) return { fresh: false, reason: 'no-revision', message: `${on}, so the tool cannot tell whether its findings apply to the evaluated commit ${repositoryCommit.slice(0, 7)}.` };
  if (analysis.revision !== repositoryCommit) {
    return { fresh: false, reason: 'different-commit', message: `${on}, not the evaluated commit ${repositoryCommit.slice(0, 7)}, so its findings may not apply.` };
  }
  const recheck = snapshot.recheck;
  if (!recheck || recheck.problem || !recheck.key) {
    return { fresh: false, reason: 'recheck-failed', message: `The tool could not confirm that SonarCloud did not re-analyse the project while it was being read${recheck?.problem ? `: ${recheck.problem}` : '.'}` };
  }
  if (recheck.key !== analysis.key) {
    return { fresh: false, reason: 'reanalysed', message: `SonarCloud analysed the project again while the tool was reading it (${analysis.date.slice(0, 10)} and ${(recheck.date ?? '').slice(0, 10)}), so its answers may mix two analyses.` };
  }
  return { fresh: true };
}

/** Test code by path, as the S011 report splits it; both halves count. */
export function isSonarTestPath(path: string): boolean {
  return /(^|\/)(src\/test|test|tests|__tests__)\//.test(path) || /\.(test|spec)\./.test(path) || /(Test|IT)\.java$/.test(path);
}

function emptySnapshot(projectKey: string, remoteEvidence: RemoteEvidenceRecord[]): SonarCloudSnapshot {
  const notRead = 'Not read.';
  return {
    projectKey,
    measures: {},
    securityIssues: { problem: notRead, examples: [] },
    vulnerabilities: { problem: notRead },
    highIssues: { problem: notRead, examples: [] },
    ignoredIssues: { problem: notRead, examples: [] },
    hotspotsToReview: { problem: notRead, groups: [], examples: [] },
    hotspotsSafe: { problem: notRead, groups: [], examples: [] },
    settings: { read: false, problem: notRead, values: [] },
    remoteEvidence
  };
}

export async function collectSonarCloudSnapshot(
  lookups: RemoteLookups,
  projectKey: string,
  requestedBranch?: string
): Promise<SonarCloudSnapshot> {
  const remoteEvidence: RemoteEvidenceRecord[] = [];
  const snapshot = emptySnapshot(projectKey, remoteEvidence);
  const get = (endpoint: string, params: Record<string, string>) =>
    lookups.getJson(`${API}/${endpoint}?${new URLSearchParams(params)}`);
  const record = (result: RemoteJsonResult) => {
    remoteEvidence.push(result.record);
    return result;
  };

  const component = record(await get('components/show', { component: projectKey }));
  if (!component.ok) {
    if (component.status === 404) snapshot.projectFound = false;
    else snapshot.problem = `SonarCloud could not be read: ${component.record.error}`;
    return snapshot;
  }
  if (objectAt(component.json, 'component')?.key !== projectKey) {
    snapshot.problem = 'SonarCloud answered with a different project.';
    return snapshot;
  }
  snapshot.projectFound = true;

  const branches = record(await get('project_branches/list', { project: projectKey }));
  const branchList = branches.ok ? arrayAt(branches.json, 'branches') : undefined;
  if (!branchList) {
    snapshot.problem = `SonarCloud's branch list could not be read${branches.ok ? '.' : `: ${branches.record.error}`}`;
    return snapshot;
  }
  const names = branchList.flatMap(item => typeof item?.name === 'string' ? [{ name: item.name as string, main: item.isMain === true }] : []);
  const main = names.find(item => item.main);
  const requested = requestedBranch ? names.find(item => item.name === requestedBranch) : undefined;
  const branch = requested ?? main;
  if (!branch) {
    snapshot.problem = 'SonarCloud lists no main branch for the project.';
    return snapshot;
  }
  snapshot.branch = branch.name;
  snapshot.branchIsMain = branch.main;
  if (requestedBranch && !requested) snapshot.requestedBranchNotAnalysed = requestedBranch;
  const onBranch = (params: Record<string, string>) => ({ ...params, branch: branch.name });

  const latestAnalysis = async () => {
    const result = record(await get('project_analyses/search', onBranch({ project: projectKey, ps: '1' })));
    if (!result.ok) return { problem: `SonarCloud's analyses could not be read: ${result.record.error}` };
    const analysis = arrayAt(result.json, 'analyses')?.[0];
    if (!analysis) return { problem: `SonarCloud has no analysis of branch ${branch.name}.` };
    if (typeof analysis.key !== 'string' || typeof analysis.date !== 'string') return { problem: 'SonarCloud\'s latest analysis has no key or date.' };
    return { key: analysis.key, date: analysis.date, revision: typeof analysis.revision === 'string' ? analysis.revision : undefined };
  };
  const analysis = await latestAnalysis();
  if ('problem' in analysis) {
    snapshot.problem = analysis.problem;
    return snapshot;
  }
  snapshot.analysis = analysis;

  const issues = (params: Record<string, string>) => get('issues/search', onBranch({ componentKeys: projectKey, ...params }));
  const hotspots = (status: string, resolution?: string) => get('hotspots/search', onBranch({
    projectKey, status, ...(resolution ? { resolution } : {}), ps: String(PAGE)
  }));
  // Started together; recorded in this fixed order, not the order they finish.
  const [measures, security, vulnerabilities, high, ignored, toReview, safe, profiles, navigation] = await Promise.all([
    get('measures/component', onBranch({ component: projectKey, metricKeys: SONAR_METRICS.join(',') })),
    issues({ issueStatuses: OPEN, impactSoftwareQualities: 'SECURITY', ps: String(PAGE) }),
    issues({ issueStatuses: OPEN, types: 'VULNERABILITY', ps: '1' }),
    issues({ issueStatuses: OPEN, impactSeverities: 'HIGH,BLOCKER', facets: 'rules', ps: String(HIGH_PAGE) }),
    issues({ issueStatuses: 'ACCEPTED,FALSE_POSITIVE', facets: 'issueStatuses', ps: String(PAGE) }),
    hotspots('TO_REVIEW'),
    // SonarCloud's only other resolution is FIXED; it has no ACKNOWLEDGED.
    hotspots('REVIEWED', 'SAFE'),
    get('qualityprofiles/search', { project: projectKey, organization: ORGANIZATION }),
    get('navigation/component', { component: projectKey })
  ]);
  [measures, security, vulnerabilities, high, ignored, toReview, safe, profiles, navigation].forEach(record);

  readMeasures(snapshot, measures);
  snapshot.securityIssues = readIssues(security, projectKey);
  snapshot.vulnerabilities = readCount(vulnerabilities);
  snapshot.highIssues = readHighIssues(high, projectKey);
  snapshot.ignoredIssues = { ...readIssues(ignored, projectKey), statuses: facetCounts(ignored, 'issueStatuses') };
  snapshot.hotspotsToReview = readHotspots(toReview, projectKey);
  snapshot.hotspotsSafe = readHotspots(safe, projectKey);
  readProfiles(snapshot, profiles);
  snapshot.settings = await readSettings(navigation, projectKey, get, record);

  // A different latest analysis means SonarCloud re-analysed while the answers above were being read.
  const recheck = await latestAnalysis();
  snapshot.recheck = recheck;
  return snapshot;
}

function readMeasures(snapshot: SonarCloudSnapshot, result: RemoteJsonResult): void {
  if (!result.ok) {
    snapshot.measuresProblem = `SonarCloud's measures could not be read: ${result.record.error}`;
    return;
  }
  const measures = arrayAt(objectAt(result.json, 'component'), 'measures');
  if (!measures) {
    snapshot.measuresProblem = 'SonarCloud\'s measures response has no measures list.';
    return;
  }
  for (const measure of measures) {
    const value = typeof measure?.value === 'string' && /^\d+(\.\d+)?$/.test(measure.value) ? Number(measure.value) : undefined;
    if (typeof measure?.metric === 'string' && value !== undefined && (SONAR_METRICS as readonly string[]).includes(measure.metric)) {
      snapshot.measures[measure.metric] = value;
    }
  }
}

function readCount(result: RemoteJsonResult): SonarCount {
  if (!result.ok) return { problem: `SonarCloud could not be read: ${result.record.error}` };
  const total = objectAt(result.json, 'paging')?.total;
  return typeof total === 'number' && Number.isInteger(total) && total >= 0
    ? { total }
    : { problem: 'SonarCloud did not report a count.' };
}

function readIssues(result: RemoteJsonResult, projectKey: string): SonarIssueQuery {
  const count = readCount(result);
  const listed = result.ok ? arrayAt(result.json, 'issues') : undefined;
  if (count.total === undefined || !listed) return { ...count, problem: count.problem ?? 'SonarCloud did not list the issues.', total: undefined, examples: [] };
  const examples = listed.map(issue => issueExample(issue, projectKey)).filter((item): item is SonarIssueExample => Boolean(item));
  return { total: count.total, examples, listed: listed.length };
}

function readHighIssues(result: RemoteJsonResult, projectKey: string): SonarHighIssueQuery {
  const issues = readIssues(result, projectKey);
  if (issues.total === undefined) return issues;
  const rules = facetCounts(result, 'rules');
  const testCount = issues.examples.filter(item => item.test).length;
  return {
    total: issues.total,
    listed: issues.listed,
    rules: rules ? Object.entries(rules).map(([rule, count]) => ({ rule, count })).sort((left, right) => right.count - left.count || left.rule.localeCompare(right.rule)) : undefined,
    mainCount: issues.examples.length - testCount,
    testCount,
    examples: issues.examples.slice(0, MAX_EXAMPLES)
  };
}

function readHotspots(result: RemoteJsonResult, projectKey: string): SonarHotspotQuery {
  const count = readCount(result);
  const listed = result.ok ? arrayAt(result.json, 'hotspots') : undefined;
  if (count.total === undefined || !listed) return { problem: count.problem ?? 'SonarCloud did not list the hotspots.', groups: [], examples: [] };
  const groups = new Map<string, { probability: string; category: string; count: number }>();
  const examples: SonarHotspotQuery['examples'] = [];
  for (const hotspot of listed) {
    if (!hotspot) continue;
    const probability = typeof hotspot.vulnerabilityProbability === 'string' ? hotspot.vulnerabilityProbability : 'UNKNOWN';
    const category = typeof hotspot.securityCategory === 'string' ? hotspot.securityCategory : 'unknown';
    const key = `${probability}\u0000${category}`;
    const group = groups.get(key) ?? { probability, category, count: 0 };
    group.count++;
    groups.set(key, group);
    if (examples.length < MAX_EXAMPLES) {
      examples.push({
        rule: typeof hotspot.ruleKey === 'string' ? hotspot.ruleKey : undefined,
        path: componentPath(hotspot.component, projectKey),
        line: typeof hotspot.line === 'number' ? hotspot.line : undefined,
        probability, category
      });
    }
  }
  return {
    total: count.total,
    listed: listed.length,
    groups: [...groups.values()].sort((left, right) => (SEVERITY_RANK[right.probability] ?? -1) - (SEVERITY_RANK[left.probability] ?? -1) || right.count - left.count),
    examples
  };
}

function readProfiles(snapshot: SonarCloudSnapshot, result: RemoteJsonResult): void {
  const profiles = result.ok ? arrayAt(result.json, 'profiles') : undefined;
  if (!profiles) {
    snapshot.qualityProfilesProblem = `SonarCloud's quality profiles for the project could not be read${result.ok ? '.' : `: ${result.record.error}`}`;
    return;
  }
  const parsed = profiles.map(profile => typeof profile?.language === 'string' && typeof profile.name === 'string' && typeof profile.isDefault === 'boolean'
    ? { language: profile.language, name: profile.name, isDefault: profile.isDefault } : undefined);
  if (parsed.some(item => !item)) {
    snapshot.qualityProfilesProblem = 'SonarCloud listed a quality profile without a language, name or default flag.';
    return;
  }
  snapshot.qualityProfiles = parsed as NonNullable<SonarCloudSnapshot['qualityProfiles']>;
}

// SonarCloud answers settings/values anonymously with an empty list, which cannot be told apart from
// "nothing set". The settings count as read only when navigation/component says the caller (SONAR_TOKEN)
// may open the project's settings, which SonarQube grants to project administrators only.
async function readSettings(
  navigation: RemoteJsonResult,
  projectKey: string,
  get: (endpoint: string, params: Record<string, string>) => Promise<RemoteJsonResult>,
  record: (result: RemoteJsonResult) => RemoteJsonResult
): Promise<SonarProjectSettings> {
  const unread = (problem: string): SonarProjectSettings => ({ read: false, problem, values: [] });
  if (!navigation.ok) return unread(`SonarCloud could not be asked whether SONAR_TOKEN may administer the project: ${navigation.record.error}`);
  if (objectAt(navigation.json, 'configuration')?.showSettings !== true) {
    return unread('SonarCloud did not confirm that SONAR_TOKEN may administer this project (no token was supplied, or it lacks admin rights).');
  }
  const result = record(await get('settings/values', { component: projectKey, keys: SONAR_SCOPE_SETTING_KEYS.join(',') }));
  const settings = result.ok ? arrayAt(result.json, 'settings') : undefined;
  if (!settings) return unread(`SonarCloud's project settings could not be read${result.ok ? '.' : `: ${result.record.error}`}`);
  const values: SonarProjectSettings['values'] = [];
  for (const setting of settings) {
    if (typeof setting?.key !== 'string' || !(SONAR_SCOPE_SETTING_KEYS as readonly string[]).includes(setting.key)) continue;
    // Built-in defaults are not the module's choice; organization and project values are.
    const origin = setting.inherited === true ? (typeof setting.parentOrigin === 'string' ? setting.parentOrigin : 'UNKNOWN') : 'PROJECT';
    if (origin === 'INSTANCE') continue;
    const value = settingValue(setting);
    if (value === undefined) return unread(`SonarCloud returned a value for ${setting.key} the tool could not read.`);
    if (value) values.push({ key: setting.key, value, origin });
  }
  return { read: true, values };
}

function settingValue(setting: Record<string, unknown>): string | undefined {
  if (typeof setting.value === 'string') return setting.value.trim();
  if (Array.isArray(setting.values)) return setting.values.every(item => typeof item === 'string') ? setting.values.join(',') : undefined;
  if (Array.isArray(setting.fieldValues)) {
    const rows = setting.fieldValues.map(row => row && typeof row === 'object' && !Array.isArray(row)
      && Object.values(row).every(item => typeof item === 'string')
      ? Object.entries(row as Record<string, string>).map(([field, value]) => `${field}=${value}`).join(', ') : undefined);
    return rows.every(row => row !== undefined) ? rows.join('; ') : undefined;
  }
  return '';
}

/** Rule names for the report. Enrichment only: a failure leaves rule keys without names. */
export async function lookupSonarRules(lookups: RemoteLookups, keys: string[]): Promise<{ rules: Record<string, SonarRule>; record?: RemoteEvidenceRecord }> {
  // squid: is the old prefix of java: rules; SonarCloud only answers for the current key.
  const lookupKey = (key: string) => key.replace(/^squid:/, 'java:');
  const asked = [...new Set(keys.filter(key => SONAR_RULE_KEY.test(key)))].sort().slice(0, PAGE);
  const wanted = [...new Set(asked.map(lookupKey))];
  if (!wanted.length) return { rules: {} };
  const params = new URLSearchParams({ organization: ORGANIZATION, rule_keys: wanted.join(','), f: 'name', ps: String(PAGE) });
  const result = await lookups.getJson(`${API}/rules/search?${params}`);
  const rules: Record<string, SonarRule> = {};
  for (const rule of (result.ok ? arrayAt(result.json, 'rules') : undefined) ?? []) {
    if (typeof rule?.key !== 'string' || typeof rule.name !== 'string' || !wanted.includes(rule.key)) continue;
    const impacts = Array.isArray(rule.impacts) ? rule.impacts : [];
    const found: SonarRule = {
      name: rule.name,
      security: rule.type === 'VULNERABILITY' || rule.type === 'SECURITY_HOTSPOT'
        || impacts.some(impact => (impact as { softwareQuality?: unknown } | undefined)?.softwareQuality === 'SECURITY')
    };
    for (const key of asked) if (lookupKey(key) === rule.key) rules[key] = found;
  }
  return { rules, record: result.record };
}

function issueExample(issue: Record<string, unknown> | undefined, projectKey: string): SonarIssueExample | undefined {
  if (!issue || typeof issue.rule !== 'string') return undefined;
  const path = componentPath(issue.component, projectKey);
  const impacts = Array.isArray(issue.impacts) ? issue.impacts as Array<{ severity?: unknown }> : [];
  const severity = impacts.map(impact => impact?.severity).filter((value): value is string => typeof value === 'string' && value in SEVERITY_RANK)
    .sort((left, right) => SEVERITY_RANK[right] - SEVERITY_RANK[left])[0];
  return {
    rule: issue.rule,
    path,
    line: typeof issue.line === 'number' ? issue.line : undefined,
    severity,
    message: typeof issue.message === 'string' ? issue.message.slice(0, 300) : undefined,
    test: path ? isSonarTestPath(path) : false
  };
}

function componentPath(component: unknown, projectKey: string): string | undefined {
  return typeof component === 'string' && component.startsWith(`${projectKey}:`) ? component.slice(projectKey.length + 1) : undefined;
}

function facetCounts(result: RemoteJsonResult, property: string): Record<string, number> | undefined {
  const facet = (result.ok ? arrayAt(result.json, 'facets') : undefined)?.find(item => item?.property === property);
  const values = Array.isArray(facet?.values) ? facet!.values as Array<{ val?: unknown; count?: unknown }> : undefined;
  if (!values) return undefined;
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (typeof value?.val === 'string' && typeof value.count === 'number') counts[value.val] = value.count;
  }
  return counts;
}

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  return item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
}

function arrayAt(value: unknown, key: string): Array<Record<string, unknown> | undefined> | undefined {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(item)
    ? item.map(entry => entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined)
    : undefined;
}
