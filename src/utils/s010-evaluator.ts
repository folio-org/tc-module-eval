import {
  EvaluationStatus,
  S010Analysis,
  S010Evidence,
  S010Finding,
  S010ScenarioEvidence
} from '../types';

export function evaluateS010(evidence: S010Evidence): S010Analysis {
  if (evidence.moduleKind.kind === 'library') {
    return analysis(
      evidence,
      EvaluationStatus.NOT_APPLICABLE,
      'S010 does not apply to explicit library repositories.',
      []
    );
  }

  if (evidence.runtimeKind !== 'java' && evidence.runtimeKind !== 'stripes-react') {
    const finding = unresolvedFinding(
      'runtime-support',
      'runtime-support',
      `S010 automation does not support runtime kind ${evidence.runtimeKind}.`
    );
    finding.statusDetermining = true;
    return analysis(
      evidence,
      EvaluationStatus.MANUAL,
      'S010 requires manual review because the repository runtime is unsupported or unresolved.',
      [finding]
    );
  }

  const findings = evidence.scenarios.map(classifyScenario);
  if (findings.length === 0) {
    findings.push(emptyScopeFinding(evidence));
  } else if (evidence.discoveryCoverage !== 'complete' || evidence.semanticCoverage !== 'complete') {
    findings.push(unresolvedFinding(
      'evidence-coverage/incomplete',
      'evidence-coverage',
      'Repository evidence coverage is incomplete or unsupported, so satisfactory scenarios cannot establish S010 compliance.'
    ));
  }

  const status = findings.some(finding => finding.outcome === 'violation')
    ? EvaluationStatus.FAIL
    : findings.some(finding => finding.outcome === 'unresolved')
      || evidence.diagnostics.some(diagnostic => diagnostic.material)
      ? EvaluationStatus.MANUAL
      : EvaluationStatus.PASS;

  for (const finding of findings) {
    finding.statusDetermining =
      (status === EvaluationStatus.FAIL && finding.outcome === 'violation')
      || (status === EvaluationStatus.MANUAL && finding.outcome === 'unresolved')
      || (status === EvaluationStatus.PASS && finding.outcome === 'satisfactory');
  }

  return analysis(evidence, status, summary(status), findings);
}

function classifyScenario(scenario: S010ScenarioEvidence): S010Finding {
  if (scenario.requirement === 'required' && scenario.scenario === 'configuration-absent') {
    if (scenario.proof === 'clear-fail-fast') {
      return finding(scenario, 'satisfactory', 'Missing required configuration has a clear fail-fast startup path.');
    }
    if (scenario.proof === 'uncontrolled-failure') {
      return finding(scenario, 'violation', 'Repository evidence proves missing required configuration is deferred or handled uncontrollably.');
    }
    return finding(scenario, 'unresolved', 'Required configuration behavior could not be established conclusively.');
  }

  if (scenario.requirement === 'required') {
    if (scenario.proof === 'uncontrolled-failure') {
      return finding(scenario, 'violation', 'Repository evidence proves the required dependency outage has an uncontrolled outcome.');
    }
    if (
      scenario.scenario === 'startup-unavailable'
      && scenario.proof === 'clear-fail-fast'
      && scenario.boundedFailure === 'proven'
    ) {
      return finding(scenario, 'satisfactory', 'Required dependency startup failure is clear and bounded.');
    }
    if (
      scenario.scenario === 'runtime-unavailable'
      && scenario.proof === 'controlled-degradation'
      && scenario.boundedFailure === 'proven'
      && (scenario.readiness === 'preserved' || scenario.readiness === 'not-preserved')
    ) {
      return finding(scenario, 'satisfactory', 'Required dependency runtime failure is bounded and controlled.');
    }
  }

  if (scenario.requirement === 'optional') {
    if (scenario.proof === 'uncontrolled-failure' || scenario.readiness === 'not-preserved') {
      return finding(scenario, 'violation', scenario.readiness === 'not-preserved'
        ? 'Repository evidence proves optional dependency loss makes the module unready.'
        : 'Repository evidence proves optional dependency loss has an uncontrolled outcome.');
    }
    const bounded = scenario.boundedFailure === 'proven' || scenario.boundedFailure === 'not-applicable';
    if (scenario.proof === 'controlled-degradation' && bounded && scenario.readiness === 'preserved') {
      return finding(scenario, 'satisfactory', 'Optional dependency failure is bounded, controlled, and preserves readiness.');
    }
  }

  return finding(
    scenario,
    'unresolved',
    scenario.rationale ?? 'Repository evidence does not establish the complete dependency failure path.'
  );
}

function emptyScopeFinding(evidence: S010Evidence): S010Finding {
  if (evidence.discoveryCoverage === 'complete' && evidence.semanticCoverage === 'complete') {
    return {
      id: 'dependency-scope/empty',
      dependencyId: 'dependency-scope',
      outcome: 'satisfactory',
      rationale: 'Complete repository evidence found no external runtime dependencies.',
      evidence: [],
      statusDetermining: false
    };
  }
  return unresolvedFinding(
    'dependency-scope/unknown',
    'dependency-scope',
    'An empty detector result does not establish that the module has no external runtime dependencies.'
  );
}

function finding(
  scenario: S010ScenarioEvidence,
  outcome: S010Finding['outcome'],
  rationale: string
): S010Finding {
  return {
    id: scenario.id,
    dependencyId: scenario.dependencyId,
    scenario: scenario.scenario,
    outcome,
    rationale,
    evidence: scenario.sourceReferences,
    statusDetermining: false
  };
}

function unresolvedFinding(id: string, dependencyId: string, rationale: string): S010Finding {
  return {
    id,
    dependencyId,
    outcome: 'unresolved',
    rationale,
    evidence: [],
    statusDetermining: false
  };
}

function analysis(
  evidence: S010Evidence,
  status: EvaluationStatus,
  summaryText: string,
  findings: S010Finding[]
): S010Analysis {
  return {
    criterionId: 'S010',
    status,
    summary: summaryText,
    evidence,
    findings,
    diagnostics: evidence.diagnostics
  };
}

function summary(status: EvaluationStatus): string {
  switch (status) {
    case EvaluationStatus.FAIL:
      return 'S010 fail: repository evidence proves at least one runtime dependency failure path violates the criterion.';
    case EvaluationStatus.PASS:
      return 'S010 pass: all applicable runtime dependency scenarios are supported by complete satisfactory evidence.';
    default:
      return 'S010 manual: runtime dependency behavior or evidence coverage requires reviewer judgment.';
  }
}
