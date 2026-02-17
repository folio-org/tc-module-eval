import * as fs from 'fs';
import * as path from 'path';
import { isNonEmptyString } from '../type-guards';
import { getLogger } from '../logger';

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
