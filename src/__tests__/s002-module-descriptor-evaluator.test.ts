import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JavaSharedEvaluator } from '../evaluators/java/java-shared-evaluator';
import { EvaluationStatus, ModuleDescriptorArtifact } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 's002-module-descriptor-'));
}

function artifact(repo: string, descriptor: object): ModuleDescriptorArtifact {
  const descriptorPath = path.join(repo, 'ModuleDescriptor.json');
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
  return {
    status: 'discovered',
    strategy: 'static-root',
    descriptorPath: 'ModuleDescriptor.json',
    absolutePath: descriptorPath,
    warnings: [],
    errors: []
  };
}

describe('S002 module descriptor evaluator', () => {
  beforeEach(() => {
    setLogger(new NoopLogger());
  });

  afterEach(() => {
    resetLogger();
  });

  it('should pass for a staged valid static descriptor', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    run.artifacts.moduleDescriptor = artifact(repo, { id: 'mod-example-1.0.0' });
    const evaluator = new JavaSharedEvaluator();

    const result = await evaluator.evaluateCriterion('S002', repo, run);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect(result.evidence).toContain('validates against Okapi schema baseline');
    expect(result.details).toContain('Strategy: static-root');
  });

  it('should fail for schema-invalid descriptors with validation details', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    run.artifacts.moduleDescriptor = artifact(repo, { name: 'missing id' });
    const evaluator = new JavaSharedEvaluator();

    const result = await evaluator.evaluateCriterion('S002', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.details).toContain('Validation errors');
    expect(result.details).toContain('required');
  });

  it('should not pass when the artifact stage rejected templates', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    run.artifacts.moduleDescriptor = {
      status: 'invalid-candidate',
      warnings: [],
      errors: ['Only descriptor templates were found']
    };
    const evaluator = new JavaSharedEvaluator();

    const result = await evaluator.evaluateCriterion('S002', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toContain('invalid-candidate');
  });

  it('should reuse the same lazy artifact slot for repeated direct evaluation', async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, 'ModuleDescriptor.json'), JSON.stringify({ id: 'mod-example-1.0.0' }));
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    const originalGetOrCreate = run.getOrCreateArtifact.bind(run);
    const getOrCreateSpy = jest.fn(originalGetOrCreate);
    run.getOrCreateArtifact = getOrCreateSpy;
    const evaluator = new JavaSharedEvaluator();

    const first = await evaluator.evaluateCriterion('S002', repo, run);
    const second = await evaluator.evaluateCriterion('S002', repo, run);

    expect(first.status).toBe(EvaluationStatus.PASS);
    expect(second.status).toBe(EvaluationStatus.PASS);
    expect(getOrCreateSpy).toHaveBeenCalledTimes(2);
    expect(run.artifacts.moduleDescriptor?.descriptorPath).toBe('ModuleDescriptor.json');
  });

  it('should fail with artifact context when selected descriptor cannot be read', async () => {
    const repo = tempRepo();
    const run = createEvaluationRun({ repositoryPath: repo, language: 'java', criteriaFilter: ['S002'] });
    run.artifacts.moduleDescriptor = {
      status: 'discovered',
      strategy: 'static-root',
      descriptorPath: 'ModuleDescriptor.json',
      absolutePath: path.join(repo, 'ModuleDescriptor.json'),
      warnings: [],
      errors: []
    };
    const evaluator = new JavaSharedEvaluator();

    const result = await evaluator.evaluateCriterion('S002', repo, run);

    expect(result.status).toBe(EvaluationStatus.FAIL);
    expect(result.evidence).toContain('Unable to read module descriptor');
    expect(result.details).toContain('Artifact status: discovered');
    expect(result.details).toContain('Read error:');
  });
});
