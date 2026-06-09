import * as fs from 'fs';
import { CriterionResult, EvaluationRun, EvaluationStatus, ModuleDescriptorArtifact } from '../../types';
import { CriterionLanguage } from '../../criteria-definitions';
import { CatalogSectionEvaluator } from '../base/catalog-section-evaluator';
import { LicenseUtils } from '../../utils/license-utils';
import { evaluateS003ThirdPartyLicenses } from '../../utils/license-compliance-evaluator';
import { produceModuleDescriptorArtifact } from '../../utils/artifacts/module-descriptor-artifact';
import { createEvaluationRun } from '../../utils/evaluation-run';
import { validateModuleDescriptorJson } from '../../utils/module-descriptor-validator';

/**
 * Abstract base class for Shared/Common criteria (S001-S014). Handled criterion
 * IDs and their fallback results are derived from the acceptance-criterion catalog
 * by CatalogSectionEvaluator. Automated criteria are supplied as handler overrides
 * to super() (here S001 and S003); every other criterion falls back to the
 * catalog-defined default result for the given language.
 */
export abstract class SharedEvaluator extends CatalogSectionEvaluator {
  constructor(language: CriterionLanguage = 'java') {
    super('Shared/Common', language, {
      S001: async (repoPath: string) => this.evaluateS001(repoPath),
      S002: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS002(repoPath, evaluationRun),
      S003: async (repoPath: string, evaluationRun?: EvaluationRun) => this.evaluateS003(repoPath, evaluationRun)
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
}
