import {
  EvaluationStatus,
  S010Analysis,
  S010Evidence,
  S010Finding,
  S010ScenarioEvidence
} from '../types';
import { s010FindingTitle, s010ServiceName } from './s010-report-details';

const RUNTIME_NAMES: Record<S010Evidence['runtimeKind'], string> = {
  java: 'Java',
  'stripes-react': 'a Stripes/React UI',
  node: 'Node.js',
  mixed: 'a mix of Java and JavaScript',
  unknown: 'not a recognized type'
};

export function evaluateS010(evidence: S010Evidence): S010Analysis {
  if (evidence.moduleKind.kind === 'library') {
    return analysis(
      evidence,
      EvaluationStatus.NOT_APPLICABLE,
      'S010 not applicable: This repository is a FOLIO library, not a deployable module, so S010 does not apply.',
      []
    );
  }

  if (evidence.runtimeKind !== 'java' && evidence.runtimeKind !== 'stripes-react') {
    const finding = unresolvedFinding(
      'runtime-support',
      'runtime-support',
      `The tool can only analyse Java and Stripes/React modules, and this repository is ${RUNTIME_NAMES[evidence.runtimeKind]}.`
    );
    finding.statusDetermining = true;
    return analysis(
      evidence,
      EvaluationStatus.MANUAL,
      `S010 manual: The tool can only analyse Java and Stripes/React modules, and this repository is ${RUNTIME_NAMES[evidence.runtimeKind]}. A reviewer needs to check how it behaves when the services and settings it depends on are missing or down.`,
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
      'The tool could not read or analyse all of the code (see Warnings and the items above), so there may be services it did not find.'
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

  return analysis(evidence, status, summary(status, findings), findings);
}

function classifyScenario(scenario: S010ScenarioEvidence): S010Finding {
  if (scenario.requirement === 'required' && scenario.scenario === 'configuration-absent') {
    if (scenario.proof === 'clear-fail-fast') {
      return finding(scenario, 'satisfactory', 'The setting is required and has no default, so the module stops at startup with an error when it is missing.');
    }
    if (scenario.proof === 'uncontrolled-failure') {
      return finding(scenario, 'violation', 'The module keeps starting without this required setting and fails later. Make startup stop with a clear error when the setting is missing.');
    }
    return finding(scenario, 'unresolved', 'The setting is required, but the code does not show that startup stops with a clear error when it is missing.');
  }

  if (scenario.requirement === 'required') {
    if (scenario.proof === 'uncontrolled-failure') {
      return finding(scenario, 'violation', 'The code shows that an outage of this required service is not handled. Add a time limit and error handling so the failure is clear and bounded.');
    }
    if (
      scenario.scenario === 'startup-unavailable'
      && scenario.proof === 'clear-fail-fast'
      && scenario.boundedFailure === 'proven'
    ) {
      return finding(scenario, 'satisfactory', 'If this required service is down at startup, the module stops with a clear error within a time limit.');
    }
    if (
      scenario.scenario === 'runtime-unavailable'
      && scenario.proof === 'controlled-degradation'
      && scenario.boundedFailure === 'proven'
      && (scenario.readiness === 'preserved' || scenario.readiness === 'not-preserved')
    ) {
      return finding(scenario, 'satisfactory', 'If this required service goes down while the module runs, calls fail within a time limit and the errors are handled.');
    }
  }

  if (scenario.requirement === 'optional') {
    if (scenario.proof === 'uncontrolled-failure' || scenario.readiness === 'not-preserved') {
      return finding(scenario, 'violation', scenario.readiness === 'not-preserved'
        ? 'Losing this optional service makes the module report itself as not ready. Keep the module ready and turn off only the features that need the service.'
        : 'Losing this optional service is not handled. Add a time limit and error handling so that only the features that use it fail.');
    }
    const bounded = scenario.boundedFailure === 'proven' || scenario.boundedFailure === 'not-applicable';
    if (scenario.proof === 'controlled-degradation' && bounded && scenario.readiness === 'preserved') {
      return finding(scenario, 'satisfactory', 'If this optional service fails, calls end within a time limit, the errors are handled, and the module stays ready.');
    }
  }

  return finding(
    scenario,
    'unresolved',
    scenario.rationale ?? 'The code does not show what happens from a failure of this service through to its outcome.'
  );
}

function emptyScopeFinding(evidence: S010Evidence): S010Finding {
  if (evidence.discoveryCoverage === 'complete' && evidence.semanticCoverage === 'complete') {
    return {
      id: 'dependency-scope/empty',
      dependencyId: 'dependency-scope',
      outcome: 'satisfactory',
      rationale: 'The tool read and analysed all of the relevant code and found no external services.',
      evidence: [],
      statusDetermining: false
    };
  }
  return unresolvedFinding(
    'dependency-scope/unknown',
    'dependency-scope',
    'The tool found no external services it recognises, but it could not read or analyse all of the code (see Warnings), so this does not show that there are none.'
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

function summary(status: EvaluationStatus, findings: S010Finding[]): string {
  const deciding = findings.filter(finding => finding.statusDetermining);
  const services = [...new Set(deciding.flatMap(finding => s010ServiceName(finding) ?? []))];
  switch (status) {
    case EvaluationStatus.FAIL: {
      const [first] = deciding;
      const more = deciding.length > 1 ? ` ${deciding.length - 1} more ${deciding.length === 2 ? 'problem is' : 'problems are'} listed below.` : '';
      return `S010 fail: ${s010FindingTitle([first])}: ${first.rationale}${more}`;
    }
    case EvaluationStatus.PASS:
      return findings.some(finding => finding.dependencyId === 'dependency-scope')
        ? 'S010 pass: The tool read all of the relevant code and found no external services that the module depends on.'
        : 'S010 pass: Every external service and setting the tool found either stops startup with a clear error or fails in a controlled way.';
    default:
      if (!services.length) {
        return 'S010 manual: The tool found no problems, but it could not read or analyse all of the code, so a reviewer needs to check for services it did not find.';
      }
      return `S010 manual: The tool found services the module depends on (${services.slice(0, 5).join(', ')}${services.length > 5 ? `, +${services.length - 5} more` : ''}) but could not confirm how the module behaves when they are missing or down. A reviewer needs to check the items under "Needs review".`;
  }
}
