/**
 * Dependency extraction orchestration utilities
 *
 * Coordinates dependency extraction across different build tools and languages.
 * Dispatches to appropriate parsers (Maven, Gradle, npm, etc.) based on project type
 * and aggregates results with deduplication.
 *
 * SECURITY WARNING: This module executes build commands via parsers on untrusted repositories.
 * Ensure proper sandboxing and consider security implications in production use.
 */

import * as fs from 'fs';
import { Dependency, DependencyExtractionResult, DependencyExtractionError, EvaluationRun } from '../types';
import { getMavenDependencies, hasMavenProject } from './parsers/maven-dependency-parser';
import { getGradleDependencies, hasGradleProject } from './parsers/gradle-dependency-parser';
import { getNpmDependencies, hasNpmProject } from './parsers/npm-dependency-parser';
import { isNonEmptyString, isValidDependency } from './type-guards';

function deduplicateDependencies(dependencies: Dependency[]): Dependency[] {
  const uniqueMap = new Map<string, Dependency>();

  for (const dep of dependencies) {
    const key = `${dep.name}:${dep.version}`;

    // If we haven't seen this dependency before, or if the current one has license info and the stored one doesn't
    if (!uniqueMap.has(key) ||
        (!uniqueMap.get(key)?.licenses?.length && dep.licenses?.length)) {
      uniqueMap.set(key, dep);
    }
  }

  return Array.from(uniqueMap.values());
}

export async function getDependencies(repoPath: string, evaluationRun?: EvaluationRun): Promise<DependencyExtractionResult> {
  const dependencies: Dependency[] = [];
  const errors: DependencyExtractionError[] = [];
  const warnings: DependencyExtractionError[] = [];

  if (!isNonEmptyString(repoPath)) {
    errors.push({
      source: 'dependency-orchestrator',
      message: 'Repository path must be a non-empty string',
      error: new Error('Invalid path parameter')
    });
    return { dependencies: [], errors, warnings };
  }

  try {
    if (!fs.existsSync(repoPath)) {
      warnings.push({
        source: 'dependency-orchestrator',
        message: `Repository path does not exist: ${repoPath}`
      });
      return { dependencies: [], errors, warnings };
    }

    const tools = [
      { present: await hasMavenProject(repoPath), extract: getMavenDependencies },
      { present: await hasGradleProject(repoPath), extract: getGradleDependencies },
      { present: await hasNpmProject(repoPath), extract: getNpmDependencies }
    ];

    for (const tool of tools) {
      if (!tool.present) continue;
      const result = await tool.extract(repoPath, evaluationRun);
      dependencies.push(...result.dependencies.filter(isValidDependency));
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }

    if (dependencies.length === 0 && errors.length === 0 && !tools.some(tool => tool.present)) {
      warnings.push({
        source: 'dependency-orchestrator',
        message: 'No Maven, Gradle or npm build file was found, so no dependencies could be listed.'
      });
    }

    const uniqueDependencies = deduplicateDependencies(dependencies);
    return { dependencies: uniqueDependencies, errors, warnings };

  } catch (error) {
    errors.push({
      source: 'dependency-orchestrator',
      message: 'Listing the dependencies failed unexpectedly',
      error: error instanceof Error ? error : new Error(String(error))
    });
    return { dependencies: [], errors, warnings };
  }
}
