import { BackendEvaluator } from '../evaluators/java/backend-evaluator';
import { B015Analysis, EvaluationStatus } from '../types';
import { evaluateB015 } from '../utils/b015-high-availability';
import { getBackendEvidence } from '../utils/backend-evidence';
import { createEvaluationRun } from '../utils/evaluation-run';
import { pom, repository } from './helpers/backend-repository';
import { expectLinearTime } from './helpers/linear-time';

async function b015(root: string) {
  const run = createEvaluationRun({ repositoryPath: root, language: 'java' });
  const result = await new BackendEvaluator().evaluateCriterion('B015', root, run);
  return { result, analysis: result.criterionDetails as B015Analysis };
}

const descriptor = JSON.stringify({ id: 'mod-example-1.0.0', provides: [] });
const JAVA = 'src/main/java/org/folio/example';

const springModule = (files: Record<string, string | Buffer>) => repository({
  'pom.xml': pom('mod-example'),
  'descriptors/ModuleDescriptor-template.json': descriptor,
  ...files
});

describe('B015 high availability', () => {
  it('lists each site that may keep state on one instance, without comments, imports, locals or tests', async () => {
    const { result, analysis } = await b015(springModule({
      [`${JAVA}/Jobs.java`]: [
        'package org.folio.example;',
        'import org.springframework.scheduling.annotation.Scheduled;',
        'import javax.servlet.http.HttpSession;',
        'class Jobs {',
        '  // @Scheduled(cron = "0 0 * * * *")',
        '  /* vertx.setPeriodic(1000, id -> run()); */',
        '  @Scheduled(cron = "0 0 * * * *")',
        '  void cleanUp() { vertx.setTimer(10, id -> run()); }',
        '  @SchedulerLock(name = "purge")',
        '  @Scheduled(fixedDelay = 1000)',
        '  void purge() {}',
        '}'
      ].join('\n'),
      [`${JAVA}/Caches.java`]: [
        'class Caches {',
        '  private final Map<String, String> users = new ConcurrentHashMap<>();',
        '  @Getter private static final Set<String> seen = ConcurrentHashMap.newKeySet();',
        '  Cache<String, String> a = Caffeine.newBuilder().expireAfterWrite(Duration.ofMinutes(5)).build();',
        '  Cache<String, String> b = Caffeine.newBuilder().maximumSize(10).build(); String c = "expireAfterWrite(";',
        '  void run() { var local = new ConcurrentHashMap<String, String>(); final Map<String, String> other = new ConcurrentHashMap<>(); }',
        '  @Cacheable(cacheNames = "x") String x() { return ""; }',
        '  Object edge = new Builder<String>().build();',
        '}'
      ].join('\n'),
      [`${JAVA}/Export.java`]: [
        'class Export {',
        '  void run() throws IOException {',
        '    Path path = Files.createTempFile("export", ".csv");',
        '    Files.write(path, bytes); Files.copy(path, target);',
        '    vertx.fileSystem().writeFile("errors.txt", buffer);',
        '    Files.readAllBytes(path);',
        '  }',
        '}'
      ].join('\n'),
      'src/test/java/org/folio/example/JobsTest.java': 'class JobsTest { @Scheduled(cron = "0 0 * * * *") void t() {} }'
    }));

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('B015 manual: No HTTP sessions found. 3 local file writes, 5 in-memory caches or maps, and 2 scheduled jobs may hold state on one instance or run on every instance. A reviewer must check them.');
    expect(result.details?.split('\n')).toEqual([
      'What the tool found:',
      '  - Source read: 3 Java, Groovy or Kotlin files in src/main and grails-app, without comments',
      '  - HTTP sessions: none found',
      '  - Local file writes: 3 in 1 file',
      '  - In-memory caches and maps: 5 in 1 file',
      '  - Scheduled jobs: 2 in 1 file',
      'What to do:',
      '  - Check each item below for a deployment of several instances behind a load balancer without session affinity; B015 is always decided by a reviewer.',
      'Checklist for the reviewer:',
      '  - B015-C1 No request depends on session affinity: no HTTP session state, and no sticky routing.',
      '  - B015-C2 No data is kept only on one instance\'s local disk; temporary files are removed in the same request or job.',
      '    - Start with:',
      `      - ${JAVA}/Export.java:3 — Files.createTempFile (temporary file)`,
      `      - ${JAVA}/Export.java:4 — Files.write`,
      `      - ${JAVA}/Export.java:5 — Vert.x fileSystem().writeFile`,
      '  - B015-C3 In-memory state is a cache that can be rebuilt from shared storage, not data other instances need.',
      '    - Start with:',
      `      - ${JAVA}/Caches.java:2 — ConcurrentHashMap field`,
      `      - ${JAVA}/Caches.java:3 — static ConcurrentHashMap field`,
      `      - ${JAVA}/Caches.java:4 — Caffeine cache with expiry`,
      `      - ${JAVA}/Caches.java:5 — Caffeine cache without expiry`,
      `      - ${JAVA}/Caches.java:7 — @Cacheable method (Spring cache)`,
      '  - B015-C4 Scheduled work runs once across instances, or is safe to run on every instance.',
      '    - Start with:',
      `      - ${JAVA}/Jobs.java:7 — @Scheduled`,
      `      - ${JAVA}/Jobs.java:10 — @Scheduled with a ShedLock @SchedulerLock`
    ]);
    expect(analysis.counts).toEqual({ session: 0, 'file-write': 3, 'in-memory-state': 5, scheduler: 2 });
    expect(analysis.checklist.items.map(item => [item.id, item.obligations])).toEqual([
      ['B015-C1', [{ id: 'B015-C1#1' }]],
      ['B015-C2', [{ id: 'B015-C2#1', subject: `${JAVA}/Export.java`, path: `${JAVA}/Export.java`, line: 3 }]],
      ['B015-C3', [{ id: 'B015-C3#1', subject: `${JAVA}/Caches.java`, path: `${JAVA}/Caches.java`, line: 2 }]],
      ['B015-C4', [{ id: 'B015-C4#1', subject: `${JAVA}/Jobs.java`, path: `${JAVA}/Jobs.java`, line: 7 }]]
    ]);
  });

  it('finds HTTP sessions in Servlet, Spring Session and Vert.x code, once per line', async () => {
    const { result, analysis } = await b015(springModule({
      [`${JAVA}/Sessions.java`]: [
        '@EnableRedisHttpSession',
        'class Sessions {',
        '  void a(HttpServletRequest httpRequest) { httpRequest.getSession(true).setAttribute("k", "v"); }',
        '  void b(HttpSession session) {}',
        '  void c() { router.route().handler(SessionHandler.create(LocalSessionStore.create(vertx))); }',
        '  void d() { hibernate.getSession(); }',
        '}'
      ].join('\n'),
      [`${JAVA}/State.java`]: 'class State { void a() { vertx.sharedData().getLocalMap("m"); } }'
    }));

    expect(result.evidence).toBe('B015 manual: 4 HTTP session uses and 1 in-memory cache or map may hold state on one instance or run on every instance. A reviewer must check them.');
    expect(analysis.signals).toEqual([
      { kind: 'session', path: `${JAVA}/Sessions.java`, line: 1, what: '@EnableRedisHttpSession (Spring Session)' },
      { kind: 'session', path: `${JAVA}/Sessions.java`, line: 3, what: 'request.getSession()' },
      { kind: 'session', path: `${JAVA}/Sessions.java`, line: 4, what: 'HttpSession' },
      { kind: 'session', path: `${JAVA}/Sessions.java`, line: 5, what: 'Vert.x SessionHandler' },
      { kind: 'in-memory-state', path: `${JAVA}/State.java`, line: 1, what: 'Vert.x local map' }
    ]);
    expect(analysis.checklist.items[0].obligations).toEqual([{ id: 'B015-C1#1', subject: `${JAVA}/Sessions.java`, path: `${JAVA}/Sessions.java`, line: 1 }]);
  });

  it('reads Grails sources and edge-common caches, and stays manual for a library with nothing found', async () => {
    const grails = await b015(repository({
      'service/build.gradle': '',
      'service/src/main/okapi/ModuleDescriptor-template.json': descriptor,
      'service/grails-app/jobs/HarvestJob.groovy': 'class HarvestJob {\n  static triggers = { simple repeatInterval: 5000l }\n}',
      'service/grails-app/services/ComparisonService.groovy': 'class ComparisonService {\n  def run() { File out = File.createTempFile(jobId, tenantId) }\n}'
    }));
    expect(grails.result.evidence).toBe('B015 manual: No HTTP sessions found. 1 local file write and 1 scheduled job may hold state on one instance or run on every instance. A reviewer must check them.');
    expect(grails.analysis.signals).toEqual([
      { kind: 'scheduler', path: 'service/grails-app/jobs/HarvestJob.groovy', line: 2, what: 'Quartz trigger' },
      { kind: 'file-write', path: 'service/grails-app/services/ComparisonService.groovy', line: 2, what: 'File.createTempFile (temporary file)' }
    ]);

    const edge = await b015(repository({
      'pom.xml': pom('edge-example', '<dependencies><dependency><groupId>org.folio</groupId><artifactId>edge-common</artifactId><version>4.0.0</version></dependency></dependencies>'),
      'src/main/java/org/folio/edge/example/IdCache.java': 'import org.folio.edge.core.cache.Cache.Builder;\nclass IdCache {\n  IdCache() {\n    cache = new Builder<String>()\n      .withTTL(ttl)\n      .build();\n  }\n}'
    }));
    expect(edge.analysis.kind).toBe('edge-module');
    expect(edge.analysis.signals).toEqual([{ kind: 'in-memory-state', path: 'src/main/java/org/folio/edge/example/IdCache.java', line: 4, what: 'edge-common cache with expiry' }]);

    const library = await b015(repository({
      'pom.xml': pom('folio-spring-base'),
      'src/main/java/org/folio/spring/Context.java': 'class Context { void run() { var map = new ConcurrentHashMap<String, Object>(); } }'
    }));
    expect(library.analysis.kind).toBe('library');
    expect(library.result.status).toBe(EvaluationStatus.MANUAL);
    expect(library.result.evidence).toBe('B015 manual: The tool found no HTTP sessions, local file writes, in-memory caches or maps, or scheduled jobs. A reviewer must still confirm that the module can run as several instances.');
    expect(library.analysis.checklist.items.map(item => item.obligations)).toEqual([[{ id: 'B015-C1#1' }], [{ id: 'B015-C2#1' }], [{ id: 'B015-C3#1' }], [{ id: 'B015-C4#1' }]]);
  });

  it('says when the source was not read completely, and when it lists only the first sites', async () => {
    const { result } = await b015(springModule({
      'src/main/resources/logo.bin': Buffer.from([0, 1, 2, 0]),
      [`${JAVA}/Many.java`]: Array.from({ length: 1_001 }, (_, index) => `@Scheduled(fixedDelay = ${index}) void job${index}() {}`).join('\n')
    }));

    expect(result.evidence).toBe('B015 manual: No HTTP sessions found. 1001 scheduled jobs may hold state on one instance or run on every instance. A reviewer must check them. '
      + 'The committed source was not read completely, so the tool may have missed some.');
    expect(result.details?.split('\n').slice(0, 10)).toEqual([
      'What the tool found:',
      '  - Source read: 1 Java, Groovy or Kotlin file in src/main and grails-app, without comments',
      '  - HTTP sessions: none found',
      '  - Local file writes: none found',
      '  - In-memory caches and maps: none found',
      '  - Scheduled jobs: 1001 in 1 file',
      '  - Listed: the first 1000 of 1001 sites',
      'What the tool could not read:',
      '  - src/main/resources/logo.bin — Skipped binary committed content',
      'What to do:'
    ]);
  });

  it.each([
    ['unclosed annotation-like words', (size: number) => '@EnableX'.repeat(size)],
    ['request-like words without getSession', (size: number) => `${'a'.repeat(size)}Request.`.repeat(4)],
    ['concurrent maps without a statement start', (size: number) => 'x new ConcurrentHashMap '.repeat(size)],
    ['cache builders without a semicolon', (size: number) => 'Caffeine.newBuilder() .maximumSize(1) '.repeat(size)],
    ['schedules near locks', (size: number) => '@SchedulerLock @Scheduled '.repeat(size)],
    ['field annotations before a map', (size: number) => `${'@A(x) '.repeat(size)}private Map m = new ConcurrentHashMap<>();`]
  ])('scans %s in linear time', async (_name, content) => {
    const prepare = async (size: number) => {
      const root = springModule({ [`${JAVA}/Big.java`]: content(size) });
      return getBackendEvidence(createEvaluationRun({ repositoryPath: root, language: 'java' }), root);
    };
    await expectLinearTime(4_000, prepare, async evidence => evaluateB015(evidence));
  });
});
