import * as fs from 'fs';
import * as path from 'path';
import { EvaluationStatus } from '../types';
import { analyzeS004Documentation } from '../utils/s004-installation-documentation';
import { classifyModuleKind } from '../utils/module-kind';

const maybeIt = process.env.S004_CORPUS_CALIBRATION === 'true' ? it : it.skip;

describe('S004 corpus calibration', () => {
  maybeIt('prints S004 status distribution over local build-repos', () => {
    const buildReposPath = path.resolve(__dirname, '..', '..', '..', 'build-repos');
    if (!fs.existsSync(buildReposPath)) {
      console.warn(`Skipping corpus calibration because ${buildReposPath} does not exist`);
      return;
    }

    const distribution: Record<string, string[]> = {
      [EvaluationStatus.PASS]: [],
      [EvaluationStatus.FAIL]: [],
      [EvaluationStatus.MANUAL]: [],
      [EvaluationStatus.NOT_APPLICABLE]: []
    };

    for (const entry of fs.readdirSync(buildReposPath)) {
      const repoPath = path.join(buildReposPath, entry);
      if (!fs.statSync(repoPath).isDirectory()) {
        continue;
      }
      const kind = classifyModuleKind(repoPath);
      if (kind.kind === 'library') {
        distribution[EvaluationStatus.NOT_APPLICABLE].push(entry);
        continue;
      }
      const result = analyzeS004Documentation(repoPath);
      distribution[result.classification.status].push(entry);
    }

    console.log(JSON.stringify({
      counts: Object.fromEntries(Object.entries(distribution).map(([status, repos]) => [status, repos.length])),
      examples: Object.fromEntries(Object.entries(distribution).map(([status, repos]) => [status, repos.slice(0, 5)]))
    }, null, 2));
  });
});
