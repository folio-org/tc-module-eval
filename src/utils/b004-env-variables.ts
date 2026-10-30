import * as fs from 'fs';
import * as path from 'path';
import {
  B004Analysis,
  B004Problem,
  B004Source,
  B004TopLevelEnv,
  B004Variable,
  BackendEvidence,
  CriterionAgentReviewResult,
  EvaluationStatus
} from '../types';
import { B004FrameworkId, B004Read, documentationTables, moduleFrameworks, readmeLinks, sourceEnvReads, templateEnvReads } from './b004-env-evidence';
import { numberBackendObligations } from './backend-agent-review';
import { templateLineOf } from './backend-evidence';
import { FrontendChecklistItemDraft } from './frontend-agent-review';
import { frontendChecklist, frontendReviewLines } from './frontend-checklist';
import { count, listText, overflowLine, reportPath, reportText } from './report-text';
import { isRecord } from './type-guards';

export const B004_POLICY_DIRECTORY = path.resolve(__dirname, '../../config/b004-env-variables-policy');

/** The pinned snapshot of the FOLIO Environment Variables policy under `config/b004-env-variables-policy/`. */
export interface B004Policy {
  title: string;
  url: string;
  pageVersion: number;
  modifiedAt: string;
  text: string;
  /** The variables each framework documents (policy section 2.2), from `framework-variables.json`, pinned to a commit. */
  frameworks: B004Framework[];
}

interface B004Framework {
  id: B004FrameworkId;
  name: string;
  repository: string;
  commit: string;
  /** URLs without the scheme; a README that contains one links to the framework's documentation. */
  documentationLinks: string[];
  variables: Array<{ name: string; file: string; line: number }>;
}

const FRAMEWORK_IDS: B004FrameworkId[] = ['rmb', 'folio-spring-base', 'folio-java-docker'];

export function loadB004Policy(directory = B004_POLICY_DIRECTORY): B004Policy {
  const source: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
  if (!isRecord(source) || typeof source.title !== 'string' || typeof source.url !== 'string' || typeof source.pageVersion !== 'number'
    || typeof source.modifiedAt !== 'string' || typeof source.file !== 'string') {
    throw new Error('source.json must name the title, URL, page version, modification date and file');
  }
  const frameworks: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'framework-variables.json'), 'utf8'));
  const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
  if (!isRecord(frameworks) || !Array.isArray(frameworks.frameworks) || !frameworks.frameworks.every(framework => isRecord(framework)
    && FRAMEWORK_IDS.includes(framework.id as B004FrameworkId) && typeof framework.name === 'string' && typeof framework.repository === 'string'
    && typeof framework.commit === 'string' && /^[0-9a-f]{40}$/.test(framework.commit) && strings(framework.documentationLinks)
    && Array.isArray(framework.variables) && framework.variables.every(variable => isRecord(variable) && typeof variable.name === 'string'
      && typeof variable.file === 'string' && typeof variable.line === 'number'))) {
    throw new Error('framework-variables.json must list frameworks with an id, name, repository, commit, documentation links and variables with their file and line');
  }
  return {
    title: source.title,
    url: source.url,
    pageVersion: source.pageVersion,
    modifiedAt: source.modifiedAt,
    text: fs.readFileSync(path.join(directory, source.file), 'utf8'),
    frameworks: frameworks.frameworks as B004Framework[]
  };
}

const MAX_ROWS = 20;
const MAX_SOURCES = 10;
const NAME_FORMAT = /^[A-Z0-9_]+$/;
const NO_DEFAULT = new Set(['', '-', '–', '—', 'none', 'n/a', 'na', 'empty', 'empty string', 'no default', 'no default value', 'not set', 'unset', 'null', 'required', 'mandatory']);
const C1_GAPS: B004Problem[] = ['undocumented', 'missing-columns', 'missing-required', 'missing-description'];
const C1_REVIEW: B004Problem[] = ['unreadable-required', 'framework-unlinked'];
const COLUMN_NAMES = { default: 'Default Value', required: 'Required', description: 'Description' } as const;

/**
 * B004 (environment variables follow the FOLIO policy) checks the variables a module uses, from the descriptor
 * template's env lists, `System.getenv` reads and Spring placeholders, in five sub-checks:
 * C1 documented in ENV_VARS.md or a README table with a default, required or optional, and a description, and a
 * template with a top-level `env`; C2 no default on a required variable; C3 names; C4 fail-fast evidence for
 * required variables; C5 log statements that may print secrets. A library, or a repository without a descriptor,
 * gets C3-C5 only. A variable its framework documents needs no documentation of the module's own when the README links
 * to that framework's documentation (policy section 2.2); without the link a reviewer checks it.
 */
export function evaluateB004(evidence: BackendEvidence, existingModule: boolean, policy: B004Policy | { problem: string }): B004Analysis {
  const { kind, template } = evidence;
  const files = evidence.snapshot.files;
  const sourceDiagnostics = evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const documentationChecked = kind === 'backend-module' || kind === 'edge-module';

  const reads: B004Read[] = [];
  let topLevelEnv: B004TopLevelEnv = 'not-checked';
  if (documentationChecked) {
    if (template?.descriptor !== undefined) {
      const fromTemplate = templateEnvReads(template.descriptor, template.path, templateLineOf(template));
      reads.push(...fromTemplate.reads);
      topLevelEnv = fromTemplate.topLevelEnv;
    } else {
      topLevelEnv = kind === 'edge-module' && !evidence.templateCandidates.length ? 'no-template' : 'template-unreadable';
    }
  }
  const scan = sourceEnvReads(files);
  reads.push(...scan.reads);

  const sourcesByName = new Map<string, B004Source[]>();
  for (const read of reads) {
    const sources = sourcesByName.get(read.name) ?? [];
    sourcesByName.set(read.name, sources);
    sources.push(read.source);
  }
  if (!sourcesByName.size && ['missing', 'empty', 'not-a-list'].includes(topLevelEnv)) topLevelEnv = 'not-checked';

  const documentation = documentationChecked ? documentationTables(files) : undefined;
  const applicable = moduleFrameworks(evidence.framework.name, files);
  const frameworks = 'problem' in policy || !documentation ? [] : policy.frameworks.filter(framework => applicable.has(framework.id));
  const linked = readmeLinks(files, frameworks.flatMap(framework => framework.documentationLinks));
  const frameworkDocumentation = new Map<string, NonNullable<B004Variable['framework']>>();
  for (const framework of frameworks) {
    const isLinked = framework.documentationLinks.some(link => linked.has(link));
    for (const variable of framework.variables) {
      frameworkDocumentation.set(variable.name, {
        name: framework.name, source: `${framework.repository}/blob/${framework.commit}/${variable.file}#L${variable.line}`, linked: isLinked
      });
    }
  }
  const variables: B004Variable[] = [...sourcesByName].map(([name, sources]) => {
    const problems: B004Problem[] = [];
    const kept = sources.slice(0, MAX_SOURCES);
    const binding = sources.find(source => source.failFast);
    if (binding && !kept.includes(binding)) kept.push(binding);
    const variable: B004Variable = { name, sources: kept, sourceCount: sources.length, problems };
    if (documentation) {
      const rows = documentation.rows.get(name) ?? [];
      const row = rows.find(candidate => !candidate.missingColumns.length) ?? rows[0];
      if (!row) {
        problems.push('undocumented');
      } else {
        variable.documentation = row;
        if (row.missingColumns.length) problems.push('missing-columns');
        if (row.required !== undefined) {
          const required = requiredValue(row.required, row.optionalColumn === true);
          if (required === 'empty') problems.push('missing-required');
          else if (required === undefined) problems.push('unreadable-required');
          else variable.required = required;
        }
        if (row.description !== undefined && !cellText(row.description)) problems.push('missing-description');
      }
      const environmentDefault = sources.find(source => source.kind === 'env' && source.value);
      const codeDefault = sources.find(source => (source.kind === 'code' || source.kind === 'configuration') && source.value?.trim());
      if (row?.default !== undefined && !NO_DEFAULT.has(cellText(row.default))) {
        variable.defaultFrom = { kind: 'documentation', path: row.path, line: row.line, value: row.default };
      } else if (environmentDefault) {
        variable.defaultFrom = { kind: 'env', path: environmentDefault.path, value: environmentDefault.value! };
      } else if (codeDefault) {
        variable.defaultFrom = { kind: 'code', path: codeDefault.path, ...(codeDefault.line ? { line: codeDefault.line } : {}), value: codeDefault.value! };
      }
      if (variable.required && variable.defaultFrom) problems.push('required-with-default');
      const framework = frameworkDocumentation.get(name);
      if (framework && problems.some(problem => C1_GAPS.includes(problem))) {
        variable.framework = framework;
        problems.splice(0, problems.length, ...problems.filter(problem => !C1_GAPS.includes(problem)));
        if (!framework.linked) problems.push('framework-unlinked');
      }
    }
    if (!NAME_FORMAT.test(name)) problems.push('name-format');
    if (name.startsWith('AWS_') && !sourcesByName.has(`S3_${name.slice(4)}`)) problems.push('aws-prefix');
    if (variable.required && !sources.some(source => source.failFast)) problems.push('no-fail-fast');
    return variable;
  });

  const having = (problem: B004Problem) => variables.filter(variable => variable.problems.includes(problem));
  const undocumented = having('undocumented');
  const missingRequired = having('missing-required');
  const missingDescription = having('missing-description');
  const unreadableRequired = having('unreadable-required');
  const frameworkUnlinked = having('framework-unlinked');
  const ownVariables = variables.filter(variable => !variable.framework);
  const requiredWithDefault = having('required-with-default');
  const nameFormat = having('name-format');
  const awsPrefix = having('aws-prefix');
  const noFailFast = having('no-fail-fast');
  const envGap = topLevelEnv === 'missing' || topLevelEnv === 'empty' || topLevelEnv === 'not-a-list';
  const c1Gap = envGap || variables.some(variable => C1_GAPS.some(problem => variable.problems.includes(problem)));
  const unknownRequired = ownVariables.filter(variable => variable.required === undefined);
  const templateUnreadable = topLevelEnv === 'template-unreadable';

  const sentences: string[] = [];
  if (templateUnreadable) {
    sentences.push('The module descriptor template could not be read (see B001), so the variables its env lists name are not known.');
  }
  if (documentation && variables.length) {
    for (const [framework, list] of byFramework(variables.filter(variable => variable.framework?.linked))) {
      sentences.push(`${list.length === 1 ? `${names(list)} is` : `${list.length} variables are`} documented by ${reportText(framework)}, which the README links to, so the module need not document ${list.length === 1 ? 'it' : 'them'} (policy section 2.2)${list.length === 1 ? '' : `: ${names(list)}`}.`);
    }
    for (const [framework, list] of byFramework(frameworkUnlinked)) {
      sentences.push(`${list.length === 1 ? `${names(list)} is` : `${list.length} variables are`} documented by ${reportText(framework)}, but the README does not link to its documentation (policy section 2.2)${list.length === 1 ? '' : `: ${names(list)}`}.`);
    }
    const documented = ownVariables.length - undocumented.length;
    const other = ownVariables.length < variables.length ? ' other' : '';
    if (ownVariables.length && !documented) {
      sentences.push(`The module uses ${ownVariables.length}${other} environment variable${ownVariables.length === 1 ? '' : 's'}, but ${ownVariables.length === 1 ? 'it is not' : 'none is'} documented in ENV_VARS.md or a README table.`);
    } else if (undocumented.length) {
      sentences.push(`ENV_VARS.md or a README table documents ${documented} of the ${ownVariables.length}${other} environment variables the module uses; ${undocumented.length} ${undocumented.length === 1 ? 'is' : 'are'} not: ${names(undocumented)}.`);
    }
    const byMissing = new Map<string, B004Variable[]>();
    for (const variable of having('missing-columns')) {
      const key = variable.documentation!.missingColumns.join(',');
      byMissing.set(key, [...(byMissing.get(key) ?? []), variable]);
    }
    for (const [key, list] of byMissing) {
      const columns = key.split(',') as Array<keyof typeof COLUMN_NAMES>;
      sentences.push(`${list.length === 1 ? `The documented variable ${reportText(list[0].name)} is` : `${list.length} documented variables are`} in a table with ${missingColumnsText(columns)} (policy section 3.2).`);
    }
    if (missingRequired.length) sentences.push(`${subject(missingRequired)} no value for required or optional.`);
    if (missingDescription.length) sentences.push(`${subject(missingDescription)} no description.`);
    if (unreadableRequired.length) {
      sentences.push(`The tool could not read whether ${unreadableRequired.length === 1 ? `${reportText(unreadableRequired[0].name)} is` : `${unreadableRequired.length} variables are`} required: ${listText(unreadableRequired.map(variable => `${reportText(variable.name)} ("${reportText(variable.documentation!.required!)}")`))}.`);
    }
  }
  if (envGap) sentences.push(`The descriptor template ${TOP_LEVEL_ENV_TEXT[topLevelEnv]} (policy section 3.1).`);
  if (c1Gap && existingModule) sentences.push('In an existing-module evaluation (--existing-module) these documentation gaps are not a fail (policy section 7.2).');
  if (requiredWithDefault.length) {
    sentences.push(`${listText(requiredWithDefault.map(variable => reportText(variable.name)))} ${requiredWithDefault.length === 1 ? 'is' : 'are'} documented as required but ${requiredWithDefault.length === 1 ? 'has' : 'have'} a default; a variable with a default is optional (policy section 4.1).`);
  }
  if (nameFormat.length) {
    sentences.push(`${nameFormat.length === 1 ? `The name ${names(nameFormat)} is` : `${nameFormat.length} names are`} not upper case letters, digits and underscores${nameFormat.length === 1 ? '' : `: ${names(nameFormat)}`} (policy section 2.1).`);
  }
  if (awsPrefix.length) {
    sentences.push(`${awsPrefix.length === 1 ? `${names(awsPrefix)} uses` : `${awsPrefix.length} variables use`} the AWS_ prefix without an S3_ variable alongside${awsPrefix.length === 1 ? '' : `: ${names(awsPrefix)}`} (policy sections 2.1 and 5.1).`);
  }
  if (!documentationChecked && variables.length) {
    sentences.push(`${kind === 'library' ? 'The repository is a shared library' : 'The repository has no module descriptor, so B004 treats it as a library (see B001)'}: its documentation is not checked, so the tool cannot tell ${variables.length === 1 ? 'whether its 1 environment variable is' : `which of its ${variables.length} environment variables are`} required.`);
  }
  if (noFailFast.length) {
    sentences.push(`${noFailFast.length === 1 ? `The required variable ${names(noFailFast)} has` : `${noFailFast.length} required variables have`} no evidence that startup stops when ${noFailFast.length === 1 ? 'it is' : 'they are'} missing${noFailFast.length === 1 ? '' : `: ${names(noFailFast)}`}.`);
  }
  if (scan.logSignals.length) {
    sentences.push(`${scan.logSignals.length === 1 ? 'A log statement' : `${scan.logSignals.length} log statements`} in files that read configuration may print a secret value or the whole environment.`);
  }
  if (scan.unreadReadCount) sentences.push(`The tool could not read the name of ${count(scan.unreadReadCount, 'System.getenv read')}.`);
  if (sourceDiagnostics.length) sentences.push('The committed source was not read completely, so the tool may have missed variables.');

  const fails = (c1Gap && !existingModule) || requiredWithDefault.length > 0 || nameFormat.length > 0 || awsPrefix.length > 0;
  const toReview = (c1Gap && existingModule) || unreadableRequired.length > 0 || frameworkUnlinked.length > 0 || noFailFast.length > 0 || scan.logSignals.length > 0
    || scan.unreadReadCount > 0 || sourceDiagnostics.length > 0 || templateUnreadable || (!documentationChecked && variables.length > 0);
  const status = fails ? EvaluationStatus.FAIL : toReview ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  if (status === EvaluationStatus.MANUAL) sentences.push('A reviewer must check the findings on the checklist.');
  if (status === EvaluationStatus.PASS) {
    const required = variables.filter(variable => variable.required);
    sentences.push(!variables.length
      ? `The ${documentationChecked ? 'module' : 'repository'} uses no environment variables, and no log statement in files that read configuration prints the whole environment.`
      : `${!ownVariables.length ? 'The module documents no variable of its own'
        : ownVariables.length < variables.length ? `${ownVariables.length === 1 ? 'The other environment variable is' : `The other ${ownVariables.length} environment variables are`} documented in a table with a default, required or optional, and a description`
          : `${variables.length === 1 ? 'The environment variable the module uses is' : `All ${variables.length} environment variables the module uses are`} documented in a table with a default, required or optional, and a description`}${topLevelEnv === 'present' ? ', and the descriptor template has a top-level "env"' : ''}. `
        + `Their names follow the policy, ${required.length ? `each required variable stops startup when missing (a @Value binding without a default)` : 'none is documented as required'}, `
        + 'and no log statement in files that read configuration prints a secret-like value or the whole environment.');
  }

  const startingPoint = (variable: B004Variable, note: string, source = variable.sources[0]) => {
    return { path: source.path, ...(source.line ? { line: source.line } : {}), note: `${reportText(variable.name)}: ${note}` };
  };
  const variableSubject = (variable: B004Variable, flag?: 'manual') => {
    const source = readSource(variable);
    return { subject: variable.name, path: source.path, ...(source.line ? { line: source.line } : {}), ...(flag ? { flag } : {}) };
  };
  const unreadSubjects = scan.unreadReads.map(read => ({ subject: `System.getenv read at ${read.path}:${read.line}`, path: read.path, line: read.line, flag: 'manual' as const }));
  const unreadFiles = sourceDiagnostics.flatMap(diagnostic => diagnostic.path ? [{ path: diagnostic.path, note: `not read: ${reportText(diagnostic.message)}` }] : []);
  const items: FrontendChecklistItemDraft[] = [];
  if (documentation && (c1Gap || unreadableRequired.length || frameworkUnlinked.length || scan.unreadReadCount || templateUnreadable || sourceDiagnostics.length)) {
    items.push({
      id: 'B004-C1',
      title: 'Every environment variable the module uses is documented in ENV_VARS.md or a README table with a default, whether it is required, and a description, and the descriptor template lists it in a top-level env.',
      startingPoints: [
        ...(envGap ? [{ path: template!.path, note: `the template ${TOP_LEVEL_ENV_TEXT[topLevelEnv]}` }] : []),
        ...variables.filter(variable => variable.problems.some(problem => C1_GAPS.includes(problem) || C1_REVIEW.includes(problem)))
          .map(variable => variable.documentation
            ? { path: variable.documentation.path, line: variable.documentation.line, note: `${reportText(variable.name)}: ${documentationNote(variable)}` }
            : startingPoint(variable, documentationNote(variable), readSource(variable))),
        ...scan.unreadReads.map(read => ({ ...read, note: 'System.getenv read whose name the tool could not read' })),
        ...unreadFiles
      ],
      reviewerOnly: false,
      subjects: unreadSubjects,
      obligations: []
    });
  }
  if (requiredWithDefault.length) {
    items.push({
      id: 'B004-C2',
      title: 'Each variable documented as required has no default, and each variable with a default is documented as optional.',
      startingPoints: requiredWithDefault.map(variable => ({
        path: variable.defaultFrom!.path, ...(variable.defaultFrom!.line ? { line: variable.defaultFrom!.line } : {}),
        note: `${reportText(variable.name)}: documented as required, default "${reportText(variable.defaultFrom!.value)}"`
      })),
      reviewerOnly: true,
      subjects: [],
      obligations: []
    });
  }
  if (nameFormat.length || awsPrefix.length) {
    items.push({
      id: 'B004-C3',
      title: 'Each variable name is upper case letters, digits and underscores, and each AWS_ variable has an S3_ variable alongside it.',
      startingPoints: [
        ...nameFormat.map(variable => startingPoint(variable, 'not upper case letters, digits and underscores')),
        ...awsPrefix.map(variable => startingPoint(variable, `no S3_${reportText(variable.name.slice(4))} alongside`))
      ],
      reviewerOnly: true,
      subjects: [],
      obligations: []
    });
  }
  const c4Subjects = [...noFailFast, ...(status === EvaluationStatus.PASS ? [] : unknownRequired)];
  if (c4Subjects.length || (!documentation && (scan.unreadReadCount || sourceDiagnostics.length))) {
    items.push({
      id: 'B004-C4',
      title: 'Each required variable stops startup with a clear message when it is missing or empty.',
      startingPoints: [
        ...noFailFast.map(variable => startingPoint(variable, 'documented as required; no fail-fast evidence found', readSource(variable))),
        ...unknownRequired.map(variable => startingPoint(variable, documentationChecked ? 'not documented as required or optional' : 'required or optional not known', readSource(variable))),
        ...(documentation ? [] : [...scan.unreadReads.map(read => ({ ...read, note: 'System.getenv read whose name the tool could not read' })), ...unreadFiles])
      ],
      reviewerOnly: false,
      subjects: [
        ...noFailFast.map(variable => variableSubject(variable, 'manual')),
        ...unknownRequired.map(variable => variableSubject(variable)),
        ...(documentation ? [] : unreadSubjects)
      ],
      obligations: []
    });
  }
  if (scan.logSignals.length) {
    items.push({
      id: 'B004-C5',
      title: 'Startup logs show the configuration without printing secret values or the whole environment.',
      startingPoints: scan.logSignals.map(signal => ({
        path: signal.path, line: signal.line,
        note: signal.kind === 'environment-dump' ? `reads the whole environment (${reportText(signal.subject)})` : `may print a secret-like value (${reportText(signal.subject)})`
      })),
      reviewerOnly: false,
      subjects: scan.logSignals.map(signal => ({ subject: `log statement at ${signal.path}:${signal.line}`, path: signal.path, line: signal.line, flag: 'manual' as const })),
      obligations: []
    });
  }

  return {
    criterionId: 'B004',
    status,
    summary: `B004 ${status}: ${sentences.join(' ')}`,
    kind,
    existingModule,
    policy: 'problem' in policy ? { problem: policy.problem } : { title: policy.title, url: policy.url, pageVersion: policy.pageVersion, modifiedAt: policy.modifiedAt },
    ...(template ? { templatePath: template.path } : {}),
    documentationChecked,
    documentationFiles: documentation?.files ?? [],
    topLevelEnv,
    variables,
    unreadReads: scan.unreadReads,
    unreadReadCount: scan.unreadReadCount,
    logSignals: scan.logSignals,
    sourceDiagnostics,
    checklist: frontendChecklist(status, numberBackendObligations(items))
  };
}

export function renderB004HumanDetails(analysis: B004Analysis, agentReview?: CriterionAgentReviewResult): string {
  const { variables } = analysis;
  const having = (problem: B004Problem) => variables.filter(variable => variable.problems.includes(problem));
  const lines = [`Evaluated as: ${analysis.existingModule ? 'an existing module (--existing-module)' : 'a new module (the default)'}`];
  lines.push('problem' in analysis.policy
    ? `Policy: not loaded (${reportText(analysis.policy.problem)})`
    : `Policy: FOLIO ${analysis.policy.title} policy, page version ${analysis.policy.pageVersion} of ${analysis.policy.modifiedAt.slice(0, 10)} (${analysis.policy.url})`);
  const kinds = (['env', 'launch-env', 'code', 'configuration'] as const).map(kind => ({
    kind, total: variables.filter(variable => variable.sources.some(source => source.kind === kind)).length
  })).filter(entry => entry.total);
  lines.push(`Variables used: ${variables.length}${kinds.length ? ` (${kinds.map(entry => `${entry.total} ${SOURCE_KIND_TEXT[entry.kind]}`).join(', ')})` : ''}`);
  const section = (heading: string, rows: string[]) => {
    if (rows.length) lines.push(`${heading}:`, ...rows);
  };
  const list = (title: string, items: B004Variable[], describe: (variable: B004Variable) => string): string[] => items.length
    ? [`  - ${title} (${items.length}):`, ...items.slice(0, MAX_ROWS).map(variable => `    - ${reportText(variable.name)} — ${describe(variable)}`), ...overflowLine(items.length, MAX_ROWS, '    ')]
    : [];

  if (analysis.documentationChecked) {
    const files = analysis.documentationFiles;
    lines.push(`Documentation: ${['ENV_VARS.md', 'README.md'].map(name => {
      const file = files.find(candidate => candidate.path.toLowerCase() === name.toLowerCase());
      return file ? `${reportPath(file.path)} with ${count(file.tableCount, 'table')}` : `no ${name}`;
    }).join(', ')}; the descriptor's env lists do not count as documentation`);
    const documented = variables.filter(variable => variable.documentation);
    const rows: string[] = [];
    if (analysis.topLevelEnv === 'template-unreadable') rows.push('  - The module descriptor template could not be read (see B001), so the variables its env lists name are not known.');
    if (analysis.topLevelEnv === 'no-template') rows.push('  - Top-level env: not checked, because the edge module has no descriptor template (see B001).');
    else if (analysis.topLevelEnv === 'present') rows.push(`  - Top-level env: present in ${reportPath(analysis.templatePath!)}`);
    else if (analysis.topLevelEnv !== 'not-checked' && analysis.topLevelEnv !== 'template-unreadable') {
      rows.push(`  - Top-level env: ${reportPath(analysis.templatePath!)} ${TOP_LEVEL_ENV_TEXT[analysis.topLevelEnv]} (policy section 3.1)`);
    }
    if (variables.length) rows.push(`  - Documented in a table: ${documented.length} of ${variables.length}`);
    rows.push(
      ...list('Not documented', having('undocumented'), where),
      ...list('In a table without a column the policy requires (section 3.2)', having('missing-columns'), variable =>
        `${rowText(variable)}: ${missingColumnsText(variable.documentation!.missingColumns)}`),
      ...list('No value for required or optional', having('missing-required'), rowText),
      ...list('Required or optional not readable', having('unreadable-required'), variable => `${rowText(variable)}: "${reportText(variable.documentation!.required!)}"`),
      ...list('No description', having('missing-description'), rowText),
      ...list('Documented by a framework the README links to (policy section 2.2)', variables.filter(variable => variable.framework?.linked), frameworkText),
      ...list('Documented by a framework the README does not link to (policy section 2.2)', having('framework-unlinked'), frameworkText)
    );
    section('C1 Documentation', rows);

    const required = variables.filter(variable => variable.required);
    const c2 = having('required-with-default');
    section('C2 Required vs optional', !documented.some(variable => variable.required !== undefined)
      ? ['  - Not checked: no documentation says whether a variable is required']
      : [`  - Documented as required: ${required.length}; as optional: ${variables.filter(variable => variable.required === false).length}`,
        ...(c2.length ? list('Documented as required, but with a default (policy section 4.1)', c2, variable =>
          `default "${reportText(variable.defaultFrom!.value)}" in ${DEFAULT_KIND_TEXT[variable.defaultFrom!.kind]} at ${location(variable.defaultFrom!)}`)
          : ['  - No variable documented as required has a default'])]);
  }

  const nameFormat = having('name-format');
  const awsPrefix = having('aws-prefix');
  section('C3 Naming', nameFormat.length || awsPrefix.length ? [
    ...list('Not upper case letters, digits and underscores (policy section 2.1)', nameFormat, where),
    ...list('AWS_ without an S3_ variable alongside (policy sections 2.1 and 5.1)', awsPrefix, variable => `no S3_${reportText(variable.name.slice(4))}`)
  ] : [variables.length ? '  - Every name is upper case letters, digits and underscores, and no AWS_ variable lacks an S3_ one' : '  - No variables']);

  const required = variables.filter(variable => variable.required);
  const unknown = variables.filter(variable => variable.required === undefined && !variable.framework).length;
  section('C4 Startup behaviour', !analysis.documentationChecked
    ? [variables.length ? '  - Not checked: a library\'s documentation is not read, so which variables are required is not known' : '  - No variables']
    : !required.length
      ? [unknown ? `  - Not known for ${count(unknown, 'variable')}, because the documentation does not say whether ${unknown === 1 ? 'it is' : 'they are'} required` : '  - No variable is documented as required']
      : [
        ...(unknown ? [`  - Not known for ${count(unknown, 'more variable')}, because the documentation does not say whether ${unknown === 1 ? 'it is' : 'they are'} required`] : []),
        ...list('Stops startup when missing (a @Value binding without a default)', required.filter(variable => !variable.problems.includes('no-fail-fast')), variable => {
          const binding = variable.sources.find(source => source.failFast)!;
          return location(binding);
        }),
        ...list('Required, with no evidence that startup stops when missing', having('no-fail-fast'), where)
      ]);

  const signals = analysis.logSignals;
  section('C5 Startup logging', signals.length
    ? [`  - Log statements that may print a secret value or the whole environment (${signals.length}):`,
      ...signals.slice(0, MAX_ROWS).map(signal => `    - ${reportPath(signal.path)}:${signal.line} — ${signal.kind === 'environment-dump'
        ? `reads the whole environment (${reportText(signal.subject)})` : `may print a secret-like value (${reportText(signal.subject)})`}`),
      ...overflowLine(signals.length, MAX_ROWS, '    ')]
    : ['  - No log statement in files that read configuration prints a secret-like value or the whole environment']);

  if (analysis.unreadReadCount) {
    lines.push(`System.getenv reads whose name the tool could not read (${analysis.unreadReadCount}):`,
      ...analysis.unreadReads.slice(0, MAX_ROWS).map(read => `  - ${reportPath(read.path)}:${read.line}`), ...overflowLine(analysis.unreadReadCount, MAX_ROWS, '  '));
  }
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    const c1Gap = !analysis.existingModule && analysis.documentationChecked
      && (variables.some(variable => C1_GAPS.some(problem => variable.problems.includes(problem))));
    const envGap = !analysis.existingModule && ['missing', 'empty', 'not-a-list'].includes(analysis.topLevelEnv);
    lines.push('What to do:', ...[
      ...(c1Gap ? ['Document every variable the module uses in ENV_VARS.md or a README table with its name, default (or empty), whether it is required, and a description (policy section 3).'] : []),
      ...(envGap ? ['List every variable with a description in the descriptor template\'s top-level "env" (policy section 3.1).'] : []),
      ...(having('required-with-default').length ? ['Document each variable that has a default as optional, or remove its default (policy section 4.1).'] : []),
      ...(nameFormat.length ? ['Rename each variable to upper case letters, digits and underscores (policy section 2.1).'] : []),
      ...(awsPrefix.length ? ['Support an S3_ variable alongside each AWS_ one, taking precedence over it, and document both (policy sections 2.1 and 5.1).'] : [])
    ].map(line => `  - ${line}`));
  }
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

const TOP_LEVEL_ENV_TEXT: Partial<Record<B004TopLevelEnv, string>> = {
  missing: 'has no top-level "env"',
  empty: 'has an empty top-level "env"',
  'not-a-list': 'has a top-level "env" that is not a list'
};

const SOURCE_KIND_TEXT: Record<B004Source['kind'], string> = {
  env: 'in the top-level env',
  'launch-env': 'in launchDescriptor.env',
  code: 'read with System.getenv',
  configuration: 'in Spring placeholders'
};

const DEFAULT_KIND_TEXT = { documentation: 'the documentation', env: 'the top-level env', code: 'the code or configuration' } as const;

/** Where the module reads a variable, or its descriptor entry when no code or configuration reads it. */
function readSource(variable: B004Variable): B004Source {
  return variable.sources.find(source => source.kind === 'code' || source.kind === 'configuration') ?? variable.sources[0];
}

function byFramework(variables: B004Variable[]): Map<string, B004Variable[]> {
  const groups = new Map<string, B004Variable[]>();
  for (const variable of variables) groups.set(variable.framework!.name, [...(groups.get(variable.framework!.name) ?? []), variable]);
  return groups;
}

function names(variables: B004Variable[]): string {
  return listText(variables.map(variable => reportText(variable.name)));
}

function subject(variables: B004Variable[]): string {
  return variables.length === 1 ? `The documented variable ${reportText(variables[0].name)} has` : `${variables.length} documented variables have`;
}

function location(source: { path: string; line?: number }): string {
  return `${reportPath(source.path)}${source.line ? `:${source.line}` : ''}`;
}

function where(variable: B004Variable): string {
  const source = variable.sources[0];
  const how = source.kind === 'env' ? 'top-level env' : source.kind === 'launch-env' ? 'launchDescriptor.env' : source.kind === 'code' ? 'System.getenv' : 'placeholder';
  return `${how} in ${location(source)}${variable.sourceCount > 1 ? ` and ${count(variable.sourceCount - 1, 'more place')}` : ''}`;
}

function missingColumnsText(columns: Array<keyof typeof COLUMN_NAMES>): string {
  const names = columns.map(column => COLUMN_NAMES[column]);
  return `no ${names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0]} column`;
}

function frameworkText(variable: B004Variable): string {
  return `${reportText(variable.framework!.name)}, ${reportText(variable.framework!.source)}`;
}

function rowText(variable: B004Variable): string {
  return location(variable.documentation!);
}

function documentationNote(variable: B004Variable): string {
  const problems = variable.problems;
  if (problems.includes('undocumented')) return 'not in ENV_VARS.md or a README table';
  if (problems.includes('framework-unlinked')) return `documented by ${reportText(variable.framework!.name)} (${reportText(variable.framework!.source)}), but the README does not link to its documentation`;
  return listText([
    ...(problems.includes('missing-columns') ? [`its table has ${missingColumnsText(variable.documentation!.missingColumns)}`] : []),
    ...(problems.includes('missing-required') ? ['no value for required or optional'] : []),
    ...(problems.includes('unreadable-required') ? ['required or optional not readable'] : []),
    ...(problems.includes('missing-description') ? ['no description'] : [])
  ]);
}

function cellText(cell: string): string {
  return cell.replace(/\\(.)/g, '$1').replace(/[`*"'()<>]/g, '').trim().replace(/^_+|_+$/g, '').trim().toLowerCase();
}

function requiredValue(cell: string, optionalColumn: boolean): boolean | 'empty' | undefined {
  const text = cellText(cell).replace(/^_+|_+$/g, '');
  if (!text || /^[-–—]$/.test(text)) return 'empty';
  const word = /^(?:[a-z]+|[✓✔☑✗✘])/.exec(text)?.[0];
  if (word === 'required' || word === 'mandatory') return true;
  if (word === 'optional') return false;
  if (word && ['yes', 'y', 'true', '✓', '✔', '☑'].includes(word)) return !optionalColumn;
  if (word && ['no', 'n', 'false', '✗', '✘'].includes(word)) return optionalColumn;
  return undefined;
}
