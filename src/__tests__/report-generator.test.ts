import * as fs from 'fs-extra';
import { ReportGenerator } from '../utils/report-generator';
import { ReportRenderer } from '../utils/report-renderer';
import { EvaluationResult } from '../types';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';

jest.mock('fs-extra', () => ({
  ensureDir: jest.fn(),
  writeFile: jest.fn()
}));

describe('ReportGenerator', () => {
  const result: EvaluationResult = {
    repositoryUrl: 'https://github.com/folio-org/test-module',
    moduleName: 'test-module',
    language: 'Java',
    evaluatedAt: new Date('2026-06-03T12:00:00.000Z'),
    criteria: []
  };

  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(() => {
    setLogger(new NoopLogger());
    jest.clearAllMocks();
    (mockFs.ensureDir as jest.Mock).mockResolvedValue(undefined);
    (mockFs.writeFile as unknown as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetLogger();
  });

  it('should write both report formats by default', async () => {
    const renderer: jest.Mocked<ReportRenderer> = {
      renderJson: jest.fn().mockReturnValue('json report'),
      renderHtml: jest.fn().mockReturnValue('html report')
    };
    const generator = new ReportGenerator('/tmp/reports', renderer);

    const paths = await generator.generateReports(result);

    expect(mockFs.ensureDir).toHaveBeenCalledWith('/tmp/reports');
    expect(paths.jsonPath).toMatch(/\/tmp\/reports\/test-module-.+\.json$/);
    expect(paths.htmlPath).toMatch(/\/tmp\/reports\/test-module-.+\.html$/);
    expect(mockFs.writeFile).toHaveBeenCalledTimes(2);
    expect(renderer.renderJson).toHaveBeenCalledWith(result);
    expect(renderer.renderHtml).toHaveBeenCalledWith(result);
  });

  it('should respect report format options', async () => {
    const renderer: jest.Mocked<ReportRenderer> = {
      renderJson: jest.fn().mockReturnValue('json report'),
      renderHtml: jest.fn().mockReturnValue('html report')
    };
    const generator = new ReportGenerator('/tmp/reports', renderer);

    const paths = await generator.generateReports(result, {
      outputJson: true,
      outputHtml: false,
      outputDir: '/tmp/custom-reports'
    });

    expect(mockFs.ensureDir).toHaveBeenCalledWith('/tmp/custom-reports');
    expect(paths.jsonPath).toMatch(/\/tmp\/custom-reports\/test-module-.+\.json$/);
    expect(paths.htmlPath).toBeUndefined();
    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    expect(renderer.renderJson).toHaveBeenCalledWith(result);
    expect(renderer.renderHtml).not.toHaveBeenCalled();
  });
});
