import {
  EvaluationRun,
  EvaluationStatus,
  ModuleKindResult,
  S014Analysis,
  S014Membership,
  S014ModuleName,
  S014PlatformSnapshot
} from '../types';
import { getModuleKind } from './module-kind';
import { sourceLine } from './remote-evidence';
import { count, reportPath, reportText } from './report-text';
import {
  collectPlatformSnapshot,
  DEFAULT_PLATFORM_REF,
  resolveS014ModuleName
} from './s014-application-assignment';

const PLATFORM = 'FOLIO LSP platform';
const RERUN_HINT = 'Rerun with --allow-remote-lookups';

export interface S014Inputs {
  moduleKind: ModuleKindResult;
  moduleName?: S014ModuleName;
  platformRef: string;
  remoteLookups: boolean;
  platform?: S014PlatformSnapshot;
}

/** Gathers S014's local and remote evidence for one evaluation and evaluates it. */
export async function analyzeS014(repoPath: string, run: EvaluationRun): Promise<S014Analysis> {
  const moduleKind = await getModuleKind(run, repoPath);
  const deployable = moduleKind.kind === 'backend-module' || moduleKind.kind === 'ui-module';
  const inputs: S014Inputs = {
    moduleKind,
    moduleName: deployable ? resolveS014ModuleName(repoPath, moduleKind.kind, run.repositoryName) : undefined,
    platformRef: run.s014PlatformRef ?? DEFAULT_PLATFORM_REF,
    remoteLookups: Boolean(run.remoteLookups)
  };
  const lookups = run.remoteLookups;
  const name = inputs.moduleName?.name;
  if (!lookups || !name) return evaluateS014(inputs);

  inputs.platform = await run.getOrCreateArtifact('platformMembership', () => collectPlatformSnapshot(lookups, inputs.platformRef));
  return evaluateS014(inputs);
}

export function evaluateS014(inputs: S014Inputs): S014Analysis {
  const { moduleKind, moduleName, platform } = inputs;
  const base: S014Analysis = {
    criterionId: 'S014',
    status: EvaluationStatus.MANUAL,
    summary: '',
    moduleKind: moduleKind.kind,
    moduleName,
    remoteLookups: inputs.remoteLookups,
    memberships: [],
    unresolvedApplications: [],
    remoteEvidence: [...(platform?.remoteEvidence ?? [])]
  };
  const result = (status: EvaluationStatus, summary: string): S014Analysis => ({ ...base, status, summary: `S014 ${statusLabel(status)}: ${summary}` });
  const name = moduleName?.name;
  const subject = name ?? 'the module';

  if (moduleKind.kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'This repository is a FOLIO library, not a deployable module, so it is not assigned to an application.');
  }
  if (!inputs.remoteLookups) {
    return result(EvaluationStatus.MANUAL, `Not checked: remote lookups are off. ${RERUN_HINT} to check which ${PLATFORM} applications list ${subject}.`);
  }
  if (moduleKind.kind === 'ambiguous') {
    return result(EvaluationStatus.MANUAL, 'The tool could not tell whether this repository is a deployable module or a library, so it did not check which application it belongs to. A reviewer needs to check that it is in exactly one application on the FOLIO LSP platform.');
  }
  if (!name || !platform) {
    return result(EvaluationStatus.MANUAL, `${moduleName?.problem ?? 'The tool could not tell the module name.'} A reviewer needs to check which ${PLATFORM} applications list the module.`);
  }
  base.platform = {
    ref: platform.platformRef,
    commit: platform.platformCommit,
    version: platform.platformVersion,
    applicationCount: platform.applications.filter(item => item.tier).length,
    problem: platform.problem
  };
  if (platform.problem) {
    return result(EvaluationStatus.MANUAL, `${reportText(platform.problem)} A reviewer needs to check which ${PLATFORM} applications list ${name}.`);
  }

  for (const item of platform.applications) {
    const entry = item.modules?.find(module => module.name === name);
    if (entry && item.version && item.tier) {
      base.memberships.push({ application: item.name, version: item.version, tier: item.tier, moduleVersion: entry.version });
    } else if (item.problem) {
      base.unresolvedApplications.push({ name: item.name, version: item.version, tier: item.tier, problem: item.problem });
    }
  }
  const memberships = base.memberships;
  const unresolved = base.unresolvedApplications.length;
  const total = base.platform.applicationCount;
  const readable = total - base.unresolvedApplications.filter(item => item.tier).length;
  const notChecked = unresolved ? ` ${count(unresolved, 'other platform application')} could not be checked, but that cannot change this result.` : '';

  if (memberships.length >= 2) {
    return result(EvaluationStatus.FAIL, `${name} is in ${memberships.length} applications on the ${PLATFORM}: ${applicationList(memberships)}. A module must be in exactly one application; remove it from all but one.${notChecked}`);
  }
  if (unresolved) {
    const found = memberships.length
      ? `${name} is in ${applicationLabel(memberships[0])}, but ${count(unresolved, 'other platform application')} could not be checked, so the tool cannot confirm that it is in no other application.`
      : `${name} is in none of the ${readable} ${PLATFORM} applications the tool could check, and ${count(unresolved, 'application')} could not be checked.`;
    return result(EvaluationStatus.MANUAL, `${found} A reviewer needs to check the applications listed under "Could not check".`);
  }
  if (memberships.length === 1) {
    const found = applicationLabel(memberships[0]);
    return result(EvaluationStatus.PASS, `${name} is assigned to exactly one application on the ${PLATFORM}, ${found}.`);
  }
  return result(EvaluationStatus.FAIL, `${name} is in none of the ${total} applications on the ${PLATFORM}. Add it to exactly one platform application.`);
}

const NAME_SOURCES: Record<NonNullable<S014ModuleName['source']>, string> = {
  descriptor: 'the module descriptor id in',
  pom: 'the artifactId in',
  package: 'the package name in',
  repository: 'the repository name'
};

export function renderS014HumanDetails(analysis: S014Analysis): string {
  const lines = [`What to do: ${whatToDo(analysis)}`];
  const name = analysis.moduleName?.name;
  if (analysis.moduleKind === 'library') return [...lines, 'Repository kind: library'].join('\n');

  if (name) {
    const source = analysis.moduleName!.source!;
    lines.push(`Module name: ${name} (from ${NAME_SOURCES[source]}${analysis.moduleName!.path ? ` ${reportPath(analysis.moduleName!.path)}` : ''})`);
  }
  const platform = analysis.platform;
  if (platform) {
    const at = platform.commit ? ` at ${platform.commit.slice(0, 7)}` : '';
    const version = platform.version ? ` (${reportText(platform.version)})` : '';
    const ref = /^[0-9a-f]{40}$/.test(platform.ref) ? '' : ` ${reportText(platform.ref)}`;
    lines.push(`Platform: folio-org/platform-lsp${ref}${at}${version}${platform.problem ? ', not read' : ''}`);
    if (!platform.problem) {
      const unread = analysis.unresolvedApplications.filter(item => item.tier).length;
      const read = unread ? `${platform.applicationCount - unread} read from FAR, ${unread} could not be read` : 'each read from FAR';
      lines.push(`Applications checked: ${platform.applicationCount} (${read}). Applications outside the platform, such as app-platform-full, are not counted.`);
      if (!analysis.memberships.length) lines.push(`Listed in: no platform application${analysis.unresolvedApplications.length ? ' the tool could read' : ''}`);
      else lines.push('Listed in:', ...analysis.memberships.map(membership =>
        `  - ${applicationLabel(membership, true)}: ${name} ${reportText(membership.moduleVersion)}`));
    }
  }
  if (analysis.unresolvedApplications.length) {
    lines.push('Could not check:');
    for (const item of analysis.unresolvedApplications) {
      const label = [reportText(item.name), item.version && reportText(item.version), item.tier && `(${item.tier})`].filter(Boolean).join(' ');
      lines.push(`  - ${label}: ${reportText(item.problem)}`);
    }
  }
  if (analysis.remoteEvidence.length) lines.push('Sources:', ...analysis.remoteEvidence.map(sourceLine));
  return lines.join('\n');
}

function whatToDo(analysis: S014Analysis): string {
  if (analysis.status === EvaluationStatus.NOT_APPLICABLE) return 'Nothing; S014 does not apply to FOLIO libraries.';
  if (analysis.status === EvaluationStatus.PASS) {
    return `Nothing; the module is in exactly one platform application, ${reportText(analysis.memberships[0].application)}.`;
  }
  if (!analysis.remoteLookups) {
    return `${RERUN_HINT} so the tool can read the platform-lsp descriptor and FAR, or check by hand that the module is in exactly one platform application.`;
  }
  if (analysis.status === EvaluationStatus.FAIL) return 'Make sure the module is listed in exactly one application on the FOLIO LSP platform.';
  return 'Check the platform applications by hand: the module must be in exactly one.';
}

function applicationLabel(membership: S014Membership, withVersion = false): string {
  const name = reportText(membership.application);
  if (withVersion) return `${name} ${reportText(membership.version)} (${membership.tier})`;
  return membership.tier === 'experimental' ? `${name} (an experimental application)` : name;
}

function applicationList(memberships: S014Membership[]): string {
  const names = memberships.map(item => applicationLabel(item));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

function statusLabel(status: EvaluationStatus): string {
  return status === EvaluationStatus.NOT_APPLICABLE ? 'not applicable' : status;
}
