import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReportGenerator } from '../utils/report-generator';
import { EvaluationResult } from '../types';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';

describe('ReportGenerator', () => {
  const result: EvaluationResult = {
    repositoryUrl: 'https://github.com/folio-org/test-module',
    moduleName: 'test-module',
    language: 'Java',
    evaluatedAt: new Date('2026-06-03T12:00:00.000Z'),
    criteria: []
  };
  let root: string;

  beforeEach(() => {
    setLogger(new NoopLogger());
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-generator-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    resetLogger();
  });

  it('should write both report formats by default', async () => {
    const outputDir = path.join(root, 'reports');
    const paths = await new ReportGenerator(outputDir).generateReports(result);

    expect(paths.jsonPath).toMatch(/\/reports\/test-module-[^/]+\.json$/);
    expect(paths.htmlPath).toBe(paths.jsonPath!.replace(/\.json$/, '.html'));
    expect(fs.readdirSync(outputDir).sort()).toEqual([path.basename(paths.htmlPath!), path.basename(paths.jsonPath!)]);
    expect(JSON.parse(fs.readFileSync(paths.jsonPath!, 'utf8'))).toMatchObject({
      moduleName: 'test-module',
      repositoryUrl: 'https://github.com/folio-org/test-module',
      evaluatedAt: '2026-06-03T12:00:00.000Z'
    });
    const html = fs.readFileSync(paths.htmlPath!, 'utf8');
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('test-module');
  });

  it('should respect report format options', async () => {
    const defaultDir = path.join(root, 'reports');
    const customDir = path.join(root, 'custom', 'reports');

    const paths = await new ReportGenerator(defaultDir).generateReports(result, {
      outputJson: true,
      outputHtml: false,
      outputDir: customDir
    });

    expect(paths.htmlPath).toBeUndefined();
    expect(path.dirname(paths.jsonPath!)).toBe(customDir);
    expect(fs.readdirSync(customDir)).toEqual([path.basename(paths.jsonPath!)]);
    expect(JSON.parse(fs.readFileSync(paths.jsonPath!, 'utf8')).moduleName).toBe('test-module');
    expect(fs.existsSync(defaultDir)).toBe(false);
  });
});
