/**
 * Tests for npm-dependency-parser
 */

import * as fs from 'fs';
import { Stats } from 'fs';

// Mock fs
jest.mock('fs');

// Now import the module under test
import { getNpmDependencies, hasNpmProject } from '../utils/parsers/npm-dependency-parser';
import { CommandExecutionRequest, CommandExecutionResult, CommandRunner, Dependency, EvaluationRun } from '../types';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';

const mockFs = fs as jest.Mocked<typeof fs>;

// Constants for mock Stats defaults
const DEFAULT_MOCK_SIZE = 0;
const DEFAULT_MOCK_DATE = new Date();

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
    size: DEFAULT_MOCK_SIZE,
    mtime: DEFAULT_MOCK_DATE,
    atime: DEFAULT_MOCK_DATE,
    ctime: DEFAULT_MOCK_DATE,
    birthtime: DEFAULT_MOCK_DATE
  } as Partial<Stats>;
}

class FakeRunner implements CommandRunner {
  calls: CommandExecutionRequest[] = [];

  constructor(private readonly results: Array<Partial<CommandExecutionResult>>) {}

  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify({ command: request.command, args: request.args, cwd: request.cwd });
  }

  async run(request: CommandExecutionRequest, _evaluationRun?: EvaluationRun): Promise<CommandExecutionResult> {
    this.calls.push(request);
    const result = this.results.shift() ?? {};
    return {
      identity: this.normalize(request),
      command: request.command,
      args: request.args ?? [],
      cwd: request.cwd,
      executionMode: result.executionMode ?? 'trusted-local',
      status: result.status ?? 'success',
      exitCode: result.exitCode ?? (result.status === 'failed' ? 1 : 0),
      signal: result.signal,
      durationMs: result.durationMs ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      errorMessage: result.errorMessage,
      sanitized: true
    };
  }
}

describe('npm-dependency-parser', () => {

  beforeEach(() => {
    setLogger(new NoopLogger());
    jest.clearAllMocks();

    // Reset fs mocks to clean state
    (mockFs.existsSync as jest.Mock).mockReset();
    (mockFs.statSync as jest.Mock).mockReset();
    (mockFs.writeFileSync as jest.Mock).mockReset();
    (mockFs.readFileSync as jest.Mock).mockReset();
    (mockFs.mkdirSync as jest.Mock).mockReset();
  });

  afterEach(() => {
    resetLogger();
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

      const runner = new FakeRunner([
        { status: 'success' },
        { status: 'success', stdout: licenseCheckerOutput }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

      expect(runner.calls[0]).toMatchObject({
        command: 'yarn',
        args: ['install', '--production', '--ignore-scripts', '--ignore-engines'],
        cwd: '/test/repo',
        requiresIsolation: true,
        networkPolicy: expect.objectContaining({ default: 'deny' })
      });
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

      const runner = new FakeRunner([
        { status: 'failed', errorMessage: 'yarn install failed' }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

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

      const runner = new FakeRunner([
        { status: 'success' },
        { status: 'failed', errorMessage: 'license-checker failed' }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

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

      const runner = new FakeRunner([
        { status: 'success' },
        { status: 'success', stdout: licenseCheckerOutput }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

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

      const runner = new FakeRunner([
        { status: 'success' },
        { status: 'success', stdout: licenseCheckerOutput }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

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

      const runner = new FakeRunner([
        { status: 'success' },
        { status: 'success', stdout: licenseCheckerOutput }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

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

      const runner = new FakeRunner([
        { status: 'success' },
        { status: 'success', stdout: licenseCheckerOutput }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

      // Verify writeFileSync was NOT called (existing .npmrc was respected)
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
      expect(result.dependencies).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should return an explicit error when license-checker fails', async () => {
      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        if (filePath.includes('package.json')) return true;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
      const runner = new FakeRunner([
        { status: 'success' },
        { status: 'failed', errorMessage: 'license-checker command not found' }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

      expect(result.dependencies).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Failed to extract npm dependencies');
      expect(result.errors[0].message).toContain('license-checker command not found');
    });

    it('should return empty array when yarn install fails', async () => {
      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
      const runner = new FakeRunner([
        { status: 'failed', errorMessage: 'yarn install failed' }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

      expect(result.dependencies).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });

    it('should not parse package.json as a hidden fallback when extraction fails', async () => {
      (mockFs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === '/test/repo') return true;
        if (filePath.includes('.npmrc')) return false;
        if (filePath.includes('package.json')) return true;
        return true;
      });
      (mockFs.statSync as jest.Mock).mockReturnValue(createMockStats(true));
      (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
      (mockFs.readFileSync as jest.Mock).mockReturnValue('{ invalid json }');
      const runner = new FakeRunner([
        { status: 'failed', errorMessage: 'blocked by policy' }
      ]);

      const result = await getNpmDependencies('/test/repo', undefined, runner);

      expect(result.dependencies).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(mockFs.readFileSync).not.toHaveBeenCalled();
    });
  });
});
