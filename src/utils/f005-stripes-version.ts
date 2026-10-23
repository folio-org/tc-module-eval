import * as path from 'path';
import {
  EvaluationStatus,
  F005Analysis,
  FrontendChecklistItem,
  FrontendChecklistStartingPoint,
  ModuleKindResult,
  S007FindingEvidence,
  S007RunAnalysis,
  S007TechnologyFinding
} from '../types';
import { frontendChecklist, renderFrontendChecklistLines } from './frontend-checklist';
import { packageDependencyEntries } from './manifest-parsers';
import { readJsonFile } from './repo-files';
import { listText, reportPath, reportText, unique } from './report-text';
import { findPolicyEntry, policySections } from './s007-policy';
import { renderS007TechnologyRows } from './s007-report-details';

const SAME_AS_S007 = '(Same finding as S007.)';

// The S007 diagnostics that mean package.json itself could not be read.
const UNREADABLE_MANIFEST = new Set(['manifest_missing', 'manifest_malformed', 'manifest_too_large', 'local_module_symlink']);

/**
 * F005 (the module uses the Stripes version on the officially supported technologies page) takes S007's own
 * finding for `@folio/stripes`. Without one, a library is a Stripes constituent library and a module simply does
 * not declare Stripes; a reviewer decides both. The package manifest only supplies starting points for the reviewer.
 */
export function evaluateF005(s007: S007RunAnalysis, moduleKind: ModuleKindResult, repoPath: string): F005Analysis {
  const { policyLoad, analysis } = s007;
  const policyEntry = policyLoad.ok ? findPolicyEntry(policySections(policyLoad.policy, 's007', 'frontend'), 'stripes')?.entry : undefined;
  const rule = policyEntry?.sourceStatement;
  const minimum = policyEntry?.constraint?.kind === 'minimum' ? policyEntry.constraint.expression : undefined;
  const ruleText = rule ?? 'the Stripes version on the officially supported technologies page';
  const usesStripes: FrontendChecklistItem = {
    id: 'F005-C1',
    title: `The module works with ${ruleText}${minimum ? ` (lower bound ^${minimum})` : ''}.`,
    startingPoints: [],
    reviewerOnly: true,
    obligations: []
  };
  const base = { criterionId: 'F005' as const, policyRule: rule, policyDiagnostics: analysis.policyDiagnostics, manifestDiagnostics: [] };
  const manual = EvaluationStatus.MANUAL;

  if (!policyLoad.ok) {
    return {
      ...base,
      status: manual,
      summary: 'F005 manual: The officially supported technologies list (config/officially-supported-technologies.json) '
        + `could not be loaded, so the Stripes version was not checked. ${SAME_AS_S007}`,
      basis: 'policy-unavailable',
      stripesFindings: [],
      checklist: frontendChecklist(manual, [usesStripes])
    };
  }

  const stripesFindings = analysis.findings.filter(finding => finding.technologyId === 'stripes' && finding.contribution !== 'note');
  if (stripesFindings.length > 0) {
    const status = stripesStatus(stripesFindings);
    const deciding = stripesFindings.filter(finding => finding.contribution === String(status));
    const rationale = deciding[0].rationale;
    const ruleNote = rule && !rationale.includes(rule) ? ` The policy rule is "${rule}".` : '';
    return {
      ...base,
      status,
      summary: `F005 ${status}: Stripes is declared as ${listText(unique(deciding.flatMap(finding => finding.evidence).map(declarationText)))}. `
        + `${rationale}${ruleNote} ${SAME_AS_S007}`,
      basis: 's007-finding',
      stripesFindings,
      checklist: frontendChecklist(status, [{
        ...usesStripes,
        startingPoints: [...new Map(stripesFindings.flatMap(finding => finding.evidence).map(item => {
          const point = { path: item.path, note: `${item.detail} ${versionText(item)}` };
          return [`${point.path} ${point.note}`, point] as const;
        })).values()]
      }])
    };
  }

  // S007 could not read package.json (it also refuses symlinks and oversized files), so nothing is known about Stripes.
  const manifestDiagnostics = analysis.evidenceDiagnostics.filter(diagnostic =>
    diagnostic.path === 'package.json' && UNREADABLE_MANIFEST.has(diagnostic.code));
  if (manifestDiagnostics.length > 0) {
    return {
      ...base,
      status: manual,
      summary: 'F005 manual: package.json could not be read, so the Stripes version was not checked. S007 reports the same problem.',
      basis: 'manifest-unreadable',
      stripesFindings: [],
      manifestDiagnostics,
      checklist: frontendChecklist(manual, [{ ...usesStripes, startingPoints: [{ path: 'package.json', note: 'could not be read' }] }])
    };
  }

  if (moduleKind.kind === 'library') {
    const packageJson = readJsonFile(path.join(repoPath, 'package.json'));
    const name = typeof packageJson?.name === 'string' ? packageJson.name : 'This library';
    return {
      ...base,
      status: manual,
      summary: `F005 manual: ${name} is a Stripes library that does not depend on @folio/stripes, so the tool cannot tell `
        + `which Stripes release it belongs to. A reviewer must check that this release is part of, or compatible with, ${ruleText}.`,
      basis: 'constituent-library',
      stripesFindings: [],
      moduleKind,
      checklist: frontendChecklist(manual, [{
        id: 'F005-C2',
        title: `For a Stripes constituent library: this release is part of, or compatible with, ${ruleText}.`,
        startingPoints: libraryStartingPoints(packageJson),
        reviewerOnly: true,
        obligations: []
      }])
    };
  }

  return {
    ...base,
    status: manual,
    summary: `F005 manual: package.json does not declare @folio/stripes, so the Stripes version cannot be compared with ${ruleText}. `
      + 'A reviewer must check which Stripes version the module uses.',
    basis: 'stripes-missing',
    stripesFindings: [],
    moduleKind,
    checklist: frontendChecklist(manual, [{ ...usesStripes, startingPoints: [{ path: 'package.json', note: 'no @folio/stripes dependency' }] }])
  };
}

export function renderF005HumanDetails(analysis: F005Analysis): string {
  const lines: string[] = [];
  if (analysis.stripesFindings.length > 0) {
    lines.push("S007's Stripes finding:", ...renderS007TechnologyRows(analysis.stripesFindings));
  }
  if (analysis.moduleKind) {
    lines.push(
      `Repository kind: ${analysis.moduleKind.kind}`,
      'Module-kind evidence:',
      ...analysis.moduleKind.evidence.map(evidence => `  - ${reportText(evidence)}`),
      'S007 has no Stripes finding: package.json does not declare @folio/stripes.'
    );
  }
  if (analysis.manifestDiagnostics.length > 0) {
    lines.push('What the tool could not read:', ...analysis.manifestDiagnostics.map(diagnostic =>
      `  - ${reportPath(diagnostic.path ?? 'package.json')} — ${reportText(diagnostic.message)}`));
  }
  if (analysis.policyDiagnostics.length > 0) {
    lines.push('Problems with the officially supported technologies list:',
      ...analysis.policyDiagnostics.map(diagnostic => `  - ${reportText(diagnostic.message)}`));
  }
  lines.push(...renderFrontendChecklistLines(analysis.checklist));
  return lines.join('\n');
}

// Fail wins over manual, and manual over pass, as in S007.
function stripesStatus(findings: S007TechnologyFinding[]): EvaluationStatus.PASS | EvaluationStatus.FAIL | EvaluationStatus.MANUAL {
  if (findings.some(finding => finding.contribution === 'fail')) return EvaluationStatus.FAIL;
  return findings.some(finding => finding.contribution === 'manual') ? EvaluationStatus.MANUAL : EvaluationStatus.PASS;
}

// "^10.0.0, resolved to 10.1.5 in yarn.lock"
function versionText(evidence: S007FindingEvidence): string {
  return `${evidence.declaredVersion ?? 'without a version'}${resolvedText(evidence)}`;
}

// "dependencies.@folio/stripes ^10.0.0 in package.json, resolved to 10.1.5 in yarn.lock"
function declarationText(evidence: S007FindingEvidence): string {
  return reportText(`${evidence.detail} ${evidence.declaredVersion ?? 'without a version'} in ${evidence.path}${resolvedText(evidence)}`);
}

function resolvedText(evidence: S007FindingEvidence): string {
  return evidence.resolvedVersion && evidence.resolvedVersion !== evidence.declaredVersion
    ? `, resolved to ${evidence.resolvedVersion} in ${evidence.versionSourcePath ?? evidence.path}`
    : '';
}

// The release and the Stripes packages it is built against, for deciding which Stripes release it belongs to.
function libraryStartingPoints(packageJson: Record<string, unknown> | undefined): FrontendChecklistStartingPoint[] {
  const version = typeof packageJson?.version === 'string' ? packageJson.version : undefined;
  const stripesPackages = packageDependencyEntries(packageJson ?? {}, ['dependencies', 'peerDependencies'])
    .flatMap(entry => 'invalid' in entry || !/^@folio\/stripes(?:-|$)/.test(entry.name) || typeof entry.specifier !== 'string'
      ? [] : [{ path: 'package.json', note: `${entry.field}.${entry.name} ${entry.specifier}` }]);
  return [{ path: 'package.json', note: version ? `version ${version}` : 'no version' }, ...stripesPackages];
}
