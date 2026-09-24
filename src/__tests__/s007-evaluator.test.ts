import {
  EvaluationStatus,
  S007PolicyLoadResult,
  S007TechnologyEvidenceResult,
  S007TechnologyObservation
} from '../types';
import { evaluateS007 } from '../utils/s007-evaluator';
import { renderS007HumanDetails } from '../utils/s007-report-details';
import { loadS007Policy } from '../utils/s007-policy';

describe('S007 deterministic evaluator', () => {
  let policy: S007PolicyLoadResult;

  beforeAll(async () => {
    policy = await loadS007Policy();
    expect(policy.ok).toBe(true);
  });

  it('passes a compliant frontend module and preserves matched policy evidence', () => {
    const result = evaluateS007(policy, evidence([
      observation('typescript', undefined, undefined, 'package.json'),
      observation('stripes', '^10.1.0', '10.1.4', 'package.json'),
      observation('react', '^18.2.0', '18.2.3', 'package.json')
    ]), 'javascript');

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ technologyId: 'stripes', classification: 'compliant', contribution: 'pass' }),
      expect.objectContaining({ technologyId: 'react', matchedPolicy: expect.objectContaining({ entryId: 'react' }) })
    ]));
  });

  it('fails a conclusive normative violation', () => {
    const result = evaluateS007(policy, evidence([
      observation('javascript', undefined),
      observation('react', '^17.0.0', '17.0.2')
    ]), 'javascript');

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ technologyId: 'react', classification: 'normative-violation', contribution: 'fail', statusDetermining: true })
    ]));
  });

  it('applies the Java 17 exception when Grails evidence is present', () => {
    const result = evaluateS007(policy, evidence([
      observation('java', '17', '17'),
      observation('grails', '7', '7')
    ]), 'java');

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        technologyId: 'java',
        classification: 'compliant',
        matchedPolicy: expect.objectContaining({
          sourceStatement: 'Grails modules use at least Java 17',
          constraint: { kind: 'minimum', expression: '17.0.0' }
        })
      }),
      expect.objectContaining({ technologyId: 'grails', classification: 'compliant' })
    ]));
  });

  it('does not apply a sibling Grails module exception to another module', () => {
    const result = evaluateS007(policy, evidence([
      observation('java', '17', '17', 'grails/pom.xml'),
      observation('grails', '7', '7', 'grails/pom.xml'),
      observation('java', '17', '17', 'vertx/pom.xml'),
      observation('vertx', '5.0.1', '5.0.1', 'vertx/pom.xml')
    ]), 'java');

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        technologyId: 'java',
        classification: 'normative-violation',
        evidence: [expect.objectContaining({ path: 'vertx/pom.xml' })]
      })
    ]));
  });

  it('keeps Java exception applicability manual when evidence coverage is incomplete', () => {
    const result = evaluateS007(policy, {
      ...evidence([observation('java', '17', '17')]),
      complete: false,
      diagnostics: [{ code: 'maven_remote_parent', message: 'remote parent', material: true, path: 'pom.xml' }]
    }, 'java');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0]).toMatchObject({ classification: 'unresolved', contribution: 'manual' });
  });

  it('returns manual for an explicit unlisted framework candidate', () => {
    const candidate = observation('angular', '^18.0.0');
    candidate.unlistedFrameworkCandidate = true;

    const result = evaluateS007(policy, evidence([candidate]), 'javascript');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0]).toMatchObject({ classification: 'unlisted-framework', contribution: 'manual' });
  });

  it('returns manual for a recognized unresolved version', () => {
    const result = evaluateS007(policy, evidence([
      observation('spring-boot', undefined)
    ]), 'java');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0]).toMatchObject({ classification: 'contested', contribution: 'manual' });
  });

  it('keeps advisory mismatches manual and never turns them into failures', () => {
    const result = evaluateS007(policy, evidence([
      observation('spring-framework', '6.2.0', '6.2.0')
    ]), 'java');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0]).toMatchObject({ classification: 'advisory-mismatch', contribution: 'manual' });
  });

  it('uses an approved Maven effective-POM version for normative comparison', () => {
    const lombok = observation('lombok', undefined, '1.18.48');
    lombok.provenance = 'shared-remote-resolution';
    lombok.resolutionSource = 'maven-effective-pom';

    const result = evaluateS007(policy, evidence([lombok]), 'java');

    expect(result.findings[0]).toMatchObject({
      technologyId: 'lombok',
      classification: 'compliant',
      contribution: 'pass',
      evidence: [expect.objectContaining({
        resolvedVersion: '1.18.48',
        resolutionSource: 'maven-effective-pom'
      })]
    });
  });

  it('can fail a normative rule from a validated Maven effective-POM version', () => {
    const lombok = observation('lombok', undefined, '1.18.20');
    lombok.provenance = 'shared-remote-resolution';
    lombok.resolutionSource = 'maven-effective-pom';

    const result = evaluateS007(policy, evidence([lombok]), 'java');

    expect(result.findings[0]).toMatchObject({
      technologyId: 'lombok',
      classification: 'normative-violation',
      contribution: 'fail'
    });
  });

  it('retains the Java 17 exception for repository-declared Grails enriched by an effective POM', () => {
    const grails = observation('grails', undefined, '7', 'pom.xml');
    grails.provenance = 'shared-remote-resolution';
    grails.resolutionSource = 'maven-effective-pom';
    grails.repositoryDeclared = true;
    const result = evaluateS007(policy, evidence([
      observation('java', '17', '17', 'pom.xml'),
      grails
    ]), 'java');

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ technologyId: 'java', classification: 'compliant' }),
      expect.objectContaining({ technologyId: 'grails', classification: 'compliant' })
    ]));
  });

  it('returns manual without comparing partial data when policy loading failed', () => {
    const invalidPolicy: S007PolicyLoadResult = {
      ok: false,
      sourcePath: '/config/officially-supported-technologies.json',
      diagnostics: [{ code: 'policy_schema_error', message: 'invalid policy' }]
    };

    const result = evaluateS007(invalidPolicy, evidence([observation('react', '17.0.0', '17.0.0')]), 'javascript');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings).toEqual([]);
    expect(result.policyDiagnostics).toEqual(invalidPolicy.diagnostics);
  });

  it('returns manual when evidence is absent or materially incomplete', () => {
    const noEvidence = evaluateS007(policy, evidence([]), 'java');
    const incomplete = evaluateS007(policy, {
      ...evidence([observation('java', '21')]),
      complete: false,
      diagnostics: [{ code: 'maven_remote_parent', message: 'remote parent', material: true, path: 'pom.xml' }]
    }, 'java');

    expect(noEvidence.status).toBe(EvaluationStatus.MANUAL);
    expect(incomplete.status).toBe(EvaluationStatus.MANUAL);
    expect(incomplete.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'coverage-incomplete', contribution: 'manual' })
    ]));
  });

  it('gives a normative violation precedence while retaining manual findings', () => {
    const angular = observation('angular', '^18.0.0');
    angular.unlistedFrameworkCandidate = true;
    const result = evaluateS007(policy, evidence([
      angular,
      observation('react', '17.0.2', '17.0.2')
    ]), 'javascript');
    const details = renderS007HumanDetails(result);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.findings.map(finding => finding.contribution)).toEqual(expect.arrayContaining(['fail', 'manual']));
    expect(details).toContain('react (react): Violates a mandatory rule. Determines overall result: Fail.');
    expect(details).toContain('angular (angular): Needs review: technology is not listed in policy.');
    expect(details.indexOf('react (react)')).toBeLessThan(details.indexOf('angular (angular)'));
  });

  it('returns manual for a partially overlapping declared range without an exact resolution', () => {
    const result = evaluateS007(policy, evidence([
      observation('react', '>=18.0.0 <18.3.0')
    ]), 'javascript');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings[0]).toMatchObject({ classification: 'unresolved', contribution: 'manual' });
  });

  it('keeps a declared npm range manual when it also permits unsupported versions', () => {
    const result = evaluateS007(policy, evidence([
      observation('javascript', undefined, undefined, 'package.json'),
      observation('react', '18', undefined, 'package.json')
    ]), 'javascript');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ technologyId: 'react', classification: 'unresolved', contribution: 'manual' })
    ]));
  });

  it.each([
    ['React', 'react', '>=16', '17.0.2'],
    ['Stripes', 'stripes', '>=9', '9.9.0']
  ])('lets the locked %s version decide when the declared range is broader', (_name, id, declaredVersion, resolvedVersion) => {
    const result = evaluateS007(policy, evidence([
      observation(id, declaredVersion, resolvedVersion, 'package.json')
    ]), 'javascript');

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.findings[0]).toMatchObject({ classification: 'normative-violation', contribution: 'fail' });
  });

  it('keeps language-only evidence manual because framework coverage is missing', () => {
    const result = evaluateS007(policy, evidence([observation('typescript')]), 'javascript');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'coverage-incomplete', contribution: 'manual', statusDetermining: true })
    ]));
  });

  it('keeps framework-only evidence manual because language coverage is missing', () => {
    const result = evaluateS007(policy, evidence([
      observation('react', '^18.2.0', '18.3.1', 'package.json')
    ]), 'javascript');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'coverage-incomplete', contribution: 'manual' })
    ]));
  });

  it('passes the existing-module raml-module-builder exception and retains deprecation advice', () => {
    const result = evaluateS007(policy, evidence([
      observation('java', '21', '21'),
      observation('raml-module-builder', '35.1.0', '35.1.0')
    ]), 'java');

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.findings.find(finding => finding.technologyId === 'raml-module-builder')).toMatchObject({
      classification: 'compliant',
      contribution: 'pass',
      advisories: [expect.stringContaining('Deprecated')]
    });
  });

  it.each([
    ['range wholly inside policy', '~18.2.1', undefined, EvaluationStatus.PASS],
    ['range disjoint from policy', '^17.0.0', undefined, EvaluationStatus.FAIL],
    ['overlap resolved inside policy', '>=18.0.0 <19', '18.2.7', EvaluationStatus.PASS],
    ['declared policy line with newer React 18 lock', '^18.2.0', '18.3.1', EvaluationStatus.PASS],
    ['resolved version below the supported baseline', '^18.0.0', '18.1.0', EvaluationStatus.FAIL],
    ['resolved React 19 version', '>=18.2.0 <20', '19.0.0', EvaluationStatus.FAIL]
  ])('%s', (_name, declaredVersion, resolvedVersion, expected) => {
    const result = evaluateS007(policy, evidence([
      observation('javascript', undefined, undefined, 'package.json'),
      observation('react', declaredVersion, resolvedVersion)
    ]), 'javascript');

    expect(result.status).toBe(expected);
  });

  it.each(['3.27.0.Final', '3.27.1'])('keeps Quarkus LTS qualification manual for %s', declaredVersion => {
    const result = evaluateS007(policy, evidence([
      observation('java', '21', '21'),
      observation('quarkus', declaredVersion)
    ]), 'java');

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.findings.find(finding => finding.technologyId === 'quarkus')).toMatchObject({
      classification: 'unresolved',
      contribution: 'manual'
    });
  });

  it('renders human details from the same structured findings', () => {
    const react = observation('react', '17.0.2', '17.0.2', 'package.json');
    react.versionSourcePath = 'yarn.lock';
    const analysis = evaluateS007(policy, evidence([
      observation('javascript', undefined, undefined, 'package.json'),
      react
    ]), 'javascript');
    const details = renderS007HumanDetails(analysis);
    const finding = analysis.findings[0];

    expect(analysis.policyFormatVersion).toBe('1.0');
    expect(details).not.toContain('Policy format:');
    expect(details).not.toContain(analysis.summary);
    expect(details).toContain(finding.displayName);
    expect(details).toContain(finding.classification);
    expect(details).toContain(finding.contribution);
    expect(details).toContain(finding.evidence[0].path);
    expect(details).toContain('Declared version: 17.0.2');
    expect(details).toContain('Resolved version: 17.0.2');
    expect(details).toContain('Version source: yarn.lock');
    expect(details).toContain(finding.matchedPolicy!.entryId);
    expect(details).toContain(finding.matchedPolicy!.strength);
  });

  it('groups repeated technology observations while retaining each declaration', () => {
    const web = observation('spring-boot', undefined, undefined, 'first/pom.xml');
    web.sourceDetail = 'org.springframework.boot:spring-boot-starter-web';
    const validation = observation('spring-boot', undefined, undefined, 'second/pom.xml');
    validation.sourceDetail = 'org.springframework.boot:spring-boot-starter-validation';
    const analysis = evaluateS007(policy, evidence([web, validation]), 'java');
    const details = renderS007HumanDetails(analysis);

    expect(details.match(/^- spring-boot \(spring-boot\):/gm)).toHaveLength(1);
    expect(details).toContain('Needs review: policy wording is contested or time-bound.');
    expect(details).toContain('org.springframework.boot:spring-boot-starter-web — Needs review: policy wording is contested or time-bound');
    expect(details).toContain('org.springframework.boot:spring-boot-starter-validation — Needs review: policy wording is contested or time-bound');
    expect(details).toContain('Classification: contested');
    expect(details).toContain('Result contribution: manual');
    expect(details).toContain('first/pom.xml — org.springframework.boot:spring-boot-starter-web');
    expect(details).toContain('second/pom.xml — org.springframework.boot:spring-boot-starter-validation');
  });

  it('summarizes mixed findings without hiding fail precedence', () => {
    const analysis = evaluateS007(policy, evidence([
      observation('react', '17.0.2', '17.0.2', 'unsupported/package.json'),
      observation('react', '>=18.0.0 <18.3.0', undefined, 'unresolved/package.json'),
      observation('react', '18.2.3', '18.2.3', 'supported/package.json')
    ]), 'javascript');
    const details = renderS007HumanDetails(analysis);

    expect(analysis.status).toBe(EvaluationStatus.FAIL);
    expect(details.match(/^- react \(react\):/gm)).toHaveLength(1);
    expect(details).toContain(
      'Mixed results: 1 violates a mandatory rule, 1 needs review, 1 complies. Determines overall result: Fail.'
    );
    expect(details).toContain('unsupported/package.json');
    expect(details).toContain('unresolved/package.json');
    expect(details).toContain('supported/package.json');
  });
});

function observation(
  id: string,
  declaredVersion?: string,
  resolvedVersion?: string,
  sourcePath = 'pom.xml'
): S007TechnologyObservation {
  return {
    identityCandidates: [id],
    displayName: id,
    ecosystem: sourcePath === 'package.json' ? 'javascript' : 'java',
    technologyType: id === 'javascript' || id === 'typescript' || id === 'java' ? 'language' : 'framework',
    evidenceKind: 'dependency-declaration',
    sourcePath,
    sourceDetail: id,
    declaredVersion,
    resolvedVersion,
    confidence: resolvedVersion ? 'confident' : 'partial',
    provenance: 'repository-static'
  };
}

function evidence(observations: S007TechnologyObservation[]): S007TechnologyEvidenceResult {
  return {
    observations,
    diagnostics: [],
    manifestPaths: [...new Set(observations.map(observation => observation.sourcePath))],
    complete: observations.length > 0
  };
}
