import { SharedEvaluator } from '../shared/shared-evaluator';

/**
 * Evaluator for Shared/Common criteria (S001-S014) for JavaScript/UI modules.
 * Extends SharedEvaluator with JavaScript-specific description overrides.
 */
export class JavaScriptSharedEvaluator extends SharedEvaluator {
  constructor() {
    super('javascript');
  }
}
