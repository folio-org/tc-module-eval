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

  it.each([
    ['21', 'compliant', 'pass'],
    ['11', 'normative-violation', 'fail'],
    ['17', 'unresolved', 'manual'],
    ['22', 'unresolved', 'manual'],
    [undefined, 'unresolved', 'manual']
  ])('resolves ambiguous Java exceptions only when every rule agrees for %s', (version, classification, contribution) => {
    const result = evaluateS007(policy, {
      ...evidence([observation('java', version, version)]), complete: false
    }, 'java');
    expect(result.findings[0]).toMatchObject({ classification, contribution });
    expect(result.findings.some(finding => finding.classification === 'coverage-incomplete')).toBe(true);
    if (version === '21') {
      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.findings[0].advisories.join(' ')).toContain('the result is the same either way');
    }
  });

  it('does not use rule agreement to bypass provenance, conflicts, or advisory exceptions', () => {
    const remote = observation('java', '21', '21');
    remote.provenance = 'shared-remote-resolution';
    const conflicting = observation('java', '21', '21');
    conflicting.conflictPaths = ['other/pom.xml'];
    for (const candidate of [remote, conflicting]) {
      const result = evaluateS007(policy, { ...evidence([candidate]), complete: false }, 'java');
      expect(result.findings[0].contribution).toBe('manual');
    }
    if (!policy.ok) throw new Error('Policy missing');
    const modified = JSON.parse(JSON.stringify(policy));
    const java = modified.policy.sections.flatMap((section: any) => section.entries).find((entry: any) => entry.id === 'java');
    java.exceptions[0].strength = 'advisory';
    expect(evaluateS007(modified, { ...evidence([observation('java', '21', '21')]), complete: false }, 'java')
      .findings[0].contribution).toBe('manual');
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
    expect(result.summary).toBe(
      'S007 fail: react 17.0.2 in pom.xml (the policy allows "React ^18.2.0") is not an officially supported version. Upgrade it to a version the policy allows.'
    );
    expect(details).toContain('- react: Fails: not an officially supported version.');
    expect(details).toContain('- angular: Needs review: not in the supported technologies list.');
    expect(details.indexOf('- react:')).toBeLessThan(details.indexOf('- angular:'));
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
    const finding = analysis.findings.find(candidate => candidate.technologyId === 'react')!;

    expect(analysis.policyFormatVersion).toBe('1.0');
    expect(details).not.toContain('Policy format:');
    expect(details).not.toContain(analysis.summary);
    expect(details).toContain(`- ${finding.displayName}: Fails: not an officially supported version.`);
    expect(details).toContain(`    - Why: ${finding.rationale}`);
    expect(details).toContain('Version 17.0.2 is not allowed by the policy rule "React ^18.2.0".');
    expect(details).toContain(`    - Policy rule: ${finding.matchedPolicy!.sourceStatement}\n`);
    expect(details).toContain('      - package.json — react, version 17.0.2 in yarn.lock');
    // Internal keys stay in the JSON details, not the readable text.
    expect(details).not.toMatch(/Classification:|Result contribution:|normative|frontend-third-party-frameworks/);
  });

  it('keeps repository text on its own row', () => {
    const vertx = observation('vertx', '4.5.0\n- injected: row', undefined, 'mod a/pom.xml');
    vertx.sourceDetail = 'io.vertx:vertx-core (evidence: fake.java:1)';
    const result = evaluateS007(policy, {
      ...evidence([vertx]),
      diagnostics: [{ code: 'version_unresolved', message: 'Has\nno version.', material: true, path: 'mod a/pom.xml' }],
      complete: false
    }, 'java');
    const details = renderS007HumanDetails(result);

    expect(details).not.toMatch(/^\s*- injected/m);
    expect(details).not.toContain('(evidence:');
    expect(details).toContain('      - mod%20a/pom.xml — io.vertx:vertx-core [evidence: fake.java:1), range 4.5.0 ↵ - injected: row');
    expect(details).toContain('  - mod%20a/pom.xml — Has ↵ no version.');
  });

  it('groups repeated technology observations while retaining each declaration', () => {
    const web = observation('spring-boot', undefined, undefined, 'first/pom.xml');
    web.sourceDetail = 'org.springframework.boot:spring-boot-starter-web';
    const validation = observation('spring-boot', undefined, undefined, 'second/pom.xml');
    validation.sourceDetail = 'org.springframework.boot:spring-boot-starter-validation';
    const analysis = evaluateS007(policy, evidence([web, validation]), 'java');
    const details = renderS007HumanDetails(analysis);

    expect(details.match(/^- spring-boot:/gm)).toHaveLength(1);
    expect(details).toContain('- spring-boot: Needs review: the policy rule is time-bound or disputed.');
    expect(details).toContain('  - org.springframework.boot:spring-boot-starter-web and 1 more — needs review');
    expect(details.match(/Why: /g)).toHaveLength(1);
    expect(details).toContain('Policy rule: Spring Boot 4.0 required at Trillium GA (time-bound or disputed)');
    expect(details).toContain('first/pom.xml — org.springframework.boot:spring-boot-starter-web, no version in the repository');
    expect(details).toContain('second/pom.xml — org.springframework.boot:spring-boot-starter-validation, no version in the repository');
  });

  it('summarizes mixed findings without hiding fail precedence', () => {
    const analysis = evaluateS007(policy, evidence([
      observation('react', '17.0.2', '17.0.2', 'unsupported/package.json'),
      observation('react', '>=18.0.0 <18.3.0', undefined, 'unresolved/package.json'),
      observation('react', '18.2.3', '18.2.3', 'supported/package.json')
    ]), 'javascript');
    const details = renderS007HumanDetails(analysis);

    expect(analysis.status).toBe(EvaluationStatus.FAIL);
    expect(details.match(/^- react:/gm)).toHaveLength(1);
    expect(details).toContain('- react: Mixed results: 1 fails, 1 needs review, 1 meets the policy.');
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
