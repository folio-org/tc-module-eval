import YAML, { isMap, isScalar, isSeq, LineCounter, Node as YamlNode } from 'yaml';
import {
  CriterionAgentReviewResult,
  EvaluationStatus,
  F002Analysis,
  F002CypressVersion,
  F002Evidence,
  F002Framework,
  F002FrameworkId,
  F002Support,
  FolioSharedWorkflowTable,
  FolioSharedWorkflowTableLoadResult,
  FrontendChecklistItem,
  S007PolicyLoadResult,
  S007TechnologyPolicyEntry
} from '../types';
import { readCommittedSource } from './committed-source';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { FRONTEND_BROWSE_SCOPE, FrontendChecklistItemDraft, numberObligations } from './frontend-agent-review';
import { packageDependencyEntries, parsePackageJson, parseYarnLockfile, yarnLockVersion } from './manifest-parsers';
import { count, listText, overflowLine, reportPath, reportText, unique } from './report-text';
import { compareObservationToConstraint } from './s007-evaluator';
import { findPolicyEntry, loadS007Policy } from './s007-policy';
import { loadFolioSharedWorkflows } from './folio-shared-workflows';
import { isRecord } from './type-guards';

interface FrameworkRule {
  displayName: string;
  support: F002Support;
  dependency?: RegExp;
  /** A file at the repository root. */
  configuration?: RegExp;
  /** A directory at the repository root, matched against the paths of the files in it. */
  directory?: RegExp;
  /** A command in a package.json script, a workflow step or the Jenkinsfile. */
  command?: RegExp;
  action?: RegExp;
}

// A tool run as a command: at the start of the command, after a shell separator, or after a package runner.
const runCommand = (tool: string) => new RegExp(String.raw`(?:^\s*|[;&|(]\s*|\b(?:npx|bunx|exec|yarn|pnpm|run)\s+(?:-[\w-]+\s+)*)${tool}(?=\s|$)`);

// In report order: the supported framework, the unsupported ones, then browser tests of unclear kind.
const FRAMEWORKS: Record<F002FrameworkId, FrameworkRule> = {
  cypress: {
    displayName: 'Cypress', support: 'supported', dependency: /^cypress$/,
    configuration: /^cypress\.(?:config\.[cm]?[jt]s|json)$/, directory: /^cypress\//,
    command: /\bcypress\s+(?:run|open)\b/, action: /^cypress-io\/github-action@/
  },
  playwright: {
    displayName: 'Playwright', support: 'unsupported', dependency: /^@playwright\/test$/,
    configuration: /^playwright\.config\.[cm]?[jt]s$/, command: /\bplaywright\s+test\b/
  },
  webdriverio: {
    displayName: 'WebdriverIO', support: 'unsupported', dependency: /^(?:webdriverio|@wdio\/cli)$/,
    configuration: /^wdio(?:\.[\w-]+)*\.conf\.[cm]?[jt]s$/, command: runCommand('wdio')
  },
  nightwatch: {
    displayName: 'Nightwatch', support: 'unsupported', dependency: /^nightwatch$/,
    configuration: /^nightwatch(?:\.conf\.[cm]?[jt]s|\.json)$/, command: runCommand('nightwatch')
  },
  testcafe: {
    displayName: 'TestCafe', support: 'unsupported', dependency: /^testcafe$/,
    configuration: /^\.testcaferc(?:\.[cm]?js|\.json)?$/, command: runCommand('testcafe')
  },
  // puppeteer alone also supplies Chrome to Karma; jest-puppeteer is what drives test suites with it.
  puppeteer: {
    displayName: 'Puppeteer (jest-puppeteer)', support: 'unsupported', dependency: /^jest-puppeteer$/,
    configuration: /^jest-puppeteer\.config\.[cm]?js$/
  },
  nightmare: {
    displayName: 'Nightmare', support: 'unsupported', dependency: /^nightmare$/, command: /\bstripes\s+test\s+nightmare\b/
  },
  // @folio/stripes-cli runs Karma itself (`stripes test karma`), so a module may have no karma dependency.
  karma: {
    displayName: 'Karma', support: 'unclear', dependency: /^karma(?:$|-)/, configuration: /^karma\.conf\.[cm]?[jt]s$/,
    command: /\bkarma\s+start\b|\bstripes\s+test\s+karma\b/
  },
  bigtest: { displayName: 'BigTest', support: 'unclear', dependency: /^@bigtest\//, directory: /^tests?\/bigtest\// },
  unrecognized: { displayName: 'an unrecognized framework in test/e2e', support: 'unclear', directory: /^tests?\/e2e\// }
};
const FRAMEWORK_IDS = Object.keys(FRAMEWORKS) as F002FrameworkId[];

const READ_FILES = /^(?:package\.json|yarn\.lock|Jenkinsfile|\.github\/workflows\/[^/]+\.ya?ml)$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SHARED_WORKFLOW = /^folio-org\/\.github\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@([A-Za-z0-9._/-]+)$/;
const SCRIPT_CALL = /\b(?:yarn|npm|pnpm)\s+(?:-[\w-]+\s+)*(?:run(?:-script)?\s+(?:-[\w-]+\s+)*)?([\w:.@/][\w:.@/-]*)/g;
const SHOWN_EVIDENCE = 10;

interface F002Files {
  files: Map<string, string>;
  /** Every committed configuration file or test-directory file of a framework. */
  listedPaths: string[];
  unread: F002Analysis['unread'];
}

export async function analyzeF002(repoPath: string): Promise<F002Analysis> {
  const [files, policyLoad, tableLoad] = await Promise.all([readF002Files(repoPath), loadS007Policy(), loadFolioSharedWorkflows()]);
  return evaluateF002(files, policyLoad, tableLoad);
}

async function readF002Files(repoPath: string): Promise<F002Files> {
  const snapshot = await readCommittedSource(repoPath, {
    include: path => READ_FILES.test(path),
    list: path => FRAMEWORK_IDS.some(id => FRAMEWORKS[id].directory?.test(path) || (!path.includes('/') && FRAMEWORKS[id].configuration?.test(path))),
    maxTreeBytes: 16 * 1024 * 1024,
    maxEntries: 50_000,
    // Lockfiles of UI modules are 0.2 to 0.8 MB.
    maxFileBytes: 4 * 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024
  });
  return {
    files: new Map(snapshot.files.map(file => [file.path, file.content])),
    listedPaths: snapshot.listedPaths ?? [],
    unread: snapshot.diagnostics.map(diagnostic => ({
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
      message: diagnostic.message,
      material: diagnostic.material && diagnostic.path !== 'yarn.lock'
    }))
  };
}

/** The paths F002's agent review may browse beyond the shared F00x scope. */
export function isF002BrowsePath(path: string): boolean {
  return /(?:^|\/)tests?\//.test(path) || /^(?:cypress|\.github\/workflows)\//.test(path) || path === 'Jenkinsfile'
    || (!path.includes('/') && FRAMEWORK_IDS.some(id => FRAMEWORKS[id].configuration?.test(path)));
}

const F002_BROWSE_SCOPE = 'test/ and tests/ directories, cypress/, .github/workflows/, Jenkinsfile and test-runner configuration files at the repository root';

/**
 * F002 (if E2E tests are provided, they use a supported technology). Not applicable without browser test tooling;
 * fail for an end-to-end framework the policy does not list; pass when Cypress 12.0 or later is the only one (Q3,
 * although the policy marks Cypress provisional); manual otherwise.
 */
function evaluateF002(
  input: F002Files,
  policyLoad: S007PolicyLoadResult,
  tableLoad: FolioSharedWorkflowTableLoadResult
): F002Analysis {
  const unread = [...input.unread];
  const evidence = new Map<F002FrameworkId, F002Evidence[]>();
  const add = (id: F002FrameworkId, item: F002Evidence) => {
    const list = evidence.get(id) ?? [];
    if (!list.some(existing => existing.path === item.path && existing.line === item.line && existing.detail === item.detail)) list.push(item);
    evidence.set(id, list);
  };

  const packageText = input.files.get('package.json');
  const parsed = packageText === undefined ? undefined : parsePackageJson(packageText);
  if (parsed && !parsed.ok) unread.push({ path: 'package.json', message: `Not valid JSON (${parsed.message}).`, material: true });
  const manifest = parsed?.ok ? parsed.manifest : {};
  const packageLine = packageText === undefined ? () => undefined : lineFinder(packageText);
  const scripts = Object.fromEntries(Object.entries(isRecord(manifest.scripts) ? manifest.scripts : {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

  const dependencies = packageDependencyEntries(manifest, ['dependencies', 'devDependencies']);
  for (const entry of dependencies) {
    if (!('name' in entry)) continue;
    const id = FRAMEWORK_IDS.find(candidate => FRAMEWORKS[candidate].dependency?.test(entry.name));
    if (id) add(id, { kind: 'dependency', path: 'package.json', line: packageLine([entry.field, entry.name]), detail: `${entry.field}.${entry.name} ${String(entry.specifier)}` });
  }
  for (const [name, command] of Object.entries(scripts)) {
    for (const id of FRAMEWORK_IDS.filter(candidate => FRAMEWORKS[candidate].command?.test(command))) {
      add(id, { kind: 'script', path: 'package.json', line: packageLine(['scripts', name]), detail: `script ${name}: ${command}` });
    }
  }
  for (const id of FRAMEWORK_IDS) {
    const rule = FRAMEWORKS[id];
    for (const path of input.listedPaths.filter(candidate => !candidate.includes('/') && rule.configuration?.test(candidate))) {
      add(id, { kind: 'configuration', path, detail: `${rule.displayName} configuration` });
    }
    const inDirectory = input.listedPaths.filter(candidate => rule.directory?.test(candidate));
    if (inDirectory.length) {
      const directory = rule.directory!.exec(inDirectory[0])![0];
      add(id, { kind: 'directory', path: directory, detail: `${count(inDirectory.length, 'file')} in ${directory}` });
    }
  }

  const ciFiles = [...input.files.keys()].filter(path => WORKFLOW.test(path) || path === 'Jenkinsfile').sort();
  const sharedJobs = tableLoad.ok ? tableLoad.table : undefined;
  if (!tableLoad.ok) unread.push(...tableLoad.diagnostics.map(diagnostic => ({ message: diagnostic.message, material: true })));
  for (const path of ciFiles) {
    const text = input.files.get(path)!;
    const found = path === 'Jenkinsfile' ? jenkinsRuns(text, scripts) : workflowRuns(path, text, scripts, sharedJobs, unread);
    for (const run of found) add(run.id, { kind: 'ci', path, line: run.line, detail: run.detail });
  }

  const recognized = FRAMEWORK_IDS.filter(id => id !== 'unrecognized' && evidence.has(id));
  if (evidence.has('unrecognized') && recognized.length === 1) {
    evidence.get(recognized[0])!.push(...evidence.get('unrecognized')!);
    evidence.delete('unrecognized');
  }
  const frameworks: F002Framework[] = FRAMEWORK_IDS.filter(id => evidence.has(id)).map(id => ({
    id, displayName: FRAMEWORKS[id].displayName, support: FRAMEWORKS[id].support, evidence: evidence.get(id)!
  }));

  const policy = cypressPolicy(policyLoad);
  const cypressFound = frameworks.some(framework => framework.id === 'cypress');
  const cypress = cypressFound ? cypressVersion(dependencies, input.files.get('yarn.lock'), policy, unread) : undefined;
  const complete = !unread.some(item => item.material);
  const base = {
    criterionId: 'F002' as const,
    frameworks,
    ...(cypress ? { cypress } : {}),
    policy: { loaded: policy.loaded, ...(policy.entry ? { sourceStatement: policy.entry.sourceStatement, strength: policy.entry.strength } : {}),
      ...(policy.minimum ? { minimum: policy.minimum } : {}), ...(policy.problem ? { problem: policy.problem } : {}) },
    ciFiles,
    unread,
    agentBrowseScope: `${FRONTEND_BROWSE_SCOPE}, ${F002_BROWSE_SCOPE}`
  };
  const { status, summary } = decide(frameworks, cypress, policy, complete);
  return { ...base, status, summary, checklist: frontendChecklist(status, checklistItems(frameworks, ciFiles)) };
}

interface CypressPolicy {
  loaded: boolean;
  entry?: S007TechnologyPolicyEntry;
  minimum?: string;
  problem?: string;
}

// The entry is chosen by section id, not by consumer: the section names S013 as its consumer.
function cypressPolicy(policyLoad: S007PolicyLoadResult): CypressPolicy {
  if (!policyLoad.ok) return { loaded: false, problem: policyLoad.diagnostics.map(diagnostic => diagnostic.message).join(' ') || 'the policy could not be loaded' };
  const section = policyLoad.policy.sections.find(candidate => candidate.id === 'frontend-integration-testing');
  const entry = section && findPolicyEntry([section], 'cypress')?.entry;
  if (!entry) return { loaded: false, problem: 'the policy has no Cypress entry under frontend-integration-testing' };
  return { loaded: true, entry, minimum: entry.constraint?.kind === 'minimum' ? entry.constraint.expression : undefined };
}

function cypressVersion(
  dependencies: ReturnType<typeof packageDependencyEntries>,
  lockText: string | undefined,
  policy: CypressPolicy,
  unread: F002Analysis['unread']
): F002CypressVersion {
  const declared = dependencies.find((entry): entry is { field: string; name: string; specifier: unknown } => 'name' in entry && entry.name === 'cypress');
  const specifier = typeof declared?.specifier === 'string' ? declared.specifier : undefined;
  if (!specifier) return { comparison: 'unresolved', text: 'of unknown version (no cypress dependency in package.json)' };
  const lockfile = lockText === undefined ? undefined : parseYarnLockfile(lockText);
  if (lockfile && lockfile.format !== 'v1') {
    unread.push({ path: 'yarn.lock', message: lockfile.format === 'berry' ? 'Is a Yarn 2+ lockfile, which the tool cannot read.' : 'Could not be read as a Yarn 1 lockfile.', material: false });
  }
  const resolved = lockfile?.format === 'v1' ? yarnLockVersion(lockfile.entries, `cypress@${specifier}`) : undefined;
  const comparison = policy.loaded ? compareObservationToConstraint({ resolvedVersion: resolved, declaredVersion: specifier, ecosystem: 'javascript' }, policy.entry?.constraint) : 'unresolved';
  return {
    ...(resolved ? { resolved } : {}),
    comparison,
    text: resolved ? `${resolved} (yarn.lock)` : `${specifier} (package.json${lockText === undefined ? ', no yarn.lock' : '; yarn.lock does not resolve it'})`
  };
}

const UNLISTED = 'not on the officially supported technologies page';

function decide(frameworks: F002Framework[], cypress: F002CypressVersion | undefined, policy: CypressPolicy, complete: boolean): { status: EvaluationStatus; summary: string } {
  const names = (items: F002Framework[]) => listText(items.map(framework => framework.displayName));
  const minimum = policy.minimum ? `the ${minorText(policy.minimum)} minimum` : 'the policy\'s minimum';
  if (frameworks.length === 0) {
    return complete
      ? { status: EvaluationStatus.NOT_APPLICABLE, summary: 'F002 not applicable: The repository has no end-to-end tests. FOLIO\'s end-to-end tests for UI modules live in stripes-testing.' }
      : { status: EvaluationStatus.MANUAL, summary: 'F002 manual: The tool found no end-to-end test tooling, but it could not read every file that would show it.' };
  }
  const unsupported = frameworks.filter(framework => framework.support === 'unsupported');
  if (unsupported.length) {
    return { status: EvaluationStatus.FAIL, summary: `F002 fail: The repository has end-to-end tests in ${names(unsupported)}, which ${unsupported.length === 1 ? 'is' : 'are'} ${UNLISTED}${policy.entry ? ` (it lists ${policy.entry.sourceStatement})` : ''}.` };
  }
  const unclear = frameworks.filter(framework => framework.support === 'unclear');
  const version = cypress ? reportText(cypress.text) : '';
  const cypressText = cypress ? `Cypress ${version}` : 'Cypress';
  const belowNote = cypress?.comparison === 'noncompliant' ? `, below ${minimum}` : cypress?.comparison === 'overlap' ? `, which allows versions below ${minimum}` : '';
  if (unclear.length) {
    const listed = unclear.filter(framework => framework.id !== 'unrecognized');
    return {
      status: EvaluationStatus.MANUAL,
      summary: `F002 manual: The repository has browser tests that use ${names(unclear)}. A reviewer must decide whether they are end-to-end tests`
        + `${listed.length ? `; ${names(listed)} ${listed.length === 1 ? 'is' : 'are'} ${UNLISTED}` : ''}.${cypress ? ` It also has ${cypressText}${belowNote}.` : ''}`
    };
  }
  if (!policy.loaded) {
    return { status: EvaluationStatus.MANUAL, summary: `F002 manual: The repository's end-to-end tests use ${cypressText}, but Cypress's policy entry could not be read (${policy.problem}).` };
  }
  const provisional = ` The supported technologies page lists "${policy.entry!.sourceStatement}" (provisional); S007 would treat that entry as manual.`;
  switch (cypress!.comparison) {
    case 'compliant':
      return complete
        ? { status: EvaluationStatus.PASS, summary: `F002 pass: The repository's end-to-end tests use Cypress ${version}, which meets ${minimum}.${provisional}` }
        : { status: EvaluationStatus.MANUAL, summary: `F002 manual: The repository's end-to-end tests use Cypress ${version}, but the tool could not read every file that would show other frameworks.` };
    case 'noncompliant':
      return { status: EvaluationStatus.MANUAL, summary: `F002 manual: The repository's end-to-end tests use Cypress ${version}, which is below ${minimum}.` };
    case 'overlap':
      return { status: EvaluationStatus.MANUAL, summary: `F002 manual: The repository's end-to-end tests use Cypress ${version}, which allows versions below ${minimum}.` };
    default:
      return { status: EvaluationStatus.MANUAL, summary: `F002 manual: The repository's end-to-end tests use Cypress ${version}, so the tool cannot compare it with ${minimum}.` };
  }
}

// "12.0.0" → "12.0"
function minorText(version: string): string {
  return version.replace(/^(\d+\.\d+)\.0$/, '$1');
}

function checklistItems(frameworks: F002Framework[], ciFiles: string[]): FrontendChecklistItem[] {
  const ci = frameworks.flatMap(framework => framework.evidence.filter(item => item.kind === 'ci').map(item => ({ framework, item })));
  const items: FrontendChecklistItemDraft[] = [{
    id: 'F002-C1',
    title: 'Each browser test suite found is a component test, or an end-to-end test in a supported framework.',
    startingPoints: frameworks.flatMap(framework => framework.evidence.filter(item => item.kind !== 'ci')
      .map(item => ({ path: item.path, ...(item.line ? { line: item.line } : {}), note: `${framework.displayName}: ${item.detail}` }))),
    reviewerOnly: false,
    obligations: [],
    subjects: frameworks.map(framework => {
      const file = framework.evidence.find(item => item.kind === 'configuration') ?? framework.evidence.find(item => !item.path.endsWith('/'));
      return { subject: framework.displayName, ...(file ? { path: file.path, ...(file.line ? { line: file.line } : {}) } : {}) };
    })
  }, {
    id: 'F002-C2',
    title: 'CI runs end-to-end tests only with a supported framework.',
    startingPoints: ci.length
      ? ci.map(({ framework, item }) => ({ path: item.path, ...(item.line ? { line: item.line } : {}), note: `${framework.displayName}: ${item.detail}` }))
      : ciFiles.map(path => ({ path, note: 'runs no browser tests the tool recognized' })),
    reviewerOnly: false,
    obligations: [],
    subjects: []
  }];
  return numberObligations(items);
}

export function renderF002HumanDetails(analysis: F002Analysis, agentReview?: CriterionAgentReviewResult): string {
  const lines = ['What the tool found:'];
  if (!analysis.frameworks.length) lines.push('  - Browser test tooling: none (no Cypress, Playwright, WebdriverIO, Nightwatch, TestCafe, jest-puppeteer, Nightmare, Karma or BigTest; no test/e2e directory)');
  for (const framework of analysis.frameworks) {
    lines.push(`  - ${framework.displayName} (${SUPPORT_LABELS[framework.support]}):`,
      ...framework.evidence.slice(0, SHOWN_EVIDENCE).map(item => `    - ${reportPath(item.path)}${item.line ? `:${item.line}` : ''} — ${reportText(item.detail)}`),
      ...overflowLine(framework.evidence.length, SHOWN_EVIDENCE, '    '));
  }
  if (analysis.cypress) lines.push(`  - Cypress version: ${reportText(analysis.cypress.text)}`);
  lines.push(`  - CI files read: ${analysis.ciFiles.length ? analysis.ciFiles.map(reportPath).join(', ') : 'none (.github/workflows/*.yml, Jenkinsfile)'}`);
  lines.push(`  - Policy: ${analysis.policy.loaded
    ? `"${reportText(analysis.policy.sourceStatement ?? '')}" (${analysis.policy.strength}${analysis.policy.minimum ? `, minimum ${analysis.policy.minimum}` : ''}) under frontend-integration-testing`
    : `not loaded: ${reportText(analysis.policy.problem ?? '')}`}`);
  if (agentReview) lines.push(`  - Agent review scope: ${reportText(analysis.agentBrowseScope)}`);
  if (analysis.frameworks.some(framework => framework.id === 'cypress') && analysis.policy.loaded && analysis.policy.strength === 'provisional') {
    lines.push('Policy note:', '  - The officially supported technologies page marks Cypress as pending verification (provisional). S007 treats provisional entries as manual; F002 passes Cypress at or above the minimum, as decided for this criterion.');
  }
  if (analysis.unread.length) {
    lines.push('What the tool could not read:', ...analysis.unread.map(item => `  - ${item.path ? `${reportPath(item.path)} — ` : ''}${reportText(item.message)}`));
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    lines.push('What to do:', '  - Write end-to-end tests in Cypress 12.0 or later, or move them to stripes-testing, and remove the unsupported framework.');
  }
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

const SUPPORT_LABELS: Record<F002Support, string> = {
  supported: 'on the supported technologies page',
  unsupported: `end-to-end framework ${UNLISTED}`,
  unclear: 'browser tests; component or end-to-end tests unclear'
};

interface CiRun {
  id: F002FrameworkId;
  line?: number;
  detail: string;
}

/**
 * What a workflow runs: steps using a recognized action, run lines with a recognized command (through the
 * package.json scripts they call), and the test jobs of FOLIO's shared workflows with their default commands.
 */
function workflowRuns(
  path: string,
  text: string,
  scripts: Record<string, string>,
  table: FolioSharedWorkflowTable | undefined,
  unread: F002Analysis['unread']
): CiRun[] {
  const lineCounter = new LineCounter();
  const document = YAML.parseDocument(text, { lineCounter, schema: 'failsafe', uniqueKeys: false });
  if (document.errors.length) {
    unread.push({ path, message: `Not valid YAML (${document.errors[0].message.split('\n')[0]}).`, material: true });
    return [];
  }
  const lineOf = (node: YamlNode | undefined) => node?.range ? lineCounter.linePos(node.range[0]).line : undefined;
  const textLines = text.split(/\r?\n/);
  const runs: CiRun[] = [];
  const jobs = document.get('jobs', true);
  if (!isMap(jobs)) return runs;
  for (const pair of jobs.items) {
    const job = String(isScalar(pair.key) ? pair.key.value : pair.key);
    if (!isMap(pair.value)) continue;
    const uses = pair.value.get('uses', true);
    const shared = isScalar(uses) ? SHARED_WORKFLOW.exec(String(uses.value).trim()) : null;
    const sharedWorkflow = shared && shared[2] === table?.ref ? table.workflows[shared[1]] : undefined;
    if (shared && sharedWorkflow) {
      const inputs = pair.value.get('with', true);
      const input = (name: string) => {
        const node = isMap(inputs) ? inputs.get(name, true) : undefined;
        return isScalar(node) ? { value: String(node.value).trim(), line: lineOf(node) } : undefined;
      };
      for (const testJob of sharedWorkflow.testJobs ?? []) {
        const enabled = input(testJob.enabledInput);
        if (!(enabled ? enabled.value.toLowerCase() !== 'false' : testJob.enabledByDefault)) continue;
        const command = input(testJob.commandInput);
        const commandText = command?.value ?? testJob.defaultCommand;
        for (const found of commandFrameworks(commandText, scripts)) {
          runs.push({ id: found.id, line: command?.line ?? enabled?.line ?? lineOf(uses),
            detail: `job ${job} (FOLIO's shared ${shared[1]}, ${testJob.enabledInput}${enabled ? `: ${enabled.value}` : ' by default'}) runs ${commandText}${viaText(found.via, scripts)}` });
        }
      }
    }
    const steps = pair.value.get('steps', true);
    if (!isSeq(steps)) continue;
    for (const step of steps.items) {
      if (!isMap(step)) continue;
      const action = step.get('uses', true);
      if (isScalar(action)) {
        for (const id of FRAMEWORK_IDS.filter(candidate => FRAMEWORKS[candidate].action?.test(String(action.value).trim()))) {
          runs.push({ id, line: lineOf(action), detail: `job ${job} uses ${String(action.value).trim()}` });
        }
      }
      // The run text is scanned line by line in the file, so each finding keeps the line it is on.
      const run = step.get('run', true);
      if (isScalar(run) && run.range) {
        const first = lineCounter.linePos(run.range[0]).line;
        const last = lineCounter.linePos(Math.max(run.range[0], run.range[1] - 1)).line;
        for (let line = first; line <= last; line++) {
          const command = textLines[line - 1].replace(/^\s*(?:-\s*)?run:\s*[|>]?[-+]?\s*/, '').trim();
          if (!command || command.startsWith('#')) continue;
          for (const found of commandFrameworks(command, scripts)) {
            runs.push({ id: found.id, line, detail: `job ${job} runs ${command}${viaText(found.via, scripts)}` });
          }
        }
      }
    }
  }
  return runs;
}

/**
 * What a Jenkinsfile runs, line by line, outside comments: `sh` commands, and `yarn test` for FOLIO's `buildNPM`
 * with `runTest` set (jenkins-pipeline-libs vars/buildNPM.groovy accepts y, yes, t and true in any case).
 */
function jenkinsRuns(text: string, scripts: Record<string, string>): CiRun[] {
  let inComment = false;
  return text.split(/\r?\n/).flatMap((raw, index) => {
    let line = '';
    for (let rest = raw; rest;) {
      if (inComment) {
        const end = rest.indexOf('*/');
        if (end < 0) break;
        inComment = false;
        rest = rest.slice(end + 2);
      } else {
        const start = rest.search(/\/\*|\/\//);
        if (start < 0 || rest.startsWith('//', start)) {
          line += start < 0 ? rest : rest.slice(0, start);
          break;
        }
        line += rest.slice(0, start);
        inComment = true;
        rest = rest.slice(start + 2);
      }
    }
    line = line.trim();
    if (!line) return [];
    const command = /^runTest\s*[=:]\s*(['"]?)(?:y|yes|t|true)\1\s*,?$/i.test(line) ? 'yarn test'
      : /^sh\s*\(?\s*(['"]{1,3})(.*?)\1/.exec(line)?.[2] ?? line;
    return commandFrameworks(command, scripts).map(found => ({
      id: found.id, line: index + 1, detail: `${line}${command === line ? '' : ` (runs ${command})`}${viaText(found.via, scripts)}`
    }));
  });
}

/** The frameworks a command runs, directly or through the package.json scripts it calls (`yarn test`, `npm run e2e`). */
function commandFrameworks(command: string, scripts: Record<string, string>, seen = new Set<string>()): Array<{ id: F002FrameworkId; via: string[] }> {
  const found: Array<{ id: F002FrameworkId; via: string[] }> = FRAMEWORK_IDS
    .filter(id => FRAMEWORKS[id].command?.test(command)).map(id => ({ id, via: [] }));
  for (const match of command.matchAll(SCRIPT_CALL)) {
    const name = match[1];
    if (!Object.prototype.hasOwnProperty.call(scripts, name) || seen.has(name)) continue;
    seen.add(name);
    found.push(...commandFrameworks(scripts[name], scripts, seen).map(inner => ({ id: inner.id, via: [name, ...inner.via] })));
  }
  return unique(found.map(item => item.id)).map(id => found.find(item => item.id === id)!);
}

// " (script test: stripes test karma)"
function viaText(via: string[], scripts: Record<string, string>): string {
  return via.length ? ` (${via.map(name => `script ${name}: ${scripts[name]}`).join('; ')})` : '';
}

/** The line of a key path in a JSON text, e.g. ['devDependencies', 'cypress'], read with the YAML parser. */
function lineFinder(text: string): (keys: string[]) => number | undefined {
  const lineCounter = new LineCounter();
  const document = YAML.parseDocument(text, { lineCounter, uniqueKeys: false });
  return keys => {
    const parent = keys.length > 1 ? document.getIn(keys.slice(0, -1), true) : document.contents;
    if (!isMap(parent)) return undefined;
    const pair = parent.items.find(item => isScalar(item.key) && String(item.key.value) === keys[keys.length - 1]);
    return isScalar(pair?.key) && pair.key.range ? lineCounter.linePos(pair.key.range[0]).line : undefined;
  };
}

