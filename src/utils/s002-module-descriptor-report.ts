import { CommandExecutionResult, CriterionResult, EvaluationStatus, ModuleDescriptorArtifact } from '../types';
import { FRONTEND_DESCRIPTOR_SCRIPTS } from './artifacts/module-descriptor-artifact';
import { ModuleDescriptorValidationError, ModuleDescriptorValidationResult } from './module-descriptor-validator';
import { reportText } from './report-text';

const DESCRIPTOR_NAME = 'ModuleDescriptor.json';
const MAVEN_TEMPLATE_HINT = 'usually descriptors/ModuleDescriptor-template.json';
const GRADLE_TEMPLATE_HINT = 'usually service/src/main/okapi/ModuleDescriptor-template.json';
const MAX_BUILD_ERROR_LINES = 40;
const MAX_BUILD_ERROR_LINE_LENGTH = 500;
const LOG_LEVEL_TAG = /^\s*\[[A-Z]+\]/;
const TRUNCATION_MARKER = /^\[output truncated to \d+ bytes\]$/;
// Maven "[ERROR]", yarn/npm "error"/"ERR!", and Node exception lines such as "TypeError: ...".
const ERROR_LINE = /^\s*(?:\[(?:ERROR|FATAL)\]|(?:npm )?ERR!|error\b|\w*Error:)/i;
const UNCERTAIN_ARTIFACT_STATUSES = new Set<ModuleDescriptorArtifact['status']>([
  'ambiguous-candidates',
  'unsafe-to-run',
  'command-failed'
]);

/** Result for an artifact stage that did not select a descriptor to validate. */
export function s002ArtifactFailureResult(artifact: ModuleDescriptorArtifact): CriterionResult {
  return {
    criterionId: 'S002',
    status: UNCERTAIN_ARTIFACT_STATUSES.has(artifact.status) ? EvaluationStatus.MANUAL : EvaluationStatus.FAIL,
    evidence: artifactFailureEvidence(artifact),
    details: formatS002Details(artifact)
  };
}

export function s002MissingPathResult(artifact: ModuleDescriptorArtifact): CriterionResult {
  return {
    criterionId: 'S002',
    status: EvaluationStatus.FAIL,
    evidence: 'A module descriptor was reported as found, but its location was not recorded, so it could not be checked.',
    details: formatS002Details(artifact)
  };
}

export function s002ReadFailureResult(artifact: ModuleDescriptorArtifact, readError: string): CriterionResult {
  return {
    criterionId: 'S002',
    status: EvaluationStatus.FAIL,
    evidence: `The module descriptor ${describeDescriptor(artifact)} could not be read, so it could not be checked against the Okapi schema.`,
    details: formatS002Details(artifact, [`Read error: ${reportText(readError)}`])
  };
}

export function s002ValidationResult(
  artifact: ModuleDescriptorArtifact,
  validation: ModuleDescriptorValidationResult
): CriterionResult {
  const checkedAgainst = `Checked against: Okapi ModuleDescriptor schema (${validation.schemaBaseline})`;
  if (validation.valid) {
    return {
      criterionId: 'S002',
      status: EvaluationStatus.PASS,
      evidence: `The module descriptor ${describeDescriptor(artifact)} matches the Okapi ModuleDescriptor schema.`,
      details: formatS002Details(artifact, [checkedAgainst])
    };
  }

  if (validation.parseError) {
    return {
      criterionId: 'S002',
      status: EvaluationStatus.FAIL,
      evidence: `The module descriptor ${describeDescriptor(artifact)} is not valid JSON, so it could not be checked against the Okapi schema. Fix the syntax error under "JSON error" ${fixLocation(artifact)}.`,
      details: formatS002Details(artifact, [checkedAgainst, `JSON error: ${reportText(validation.parseError)}`])
    };
  }

  const count = validation.errors.length;
  return {
    criterionId: 'S002',
    status: EvaluationStatus.FAIL,
    evidence: `The module descriptor ${describeDescriptor(artifact)} does not match the Okapi ModuleDescriptor schema: ${count} ${count === 1 ? 'problem' : 'problems'}, listed under "Schema problems". Fix ${count === 1 ? 'it' : 'them'} ${fixLocation(artifact)}.`,
    details: formatS002Details(artifact, [
      checkedAgainst,
      'Schema problems:',
      ...validation.errors.map(error => `  - ${reportText(describeSchemaProblem(error))}`)
    ])
  };
}

function artifactFailureEvidence(artifact: ModuleDescriptorArtifact): string {
  const problem = artifact.errors.join(' ');
  switch (artifact.status) {
    case 'unsafe-to-run':
      return artifact.command?.status === 'blocked' && !artifact.command.localCommandsAllowed
        ? `The module descriptor is ${describeSource(artifact)}, which was not run because build commands are turned off for this evaluation. Rerun with --allow-local-commands on a trusted machine, or check the descriptor by hand.`
        : `The evaluator could not safely look for the module descriptor. ${sentence(problem)} A reviewer needs to check it by hand.`;
    case 'command-failed':
      return `The ${buildName(artifact)} that generates the module descriptor ${commandFailure(artifact.command)}, so the descriptor could not be checked. A reviewer needs to check whether the build works and its descriptor is valid.`;
    case 'ambiguous-candidates':
      return `${problem} A reviewer needs to pick the module's descriptor and check it against the Okapi schema.`;
    case 'missing':
    case 'invalid-candidate':
      return `${problem} ${missingDescriptorFix(artifact)}`;
    default:
      return problem || 'No module descriptor was selected for checking.';
  }
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function missingDescriptorFix(artifact: ModuleDescriptorArtifact): string {
  switch (artifact.strategy) {
    case 'maven-generation':
      return `Make the build generate it, ${MAVEN_TEMPLATE_HINT}.`;
    case 'gradle-generation':
      return `Make the build's processResources task generate it, ${GRADLE_TEMPLATE_HINT}.`;
    case 'frontend-script':
      return `Fix the ${scriptName(artifact)} script so it writes ${DESCRIPTOR_NAME}.`;
    default:
      return `Commit a ${DESCRIPTOR_NAME} at the repository root, or add a build step that generates it.`;
  }
}

function formatS002Details(artifact: ModuleDescriptorArtifact, extraLines: string[] = []): string {
  const lines: Array<string | undefined> = [
    artifact.descriptorPath ? `Descriptor: ${reportText(artifact.descriptorPath)}` : undefined,
    artifact.strategy ? `Source: ${sourceLabel(artifact)}` : undefined,
    artifact.command ? `Build command: ${reportText(formatCommand(artifact.command))}` : undefined,
    !artifact.strategy && artifact.status !== 'unsafe-to-run'
      ? `Looked for: a ${DESCRIPTOR_NAME} at the repository root, a Maven build (pom.xml), a Gradle build (build.gradle at the root or in service/), or a package.json script named ${FRONTEND_DESCRIPTOR_SCRIPTS.join(', ')}`
      : undefined,
    ...extraLines,
    ...formatBuildErrorLines(artifact),
    ...(artifact.warnings.length ? ['Notes:', ...artifact.warnings.map(warning => `  - ${reportText(warning)}`)] : [])
  ];

  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

// Runner output for failed builds; blocked commands are explained by the evidence instead.
function formatBuildErrorLines(artifact: ModuleDescriptorArtifact): string[] {
  if (artifact.status !== 'command-failed') {
    return [];
  }

  // Maven reports failures on stdout, and Gradle and yarn on stderr; put that stream last so the tail keeps the failure.
  const command = artifact.command;
  const streams = artifact.strategy === 'maven-generation'
    ? [command?.stderr, command?.stdout]
    : [command?.stdout, command?.stderr];
  const printed = streams
    .flatMap(stream => (stream ?? '').split('\n'))
    .map(line => line.trimEnd())
    .filter(line => !TRUNCATION_MARKER.test(line));
  // A build that could not start (for example "spawn mvn ENOENT") prints nothing; show the runner's error instead.
  const output = (printed.some(isMeaningfulLine)
    ? printed
    : artifact.errors.map(error => error.replace(/^Command exited with code \S+(?::\s*|$)/, '')).flatMap(error => error.split('\n'))
  ).filter(isMeaningfulLine);
  if (!output.length) {
    return [];
  }
  const cutOff = Boolean(command?.stdoutTruncated || command?.stderrTruncated);

  // The end of the output usually holds the actual failure.
  // The report shows long lists collapsed to their first few items, so list only the error lines when there are any.
  const tail = output.slice(-MAX_BUILD_ERROR_LINES);
  const errorLines = tail.filter(line => ERROR_LINE.test(line));
  const shown = (errorLines.length ? errorLines : tail).map(line =>
    line.length > MAX_BUILD_ERROR_LINE_LENGTH ? `${line.slice(0, MAX_BUILD_ERROR_LINE_LENGTH)}… (line shortened)` : line
  );
  // The runner keeps the start of each stream, so when it cut the output off, the true end of the build is missing.
  const cutOffNote = 'the build printed more than the evaluator keeps, so the final lines are missing';
  const heading = errorLines.length
    ? cutOff
      ? `Build error (error lines from the build output; ${cutOffNote}):`
      : 'Build error (error lines from the end of the build output):'
    : output.length > tail.length
      ? `Build error (last ${tail.length} of ${output.length} lines of build output${cutOff ? `; ${cutOffNote}` : ''}):`
      : cutOff ? `Build error (${cutOffNote}):` : 'Build error:';
  return [heading, ...shown.map(line => `  - ${reportText(line)}`)];
}

function isMeaningfulLine(line: string): boolean {
  return /[A-Za-z0-9]/.test(line.replace(LOG_LEVEL_TAG, ''));
}

function describeDescriptor(artifact: ModuleDescriptorArtifact): string {
  return `${artifact.descriptorPath ?? DESCRIPTOR_NAME} (${describeSource(artifact)})`;
}

function describeSource(artifact: ModuleDescriptorArtifact): string {
  switch (artifact.strategy) {
    case 'maven-generation':
      return 'generated by the Maven build';
    case 'gradle-generation':
      return 'generated by the Gradle build';
    case 'frontend-script':
      return `generated by the ${scriptName(artifact)} script`;
    case 'static-root':
      return 'committed at the repository root';
    default:
      return 'source unknown';
  }
}

function sourceLabel(artifact: ModuleDescriptorArtifact): string {
  switch (artifact.strategy) {
    case 'maven-generation':
      return 'Maven build';
    case 'gradle-generation':
      return 'Gradle build';
    case 'frontend-script':
      return `${scriptName(artifact)} script in package.json`;
    default:
      return 'committed file at the repository root';
  }
}

function fixLocation(artifact: ModuleDescriptorArtifact): string {
  switch (artifact.strategy) {
    case 'maven-generation':
      return `in the descriptor template the Maven build generates it from (${MAVEN_TEMPLATE_HINT})`;
    case 'gradle-generation':
      return `in the descriptor template the Gradle build generates it from (${GRADLE_TEMPLATE_HINT})`;
    case 'frontend-script':
      return `in the package.json settings the ${scriptName(artifact)} script generates it from`;
    default:
      return `in ${artifact.descriptorPath ?? DESCRIPTOR_NAME}`;
  }
}

function buildName(artifact: ModuleDescriptorArtifact): string {
  switch (artifact.strategy) {
    case 'frontend-script':
      return `${scriptName(artifact)} script`;
    case 'gradle-generation':
      return 'Gradle build';
    default:
      return 'Maven build';
  }
}

function scriptName(artifact: ModuleDescriptorArtifact): string {
  return artifact.command?.args[1] ?? 'package.json descriptor';
}

function formatCommand(command: CommandExecutionResult): string {
  const commandLine = [command.command, ...command.args].join(' ');
  const where = command.commandExecutionEnvironment === 'github-actions' ? 'in GitHub Actions' : 'locally';
  switch (command.status) {
    case 'success':
      return `${commandLine} (ran ${where} and succeeded)`;
    case 'blocked':
      return command.localCommandsAllowed
        ? `${commandLine} (not run)`
        : `${commandLine} (not run: build commands are turned off)`;
    default:
      return `${commandLine} (ran ${where} and ${commandFailure(command)})`;
  }
}

function commandFailure(command: CommandExecutionResult | undefined): string {
  if (command?.status === 'timed_out') {
    return 'timed out';
  }
  return typeof command?.exitCode === 'number' ? `failed with exit code ${command.exitCode}` : 'failed';
}

// Ajv reports JSON pointers and schema keywords; name the descriptor field instead.
export function describeSchemaProblem(error: ModuleDescriptorValidationError): string {
  const field = fieldPath(error.instancePath);
  const child = (name: unknown) => (field ? `${field}.${String(name)}` : String(name));
  switch (error.keyword) {
    case 'required':
      return `Missing required field "${child(error.params.missingProperty)}"`;
    case 'additionalProperties':
      return `Field "${child(error.params.additionalProperty)}" is not allowed by the schema`;
    case 'type':
      return `${field ? `Field "${field}"` : 'The descriptor'} must be ${describeTypes(error.params.type)}`;
    default:
      return `${field ? `Field "${field}"` : 'The descriptor'} ${error.message}`;
  }
}

function fieldPath(instancePath: string): string {
  return instancePath
    .split('/')
    .slice(1)
    .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((path, segment) => (/^\d+$/.test(segment) ? `${path}[${segment}]` : path ? `${path}.${segment}` : segment), '');
}

function describeTypes(type: unknown): string {
  const articles: Record<string, string> = {
    array: 'an array',
    boolean: 'true or false',
    integer: 'a whole number',
    null: 'null',
    number: 'a number',
    object: 'an object',
    string: 'a string'
  };
  return String(type).split(',').map(name => articles[name] ?? name).join(' or ');
}
