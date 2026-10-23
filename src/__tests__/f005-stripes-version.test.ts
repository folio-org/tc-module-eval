import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { JavaScriptEvaluator } from '../evaluators/javascript-evaluator';
import { FrontendEvaluator } from '../evaluators/javascript/frontend-evaluator';
import { CriterionResult, EvaluationStatus, F005Analysis, S007AnalysisResult } from '../types';
import { createEvaluationRun } from '../utils/evaluation-run';
import * as S007Policy from '../utils/s007-policy';

describe('F005 Stripes version', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'f005-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(repoPath);
  });

  it.each([
    // Without a lockfile the range ^10.0.0 also allows 10.0.x, below the required 10.1.
    ['without a lockfile, ^10.0.0 needs review', undefined, EvaluationStatus.MANUAL],
    // The lockfile shows the version actually used, so the same range passes.
    ['with a lockfile resolving 10.1.5, ^10.0.0 passes', '10.1.5', EvaluationStatus.PASS],
    ['with a lockfile resolving 10.0.3, ^10.0.0 fails', '10.0.3', EvaluationStatus.FAIL]
  ])('%s', async (_name, lockedVersion, expected) => {
    await writeJson('package.json', { name: '@folio/example', stripes: { actsAs: ['app'] }, devDependencies: { '@folio/stripes': '^10.0.0' } });
    if (lockedVersion) await write('yarn.lock', `"@folio/stripes@^10.0.0":\n  version "${lockedVersion}"\n`);

    const result = await new FrontendEvaluator().evaluateCriterion('F005', repoPath);
    const analysis = result.criterionDetails as F005Analysis;

    expect(result.status).toBe(expected);
    expect(analysis.basis).toBe('s007-finding');
    expect(result.evidence).toMatch(new RegExp(`^F005 ${expected}: Stripes is declared as devDependencies\\.@folio/stripes \\^10\\.0\\.0 in package\\.json`));
    expect(result.evidence).toMatch(/\(Same finding as S007\.\)$/);
    if (lockedVersion) {
      expect(result.evidence).toContain(`resolved to ${lockedVersion} in yarn.lock`);
    }
    if (expected === EvaluationStatus.PASS) {
      expect(analysis.checklist.items).toEqual([]);
      expect(result.details).not.toContain('Checklist for the reviewer:');
    } else {
      expect(analysis.checklist.items).toEqual([expect.objectContaining({
        id: 'F005-C1',
        title: 'The module works with Stripes 10.1 or greater (lower bound ^10.1.0).',
        startingPoints: [{ path: 'package.json', note: `devDependencies.@folio/stripes ^10.0.0${lockedVersion ? `, resolved to ${lockedVersion} in yarn.lock` : ''}` }]
      })]);
      expect(result.details).toContain('Checklist for the reviewer:\n  - F005-C1 The module works with Stripes 10.1 or greater');
    }
  });

  it('gives the same Stripes finding as S007, not S007\'s overall status, alone or after S007', async () => {
    // React 17 fails S007 as a whole, while the Stripes finding passes.
    await writeJson('package.json', {
      name: '@folio/example',
      stripes: { actsAs: ['app'] },
      dependencies: { react: '17.0.2' },
      devDependencies: { '@folio/stripes': '^10.0.0' }
    });
    await write('yarn.lock', '"@folio/stripes@^10.0.0":\n  version "10.1.5"\n"react@17.0.2":\n  version "17.0.2"\n');
    const run = createEvaluationRun({ repositoryPath: repoPath, language: 'javascript', criteriaFilter: ['S007', 'F005'] });

    const results = await new JavaScriptEvaluator().evaluate(repoPath, ['S007', 'F005'], run);
    const s007 = byId(results, 'S007');
    const f005 = byId(results, 'F005');
    const alone = await new FrontendEvaluator().evaluateCriterion('F005', repoPath);

    expect(s007.status).toBe(EvaluationStatus.FAIL);
    const stripesFindings = (s007.criterionDetails as S007AnalysisResult).findings.filter(finding => finding.technologyId === 'stripes');
    expect(stripesFindings).toEqual([expect.objectContaining({ contribution: 'pass' })]);
    expect(f005.status).toBe(EvaluationStatus.PASS);
    expect((f005.criterionDetails as F005Analysis).stripesFindings).toEqual(stripesFindings);
    // S007's Stripes rows appear in F005 exactly as S007 writes them.
    const stripesRows = s007.details!.split('\n').filter(line => /^- Stripes:/.test(line) || /@folio\/stripes|Stripes 10\.1/.test(line));
    expect(stripesRows.length).toBeGreaterThan(0);
    for (const row of stripesRows) expect(f005.details).toContain(row);
    expect(alone).toEqual(f005);
  });

  it('leaves a Stripes constituent library to the reviewer with F005-C2', async () => {
    await writeJson('package.json', {
      name: '@folio/stripes-smart-components',
      version: '10.0.4',
      stripes: { actsAs: ['app'] },
      peerDependencies: { '@folio/stripes-components': '^13.0.0', react: '^18.2.0' },
      devDependencies: { '@folio/stripes-core': '^11.0.0' }
    });

    const result = await new FrontendEvaluator().evaluateCriterion('F005', repoPath);
    const analysis = result.criterionDetails as F005Analysis;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.basis).toBe('constituent-library');
    expect(result.evidence).toBe('F005 manual: @folio/stripes-smart-components is a Stripes library that does not depend on @folio/stripes, '
      + 'so the tool cannot tell which Stripes release it belongs to. A reviewer must check that this release is part of, '
      + 'or compatible with, Stripes 10.1 or greater.');
    expect(analysis.checklist.items).toEqual([{
      id: 'F005-C2',
      title: 'For a Stripes constituent library: this release is part of, or compatible with, Stripes 10.1 or greater.',
      startingPoints: [
        { path: 'package.json', note: 'version 10.0.4' },
        { path: 'package.json', note: 'peerDependencies.@folio/stripes-components ^13.0.0' }
      ],
      reviewerOnly: true,
      obligations: []
    }]);
    expect(result.details).toContain('Repository kind: library');
  });

  it('takes S007\'s finding for a library that does depend on @folio/stripes', async () => {
    // An empty actsAs makes this a library (PR 0), but it declares Stripes, so it is not a constituent library.
    await writeJson('package.json', {
      name: '@folio/stripes-acq-components',
      stripes: { actsAs: [''] },
      peerDependencies: { '@folio/stripes': '^10.1.0' }
    });

    const result = await new FrontendEvaluator().evaluateCriterion('F005', repoPath);

    expect(result.status).toBe(EvaluationStatus.PASS);
    expect((result.criterionDetails as F005Analysis).basis).toBe('s007-finding');
  });

  it('needs review with F005-C1 when a UI module does not declare @folio/stripes', async () => {
    await writeJson('package.json', { name: '@folio/ui-example', stripes: { actsAs: ['app'] }, dependencies: { '@folio/stripes-core': '^11.0.0' } });

    const result = await new FrontendEvaluator().evaluateCriterion('F005', repoPath);
    const analysis = result.criterionDetails as F005Analysis;

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect(analysis.basis).toBe('stripes-missing');
    expect(analysis.checklist.items.map(item => item.id)).toEqual(['F005-C1']);
    expect(result.evidence).toMatch(/^F005 manual: package\.json does not declare @folio\/stripes/);
  });

  it.each([
    ['is not valid JSON', async () => write('package.json', '{"name": "@folio/stripes-x", "dependencies": {"@folio/stripes": "^10.1.0",}}')],
    // S007 does not follow a symlink, so F005 must not read the file it points to either.
    ['is a symbolic link', async () => {
      await fs.outputFile(outside(), JSON.stringify({ name: '@folio/stripes-components', version: '99.0.0' }));
      await fs.symlink(outside(), path.join(repoPath, 'package.json'));
    }]
  ])('says package.json could not be read, not that it lacks Stripes, when it %s', async (_name, setUp) => {
    await setUp();
    try {
      const result = await new FrontendEvaluator().evaluateCriterion('F005', repoPath);
      const analysis = result.criterionDetails as F005Analysis;

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(analysis.basis).toBe('manifest-unreadable');
      expect(result.evidence).toBe('F005 manual: package.json could not be read, so the Stripes version was not checked. S007 reports the same problem.');
      expect(result.details).toContain('What the tool could not read:\n  - package.json — ');
      expect(JSON.stringify(analysis)).not.toContain('99.0.0');
    } finally {
      await fs.remove(outside());
    }
  });

  it('needs review, like S007, when the policy cannot be loaded', async () => {
    await writeJson('package.json', { name: '@folio/example', devDependencies: { '@folio/stripes': '^10.1.0' } });
    jest.spyOn(S007Policy, 'loadS007Policy').mockResolvedValue({
      ok: false, sourcePath: 'config/officially-supported-technologies.json',
      diagnostics: [{ code: 'policy_parse_error', message: 'Unexpected token' }]
    });

    const result = await new FrontendEvaluator().evaluateCriterion('F005', repoPath);

    expect(result.status).toBe(EvaluationStatus.MANUAL);
    expect((result.criterionDetails as F005Analysis).basis).toBe('policy-unavailable');
    expect(result.details).toContain('Problems with the officially supported technologies list:\n  - Unexpected token');
  });

  function outside(): string {
    return `${repoPath}-outside-package.json`;
  }

  function byId(results: CriterionResult[], id: string): CriterionResult {
    return results.find(result => result.criterionId === id)!;
  }

  async function write(relativePath: string, content: string): Promise<void> {
    await fs.outputFile(path.join(repoPath, relativePath), content);
  }

  async function writeJson(relativePath: string, value: unknown): Promise<void> {
    await fs.writeJson(path.join(repoPath, relativePath), value, { spaces: 2 });
  }
});
