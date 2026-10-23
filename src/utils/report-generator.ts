import * as fs from 'fs-extra';
import * as path from 'path';
import { EvaluationResult, ReportOptions } from '../types';
import { getLogger } from './logger';
import { EvaluationReportRenderer, ReportRenderer } from './report-renderer';

export class ReportGenerator {
  private outputDir: string;
  private renderer: ReportRenderer;

  constructor(outputDir: string = './reports', renderer: ReportRenderer = new EvaluationReportRenderer()) {
    this.outputDir = outputDir;
    this.renderer = renderer;
  }

  async generateReports(
    result: EvaluationResult, 
    options: ReportOptions = {}
  ): Promise<{ htmlPath?: string; jsonPath?: string }> {
    const outputDir = options.outputDir || this.outputDir;
    await fs.ensureDir(outputDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `${result.moduleName}-${timestamp}`;
    
    const paths: { htmlPath?: string; jsonPath?: string } = {};

    if (options.outputJson !== false) {
      const jsonPath = path.join(outputDir, `${baseName}.json`);
      await this.generateJsonReport(result, jsonPath);
      paths.jsonPath = jsonPath;
    }

    if (options.outputHtml !== false) {
      const htmlPath = path.join(outputDir, `${baseName}.html`);
      await this.generateHtmlReport(result, htmlPath);
      paths.htmlPath = htmlPath;
    }

    return paths;
  }

  private async generateJsonReport(result: EvaluationResult, outputPath: string): Promise<void> {
    const jsonContent = this.renderer.renderJson(result);
    await fs.writeFile(outputPath, jsonContent);
    getLogger().info(`JSON report generated: ${outputPath}`);
  }

  private async generateHtmlReport(result: EvaluationResult, outputPath: string): Promise<void> {
    const htmlContent = this.renderer.renderHtml(result);
    await fs.writeFile(outputPath, htmlContent);
    getLogger().info(`HTML report generated: ${outputPath}`);
  }
}
