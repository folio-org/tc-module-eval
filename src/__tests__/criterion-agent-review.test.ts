import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandRunner,
  CriterionAgentReviewConfig
} from '../types';
import {
  prepareCriterionReviewWorkspace,
  runCriterionAgentReview,
  validateEndpointUrl
} from '../utils/criterion-agent-review';
import { materializeOpenCodeInvocation } from '../utils/opencode-agent-adapter';

class FakeRunner implements CommandRunner {
  requests: CommandExecutionRequest[] = [];

  constructor(
    private readonly configDebug?: string,
    private readonly agentDebug?: string,
    private readonly runStdout?: string
  ) {}

  normalize(request: CommandExecutionRequest): string {
    return JSON.stringify(request);
  }

  async run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    this.requests.push(request);
    const command = `${request.command} ${(request.args ?? []).join(' ')}`;
    const provenance = request.env?.OPENCODE_CONFIG_DIR ?? request.cwd;
    if (command.includes('debug config')) {
      return this.result(request, (this.configDebug ?? JSON.stringify({ plugin: [], mcp: {}, provenance: '__CWD__' })).replace('__CWD__', provenance));
    }
    if (command.includes('debug agent')) {
      return this.result(request, (this.agentDebug ?? JSON.stringify({
        provenance: '__CWD__',
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
      })).replace('__CWD__', provenance));
    }
    return this.result(request, this.runStdout ?? JSON.stringify({
      recommendation: 'needs_reviewer_judgment',
      confidence: 'medium',
      summary: 'Looks plausible.',
      rationale: 'Cites README.md only.',
      evidenceReferences: ['README.md', 'missing.md']
    }));
  }

  private result(request: CommandExecutionRequest, stdout: string): CommandExecutionResult {
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

describe('criterion agent review', () => {
  let repoPath: string;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-repo-'));
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('returns disabled evidence by default', async () => {
    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [],
      schemaDescription: 'schema'
    }, undefined);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('disabled');
  });

  it('normalizes fake adapter advisory output against manifest references', async () => {
    const result = await runCriterionAgentReview({
      criterionId: 'S005',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'schemas/user.json', content: 'email' }],
      schemaDescription: 'schema'
    }, {
      enabled: true,
      enabledCriteria: ['S005'],
      adapter: 'fake',
      modelLabel: 'fake-model',
      fakeResult: {
        available: true,
        criterionId: 'S005',
        recommendation: 'fail',
        confidence: 0.78,
        summary: 'Fake summary.',
        rationale: 'Fake rationale.',
        evidenceReferences: [
          { repoRelativePath: 'schemas/user.json' },
          'missing.md'
        ],
        warnings: [],
        errors: []
      } as unknown as CriterionAgentReviewConfig['fakeResult']
    });

    expect(result.available).toBe(true);
    expect(result.recommendation).toBe('likely_insufficient');
    expect(result.confidence).toBe('high');
    expect(result.evidenceReferences).toEqual(['schemas/user.json']);
    expect(result.warnings.join('\n')).toContain('Dropped');
  });

  it('treats incomplete fake adapter advisory output as unavailable', async () => {
    const result = await runCriterionAgentReview({
      criterionId: 'S005',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'schemas/user.json', content: 'email' }],
      schemaDescription: 'schema'
    }, {
      enabled: true,
      enabledCriteria: ['S005'],
      adapter: 'fake',
      modelLabel: 'fake-model',
      fakeResult: {
        available: true,
        criterionId: 'S005',
        recommendation: 'definitely_compliant',
        confidence: 'certain',
        summary: 'Fake summary.',
        rationale: 'Fake rationale.',
        evidenceReferences: ['schemas/user.json'],
        warnings: [],
        errors: []
      } as unknown as CriterionAgentReviewConfig['fakeResult']
    });

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('incomplete advisory JSON');
  });

  it('prepares a sanitized manifest workspace', () => {
    const workspace = prepareCriterionReviewWorkspace({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'do not leak token=secret',
      files: [{ repoRelativePath: 'README.md', content: `password=hunter2\n${'x'.repeat(100 * 1024)}` }],
      schemaDescription: 'schema'
    });

    try {
      const manifest = fs.readFileSync(workspace.manifestPath, 'utf-8');
      const readme = fs.readFileSync(path.join(workspace.rootPath, 'docs/README.md'), 'utf-8');
      const mode = fs.statSync(workspace.rootPath).mode & 0o777;

      expect(mode).toBe(0o700);
      expect(manifest).toContain('token=[REDACTED]');
      expect(readme).toContain('password=[REDACTED]');
      expect(readme).toContain('output truncated');
      expect(readme).not.toContain('hunter2');
    } finally {
      fs.rmSync(workspace.rootPath, { recursive: true, force: true });
    }
  });

  it('rejects unsafe or colliding review workspace paths', async () => {
    const unsafe = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: '../README.md', content: 'unsafe' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), new FakeRunner());

    const colliding = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [
        { repoRelativePath: 'README.md', content: 'first' },
        { repoRelativePath: './README.md', content: 'second' }
      ],
      schemaDescription: 'schema'
    }, opencodeConfig(), new FakeRunner());

    expect(unsafe.available).toBe(false);
    expect(unsafe.errors.join('\n')).toContain('must stay inside the repository');
    expect(colliding.available).toBe(false);
    expect(colliding.errors.join('\n')).toContain('Duplicate agent review workspace path');
  });

  it('rejects non-HTTPS endpoints unless local or allowlisted', () => {
    expect(validateEndpointUrl('http://api.example.test')).toContain('HTTPS');
    expect(validateEndpointUrl('http://localhost:11434')).toBeUndefined();
    expect(validateEndpointUrl('http://[::1]:11434')).toBeUndefined();
    expect(validateEndpointUrl('http://api.example.test', ['http://api.example.test'])).toBeUndefined();
    expect(validateEndpointUrl('http://api.example.test/v1/chat', ['http://api.example.test/v1'])).toBeUndefined();
    expect(validateEndpointUrl('http://api.example.test/v10/chat', ['http://api.example.test/v1'])).toContain('HTTPS');
    expect(validateEndpointUrl('http://api.example.test/v1.evil/chat', ['http://api.example.test/v1'])).toContain('HTTPS');
    expect(validateEndpointUrl('http://api.example.test.attacker', ['http://api.example.test'])).toContain('HTTPS');
    expect(validateEndpointUrl('http://api.example.test@attacker.example', ['http://api.example.test'])).toContain('HTTPS');
  });

  it('runs OpenCode with generated env and manifest args', async () => {
    const runner = new FakeRunner();
    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(true);
    expect(result.evidenceReferences).toEqual(['README.md']);
    expect(result.warnings.join('\n')).toContain('Dropped');

    const runRequest = runner.requests.find(request => request.args?.[0] === 'run');
    expect(runRequest?.args).toEqual(expect.arrayContaining([
      '--agent',
      'reviewer',
      '--model',
      'test-model',
      '--format',
      'json',
      '--file'
    ]));
    expect(runRequest?.args).not.toContain('--dir');
    expect(runRequest?.args?.indexOf('review')).toBeLessThan(runRequest?.args?.indexOf('--file') ?? -1);
    expect(runRequest?.env?.HOME).toBeDefined();
    expect(runRequest?.env?.XDG_CONFIG_HOME).toBeDefined();
    expect(runRequest?.env?.OPENCODE_CONFIG_DIR).toBeDefined();
    expect(runRequest?.maxOutputBytes).toBe(1024 * 1024);
  });

  it('removes external OpenCode runtime data after normal runs', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-secret';
    const runner = new FakeRunner();

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, {
      ...opencodeConfig(),
      modelLabel: 'openrouter/openrouter/free',
      endpoint: undefined,
      endpointFamily: 'openrouter',
      generatedProvider: {
        name: 'openrouter',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        modelEnv: 'OPENROUTER_MODEL',
        modelId: 'openrouter/free',
        modelSelector: 'openrouter/openrouter/free'
      },
      providerEnvAllowlist: ['OPENROUTER_API_KEY']
    }, runner);

    const runRequest = runner.requests.find(request => request.args?.[0] === 'run');
    const runtimeDataHome = runRequest?.env?.XDG_DATA_HOME;

    expect(result.available).toBe(true);
    expect(runtimeDataHome).toBeDefined();
    expect(fs.existsSync(path.dirname(runtimeDataHome!))).toBe(false);
  });

  it('parses OpenCode JSON event streams', async () => {
    const runner = new FakeRunner(undefined, undefined, [
      JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
      JSON.stringify({
        type: 'text',
        part: {
          type: 'text',
          text: JSON.stringify({
            recommendation: 'likely_sufficient',
            confidence: 'low',
            summary: 'Event stream summary.',
            rationale: 'Event stream rationale.',
            evidenceReferences: ['README.md']
          })
        }
      }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } })
    ].join('\n'));

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(true);
    expect(result.recommendation).toBe('likely_sufficient');
    expect(result.summary).toBe('Event stream summary.');
    expect(result.evidenceReferences).toEqual(['README.md']);
  });

  it('parses OpenCode message-content event streams after large tool events', async () => {
    const runner = new FakeRunner(undefined, undefined, [
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          state: {
            output: 'x'.repeat(96 * 1024)
          }
        }
      }),
      JSON.stringify({
        type: 'message',
        message: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              recommendation: 'needs_reviewer_judgment',
              confidence: 'medium',
              summary: 'Message content summary.',
              rationale: 'Message content rationale.',
              evidenceReferences: ['README.md']
            })
          }]
        }
      })
    ].join('\n'));

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(true);
    expect(result.summary).toBe('Message content summary.');
  });

  it('parses fenced JSON from OpenCode text events', async () => {
    const runner = new FakeRunner(undefined, undefined, JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: '```json\n{"recommendation":"needs_reviewer_judgment","confidence":"low","summary":"Fenced summary.","rationale":"Fenced rationale.","evidenceReferences":["README.md"]}\n```'
      }
    }));

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(true);
    expect(result.summary).toBe('Fenced summary.');
    expect(result.evidenceReferences).toEqual(['README.md']);
  });

  it('extracts valid advisory JSON after stray prose braces and non-advisory JSON', async () => {
    const runner = new FakeRunner(undefined, undefined, JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: [
          'Note: config {timeout} was used before the final answer.',
          '{"note":"debug"}',
          '{"recommendation":"likely_insufficient","confidence":"medium","summary":"Stray brace summary.","rationale":"Stray brace rationale.","evidenceReferences":["README.md"]}'
        ].join('\n')
      }
    }));

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(true);
    expect(result.recommendation).toBe('likely_insufficient');
    expect(result.summary).toBe('Stray brace summary.');
  });

  it('normalizes common off-schema OpenCode advisory fields', async () => {
    const runner = new FakeRunner(undefined, undefined, JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        text: JSON.stringify({
          recommendation: 'pass',
          confidence: 0.78,
          summary: 'Off-schema summary.',
          rationale: 'Off-schema rationale.',
          evidenceReferences: [
            { repoRelativePath: 'README.md', lineRange: '1-2' },
            { path: 'README.md' },
            { repoRelativePath: 'unknown.md' }
          ]
        })
      }
    }));

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(true);
    expect(result.recommendation).toBe('likely_sufficient');
    expect(result.confidence).toBe('high');
    expect(result.evidenceReferences).toEqual(['README.md']);
    expect(result.warnings.join('\n')).toContain('Dropped');
  });

  it('treats parsed but incomplete OpenCode advisory JSON as unavailable', async () => {
    const runner = new FakeRunner(undefined, undefined, JSON.stringify({}));

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('incomplete advisory JSON');
  });

  it('allows empty OpenCode plugin defaults while rejecting configured extension entries', async () => {
    const safeRunner = new FakeRunner(
      JSON.stringify({ plugin: [], agent: {}, provenance: '__CWD__' }),
      JSON.stringify({ permission: [{ permission: 'read', action: 'allow', pattern: '*' }] })
    );
    const safe = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), safeRunner);
    expect(safe.available).toBe(true);

    const unsafeRunner = new FakeRunner(
      JSON.stringify({ plugin: ['custom-plugin'], provenance: '__CWD__' }),
      JSON.stringify({ permission: [{ permission: 'read', action: 'allow', pattern: '*' }] })
    );
    const unsafe = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), unsafeRunner);
    expect(unsafe.available).toBe(false);
    expect(unsafe.errors.join('\n')).toContain('plugin');
  });

  it('rejects scalar OpenCode extension debug entries', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: 'custom-plugin', mcp: {}, provenance: '__CWD__' }),
      JSON.stringify({ permission: [{ permission: 'read', action: 'allow', pattern: '*' }] })
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('plugin');
  });

  it('rejects scalar OpenCode MCP debug entries', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: [], mcp: 'custom-mcp', provenance: '__CWD__' }),
      JSON.stringify({ permission: [{ permission: 'read', action: 'allow', pattern: '*' }] })
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('MCP');
  });

  it('rejects broad or mutating OpenCode permissions from debug output', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: [], provenance: '__CWD__' }),
      JSON.stringify({ permission: [{ permission: '*', action: 'allow', pattern: '*' }] })
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('wildcard');
  });

  it.each(['task', 'skill', 'todowrite', 'lsp', 'question', 'doom_loop', 'write'])(
    'rejects legacy %s permission when it is not denied',
    async permission => {
      const runner = new FakeRunner(
        JSON.stringify({ plugin: [], provenance: '__CWD__' }),
        JSON.stringify({ permission: [{ permission, action: 'allow', pattern: '*' }] })
      );

      const result = await runCriterionAgentReview({
        criterionId: 'S004',
        repositoryPath: repoPath,
        instructions: 'review',
        files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
        schemaDescription: 'schema'
      }, opencodeConfig(), runner);

      expect(result.available).toBe(false);
      expect(result.errors.join('\n')).toContain(permission);
    }
  );

  it('fails closed when OpenCode permission schema is unrecognized', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: [], provenance: '__CWD__' }),
      JSON.stringify({ permissions: { edit: 'allow' }, provenance: '__CWD__' })
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('could not recognize effective permission schema');
  });

  it('uses resolved OpenCode tools over historical permission rows when available', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: [], provenance: '__CWD__' }),
      JSON.stringify({
        permission: [
          { permission: '*', action: 'allow', pattern: '*' },
          { permission: 'edit', action: 'deny', pattern: '*' },
          { permission: 'bash', action: 'deny', pattern: '*' },
          { permission: 'external_directory', action: 'deny', pattern: '*' }
        ],
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
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(true);
  });

  it('rejects mutating OpenCode effective tools', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: [], provenance: '__CWD__' }),
      JSON.stringify({
        permission: [{ permission: 'bash', action: 'deny', pattern: '*' }],
        tools: {
          read: true,
          glob: true,
          grep: true,
          edit: false,
          write: false,
          bash: true,
          task: false,
          webfetch: false,
          websearch: false,
          skill: false,
          todowrite: false
        }
      })
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('bash');
  });

  it('rejects non-false blocked OpenCode effective tool values', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: [], provenance: '__CWD__' }),
      JSON.stringify({
        tools: {
          read: true,
          glob: true,
          grep: true,
          edit: 'allow',
          write: false,
          bash: { enabled: true },
          task: false,
          webfetch: false,
          websearch: false,
          skill: false,
          todowrite: false
        }
      })
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('edit');
  });

  it('rejects object-valued blocked OpenCode effective tools', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: [], provenance: '__CWD__' }),
      JSON.stringify({
        tools: {
          read: true,
          glob: true,
          grep: true,
          edit: false,
          write: false,
          bash: { enabled: true },
          task: false,
          webfetch: false,
          websearch: false,
          skill: false,
          todowrite: false
        }
      })
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('bash');
  });

  it('rejects external-directory OpenCode effective tool access', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: [], provenance: '__CWD__' }),
      JSON.stringify({
        tools: {
          read: true,
          glob: true,
          grep: true,
          list: true,
          external_directory: true
        }
      })
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('external_directory');
  });

  it('allows OpenCode sentinel and read-only effective tools', async () => {
    const runner = new FakeRunner(
      JSON.stringify({ plugin: [], provenance: '__CWD__' }),
      JSON.stringify({
        tools: {
          invalid: true,
          read: true,
          glob: true,
          grep: true,
          list: true,
          todoread: true,
          question: false,
          bash: false,
          edit: false,
          write: false,
          task: false,
          webfetch: false,
          todowrite: false,
          skill: false
        }
      })
    );

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), runner);

    expect(result.available).toBe(true);
  });

  it('rejects trusted config and auth paths inside the evaluated repo', async () => {
    const insidePath = path.join(repoPath, 'missing-opencode.json');

    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, { ...opencodeConfig(), trustedConfigPath: insidePath }, new FakeRunner());

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('inside the evaluated repository');
  });

  it('returns unavailable when trusted auth material cannot be copied', async () => {
    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, {
      ...opencodeConfig(),
      trustedAuthStorePath: path.join(os.tmpdir(), 'missing-opencode-auth.json')
    }, new FakeRunner());

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('Unable to materialize OpenCode invocation');
  });

  it('fails closed when OpenCode debug output is not parseable JSON', async () => {
    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, opencodeConfig(), new FakeRunner('plain text provenance __CWD__'));

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('debug output was not parseable JSON');
  });

  it('copies trusted OpenCode auth material under the generated opencode data root', () => {
    const workspace = prepareCriterionReviewWorkspace({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    });
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-'));
    const authPath = path.join(authDir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({ openrouter: { type: 'api', key: 'redacted' } }));

    try {
      const invocation = materializeOpenCodeInvocation(workspace, {
        ...opencodeConfig(),
        trustedAuthStorePath: authPath
      });
      const copiedAuthPath = path.join(invocation.env.XDG_DATA_HOME!, 'opencode', 'auth.json');

      expect(fs.existsSync(copiedAuthPath)).toBe(true);
      expect(fs.statSync(copiedAuthPath).mode & 0o777).toBe(0o600);
    } finally {
      removeRuntime(workspace);
      fs.rmSync(workspace.rootPath, { recursive: true, force: true });
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  });

  it('generates isolated OpenRouter config and auth from first-class provider env', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-secret';
    const workspace = prepareCriterionReviewWorkspace({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    });

    try {
      const invocation = materializeOpenCodeInvocation(workspace, {
        ...opencodeConfig(),
        modelLabel: 'openrouter/openrouter/free',
        endpoint: undefined,
        endpointFamily: 'openrouter',
        generatedProvider: {
          name: 'openrouter',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          modelEnv: 'OPENROUTER_MODEL',
          modelId: 'openrouter/free',
          modelSelector: 'openrouter/openrouter/free'
        },
        providerEnvAllowlist: ['OPENROUTER_API_KEY']
      });
      const generatedConfig = JSON.parse(fs.readFileSync(invocation.env.OPENCODE_CONFIG!, 'utf-8'));
      const generatedAuthPath = path.join(invocation.env.XDG_DATA_HOME!, 'opencode', 'auth.json');
      const generatedAuth = JSON.parse(fs.readFileSync(generatedAuthPath, 'utf-8'));

      expect(generatedConfig.model).toBe('openrouter/openrouter/free');
      expect(generatedConfig.provider.openrouter.models['openrouter/free']).toEqual({});
      expect(generatedConfig.agent.reviewer.permission).toEqual(expect.objectContaining({
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        edit: 'deny',
        bash: 'deny'
      }));
      expect(generatedAuth).toEqual({
        openrouter: {
          type: 'api',
          key: 'sk-or-test-secret'
        }
      });
      expect(fs.statSync(generatedAuthPath).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(generatedConfig)).not.toContain('sk-or-test-secret');
      expect(invocation.runtimeRootPath.startsWith(workspace.rootPath)).toBe(false);
    } finally {
      removeRuntime(workspace);
      fs.rmSync(workspace.rootPath, { recursive: true, force: true });
    }
  });

  it('removes OpenCode auth data from retained debug workspaces after the run', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-secret';
    const runner = new FakeRunner();
    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, {
      ...opencodeConfig(),
      debugRetainWorkspace: true,
      modelLabel: 'openrouter/openrouter/free',
      endpoint: undefined,
      endpointFamily: 'openrouter',
      generatedProvider: {
        name: 'openrouter',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        modelEnv: 'OPENROUTER_MODEL',
        modelId: 'openrouter/free',
        modelSelector: 'openrouter/openrouter/free'
      },
      providerEnvAllowlist: ['OPENROUTER_API_KEY']
    }, runner);

    const retainedWorkspace = result.metadata?.retainedWorkspacePath;
    const runRequest = runner.requests.find(request => request.args?.[0] === 'run');
    const runtimeDataHome = runRequest?.env?.XDG_DATA_HOME;
    expect(result.available).toBe(true);
    expect(retainedWorkspace).toBeDefined();
    expect(runtimeDataHome).toBeDefined();

    try {
      expect(fs.existsSync(path.join(retainedWorkspace!, '.opencode-runtime'))).toBe(false);
      expect(fs.existsSync(path.dirname(runtimeDataHome!))).toBe(false);
    } finally {
      fs.rmSync(retainedWorkspace!, { recursive: true, force: true });
    }
  });

  it('returns a clear unavailable result when generated provider auth env is absent', async () => {
    const result = await runCriterionAgentReview({
      criterionId: 'S004',
      repositoryPath: repoPath,
      instructions: 'review',
      files: [{ repoRelativePath: 'README.md', content: 'Configuration values.' }],
      schemaDescription: 'schema'
    }, {
      ...opencodeConfig(),
      modelLabel: 'openrouter/openrouter/free',
      generatedProvider: {
        name: 'openrouter',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        modelEnv: 'OPENROUTER_MODEL',
        modelId: 'openrouter/free',
        modelSelector: 'openrouter/openrouter/free'
      }
    }, new FakeRunner());

    expect(result.available).toBe(false);
    expect(result.errors.join('\n')).toContain('OPENROUTER_API_KEY is required');
  });

  function opencodeConfig(): CriterionAgentReviewConfig {
    return {
      enabled: true,
      enabledCriteria: ['S004'],
      adapter: 'opencode',
      modelLabel: 'test-model',
      readOnlyAgentName: 'reviewer',
      endpoint: 'https://api.example.test',
      endpointFamily: 'openai-compatible'
    };
  }

  function removeRuntime(workspace: { runtimeRootPath?: string }): void {
    if (workspace.runtimeRootPath) {
      fs.rmSync(workspace.runtimeRootPath, { recursive: true, force: true });
    }
  }
});
