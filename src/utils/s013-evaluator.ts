import {
  BuildTestEvidence,
  EvaluationRun,
  EvaluationStatus,
  FolioSharedWorkflowTableLoadResult,
  RemoteEvidenceRecord,
  S011SuppressionScan,
  S007PolicyLoadResult,
  S007PolicySection,
  S007TechnologyPolicyEntry,
  S013Analysis,
  S013Coverage,
  S013CoverageScope,
  S013WorkflowScope,
  S013TechnologyFinding,
  S013Technologies,
  SonarCloudSnapshot
} from '../types';
import { collectBuildTestEvidence } from './build-test-evidence';
import { loadFolioSharedWorkflows } from './folio-shared-workflows';
import { displayPolicyPath } from './acceptance-ledger';
import { compareObservationToConstraint } from './s007-evaluator';
import { loadS007Policy, policySections } from './s007-policy';
import { reportPath, reportText } from './report-text';
import { warningLines } from './s012-report-details';
import { getSonarCloudSnapshot, sonarSnapshotFreshness } from './sonarcloud-snapshot';
import { scanS011Suppressions } from './s011-suppressions';

const REQUIRED_COVERAGE = 80;
const MAX_DECLARATIONS_SHOWN = 2;
const KIND_ORDER: Record<S013TechnologyFinding['kind'], number> = { runner: 0, library: 1, helper: 2, integration: 3 };

export interface S013Inputs {
  language: 'java' | 'javascript';
  policyLoad: S007PolicyLoadResult;
  tableLoad: FolioSharedWorkflowTableLoadResult;
  evidence: BuildTestEvidence;
  remoteLookups: boolean;
  /** SonarCloud's latest analysis; absent when remote lookups are off. */
  snapshot?: SonarCloudSnapshot;
  repositoryCommit?: string;
  /** S011's scan of the repository's and CI's Sonar settings; read only with remote lookups. */
  scopeScan?: S011SuppressionScan;
}

/**
 * Gathers S013's evidence and evaluates it. Coverage comes from SonarCloud only: tests are never run, even with
 * --allow-local-commands, and CI coverage artifacts are not downloaded.
 */
export async function analyzeS013(repoPath: string, run: EvaluationRun, language: 'java' | 'javascript'): Promise<S013Analysis> {
  const [policyLoad, tableLoad, evidence, snapshot] = await Promise.all([
    loadS007Policy(),
    loadFolioSharedWorkflows(),
    run.getOrCreateArtifact('buildTestEvidence', () => collectBuildTestEvidence(repoPath)),
    getSonarCloudSnapshot(run, repoPath)
  ]);
  // The exclusions qualify a coverage figure, so they are read only when SonarCloud has an analysis to show.
  // S011's scan, shared through the run so it is made once when both criteria run.
  const scopeScan = snapshot?.analysis && !snapshot.problem
    ? await run.getOrCreateArtifact('s011SuppressionScan', async () => scanS011Suppressions(repoPath, evidence, tableLoad.ok ? tableLoad.table : undefined))
    : undefined;
  return evaluateS013({
    language,
    policyLoad,
    tableLoad,
    evidence,
    remoteLookups: Boolean(run.remoteLookups),
    snapshot,
    repositoryCommit: run.repositoryCommit,
    scopeScan
  });
}

export function evaluateS013(inputs: S013Inputs): S013Analysis {
  const area = inputs.language === 'javascript' ? 'frontend' : 'backend';
  const coverage = coverageHalf(inputs);
  const technologies = technologyHalf(inputs, area);
  const status = coverage.outcome === 'fail'
    ? EvaluationStatus.FAIL
    : coverage.outcome === 'manual' || technologies.outcome === 'manual' ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  const source = inputs.policyLoad.ok ? inputs.policyLoad.policy.source : undefined;
  return {
    criterionId: 'S013',
    status,
    summary: `S013 ${status}: ${coverage.rationale} ${technologies.rationale}`,
    area,
    remoteLookups: inputs.remoteLookups,
    coverage,
    technologies,
    coverageScope: inputs.scopeScan && coverageScope(inputs, inputs.scopeScan),
    policy: inputs.policyLoad.ok ? {
      sourcePath: displayPolicyPath(inputs.policyLoad.sourcePath),
      title: source?.title,
      documentStatus: source?.documentStatus,
      exportDate: source?.exportDate
    } : undefined,
    policyDiagnostics: inputs.policyLoad.ok ? [] : inputs.policyLoad.diagnostics,
    evidenceDiagnostics: inputs.evidence.testDiagnostics,
    remoteEvidence: inputs.snapshot?.remoteEvidence ?? []
  };
}

// ---- Coverage: SonarCloud's overall figure on the evaluated commit ----

function coverageHalf(inputs: S013Inputs): S013Coverage {
  const snapshot = inputs.snapshot;
  if (!inputs.remoteLookups || !snapshot) {
    return {
      outcome: 'manual',
      reason: 'no-lookups',
      rationale: 'Coverage was not checked: remote lookups are off. Rerun with --allow-remote-lookups to read it from SonarCloud.',
      measures: {}
    };
  }
  const projectKey = reportText(snapshot.projectKey);
  const base = {
    projectKey,
    branch: snapshot.branch === undefined ? undefined : reportText(snapshot.branch),
    requestedBranchNotAnalysed: snapshot.requestedBranchNotAnalysed === undefined ? undefined : reportText(snapshot.requestedBranchNotAnalysed),
    analysis: snapshot.analysis ? { date: reportText(snapshot.analysis.date), revision: snapshot.analysis.revision && reportText(snapshot.analysis.revision) } : undefined,
    measures: { ...snapshot.measures }
  };
  const manual = (reason: S013Coverage['reason'], rationale: string, extra: Partial<S013Coverage> = {}): S013Coverage =>
    ({ ...base, ...extra, outcome: 'manual', reason, rationale });

  if (snapshot.projectFound === false) {
    const workflows = workflowsWithoutSonar(inputs);
    return manual('no-project', `No coverage figure is available: SonarCloud has no project for this module (${projectKey})${workflows.length
      ? `, and its CI uses FOLIO's ${listText(workflows)} ${workflows.length === 1 ? 'workflow, which does' : 'workflows, which do'} not run SonarCloud.`
      : '.'}`, { workflowsWithoutSonar: workflows });
  }
  if (snapshot.problem || !snapshot.analysis) {
    return manual('unreadable', `No coverage figure is available: ${reportText(snapshot.problem ?? 'SonarCloud has no analysis of the project.')}`);
  }
  // Stale data cannot pass or fail: the evaluated commit may have more or fewer tests than the analysed one.
  const freshness = sonarSnapshotFreshness(snapshot, inputs.repositoryCommit);
  if (!freshness.fresh) {
    return manual('stale', `SonarCloud's coverage cannot be used: ${reportText(freshness.message)}`, { fresh: false });
  }
  if (snapshot.measuresProblem) {
    return manual('unreadable', `No coverage figure is available: ${reportText(snapshot.measuresProblem)}`, { fresh: true });
  }
  // A figure SonarCloud did not return is unknown, never 0.
  const { coverage, lines_to_cover: linesToCover } = snapshot.measures;
  if (coverage === undefined || linesToCover === undefined) {
    const missing = [coverage === undefined && 'coverage', linesToCover === undefined && 'lines to cover'].filter(Boolean).join(' or ');
    return manual('no-measures', `SonarCloud's analysis of the evaluated commit reports no ${missing} figure, so there is no coverage to judge.`, { fresh: true });
  }
  if (linesToCover === 0) {
    return manual('nothing-to-cover', 'SonarCloud measured no lines to cover in its analysis of the evaluated commit, so there is no coverage percentage to judge.', { fresh: true });
  }
  if (coverage < REQUIRED_COVERAGE) {
    return {
      ...base,
      fresh: true,
      outcome: 'fail',
      reason: 'below',
      rationale: `SonarCloud reports ${percent(coverage)} test coverage, below the required ${REQUIRED_COVERAGE}%.${coverage === 0
        ? ' If the module has tests, check that CI uploads its coverage report to SonarCloud.'
        : ''}`
    };
  }
  return { ...base, fresh: true, outcome: 'ok', reason: 'meets', rationale: `SonarCloud reports ${percent(coverage)} test coverage, meeting the required ${REQUIRED_COVERAGE}%.` };
}

/** FOLIO shared workflows the repository builds with that the shared-workflow table records as not running SonarCloud. */
function workflowsWithoutSonar(inputs: S013Inputs): string[] {
  if (!inputs.tableLoad.ok) return [];
  const table = inputs.tableLoad.table;
  return unique(inputs.evidence.sharedWorkflows
    .filter(use => use.ref === table.ref && Object.prototype.hasOwnProperty.call(table.workflows, use.name) && table.workflows[use.name].sonar === false)
    .map(use => `${use.name}@${use.ref}`));
}

/** Settings that change which files the coverage figure counts; issue, duplication and test settings do not. */
const COVERAGE_SCOPE_LABELS: Array<[RegExp, string]> = [
  [/^sonar\.coverage\.exclusions$/, 'Files excluded from coverage'],
  [/^sonar\.(?:(?:java|javascript|typescript|css|html|xml)\.)?exclusions$/, 'Files excluded from analysis'],
  [/^sonar\.sources$/, 'Source folders analysed'],
  [/^sonar\.inclusions$/, 'Files analysis is limited to']
];

/** FOLIO's build workflows; used to recognize them when the shared-workflow table could not be loaded. */
const BUILD_WORKFLOWS = ['maven.yml', 'gradle.yml', 'ui.yml'];
/** Files where S011's scan finds analysis-scope settings; an unread one may hide an exclusion. */
const SCOPE_FILE = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.properties)$|^\.mvn\/maven\.config$|^\.github\/workflows\//;
const MAX_SCAN_DIAGNOSTICS = 20;

function coverageScope(inputs: S013Inputs, scan: S011SuppressionScan): S013CoverageScope {
  const table = inputs.tableLoad.ok ? inputs.tableLoad.table : undefined;
  const workflows: S013WorkflowScope[] = [];
  const patterns = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
  for (const use of inputs.evidence.sharedWorkflows) {
    const label = `${use.name}@${use.ref}`;
    if (workflows.some(item => item.workflow === label)) continue;
    const known = table && use.ref === table.ref && Object.prototype.hasOwnProperty.call(table.workflows, use.name) ? table.workflows[use.name] : undefined;
    if (!known) {
      // A FOLIO build workflow the table does not cover may pass exclusions the tool cannot see.
      if (table ? Object.prototype.hasOwnProperty.call(table.workflows, use.name) : BUILD_WORKFLOWS.includes(use.name)) {
        workflows.push({ workflow: label, path: use.path, unknown: true });
      }
      continue;
    }
    // The caller can switch the scan off (maven.yml do-sonar-scan, ui.yml sonar-enabled).
    if (!known.sonar || ['do-sonar-scan', 'sonar-enabled'].some(input => use.inputs[input]?.trim().toLowerCase() === 'false')) continue;
    // A with: value replaces the workflow's default; it is passed to the scanner as -Dsonar.sources / -Dsonar.exclusions.
    const value = (input: string, defaults: string[] | null | undefined) => use.inputs[input] !== undefined
      ? { patterns: patterns(use.inputs[input]), input: true }
      : defaults?.length ? { patterns: defaults, input: false } : undefined;
    workflows.push({
      workflow: label,
      path: use.path,
      sources: value('sonar-sources', known.sonarSources),
      exclusions: value('sonar-exclusions', known.sonarExclusions)
    });
  }
  const settings = inputs.snapshot?.settings;
  const relevant = scan.diagnostics.filter(item => !item.path || SCOPE_FILE.test(item.path));
  return {
    // Workflow inputs are shown with their workflow, in full.
    settings: scan.scope.filter(setting => setting.source !== 'workflow-input' && COVERAGE_SCOPE_LABELS.some(([pattern]) => pattern.test(setting.key))),
    workflows,
    projectSettings: settings?.read ? settings.values.filter(setting => COVERAGE_SCOPE_LABELS.some(([pattern]) => pattern.test(setting.key))) : undefined,
    // Diagnostics are capped, so a full list may hide an unread scope file.
    complete: scan.complete || (!relevant.length && scan.diagnostics.length < MAX_SCAN_DIAGNOSTICS)
  };
}

// ---- Test technologies against the s013 sections of the supported-technologies policy ----

function technologyHalf(inputs: S013Inputs, area: 'frontend' | 'backend'): S013Technologies {
  const ecosystem = area === 'frontend' ? 'javascript' : 'java';
  const sections = inputs.policyLoad.ok ? policySections(inputs.policyLoad.policy, 's013', area) : [];
  const findings: S013TechnologyFinding[] = [];
  for (const declaration of inputs.evidence.testTechnologies.filter(item => item.ecosystem === ecosystem)) {
    let finding = findings.find(item => item.id === declaration.id);
    if (!finding) {
      const entry = findEntry(sections, declaration.id);
      finding = {
        id: declaration.id,
        displayName: declaration.displayName,
        kind: declaration.kind,
        listed: Boolean(entry),
        policyStatement: entry?.sourceStatement,
        declarations: [],
        versions: declaration.versions
      };
      findings.push(finding);
      const outdated = entry?.constraint && declaration.versions?.find(version =>
        compareObservationToConstraint({ resolvedVersion: version, ecosystem }, entry.constraint) === 'noncompliant');
      if (entry && outdated) {
        finding.recommendation = `${entry.recommendations?.[0] ?? `Follow "${entry.sourceStatement}".`} yarn.lock resolves ${declaration.displayName} ${reportText(outdated)}.`;
      }
    }
    finding.declarations.push({ dependency: reportText(declaration.dependency), path: declaration.path, scope: reportText(declaration.scope) });
  }
  findings.sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);

  const runners = findings.filter(finding => finding.kind === 'runner');
  const names = runners.map(finding => finding.displayName);
  const unlisted = runners.filter(finding => !finding.listed).map(finding => finding.displayName);
  const manual = (rationale: string): S013Technologies => ({ outcome: 'manual', rationale, findings });
  if (!inputs.policyLoad.ok) {
    return manual('The officially supported technologies list (config/officially-supported-technologies.json) could not be loaded, so the test technologies were not checked.');
  }
  if (unlisted.length) {
    return manual(unlisted.length === runners.length
      ? `The tests use ${listText(names)}, which the supported-technologies page does not list.`
      : `The tests use ${listText(names)}, and the supported-technologies page does not list ${listText(unlisted)}.`);
  }
  // "No tests" is never a failure on its own; a module without tests fails on its coverage figure instead.
  if (!inputs.evidence.testComplete) {
    return manual(`${runners.length ? `The tests use ${listText(names)}, but some` : 'Some'} build files could not be read (see Warnings), so a test runner may be missing.`);
  }
  if (!runners.length) {
    return manual('No unit-test runner was found in the build files, so a reviewer must check which technologies the tests use.');
  }
  return {
    outcome: 'ok',
    rationale: `The tests use ${listText(names)}, which ${runners.length === 1 ? 'is an officially supported technology' : 'are officially supported technologies'}.`,
    findings
  };
}

function findEntry(sections: S007PolicySection[], id: string): S007TechnologyPolicyEntry | undefined {
  for (const section of sections) {
    const entry = section.entries.find(candidate => candidate.id === id || candidate.aliases.includes(id));
    if (entry) return entry;
  }
  return undefined;
}

// ---- Report ----

export function renderS013HumanDetails(analysis: S013Analysis): string {
  const lines: string[] = [];
  const action = whatToDo(analysis);
  if (action) lines.push(`What to do: ${action}`);
  lines.push(...coverageLines(analysis.coverage));
  if (analysis.coverageScope) lines.push(...coverageScopeLines(analysis.coverageScope));

  const findings = analysis.technologies.findings;
  if (!findings.length) {
    lines.push(`Test technologies: none found in the build files${analysis.evidenceDiagnostics.some(item => item.material) ? ' that could be read' : ''}`);
  } else {
    lines.push('Test technologies:');
    for (const finding of findings) {
      const versions = finding.versions?.length ? ` ${finding.versions.map(reportText).join(', ')}` : '';
      lines.push(`  - ${finding.displayName}${versions} (${declarationText(finding)}): ${verdict(finding)}`);
      if (finding.recommendation) lines.push(`    - Recommendation (advisory): ${finding.recommendation}`);
    }
  }

  const policy = analysis.policy;
  if (policy) {
    const status = [policy.documentStatus, policy.exportDate && `exported ${policy.exportDate}`].filter(Boolean).join(', ');
    lines.push(`Policy: ${policy.title ?? 'Officially Supported Technologies'}${status ? ` (${status})` : ''}, ${policy.sourcePath}`);
  }
  if (analysis.policyDiagnostics.length) {
    lines.push('Configuration problems:', ...analysis.policyDiagnostics.map(diagnostic => `  - ${reportText(diagnostic.message)}`));
  }
  lines.push(...warningLines(analysis.evidenceDiagnostics));
  if (analysis.remoteEvidence.length) lines.push('Sources:', ...analysis.remoteEvidence.map(sourceLine));
  return lines.join('\n');
}

function coverageLines(coverage: S013Coverage): string[] {
  if (coverage.reason === 'no-lookups') return ['Coverage: not checked (remote lookups are off)'];
  if (coverage.reason === 'no-project') return [`Coverage: SonarCloud has no project ${coverage.projectKey}`];
  if (!coverage.analysis) return [`Coverage: SonarCloud project ${coverage.projectKey}, not read`];
  const { analysis, measures } = coverage;
  const commit = analysis.revision ? `commit ${analysis.revision.slice(0, 7)}` : 'commit not recorded';
  const evaluated = coverage.fresh ? ', the commit evaluated here' : coverage.fresh === false ? ', not confirmed as the commit evaluated here' : '';
  const lines = [`Coverage (SonarCloud ${coverage.projectKey}, branch ${coverage.branch}, analysed ${analysis.date.slice(0, 10)}, ${commit}${evaluated}):`];
  if (coverage.requestedBranchNotAnalysed) {
    lines.push(`  - SonarCloud has no analysis of branch ${coverage.requestedBranchNotAnalysed}, so its main branch was read.`);
  }
  const value = (metric: string, format: (number: number) => string) => measures[metric] === undefined ? 'not reported' : format(measures[metric]);
  lines.push(`  - Overall: ${value('coverage', percent)} (lines ${value('line_coverage', percent)}, branches ${value('branch_coverage', percent)})`);
  lines.push(`  - Lines: ${value('lines_to_cover', count)} to cover, ${value('uncovered_lines', count)} uncovered`);
  lines.push(`  - Conditions: ${value('conditions_to_cover', count)} to cover, ${value('uncovered_conditions', count)} uncovered`);
  lines.push(`  - The ${REQUIRED_COVERAGE}% rule uses the overall figure, which combines lines and branches.`);
  return lines;
}

// Rows start with a label, not "key: value" or "path:line", so the HTML report keeps each one readable.
function coverageScopeLines(scope: S013CoverageScope): string[] {
  const label = (key: string) => COVERAGE_SCOPE_LABELS.find(([pattern]) => pattern.test(key))![1];
  const rows = [
    ...scope.settings.map(setting => {
      const where = `${setting.source === 'command-line' ? 'command line ' : ''}${reportPath(setting.path)}:${setting.line}`;
      return `  - ${label(setting.key)} (${reportText(setting.key)}, ${where}): ${reportText(setting.value)}`;
    }),
    ...scope.workflows.flatMap(workflowRows)
  ];
  if (!rows.length) rows.push('  - None set in the repository or CI');
  if (!scope.projectSettings) {
    rows.push('  - Exclusions set in SonarCloud\'s project settings were not checked (reading them needs a SonarCloud admin token).');
  } else if (!scope.projectSettings.length) {
    rows.push('  - None set in SonarCloud\'s project settings');
  } else {
    rows.push(...scope.projectSettings.map(setting => `  - ${label(setting.key)} (${reportText(setting.key)}, SonarCloud project settings): ${reportText(setting.value)}`));
  }
  if (!scope.complete) rows.push('  - Some build or CI files could not be scanned, so other exclusions may be missing.');
  return ['Not counted in the coverage figure (for review; this does not change the result):', ...rows];
}

function workflowRows(item: S013WorkflowScope): string[] {
  const workflow = `FOLIO's ${reportText(item.workflow)} workflow`;
  if (item.unknown) return [`  - ${workflow} (${reportPath(item.path)}) is not in the shared-workflow table, so the exclusions it passes to SonarCloud are not known.`];
  const origin = (value: { input: boolean }) => value.input ? `set in ${reportPath(item.path)}, replacing its default` : 'its default';
  return [
    item.sources && `  - Source folders ${workflow} analyses (${origin(item.sources)}): ${item.sources.patterns.map(reportText).join(', ')}`,
    item.exclusions && `  - Files ${workflow} excludes from analysis (${origin(item.exclusions)}): ${item.exclusions.patterns.map(reportText).join(', ')}`
  ].filter((row): row is string => Boolean(row));
}

function declarationText(finding: S013TechnologyFinding): string {
  const shown = finding.declarations.slice(0, MAX_DECLARATIONS_SHOWN).map(item => {
    const scope = /^(?:test|compile|provided|runtime|system|import)$/.test(item.scope) ? `${item.scope} scope` : item.scope;
    return `${item.dependency} in ${reportPath(item.path)}, ${scope}`;
  });
  const more = finding.declarations.length - shown.length;
  return `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}

function verdict(finding: S013TechnologyFinding): string {
  if (finding.kind === 'helper') return 'testing helper, not covered by the supported-technologies page';
  if (finding.kind === 'integration') return 'integration or end-to-end tool, does not count for unit tests';
  if (!finding.listed) return 'not listed on the supported-technologies page';
  return `supported${finding.policyStatement ? ` ("${reportText(finding.policyStatement)}")` : ''}`;
}

function whatToDo(analysis: S013Analysis): string | undefined {
  if (analysis.status === EvaluationStatus.PASS) return undefined;
  const { coverage, technologies } = analysis;
  const actions: string[] = [];
  switch (coverage.reason) {
    case 'no-lookups':
      actions.push(`Rerun with --allow-remote-lookups so the tool can read the module's coverage from SonarCloud, or check by hand that SonarCloud's overall coverage for the evaluated commit is at least ${REQUIRED_COVERAGE}%.`);
      break;
    case 'below': {
      const { coverage: overall, line_coverage: lines, branch_coverage: branches } = coverage.measures;
      actions.push(overall === 0
        ? `If the module has tests, make sure CI uploads its coverage report to SonarCloud; otherwise add tests until overall coverage reaches ${REQUIRED_COVERAGE}%.`
        : `Add tests until SonarCloud's overall coverage reaches ${REQUIRED_COVERAGE}%.${lines !== undefined && branches !== undefined && branches < lines ? ' Branch coverage is the weaker part.' : ''}`);
      break;
    }
    case 'stale':
      actions.push('Rerun the evaluation once SonarCloud has analysed the evaluated commit, or check that commit\'s coverage by hand.');
      break;
    case 'meets':
      break;
    default:
      actions.push(`Check by hand that the module's overall test coverage is at least ${REQUIRED_COVERAGE}%.`);
  }
  if (technologies.outcome === 'manual') {
    const unlisted = technologies.findings.filter(finding => finding.kind === 'runner' && !finding.listed).map(finding => finding.displayName);
    const supported = analysis.area === 'frontend' ? 'Jest' : 'JUnit';
    actions.push(unlisted.length
      ? `A reviewer must decide whether ${listText(unlisted)} is acceptable for unit tests; the supported-technologies page lists ${supported}.`
      : analysis.policy
        ? `Check which technologies the unit tests use and that they are officially supported (${supported}).`
        : 'Fix the supported-technologies list (problems below) and run the evaluation again.');
  }
  return actions.join(' ') || undefined;
}

function sourceLine(record: RemoteEvidenceRecord): string {
  const outcome = record.error
    // The transport's error text already names a plain HTTP status ("HTTP 404.").
    ? `${record.status && !record.error.startsWith('HTTP ') ? `HTTP ${record.status}, ` : ''}${reportText(record.error)}`
    : `HTTP ${record.status}, ${reportText(record.sha256 ?? '')}`;
  return `  - ${reportText(record.url)} (fetched ${reportText(record.fetchedAt.replace(/\.\d{3}Z$/, 'Z'))}; ${outcome})`;
}

/** A SonarCloud percentage as reported: 77.5 reads 77.5%, 80 reads 80.0%, and 79.95 stays 79.95%, never rounded up to 80. */
function percent(value: number): string {
  return `${Number.isInteger(value * 10) ? value.toFixed(1) : String(value)}%`;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function listText(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
