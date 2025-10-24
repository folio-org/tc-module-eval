/**
 * Tests for npm-dependency-parser
 */

import * as fs from 'fs';
import { Stats } from 'fs';

// Create mock execAsync before importing the module
const mockExecAsync = jest.fn();

// Mock fs and child_process
jest.mock('fs');
jest.mock('child_process', () => ({
  exec: jest.fn()
}));
jest.mock('util', () => ({
  promisify: jest.fn(() => mockExecAsync)
}));

// Now import the module under test
import { getNpmDependencies, hasNpmProject } from '../utils/parsers/npm-dependency-parser';
import { Dependency } from '../types';

const mockFs = fs as jest.Mocked<typeof fs>;

// Helper to create a proper Stats mock
function createMockStats(isDirectory: boolean = true): Partial<Stats> {
  return {
    isDirectory: jest.fn().mockReturnValue(isDirectory),
    isFile: jest.fn().mockReturnValue(!isDirectory),
    isSymbolicLink: jest.fn().mockReturnValue(false),
    isBlockDevice: jest.fn().mockReturnValue(false),
    isCharacterDevice: jest.fn().mockReturnValue(false),
    isFIFO: jest.fn().mockReturnValue(false),
    isSocket: jest.fn().mockReturnValue(false),
    size: 0,
    mtime: new Date(),
    atime: new Date(),
    ctime: new Date(),
    birthtime: new Date()
  } as Partial<Stats>;
}

describe('npm-dependency-parser', () => {

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset fs mocks to clean state
    (mockFs.existsSync as jest.Mock).mockReset();
    (mockFs.statSync as jest.Mock).mockReset();
    (mockFs.writeFileSync as jest.Mock).mockReset();
    (mockFs.readFileSync as jest.Mock).mockReset();
  });

  describe('hasNpmProject', () => {
    it('should return true when package.json exists', async () => {
      (mockFs.existsSync as jest.Mock).mockImplementation((path) => {
        return path.toString().endsWith('package.json');
      });

      const result = await hasNpmProject('/test/repo');
      expect(result).toBe(true);
    });

    it('should return false when package.json does not exist', async () => {
      (mockFs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await hasNpmProject('/test/repo');
      expect(result).toBe(false);
    });

    it('should return false for invalid path', async () => {
      const result = await hasNpmProject('');
      expect(result).toBe(false);
    });
  });

  describe('getNpmDependencies', () => {
    it('should parse license-checker output correctly', async () => {
      const licenseCheckerOutput = JSON.stringify({
        'express@4.18.2': {
          licenses: 'MIT',
          repository: 'https://github.com/expressjs/express',
          publisher: 'TJ Holowaychuk',
          path: '/test/node_modules/express'
        },
        '@folio/stripes@8.0.0': {
          licenses: 'Apache-2.0',
          repository: 'https://github.com/folio-org/stripes',
          path: '/test/node_modules/@folio/stripes'
        },
        'lodash@4.17.21': {
          licenses: '(MIT OR Apache-2.0)',
          repository: 'https://github.com/lodash/lodash',
          path: '/test/node_modules/lodash'
        }
      });

      // Mock validateRepoPath with implementation-based logic
      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        // Repo path exists, but .npmrc doesn't (so it will be created)
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

      // Mock execAsync
      mockExecAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // yarn install
        .mockResolvedValueOnce({ stdout: licenseCheckerOutput, stderr: '' }); // license-checker

      const result = await getNpmDependencies('/test/repo');

      expect(result.dependencies).toHaveLength(3);

      const express = result.dependencies.find(d => d.name === 'express');
      expect(express).toBeDefined();
      expect(express?.version).toBe('4.18.2');
      expect(express?.licenses).toEqual(['MIT']);

      const stripes = result.dependencies.find(d => d.name === '@folio/stripes');
      expect(stripes).toBeDefined();
      expect(stripes?.version).toBe('8.0.0');
      expect(stripes?.licenses).toEqual(['Apache-2.0']);

      const lodash = result.dependencies.find(d => d.name === 'lodash');
      expect(lodash).toBeDefined();
      expect(lodash?.version).toBe('4.17.21');
      // SPDX expression should be split
      expect(lodash?.licenses).toEqual(['MIT', 'Apache-2.0']);

      expect(result.errors).toHaveLength(0);
    });

    it('should handle invalid repository path', async () => {
      (mockFs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await getNpmDependencies('/invalid/path');

      expect(result.dependencies).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Invalid repository path');
    });

    it('should handle yarn install failure', async () => {
      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

      mockExecAsync.mockRejectedValueOnce(new Error('yarn install failed'));

      const result = await getNpmDependencies('/test/repo');

      expect(result.dependencies).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Failed to extract npm dependencies');
    });

    it('should handle license-checker failure', async () => {
      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

      mockExecAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // yarn install succeeds
        .mockRejectedValueOnce(new Error('license-checker failed'));

      const result = await getNpmDependencies('/test/repo');

      expect(result.dependencies).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });

    it('should handle packages with array licenses', async () => {
      const licenseCheckerOutput = JSON.stringify({
        'multi-license@1.0.0': {
          licenses: ['MIT', 'Apache-2.0'],
          path: '/test/node_modules/multi-license'
        }
      });

      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

      mockExecAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: licenseCheckerOutput, stderr: '' });

      const result = await getNpmDependencies('/test/repo');

      expect(result.dependencies).toHaveLength(1);
      const dep = result.dependencies[0];
      expect(dep.licenses).toEqual(['MIT', 'Apache-2.0']);
    });

    it('should handle packages without licenses', async () => {
      const licenseCheckerOutput = JSON.stringify({
        'no-license@1.0.0': {
          path: '/test/node_modules/no-license'
        }
      });

      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

      mockExecAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: licenseCheckerOutput, stderr: '' });

      const result = await getNpmDependencies('/test/repo');

      expect(result.dependencies).toHaveLength(1);
      const dep = result.dependencies[0];
      expect(dep.licenses).toBeUndefined();
    });

    it('should handle scoped package names correctly', async () => {
      const licenseCheckerOutput = JSON.stringify({
        '@folio/stripes-core@8.0.0': {
          licenses: 'Apache-2.0',
          path: '/test/node_modules/@folio/stripes-core'
        }
      });

      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

      mockExecAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: licenseCheckerOutput, stderr: '' });

      const result = await getNpmDependencies('/test/repo');

      expect(result.dependencies).toHaveLength(1);
      const dep = result.dependencies[0];
      expect(dep.name).toBe('@folio/stripes-core');
      expect(dep.version).toBe('8.0.0');
      expect(dep.licenses).toEqual(['Apache-2.0']);
    });

    it('should respect existing .npmrc file', async () => {
      const licenseCheckerOutput = JSON.stringify({
        'test-package@1.0.0': {
          licenses: 'MIT',
          path: '/test/node_modules/test-package'
        }
      });

      // Mock .npmrc already exists
      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return true; // .npmrc exists
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

      mockExecAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: licenseCheckerOutput, stderr: '' });

      const result = await getNpmDependencies('/test/repo');

      // Verify writeFileSync was NOT called (existing .npmrc was respected)
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
      expect(result.dependencies).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should fallback to package.json when license-checker fails', async () => {
      const packageJsonContent = JSON.stringify({
        name: 'test-project',
        dependencies: {
          'express': '^4.18.2',
          'lodash': '~4.17.21'
        }
      });

      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        if (filePath.includes('package.json')) return true;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
      (mockFs.readFileSync as jest.Mock).mockReturnValue(packageJsonContent);

      // license-checker fails
      mockExecAsync
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // yarn install succeeds
        .mockRejectedValueOnce(new Error('license-checker command not found'));

      const result = await getNpmDependencies('/test/repo');

      // Should return partial results from package.json fallback
      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies[0].name).toBe('express');
      expect(result.dependencies[0].version).toBe('4.18.2');
      expect(result.dependencies[0].licenses).toBeUndefined();
      expect(result.dependencies[1].name).toBe('lodash');
      expect(result.dependencies[1].version).toBe('4.17.21');

      // Should have warnings, not errors
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0].message).toContain('License-checker approach failed');
      expect(result.warnings[1].message).toContain('Using fallback');
      expect(result.errors).toHaveLength(0);
    });

    it('should return empty array when both license-checker and fallback fail', async () => {
      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        if (filePath.includes('package.json')) return false; // package.json doesn't exist
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);

      mockExecAsync.mockRejectedValueOnce(new Error('yarn install failed'));

      const result = await getNpmDependencies('/test/repo');

      expect(result.dependencies).toHaveLength(0);
      expect(result.warnings).toHaveLength(1); // Fallback attempt warning
      expect(result.errors).toHaveLength(1); // Main failure (fallback returns empty array gracefully)
    });

    it('should handle malformed package.json in fallback', async () => {
      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        if (filePath.includes('package.json')) return true;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
      (mockFs.readFileSync as jest.Mock).mockReturnValue('{ invalid json }');

      mockExecAsync.mockRejectedValueOnce(new Error('license-checker failed'));

      const result = await getNpmDependencies('/test/repo');

      expect(result.dependencies).toHaveLength(0);
      expect(result.warnings).toHaveLength(1); // Fallback attempt warning
      expect(result.errors).toHaveLength(1); // Main failure (fallback catches JSON.parse error gracefully)
    });
  });
});
