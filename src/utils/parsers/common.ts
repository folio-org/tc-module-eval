import * as fs from 'fs';
import * as path from 'path';
import { CommandExecutionResult, DependencyExtractionError } from '../../types';
import { isNonEmptyString } from '../type-guards';
import { getLogger } from '../logger';
import { isWithinRepo, readBoundedFileBytes } from '../repo-files';

/** Plain-English reason a dependency-listing command did not succeed, for the S003 report. */
export function commandFailureReason(result: CommandExecutionResult): string {
  return commandsDisabled(result)
    ? 'build commands are turned off for this evaluation'
    : result.errorMessage || result.stderr || result.status;
}

function commandsDisabled(result: CommandExecutionResult): boolean {
  return result.status === 'blocked' && !result.localCommandsAllowed;
}

/** Extraction error for a dependency-listing command that did not succeed. */
export function commandError(source: string, tool: string, result: CommandExecutionResult): DependencyExtractionError {
  const reason = commandFailureReason(result);
  return {
    source,
    message: `${tool} could not list the dependencies: ${reason}`,
    error: new Error(result.stderr || reason),
    commandsDisabled: commandsDisabled(result)
  };
}

/**
 * Reads a repository file without leaving the repository: the path, after following any symlinks,
 * must be a regular file inside the repository, and at most `maxBytes` are read.
 * @returns File contents, or null if the file is missing, outside the repository, or not a regular file
 */
export function readRepoTextFile(repoPath: string, relativePath: string, maxBytes: number): string | null {
  const filePath = path.join(repoPath, relativePath);
  try {
    if (!isWithinRepo(repoPath, filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }
    return readBoundedFileBytes(filePath, maxBytes).toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Safely read file contents
 * @param filePath - Path to file
 * @returns File contents or null if file doesn't exist or can't be read
 */
export function safeReadFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    getLogger().warn(`Failed to read file ${filePath}:`, error);
    return null;
  }
}

/**
 * Validate and sanitize a repository path before executing shell commands
 * SECURITY: Normalizes paths and validates existence and type.
 * Note: Does not enforce path containment within a specific directory.
 * @param repoPath - Path to validate
 * @returns Validated absolute path or null if invalid
 */
export function validateRepoPath(repoPath: string): string | null {
  try {
    // Check for non-empty string
    if (!isNonEmptyString(repoPath)) {
      getLogger().warn('Repository path is empty or invalid');
      return null;
    }

    // Resolve to absolute path (prevents directory traversal attacks)
    const absolutePath = path.resolve(repoPath);

    // Verify path exists
    if (!fs.existsSync(absolutePath)) {
      getLogger().warn(`Repository path does not exist: ${absolutePath}`);
      return null;
    }

    // Verify it's a directory
    const stats = fs.statSync(absolutePath);
    if (!stats.isDirectory()) {
      getLogger().warn(`Repository path is not a directory: ${absolutePath}`);
      return null;
    }

    return absolutePath;
  } catch (error) {
    getLogger().warn(`Failed to validate repository path ${repoPath}:`, error);
    return null;
  }
}
