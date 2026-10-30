import {
  B012Analysis,
  B012Basis,
  B012Infrastructure,
  BackendEvidence,
  BackendInfrastructure,
  BackendInfrastructureEvidence,
  BackendInfrastructureSignal,
  CriterionAgentReviewResult,
  EvaluationStatus
} from '../types';
import { numberBackendObligations } from './backend-agent-review';
import { FrontendChecklistItemDraft } from './frontend-agent-review';
import { frontendReviewLines } from './frontend-checklist';
import { isNamedInReadme } from './license-compliance';
import { listText, overflowLine, reportPath, reportText } from './report-text';

const README = /^readme\.md$/i;
const SHOWN_SIGNALS = 5;
const MAX_ROWS = 20;

const README_NAMES: Record<BackendInfrastructure['id'], string[]> = {
  postgresql: ['PostgreSQL', 'Postgres'],
  kafka: ['Kafka'],
  opensearch: ['OpenSearch', 'Elasticsearch'],
  elasticsearch: ['Elasticsearch', 'OpenSearch'],
  s3: ['S3', 'MinIO'],
  keycloak: ['Keycloak'],
  redis: ['Redis'],
  mongodb: ['MongoDB', 'Mongo'],
  rabbitmq: ['RabbitMQ'],
  activemq: ['ActiveMQ'],
  cassandra: ['Cassandra'],
  solr: ['Solr'],
  hazelcast: ['Hazelcast'],
  'aws-ssm': ['AWS SSM', 'Parameter Store', 'AwsSsm'],
  'aws-sqs': ['SQS'],
  'aws-sns': ['SNS'],
  vault: ['Vault'],
  mysql: ['MySQL'],
  mariadb: ['MariaDB']
};

const USAGE_LABELS: Record<BackendInfrastructure['usage'], string> = {
  required: 'required',
  optional: 'optional or selectable',
  'configuration-only': 'configuration only, no client library'
};

/**
 * B012 (non-interface dependencies declared in README.md) looks up each infrastructure B016's detection found in the
 * root README.md, by its name or a synonym, as S003 looks up dependency names. External services and other modules'
 * Kafka topics are checklist items for the reviewer and the agent; they never fail B012.
 */
export function evaluateB012(evidence: BackendEvidence, detected: BackendInfrastructureEvidence): B012Analysis {
  const readmeFiles = evidence.snapshot.files.filter(file => README.test(file.path));
  const unreadable = evidence.snapshot.diagnostics.filter(diagnostic => diagnostic.path && README.test(diagnostic.path));
  const readmePaths = readmeFiles.map(file => file.path).sort();
  const unreadableReadmePaths = unreadable.map(diagnostic => diagnostic.path!).sort();
  const basis: B012Basis = unreadable.length ? 'readme-unreadable' : readmeFiles.length ? 'readme-checked'
    : evidence.snapshot.diagnostics.some(diagnostic => diagnostic.material && !diagnostic.path) ? 'source-incomplete' : 'no-readme';
  const diagnostics: B012Analysis['diagnostics'] = [
    ...detected.diagnostics,
    ...detected.sourceDiagnostics.filter(diagnostic => !(diagnostic.path && README.test(diagnostic.path))).map(({ path, message }) => ({ ...(path ? { path } : {}), message }))
  ];
  const infrastructure = detected.items.map((item): B012Infrastructure => {
    const namedAs = basis === 'readme-checked' || basis === 'readme-unreadable'
      ? [item.name, ...README_NAMES[item.id]].find(name => readmeFiles.some(file => isNamedInReadme(name, file.content)))
      : undefined;
    return { ...item, ...(namedAs ? { namedAs } : {}) };
  });

  const readme = readmePaths.length ? listText(readmePaths.map(reportPath)) : 'README.md';
  const plural = readmePaths.length > 1;
  const checked = basis === 'readme-checked';
  const unnamed = infrastructure.filter(item => !item.namedAs);
  const required = unnamed.filter(item => item.usage === 'required');
  const uncertain = unnamed.filter(item => item.usage !== 'required');
  const names = (items: B012Infrastructure[], conjunction = 'and') => listText(items.map(item => reportText(item.name)), items.length > 4 ? 'and' : conjunction);
  const evidenceText = (items: B012Infrastructure[]) => items.map(item => signalText(item.signals[0])).join('; ');

  const sentences: string[] = [];
  const what = infrastructure.length ? `the infrastructure the module uses: ${names(infrastructure)}` : 'the module\'s dependencies';
  if (basis === 'readme-unreadable') {
    sentences.push(`The tool could not read ${listText(unreadableReadmePaths.map(reportPath))}, so it could not check that it names ${what}.`);
  } else if (basis === 'source-incomplete') {
    sentences.push(`The committed source was not read completely and README.md was not among the files read, so the tool could not check that it names ${what}.`);
  } else if (unnamed.length) {
    const subject = basis === 'no-readme' ? 'There is no README.md at the repository root, so nothing names' : `${readme} ${plural ? 'do' : 'does'} not name`;
    if (required.length) sentences.push(`${subject} ${names(required, 'or')}, which the module uses (${evidenceText(required)}).`);
    if (uncertain.length) {
      sentences.push(`${required.length ? `It does not name ${names(uncertain, 'or')} either` : `${subject} ${names(uncertain, 'or')}`}, which the module may use (${evidenceText(uncertain)}).`);
    }
  } else if (infrastructure.length) {
    sentences.push(`${readme} ${plural ? 'name' : 'names'} every infrastructure the tool found: ${listText(infrastructure.map(item =>
      `${reportText(item.name)}${item.namedAs !== item.name ? ` (as "${reportText(item.namedAs!)}")` : ''}`))}.`);
  } else {
    sentences.push(`The tool found no infrastructure the module uses, so ${basis === 'no-readme' ? 'the missing README.md names nothing it should' : `${readme} has none to name`}.`);
  }
  const fails = required.length > 0 && (checked || basis === 'no-readme');
  const status = fails ? EvaluationStatus.FAIL
    : uncertain.length || !(checked || basis === 'no-readme') || diagnostics.length ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  if (diagnostics.length && !fails && basis !== 'source-incomplete') {
    sentences.push('Some build, configuration or source files could not be read, so the module may use infrastructure the tool did not find.');
  }
  if (status === EvaluationStatus.MANUAL) sentences.push('A reviewer must check the items listed under B012-C3.');

  const readmePoints = readmePaths.map(path => ({ path, note: 'the README' }));
  const signalPoints = (items: B012Infrastructure[], kinds: Array<BackendInfrastructureSignal['kind']>) => items.flatMap(item => item.signals
    .filter(signal => signal.path && kinds.includes(signal.kind))
    .map(signal => ({ path: signal.path!, ...(signal.line ? { line: signal.line } : {}), note: `${reportText(item.name)}: ${reportText(signal.detail)}${signal.optional ? ` (${reportText(signal.optional)})` : ''}` })));
  const drafts: FrontendChecklistItemDraft[] = [
    {
      id: 'B012-C1',
      title: `Each external service the module calls, other than FOLIO interfaces and the infrastructure listed, is named in ${readme}.`,
      startingPoints: readmePoints,
      reviewerOnly: false,
      obligations: [],
      subjects: []
    },
    {
      id: 'B012-C2',
      title: `Each Kafka topic the module consumes from or produces for other modules is named in ${readme}.`,
      startingPoints: [...readmePoints, ...signalPoints(infrastructure.filter(item => item.id === 'kafka'), ['dependency', 'configuration'])],
      reviewerOnly: false,
      obligations: [],
      subjects: []
    }
  ];
  if (status === EvaluationStatus.MANUAL) {
    drafts.push({
      id: 'B012-C3',
      title: `Each infrastructure listed as not named or not checked, and any infrastructure in files the tool could not read, is named in ${readme} if the module uses it.`,
      startingPoints: [...signalPoints(checked || basis === 'no-readme' ? uncertain : unnamed, ['dependency', 'storage', 'configuration', 'environment']), ...diagnostics.filter(diagnostic => diagnostic.path)
        .map(diagnostic => ({ path: diagnostic.path!, ...(diagnostic.line ? { line: diagnostic.line } : {}), note: reportText(diagnostic.message) })),
      ...unreadable.map(diagnostic => ({ path: diagnostic.path!, note: reportText(diagnostic.message) }))],
      reviewerOnly: true,
      obligations: [],
      subjects: []
    });
  }

  return {
    criterionId: 'B012',
    status,
    summary: `B012 ${status}: ${sentences.join(' ')}`,
    basis,
    kind: evidence.kind,
    readmePaths,
    unreadableReadmePaths,
    infrastructure,
    diagnostics,
    checklist: { items: numberBackendObligations(drafts) }
  };
}

export function renderB012HumanDetails(analysis: B012Analysis, agentReview?: CriterionAgentReviewResult): string {
  const readme = analysis.readmePaths.length ? listText(analysis.readmePaths.map(reportPath)) : undefined;
  const unreadable = listText(analysis.unreadableReadmePaths.map(reportPath));
  const lines = [`README: ${analysis.basis === 'readme-unreadable' ? `${readme ? `${readme}; ` : ''}could not read ${unreadable}`
    : analysis.basis === 'source-incomplete' ? 'not among the files read' : readme ?? 'no README.md at the repository root'}`];
  lines.push(`Infrastructure the module uses (direct dependencies, configuration and storage):${analysis.infrastructure.length ? '' : ' none found'}`);
  for (const item of analysis.infrastructure) {
    const named = item.namedAs ? `named${item.namedAs !== item.name ? ` as "${reportText(item.namedAs)}"` : ''}`
      : analysis.basis === 'readme-checked' || analysis.basis === 'no-readme' ? 'not named' : 'not checked';
    lines.push(`  - ${reportText(item.name)} (${USAGE_LABELS[item.usage]}) — ${named}`,
      ...item.signals.slice(0, SHOWN_SIGNALS).map(signal => `    - ${signalText(signal)}`),
      ...overflowLine(item.signals.length, SHOWN_SIGNALS));
  }
  if (analysis.diagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.diagnostics.slice(0, MAX_ROWS).map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)}${diagnostic.line ? `:${diagnostic.line}` : ''} — ` : ''}${reportText(diagnostic.message)}`),
    ...overflowLine(analysis.diagnostics.length, MAX_ROWS, '  '));
  }
  if (analysis.status === EvaluationStatus.FAIL) {
    const unnamed = analysis.infrastructure.filter(item => !item.namedAs && item.usage === 'required');
    const list = listText(unnamed.map(item => reportText(item.name)));
    lines.push('What to do:', readme
      ? `  - Name ${list} in ${readme}, with what the module uses ${unnamed.length === 1 ? 'it' : 'each'} for.`
      : `  - Add a README.md at the repository root that names ${list}, with what the module uses ${unnamed.length === 1 ? 'it' : 'each'} for.`);
  }
  lines.push(...frontendReviewLines(analysis.checklist, agentReview, analysis.agentReviewUnavailableReason));
  return lines.join('\n');
}

function signalText(signal: BackendInfrastructureSignal): string {
  const where = signal.path ? ` in ${reportPath(signal.path)}${signal.line ? `:${signal.line}` : ''}` : '';
  const optional = signal.optional ? ` (${reportText(signal.optional)})` : '';
  return signal.kind === 'storage' ? `${reportText(signal.detail)}${optional}` : `${reportText(signal.detail)}${where}${optional}`;
}
