import { SharedEvaluator } from '../shared/shared-evaluator';

/**
 * Evaluator for Shared/Common criteria (S001-S014) for JavaScript/UI modules.
 * Selects the 'javascript' catalog language so JS-specific fallback text
 * (languageReasons) is applied; it adds no per-criterion logic of its own.
 */
export class JavaScriptSharedEvaluator extends SharedEvaluator {
  constructor() {
    super('javascript');
  }
}
