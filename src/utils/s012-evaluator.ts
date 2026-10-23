import semver from 'semver';
import {
  BuildFileKind,
  BuildTestEvidence,
  BuildToolId,
  EvaluationStatus,
  FolioSharedWorkflowTable,
  FolioSharedWorkflowTableLoadResult,
  S007PolicyLoadResult,
  S007PolicySection,
  S007TechnologyPolicyEntry,
  S012AnalysisResult,
  S012Finding,
  S012MatchedPolicy,
  S012VersionCheck,
  SharedWorkflowUse,
  VersionDeclaration
} from '../types';
import { policySections } from './s007-policy';
import { compareObservationToConstraint } from './s007-evaluator';
import { displayPolicyPath } from './acceptance-ledger';
import { reportPath, reportText } from './report-text';

const TOOL_NAMES: Record<string, string> = {
  maven: 'Maven',
  gradle: 'Gradle',
  node: 'Node.js',
  yarn: 'Yarn',
  npm: 'npm',
  pnpm: 'pnpm',
  make: 'Make',
  go: 'Go',
  sbt: 'sbt',
  bazel: 'Bazel',
  docker: 'Docker',
  'github-actions': 'GitHub Actions',
  jenkins: 'Jenkins'
};

/** The build file that shows a tool builds this repository. */
const TOOL_FILES: Record<BuildToolId, BuildFileKind[]> = {
  maven: ['maven-pom'],
  gradle: ['gradle-build'],
  node: ['package-json'],
  yarn: ['package-json'],
  npm: ['package-json'],
  pnpm: ['package-json'],
  make: ['makefile'],
  go: ['go-mod'],
  sbt: ['sbt'],
  bazel: ['bazel']
};

const BACKEND_TOOLS: BuildToolId[] = ['maven', 'gradle', 'make', 'go', 'sbt', 'bazel'];
const PACKAGE_MANAGERS: BuildToolId[] = ['yarn', 'npm', 'pnpm'];
const LOCKFILE_MANAGERS: Partial<Record<BuildFileKind, BuildToolId>> = {
  'yarn-lock': 'yarn',
  'yarnrc-yml': 'yarn',
  'package-lock': 'npm',
  'pnpm-lock': 'pnpm'
};
/** Build tools that are not on the supported list in any form, so using one fails S012. */
const UNSUPPORTED_TOOLS = new Set<BuildToolId>(['npm', 'pnpm', 'sbt', 'bazel']);

const DECLARATION_LABELS: Record<VersionDeclaration['source'], string> = {
  'maven-wrapper': 'Maven wrapper',
  'maven-enforcer': 'maven-enforcer-plugin requireMavenVersion',
  'gradle-wrapper': 'Gradle wrapper',
  nvmrc: '.nvmrc',
  'node-version-file': '.node-version',
  'engines-node': 'package.json engines.node',
  'package-manager-field': 'package.json packageManager',
  'yarn-lock': 'yarn.lock format',
  'yarnrc-yarn-path': '.yarnrc.yml yarnPath',
  'workflow-input': 'Workflow input',
  'setup-node': 'Workflow actions/setup-node',
  'setup-maven': 'Workflow Maven setup'
};

interface ToolSignal {
  tool: BuildToolId;
  /** How the build reaches the tool, already made safe for the report. */
  via: string;
  path: string;
  /** The workflow job, for a CI build. */
  job?: string;
  /** A CI build, as opposed to a lockfile or packageManager field. */
  ci?: true;
  shared?: SharedWorkflowUse;
}

export function evaluateS012(
  policyLoad: S007PolicyLoadResult,
  tableLoad: FolioSharedWorkflowTableLoadResult,
  evidence: BuildTestEvidence,
  language: 'java' | 'javascript'
): S012AnalysisResult {
  const area = language === 'javascript' ? 'frontend' : 'backend';
  const base = { criterionId: 'S012' as const, area: area as S012AnalysisResult['area'], evidence, findings: [] as S012Finding[] };
  if (!policyLoad.ok) {
    return {
      ...base,
      status: EvaluationStatus.MANUAL,
      summary: 'S012 manual: The officially supported technologies list (config/officially-supported-technologies.json) could not be loaded, so no build tool was checked. Fix the file and run the evaluation again.',
      policyDiagnostics: policyLoad.diagnostics
    };
  }
  if (!tableLoad.ok) {
    return {
      ...base,
      status: EvaluationStatus.MANUAL,
      summary: "S012 manual: The table of FOLIO's shared workflows (config/folio-shared-workflows.json) could not be loaded, so no build tool was checked. Fix the file and run the evaluation again.",
      policyDiagnostics: tableLoad.diagnostics
    };
  }

  const sections = policySections(policyLoad.policy, 's012', area);
  const table = tableLoad.table;
  const findings = area === 'backend'
    ? backendFindings(evidence, sections, table)
    : frontendFindings(evidence, sections, table);
  findings.push(...ciFindings(evidence, sections, table, area));
  if (!evidence.complete) {
    findings.push(coverageFinding('Some build or workflow files could not be read (see Warnings), so a build tool or version may be missing.'));
  }

  const status = findings.some(finding => finding.contribution === 'fail')
    ? EvaluationStatus.FAIL
    : findings.some(finding => finding.contribution === 'manual') || !findings.some(finding => finding.contribution === 'pass')
      ? EvaluationStatus.MANUAL
      : EvaluationStatus.PASS;
  const deciding = status === EvaluationStatus.FAIL ? 'fail' : status === EvaluationStatus.PASS ? 'pass' : 'manual';
  for (const finding of findings) finding.statusDetermining = finding.contribution === deciding;
  if (status === EvaluationStatus.MANUAL && !findings.some(finding => finding.statusDetermining)) {
    findings.push({ ...coverageFinding('No build tool the tool recognizes was found (no pom.xml, build.gradle, package.json, Makefile or other build file at the repository root or in service/).'), statusDetermining: true });
  }

  const source = policyLoad.policy.source;
  return {
    ...base,
    status: status as S012AnalysisResult['status'],
    summary: summaryFor(status, findings),
    findings,
    policy: {
      sourcePath: displayPolicyPath(policyLoad.sourcePath),
      title: source?.title,
      documentStatus: source?.documentStatus,
      exportDate: source?.exportDate
    },
    sharedWorkflowTable: { sourcePath: displayPolicyPath(tableLoad.sourcePath), ref: table.ref, reviewedAt: table.reviewedAt },
    policyDiagnostics: []
  };
}

// ---- Which tools build the module ----

/** CI evidence: FOLIO shared workflows the table knows, and build commands of inline jobs whose build file exists. */
function ciSignals(evidence: BuildTestEvidence, table: FolioSharedWorkflowTable): ToolSignal[] {
  const signals: ToolSignal[] = [];
  for (const use of knownSharedWorkflows(evidence, table)) {
    signals.push({ tool: table.workflows[use.name].buildTool, via: `FOLIO's ${use.name}@${use.ref} workflow (${reportPath(use.path)})`, path: use.path, job: use.job, ci: true, shared: use });
  }
  for (const command of evidence.buildCommands) {
    if (TOOL_FILES[command.tool].some(kind => hasFile(evidence, kind))) {
      signals.push({ tool: command.tool, via: `"${reportText(command.command)}" in ${reportPath(command.path)}`, path: command.path, job: command.job, ci: true });
    }
  }
  return signals;
}

function knownSharedWorkflows(evidence: BuildTestEvidence, table: FolioSharedWorkflowTable): SharedWorkflowUse[] {
  return evidence.sharedWorkflows.filter(use => use.ref === table.ref && Object.prototype.hasOwnProperty.call(table.workflows, use.name));
}

/**
 * Whether a workflow file (or the CI command list) could not be read in full. Then CI may run a different tool than
 * the build files suggest, so a tool chosen from the build files alone cannot fail the module.
 */
function ciIncomplete(evidence: BuildTestEvidence): boolean {
  return evidence.diagnostics.some(item =>
    item.code === 'file_limit' || item.code === 'command_limit' || (item.path ?? '').startsWith('.github'));
}

/** A failure that depends on which tool builds the module, when unread CI could change that choice, needs review. */
function unlessSelectionUncertain(finding: S012Finding, uncertain: boolean): S012Finding {
  if (!uncertain || finding.contribution !== 'fail') return finding;
  return {
    ...finding,
    classification: 'version-unsettled',
    contribution: 'manual',
    rationale: `${finding.rationale} However, some workflow files could not be read, so a reviewer must check that CI really builds with it.`
  };
}

function backendFindings(evidence: BuildTestEvidence, sections: S007PolicySection[], table: FolioSharedWorkflowTable): S012Finding[] {
  const ci = ciSignals(evidence, table).filter(signal => BACKEND_TOOLS.includes(signal.tool));
  const fromFiles = BACKEND_TOOLS.filter(tool => TOOL_FILES[tool].some(kind => hasFile(evidence, kind)));
  let active = ci.length ? unique(ci.map(signal => signal.tool)) : fromFiles;
  // Go modules build with Make; the policy's Make entry covers them.
  if (active.includes('go') && hasFile(evidence, 'makefile')) active = unique(active.map(tool => tool === 'go' ? 'make' : tool));
  const uncertain = !ci.length && active.length > 1 && ciIncomplete(evidence);

  const findings = active.map(tool =>
    unlessSelectionUncertain(toolFinding(tool, evidence, sections, table, ci.filter(signal => signal.tool === tool)), uncertain));
  const unused = fromFiles.filter(candidate => !active.includes(candidate) && !(candidate === 'go' && active.includes('make')));
  findings.push(...dockerFindings(evidence, sections), ...notUsedFindings(evidence, [
    ...unused.flatMap(tool => TOOL_FILES[tool]),
    'package-json', 'yarn-lock', 'yarnrc-yml', 'package-lock', 'pnpm-lock', 'nvmrc', 'node-version-file'
  ]));
  return findings;
}

function frontendFindings(evidence: BuildTestEvidence, sections: S007PolicySection[], table: FolioSharedWorkflowTable): S012Finding[] {
  const findings: S012Finding[] = [];
  if (hasFile(evidence, 'package-json')) {
    const ci = ciSignals(evidence, table).filter(signal => PACKAGE_MANAGERS.includes(signal.tool));
    const field = evidence.declarations.filter(item => item.source === 'package-manager-field');
    const lockfiles = evidence.files.filter(file => LOCKFILE_MANAGERS[file.kind]);
    const signals = [
      ...ci,
      ...field.map(item => ({ tool: item.tool, via: `packageManager in ${reportPath(item.path)}`, path: item.path })),
      ...lockfiles.map(file => ({ tool: LOCKFILE_MANAGERS[file.kind]!, via: reportPath(file.path), path: file.path }))
    ];
    // CI decides; without CI the packageManager field, and then the lockfiles.
    const deciding = ci.length ? ci : field.length ? signals.slice(ci.length, ci.length + field.length) : signals;
    const active = unique(deciding.map(signal => signal.tool));
    const contrary = signals.filter(signal => !active.includes(signal.tool) || active.length > 1);
    if (active.length === 0) {
      findings.push(manualFinding('package-manager', 'Package manager', 'primary', 'version-unsettled', hasFile(evidence, 'package-json') ? ['package.json'] : [],
        'No lockfile, packageManager field or CI build shows which package manager builds the module, so a reviewer must check that it is Yarn 1.'));
    } else if (contrary.length) {
      findings.push(manualFinding('package-manager', 'Package manager', 'primary', 'conflicting', unique(signals.map(signal => signal.path)),
        `The repository points to more than one package manager (${listText(unique(signals.map(signal => `${TOOL_NAMES[signal.tool]} from ${signal.via}`)))}), so it is not clear which one builds the module. Keep only the files for Yarn 1, the supported one.`));
    } else {
      findings.push(unlessSelectionUncertain(toolFinding(active[0], evidence, sections, table, deciding), !ci.length && ciIncomplete(evidence)));
    }
    findings.push(toolFinding('node', evidence, sections, table, ci));
  }
  findings.push(...dockerFindings(evidence, sections), ...notUsedFindings(evidence, BACKEND_TOOLS.flatMap(tool => TOOL_FILES[tool])));
  return findings;
}

// ---- One build tool ----

function toolFinding(
  tool: BuildToolId,
  evidence: BuildTestEvidence,
  sections: S007PolicySection[],
  table: FolioSharedWorkflowTable,
  signals: ToolSignal[]
): S012Finding {
  const name = TOOL_NAMES[tool];
  const files = tool === 'node'
    ? filesFor(evidence, ['package-json', 'nvmrc', 'node-version-file'])
    : unique([...filesFor(evidence, TOOL_FILES[tool]), ...filesFor(evidence, wrapperKinds(tool))]);
  const toolSignals = tool === 'node' ? signals.filter(signal => signal.shared) : signals.filter(signal => signal.tool === tool);
  // A shared workflow is the build; inline commands are named only when there is none.
  const ciSignalsForTool = toolSignals.filter(signal => signal.ci);
  const shown = ciSignalsForTool.some(signal => signal.shared) ? ciSignalsForTool.filter(signal => signal.shared) : ciSignalsForTool;
  const via = shown.length ? listText(unique(shown.map(signal => signal.via))) : undefined;
  const source = toolSignals.length ? listText(unique(toolSignals.map(signal => signal.via))) : listText(files.map(reportPath));
  const base = { toolId: tool, displayName: name, role: 'primary' as const, files, via, versions: [] as S012VersionCheck[], statusDetermining: false };
  const match = findEntry(sections, tool);

  if (!match) {
    const supported = tool === 'go' ? 'Make' : sections.some(section => section.area === 'frontend') ? 'Yarn 1' : 'Maven';
    return UNSUPPORTED_TOOLS.has(tool)
      ? { ...base, classification: 'unlisted-tool', contribution: 'fail',
        rationale: `The module builds with ${name} (${source}), which is not an officially supported build tool. Build it with ${supported} instead.` }
      : { ...base, classification: 'unlisted-tool', contribution: 'manual',
        rationale: `The module builds with ${name} (${source}), which the supported-technologies page does not list, so a reviewer must decide whether it is acceptable.` };
  }

  const matchedPolicy = toMatchedPolicy(match.entry, match.section);
  const versions = versionChecks(tool, evidence, table, toolSignals, match.entry);
  const withPolicy = { ...base, matchedPolicy, versions };
  const pinned = versions.find(check => check.kind === 'pin' && !check.inherited && !check.activation && check.range);
  if (match.entry.strength === 'provisional' || match.entry.provisional) {
    return { ...withPolicy, classification: 'provisional', contribution: 'manual',
      rationale: `The module builds with ${name}${pinned ? ` ${pinned.range}` : ''}${pinned?.path ? ` (${reportPath(pinned.path)})` : ''}, and the supported-technologies page lists ${name} without settled version guidance ("${match.entry.sourceStatement}"), so a reviewer must confirm it.` };
  }
  if (match.entry.strength === 'contested') {
    return { ...withPolicy, classification: 'contested', contribution: 'manual',
      rationale: `The supported-technologies rule for ${name} ("${match.entry.sourceStatement}") is time-bound or disputed, so a reviewer must decide whether it applies now.` };
  }
  if (match.entry.strength === 'advisory') {
    return { ...withPolicy, classification: 'advisory', contribution: 'manual',
      rationale: `The supported-technologies page only recommends ${name} ("${match.entry.sourceStatement}"), so a reviewer must decide.` };
  }
  if (!match.entry.constraint) {
    return { ...withPolicy, classification: 'compliant', contribution: 'pass', rationale: `${name} is officially supported ("${match.entry.sourceStatement}").` };
  }
  return { ...withPolicy, ...versionVerdict(name, versions, match.entry.sourceStatement) };
}

function wrapperKinds(tool: BuildToolId): BuildFileKind[] {
  if (tool === 'maven') return ['maven-wrapper'];
  if (tool === 'gradle') return ['gradle-wrapper'];
  if (tool === 'yarn') return ['yarn-lock', 'yarnrc-yml'];
  if (tool === 'npm') return ['package-lock'];
  if (tool === 'pnpm') return ['pnpm-lock'];
  return [];
}

/**
 * The repository's version declarations for the tool, each turned into a range and compared with the policy. When
 * the repository pins no version, the shared workflow that builds the module supplies one from the table.
 */
function versionChecks(
  tool: BuildToolId,
  evidence: BuildTestEvidence,
  table: FolioSharedWorkflowTable,
  signals: ToolSignal[],
  entry: S007TechnologyPolicyEntry
): S012VersionCheck[] {
  const compare = (range: string | undefined): S012VersionCheck['comparison'] => range === undefined
    ? 'unresolved'
    : compareObservationToConstraint({ declaredVersion: range, ecosystem: tool === 'node' || tool === 'yarn' ? 'javascript' : 'java' }, entry.constraint);
  // A Node version set in a CI job counts only when that job builds the module: it calls one of the shared build
  // workflows in the table (at any ref), or runs a package-manager build command with package.json present.
  const buildJobs = new Set([
    ...evidence.sharedWorkflows.filter(use => Object.prototype.hasOwnProperty.call(table.workflows, use.name)),
    ...ciSignals(evidence, table).filter(signal => PACKAGE_MANAGERS.includes(signal.tool))
  ].map(item => `${item.path}\0${item.job}`));
  const checks: S012VersionCheck[] = evidence.declarations.filter(item => item.tool === tool).map(item => {
    const { range, kind } = declarationRange(item);
    const notBuildJob = tool === 'node' && item.job !== undefined && !buildJobs.has(`${item.path}\0${item.job}`);
    const activation = item.activation
      ?? (notBuildJob ? { state: 'inactive' as const, reason: `set in job ${item.job}, which does not build the module` } : undefined);
    return { label: DECLARATION_LABELS[item.source], path: item.path, text: item.text, range, kind, comparison: compare(range), activation };
  });
  if (!checks.some(check => check.kind === 'pin' && !check.activation)) {
    for (const use of unique(signals.flatMap(signal => signal.shared ? [signal.shared] : []))) {
      const workflow = table.workflows[use.name];
      const supplied = tool === 'maven' ? workflow.maven : tool === 'yarn' ? workflow.yarn : undefined;
      const text = supplied?.version ?? (tool === 'node' ? workflow.node : undefined);
      if (!text) continue;
      const range = tool === 'node' ? semver.validRange(text) ? text : undefined : text;
      if (checks.some(check => check.inherited && check.text === text)) continue;
      checks.push({
        label: `FOLIO's ${use.name}@${use.ref} workflow`,
        text,
        range,
        kind: 'pin',
        inherited: { workflow: use.name, ref: use.ref, source: supplied?.source, recordedAt: supplied?.recordedAt },
        comparison: compare(range)
      });
    }
  }
  return checks;
}

/**
 * The versions a declaration allows. A pin selects the version the build uses; a requirement only makes the build
 * refuse other versions (Maven Enforcer, engines.node).
 */
export function declarationRange(declaration: Pick<VersionDeclaration, 'source' | 'text'>): { range?: string; kind: 'pin' | 'requirement' } {
  const text = declaration.text.trim();
  switch (declaration.source) {
    case 'maven-wrapper':
      return { range: fullVersion(/apache-maven-(\d+(?:\.\d+){0,2})-(?:bin|src)\.(?:zip|tar\.gz)/.exec(text)?.[1]), kind: 'pin' };
    case 'gradle-wrapper':
      return { range: fullVersion(/gradle-(\d+(?:\.\d+){0,2})(?:-rc-\d+|-milestone-\d+)?-(?:bin|all)\.zip/.exec(text)?.[1]), kind: 'pin' };
    case 'maven-enforcer':
      return { range: mavenRequirementRange(text), kind: 'requirement' };
    case 'setup-maven':
      return { range: fullVersion(/^\d+(?:\.\d+){0,2}$/.test(text) ? text : undefined), kind: 'pin' };
    case 'package-manager-field':
      return { range: semver.valid(text.split('+')[0]) ?? undefined, kind: 'pin' };
    case 'yarn-lock':
      return { range: text === 'v1' ? '1.x' : text === 'berry' ? '>=2.0.0' : undefined, kind: 'pin' };
    case 'yarnrc-yarn-path':
      return { range: /yarn-(\d+\.\d+\.\d+)\.c?js$/.exec(text)?.[1], kind: 'pin' };
    case 'engines-node':
      return { range: semver.validRange(text) ? text : undefined, kind: 'requirement' };
    case 'nvmrc':
    case 'node-version-file':
    case 'workflow-input':
    case 'setup-node': {
      // A Node version written as 22, v22.1.0 or 22.x; lts/* or node name no fixed version.
      const version = text.replace(/^v(?=\d)/, '');
      return { range: /^\d/.test(version) && semver.validRange(version) ? version : undefined, kind: 'pin' };
    }
  }
}

/** Maven version-range semantics: a bare 3.6 means 3.6 or later, [3.9] exactly 3.9, and [a,b) an interval. */
function mavenRequirementRange(text: string): string | undefined {
  if (/^\d+(?:\.\d+){0,2}$/.test(text)) return `>=${fullVersion(text)}`;
  // Split "[a,b),[c,d)" into its intervals by the brackets, then read each bound on its own (no nested quantifiers).
  const ranges: string[] = [];
  let rest = text;
  while (rest) {
    const close = rest.search(/[\])]/);
    if (!/^[[(]/.test(rest) || close === -1) return undefined;
    const body = rest.slice(1, close);
    const comma = body.indexOf(',');
    const bounds = (comma === -1 ? [body] : [body.slice(0, comma), body.slice(comma + 1)]).map(bound => bound.trim());
    if (bounds.some(bound => bound && !/^\d+(?:\.\d+){0,2}$/.test(bound)) || bounds.length > 2 || body.indexOf(',', comma + 1) !== -1) return undefined;
    if (comma === -1) {
      if (rest[0] !== '[' || rest[close] !== ']' || !bounds[0]) return undefined;
      ranges.push(fullVersion(bounds[0])!);
    } else {
      const [lower, upper] = bounds;
      if (!lower && !upper) return undefined;
      ranges.push([
        lower ? `${rest[0] === '[' ? '>=' : '>'}${fullVersion(lower)}` : '',
        upper ? `${rest[close] === ']' ? '<=' : '<'}${fullVersion(upper)}` : ''
      ].filter(Boolean).join(' '));
    }
    rest = rest.slice(close + 1).trim();
    if (rest.startsWith(',')) rest = rest.slice(1).trim();
    else if (rest) return undefined;
  }
  return ranges.length ? ranges.join(' || ') : undefined;
}

function fullVersion(version: string | undefined): string | undefined {
  if (!version) return undefined;
  const parts = version.split('.');
  while (parts.length < 3) parts.push('0');
  return parts.map(Number).join('.');
}

function versionVerdict(
  name: string,
  versions: S012VersionCheck[],
  statement: string
): Pick<S012Finding, 'classification' | 'contribution' | 'rationale'> {
  // An Enforcer rule that does not run is shown but does not count. One whose activation is uncertain cannot help a
  // pass, and if it would reject every supported version, a reviewer must check whether it runs.
  const pins = versions.filter(check => check.kind === 'pin' && !check.activation);
  const requirements = versions.filter(check => check.kind === 'requirement' && !check.activation);
  const uncertainViolation = versions.find(check => check.activation?.state === 'uncertain' && check.comparison === 'noncompliant');
  const where = (check: S012VersionCheck) => check.inherited
    ? `from FOLIO's ${check.inherited.workflow}@${check.inherited.ref} workflow`
    : `in ${reportPath(check.path ?? '')}`;
  const failing = [...requirements, ...pins].filter(check => check.comparison === 'noncompliant');

  const brokenRequirement = requirements.find(check => check.comparison === 'noncompliant');
  if (brokenRequirement || (pins.length && pins.every(check => check.comparison === 'noncompliant'))) {
    const shown = brokenRequirement ?? pins[0];
    const problem = brokenRequirement
      ? `${shown.label} ${where(shown)} accepts only ${name} ${reportText(shown.text)}, and the policy allows none of those versions ("${statement}").`
      : `The module uses ${pinPhrase(name, shown)}, but the policy allows only "${statement}".`;
    return { classification: 'version-violation', contribution: 'fail',
      rationale: `${problem} Change it to a version the policy allows.${failing.length > 1 ? ` ${failing.length - 1} more ${failing.length === 2 ? 'declaration does' : 'declarations do'} not meet it either.` : ''}` };
  }
  if (uncertainViolation) {
    return { classification: 'version-unsettled', contribution: 'manual',
      rationale: `${uncertainViolation.label} in ${reportPath(uncertainViolation.path ?? '')} accepts only ${name} ${reportText(uncertainViolation.text)}, which the policy does not allow ("${statement}"), but ${reportText(uncertainViolation.activation!.reason)}, so a reviewer must check whether the build applies it.` };
  }
  if (pins.some(check => check.comparison === 'noncompliant')) {
    return { classification: 'conflicting', contribution: 'manual',
      rationale: `${name} is set to different versions (${listText(pins.map(check => pinPhrase(name, check)))}), and some are not allowed by the policy ("${statement}"), so it is not clear which one the build uses.` };
  }
  if (pins.length && pins.every(check => check.comparison === 'compliant')) {
    const inherited = pins.find(check => check.inherited);
    return { classification: 'compliant', contribution: 'pass',
      rationale: inherited
        ? `The repository does not pin a ${name} version; ${inheritedText(name, inherited)}. Meets "${statement}".`
        : `${listText(unique(pins.map(check => pinPhrase(name, check))))} ${pins.length === 1 ? 'meets' : 'meet'} "${statement}".` };
  }
  const enforced = requirements.find(check => check.comparison === 'compliant');
  if (enforced) {
    return { classification: 'compliant', contribution: 'pass',
      rationale: `${enforced.label} in ${reportPath(enforced.path ?? '')} makes the build refuse any ${name} version outside "${statement}".` };
  }
  const open = pins.find(check => check.comparison === 'overlap');
  if (open) {
    return { classification: 'version-unsettled', contribution: 'manual',
      rationale: `${name} ${reportText(open.text)} ${where(open)} allows both supported and unsupported versions ("${statement}"), and nothing else settles which one the build uses.` };
  }
  const unreadable = pins.find(check => check.comparison === 'unresolved');
  if (unreadable) {
    return { classification: 'version-unsettled', contribution: 'manual',
      rationale: `The ${name} version ${where(unreadable)} ("${reportText(unreadable.text)}") could not be read as a version, so it cannot be compared with "${statement}".` };
  }
  const loose = requirements.find(check => check.comparison === 'overlap' || check.comparison === 'unresolved');
  return { classification: 'version-unsettled', contribution: 'manual',
    rationale: loose
      ? `${loose.label} in ${reportPath(loose.path ?? '')} (${reportText(loose.text)}) also allows versions outside "${statement}", and neither the repository nor FOLIO's shared workflows settle which ${name} version the build uses.`
      : `Neither the repository nor FOLIO's shared workflows settle which ${name} version the build uses, so it cannot be compared with "${statement}".` };
}

/** A pinned version and where it is set, such as "Maven 3.6.3 in .mvn/wrapper/maven-wrapper.properties". */
function pinPhrase(name: string, check: S012VersionCheck): string {
  if (check.label === 'yarn.lock format' && (check.text === 'v1' || check.text === 'berry')) {
    return `Yarn ${check.text === 'v1' ? '1' : '2 or later'}, as the format of ${reportPath(check.path ?? 'yarn.lock')} shows`;
  }
  const version = check.range && semver.valid(check.range) ? check.range : reportText(check.text);
  return `${name} ${version} ${check.inherited ? `from FOLIO's ${check.inherited.workflow}@${check.inherited.ref} workflow` : `in ${reportPath(check.path ?? '')}`}`;
}

function inheritedText(name: string, check: S012VersionCheck): string {
  const inherited = check.inherited!;
  if (inherited.source) {
    return `FOLIO's ${inherited.workflow}@${inherited.ref} workflow uses its runner's ${name} ${check.text} (${inherited.source}, recorded ${inherited.recordedAt})`;
  }
  return `FOLIO's ${inherited.workflow}@${inherited.ref} workflow installs ${name} ${check.text}`;
}

// ---- CI, Docker and other files ----

function ciFindings(
  evidence: BuildTestEvidence,
  sections: S007PolicySection[],
  table: FolioSharedWorkflowTable,
  area: 'frontend' | 'backend'
): S012Finding[] {
  const findings: S012Finding[] = [];
  const jenkinsfile = filesFor(evidence, ['jenkinsfile']);
  const listed = (id: string) => findEntry(sections, id);
  if (evidence.workflowFiles.length) {
    const uses = evidence.sharedWorkflows.map(use => `${reportPath(use.path)} uses folio-org/.github ${use.name}@${use.ref}`);
    const match = listed('github-actions');
    findings.push(noteFinding('github-actions', 'secondary', evidence.workflowFiles,
      `${uses.length ? listText(unique(uses)) : `${evidence.workflowFiles.length} workflow ${evidence.workflowFiles.length === 1 ? 'file' : 'files'}`}.`
      + (match ? ' Supported.' : ' CI is reported only; the backend build-tool list does not cover it.'), match));
  }
  for (const use of evidence.sharedWorkflows.filter(item => item.ref !== table.ref && ['maven.yml', 'gradle.yml', 'ui.yml'].includes(item.name))) {
    findings.push(noteFinding('shared-workflow-ref', 'secondary', [use.path],
      `${reportPath(use.path)} uses FOLIO's ${use.name}@${use.ref} workflow, which the shared-workflow table (reviewed for ${table.ref}) does not cover, so the tool versions it supplies are not known.`));
  }
  if (jenkinsfile.length) {
    const soleCi = area === 'frontend' && !evidence.workflowFiles.length;
    const match = listed('jenkins');
    findings.push(soleCi
      ? { ...noteFinding('jenkins', 'secondary', jenkinsfile, ''), classification: 'legacy-ci', contribution: 'manual', matchedPolicy: match ? toMatchedPolicy(match.entry, match.section) : undefined,
        rationale: 'The module\'s only CI is Jenkins (Jenkinsfile), and the supported-technologies page lists Jenkins "for legacy projects" only, so a reviewer must decide whether this module counts as legacy.' }
      : noteFinding('jenkins', 'secondary', jenkinsfile, area === 'frontend'
        ? 'Jenkinsfile. The module also has GitHub Actions workflows.'
        : 'Jenkinsfile. CI is reported only; the backend build-tool list does not cover it.', match));
  }
  const inactive = filesFor(evidence, ['jenkinsfile-inactive']);
  if (inactive.length) {
    findings.push({ ...noteFinding('jenkins-inactive', 'incidental', inactive, `${listText(inactive.map(reportPath))}.`), displayName: 'Not used by community CI', classification: 'not-used' });
  }
  return findings;
}

function dockerFindings(evidence: BuildTestEvidence, sections: S007PolicySection[]): S012Finding[] {
  const files = filesFor(evidence, ['dockerfile']);
  if (!files.length) return [];
  const match = findEntry(sections, 'docker');
  return [{
    ...noteFinding('docker', 'secondary', files, match
      ? `${listText(files.map(reportPath))} (supported, advisory). Docker never changes the result.`
      : `${listText(files.map(reportPath))}. The frontend build-tool list does not cover Docker, so it is reported only.`, match),
    classification: match ? 'advisory' : 'note'
  }];
}

const FILE_TOOLS: Partial<Record<BuildFileKind, string>> = {
  'maven-pom': 'Maven',
  'gradle-build': 'Gradle',
  makefile: 'Make',
  'go-mod': 'Go',
  sbt: 'sbt',
  bazel: 'Bazel',
  'package-json': 'Node.js',
  'yarn-lock': 'Yarn',
  'yarnrc-yml': 'Yarn',
  'package-lock': 'npm',
  'pnpm-lock': 'pnpm',
  nvmrc: 'Node.js',
  'node-version-file': 'Node.js'
};

/** Build files of tools the module does not build with, such as a stray package-lock.json next to a Maven build. */
function notUsedFindings(evidence: BuildTestEvidence, kinds: BuildFileKind[]): S012Finding[] {
  const files = evidence.files.filter(file => kinds.includes(file.kind));
  if (!files.length) return [];
  return [{
    ...noteFinding('not-used', 'incidental', files.map(file => file.path),
      `${listText(files.map(file => `${reportPath(file.path)} (${FILE_TOOLS[file.kind]})`))}. Reported only; they do not change the result.`),
    displayName: 'Not used by the build',
    classification: 'not-used'
  }];
}

function noteFinding(
  toolId: string,
  role: S012Finding['role'],
  files: string[],
  rationale: string,
  match?: { entry: S007TechnologyPolicyEntry; section: S007PolicySection }
): S012Finding {
  return {
    toolId,
    displayName: TOOL_NAMES[toolId] ?? 'Shared workflow',
    role,
    classification: 'note',
    contribution: 'note',
    rationale,
    files,
    versions: [],
    matchedPolicy: match ? toMatchedPolicy(match.entry, match.section) : undefined,
    statusDetermining: false
  };
}

function manualFinding(
  toolId: string,
  displayName: string,
  role: S012Finding['role'],
  classification: S012Finding['classification'],
  files: string[],
  rationale: string
): S012Finding {
  return { toolId, displayName, role, classification, contribution: 'manual', rationale, files, versions: [], statusDetermining: false };
}

function coverageFinding(rationale: string): S012Finding {
  return manualFinding('evidence-coverage', 'Repository evidence', 'coverage', 'coverage-incomplete', [], rationale);
}

// ---- Helpers ----

function findEntry(sections: S007PolicySection[], id: string): { entry: S007TechnologyPolicyEntry; section: S007PolicySection } | undefined {
  for (const section of sections) {
    const entry = section.entries.find(candidate => candidate.id === id || candidate.aliases.includes(id));
    if (entry) return { entry, section };
  }
  return undefined;
}

function toMatchedPolicy(entry: S007TechnologyPolicyEntry, section: S007PolicySection): S012MatchedPolicy {
  return {
    sectionId: section.id,
    entryId: entry.id,
    displayName: entry.displayName,
    strength: entry.strength,
    sourceStatement: entry.sourceStatement,
    constraint: entry.constraint
  };
}

function hasFile(evidence: BuildTestEvidence, kind: BuildFileKind): boolean {
  return evidence.files.some(file => file.kind === kind);
}

function filesFor(evidence: BuildTestEvidence, kinds: BuildFileKind[]): string[] {
  return evidence.files.filter(file => kinds.includes(file.kind)).map(file => file.path);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function listText(items: string[]): string {
  const shown = items.length > 4 ? [...items.slice(0, 3), `${items.length - 3} more`] : items;
  if (shown.length <= 2) return shown.join(' and ');
  return `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
}

const REVIEW_REASONS: Partial<Record<S012Finding['classification'], string>> = {
  'unlisted-tool': 'not on the supported list',
  'version-unsettled': 'the version is not settled',
  conflicting: 'conflicting evidence',
  provisional: 'the policy has no settled guidance',
  contested: 'the policy rule is disputed',
  advisory: 'the policy only recommends it',
  'legacy-ci': 'Jenkins is supported for legacy projects only',
  'coverage-incomplete': 'some files could not be read'
};

function summaryFor(status: EvaluationStatus, findings: S012Finding[]): string {
  const deciding = findings.filter(finding => finding.statusDetermining);
  if (status === EvaluationStatus.FAIL) {
    const more = deciding.length > 1 ? ` ${deciding.length - 1} more ${deciding.length === 2 ? 'problem is' : 'problems are'} listed below.` : '';
    return `S012 fail: ${deciding[0].rationale}${more}`;
  }
  if (status === EvaluationStatus.PASS) {
    const names = deciding.filter(finding => finding.role === 'primary').map(finding => finding.displayName);
    const shared = deciding.filter(finding => finding.role === 'primary').every(finding => finding.via?.startsWith("FOLIO's"));
    return `S012 pass: The module builds with ${listText(names)}${shared ? " through FOLIO's shared GitHub Actions workflow" : ''}, and `
      + `${names.length === 1 ? `${names[0]} is an officially supported build tool` : `${names.length === 2 ? 'both' : 'all'} are officially supported build tools`}.`;
  }
  if (deciding.length === 1) return `S012 manual: ${deciding[0].rationale}`;
  return `S012 manual: No unsupported build tool was found, but a reviewer needs to check ${listText(unique(deciding.map(finding =>
    `${finding.displayName} (${REVIEW_REASONS[finding.classification] ?? 'see below'})`)))}.`;
}
