import * as fs from 'fs';
import {
  CriterionResult,
  EvaluationRun,
  EvaluationStatus,
  ModuleDescriptorArtifact,
  ModuleKindResult,
  S005PersonalDataDisclosureAnalysisResult
} from '../../types';
import { CriterionLanguage } from '../../criteria-definitions';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { LicenseUtils } from '../../utils/license-utils';
import { evaluateS003ThirdPartyLicenses } from '../../utils/license-compliance-evaluator';
import { produceModuleDescriptorArtifact } from '../../utils/artifacts/module-descriptor-artifact';
import { createEvaluationRun } from '../../utils/evaluation-run';
import { validateModuleDescriptorJson } from '../../utils/module-descriptor-validator';
import { analyzeS004Documentation, formatS004Evidence } from '../../utils/s004-installation-documentation';
import { classifyModuleKind } from '../../utils/module-kind';
import { reviewS004WithAgent } from '../../utils/s004-agent-review';
import { reviewCriterionWithAgent } from '../../utils/criterion-agent-review';
import { analyzeS005PersonalDataDisclosure } from '../../utils/s005-personal-data-disclosure';

const S005_AGENT_NOT_APPLIED_REASON = 'S005 agent review is not applied until the criterion-agent adapter is added.';

/**
 * Abstract base class for Shared/Common criteria (S001-S014). Handled criterion
 * IDs and their fallback results are derived from the acceptance-criterion catalog
 * by CatalogSectionEvaluator. Automated criteria are supplied as handler overrides
 * to super() (here S001, S002, S003, and S004); every other criterion falls back to the
 * catalog-defined default result for the given language.
 */
export abstract class SharedEvaluator extends CatalogSectionEvaluator {
  constructor(language: CriterionLanguage = 'java') {
    super('Shared/Common', language, {
      S001: async (repoPath: string) => this.evaluateS001(repoPath),
      S002: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS002(repoPath, evaluationRun),
      S003: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS003(repoPath, evaluationRun),
      S004: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS004(repoPath, evaluationRun),
      S005: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS005(repoPath, evaluationRun)
    });
  }

  private async evaluateS001(repoPath: string): Promise<CriterionResult> {
    return await LicenseUtils.checkApache2License(repoPath, 'S001');
  }

  private async evaluateS003(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    return await evaluateS003ThirdPartyLicenses(repoPath, evaluationRun);
  }

  private async evaluateS002(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = evaluationRun ?? createEvaluationRun({
      repositoryPath: repoPath,
      language: this.language,
      criteriaFilter: ['S002']
    });
    const artifact = await run.getOrCreateArtifact('moduleDescriptor', () => produceModuleDescriptorArtifact(repoPath, run));

    if (artifact.status !== 'produced' && artifact.status !== 'discovered') {
      return this.artifactFailureResult(artifact);
    }

    if (!artifact.absolutePath || !artifact.descriptorPath) {
      return {
        criterionId: 'S002',
        status: EvaluationStatus.FAIL,
        evidence: 'Module descriptor artifact did not include a selected descriptor path',
        details: this.formatArtifactDetails(artifact)
      };
    }

    let descriptorContent: string;
    try {
      descriptorContent = fs.readFileSync(artifact.absolutePath, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        criterionId: 'S002',
        status: EvaluationStatus.FAIL,
        evidence: `Unable to read module descriptor ${artifact.descriptorPath}`,
        details: `${this.formatArtifactDetails(artifact)}\n\nRead error: ${message}`
      };
    }

    const validation = validateModuleDescriptorJson(descriptorContent);
    const evidence = validation.valid
      ? `Module descriptor ${artifact.descriptorPath} validates against Okapi schema baseline ${validation.schemaBaseline}`
      : `Module descriptor ${artifact.descriptorPath} does not validate against Okapi schema baseline ${validation.schemaBaseline}`;

    if (validation.valid) {
      return {
        criterionId: 'S002',
        status: EvaluationStatus.PASS,
        evidence,
        details: this.formatArtifactDetails(artifact)
      };
    }

    const validationDetails = validation.parseError
      ? `Parse error: ${validation.parseError}`
      : validation.errors
          .map(error => `${error.instancePath || '/'} ${error.keyword} ${error.message} (${error.schemaPath})`)
          .join('\n');

    return {
      criterionId: 'S002',
      status: EvaluationStatus.FAIL,
      evidence,
      details: `${this.formatArtifactDetails(artifact)}\n\nValidation errors:\n${validationDetails}`
    };
  }

  private async evaluateS004(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = evaluationRun ?? createEvaluationRun({
      repositoryPath: repoPath,
      language: this.language,
      criteriaFilter: ['S004']
    });

    const moduleKind = await run.getOrCreateArtifact('moduleKind', () => Promise.resolve(classifyModuleKind(repoPath)));
    if (moduleKind.kind === 'library') {
      return {
        criterionId: 'S004',
        status: EvaluationStatus.NOT_APPLICABLE,
        evidence: 'S004 does not apply to explicit FOLIO library repositories',
        details: [
          'Repository kind: library',
          'Evidence:',
          ...moduleKind.evidence.map(evidence => `  - ${evidence}`),
          ...(moduleKind.warnings.length ? ['Warnings:', ...moduleKind.warnings.map(warning => `  - ${warning}`)] : [])
        ].join('\n')
      };
    }

    const documentation = analyzeS004Documentation(repoPath);
    documentation.warnings.push(...moduleKind.warnings);
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'S004',
      status: documentation.classification.status,
      hasReviewMaterial: documentation.candidates.length > 0,
      evaluationRun: run,
      review: (config, commandRunner) => reviewS004WithAgent(repoPath, documentation, config, commandRunner)
    });
    if (unavailableReason) {
      documentation.agentReviewUnavailableReason = unavailableReason;
    }

    const rendered = formatS004Evidence(documentation, agentReview);
    return {
      criterionId: 'S004',
      status: documentation.classification.status,
      evidence: rendered.evidence,
      details: rendered.details,
      criterionDetails: documentation,
      agentReview
    };
  }

  private async evaluateS005(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = evaluationRun ?? createEvaluationRun({
      repositoryPath: repoPath,
      language: this.language,
      criteriaFilter: ['S005']
    });

    const moduleKind = await run.getOrCreateArtifact('moduleKind', () => Promise.resolve(classifyModuleKind(repoPath)));
    if (moduleKind.kind === 'library') {
      return {
        criterionId: 'S005',
        status: EvaluationStatus.NOT_APPLICABLE,
        evidence: 'S005 does not apply to explicit FOLIO library repositories',
        details: this.formatModuleKindDetails('Repository kind: library', moduleKind),
        criterionDetails: {
          moduleKind
        }
      };
    }

    const analysis = analyzeS005PersonalDataDisclosure(repoPath);
    analysis.warnings.push(...moduleKind.warnings);
    analysis.classification.warnings.push(...moduleKind.warnings);
    if (analysis.classification.status === EvaluationStatus.MANUAL) {
      analysis.agentReviewUnavailableReason = S005_AGENT_NOT_APPLIED_REASON;
    }

    const rendered = this.formatS005Evidence(analysis, moduleKind);
    return {
      criterionId: 'S005',
      status: analysis.classification.status,
      evidence: rendered.evidence,
      details: rendered.details,
      criterionDetails: analysis
    };
  }

  private artifactFailureResult(artifact: ModuleDescriptorArtifact): CriterionResult {
    const uncertainStatuses = new Set<ModuleDescriptorArtifact['status']>([
      'ambiguous-candidates',
      'unsafe-to-run',
      'command-failed'
    ]);

    return {
      criterionId: 'S002',
      status: uncertainStatuses.has(artifact.status) ? EvaluationStatus.MANUAL : EvaluationStatus.FAIL,
      evidence: `Module descriptor artifact stage returned ${artifact.status}`,
      details: this.formatArtifactDetails(artifact)
    };
  }

  private formatArtifactDetails(artifact: ModuleDescriptorArtifact): string {
    const lines = [
      `Artifact status: ${artifact.status}`,
      artifact.strategy ? `Strategy: ${artifact.strategy}` : undefined,
      artifact.descriptorPath ? `Descriptor path: ${artifact.descriptorPath}` : undefined,
      artifact.command ? `Command: ${artifact.command.command} ${artifact.command.args.join(' ')} (${artifact.command.status})` : undefined,
      artifact.command ? `Command execution environment: ${artifact.command.commandExecutionEnvironment}` : undefined,
      artifact.warnings.length ? `Warnings:\n${artifact.warnings.map(warning => `  - ${warning}`).join('\n')}` : undefined,
      artifact.errors.length ? `Errors:\n${artifact.errors.map(error => `  - ${error}`).join('\n')}` : undefined
    ];

    return lines.filter((line): line is string => Boolean(line)).join('\n');
  }

  private formatModuleKindDetails(heading: string, moduleKind: ModuleKindResult): string {
    return [
      heading,
      'Module-kind evidence:',
      ...moduleKind.evidence.map(evidence => `  - ${evidence}`),
      ...(moduleKind.warnings.length ? ['Warnings:', ...moduleKind.warnings.map(warning => `  - ${warning}`)] : [])
    ].join('\n');
  }

  private formatS005Evidence(
    analysis: S005PersonalDataDisclosureAnalysisResult,
    moduleKind: ModuleKindResult
  ): { evidence: string; details: string } {
    const evidence = analysis.classification.status === EvaluationStatus.FAIL
      ? analysis.classification.reason
      : 'Completed S005 personal data disclosure form requires reviewer judgment';

    const parseResult = analysis.parseResult;
    const evidenceScan = analysis.evidenceScan;
    const lines = [
      `Status: ${analysis.classification.status}`,
      `Reason: ${analysis.classification.reason}`,
      `Parse state: ${analysis.classification.parseState}`,
      `Repository kind: ${moduleKind.kind}`,
      'Module-kind evidence:',
      ...moduleKind.evidence.map(item => `  - ${item}`),
      `Disclosure artifact: ${analysis.discovery.artifact?.path ?? analysis.discovery.status}`,
      analysis.discovery.readError ? `Read error: ${analysis.discovery.readError}` : undefined,
      analysis.discovery.attempts.length
        ? `Attempted disclosure files:\n${analysis.discovery.attempts.map(attempt => `  - ${attempt.path} (${attempt.reason})`).join('\n')}`
        : undefined,
      parseResult?.metadata.versionText ? `Form version: ${parseResult.metadata.versionText}` : undefined,
      parseResult ? `Checked categories: ${parseResult.checkedCategories.join(', ') || 'none'}` : undefined,
      parseResult ? `Unchecked categories: ${parseResult.uncheckedCategories.join(', ') || 'none'}` : undefined,
      analysis.placeholders.length
        ? `Placeholders:\n${analysis.placeholders.map(placeholder => `  - ${placeholder.field} at line ${placeholder.lineNumber}: ${placeholder.placeholderText}`).join('\n')}`
        : undefined,
      analysis.contradictions.length
        ? `Contradictions:\n${analysis.contradictions.map(contradiction => `  - ${contradiction.message}`).join('\n')}`
        : undefined,
      analysis.possibleMismatches.length
        ? `Possible mismatches:\n${analysis.possibleMismatches.map(mismatch => `  - ${mismatch.kind}${mismatch.category ? `/${mismatch.category}` : ''}: ${mismatch.message}`).join('\n')}`
        : undefined,
      analysis.matchingEvidence.length
        ? `Matching evidence:\n${analysis.matchingEvidence.map(match => `  - ${match.category ?? 'unknown'}: ${match.message}`).join('\n')}`
        : undefined,
      analysis.supportingEvidence.length
        ? `Supporting evidence:\n${analysis.supportingEvidence.map(support => `  - ${support.category ?? 'unknown'}: ${support.message}`).join('\n')}`
        : undefined,
      evidenceScan ? `Evidence signals: ${evidenceScan.signals.length}` : undefined,
      evidenceScan?.signals.length
        ? `Signal samples:\n${evidenceScan.signals.slice(0, 8).map(signal => `  - ${signal.path}${signal.line ? `:${signal.line}` : ''} [${signal.sourceClass}/${signal.strength}/${signal.category}] ${signal.excerpt}`).join('\n')}`
        : undefined,
      analysis.agentReviewUnavailableReason ? `Agent review: ${analysis.agentReviewUnavailableReason}` : undefined,
      analysis.warnings.length ? `Warnings:\n${analysis.warnings.map(warning => `  - ${warning}`).join('\n')}` : undefined
    ];

    return {
      evidence,
      details: lines.filter((line): line is string => Boolean(line)).join('\n')
    };
  }
}
