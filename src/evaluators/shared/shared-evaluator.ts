import * as fs from 'fs';
import {
  CriterionResult,
  EvaluationRun,
  EvaluationStatus,
  ModuleDescriptorArtifact,
  ModuleKindResult
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
import {
  analyzeS005PersonalDataDisclosure,
  buildS005CriterionDetails,
  formatS005Evidence
} from '../../utils/s005-personal-data-disclosure';
import { hasS005AgentReviewMaterial, reviewS005WithAgent } from '../../utils/s005-agent-review';
import {
  analyzeS006SensitiveInformation,
  buildS006CriterionDetails,
  formatS006Evidence
} from '../../utils/s006-sensitive-information';
import { hasS006AgentReviewMaterial, reviewS006WithAgent } from '../../utils/s006-agent-review';

/**
 * Abstract base class for Shared/Common criteria (S001-S014). Handled criterion
 * IDs and their fallback results are derived from the acceptance-criterion catalog
 * by CatalogSectionEvaluator. Automated criteria are supplied as handler overrides
 * to super(); every other criterion falls back to the catalog-defined default result
 * for the given language.
 */
export abstract class SharedEvaluator extends CatalogSectionEvaluator {
  constructor(language: CriterionLanguage = 'java') {
    super('Shared/Common', language, {
      S001: async (repoPath: string) => this.evaluateS001(repoPath),
      S002: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS002(repoPath, evaluationRun),
      S003: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS003(repoPath, evaluationRun),
      S004: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS004(repoPath, evaluationRun),
      S005: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS005(repoPath, evaluationRun),
      S006: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS006(repoPath, evaluationRun)
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
        details: this.formatModuleKindDetails('Repository kind: library', moduleKind)
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
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'S005',
      status: analysis.classification.status,
      hasReviewMaterial: hasS005AgentReviewMaterial(analysis),
      evaluationRun: run,
      review: (config, commandRunner) => reviewS005WithAgent(repoPath, analysis, config, commandRunner)
    });
    if (unavailableReason) {
      analysis.agentReviewUnavailableReason = unavailableReason;
    }

    const rendered = formatS005Evidence(analysis, moduleKind, agentReview);
    return {
      criterionId: 'S005',
      status: analysis.classification.status,
      evidence: rendered.evidence,
      details: rendered.details,
      criterionDetails: buildS005CriterionDetails(analysis),
      agentReview
    };
  }

  private async evaluateS006(repoPath: string, evaluationRun?: EvaluationRun): Promise<CriterionResult> {
    const run = evaluationRun ?? createEvaluationRun({
        repositoryPath: repoPath,
        language: this.language,
        criteriaFilter: ['S006']
      });

    const analysis = analyzeS006SensitiveInformation(repoPath);
    const { agentReview, unavailableReason } = await reviewCriterionWithAgent({
      criterionId: 'S006',
      status: analysis.classification.status,
      hasReviewMaterial: hasS006AgentReviewMaterial(analysis),
      evaluationRun: run,
      review: (config, commandRunner) => reviewS006WithAgent(repoPath, analysis, config, commandRunner)
    });
    if (unavailableReason) {
      analysis.agentReviewUnavailableReason = unavailableReason;
    }

    const rendered = formatS006Evidence(analysis, agentReview);
    return {
      criterionId: 'S006',
      status: analysis.classification.status,
      evidence: rendered.evidence,
      details: rendered.details,
      criterionDetails: buildS006CriterionDetails(analysis),
      agentReview
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
}
