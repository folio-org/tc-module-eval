import { CriterionResult, EvaluationStatus, SectionEvaluator, CriterionFunction, ModuleKindResult } from '../types';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { JavaScriptSharedEvaluator } from '../evaluators/javascript/javascript-shared-evaluator';
import { CompositeLanguageEvaluator } from '../evaluators/base/composite-language-evaluator';
import { BaseSectionEvaluator } from '../evaluators/base/section-evaluator';
import { CatalogSectionEvaluator } from '../evaluators/base/catalog-section-evaluator';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';
import { createEvaluationRun } from '../utils/evaluation-run';
import { EVALUATOR_SECRETS, withEvaluatorSecrets } from './helpers/evaluator-secrets';

// Mock fs-extra (needed by SharedEvaluator criteria)
jest.mock('fs-extra', () => ({
  pathExists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn().mockResolvedValue('')
}));

class TestSharedEvaluator extends SharedEvaluator {}

class OverriddenSharedEvaluator extends SharedEvaluator {
  constructor() {
    super();
    this.criterionHandlers.set('S002', this.customS002.bind(this));
  }

  private async customS002(_repoPath: string): Promise<CriterionResult> {
    return this.createResult('S002', EvaluationStatus.PASS, 'Custom override works');
  }
}

class StubSectionEvaluator extends BaseSectionEvaluator {
  readonly sectionName: string;

  constructor(name: string, criteria: Record<string, CriterionFunction>) {
    super();
    this.sectionName = name;
    for (const [id, fn] of Object.entries(criteria)) {
      this.criterionHandlers.set(id, fn);
    }
  }
}

class TestCompositeEvaluator extends CompositeLanguageEvaluator {
  private sections: SectionEvaluator[];

  constructor(sections: SectionEvaluator[]) {
    super();
    this.sections = sections;
  }

  protected getSectionEvaluators(): SectionEvaluator[] {
    return this.sections;
  }

  async canEvaluate(_repoPath: string): Promise<boolean> {
    return true;
  }

  getLanguage(): string {
    return 'TestLang';
  }
}

describe('SharedEvaluator', () => {
  beforeEach(() => {
    setLogger(new NoopLogger());
  });

  afterEach(() => {
    resetLogger();
  });

  it('should return S001-S014 in canonical order', () => {
    const evaluator = new TestSharedEvaluator();
    const ids = evaluator.criteriaIds;

    expect(ids).toEqual([
      'S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007',
      'S008', 'S009', 'S010', 'S011', 'S012', 'S013', 'S014'
    ]);
  });

  it('should preserve ordering when a subclass overrides a handler', () => {
    const evaluator = new OverriddenSharedEvaluator();
    const ids = evaluator.criteriaIds;

    // S002 should still be in position 1 (0-indexed), not moved to end
    expect(ids).toEqual([
      'S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007',
      'S008', 'S009', 'S010', 'S011', 'S012', 'S013', 'S014'
    ]);
  });

  it('should use the overridden handler implementation', async () => {
    const evaluator = new OverriddenSharedEvaluator();
    const result = await evaluator.evaluateCriterion('S002', '/fake/path');

    expect(result.criterionId).toBe('S002');
    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toBe('Custom override works');
  });

  it('should automate JavaScript S002 through descriptor artifact evidence', async () => {
    const evaluator = new JavaScriptSharedEvaluator();
    const result = await evaluator.evaluateCriterion('S002', '/fake/path');

    expect(result.criterionId).toBe('S002');
    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(result.evidence).toBe('The evaluator could not safely look for the module descriptor. The repository path is not valid: /fake/path. A reviewer needs to check it by hand.');
  });
});

describe('EvaluationRun', () => {
  it('should cache lazy artifacts in one run slot', async () => {
    const run = createEvaluationRun({
      repositoryPath: '/repo',
      language: 'java',
      criteriaFilter: ['S002']
    });
    const producer = jest.fn().mockResolvedValue({
      status: 'missing',
      warnings: [],
      errors: ['not found']
    });

    // Concurrent callers share the in-flight producer rather than each starting one.
    const [first, second] = await Promise.all([
      run.getOrCreateArtifact('moduleDescriptor', producer),
      run.getOrCreateArtifact('moduleDescriptor', producer)
    ]);
    const third = await run.getOrCreateArtifact('moduleDescriptor', producer);

    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(run.artifacts.moduleDescriptor).toBe(first);
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('should retry an artifact whose producer failed', async () => {
    const run = createEvaluationRun({ repositoryPath: '/repo', language: 'java' });
    const moduleKind: ModuleKindResult = { kind: 'library', evidence: [], warnings: [] };
    const producer = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(moduleKind);

    const failed = await Promise.allSettled([
      run.getOrCreateArtifact('moduleKind', producer),
      run.getOrCreateArtifact('moduleKind', producer)
    ]);

    expect(failed.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(run.artifacts.moduleKind).toBeUndefined();
    await expect(run.getOrCreateArtifact('moduleKind', producer)).resolves.toBe(moduleKind);
    expect(producer).toHaveBeenCalledTimes(2);
  });
});

describe('BaseSectionEvaluator', () => {
  beforeEach(() => {
    setLogger(new NoopLogger());
  });

  afterEach(() => {
    resetLogger();
  });

  it('should filter criteria when criteriaFilter is provided', async () => {
    const evaluator = new StubSectionEvaluator('Test', {
      'X001': async () => ({ criterionId: 'X001', status: EvaluationStatus.PASS, evidence: 'ok' }),
      'X002': async () => ({ criterionId: 'X002', status: EvaluationStatus.PASS, evidence: 'ok' }),
      'X003': async () => ({ criterionId: 'X003', status: EvaluationStatus.PASS, evidence: 'ok' }),
    });

    const results = await evaluator.evaluate('/fake/path', ['X001', 'X003']);

    expect(results).toHaveLength(2);
    expect(results[0].criterionId).toBe('X001');
    expect(results[1].criterionId).toBe('X003');
  });

  it('should return empty results when criteriaFilter matches nothing', async () => {
    const evaluator = new StubSectionEvaluator('Test', {
      'X001': async () => ({ criterionId: 'X001', status: EvaluationStatus.PASS, evidence: 'ok' }),
    });

    const results = await evaluator.evaluate('/fake/path', ['Z999']);

    expect(results).toHaveLength(0);
  });

  it('should throw when evaluateCriterion is called with unknown criterion ID', async () => {
    const evaluator = new StubSectionEvaluator('Test', {
      'X001': async () => ({ criterionId: 'X001', status: EvaluationStatus.PASS, evidence: 'ok' }),
    });

    await expect(evaluator.evaluateCriterion('UNKNOWN', '/fake/path'))
      .rejects.toThrow('Criterion UNKNOWN is not handled by Test evaluator');
  });

  it('should return MANUAL result when an individual handler throws during evaluate', async () => {
    const evaluator = new StubSectionEvaluator('Test', {
      'X001': async () => ({ criterionId: 'X001', status: EvaluationStatus.PASS, evidence: 'ok' }),
      'X002': async () => { throw new Error(`Handler exploded at http://localhost:8080/health with ${EVALUATOR_SECRETS.SONAR_TOKEN}`); },
      'X003': async () => ({ criterionId: 'X003', status: EvaluationStatus.PASS, evidence: 'ok' }),
    });

    const results = await withEvaluatorSecrets(() => evaluator.evaluate('/fake/path'));

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe(EvaluationStatus.PASS);
    expect(results[1].criterionId).toBe('X002');
    expect(results[1].status).toBe(EvaluationStatus.MANUAL);
    expect(results[1].evidence).toBe('Evaluation failed: Handler exploded at http://localhost:8080/health with [REDACTED_SONAR_TOKEN]');
    expect(results[2].status).toBe(EvaluationStatus.PASS);
  });

  it('should overlap agent reviews but keep deterministic work sequential and results in order', async () => {
    const run = createEvaluationRun({ repositoryPath: '/repo', language: 'java' });
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    let deterministic = 0;
    let maxDeterministic = 0;
    let reviews = 0;
    let maxReviews = 0;
    const finished: string[] = [];
    // Earlier criteria review longest, so reviews finish in reverse order.
    const criterion = (id: string, reviewMs?: number, failure?: 'analysis' | 'review'): CriterionFunction => async (_repoPath, evaluationRun) => {
      deterministic++;
      maxDeterministic = Math.max(maxDeterministic, deterministic);
      await delay(5);
      deterministic--;
      if (failure === 'analysis') throw new Error(`${id} analysis failed`);
      if (reviewMs === undefined) return { criterionId: id, status: EvaluationStatus.PASS, evidence: `${id} done` };
      const review = await evaluationRun!.runAgentReview(async () => {
        reviews++;
        maxReviews = Math.max(maxReviews, reviews);
        await delay(reviewMs);
        reviews--;
        if (failure === 'review') throw new Error(`${id} review failed`);
        return `${id} reviewed`;
      });
      finished.push(id);
      return { criterionId: id, status: EvaluationStatus.MANUAL, evidence: review };
    };
    const evaluator = new StubSectionEvaluator('Test', {
      X001: criterion('X001', 120),
      X002: criterion('X002', undefined, 'analysis'),
      X003: criterion('X003', 100),
      X004: criterion('X004', 80, 'review'),
      X005: criterion('X005', 60),
      X006: criterion('X006'),
      X007: criterion('X007', 20)
    });

    const results = await evaluator.evaluate('/repo', undefined, run);

    expect(results.map(result => [result.criterionId, result.evidence])).toEqual([
      ['X001', 'X001 reviewed'],
      ['X002', 'Evaluation failed: X002 analysis failed'],
      ['X003', 'X003 reviewed'],
      ['X004', 'Evaluation failed: X004 review failed'],
      ['X005', 'X005 reviewed'],
      ['X006', 'X006 done'],
      ['X007', 'X007 reviewed']
    ]);
    expect(maxDeterministic).toBe(1);
    expect(maxReviews).toBe(3);
    expect(finished[0]).not.toBe('X001');
  });
});

describe('CatalogSectionEvaluator', () => {
  it('should fail fast when a catalog criterion has neither fallback nor override', () => {
    class MissingOverrideEvaluator extends CatalogSectionEvaluator {
      constructor() {
        super('Shared/Common', 'java');
      }
    }

    expect(() => new MissingOverrideEvaluator()).toThrow(
      'No default evaluation or handler registered for criterion: S001'
    );
  });
});

describe('CompositeLanguageEvaluator', () => {
  beforeEach(() => {
    setLogger(new NoopLogger());
  });

  afterEach(() => {
    resetLogger();
  });

  it('should collect results from all section evaluators in order', async () => {
    const section1 = new StubSectionEvaluator('Section1', {
      'X001': async () => ({ criterionId: 'X001', status: EvaluationStatus.PASS, evidence: 'ok' }),
      'X002': async () => ({ criterionId: 'X002', status: EvaluationStatus.MANUAL, evidence: 'manual' }),
    });

    const section2 = new StubSectionEvaluator('Section2', {
      'Y001': async () => ({ criterionId: 'Y001', status: EvaluationStatus.FAIL, evidence: 'fail' }),
    });

    const evaluator = new TestCompositeEvaluator([section1, section2]);
    const results = await evaluator.evaluate('/fake/path');

    expect(results).toHaveLength(3);
    expect(results[0].criterionId).toBe('X001');
    expect(results[1].criterionId).toBe('X002');
    expect(results[2].criterionId).toBe('Y001');
  });

  it('should return partial results if a section evaluator throws', async () => {
    const section1 = new StubSectionEvaluator('Section1', {
      'X001': async () => ({ criterionId: 'X001', status: EvaluationStatus.PASS, evidence: 'ok' }),
    });

    const throwingSection: SectionEvaluator = {
      sectionName: 'Broken',
      criteriaIds: ['Z001'],
      evaluate: async () => { throw new Error('Section exploded'); },
      evaluateCriterion: async () => { throw new Error('Section exploded'); },
    };

    const section3 = new StubSectionEvaluator('Section3', {
      'Y001': async () => ({ criterionId: 'Y001', status: EvaluationStatus.PASS, evidence: 'ok' }),
    });

    const evaluator = new TestCompositeEvaluator([section1, throwingSection, section3]);
    const results = await evaluator.evaluate('/fake/path');

    // Should have results from section1 only; throwingSection aborts the loop
    expect(results).toHaveLength(1);
    expect(results[0].criterionId).toBe('X001');
  });
});
