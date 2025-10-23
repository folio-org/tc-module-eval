import simpleGit from 'simple-git';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

/**
 * Git utilities for cloning and managing repositories
 */
export class GitUtils {
  private tempDir: string;
  private timeoutMs: number;
  private repoName: string = '';

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

    // Ensure temp directory exists
    await fs.ensureDir(clonePath);

    const git = simpleGit({
      timeout: {
        block: this.timeoutMs
      }
    });

    try {
      // Clone with branch if specified
      if (branch) {
        await git.clone(repositoryUrl, clonePath, ['--branch', branch]);
        console.log(`Repository cloned to: ${clonePath} (branch: ${branch})`);
      } else {
        await git.clone(repositoryUrl, clonePath);
        console.log(`Repository cloned to: ${clonePath}`);
      }

      // Store repo name for later use
      this.repoName = repoName;

      return clonePath;
    } catch (error: any) {
      // Clean up the partially created directory
      await fs.remove(clonePath).catch(() => {
        // Ignore cleanup errors
      });

      // Provide more helpful error messages
      const errorMessage = error.message || String(error);

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

      // Generic git error with original message
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
      this.repoName = '';
      console.log(`Cleaned up: ${repoPath}`);
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
  async getRepoInfo(repoPath: string): Promise<{ name: string; hasPackageJson: boolean; hasPomXml: boolean; hasBuildGradle: boolean }> {
    // Use stored repo name if available, otherwise fall back to path extraction
    // (fallback maintained for backward compatibility)
    const name = this.repoName || path.basename(path.dirname(repoPath));
    const hasPackageJson = await fs.pathExists(path.join(repoPath, 'package.json'));
    const hasPomXml = await fs.pathExists(path.join(repoPath, 'pom.xml'));
    const hasBuildGradle = await fs.pathExists(path.join(repoPath, 'build.gradle')) ||
                          await fs.pathExists(path.join(repoPath, 'build.gradle.kts'));

    return {
      name,
      hasPackageJson,
      hasPomXml,
      hasBuildGradle
    };
  }
}
