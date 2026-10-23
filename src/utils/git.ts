import simpleGit from 'simple-git';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from './logger';

/**
 * Git utilities for cloning and managing repositories
 */
export class GitUtils {
  private tempDir: string;
  private timeoutMs: number;

  constructor(tempDir?: string, timeoutMs: number = 120000) {
    this.tempDir = tempDir || path.join(os.tmpdir(), 'folio-eval');
    this.timeoutMs = timeoutMs;
  }

  /**
   * Clone a repository to a temporary directory
   * @param repositoryUrl GitHub URL of the repository
   * @param branch Optional branch name to clone (defaults to repository's default branch)
   * @returns Promise<string> Path to the cloned repository
   */
  async cloneRepository(repositoryUrl: string, branch?: string): Promise<string> {
    const repoName = this.extractRepoName(repositoryUrl);
    const clonePath = path.join(this.tempDir, repoName, Date.now().toString());

    await fs.ensureDir(clonePath);

    const git = simpleGit({
      timeout: {
        block: this.timeoutMs
      }
    });

    try {
      if (branch) {
        await git.clone(repositoryUrl, clonePath, ['--branch', branch]);
        getLogger().info(`Repository cloned to: ${clonePath} (branch: ${branch})`);
      } else {
        await git.clone(repositoryUrl, clonePath);
        getLogger().info(`Repository cloned to: ${clonePath}`);
      }

      return clonePath;
    } catch (error: unknown) {
      await fs.remove(clonePath).catch(() => {
        // Ignore cleanup errors
      });

      const errorMessage = (error instanceof Error && error.message) || String(error);

      if (branch && (errorMessage.includes('Remote branch') || errorMessage.includes('not found'))) {
        throw new Error(
          `Failed to clone branch '${branch}' from repository.\n` +
          `The branch may not exist or you may have a typo in the branch name.\n` +
          `Repository: ${repositoryUrl}\n` +
          `Git error: ${errorMessage}`
        );
      }

      if (errorMessage.includes('Could not resolve host') || errorMessage.includes('not found')) {
        throw new Error(
          `Failed to access repository: ${repositoryUrl}\n` +
          `The repository may not exist, may be private, or there may be a network issue.\n` +
          `Git error: ${errorMessage}`
        );
      }

      if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
        throw new Error(
          `Repository clone timed out after ${this.timeoutMs / 1000} seconds.\n` +
          `The repository may be too large or there may be network issues.\n` +
          `Repository: ${repositoryUrl}\n` +
          `Git error: ${errorMessage}`
        );
      }

      throw new Error(
        `Failed to clone repository: ${repositoryUrl}\n` +
        (branch ? `Branch: ${branch}\n` : '') +
        `Git error: ${errorMessage}`
      );
    }
  }

  /**
   * Clean up cloned repository
   * @param repoPath Path to the cloned repository
   */
  async cleanup(repoPath: string): Promise<void> {
    if (await fs.pathExists(repoPath)) {
      await fs.remove(repoPath);
      getLogger().info(`Cleaned up: ${repoPath}`);
    }
  }

  /**
   * Extract repository name from GitHub URL
   * @param repositoryUrl GitHub URL
   * @returns Repository name
   */
  private extractRepoName(repositoryUrl: string): string {
    const match = repositoryUrl.match(/\/([^\/]+?)(?:\.git)?$/);
    return match ? match[1] : 'unknown-repo';
  }

  /**
   * Get basic repository information
   * @param repoPath Path to the cloned repository
   * @returns Basic repository info
   */
  async getRepoInfo(repoPath: string): Promise<{
    name: string;
    commit: string;
    trackedFiles: string[];
  }> {
    // cloneRepository clones to <tempDir>/<repo>/<timestamp>, so the parent directory names the repository.
    const name = path.basename(path.dirname(repoPath));
    const git = simpleGit(repoPath);
    const [commit, trackedOutput] = await Promise.all([
      git.revparse(['HEAD']),
      git.raw(['ls-files', '-z'])
    ]);

    return {
      name,
      commit: commit.trim(),
      trackedFiles: trackedOutput.split('\0').filter(Boolean)
    };
  }
}
