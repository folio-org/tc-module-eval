import { JavaEvaluator } from '../evaluators/java-evaluator';
import { EvaluationStatus } from '../types';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';

// Mock fs-extra module with factory function
jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
  readFile: jest.fn()
}));

import * as fs from 'fs-extra';
import * as realFs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('JavaEvaluator', () => {
  let evaluator: JavaEvaluator;
  const mockRepoPath = '/tmp/test-repo';
  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(() => {
    setLogger(new NoopLogger());
    evaluator = new JavaEvaluator();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetLogger();
  });

  describe('canEvaluate', () => {
    it('should return true for Maven projects', async () => {
      mockFs.pathExists.mockImplementation((filePath: any) => {
        return Promise.resolve(filePath.toString().endsWith('pom.xml'));
      });

      const result = await evaluator.canEvaluate(mockRepoPath);
      expect(result).toBe(true);
    });

    it('should return true for Gradle projects at the root or in service/, like FOLIO Grails modules', async () => {
      (mockFs.pathExists as jest.Mock).mockResolvedValue(false);
      const repo = realFs.mkdtempSync(path.join(os.tmpdir(), 'java-evaluator-'));
      try {
        realFs.mkdirSync(path.join(repo, 'service'));
        realFs.writeFileSync(path.join(repo, 'service', 'build.gradle'), '');
        expect(await evaluator.canEvaluate(repo)).toBe(true);

        realFs.renameSync(path.join(repo, 'service'), path.join(repo, 'tools'));
        expect(await evaluator.canEvaluate(repo)).toBe(false);

        realFs.writeFileSync(path.join(repo, 'build.gradle.kts'), '');
        expect(await evaluator.canEvaluate(repo)).toBe(true);
      } finally {
        realFs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('should return false for non-Java projects', async () => {
      (mockFs.pathExists as jest.Mock).mockResolvedValue(false);

      const result = await evaluator.canEvaluate(mockRepoPath);
      expect(result).toBe(false);
    });
  });

  describe('getLanguage', () => {
    it('should return Java', () => {
      expect(evaluator.getLanguage()).toBe('Java');
    });
  });

  describe('evaluate', () => {
    it('should evaluate all applicable criteria sections', async () => {
      // Mock file system for basic repository structure
      mockFs.pathExists.mockImplementation((filePath: any) => {
        const pathStr = filePath.toString();
        return Promise.resolve(
          pathStr.endsWith('README.md') ||
          pathStr.endsWith('LICENSE') ||
          pathStr.endsWith('pom.xml')
        );
      });

      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('LICENSE')) {
          return Promise.resolve('Apache License\nVersion 2.0');
        }
        if (pathStr.endsWith('README.md')) {
          return Promise.resolve('# Test Module\nThis is a FOLIO module for testing.');
        }
        return Promise.resolve('');
      });

//      (mockFs.readdir as jest.Mock).mockResolvedValue([]);

      const results = await evaluator.evaluate(mockRepoPath);
      
      // Should have results from all sections: Administrative (1) + Shared (14) + Backend (16) = 31 total
      expect(results.length).toBe(31);
      
      // Should have results for all major criterion categories
      const criterionIds = results.map(r => r.criterionId);
      expect(criterionIds).toContain('A001'); // Administrative
      expect(criterionIds).toContain('S001'); // Shared - License
      expect(criterionIds).toContain('S004'); // Shared - README
      expect(criterionIds).toContain('B001'); // Backend
      
      // Each result should have the required structure
      results.forEach(result => {
        expect(result).toHaveProperty('criterionId');
        expect(result).toHaveProperty('status');
        expect(result).toHaveProperty('evidence');
        expect(['pass', 'fail', 'manual', 'not_applicable']).toContain(result.status);
      });
    });

    it('should handle evaluation errors gracefully', async () => {
      // Mock fs to throw errors
      (mockFs.pathExists as jest.Mock).mockRejectedValue(new Error('File system error'));

      const results = await evaluator.evaluate(mockRepoPath);
      
      // Should still return results, even if some evaluations fail
      expect(Array.isArray(results)).toBe(true);
    });

    it('should evaluate S001 against the repository license file', async () => {
      // S001 reads the real filesystem (not fs-extra), so give it a real repository.
      const repoPath = realFs.mkdtempSync(path.join(os.tmpdir(), 's001-java-'));
      try {
        realFs.writeFileSync(path.join(repoPath, 'LICENSE'), 'Apache License\nVersion 2.0, January 2004\n');
        (mockFs.pathExists as jest.Mock).mockResolvedValue(false);

        const results = await evaluator.evaluate(repoPath);

        const licenseResult = results.find(r => r.criterionId === 'S001');
        expect(licenseResult?.status).toBe(EvaluationStatus.PASS);
        expect(licenseResult?.evidence).toBe('The LICENSE file is the Apache License 2.0.');
      } finally {
        realFs.rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });
});
