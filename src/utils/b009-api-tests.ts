import {
  B009Analysis,
  B009Basis,
  B009FrameworkId,
  B009IntegrationTestsLookup,
  B009Suite,
  B009Support,
  BackendRepositoryKind,
  EvaluationRun,
  EvaluationStatus,
  FrontendChecklistItem,
  RemoteEvidenceRecord,
  RemoteLookups,
  S007PolicyLoadResult,
  S014ModuleName
} from '../types';
import { getBackendEvidence } from './backend-evidence';
import { CommittedSourceDiagnostic, CommittedSourceSnapshot, readCommittedSource } from './committed-source';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { sourceLine } from './remote-evidence';
import { count, listText, overflowLine, reportPath, reportText } from './report-text';
import { findPolicyEntry, loadS007Policy } from './s007-policy';
import { resolveS014ModuleName } from './s014-application-assignment';
import { isRecord } from './type-guards';

const INTEGRATION_TESTS = 'https://api.github.com/repos/folio-org/folio-integration-tests';
// GitHub's contents API lists at most 1,000 entries of a directory.
const GITHUB_LISTING_LIMIT = 1_000;
const TREE_SHA = /^[0-9a-f]{40}$/;
const SHOWN_FILES = 20;
const POLICY_SECTION = 'backend-integration-testing';

const FEATURE = /\.feature$/;
const KARATE_CONFIG = /(?:^|\/)karate-config\.js$/;
const KARATE_STEP = /^[ \t]*(?:\*|Given|When|Then|And|But)[ \t]+(?:method[ \t]+(?:get|post|put|patch|delete|head|options)[ \t\r]*$|status[ \t]+\d{3}[ \t\r]*$|def[ \t]+\w+[ \t]*=|callonce?[ \t]+read[ \t]*\(|url[ \t]+(?:['"]|\w*Url\b)|match[ \t]+\S+[ \t]+(?:==|!=|contains\b))/m;

const COLLECTIONS: Array<{ id: B009FrameworkId; displayName: string; path: RegExp }> = [
  { id: 'postman', displayName: 'Postman', path: /\.postman_collection\.json$/i },
  { id: 'bruno', displayName: 'Bruno', path: /(?:^|\/)bruno\.json$|\.bru$/i },
  { id: 'insomnia', displayName: 'Insomnia', path: /(?:^|\/)\.insomnia\/|(?:^|\/)insomnia[^/]*\.(?:json|ya?ml)$/i }
];
const POSTMAN_NAME = COLLECTIONS[0].path;
const POSTMAN_FOLDER = /(?:^|\/)(?:postman|collections)\//i;
const POSTMAN_SCHEMA = /^https?:\/\/schema\.(?:get)?postman\.com\/json\/collection\//i;
const isPostmanCandidate = (path: string) => /\.json$/i.test(path) && POSTMAN_FOLDER.test(path) && !POSTMAN_NAME.test(path);

export interface B009Inputs {
  kind: BackendRepositoryKind;
  snapshot?: CommittedSourceSnapshot;
  policyLoad?: S007PolicyLoadResult;
  remoteLookups: boolean;
  moduleName?: S014ModuleName;
  integrationTests?: B009IntegrationTestsLookup;
  remoteEvidence: RemoteEvidenceRecord[];
}

export async function analyzeB009(repoPath: string, run: EvaluationRun): Promise<B009Analysis> {
  const { kind } = await getBackendEvidence(run, repoPath);
  const inputs: B009Inputs = { kind, remoteLookups: Boolean(run.remoteLookups), remoteEvidence: [] };
  if (kind === 'library') return evaluateB009(inputs);
  [inputs.snapshot, inputs.policyLoad] = await Promise.all([readCommittedSource(repoPath, {
    include: path => FEATURE.test(path) || isPostmanCandidate(path),
    list: path => KARATE_CONFIG.test(path) || COLLECTIONS.some(rule => rule.path.test(path)),
    maxTreeBytes: 16 * 1024 * 1024,
    maxEntries: 50_000,
    maxFiles: 2_000
  }), loadS007Policy()]);
  if (kind === 'ambiguous') return evaluateB009(inputs);
  inputs.moduleName = resolveS014ModuleName(repoPath, 'backend-module', run.repositoryName);
  if (!run.remoteLookups) return evaluateB009(inputs);
  inputs.integrationTests = inputs.moduleName.name
    ? await lookUpIntegrationTests(run.remoteLookups, inputs.moduleName.name, inputs.remoteEvidence)
    : { folder: '', outcome: 'unread', problem: inputs.moduleName.problem ?? 'The tool could not tell the module name.', featureFiles: [], featureFileCount: 0 };
  return evaluateB009(inputs);
}

export async function lookUpIntegrationTests(lookups: RemoteLookups, folder: string, records: RemoteEvidenceRecord[]): Promise<B009IntegrationTestsLookup> {
  const base = { folder, featureFiles: [], featureFileCount: 0 };
  const unread = (problem: string): B009IntegrationTestsLookup => ({ ...base, outcome: 'unread', problem });
  const listing = await lookups.getJson(`${INTEGRATION_TESTS}/contents/`);
  records.push(listing.record);
  if (!listing.ok) return unread(`The top-level listing of folio-integration-tests could not be read (${listing.record.error}).`);
  if (!Array.isArray(listing.json)) return unread('The top-level listing of folio-integration-tests is not a list of entries.');
  const entry = listing.json.find(item => isRecord(item) && item.name === folder);
  if (isRecord(entry) && entry.type !== 'dir') return unread(`The entry named ${folder} in folio-integration-tests is not a folder.`);
  if (!isRecord(entry)) {
    return listing.json.length >= GITHUB_LISTING_LIMIT
      ? unread(`The top-level listing of folio-integration-tests has ${listing.json.length} entries, the most GitHub lists, so it may be incomplete.`)
      : { ...base, outcome: 'no-folder' };
  }
  if (typeof entry.sha !== 'string' || !TREE_SHA.test(entry.sha)) return unread(`The listing gives no tree id for the folder ${folder}/.`);
  const tree = await lookups.getJson(`${INTEGRATION_TESTS}/git/trees/${entry.sha}?recursive=1`);
  records.push(tree.record);
  if (!tree.ok) return unread(`The folder ${folder}/ could not be read (${tree.record.error}).`);
  if (!isRecord(tree.json) || !Array.isArray(tree.json.tree)) return unread(`The listing of the folder ${folder}/ is not a git tree.`);
  if (tree.json.truncated !== false) return unread(`GitHub listed the folder ${folder}/ only in part (truncated).`);
  const blobs = tree.json.tree.flatMap(item => isRecord(item) && item.type === 'blob' && typeof item.path === 'string' ? [item.path] : []);
  const features = blobs.filter(path => FEATURE.test(path));
  const karateConfig = blobs.find(path => KARATE_CONFIG.test(path));
  return {
    folder,
    outcome: 'folder',
    featureFiles: features.slice(0, SHOWN_FILES).map(path => `${folder}/${path}`),
    featureFileCount: features.length,
    ...(karateConfig ? { karateConfig: `${folder}/${karateConfig}` } : {})
  };
}

/**
 * B009 (if provided, API tests in a supported technology). Not applicable to libraries, or when neither the repository
 * nor a folio-integration-tests folder named after the module has API tests; fail for a framework the policy does not
 * list; pass for Karate; manual otherwise, including when remote lookups are off and the repository has none.
 */
export function evaluateB009(inputs: B009Inputs): B009Analysis {
  const { kind, snapshot, integrationTests } = inputs;
  const policy = karatePolicy(inputs.policyLoad);
  const diagnostics = snapshot?.diagnostics ?? [];
  const unread = [
    ...diagnostics.filter(diagnostic => diagnostic.material && !isSkippedCandidate(diagnostic))
      .map(diagnostic => ({ ...(diagnostic.path ? { path: diagnostic.path } : {}), message: diagnostic.message })),
    ...(snapshot?.files ?? []).filter(file => isPostmanCandidate(file.path) && postmanSchema(file.content) === undefined)
      .map(file => ({ path: file.path, message: 'Is not valid JSON, so the tool could not tell whether it is a Postman collection.' }))
  ];
  const skipped = diagnostics.filter(isSkippedCandidate).map(diagnostic => ({ path: diagnostic.path!, message: diagnostic.message }));
  const suites = [...repositorySuites(snapshot, policy), ...integrationTestSuites(integrationTests, policy)];
  const base = {
    criterionId: 'B009' as const, kind, remoteLookups: inputs.remoteLookups, ...(inputs.moduleName ? { moduleName: inputs.moduleName } : {}),
    suites, ...(integrationTests ? { integrationTests } : {}),
    policy: policy.loaded
      ? { loaded: true, displayName: policy.entry.displayName, strength: policy.entry.strength, provisional: policy.provisional }
      : { loaded: false, ...(policy.problem ? { problem: policy.problem } : {}) },
    unread, ...(skipped.length ? { skipped } : {}), remoteEvidence: inputs.remoteEvidence
  };
  const folder = integrationTests?.folder || inputs.moduleName?.name;
  const karateName = policy.loaded ? reportText(policy.entry.displayName) : 'Karate';
  const items: FrontendChecklistItem[] = [];
  if (suites.length) {
    items.push({
      id: 'B009-C1',
      title: 'Each API test suite listed uses Karate, the framework the supported technologies page lists, or is not an API test suite.',
      startingPoints: suites.flatMap(suite => (suite.configFile ? [suite.configFile] : []).concat(suite.files).slice(0, SHOWN_FILES)
        .map(path => ({ path, note: `${suite.displayName}${suite.source === 'folio-integration-tests' ? ' in folio-integration-tests' : ''}` }))),
      reviewerOnly: true,
      obligations: []
    });
  }
  const result = (status: EvaluationStatus, basis: B009Basis, summary: string): B009Analysis => {
    if (status === EvaluationStatus.MANUAL && basis !== 'unclear-suites' && basis !== 'policy-unavailable') {
      items.push({
        id: 'B009-C2',
        title: `The module's API tests, in the repository or outside it (such as in folio-integration-tests, in a folder ${folder ? `named ${reportText(folder)} or ` : ''}under another name), use Karate.`,
        startingPoints: [],
        reviewerOnly: true,
        obligations: []
      });
    }
    return { ...base, status, basis, summary: `B009 ${status === EvaluationStatus.NOT_APPLICABLE ? 'not applicable' : status}: ${summary}`, checklist: frontendChecklist(status, items) };
  };

  if (kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'library', 'The repository is a shared library, which has no API of its own to test.');
  }
  const found = foundText(suites, integrationTests?.folder);
  if (kind === 'ambiguous') {
    return result(EvaluationStatus.MANUAL, 'ambiguous',
      `No module descriptor was found, and the repository is not a known shared library, so the tool could not tell whether it needs API tests (see B001).${found ? ` ${found}` : ''}`);
  }
  if (suites.length && !policy.loaded) {
    return result(EvaluationStatus.MANUAL, 'policy-unavailable', `${found} The Karate entry of the officially supported technologies list could not be read (${reportText(policy.problem ?? '')}).`);
  }
  const unlisted = suites.filter(suite => suite.support === 'unlisted');
  if (unlisted.length) {
    const names = listText(unlisted.map(suite => suite.displayName));
    return result(EvaluationStatus.FAIL, 'unlisted-framework',
      `The repository has API tests in ${names}, which ${unlisted.length === 1 ? 'is' : 'are'} not on the officially supported technologies page (it lists ${karateName} for backend API tests).`);
  }
  const problems: string[] = [];
  if (unread.length) problems.push('The tool could not read every file in the repository that would show API tests.');
  const lookupFailed = integrationTests?.outcome === 'unread';
  if (lookupFailed) problems.push(`The tool could not look in folio-integration-tests: ${reportText(integrationTests.problem ?? '')}`);
  const lookupNote = (onlyProblem: boolean): string[] => !lookupFailed ? []
    : [onlyProblem ? 'B009 is manual because of this lookup, not because API tests are missing or failing.' : 'This lookup failure does not mean API tests are missing or failing.'];
  const unclear = suites.filter(suite => suite.support === 'unclear');
  const emptyFolder = integrationTests?.outcome === 'folder' && integrationTests.featureFileCount === 0;
  if (unclear.length || emptyFolder) {
    const sentences = unclear.map(suite => suite.source === 'repository'
      ? `The repository has ${count(suite.fileCount, '.feature file')} without Karate syntax or a karate-config.js, which may be Cucumber or Karate tests.`
      : `folio-integration-tests has ${count(suite.fileCount, '.feature file')} in ${reportText(folder ?? '')}/ but no karate-config.js, so the tool could not tell whether they are Karate tests.`);
    if (emptyFolder) sentences.push(`folio-integration-tests has a folder named ${reportText(folder ?? '')}, but it has no .feature files.`);
    const supported = suites.filter(suite => suite.support === 'supported');
    return result(EvaluationStatus.MANUAL, 'unclear-suites',
      [...(supported.length ? [foundText(supported, integrationTests?.folder)] : []), ...sentences, ...problems, ...lookupNote(false), 'A reviewer must check which framework the API tests use.'].join(' '));
  }
  if (problems.length) {
    return result(EvaluationStatus.MANUAL, 'incomplete', [...(found ? [found] : []), ...problems, ...lookupNote(problems.length === 1), `A reviewer must check the module's API tests${lookupFailed ? ', including folio-integration-tests' : ''}.`].join(' '));
  }
  if (suites.length) {
    return result(EvaluationStatus.PASS, 'karate', [
      found,
      ...(policy.loaded && policy.provisional ? [`(${karateName} is listed as provisional on the supported technologies page.)`] : []),
      ...(integrationTests ? [] : ['folio-integration-tests was not checked, because remote lookups are off.'])
    ].join(' '));
  }
  if (!integrationTests) {
    return result(EvaluationStatus.MANUAL, 'lookups-off',
      `The repository has no API tests; folio-integration-tests not checked, because remote lookups are off. Rerun with --allow-remote-lookups to look for a folder named ${folder ? reportText(folder) : 'after the module'} there.`);
  }
  return result(EvaluationStatus.NOT_APPLICABLE, 'no-tests',
    `The repository has no API tests, and folio-integration-tests has no folder named ${reportText(integrationTests.folder)}. The tool looks only for a folder named after the module, so tests kept under another name (such as erm/ for mod-agreements) are not seen.`);
}

type KaratePolicy =
  | { loaded: true; entry: { displayName: string; strength: string }; provisional: boolean; listed: (id: B009FrameworkId) => boolean }
  | { loaded: false; problem?: string };

function karatePolicy(policyLoad: S007PolicyLoadResult | undefined): KaratePolicy {
  if (!policyLoad) return { loaded: false };
  if (!policyLoad.ok) return { loaded: false, problem: policyLoad.diagnostics.map(diagnostic => diagnostic.message).join(' ') || 'the policy could not be loaded' };
  const section = policyLoad.policy.sections.find(candidate => candidate.id === POLICY_SECTION);
  const entry = section && findPolicyEntry([section], 'karate')?.entry;
  if (!section || !entry) return { loaded: false, problem: `the policy has no Karate entry under ${POLICY_SECTION}` };
  return { loaded: true, entry, provisional: Boolean(entry.provisional) || entry.strength === 'provisional', listed: id => Boolean(findPolicyEntry([section], id)) };
}

function support(policy: KaratePolicy, id: B009FrameworkId): B009Support {
  if (id === 'feature-files' || !policy.loaded) return 'unclear';
  return policy.listed(id) ? 'supported' : 'unlisted';
}

function repositorySuites(snapshot: CommittedSourceSnapshot | undefined, policy: KaratePolicy): B009Suite[] {
  if (!snapshot) return [];
  const listed = snapshot.listedPaths ?? [];
  const configFile = listed.find(path => KARATE_CONFIG.test(path));
  const features = snapshot.files.filter(file => FEATURE.test(file.path));
  const karate = configFile ? features : features.filter(file => KARATE_STEP.test(file.content));
  const other = configFile ? [] : features.filter(file => !KARATE_STEP.test(file.content));
  const suite = (framework: B009FrameworkId, displayName: string, paths: string[], extra: Partial<B009Suite> = {}): B009Suite[] => paths.length ? [{
    source: 'repository', framework, displayName, support: support(policy, framework), files: paths.slice(0, SHOWN_FILES), fileCount: paths.length, ...extra
  }] : [];
  return [
    ...suite('karate', 'Karate', karate.map(file => file.path), configFile && karate.length ? { configFile } : {}),
    ...suite('feature-files', 'Gherkin', other.map(file => file.path)),
    ...COLLECTIONS.flatMap(rule => suite(rule.id, rule.displayName, listed.filter(path => rule.path.test(path))
      .concat(rule.id === 'postman' ? postmanCollections(snapshot.files) : []).sort()))
  ];
}

function postmanCollections(files: CommittedSourceSnapshot['files']): string[] {
  return files.filter(file => isPostmanCandidate(file.path) && POSTMAN_SCHEMA.test(postmanSchema(file.content) ?? '')).map(file => file.path);
}

/** The collection's `info.schema`, '' when it has none, or undefined when the file is not valid JSON. */
function postmanSchema(content: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    const info = isRecord(parsed) ? parsed.info : undefined;
    return isRecord(info) && typeof info.schema === 'string' ? info.schema : '';
  } catch {
    return undefined;
  }
}

const SKIPPED_CANDIDATE_CODES = new Set(['file-size', 'total-size', 'binary']);
const isSkippedCandidate = (diagnostic: CommittedSourceDiagnostic) =>
  diagnostic.path !== undefined && isPostmanCandidate(diagnostic.path) && SKIPPED_CANDIDATE_CODES.has(diagnostic.code);

function integrationTestSuites(lookup: B009IntegrationTestsLookup | undefined, policy: KaratePolicy): B009Suite[] {
  if (lookup?.outcome !== 'folder' || !lookup.featureFileCount) return [];
  const framework: B009FrameworkId = lookup.karateConfig ? 'karate' : 'feature-files';
  return [{
    source: 'folio-integration-tests',
    framework,
    displayName: lookup.karateConfig ? 'Karate' : 'Gherkin',
    support: support(policy, framework),
    files: lookup.featureFiles,
    fileCount: lookup.featureFileCount,
    ...(lookup.karateConfig ? { configFile: lookup.karateConfig } : {})
  }];
}

function foundText(suites: B009Suite[], folder: string | undefined): string {
  const sentences: string[] = [];
  const karate = (source: B009Suite['source']) => suites.find(suite => suite.source === source && suite.framework === 'karate');
  const inRepository = karate('repository');
  if (inRepository) sentences.push(`The repository has Karate API tests (${count(inRepository.fileCount, '.feature file')}${inRepository.configFile ? ' and karate-config.js' : ''}).`);
  const remote = karate('folio-integration-tests');
  if (remote) sentences.push(`folio-integration-tests has Karate feature files in ${reportText(folder ?? '')}/ (${count(remote.fileCount, '.feature file')} and karate-config.js).`);
  const others = suites.filter(suite => suite.framework !== 'karate' && suite.source === 'repository');
  if (others.length) sentences.push(`The repository has ${listText(others.map(suite => `${suite.displayName} tests (${fileCount(suite)})`))}.`);
  const remoteOther = suites.find(suite => suite.framework !== 'karate' && suite.source === 'folio-integration-tests');
  if (remoteOther) sentences.push(`folio-integration-tests has ${fileCount(remoteOther)} in ${reportText(folder ?? '')}/.`);
  return sentences.join(' ');
}

function fileCount(suite: B009Suite): string {
  return count(suite.fileCount, suite.framework === 'karate' || suite.framework === 'feature-files' ? '.feature file' : 'file');
}

const SUPPORT_LABELS: Record<B009Support, string> = {
  supported: 'on the supported technologies page',
  unlisted: 'an API test framework not on the supported technologies page',
  unclear: 'framework unclear'
};

const KIND_LABELS: Record<BackendRepositoryKind, string> = {
  'backend-module': 'a backend module',
  'edge-module': 'an edge module',
  library: 'a shared library',
  ambiguous: 'neither a module with a descriptor nor a known shared library'
};

export function renderB009HumanDetails(analysis: B009Analysis): string {
  const lines = [`Evaluated as: ${KIND_LABELS[analysis.kind]}`];
  if (analysis.kind === 'library') return [...lines, ...whatToDo(analysis)].join('\n');
  lines.push(`Policy: ${analysis.policy.loaded
    ? `${reportText(analysis.policy.displayName ?? '')} (${reportText(analysis.policy.strength ?? '')}) under ${POLICY_SECTION}`
    : `not loaded: ${reportText(analysis.policy.problem ?? '')}`}`, ...whatToDo(analysis));
  const suiteLines = (suite: B009Suite) => [
    `  - ${suite.displayName} (${SUPPORT_LABELS[suite.support]}): ${fileCount(suite)}${suite.configFile ? `, with ${reportPath(suite.configFile)}` : ''}`,
    ...suite.files.map(path => `    - ${reportPath(path)}`),
    ...overflowLine(suite.fileCount, suite.files.length, '    ')
  ];
  const inRepository = analysis.suites.filter(suite => suite.source === 'repository');
  lines.push('API tests in the repository:', ...(inRepository.length ? inRepository.flatMap(suiteLines)
    : ['  - none (no Karate or other .feature files, and no Postman, Bruno or Insomnia collections)']));
  if (analysis.kind !== 'ambiguous') {
    const lookup = analysis.integrationTests;
    const name = analysis.moduleName;
    lines.push('folio-integration-tests (only a folder named after the module is searched):');
    if (name?.name) lines.push(`  - Module name: ${reportText(name.name)} (${name.path ? `from ${reportPath(name.path)}` : 'the repository name'})`);
    if (!lookup) {
      lines.push('  - Not checked: remote lookups are off');
    } else if (lookup.outcome === 'unread') {
      lines.push(`  - Not checked: ${reportText(lookup.problem ?? '')}`);
    } else if (lookup.outcome === 'no-folder') {
      lines.push(`  - No folder named ${reportText(lookup.folder)}; tests kept under another name, such as erm/ for mod-agreements, are not seen`);
    } else {
      const remote = analysis.suites.find(suite => suite.source === 'folio-integration-tests');
      lines.push(...(remote ? suiteLines(remote) : [`  - ${reportText(lookup.folder)}/ has no .feature files`]));
    }
  }
  if (analysis.status === EvaluationStatus.PASS && analysis.policy.provisional) {
    lines.push('Policy note:', '  - The officially supported technologies page lists Karate as provisional. B009 passes Karate API tests, as decided for this criterion.');
  }
  if (analysis.unread.length) {
    lines.push('What the tool could not read:', ...analysis.unread.map(item => `  - ${item.path ? `${reportPath(item.path)} — ` : ''}${reportText(item.message)}`));
  }
  if (analysis.skipped?.length) {
    lines.push('Skipped JSON files under postman/ or collections/ (too large to check for a Postman schema; they do not affect the result):',
      ...analysis.skipped.map(item => `  - ${reportPath(item.path)} — ${reportText(item.message)}`));
  }
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  if (analysis.remoteEvidence.length) lines.push('Sources:', ...analysis.remoteEvidence.map(sourceLine));
  return lines.join('\n');
}

function whatToDo(analysis: B009Analysis): string[] {
  if (analysis.status === EvaluationStatus.FAIL) {
    const names = listText(analysis.suites.filter(suite => suite.support === 'unlisted').map(suite => suite.displayName));
    return ['What to do:', `  - Write the module's API tests in Karate, for example in folio-integration-tests, and remove the ${names} tests.`];
  }
  switch (analysis.basis) {
    case 'lookups-off':
      return ['What to do:', '  - Rerun with --allow-remote-lookups, or check folio-integration-tests by hand for the module\'s API tests.'];
    case 'library':
      return ['What to do: Nothing; a shared library has no API of its own to test.'];
    case 'ambiguous':
      return ['What to do: Check whether the repository is a module with an API of its own, and if so that its API tests use Karate (the checklist below).'];
    case 'policy-unavailable':
      return ['What to do: Check that each API test suite on the checklist below uses Karate, the framework the supported technologies page lists for backend API tests.'];
    case 'unclear-suites':
      return ['What to do: Check which framework each API test suite on the checklist below uses; only Karate is on the supported technologies page.'];
    case 'incomplete':
      return ['What to do: Check that the module\'s API tests use Karate, starting with the checklist below.'];
    case 'karate':
      return ['What to do: Nothing; the module\'s API tests use Karate, the framework the supported technologies page lists for backend API tests.'];
    default:
      return ['What to do: Nothing; the tool found no API tests to check, in the repository or in a folio-integration-tests folder named after the module.'];
  }
}
