import {
  AcceptanceLedger,
  EvaluationStatus,
  ModuleKindResult,
  S008AnalysisResult,
  S008Catalog,
  S008CatalogChannel,
  S008DeclarationResult,
  S008Finding,
  S008PolicyLoadResult,
  S008ProviderCandidate
} from '../types';
import { compareEurekaInterfaces, isEurekaInterfaceCompatible } from './eureka-interface-compatibility';
import { displayPolicyPath } from './acceptance-ledger';
import { reportPath, reportText } from './report-text';

export function evaluateS008(
  moduleKind: ModuleKindResult,
  channel: S008CatalogChannel,
  ledgerLoad: S008PolicyLoadResult<AcceptanceLedger>,
  catalogLoad: S008PolicyLoadResult<S008Catalog>,
  declarations: S008DeclarationResult
): S008AnalysisResult {
  const base = { criterionId: 'S008' as const, moduleKind, channel, declarations, findings: [] as S008Finding[], policyDiagnostics: [] };
  if (moduleKind.kind === 'library') return { ...base, status: EvaluationStatus.NOT_APPLICABLE, summary: 'S008 does not apply to FOLIO libraries.' };
  if (moduleKind.kind === 'ambiguous') {
    return {
      ...base,
      status: EvaluationStatus.MANUAL,
      summary: 'S008 could not tell whether this repository is a deployable module or a library, so a reviewer must decide whether S008 applies.'
    };
  }

  if (!ledgerLoad.ok || !catalogLoad.ok) {
    const diagnostics = [...(!ledgerLoad.ok ? ledgerLoad.diagnostics : []), ...(!catalogLoad.ok ? catalogLoad.diagnostics : [])];
    return {
      ...base,
      status: EvaluationStatus.MANUAL,
      summary: 'S008 could not load the evaluator\'s interface catalog or acceptance ledger, so the interfaces were not checked.',
      policyDiagnostics: diagnostics
    };
  }

  const findings = declarations.declarations.map(declaration => finding(declaration, ledgerLoad.value, catalogLoad.value));
  const failures = findings.filter(item => effect(item) === 'fail');
  const reviews = findings.filter(item => effect(item) === 'review');
  const status = failures.length ? EvaluationStatus.FAIL
    : reviews.length || !declarations.complete ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
  const catalogName = `${channel} catalog (${catalogLoad.value.baseline.descriptorVersion})`;
  return {
    ...base,
    status,
    summary: summarize(findings, failures, reviews, declarations, catalogName),
    ledger: { sourcePath: displayPolicyPath(ledgerLoad.sourcePath), digest: ledgerLoad.digest },
    catalog: {
      sourcePath: displayPolicyPath(catalogLoad.sourcePath),
      digest: catalogLoad.digest,
      baseline: catalogLoad.value.baseline,
      applications: catalogLoad.value.applications,
      eurekaComponents: catalogLoad.value.eurekaComponents
    },
    findings
  };
}

function summarize(
  findings: S008Finding[],
  failures: S008Finding[],
  reviews: S008Finding[],
  declarations: S008DeclarationResult,
  catalogName: string
): string {
  // With unreadable declarations, the count covers only the interfaces that could be read.
  const declared = declarations.complete ? 'the module declares' : 'that could be read';
  if (failures.length) {
    const subject = failures.length === findings.length
      ? findings.length === 1 ? `The one interface ${declared} is not` : `None of the ${findings.length} interfaces ${declared} is`
      : `${failures.length} of the ${findings.length} interfaces ${declared} ${failures.length === 1 ? 'is' : 'are'} not`;
    const alsoReviews = reviews.length
      ? ` ${reviews.length} more ${reviews.length === 1 ? 'needs' : 'need'} a reviewer: ${nameList(sortProblems(reviews))}.`
      : '';
    return `${subject} available from an accepted module in the ${catalogName}: ${nameList(sortProblems(failures))}.${alsoReviews}`;
  }
  if (reviews.length) {
    const subject = reviews.length === findings.length
      ? findings.length === 1 ? `The one interface ${declared} needs` : `All ${findings.length} interfaces ${declared} need`
      : `${reviews.length} of the ${findings.length} interfaces ${declared} ${reviews.length === 1 ? 'needs' : 'need'}`;
    return `${subject} a reviewer: ${nameList(sortProblems(reviews))}.${declarations.complete ? '' : ' Some declarations could not be read either.'}`;
  }
  if (!declarations.complete) {
    if (declarations.sourcePaths.length && findings.length) {
      return `No problems were found in the ${findings.length} interface${findings.length === 1 ? '' : 's'} that could be read, but some declarations could not be read, so a reviewer must check them.`;
    }
    return 'S008 could not find or read the module\'s interface declarations, so a reviewer must check its interfaces.';
  }
  if (findings.length) {
    return `${findings.length === 1 ? 'The one interface the module declares is' : `All ${findings.length} interfaces the module declares are`} provided by accepted modules in the ${catalogName}.`;
  }
  return 'The module declares no interfaces from other modules, so there is nothing to check.';
}

function finding(declaration: S008DeclarationResult['declarations'][number], ledger: Readonly<AcceptanceLedger>, catalog: Readonly<S008Catalog>): S008Finding {
  // Like mgr-tenant-entitlements, system interfaces (_tenant, _timer, ...) never satisfy a requirement.
  const candidates = catalog.providers.flatMap(provider => provider.provides
    .filter(provided => provided.id === declaration.id && provided.interfaceType !== 'system')
    .map(provided => candidate(provider, provided, declaration, ledger, catalog)));
  const satisfied = candidates.some(item => item.eligible && item.compatible);
  // -2: same major version, older minor version. An accepted provider may offer the newer one in a later release.
  const newerMinor = candidates.some(item => item.eligible && compareEurekaInterfaces({ id: declaration.id, version: item.version }, declaration) === -2);
  const classification = satisfied ? 'satisfied'
    : newerMinor ? 'newer-minor'
      : candidates.some(item => item.compatible && !item.eligible) ? 'unaccepted'
        : candidates.length ? 'incompatible' : 'missing';
  return { declaration, classification, candidates: candidates.sort((a, b) => `${a.moduleId}\0${a.version}`.localeCompare(`${b.moduleId}\0${b.version}`)) };
}

function candidate(
  provider: S008Catalog['providers'][number],
  provided: S008Catalog['providers'][number]['provides'][number],
  declaration: S008DeclarationResult['declarations'][number],
  ledger: Readonly<AcceptanceLedger>,
  catalog: Readonly<S008Catalog>
): S008ProviderCandidate {
  const { moduleId, moduleIdentity } = provider;
  const mapping = ledger.moduleIdentities.find(item => item.identity === moduleIdentity);
  const family = mapping && ledger.families.find(item => item.id === mapping.familyId);
  const accepted = Boolean(family && (family.acceptance.kind !== 'exception' || family.acceptance.scope === 'S008' || family.acceptance.scope === 'S008,S009'));
  const component = catalog.eurekaComponents.find(item => item.moduleIdentities.includes(moduleIdentity));
  const eligibility = accepted ? 'accepted-family' : component ? 'eureka-component' : 'unaccepted';
  return {
    moduleId,
    moduleIdentity,
    source: provider.source,
    descriptorHash: provider.descriptorHash,
    version: provided.version,
    interfaceType: provided.interfaceType,
    eligible: eligibility !== 'unaccepted',
    compatible: isEurekaInterfaceCompatible(provided, declaration),
    eligibility,
    familyId: accepted ? mapping!.familyId : component?.familyId
  };
}

const PROBLEM_SECTIONS: Array<[S008Finding['classification'], string]> = [
  ['missing', 'Not provided by any module in the catalog:'],
  ['incompatible', 'Needed version not in the catalog:'],
  ['unaccepted', 'Provided only by modules that are not accepted:']
];
const MAX_SUMMARY_NAMES = 5;

// A reviewer decides when an accepted provider may offer the newer minor version, or when an optional interface
// is missing: the module still works without it.
function effect(item: S008Finding): 'pass' | 'review' | 'fail' {
  if (item.classification === 'satisfied') return 'pass';
  return item.classification === 'newer-minor' || (item.classification === 'missing' && item.declaration.optional) ? 'review' : 'fail';
}

// Required interfaces first: they block the module from being enabled, optional ones only limit it.
function sortProblems(findings: S008Finding[]): S008Finding[] {
  return [...findings].sort((a, b) => Number(a.declaration.optional) - Number(b.declaration.optional));
}

function nameList(findings: S008Finding[]): string {
  const names = findings.slice(0, MAX_SUMMARY_NAMES)
    .map(item => `${reportText(`${item.declaration.id} ${item.declaration.version}`)}${item.declaration.optional ? ' (optional)' : ''}`);
  const more = findings.length - names.length;
  return more > 0 ? `${names.join(', ')}, and ${more} more` : names.join(', ');
}

// Okapi lists acceptable versions separated by spaces ("1.0 2.0"). The first one with the provider's major version
// decides, so they read as "or" only when their major versions differ; "1.6 1.4" stays as written.
function versions(expression: string): string {
  const alternatives = expression.split(' ').filter(Boolean);
  if (alternatives.length < 2) return expression;
  if (new Set(alternatives.map(version => version.split('.')[0])).size < alternatives.length) return `"${expression}"`;
  return `${alternatives.slice(0, -1).join(', ')} or ${alternatives[alternatives.length - 1]}`;
}

function provider(candidate: S008ProviderCandidate): string {
  return `${candidate.moduleId}${candidate.eligibility === 'eureka-component' ? ' (Eureka platform component)' : ''}`;
}

function findingLine(item: S008Finding): string {
  const { declaration, candidates } = item;
  // The interface id leads the row, so it is encoded like a path: it must stay one token before the [tag].
  const head = `  - ${reportPath(declaration.id)} [${declaration.optional ? 'optional' : 'required'}] Needs ${reportText(versions(declaration.version))}`;
  if (item.classification === 'satisfied') {
    const match = candidates.find(candidate => candidate.eligible && candidate.compatible)!;
    return `${head}; ${provider(match)} provides ${match.version}.`;
  }
  if (item.classification === 'incompatible') {
    const offered = candidates.map(candidate => `${candidate.version} (${provider(candidate)}${candidate.eligible ? '' : ', not accepted'})`);
    return `${head}, but the catalog only has ${offered.join(', ')}.`;
  }
  if (item.classification === 'newer-minor') {
    const accepted = candidates.filter(candidate => candidate.eligible);
    return `${head}, but accepted modules in the catalog only have ${accepted.map(candidate => `${candidate.version} (${provider(candidate)})`).join(', ')}.`;
  }
  if (item.classification === 'missing' && declaration.optional) return `${head}; no module in the catalog provides it.`;
  if (item.classification === 'unaccepted') {
    const providers = candidates.filter(candidate => candidate.compatible && !candidate.eligible).map(candidate => candidate.moduleId);
    return providers.length === 1
      ? `${head}. Only ${providers[0]} provides it, and the Technical Council has not accepted that module.`
      : `${head}. Only ${providers.join(', ')} provide it, and the Technical Council has not accepted those modules.`;
  }
  return `${head}.`;
}

function reviewAdvice(analysis: S008AnalysisResult): Array<string | undefined> {
  const reviews = analysis.findings.filter(item => effect(item) === 'review');
  const release = analysis.catalog?.baseline.descriptorVersion;
  return [
    reviews.some(item => item.classification === 'newer-minor')
      ? `A reviewer must check that an accepted module provides the newer versions listed under "Needs a reviewer"; the catalog is based on ${release} and may not have newer releases of those modules.`
      : undefined,
    reviews.some(item => item.classification === 'missing')
      ? 'A reviewer must check whether an accepted module provides the optional interfaces listed under "Needs a reviewer" that no module in the catalog provides.'
      : undefined
  ];
}

function whatToDo(analysis: S008AnalysisResult): string | undefined {
  if (analysis.status === EvaluationStatus.FAIL) {
    const failures = analysis.findings.filter(item => effect(item) === 'fail');
    const has = (classification: S008Finding['classification']) => failures.some(item => item.classification === classification);
    return [
      has('missing') ? 'Stop using interfaces that no module in the catalog provides, or have the module that provides them accepted by the Technical Council and released in the platform.' : undefined,
      has('incompatible') ? 'Require a version that an accepted module in the catalog provides; a newer version counts only once a platform release that includes it is added to the catalog.' : undefined,
      has('unaccepted') ? 'Use interfaces from accepted modules, or have the module that provides them accepted by the Technical Council.' : undefined,
      failures.some(item => item.declaration.optional) ? 'This applies to optional interfaces too.' : undefined,
      ...reviewAdvice(analysis),
      analysis.declarations.complete ? undefined : 'Also fix the problems under "Declarations that could not be read", or check those interfaces by hand.'
    ].filter(Boolean).join(' ');
  }
  if (analysis.status !== EvaluationStatus.MANUAL) return undefined;
  if (analysis.findings.some(item => effect(item) === 'review')) {
    return [
      ...reviewAdvice(analysis),
      analysis.declarations.complete ? undefined : 'Also fix the problems under "Declarations that could not be read", or check those interfaces by hand.'
    ].filter(Boolean).join(' ');
  }
  if (analysis.moduleKind.kind === 'ambiguous') {
    return 'Decide whether this repository is a deployable module. If it is, check by hand that every interface it declares is provided by an accepted module.';
  }
  if (analysis.policyDiagnostics.length) {
    return `Fix the evaluator files listed under "Problems with the evaluator's catalog or ledger" and rerun the evaluation.${analysis.channel === 'development' ? ' To use the official catalog instead, run with --s008-catalog official.' : ''}`;
  }
  return 'Fix the problems under "Declarations that could not be read" and rerun the evaluation, or check those interfaces by hand.';
}

function diagnosticLine(item: { message: string }): string {
  return `  - ${reportText(item.message)}`;
}

export function renderS008HumanDetails(analysis: S008AnalysisResult): string {
  // The summary is the criterion's evidence line, which the report already shows above the details.
  const lines: string[] = [];
  const action = whatToDo(analysis);
  if (action) lines.push(`What to do: ${action}`);
  if (analysis.moduleKind.kind === 'library' || analysis.moduleKind.kind === 'ambiguous') {
    const reason = analysis.moduleKind.evidence.length ? ` (${analysis.moduleKind.evidence.join('; ')})` : '';
    lines.push(`Repository kind: ${analysis.moduleKind.kind === 'library' ? 'library' : 'could not be determined'}${reason}`);
    return lines.join('\n');
  }

  const section = (title: string, rows: string[]) => { if (rows.length) lines.push(...(lines.length ? [''] : []), title, ...rows); };
  for (const [classification, title] of PROBLEM_SECTIONS) {
    section(title, sortProblems(analysis.findings.filter(item => item.classification === classification && effect(item) === 'fail')).map(findingLine));
  }
  section('Needs a reviewer:', sortProblems(analysis.findings.filter(item => effect(item) === 'review')).map(findingLine));
  section('Provided by accepted modules:', analysis.findings.filter(item => item.classification === 'satisfied').map(findingLine));
  section('Declarations that could not be read:', analysis.declarations.diagnostics.map(diagnosticLine));
  section('Problems with the evaluator\'s catalog or ledger:', analysis.policyDiagnostics.map(diagnosticLine));

  const catalog = analysis.catalog;
  // "Declarations read from" sits here, not at the top, so the details have at most eight top-level rows and sections:
  // the HTML report shows only six of nine or more.
  section('Sources:', [
    ...(analysis.declarations.sourcePaths.length ? [`  - Declarations read from: ${analysis.declarations.sourcePaths.map(reportPath).join(', ')}`] : []),
    `  - Catalog channel: ${analysis.channel}`,
    ...(catalog ? [
      `  - Platform release: ${catalog.baseline.descriptorVersion} (${catalog.baseline.platformRepository} at commit ${catalog.baseline.platformCommit})`,
      `  - Catalog file: ${catalog.sourcePath}`
    ] : []),
    ...(analysis.ledger ? [`  - Acceptance ledger: ${analysis.ledger.sourcePath}`] : []),
    ...(catalog?.applications.length ? [
      '  - Applications:',
      ...catalog.applications.map(app => `    - ${app.name} ${app.version}${app.optional ? ' (optional application)' : ''}`)
    ] : []),
    ...(catalog?.eurekaComponents.length ? [
      '  - Eureka platform components:',
      ...catalog.eurekaComponents.map(component => {
        const source = component.descriptorSource;
        const origin = source.status === 'intentionally-descriptorless' ? 'has no module descriptor'
          : source.status === 'unresolved' ? 'descriptor not found'
            : source.kind === 'repository-tag' ? `descriptor from ${source.repository} at ${source.tag}`
              : `descriptor from ${source.source}`;
        return `    - ${component.familyId} ${component.version} (${origin})`;
      })
    ] : [])
  ]);
  return lines.join('\n');
}
