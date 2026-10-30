import YAML, { isAlias, isMap, isScalar, isSeq, LineCounter, Node as YamlNode } from 'yaml';
import {
  B014ActuatorApplication,
  B014ActuatorProblem,
  B014Analysis,
  B014Basis,
  B014Mechanism,
  B014Runtime,
  BackendEvidence,
  BackendRuntimeEvidence,
  EvaluationStatus,
  FrontendChecklistItem
} from '../types';
import { CommittedSourceDiagnostic, CommittedSourceFile } from './committed-source';
import { REST_VERTICLE, SOURCE_FILE } from './backend-evidence';
import { HEALTH_ROUTE, lineCounter, sourceRoutes, withoutComments } from './backend-routes';
import { runtimeDockerLines, runtimeOutcomeText, runtimeSummary } from './backend-runtime-harness';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { count, listText, overflowLine, reportPath, reportText } from './report-text';

const MAX_ROWS = 20;
const MAX_YAML_DEPTH = 64;
const MAX_CONDITIONS = 100;
const SPRING_BOOT_APPLICATION = /^[ \t]*@SpringBootApplication\b/m;
const GRAILS_APP = /^(.*?)grails-app\//;
const CONFIG_FILE = /^(.*?)(src\/main\/resources\/(?:config\/)?|grails-app\/conf\/)application(?:-([^/]+))?\.(ya?ml|properties|groovy)$/;
const MAX_PROBLEMS = 50;
const ACTUATOR_ARTIFACTS = new Set(['spring-boot-starter-actuator', 'spring-boot-actuator', 'spring-boot-actuator-autoconfigure', 'folio-spring-base']);
const GRADLE_DEPENDENCY = /^[ \t]*(?:implementation|api|compile|runtime|runtimeOnly)\b[^\n{]*?\b(?:spring-boot-(?:starter-)?actuator(?:-autoconfigure)?|folio-spring-base)\b(?!-)/m;
const POM_IGNORED: Array<[string, string]> = [['<!--', '-->'], ['<exclusions>', '</exclusions>'], ['<dependencyManagement>', '</dependencyManagement>'], ['<build>', '</build>'], ['<profiles>', '</profiles>']];
const DOCKER_SETTING = /(?:(?<=-D)|\b)(?:management[_.][\w.-]+|server[_.](?:servlet|context)[\w.-]*|server[_.]port[ \t=:]+["']?-1\b|spring[_.](?:mvc|webflux|main|config)[\w.-]*|spring_application_json)/i;
const FALSE_VALUES = new Set(['false', 'off', 'no', '0']);
const TRUE_VALUES = new Set(['true', 'on', 'yes', '1']);
const ACTIVATION_KEYS = new Set(['spring.config.activate.onprofile', 'spring.profiles', 'spring.config.activate.oncloudplatform']);
const GROOVY_SETTING = /\b(?:management|server|spring\s*\.\s*(?:mvc|webflux|main))\b/;
const PLACEHOLDER_VALUE = /\$\{|@[^@\s]+@/;

const KEYS = {
  basePath: 'management.endpoints.web.base-path',
  pathMapping: 'management.endpoints.web.path-mapping.health',
  include: 'management.endpoints.web.exposure.include',
  exclude: 'management.endpoints.web.exposure.exclude',
  healthEnabled: 'management.endpoint.health.enabled',
  enabledByDefault: 'management.endpoints.enabled-by-default',
  healthAccess: 'management.endpoint.health.access',
  accessDefault: 'management.endpoints.access.default',
  maxPermitted: 'management.endpoints.access.max-permitted',
  managementPort: 'management.server.port',
  contextPath: 'server.servlet.context-path',
  legacyContextPath: 'server.context-path',
  servletPath: 'spring.mvc.servlet.path',
  webfluxBasePath: 'spring.webflux.base-path',
  webApplicationType: 'spring.main.web-application-type',
  serverPort: 'server.port',
  configImport: 'spring.config.import',
  configLocation: 'spring.config.location',
  configAdditionalLocation: 'spring.config.additional-location'
} as const;
const RELEVANT = new Set(Object.values(KEYS).map(canonicalKey));
const PREFIXES = [KEYS.contextPath, KEYS.legacyContextPath, KEYS.servletPath, KEYS.webfluxBasePath];
const PREFIX_NAMES = new Set([...PREFIXES, KEYS.webApplicationType, KEYS.serverPort, KEYS.configImport, KEYS.configLocation, KEYS.configAdditionalLocation].map(canonicalKey));

interface Setting {
  key: string;
  value: string;
  path: string;
  line?: number;
  alias?: boolean;
}

type Problem = B014ActuatorProblem & { actuatorOnly?: boolean };

type Settings = Map<string, Setting[]>;

interface ConfigSource {
  settings: Setting[];
  condition?: string;
}

/**
 * B014 (GET /admin/health returns 200) decides from the mechanism the framework uses to serve it: RMB's RestVerticle as
 * the main verticle, Spring Boot actuator configured at /admin, or a route in the source. With `runtime` from the
 * runtime harness, a module whose health check was called is decided by its answer: 200 passes, anything else is
 * manual; when the module never reached the health check, the committed files decide.
 */
export function evaluateB014(evidence: BackendEvidence, runtime?: BackendRuntimeEvidence): B014Analysis {
  const analysis = staticB014(evidence);
  if (!runtime) return analysis;
  const summary: B014Runtime = { ...runtimeSummary(runtime), ...(runtime.health ? { health: runtime.health } : {}) };
  const health = runtime.health;
  if (!health || analysis.basis === 'library' || analysis.basis === 'ambiguous') return { ...analysis, runtime: summary };
  if (health.status === 200) {
    return { ...analysis, status: EvaluationStatus.PASS, basis: 'runtime-200', endpointCalled: true, runtime: summary,
      summary: `B014 pass: GET ${HEALTH_ROUTE} answered 200 when the tool ran the module in Docker.`, checklist: frontendChecklist(EvaluationStatus.PASS, []) };
  }
  return { ...analysis, status: EvaluationStatus.MANUAL, basis: 'runtime-not-200', endpointCalled: true, runtime: summary,
    summary: `B014 manual: GET ${HEALTH_ROUTE} ${healthAnswer(health)} when the tool ran the module in Docker. The tool starts no more than an Okapi stub, PostgreSQL and Kafka beside it, so a reviewer must check that it answers 200 once the module's dependencies are available.`,
    checklist: frontendChecklist(EvaluationStatus.MANUAL, [...analysis.checklist.items, {
      id: 'B014-C2',
      title: `GET ${HEALTH_ROUTE} returns 200 once the module's dependencies are available.`,
      startingPoints: analysis.mechanisms.map(mechanism => ({ path: mechanism.path, line: mechanism.line, note: mechanism.note })),
      reviewerOnly: true,
      obligations: []
    }]) };
}

function staticB014(evidence: BackendEvidence): B014Analysis {
  const { kind, snapshot } = evidence;
  const sourceDiagnostics = snapshot.diagnostics.filter(diagnostic => diagnostic.material);
  const base = { criterionId: 'B014' as const, kind, endpointCalled: false, sourceDiagnostics };
  const result = (status: EvaluationStatus, basis: B014Basis, summary: string, facts: Pick<B014Analysis, 'mechanisms' | 'actuator' | 'unreadRoutes' | 'unreadRouteCount'>, items: FrontendChecklistItem[] = []): B014Analysis =>
    ({ ...base, ...facts, status, basis, summary: `B014 ${status}: ${summary}`, checklist: frontendChecklist(status, items) });

  if (kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'library', 'The repository is a shared library, which is not deployed on its own and serves no health check.',
      { mechanisms: [], actuator: [], unreadRoutes: [], unreadRouteCount: 0 });
  }

  const files = snapshot.files;
  const mechanisms: B014Mechanism[] = [];
  for (const file of files.filter(candidate => /(?:^|\/)pom\.xml$/.test(candidate.path))) {
    const match = REST_VERTICLE.exec(file.content);
    if (match) {
      mechanisms.push({ kind: 'rmb', path: file.path, line: lineCounter(file.content)(match.index), note: 'org.folio.rest.RestVerticle is the main verticle, and RMB serves GET /admin/health' });
    }
  }
  const actuator = actuatorApplications(files, sourceDiagnostics);
  if (actuator.every(application => !application.problems.length)) {
    for (const { basePath: setting } of actuator) {
      mechanisms.push({ kind: 'actuator', path: setting.path, line: setting.line, note: `${reportText(setting.key)} ${reportText(setting.value)}; actuator serves health at ${HEALTH_ROUTE}` });
    }
  }
  const scan = sourceRoutes(files);
  const blocked = (file: string) => {
    const owners = actuator.filter(application => file.startsWith(application.root));
    return (owners.length ? owners : actuator).some(application => application.blocksRoutes);
  };
  const blockedRoutes: Array<{ file: string; line: number }> = [];
  for (const route of scan.routes) {
    if (route.path !== HEALTH_ROUTE || (route.method !== 'GET' && route.method !== '*')) continue;
    if (blocked(route.file)) {
      blockedRoutes.push(route);
    } else {
      mechanisms.push({ kind: 'route', path: route.file, line: route.line, note: `${route.method === '*' ? 'every method on' : 'GET'} ${HEALTH_ROUTE}` });
    }
  }
  const facts = {
    mechanisms,
    actuator: actuator.map(({ basePath, blocksRoutes, ...application }) => application),
    unreadRoutes: scan.unreadRoutes,
    unreadRouteCount: scan.unreadRouteCount
  };

  const sentences: string[] = [];
  const startingPoints: FrontendChecklistItem['startingPoints'] = [];
  for (const application of facts.actuator) {
    if (!application.problems.length) continue;
    const texts = application.problems.map(problemText);
    const listed = application.problemCount > texts.length ? `${texts.slice(0, 3).join(', ')}, and ${application.problemCount - 3} more` : listText(texts);
    sentences.push(`${actuatorName(application)} may not serve health at ${HEALTH_ROUTE}: ${listed}.`);
    startingPoints.push(...application.problems.map(problem => ({ path: problem.path ?? application.source, line: problem.line, note: problemText(problem) })));
  }
  if (blockedRoutes.length) {
    sentences.push(`The source registers GET ${HEALTH_ROUTE} (${listText(blockedRoutes.map(route => location(route.file, route.line)))}), but the application's settings put a prefix before every path or serve no HTTP, so the route may not answer at ${HEALTH_ROUTE}.`);
    startingPoints.push(...blockedRoutes.map(route => ({ path: route.file, line: route.line, note: `GET ${HEALTH_ROUTE} route under the application's settings` })));
  }

  if (kind === 'ambiguous') {
    return result(EvaluationStatus.MANUAL, 'ambiguous', [
      'No module descriptor was found and the repository is not a known shared library, so the tool cannot tell whether it is a module that must serve GET /admin/health (see B001).',
      ...(mechanisms.length ? [`It found ${mechanismList(mechanisms)}.`] : []),
      ...sentences,
      'A reviewer must check it.'
    ].join(' '), facts, [checklistItem([...mechanisms.map(mechanism => ({ path: mechanism.path, line: mechanism.line, note: mechanism.note })), ...startingPoints])]);
  }

  if (mechanisms.length) {
    return result(EvaluationStatus.PASS, 'mechanism-found', `${passSentence(mechanisms[0])} ${NOT_CALLED[mechanisms[0].kind]}`, facts);
  }

  const missing = ['no RMB RestVerticle main verticle', ...(actuator.length ? [] : ['no Spring Boot or Grails application']),
    ...(blockedRoutes.length ? [] : [`no GET ${HEALTH_ROUTE} route in the source`])];
  sentences.push(`The tool found ${listText(missing)}.`);
  if (scan.unreadRouteCount) {
    sentences.push(`It could not read ${count(scan.unreadRouteCount, 'route')} in the source, which may serve it.`);
    startingPoints.push(...scan.unreadRoutes.map(route => ({ path: route.file, line: route.line, note: 'route whose path the tool could not read' })));
  }
  if (sourceDiagnostics.length) sentences.push('The committed source was not read completely, so the tool may have missed the mechanism.');
  sentences.push('A reviewer must check that the module answers GET /admin/health with 200.');
  return result(EvaluationStatus.MANUAL, 'no-mechanism', sentences.join(' '), facts, [checklistItem(startingPoints)]);
}

export function renderB014HumanDetails(analysis: B014Analysis): string {
  if (analysis.basis === 'library') return ['Health check: not applicable to a shared library', ...runtimeLines(analysis.runtime)].join('\n');
  const lines = [`Health check: GET ${HEALTH_ROUTE} was ${analysis.endpointCalled ? 'called' : 'not called; the result comes from the committed files'}`,
    ...runtimeLines(analysis.runtime)];
  if (analysis.mechanisms.length) {
    lines.push('Found:', ...analysis.mechanisms.slice(0, MAX_ROWS).map(mechanism =>
      `  - ${MECHANISM_NAMES[mechanism.kind]}: ${location(mechanism.path, mechanism.line)} — ${reportText(mechanism.note)}`),
    ...overflowLine(analysis.mechanisms.length, MAX_ROWS, '  '));
  }
  for (const application of analysis.actuator) {
    if (!application.problems.length) continue;
    lines.push(`Actuator not counted for ${actuatorName(application).replace(/^The/, 'the')}:`, ...application.problems.slice(0, MAX_ROWS).map(problem =>
      `  - ${location(problem.path ?? application.source, problem.line)} — ${problemText(problem)}`), ...overflowLine(application.problemCount, MAX_ROWS, '  '));
  }
  if (analysis.status !== EvaluationStatus.PASS) {
    if (analysis.unreadRouteCount) {
      lines.push('Routes the tool could not read:', ...analysis.unreadRoutes.slice(0, MAX_ROWS).map(route => `  - ${location(route.file, route.line)}`),
        ...overflowLine(analysis.unreadRouteCount, MAX_ROWS, '  '));
    }
    if (analysis.sourceDiagnostics.length) {
      lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
        `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
    }
  }
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  return lines.join('\n');
}

function runtimeLines(runtime: B014Runtime | undefined): string[] {
  if (!runtime) return [];
  const health = runtime.health;
  return ['Runtime check:', ...runtimeDockerLines(runtime.docker, runtime.cleanup), health
    ? `  - GET ${HEALTH_ROUTE} ${healthAnswer(health)} after ${count(health.attempts, 'attempt')} over ${Math.round(health.waitedMs / 1000)} s${health.status !== 200 && health.body ? `: ${reportText(health.body)}` : ''}`
    : `  - ${runtimeOutcomeText(runtime.outcome, runtime.problem)}; the result comes from the committed files`];
}

function healthAnswer(health: NonNullable<B014Runtime['health']>): string {
  return health.status !== undefined ? `answered ${health.status}` : `got no response${health.error ? ` (${reportText(health.error)})` : ''}`;
}

const MECHANISM_NAMES: Record<B014Mechanism['kind'], string> = {
  rmb: 'RMB',
  actuator: 'Spring Boot actuator',
  route: 'Route'
};

const NOT_CALLED: Record<B014Mechanism['kind'], string> = {
  rmb: 'The tool found the mechanism in the build file and did not call the endpoint.',
  actuator: 'The tool found the mechanism in configuration and did not call the endpoint.',
  route: 'The tool found the mechanism in the source and did not call the endpoint.'
};

function passSentence(mechanism: B014Mechanism): string {
  const where = location(mechanism.path, mechanism.line);
  if (mechanism.kind === 'rmb') return `RMB's RestVerticle, the main verticle in ${where}, serves GET ${HEALTH_ROUTE}.`;
  if (mechanism.kind === 'actuator') return `Spring Boot actuator serves health at ${HEALTH_ROUTE} (${KEYS.basePath} in ${where}).`;
  return `The source registers ${mechanism.note} (${where}).`;
}

function mechanismList(mechanisms: B014Mechanism[]): string {
  return listText(mechanisms.map(mechanism => `${mechanism.kind === 'route' ? 'a route' : MECHANISM_NAMES[mechanism.kind]} in ${location(mechanism.path, mechanism.line)}`));
}

function checklistItem(startingPoints: FrontendChecklistItem['startingPoints']): FrontendChecklistItem {
  return {
    id: 'B014-C1',
    title: `The module answers GET ${HEALTH_ROUTE} with 200 when it runs.`,
    startingPoints,
    reviewerOnly: true,
    obligations: []
  };
}

function actuatorName(application: B014ActuatorApplication): string {
  return `${application.framework === 'grails' ? 'The Grails application' : 'The Spring Boot application'}${application.root ? ` in ${reportPath(application.root)}` : ''}`;
}

function problemText(problem: B014ActuatorProblem): string {
  return problem.condition ? `${problem.note} ${reportText(problem.condition)}` : problem.note;
}

function location(path: string, line?: number): string {
  return `${reportPath(path)}${line ? `:${line}` : ''}`;
}

type ActuatorResult = B014ActuatorApplication & { basePath: Setting; blocksRoutes: boolean };

/**
 * Each Spring Boot application (a `@SpringBootApplication` class) and Grails application, with the reasons its
 * actuator may not serve health at /admin/health in its default configuration or any profile or Grails environment.
 */
function actuatorApplications(files: CommittedSourceFile[], diagnostics: CommittedSourceDiagnostic[]): ActuatorResult[] {
  const roots = new Map<string, { framework: 'spring' | 'grails'; source: string }>();
  for (const file of files) {
    const grails = GRAILS_APP.exec(file.path);
    if (grails && !roots.has(grails[1])) roots.set(grails[1], { framework: 'grails', source: `${grails[1]}grails-app/` });
  }
  for (const file of files) {
    if (!SOURCE_FILE.test(file.path) || !SPRING_BOOT_APPLICATION.test(file.content)) continue;
    const root = file.path.slice(0, file.path.indexOf('src/main/'));
    if (!roots.has(root)) roots.set(root, { framework: 'spring', source: file.path });
  }
  const dockerProblems: Problem[] = [];
  if (roots.size) {
    for (const file of files.filter(candidate => /(?:^|\/)Dockerfile$/.test(candidate.path))) {
      file.content.split('\n').forEach((text, index) => {
        const match = text.trimStart().startsWith('#') ? null : DOCKER_SETTING.exec(text);
        if (match) dockerProblems.push({ path: file.path, line: index + 1, note: `the Dockerfile sets ${reportText(match[0])}, which the tool does not read` });
      });
    }
  }
  const configFilesByRoot = new Map<string, CommittedSourceFile[]>();
  for (const file of files) {
    const root = CONFIG_FILE.exec(file.path)?.[1];
    if (root === undefined || !roots.has(root)) continue;
    const list = configFilesByRoot.get(root) ?? [];
    configFilesByRoot.set(root, list);
    list.push(file);
  }
  const buildFiles = roots.size ? files.filter(file => /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(file.path))
    .map(file => ({ folder: file.path.slice(0, file.path.lastIndexOf('/') + 1), dependency: declaredDependency(file) })) : [];
  return [...roots].sort(([left], [right]) => left.localeCompare(right)).map(([root, { framework, source }]) => {
    const configFiles = configFilesByRoot.get(root) ?? [];
    const problems: Problem[] = [...dockerProblems];
    const dependency = buildFiles.find(file => file.dependency && root.startsWith(file.folder))?.dependency;
    if (!dependency) {
      problems.push({ note: 'no build file of the application or its parent folders has a dependency on spring-boot-starter-actuator or folio-spring-base', actuatorOnly: true });
    }
    for (const diagnostic of diagnostics) {
      const config = diagnostic.path ? CONFIG_FILE.exec(diagnostic.path) : undefined;
      if (!diagnostic.path || config?.[1] === root) {
        problems.push({ ...(diagnostic.path ? { path: diagnostic.path } : {}), note: `the tool could not read ${diagnostic.path ? 'this configuration file' : 'every committed file'} (${reportText(diagnostic.message)})` });
      }
    }
    const { defaults, conditional } = configSources(configFiles, framework, problems);
    const merged = merge(new Map(), defaults);
    const checked = checkSettings(merged);
    problems.push(...checked.problems);
    const seen = new Set(checked.problems.map(problem => problem.note));
    if (conditional.length > MAX_CONDITIONS) {
      problems.push({ note: `the configuration has ${conditional.length} profile documents, files or Grails environments, and the tool checked only the first ${MAX_CONDITIONS}` });
    }
    for (const source of conditional.slice(0, MAX_CONDITIONS)) {
      for (const problem of checkSettings(merge(new Map(merged), [source])).problems) {
        const key = `${problem.note}\n${source.condition}`;
        if (seen.has(problem.note) || seen.has(key)) continue;
        seen.add(key);
        problems.push({ ...problem, condition: source.condition });
      }
    }
    const shown = problems.slice(0, MAX_PROBLEMS).map(({ actuatorOnly, ...problem }) => problem);
    return {
      framework,
      root,
      source,
      ...(dependency ? { dependency } : {}),
      configFiles: configFiles.map(file => file.path).sort(),
      problems: shown,
      problemCount: problems.length,
      basePath: checked.basePath ?? { key: KEYS.basePath, value: '', path: source },
      blocksRoutes: problems.some(problem => !problem.actuatorOnly)
    };
  });
}

/**
 * Where a build file declares actuator, or folio-spring-base, which brings it in, as a production dependency: not in a
 * comment, an exclusion, dependency management, the build section, a profile, or a test scope or configuration.
 */
function declaredDependency(file: CommittedSourceFile): { path: string; line: number } | undefined {
  if (/(?:^|\/)pom\.xml$/.test(file.path)) {
    const content = POM_IGNORED.reduce((text, [open, close]) => blankBlocks(text, open, close), file.content);
    let close = content.indexOf('</dependency>');
    let next: number;
    for (let start = content.indexOf('<dependency>'); start >= 0; start = next) {
      next = content.indexOf('<dependency>', start + 1);
      while (close >= 0 && close < start) close = content.indexOf('</dependency>', close + 1);
      const block = content.slice(start, Math.min(close < 0 ? content.length : close, next < 0 ? content.length : next));
      const artifactId = /<artifactId>([^<]*)<\/artifactId>/.exec(block)?.[1].trim();
      const scope = /<scope>([^<]*)<\/scope>/.exec(block)?.[1].trim();
      if (artifactId && ACTUATOR_ARTIFACTS.has(artifactId) && scope !== 'test' && scope !== 'provided') {
        return { path: file.path, line: lineCounter(content)(start) };
      }
    }
  } else if (/(?:^|\/)build\.gradle(?:\.kts)?$/.test(file.path)) {
    const content = withoutComments(file.content);
    const match = GRADLE_DEPENDENCY.exec(content);
    if (match) return { path: file.path, line: lineCounter(content)(match.index) };
  }
  return undefined;
}

/** The text with each block from `open` to `close` replaced by spaces, keeping line breaks and offsets. */
function blankBlocks(content: string, open: string, close: string): string {
  const parts: string[] = [];
  let kept = 0;
  for (let start = content.indexOf(open); start >= 0; start = content.indexOf(open, kept)) {
    const end = content.indexOf(close, start + open.length);
    const stop = end < 0 ? content.length : end + close.length;
    parts.push(content.slice(kept, start), content.slice(start, stop).replace(/[^\n]/g, ' '));
    kept = stop;
  }
  parts.push(content.slice(kept));
  return parts.join('');
}

/**
 * The settings of an application's configuration files, lowest precedence first: Grails' `grails-app/conf`, then
 * `src/main/resources`, then its `config/` folder, YAML before properties in each. Profile files and documents, and
 * Grails `environments`, are conditional sources.
 */
function configSources(files: CommittedSourceFile[], framework: 'spring' | 'grails', problems: B014ActuatorProblem[]): { defaults: ConfigSource[]; conditional: ConfigSource[] } {
  const rank = (path: string) => {
    const [, , folder, , extension] = CONFIG_FILE.exec(path)!;
    return (folder.startsWith('grails-app') ? 0 : folder.endsWith('config/') ? 4 : 2) + (extension === 'properties' ? 1 : 0);
  };
  const defaults: ConfigSource[] = [];
  const conditional: ConfigSource[] = [];
  for (const file of [...files].sort((left, right) => rank(left.path) - rank(right.path) || left.path.localeCompare(right.path))) {
    const [, , , profile, extension] = CONFIG_FILE.exec(file.path)!;
    if (extension === 'groovy') {
      const match = GROOVY_SETTING.exec(file.content);
      if (match) problems.push({ path: file.path, line: lineCounter(file.content)(match.index), note: 'Groovy configuration sets management, server or spring settings, which the tool does not read' });
      continue;
    }
    const documents = extension === 'properties' ? propertiesDocuments(file) : yamlDocuments(file, problems);
    for (const settings of documents) {
      const activation = settings.filter(setting => ACTIVATION_KEYS.has(listName(canonicalKey(setting.key))));
      const condition = profile ? `when the profile ${reportPath(profile)} is active`
        : activation.length ? `when ${activationText(activation)}` : undefined;
      if (framework === 'grails') {
        const environments = new Map<string, Setting[]>();
        for (const setting of settings) {
          const environment = /^environments\.([^.]+)\.(.+)$/.exec(setting.key);
          if (!environment) continue;
          const list = environments.get(environment[1]) ?? [];
          environments.set(environment[1], list);
          list.push({ ...setting, key: environment[2] });
        }
        for (const [environment, list] of environments) {
          conditional.push({ settings: list, condition: `in the Grails environment ${environment}${condition ? `, ${condition}` : ''}` });
        }
      }
      const kept = framework === 'grails' ? settings.filter(setting => !setting.key.startsWith('environments.')) : settings;
      (condition ? conditional : defaults).push({ settings: kept, ...(condition ? { condition } : {}) });
    }
  }
  return { defaults, conditional };
}

function activationText(activation: Setting[]): string {
  const values = new Map<string, string[]>();
  for (const setting of activation) {
    const key = setting.key.replace(/\[\d+\]$/, '');
    const list = values.get(key) ?? [];
    values.set(key, list);
    list.push(setting.value);
  }
  return [...values].map(([key, list]) => `${key} is ${list.join(', ')}`).join(' and ');
}

function yamlDocuments(file: CommittedSourceFile, problems: B014ActuatorProblem[]): Setting[][] {
  const counter = new LineCounter();
  const documents = YAML.parseAllDocuments(file.content.replace(/^\uFEFF/, ''), { lineCounter: counter, schema: 'failsafe', uniqueKeys: false });
  if (!Array.isArray(documents)) return [];
  const result: Setting[][] = [];
  for (const document of documents) {
    if (document.errors.length) {
      const error = document.errors[0];
      problems.push({ path: file.path, line: error.linePos?.[0].line, note: `the tool could not parse this file as YAML (${reportText(error.message.split('\n')[0])})` });
      continue;
    }
    const settings: Setting[] = [];
    let tooDeep = false;
    const lineOf = (node: unknown) => (node as YamlNode | undefined)?.range ? counter.linePos((node as YamlNode).range![0]).line : undefined;
    const visit = (node: unknown, key: string, line: number | undefined, depth: number): void => {
      if (depth > MAX_YAML_DEPTH) {
        tooDeep = true;
        return;
      }
      if (isMap(node)) {
        for (const pair of node.items) {
          if (!isScalar(pair.key)) {
            settings.push({ key, value: '', path: file.path, line: lineOf(pair.key) ?? line, alias: true });
            continue;
          }
          const name = String(pair.key.value ?? '');
          if (name === '<<' && isSeq(pair.value)) {
            for (const item of pair.value.items) visit(item, key, lineOf(item) ?? lineOf(pair.key), depth + 1);
          } else {
            visit(pair.value, name === '<<' ? key : key ? `${key}.${name}` : name, lineOf(pair.key), depth + 1);
          }
        }
      } else if (isSeq(node)) {
        node.items.forEach((item, index) => visit(item, `${key}[${index}]`, lineOf(item) ?? line, depth + 1));
      } else if (key || isAlias(node)) {
        settings.push({ key, value: isScalar(node) ? String(node.value ?? '') : '', path: file.path, line, ...(isAlias(node) ? { alias: true } : {}) });
      }
    };
    visit(document.contents, '', undefined, 0);
    if (tooDeep) problems.push({ path: file.path, note: `the tool did not read the parts of this file nested more than ${MAX_YAML_DEPTH} levels deep` });
    result.push(settings);
  }
  return result;
}

/** Java properties lines, split into documents at `#---` or `!---` lines as Spring Boot does. */
function propertiesDocuments(file: CommittedSourceFile): Setting[][] {
  const documents: Setting[][] = [[]];
  const lines = file.content.split(/\r?\n|\r/);
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    if (lines[index] === '#---' || lines[index] === '!---') {
      documents.push([]);
      continue;
    }
    let text = lines[index].trimStart();
    if (!text || text.startsWith('#') || text.startsWith('!')) continue;
    const parts: string[] = [];
    while (endsWithContinuation(text) && index + 1 < lines.length) {
      parts.push(text.slice(0, -1));
      text = lines[++index].trimStart();
    }
    text = parts.join('') + text;
    const match = /^((?:\\.|[^\s:=\\])+)[ \t\f]*[:=]?[ \t\f]*(.*)$/s.exec(text);
    if (!match) continue;
    const key = unescapeProperty(match[1]);
    const settings = documents[documents.length - 1];
    if (key.endsWith('[]')) {
      listItems(match[2]).forEach((item, position) => settings.push({ key: `${key.slice(0, -2)}[${position}]`, value: unescapeProperty(item), path: file.path, line }));
    } else {
      settings.push({ key, value: unescapeProperty(match[2]), path: file.path, line });
    }
  }
  return documents;
}

const PROPERTY_ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f' };

function unescapeProperty(text: string): string {
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/gs, (_match, hex: string | undefined, character: string) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : PROPERTY_ESCAPES[character] ?? character);
}

/** A `name[]` value split at the commas a backslash does not escape. */
function listItems(text: string): string[] {
  const items: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === ',') {
      items.push(text.slice(start, index));
      start = index + 1;
    }
  }
  items.push(text.slice(start));
  return items;
}

function endsWithContinuation(text: string): boolean {
  let backslashes = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === '\\'; index--) backslashes++;
  return backslashes % 2 === 1;
}

/** Spring Boot's relaxed binding: case, dashes and underscores do not matter, and `[0]` indexes a list. */
function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/\[(?!\d+\])([^\][]*)\]/g, '.$1').replace(/[-_]/g, '');
}

/** Later sources override earlier ones; a list in a later source replaces the whole list. */
function merge(settings: Settings, sources: ConfigSource[]): Settings {
  for (const source of sources) {
    const incoming = new Map<string, Map<string, Setting>>();
    for (const setting of source.settings) {
      const key = canonicalKey(setting.key);
      const name = listName(key);
      if (!RELEVANT.has(name) && !(setting.alias && (!key || [...RELEVANT].some(relevant => relevant.startsWith(`${key}.`))))) continue;
      const entries = key === name ? undefined : incoming.get(name);
      if (entries) entries.set(key, setting);
      else incoming.set(name, new Map([[key, setting]]));
    }
    incoming.forEach((entries, name) => settings.set(name, [...entries.values()]));
  }
  return settings;
}

function listName(key: string): string {
  const bracket = key.indexOf('[');
  return bracket < 0 ? key : key.slice(0, bracket);
}

function checkSettings(configured: Settings): { problems: Problem[]; basePath?: Setting } {
  const problems: Problem[] = [];
  const settings: Settings = new Map();
  const get = (key: string) => settings.get(canonicalKey(key))?.[0];
  const at = (setting: Setting) => ({ path: setting.path, ...(setting.line ? { line: setting.line } : {}) });
  const value = (setting: Setting | undefined) => setting?.value.trim().toLowerCase();
  const list = (key: string): Setting[] => settings.get(canonicalKey(key)) ?? [];

  for (const [name, configuredList] of configured) {
    const known = configuredList.filter(setting => {
      if (setting.alias) {
        problems.push({ ...at(setting), note: `${setting.key ? reportText(setting.key) : 'the top level of the document'} is a YAML alias or merge, which the tool does not resolve` });
      } else if (PLACEHOLDER_VALUE.test(setting.value)) {
        problems.push({ ...at(setting), note: `${reportText(setting.key)} is set from ${reportText(setting.value)}, which the deployment decides`, actuatorOnly: !PREFIX_NAMES.has(name) });
      } else {
        return true;
      }
      return false;
    });
    if (known.length) settings.set(name, known);
  }

  const basePath = get(KEYS.basePath);
  const mapping = get(KEYS.pathMapping);
  const base = basePath ? basePath.value : '/actuator';
  const healthPath = `${base.endsWith('/') ? base.slice(0, -1) : base}/${mapping ? mapping.value : 'health'}`;
  if (basePath && base && !base.startsWith('/')) {
    problems.push({ ...at(basePath), note: `${KEYS.basePath} is ${reportText(base)}, which does not start with /, so Spring Boot does not start`, actuatorOnly: true });
  } else if (healthPath !== HEALTH_ROUTE) {
    const cited = mapping && mapping.value !== 'health' ? mapping : basePath;
    problems.push({
      ...(cited ? at(cited) : {}),
      note: basePath
        ? `actuator serves health at ${reportText(healthPath)} (${listText([basePath, mapping].filter((setting): setting is Setting => !!setting).map(setting => `${reportText(setting.key)} ${reportText(setting.value)}`))})`
        : `${KEYS.basePath} is not set, so actuator serves health at ${reportText(healthPath)}`,
      actuatorOnly: true
    });
  }

  const include = list(KEYS.include);
  const items = (setting: Setting) => (/\]$/.test(setting.key) ? [setting.value] : setting.value.split(',')).map(item => item.trim().toLowerCase());
  const included = include.flatMap(items);
  if (include.length && !included.includes('health') && !included.includes('*')) {
    problems.push({ ...at(include[0]), note: `${KEYS.include} does not include health`, actuatorOnly: true });
  }
  const exclude = list(KEYS.exclude);
  const excluded = exclude.find(setting => items(setting).some(item => item === 'health' || item === '*'));
  if (excluded) problems.push({ ...at(excluded), note: `${KEYS.exclude} excludes health`, actuatorOnly: true });

  const healthEnabled = get(KEYS.healthEnabled);
  const enabledByDefault = get(KEYS.enabledByDefault);
  if (FALSE_VALUES.has(value(healthEnabled) ?? '')) {
    problems.push({ ...at(healthEnabled!), note: `${KEYS.healthEnabled} is ${reportText(healthEnabled!.value)}`, actuatorOnly: true });
  } else if (FALSE_VALUES.has(value(enabledByDefault) ?? '') && !TRUE_VALUES.has(value(healthEnabled) ?? '')) {
    problems.push({ ...at(enabledByDefault!), note: `${KEYS.enabledByDefault} is ${reportText(enabledByDefault!.value)} and ${KEYS.healthEnabled} is not true`, actuatorOnly: true });
  }
  const healthAccess = get(KEYS.healthAccess);
  const accessDefault = get(KEYS.accessDefault);
  const maxPermitted = get(KEYS.maxPermitted);
  if (value(healthAccess) === 'none') {
    problems.push({ ...at(healthAccess!), note: `${KEYS.healthAccess} is none`, actuatorOnly: true });
  } else if (value(accessDefault) === 'none' && !healthAccess) {
    problems.push({ ...at(accessDefault!), note: `${KEYS.accessDefault} is none and ${KEYS.healthAccess} is not set`, actuatorOnly: true });
  }
  if (value(maxPermitted) === 'none') problems.push({ ...at(maxPermitted!), note: `${KEYS.maxPermitted} is none`, actuatorOnly: true });

  const managementPort = get(KEYS.managementPort);
  if (managementPort) {
    problems.push({ ...at(managementPort), note: `${KEYS.managementPort} is ${reportText(managementPort.value)}, so actuator does not listen on the module's port`, actuatorOnly: true });
  }
  for (const key of PREFIXES) {
    const prefix = get(key)?.value.trim();
    if (prefix && prefix !== '/') problems.push({ ...at(get(key)!), note: `${key} is ${reportText(prefix)}, which comes before every path` });
  }
  const webApplicationType = get(KEYS.webApplicationType);
  if (value(webApplicationType) === 'none') {
    problems.push({ ...at(webApplicationType!), note: `${KEYS.webApplicationType} is none, so the application starts no web server` });
  }
  const serverPort = get(KEYS.serverPort);
  if (value(serverPort) === '-1') problems.push({ ...at(serverPort!), note: `${KEYS.serverPort} is -1, so the application serves no HTTP` });
  for (const key of [KEYS.configImport, KEYS.configLocation, KEYS.configAdditionalLocation]) {
    const imported = list(key);
    if (imported.length) problems.push({ ...at(imported[0]), note: `${key} reads configuration the tool does not read` });
  }

  return { problems, ...(basePath ? { basePath } : {}) };
}
