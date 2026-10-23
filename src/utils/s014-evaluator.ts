import {
  EvaluationRun,
  EvaluationStatus,
  ModuleKindResult,
  RemoteEvidenceRecord,
  S014Analysis,
  S014Membership,
  S014ModuleName,
  S014PlatformSnapshot,
  S014TemplateCheck
} from '../types';
import { classifyModuleKind } from './module-kind';
import { sourceLine } from './remote-evidence';
import { count, reportPath, reportText } from './report-text';
import {
  checkApplicationTemplate,
  collectPlatformSnapshot,
  DEFAULT_PLATFORM_REF,
  resolveS014ModuleName
} from './s014-application-assignment';

const PLATFORM = 'FOLIO LSP platform';
const RERUN_HINT = 'Rerun with --allow-remote-lookups';

export interface S014Inputs {
  moduleKind: ModuleKindResult;
  moduleName?: S014ModuleName;
  application?: string;
  platformRef: string;
  remoteLookups: boolean;
  platform?: S014PlatformSnapshot;
  template?: { check: S014TemplateCheck; record?: RemoteEvidenceRecord };
}

/** Gathers S014's local and remote evidence for one evaluation and evaluates it. */
export async function analyzeS014(repoPath: string, run: EvaluationRun): Promise<S014Analysis> {
  const moduleKind = await run.getOrCreateArtifact('moduleKind', () => Promise.resolve(classifyModuleKind(repoPath)));
  const deployable = moduleKind.kind === 'backend-module' || moduleKind.kind === 'ui-module';
  const inputs: S014Inputs = {
    moduleKind,
    moduleName: deployable ? resolveS014ModuleName(repoPath, moduleKind.kind, run.repositoryName) : undefined,
    application: run.s014Application,
    platformRef: run.s014PlatformRef ?? DEFAULT_PLATFORM_REF,
    remoteLookups: Boolean(run.remoteLookups)
  };
  const lookups = run.remoteLookups;
  const name = inputs.moduleName?.name;
  if (!lookups || !name) return evaluateS014(inputs);

  inputs.platform = await run.getOrCreateArtifact('platformMembership', () => collectPlatformSnapshot(lookups, inputs.platformRef));
  const { application } = inputs;
  const platform = inputs.platform;
  const listed = platform.applications.some(item => item.modules?.some(module => module.name === name));
  const complete = !platform.problem && platform.applications.every(item => !item.problem);
  if (application && complete && !listed && !platform.applications.some(item => item.name === application)) {
    inputs.template = await checkApplicationTemplate(lookups, application, name);
  }
  return evaluateS014(inputs);
}

export function evaluateS014(inputs: S014Inputs): S014Analysis {
  const { moduleKind, moduleName, platform } = inputs;
  // --application is validated by the CLI; programmatic callers still cannot shape report rows with it.
  const application = inputs.application === undefined ? undefined : reportText(inputs.application);
  const base: S014Analysis = {
    criterionId: 'S014',
    status: EvaluationStatus.MANUAL,
    summary: '',
    moduleKind: moduleKind.kind,
    moduleName,
    application,
    remoteLookups: inputs.remoteLookups,
    memberships: [],
    unresolvedApplications: [],
    remoteEvidence: [...(platform?.remoteEvidence ?? []), ...(inputs.template?.record ? [inputs.template.record] : [])]
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
    return result(EvaluationStatus.MANUAL, 'The tool could not tell whether this repository is a deployable module or a library, so it did not check which application it belongs to. A reviewer needs to check that it is in exactly one application on the FOLIO LSP platform, the one the evaluation\'s Jira task names.');
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
  base.applicationOnPlatform = application ? platform.applications.some(item => item.name === application) : undefined;
  base.namedApplicationTemplate = inputs.template?.check;
  const memberships = base.memberships;
  const unresolved = base.unresolvedApplications.length;
  const total = base.platform.applicationCount;
  const readable = total - base.unresolvedApplications.filter(item => item.tier).length;
  const notChecked = unresolved ? ` ${count(unresolved, 'other platform application')} could not be checked, but that cannot change this result.` : '';
  const named = application ? `${application}, the application named for this evaluation` : undefined;

  if (memberships.length >= 2) {
    const keep = application && memberships.some(item => item.application === application) ? named : 'one';
    return result(EvaluationStatus.FAIL, `${name} is in ${memberships.length} applications on the ${PLATFORM}: ${applicationList(memberships)}. A module must be in exactly one application; remove it from all but ${keep}.${notChecked}`);
  }
  if (memberships.length === 1 && application && memberships[0].application !== application) {
    const found = applicationLabel(memberships[0]);
    return result(EvaluationStatus.FAIL, `${name} is in ${found} on the ${PLATFORM}, but the application named for this evaluation is ${application}. Move the module to ${application}, or correct --application if the evaluation's Jira task names ${reportText(memberships[0].application)}.${notChecked}`);
  }
  if (unresolved) {
    const found = memberships.length
      ? `${name} is in ${applicationLabel(memberships[0])}, but ${count(unresolved, 'other platform application')} could not be checked, so the tool cannot confirm that it is in no other application.`
      : `${name} is in none of the ${readable} ${PLATFORM} applications the tool could check, and ${count(unresolved, 'application')} could not be checked.`;
    return result(EvaluationStatus.MANUAL, `${found} A reviewer needs to check the applications listed under "Could not check".`);
  }
  if (memberships.length === 1) {
    const found = applicationLabel(memberships[0]);
    return application
      ? result(EvaluationStatus.PASS, `${name} is assigned to exactly one application on the ${PLATFORM}, ${found}, which is the application named for this evaluation.`)
      : result(EvaluationStatus.MANUAL, `${name} is in exactly one platform application, ${found}. Confirm that the evaluation's Jira task names ${reportText(memberships[0].application)}, or rerun with --application ${reportText(memberships[0].application)}.`);
  }

  const none = `${name} is in none of the ${total} applications on the ${PLATFORM}.`;
  if (application && !base.applicationOnPlatform) {
    const template = inputs.template?.check;
    if (template?.listsModule) {
      return result(EvaluationStatus.MANUAL, `${none} It is assigned in ${application}, the application named for this evaluation, which is not yet part of the platform. A reviewer needs to decide whether that assignment is enough.`);
    }
    if (!template || template.problem) {
      return result(EvaluationStatus.MANUAL, `${none} ${application}, the application named for this evaluation, is not part of the platform, and the tool could not read its own repository to see whether it lists the module. A reviewer needs to check.`);
    }
    return result(EvaluationStatus.FAIL, `${none} ${application}, the application named for this evaluation, is not part of the platform, and its own repository does not list the module either. Add the module to exactly one platform application.`);
  }
  return result(EvaluationStatus.FAIL, application
    ? `${none} ${named}, does not list it. Add the module to exactly one platform application, ${application}.`
    : `${none} Add it to exactly one platform application.`);
}

const NAME_SOURCES: Record<NonNullable<S014ModuleName['source']>, string> = {
  descriptor: 'the module descriptor id in',
  pom: 'the artifactId in',
  package: 'the package name in',
  repository: 'the repository name'
};

export function renderS014HumanDetails(analysis: S014Analysis): string {
  const lines: string[] = [];
  const name = analysis.moduleName?.name;
  const action = whatToDo(analysis);
  if (action) lines.push(`What to do: ${action}`);
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
      lines.push(`Named application: ${analysis.application ?? 'not given'} (--application)`);
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
  const template = analysis.namedApplicationTemplate;
  if (template) {
    const file = `${template.application}.template.json in folio-org/${template.application}`;
    lines.push(`Named application template: ${template.problem
      ? `${file} could not be read. ${reportText(template.problem)}`
      : `${file} ${template.listsModule ? 'lists' : 'does not list'} ${name}`}`);
  }
  if (analysis.remoteEvidence.length) lines.push('Sources:', ...analysis.remoteEvidence.map(sourceLine));
  return lines.join('\n');
}

function whatToDo(analysis: S014Analysis): string | undefined {
  if (analysis.status === EvaluationStatus.PASS || analysis.status === EvaluationStatus.NOT_APPLICABLE) return undefined;
  if (!analysis.remoteLookups) {
    return `${RERUN_HINT}${analysis.application ? '' : ' --application <the application the Jira task names>'} so the tool can read the platform-lsp descriptor and FAR, or check by hand that the module is in exactly one platform application and that it is the one the Jira task names.`;
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    return 'Make sure the module is listed in exactly one application on the FOLIO LSP platform, the one the evaluation\'s Jira task names.';
  }
  if (analysis.memberships.length === 1 && !analysis.application && !analysis.unresolvedApplications.length) {
    return `Check that the evaluation's Jira task names ${reportText(analysis.memberships[0].application)}.`;
  }
  return 'Check the platform applications by hand: the module must be in exactly one, the one the evaluation\'s Jira task names.';
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
