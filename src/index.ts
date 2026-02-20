// Main exports for the FOLIO Module Evaluator
export { ModuleEvaluator } from './module-evaluator';
export { ReportGenerator } from './utils/report-generator';
export { GitUtils } from './utils/git';
export { evaluateS003ThirdPartyLicenses } from './utils/license-compliance-evaluator';
export { Logger, ConsoleLogger, NoopLogger, getLogger, setLogger, resetLogger } from './utils/logger';

// Language-specific evaluators
export { JavaEvaluator } from './evaluators/java-evaluator';
export { JavaScriptEvaluator } from './evaluators/javascript-evaluator';

// Section-based evaluator framework classes
export { SharedEvaluator } from './evaluators/shared/shared-evaluator';
export { AdministrativeEvaluator } from './evaluators/shared/administrative-evaluator';
export { JavaSharedEvaluator } from './evaluators/java/java-shared-evaluator';
export { JavaScriptSharedEvaluator } from './evaluators/javascript/javascript-shared-evaluator';
export { BackendEvaluator } from './evaluators/java/backend-evaluator';
export { FrontendEvaluator } from './evaluators/javascript/frontend-evaluator';
export { BaseSectionEvaluator } from './evaluators/base/section-evaluator';
export { CompositeLanguageEvaluator } from './evaluators/base/composite-language-evaluator';

// Export types
export {
  EvaluationStatus,
  Criterion,
  CriterionResult,
  EvaluationResult,
  EvaluationConfig,
  LanguageEvaluator,
  SectionEvaluator,
  CriterionFunction,
  ReportOptions
} from './types';
