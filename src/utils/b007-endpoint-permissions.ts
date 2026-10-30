import {
  B007Analysis,
  B007Basis,
  B007Endpoint,
  B007Finding,
  B007NamingProblem,
  B007Problem,
  BackendEvidence,
  CriterionAgentReviewResult,
  EvaluationStatus,
  FrontendChecklistItem
} from '../types';
import { backendBrowse, numberBackendObligations, providedInterfaceSubjects } from './backend-agent-review';
import { templateLineOf } from './backend-evidence';
import { isSystemInterface } from './descriptor-handlers';
import { FrontendChecklistItemDraft } from './frontend-agent-review';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { count, listText, overflowLine, reportPath, reportText, unique } from './report-text';
import { isRecord } from './type-guards';

const MAX_ROWS = 20;
const ALL = /\.all$/;
const WORDS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// https://folio-org.atlassian.net/wiki/x/BgDtY: backend permissions end with an HTTP-like action; broad sets with `all`.
const ACTIONS = new Set(['get', 'post', 'put', 'patch', 'delete', 'execute', 'all']);
const ROOT_PROJECT = /^[ \t]*rootProject\.name[ \t]*=[ \t]*["']([^"'\n]+)["']/m;
const FAILING: B007Problem[] = ['all-required', 'undefined-required'];

const NAMING_NOTES: Record<B007NamingProblem, (prefix?: string) => string> = {
  prefix: prefix => `does not start with ${prefix}`,
  'word-format': () => 'a term is not lowercase words joined by hyphens',
  action: () => 'does not end with an action'
};

/**
 * B007 (endpoints protected with appropriate permissions) reads each handler of the descriptor template's non-system
 * interfaces. It fails when a handler requires a `*.all` permission or one no permission set defines (Q7); otherwise
 * it is manual, because whether each permission fits its endpoint needs a reviewer.
 */
export function evaluateB007(evidence: BackendEvidence): B007Analysis {
  const { kind, template } = evidence;
  const browse = backendBrowse();
  const base = { criterionId: 'B007' as const, kind, endpoints: [], definedPermissionCount: 0, definitionsChecked: false, placeholderPermissions: [], findings: [],
    namingDeviations: [], unreadable: [], agentBrowseScope: browse.scope };
  const result = (status: EvaluationStatus, basis: B007Basis, summary: string, items: FrontendChecklistItem[], extra: Partial<B007Analysis> = {}): B007Analysis =>
    ({ ...base, ...extra, status, basis, summary: `B007 ${status}: ${summary}`, checklist: frontendChecklist(status, items) });

  if (kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'library', 'The repository is a shared library, which provides no endpoints of its own.', []);
  }
  if (!template?.descriptor) {
    return result(EvaluationStatus.MANUAL, 'no-descriptor',
      `${kind === 'ambiguous' ? 'No module descriptor template was found' : 'The module descriptor template could not be read'}, so the module's endpoints and their permissions are not known (see B001).`,
      [{ id: 'B007-C1', title: FIT_TITLE, startingPoints: [], reviewerOnly: true, obligations: [] }]);
  }

  const descriptor = isRecord(template.descriptor) ? template.descriptor : {};
  const lineOf = templateLineOf(template);
  const at = (pointer: string) => {
    const line = lineOf(pointer);
    return line ? { line } : {};
  };
  const endpoints: B007Endpoint[] = [];
  const findings: B007Finding[] = [];
  const provides = Array.isArray(descriptor.provides) ? descriptor.provides : [];
  const unreadable: string[] = descriptor.provides === undefined || Array.isArray(descriptor.provides) ? [] : ['/provides'];
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const readable = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
  const unresolved = new Set(template.placeholders.filter(placeholder => placeholder.value === undefined).flatMap(placeholder => placeholder.pointers));
  const placeholderPermissions: string[] = [];

  const permissionSets = descriptor.permissionSets;
  if (permissionSets !== undefined && !Array.isArray(permissionSets)) unreadable.push('/permissionSets');
  const definitions = (Array.isArray(permissionSets) ? permissionSets : []).flatMap((set, index) => {
    if (!isRecord(set) || typeof set.permissionName !== 'string') {
      unreadable.push(`/permissionSets/${index}`);
      return [];
    }
    const placeholder = unresolved.has(`/permissionSets/${index}/permissionName`);
    if (placeholder) placeholderPermissions.push(set.permissionName);
    return [{ permission: set.permissionName, placeholder, ...at(`/permissionSets/${index}`) }];
  });
  const defined = new Set(definitions.map(definition => definition.permission));
  const definitionGaps = [...unreadable];
  const definitionsComplete = !definitionGaps.length && !placeholderPermissions.length;

  provides.forEach((provided, interfaceIndex) => {
    if (!isRecord(provided)) {
      unreadable.push(`/provides/${interfaceIndex}`);
      return;
    }
    if (isSystemInterface(provided) || provided.handlers === undefined) return;
    if (!Array.isArray(provided.handlers)) {
      unreadable.push(`/provides/${interfaceIndex}/handlers`);
      return;
    }
    provided.handlers.forEach((handler, handlerIndex) => {
      const pointer = `/provides/${interfaceIndex}/handlers/${handlerIndex}`;
      if (!isRecord(handler)) {
        unreadable.push(pointer);
        return;
      }
      const required = strings(handler.permissionsRequired);
      const modulePermissions = strings(handler.modulePermissions);
      const endpoint: B007Endpoint = {
        interfaceId: String(provided.id),
        methods: strings(handler.methods),
        path: typeof handler.pathPattern === 'string' ? handler.pathPattern : typeof handler.path === 'string' ? handler.path : '',
        pointer,
        ...at(pointer),
        ...(handler.permissionsRequired !== undefined ? { permissionsRequired: required } : {}),
        modulePermissions
      };
      endpoints.push(endpoint);
      const finding = (problem: B007Problem, extra: Partial<B007Finding> = {}) => findings.push({ ...endpoint, problem, ...extra });
      if ((handler.permissionsRequired !== undefined && !readable(handler.permissionsRequired))
        || (handler.modulePermissions !== undefined && !readable(handler.modulePermissions))) {
        finding('unreadable');
        unreadable.push(pointer);
      }
      if (handler.permissionsRequired === undefined) finding('no-permission', { missing: true });
      else if (Array.isArray(handler.permissionsRequired) && handler.permissionsRequired.length === 0) finding('no-permission', { missing: false });
      const checked = new Set<string>();
      (Array.isArray(handler.permissionsRequired) ? handler.permissionsRequired : []).forEach((permission: unknown, index) => {
        if (typeof permission !== 'string' || checked.has(permission)) return;
        checked.add(permission);
        if (ALL.test(permission)) finding('all-required', { permission });
        else if (unresolved.has(`${pointer}/permissionsRequired/${index}`)) placeholderPermissions.push(permission);
        else if (definitionsComplete && !defined.has(permission)) finding('undefined-required', { permission });
      });
      for (const permission of unique(modulePermissions).filter(name => ALL.test(name))) finding('all-module-permission', { permission });
    });
  });

  const { prefix, source } = permissionPrefix(evidence);
  const namingDeviations = definitions.filter(definition => !definition.placeholder).flatMap(({ permission, line }) => {
    const terms = permission.split('.');
    const problems: B007NamingProblem[] = [];
    if (prefix !== undefined && terms[0] !== prefix) problems.push('prefix');
    if (!terms.every(term => WORDS.test(term))) problems.push('word-format');
    if (!ACTIONS.has(terms[terms.length - 1])) problems.push('action');
    return problems.length ? [{ permission, problems, ...(line ? { line } : {}) }] : [];
  });
  const facts: Partial<B007Analysis> = {
    templatePath: template.path,
    ...(prefix !== undefined ? { permissionPrefix: prefix, permissionPrefixSource: source } : {}),
    endpoints, definedPermissionCount: defined.size, definitionsChecked: definitionsComplete, placeholderPermissions: unique(placeholderPermissions), findings, namingDeviations,
    unreadable: unreadable.map(pointer => ({ pointer, ...at(pointer) }))
  };

  if (!endpoints.length && !unreadable.length) {
    return result(EvaluationStatus.NOT_APPLICABLE, 'no-endpoints',
      `${reportPath(template.path)} provides no endpoints other than those of system interfaces.`, [], facts);
  }

  const having = (problem: B007Problem) => findings.filter(item => item.problem === problem);
  const allRequired = having('all-required');
  const undefinedRequired = having('undefined-required');
  const publicEndpoints = having('no-permission');
  const allModule = having('all-module-permission');
  const endpointCount = (list: Array<{ pointer: string }>) => unique(list.map(item => item.pointer)).length;
  const sentences: string[] = [];
  if (allRequired.length) {
    sentences.push(`${endpointCount(allRequired) === 1 ? 'An endpoint requires' : `${endpointCount(allRequired)} endpoints require`} ${allRequired.length === 1 ? 'a *.all permission' : '*.all permissions'}: `
      + `${listText(allRequired.map(withPermission))}; a *.all permission grants a whole module's permissions, so an endpoint should require only what it needs.`);
  }
  if (undefinedRequired.length) {
    sentences.push(`${endpointCount(undefinedRequired) === 1 ? 'An endpoint requires' : `${endpointCount(undefinedRequired)} endpoints require`} `
      + `${undefinedRequired.length === 1 ? 'a permission' : 'permissions'} that no permission set in the template defines: ${listText(undefinedRequired.map(withPermission))}.`);
  }
  const unreadPointers = new Set(unreadable);
  const withPermissions = endpoints.filter(endpoint => endpoint.permissionsRequired?.length && !unreadPointers.has(endpoint.pointer));
  if (!allRequired.length && !undefinedRequired.length && withPermissions.length) {
    const readNote = withPermissions.length < endpoints.length - endpointCount(publicEndpoints) ? ' whose permissions the tool could read' : '';
    sentences.push(!definitionsComplete
      ? withPermissions.length === endpoints.length && endpoints.length === 1 ? 'The endpoint does not require a *.all permission.' : `No endpoint${readNote} requires a *.all permission.`
      : withPermissions.length === endpoints.length
        ? endpoints.length === 1 ? 'The endpoint requires a permission that a permission set defines, and not a *.all permission.'
          : `Each of the ${endpoints.length} endpoints requires a permission that a permission set defines, and none requires a *.all permission.`
        : `Every endpoint${readNote} that requires a permission requires one that a permission set defines, and none requires a *.all permission.`);
  }
  const placeholders = unique(placeholderPermissions);
  if (placeholders.length) {
    sentences.push(`The tool could not check that the required permissions are defined, because ${placeholders.length === 1 ? 'the permission' : 'the permissions'} ${listText(placeholders.map(reportText))} `
      + `${placeholders.length === 1 ? 'has a build placeholder' : 'have build placeholders'} the build properties do not define.`);
  }
  if (publicEndpoints.length) {
    sentences.push(`${publicEndpoints.length === 1 ? 'An endpoint requires' : `${publicEndpoints.length} endpoints require`} no permission: ${listText(publicEndpoints.map(endpointLabel))}.`);
  }
  if (allModule.length) {
    sentences.push(`${endpointCount(allModule) === 1 ? 'An endpoint has' : `${endpointCount(allModule)} endpoints have`} ${allModule.length === 1 ? 'a *.all module permission' : '*.all module permissions'}: ${listText(allModule.map(withPermission))}.`);
  }
  if (definitionGaps.length) {
    sentences.push(`The tool could not read ${listText(definitionGaps)} in the template (see B001), so it could not check that the required permissions are defined.`);
  }
  const handlerGaps = unreadable.filter(pointer => !pointer.startsWith('/permissionSets'));
  if (handlerGaps.length) {
    sentences.push(`The tool could not read the permissions at ${listText(handlerGaps)} in the template (see B001).`);
  }
  if (namingDeviations.length) {
    const counted = (problem: B007NamingProblem, text: string) => {
      const matching = namingDeviations.filter(item => item.problems.includes(problem)).length;
      return matching ? [`${matching} ${text}`] : [];
    };
    sentences.push(`${count(namingDeviations.length, 'permission name')} ${namingDeviations.length === 1 ? 'departs' : 'depart'} from the permission naming guidelines: ${listText([
      ...counted('prefix', `${namingDeviations.filter(item => item.problems.includes('prefix')).length === 1 ? 'does' : 'do'} not start with the module name ${reportText(prefix ?? '')}`),
      ...counted('word-format', `${namingDeviations.filter(item => item.problems.includes('word-format')).length === 1 ? 'is' : 'are'} not lowercase words joined by hyphens, such as camelCase`),
      ...counted('action', `${namingDeviations.filter(item => item.problems.includes('action')).length === 1 ? 'does' : 'do'} not end with an action (get, post, put, patch, delete or execute) or all`)
    ])}.`);
  }

  const status = allRequired.length || undefinedRequired.length ? EvaluationStatus.FAIL : EvaluationStatus.MANUAL;
  if (status === EvaluationStatus.MANUAL) sentences.push('A reviewer must judge whether the permissions fit the endpoints.');

  const interfaceOf = (item: { pointer: string }) => Number(item.pointer.split('/')[2]);
  const interfacesWith = (list: Array<{ pointer: string }>) => new Set(list.map(interfaceOf));
  const endpointCounts = new Map<number, number>();
  for (const endpoint of endpoints) endpointCounts.set(interfaceOf(endpoint), (endpointCounts.get(interfaceOf(endpoint)) ?? 0) + 1);
  const subjects = providedInterfaceSubjects(template).filter(entry => endpointCounts.has(entry.index));
  const failing = interfacesWith(findings.filter(item => FAILING.includes(item.problem)));
  const unreadableInterfaces = interfacesWith(findings.filter(item => item.problem === 'unreadable'));
  const publicInterfaces = interfacesWith(publicEndpoints);
  const allModuleInterfaces = interfacesWith(allModule);
  const subject = (entry: typeof subjects[number], flag?: 'fail' | 'manual') => ({
    subject: entry.subject, path: entry.path, ...(entry.line ? { line: entry.line } : {}), ...(flag ? { flag } : {})
  });
  const items: FrontendChecklistItemDraft[] = [{
    id: 'B007-C1', title: FIT_TITLE, reviewerOnly: !subjects.length, obligations: [],
    startingPoints: subjects.map(entry => ({ path: entry.path, ...(entry.line ? { line: entry.line } : {}),
      note: `interface ${reportText(entry.interfaceId)}: ${count(endpointCounts.get(entry.index)!, 'endpoint')}` })),
    subjects: subjects.map(entry => subject(entry, failing.has(entry.index) ? 'fail' : unreadableInterfaces.has(entry.index) ? 'manual' : undefined))
  }];
  if (publicEndpoints.length) {
    items.push({
      id: 'B007-C2', title: 'Each endpoint without a permission is meant to be public, and exposes or changes no tenant data.', reviewerOnly: false, obligations: [],
      startingPoints: publicEndpoints.map(item => ({ path: template.path, ...(item.line ? { line: item.line } : {}),
        note: `${endpointLabel(item)}: permissionsRequired ${item.missing ? 'is missing' : 'is empty'}` })),
      subjects: subjects.filter(entry => publicInterfaces.has(entry.index)).map(entry => subject(entry, 'manual'))
    });
  }
  items.push({
    id: 'B007-C3', title: 'Each endpoint\'s modulePermissions cover every interface its implementation calls, without *.all permissions.', reviewerOnly: !subjects.length, obligations: [],
    startingPoints: allModule.map(item => ({ path: template.path, ...(item.line ? { line: item.line } : {}), note: `${endpointLabel(item)}: module permission ${reportText(item.permission!)}` })),
    subjects: subjects.map(entry => subject(entry, allModuleInterfaces.has(entry.index) ? 'manual' : undefined))
  });
  if (namingDeviations.length) {
    items.push({
      id: 'B007-C4', title: NAMING_TITLE, reviewerOnly: true, obligations: [], subjects: [],
      startingPoints: namingDeviations.map(item => ({ path: template.path, ...(item.line ? { line: item.line } : {}), note: namingNote(item, prefix) }))
    });
  }
  return result(status, 'endpoints-checked', sentences.join(' '), numberBackendObligations(items), facts);
}

const FIT_TITLE = 'Each endpoint\'s permission fits what it does: a read permission for a read and a write permission for a write, an item permission for one record and a collection permission for many.';
const NAMING_TITLE = 'Permission names follow the permission naming guidelines (https://folio-org.atlassian.net/wiki/x/BgDtY): <module>.<resource>.<scope>.<action>, '
  + 'each term lowercase words joined by hyphens, ending with get, post, put, patch, delete or execute, or all for a broad permission set.';

export function renderB007HumanDetails(analysis: B007Analysis, agentReview?: CriterionAgentReviewResult): string {
  const lines: string[] = [];
  if (analysis.templatePath) {
    const interfaces = unique(analysis.endpoints.map(endpoint => endpoint.pointer.split('/')[2])).length;
    lines.push(`Endpoints: ${analysis.endpoints.length} in ${count(interfaces, 'interface')} of ${reportPath(analysis.templatePath)}, without system interfaces`,
      `Permissions defined in permissionSets: ${analysis.definedPermissionCount}${analysis.definitionsChecked ? '' : ' (not all could be read)'}`);
  }
  const section = (heading: string, problem: B007Problem, describe: (finding: B007Finding) => string) => {
    const list = analysis.findings.filter(finding => finding.problem === problem);
    if (!list.length) return;
    lines.push(`${heading}:`, ...list.slice(0, MAX_ROWS).map(finding =>
      `  - ${describe(finding)} — ${reportPath(analysis.templatePath!)}${finding.line ? `:${finding.line}` : ''}`), ...overflowLine(list.length, MAX_ROWS, '  '));
  };
  section('Endpoints that require a *.all permission', 'all-required', withPermission);
  section('Endpoints that require a permission no permission set defines', 'undefined-required', withPermission);
  section('Endpoints that require no permission', 'no-permission', finding => `${endpointLabel(finding)}: permissionsRequired ${finding.missing ? 'is missing' : 'is empty'}`);
  section('Endpoints with a *.all module permission', 'all-module-permission', withPermission);
  if (analysis.unreadable.length) {
    lines.push('What the tool could not read:', ...analysis.unreadable.slice(0, MAX_ROWS).map(item =>
      `  - ${item.pointer} — ${reportPath(analysis.templatePath!)}${item.line ? `:${item.line}` : ''}`), ...overflowLine(analysis.unreadable.length, MAX_ROWS, '  '));
  }
  if (analysis.templatePath) {
    lines.push(`Module name for permission names: ${analysis.permissionPrefix !== undefined
      ? `${reportText(analysis.permissionPrefix)} (from ${reportText(analysis.permissionPrefixSource ?? '')})`
      : 'not found in pom.xml or settings.gradle, so names are not checked for it'}`);
    if (analysis.namingDeviations.length) {
      lines.push(`Permission names that depart from the naming guidelines: ${analysis.namingDeviations.length}, listed under B007-C4`);
    }
  }
  if (agentReview) lines.push(`Agent review scope: ${reportText(analysis.agentBrowseScope)}`);
  if (analysis.status === EvaluationStatus.FAIL) {
    const all = analysis.findings.some(finding => finding.problem === 'all-required');
    const undefinedRequired = analysis.findings.some(finding => finding.problem === 'undefined-required');
    lines.push('What to do:', `  - ${[
      ...(all ? ['Give each endpoint listed under "Endpoints that require a *.all permission" a permission for what it does'] : []),
      ...(undefinedRequired ? [`${all ? 'define' : 'Define'} each permission listed under "Endpoints that require a permission no permission set defines" in permissionSets, or require a defined one`] : [])
    ].join(', and ')}.`);
  }
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

/** The module name permission names start with: the root pom.xml artifactId, or Gradle's rootProject.name, without `mod-`. */
function permissionPrefix(evidence: BackendEvidence): { prefix?: string; source?: string } {
  if (evidence.artifactId) return { prefix: evidence.artifactId.replace(/^mod-/, ''), source: `pom.xml artifactId ${evidence.artifactId}` };
  const directories = (evidence.template?.path ?? '').split('/').slice(0, -1).map((_part, index, parts) => parts.slice(0, parts.length - index).join('/'));
  for (const directory of [...directories, '']) {
    for (const name of ['settings.gradle', 'settings.gradle.kts']) {
      const file = evidence.snapshot.files.find(candidate => candidate.path === (directory ? `${directory}/${name}` : name));
      const project = file && ROOT_PROJECT.exec(file.content)?.[1];
      if (project) return { prefix: project.replace(/^mod-/, ''), source: `${file.path} rootProject.name ${project}` };
    }
  }
  return {};
}

function endpointLabel(endpoint: Pick<B007Endpoint, 'methods' | 'path' | 'pointer'>): string {
  const path = endpoint.path ? reportText(endpoint.path) : `(no path at ${endpoint.pointer})`;
  return endpoint.methods.length ? `${endpoint.methods.map(reportText).join(', ')} ${path}` : path;
}

function withPermission(finding: B007Finding): string {
  return `${endpointLabel(finding)} (${reportText(finding.permission ?? '')})`;
}

function namingNote(item: B007Analysis['namingDeviations'][number], prefix?: string): string {
  return `${reportText(item.permission)}: ${listText(item.problems.map(problem => NAMING_NOTES[problem](reportText(prefix ?? ''))))}`;
}
