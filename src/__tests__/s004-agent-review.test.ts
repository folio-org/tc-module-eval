import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  CriterionAgentReviewConfig,
  EvaluationStatus,
  S004InstallationDocumentationResult
} from '../types';
import { reviewS004WithAgent } from '../utils/s004-agent-review';
import { MAX_DOC_BYTES } from '../utils/s004-installation-documentation';

class CapturingRunner implements CommandRunner {
  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify(request);
  }

  async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    const command = `${request.command} ${(request.args ?? []).join(' ')}`;
    const provenance = request.env?.OPENCODE_CONFIG_DIR ?? request.cwd;
    const stdout = command.includes('debug config')
      ? JSON.stringify({ plugin: [], mcp: {}, provenance })
      : command.includes('debug agent')
        ? JSON.stringify({
            provenance,
            tools: {
              read: true,
              glob: true,
              grep: true,
              edit: false,
              write: false,
              bash: false,
              task: false,
              webfetch: false,
              websearch: false,
              skill: false,
              todowrite: false
            }
          })
        : JSON.stringify({
            recommendation: 'needs_reviewer_judgment',
            confidence: 'medium',
            summary: 'Bounded review.',
            rationale: 'README.md was reviewed.',
            evidenceReferences: ['README.md']
          });

    return {
      identity: this.normalize(request),
      command: request.command,
      args: request.args ?? [],
      cwd: request.cwd,
      commandExecutionEnvironment: 'local',
      localCommandsAllowed: false,
      status: 'success',
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout,
      stderr: '',
      sanitized: true
    };
  }
}

describe('S004 agent review', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 's004-agent-'));
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('sends bounded candidate documentation to the review workspace', async () => {
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'x'.repeat(MAX_DOC_BYTES + 4096));

    const result = await reviewS004WithAgent(repoPath, documentationResult(), agentConfig(), new CapturingRunner());
    const retainedWorkspace = result.metadata?.retainedWorkspacePath;

    expect(result.available).toBe(true);
    expect(retainedWorkspace).toBeDefined();

    try {
      const copied = fs.readFileSync(path.join(retainedWorkspace!, 'docs', 'README.md'));
      expect(copied.length).toBeLessThanOrEqual(MAX_DOC_BYTES);
    } finally {
      fs.rmSync(retainedWorkspace!, { recursive: true, force: true });
    }
  });

  function documentationResult(): S004InstallationDocumentationResult {
    return {
      candidates: [{
        path: 'README.md',
        source: 'root-readme',
        sizeBytes: MAX_DOC_BYTES,
        signals: []
      }],
      classification: {
        status: EvaluationStatus.MANUAL,
        reason: 'manual',
        strongestSignals: [],
        filesConsidered: ['README.md'],
        warnings: []
      },
      warnings: []
    };
  }

  function agentConfig(): CriterionAgentReviewConfig {
    return {
      enabled: true,
      enabledCriteria: ['S004'],
      adapter: 'opencode',
      modelLabel: 'test-model',
      readOnlyAgentName: 'reviewer',
      endpoint: 'https://api.example.test',
      endpointFamily: 'openai-compatible',
      debugRetainWorkspace: true
    };
  }
});
