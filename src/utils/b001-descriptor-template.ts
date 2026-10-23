import * as fs from 'fs';
import {
  B001Analysis,
  B001Basis,
  BackendEvidence,
  BackendPlaceholder,
  BackendRepositoryKind,
  EvaluationStatus,
  FrontendChecklistItem,
  ModuleDescriptorArtifact
} from '../types';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { validateModuleDescriptorJson } from './module-descriptor-validator';
import { listText, overflowLine, reportPath, reportText } from './report-text';
import { describeSchemaProblem } from './s002-module-descriptor-report';

const LOOKED_FOR = 'ModuleDescriptor*.json in descriptors/, src/main/resources/descriptors/, service/src/main/okapi/ or the repository root';
const MAX_ROWS = 20;

const KIND_LABELS: Record<BackendRepositoryKind, string> = {
  'backend-module': 'backend module',
  'edge-module': 'edge module',
  library: 'shared library',
  ambiguous: 'not a known module or library'
};

const FRAMEWORK_LABELS: Record<BackendEvidence['framework']['name'], string> = {
  rmb: 'RAML Module Builder (RMB)',
  spring: 'Spring Boot',
  vertx: 'Vert.x',
  grails: 'Grails',
  edge: 'edge module',
  library: 'shared library',
  unknown: 'not recognised'
};

/**
 * B001 (a compliant module descriptor in the repository) checks the committed descriptor template, with the build
 * placeholders the build properties define replaced, against the Okapi schema S002 uses. S002's check of the
 * descriptor the build generates is reported, not re-decided.
 */
export function evaluateB001(evidence: BackendEvidence, s002Artifact?: ModuleDescriptorArtifact): B001Analysis {
  const { kind, kindEvidence, templateCandidates, template, framework, storage } = evidence;
  // Problems with the snapshot itself (not a single file) could hide a template.
  const sourceDiagnostics = evidence.snapshot.diagnostics.filter(diagnostic =>
    diagnostic.material && (!diagnostic.path || templateCandidates.includes(diagnostic.path)));
  const base = {
    criterionId: 'B001' as const, kind, kindEvidence, templateCandidates, framework, storage, sourceDiagnostics, schemaProblems: [] as string[],
    generatedDescriptor: generatedDescriptor(s002Artifact)
  };
  const startingPoints = (paths: string[]) => [
    ...paths.map(path => ({ path, note: 'committed descriptor template' })),
    ...buildFile(evidence).map(path => ({ path, note: 'build that generates ModuleDescriptor.json from the template' }))
  ];
  const templateIsUsed = (paths: string[]): FrontendChecklistItem => ({
    id: 'B001-C1', title: 'The descriptor template is the one the build uses.', startingPoints: startingPoints(paths), reviewerOnly: true, obligations: []
  });
  const result = (status: EvaluationStatus, basis: B001Basis, summary: string, items: FrontendChecklistItem[], extra: Partial<B001Analysis> = {}): B001Analysis =>
    ({ ...base, ...extra, status, basis, summary: `B001 ${status}: ${summary}`, checklist: frontendChecklist(status, items) });

  if (kind === 'library') {
    return result(EvaluationStatus.NOT_APPLICABLE, 'library',
      'The repository is a shared library, which needs no module descriptor.', []);
  }

  if (!template) {
    if (templateCandidates.length > 1) {
      return result(EvaluationStatus.MANUAL, 'several-templates',
        `Several module descriptor candidates were found (${listText(templateCandidates.map(reportPath))}). A reviewer must check which one the build uses.`,
        [templateIsUsed(templateCandidates)]);
    }
    if (kind === 'edge-module' && !sourceDiagnostics.length) {
      return result(EvaluationStatus.FAIL, 'edge-without-template',
        `${reportText(evidence.artifactId ?? 'The repository')} is an edge module, but it has no module descriptor template. `
        + 'Commit one at descriptors/ModuleDescriptor-template.json.', []);
    }
    if (kind !== 'ambiguous') {
      // The working tree has a descriptor (or this is an edge module), but the committed source did not yield one.
      const problems = sourceDiagnostics.map(diagnostic => reportText(diagnostic.message));
      return result(EvaluationStatus.MANUAL, 'template-unreadable',
        `The repository is ${kind === 'edge-module' ? 'an edge module' : 'a backend module'}, but no committed descriptor template was read`
        + `${problems.length ? ` (${listText(problems)})` : ''}. A reviewer must check its template.`, [templateIsUsed([])]);
    }
    return result(EvaluationStatus.MANUAL, 'ambiguous-without-template',
      'No module descriptor was found, and the repository is not a known shared library. A module must have one; a library need not.',
      [{
        id: 'B001-C2',
        title: 'The repository is a shared library, or it is a module and commits its module descriptor template.',
        startingPoints: buildFile(evidence).map(path => ({ path, note: 'what the build produces' })),
        reviewerOnly: true,
        obligations: []
      }]);
  }

  const path = reportPath(template.path);
  const extra = { template: { path: template.path, placeholders: template.placeholders } };
  const items = [templateIsUsed([template.path])];
  if (template.readError) {
    return result(EvaluationStatus.MANUAL, 'template-unreadable',
      `${path} could not be read (${reportText(template.readError)}), so it was not checked.`, items, extra);
  }
  const outside = template.placeholders.filter(placeholder => placeholder.outsideString);
  if (outside.length) {
    return result(EvaluationStatus.MANUAL, 'template-placeholders-outside-strings',
      `${path} has build placeholders outside JSON strings (${listText(outside.map(placeholder => reportText(placeholder.text)))}), `
      + 'so whether it is valid JSON depends on what the build writes there. A reviewer must check the generated descriptor.', items, extra);
  }
  if (template.parseError !== undefined) {
    return result(EvaluationStatus.FAIL, 'template-invalid-json',
      `${path} is not valid JSON${placeholderClause(template.placeholders, 'after')}: ${reportText(template.parseError)}`, items,
      { ...extra, parseError: template.parseError });
  }

  const validation = validateModuleDescriptorJson(template.content ?? '');
  const schemaProblems = validation.errors.map(describeSchemaProblem);
  if (!validation.valid) {
    return result(EvaluationStatus.FAIL, 'template-schema-errors',
      `${path} does not match the Okapi ModuleDescriptor schema${placeholderClause(template.placeholders, 'after')}: `
      + `${schemaProblems.length} ${schemaProblems.length === 1 ? 'problem' : 'problems'}, listed under "Schema problems".`, items,
      { ...extra, schemaBaseline: validation.schemaBaseline, schemaProblems });
  }
  return result(EvaluationStatus.PASS, 'template-valid',
    `${path} matches the Okapi ModuleDescriptor schema${placeholderClause(template.placeholders, 'with')}. S002 checks the descriptor the build produces.`,
    [], { ...extra, schemaBaseline: validation.schemaBaseline });
}

export function renderB001HumanDetails(analysis: B001Analysis): string {
  const lines: string[] = [];
  if (analysis.template) lines.push(`Descriptor template: ${reportPath(analysis.template.path)}`);
  if (analysis.schemaBaseline) lines.push(`Checked against: Okapi ModuleDescriptor schema (${analysis.schemaBaseline})`);
  if (analysis.parseError) lines.push(`JSON error: ${reportText(analysis.parseError)}`);
  const placeholders = analysis.template?.placeholders ?? [];
  if (placeholders.length) {
    lines.push('Build placeholders:', ...placeholders.slice(0, MAX_ROWS).map(placeholderLine), ...overflowLine(placeholders.length, MAX_ROWS, '  '));
  }
  if (analysis.schemaProblems.length) {
    lines.push('Schema problems:', ...analysis.schemaProblems.slice(0, MAX_ROWS).map(problem => `  - ${reportText(problem)}`),
      ...overflowLine(analysis.schemaProblems.length, MAX_ROWS, '  '));
  }
  if (analysis.templateCandidates.length > 1) {
    lines.push('Descriptor candidates:', ...analysis.templateCandidates.map(candidate => `  - ${reportPath(candidate)}`));
  }
  if (!analysis.templateCandidates.length && analysis.kind !== 'library') lines.push(`Looked for: ${LOOKED_FOR}`);
  const generated = analysis.generatedDescriptor;
  if (generated) {
    lines.push(`Generated descriptor: ${reportPath(generated.path)}, generated by the build for S002, ${generated.valid
      ? 'matches the Okapi schema'
      : `has ${generated.problemCount} schema ${generated.problemCount === 1 ? 'problem' : 'problems'}`} (S002 reports it; B001 checks the committed template)`);
  }
  lines.push(`Repository kind: ${KIND_LABELS[analysis.kind]}`,
    'Repository-kind evidence:', ...analysis.kindEvidence.map(item => `  - ${reportText(item)}`),
    `Framework: ${FRAMEWORK_LABELS[analysis.framework.name]}`, ...analysis.framework.evidence.map(item => `  - ${reportText(item)}`),
    `Storage: ${analysis.storage.present ? 'found' : 'none found'}`, ...analysis.storage.evidence.map(item => `  - ${reportText(item)}`));
  if (analysis.sourceDiagnostics.length) {
    lines.push('What the tool could not read:', ...analysis.sourceDiagnostics.map(diagnostic =>
      `  - ${diagnostic.path ? `${reportPath(diagnostic.path)} — ` : ''}${reportText(diagnostic.message)}`));
  }
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  return lines.join('\n');
}

// " (checked with build placeholders such as ${artifactId} replaced)"
function placeholderClause(placeholders: BackendPlaceholder[], preposition: 'with' | 'after'): string {
  const resolved = placeholders.filter(placeholder => placeholder.value !== undefined);
  const unresolved = placeholders.filter(placeholder => placeholder.value === undefined);
  if (!placeholders.length) return '';
  const parts = [
    ...(resolved.length ? [`build placeholders such as ${reportText(resolved[0].text)} replaced`] : []),
    ...(unresolved.length ? [`${listText(unresolved.map(placeholder => reportText(placeholder.text)))} left as written, because the build properties do not define ${unresolved.length === 1 ? 'it' : 'them'}`] : [])
  ];
  return preposition === 'with' ? ` (checked with ${parts.join('; ')})` : ` (with ${parts.join('; ')})`;
}

function placeholderLine(placeholder: BackendPlaceholder): string {
  const where = placeholder.outsideString ? ' (outside a JSON string)' : '';
  if (placeholder.value !== undefined) {
    return `  - ${reportText(placeholder.text)} = ${reportText(placeholder.value)}, from ${reportText(placeholder.source ?? 'the build properties')}${where}`;
  }
  const pointers = placeholder.pointers.length ? `; used at ${placeholder.pointers.slice(0, 5).map(reportText).join(', ')}${placeholder.pointers.length > 5 ? ', …' : ''}` : '';
  return `  - ${reportText(placeholder.text)} is not defined by the build properties${where}${pointers}`;
}

function buildFile(evidence: BackendEvidence): string[] {
  const paths = evidence.snapshot.files.map(file => file.path);
  const nearest = (evidence.template?.path ?? '').split('/').slice(0, -1);
  for (let depth = nearest.length; depth >= 0; depth--) {
    const directory = nearest.slice(0, depth).join('/');
    const found = ['pom.xml', 'build.gradle', 'build.gradle.kts'].map(name => directory ? `${directory}/${name}` : name).find(path => paths.includes(path));
    if (found) return [found];
  }
  return paths.filter(path => /^(?:service\/)?(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(path)).slice(0, 1);
}

function generatedDescriptor(artifact: ModuleDescriptorArtifact | undefined): B001Analysis['generatedDescriptor'] {
  if (!artifact || !['produced', 'discovered'].includes(artifact.status) || !artifact.absolutePath || !artifact.descriptorPath
    || (artifact.strategy !== 'maven-generation' && artifact.strategy !== 'gradle-generation')) {
    return undefined;
  }
  try {
    const validation = validateModuleDescriptorJson(fs.readFileSync(artifact.absolutePath, 'utf-8'));
    return { path: artifact.descriptorPath, valid: validation.valid, problemCount: validation.errors.length + (validation.parseError ? 1 : 0) };
  } catch {
    return undefined;
  }
}
