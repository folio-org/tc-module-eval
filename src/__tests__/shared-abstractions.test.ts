import { CriterionResult, EvaluationStatus, SectionEvaluator, CriterionFunction } from '../types';
import { SharedEvaluator } from '../evaluators/shared/shared-evaluator';
import { CompositeLanguageEvaluator } from '../evaluators/base/composite-language-evaluator';
import { BaseSectionEvaluator } from '../evaluators/base/section-evaluator';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';

// Mock fs-extra (needed by SharedEvaluator -> LicenseUtils)
jest.mock('fs-extra', () => ({
  pathExists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn().mockResolvedValue('')
}));

// Concrete subclass for testing SharedEvaluator
class TestSharedEvaluator extends SharedEvaluator {}

// Concrete subclass that overrides a handler
class OverriddenSharedEvaluator extends SharedEvaluator {
  constructor() {
    super();
    this.criterionHandlers.set('S002', this.customS002.bind(this));
  }

  private async customS002(_repoPath: string): Promise<CriterionResult> {
    return this.createResult('S002', EvaluationStatus.PASS, 'Custom override works');
  }
}

// Stub section evaluator for CompositeLanguageEvaluator tests
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

// Concrete CompositeLanguageEvaluator for testing
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
      'X002': async () => { throw new Error('Handler exploded'); },
      'X003': async () => ({ criterionId: 'X003', status: EvaluationStatus.PASS, evidence: 'ok' }),
    });

    const results = await evaluator.evaluate('/fake/path');

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe(EvaluationStatus.PASS);
    // The throwing handler should produce a MANUAL error result
    expect(results[1].criterionId).toBe('X002');
    expect(results[1].status).toBe(EvaluationStatus.MANUAL);
    expect(results[1].evidence).toContain('Handler exploded');
    // Evaluation continues after the error
    expect(results[2].status).toBe(EvaluationStatus.PASS);
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

    // Create a section that throws during evaluate()
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
