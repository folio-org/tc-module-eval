import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandExecutionMode,
  CommandRunner,
  EvaluationRun
} from '../types';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const SECRET_PATTERNS = [
  /(token|password|passwd|secret|api[_-]?key)=([^\s]+)/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g
];

export function normalizeCommandRequest(
  request: CommandExecutionRequest,
  executionMode: CommandExecutionMode = 'strict'
): string {
  const args = request.args ?? [];
  const env = Object.entries(request.env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  const envHash = createHash('sha256')
    .update(JSON.stringify(env))
    .digest('hex');
  const network = request.networkPolicy
    ? `${request.networkPolicy.default}:${(request.networkPolicy.allowedHosts ?? []).sort().join(',')}`
    : 'network:default';

  return JSON.stringify({
    command: request.command,
    args,
    cwd: path.resolve(request.cwd),
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    envHash,
    requiresIsolation: request.requiresIsolation === true,
    executionMode,
    network
  });
}

export function sanitizeCommandOutput(output: string, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): string {
  let sanitized = output;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, match => {
      const separator = match.includes('=') ? match.indexOf('=') + 1 : 0;
      return separator > 0 ? `${match.slice(0, separator)}[REDACTED]` : '[REDACTED]';
    });
  }

  const buffer = Buffer.from(sanitized);
  if (buffer.length <= maxBytes) {
    return sanitized;
  }

  return `${buffer.subarray(0, maxBytes).toString('utf-8')}\n[output truncated to ${maxBytes} bytes]`;
}

export interface LocalCommandRunnerOptions {
  executionMode?: CommandExecutionMode;
}

export class LocalCommandRunner implements CommandRunner {
  private readonly executionMode: CommandExecutionMode;

  constructor(options: boolean | LocalCommandRunnerOptions = false) {
    this.executionMode = typeof options === 'boolean'
      ? options ? 'sandboxed' : 'strict'
      : options.executionMode ?? 'strict';
  }

  normalize(request: CommandExecutionRequest): string {
    return normalizeCommandRequest(request, this.executionMode);
  }

  async run(request: CommandExecutionRequest, evaluationRun?: EvaluationRun): Promise<CommandExecutionResult> {
    const identity = this.normalize(request);
    const cached = evaluationRun?.commandObservations.get(identity);
    if (cached) {
      return cached;
    }

    const started = Date.now();
    const args = request.args ?? [];
    const cwd = path.resolve(request.cwd);
    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    if (this.requiresPolicyEnforcement(request) && !this.canRunPolicyBoundCommands()) {
      const blocked = this.result(request, identity, cwd, args, started, {
        status: 'blocked',
        errorMessage: `Command requires isolation or network policy enforcement, but execution mode '${this.executionMode}' does not allow it`
      });
      evaluationRun?.commandObservations.set(identity, blocked);
      return blocked;
    }

    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      const blocked = this.result(request, identity, cwd, args, started, {
        status: 'blocked',
        errorMessage: `Command working directory is not a directory: ${cwd}`
      });
      evaluationRun?.commandObservations.set(identity, blocked);
      return blocked;
    }

    const result = await this.spawnCommand(request, identity, cwd, args, started, maxOutputBytes);
    evaluationRun?.commandObservations.set(identity, result);
    return result;
  }

  private requiresPolicyEnforcement(request: CommandExecutionRequest): boolean {
    return request.requiresIsolation === true || request.networkPolicy?.default === 'deny';
  }

  private canRunPolicyBoundCommands(): boolean {
    return this.executionMode !== 'strict';
  }

  private spawnCommand(
    request: CommandExecutionRequest,
    identity: string,
    cwd: string,
    args: string[],
    started: number,
    maxOutputBytes: number
  ): Promise<CommandExecutionResult> {
    return new Promise(resolve => {
      const child = spawn(request.command, args, {
        cwd,
        env: this.buildEnv(request)
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;

      const appendBounded = (chunks: Buffer[], currentBytes: number, chunk: Buffer): number => {
        if (currentBytes >= maxOutputBytes) {
          return currentBytes + chunk.length;
        }
        const remaining = maxOutputBytes - currentBytes;
        chunks.push(chunk.subarray(0, remaining));
        return currentBytes + chunk.length;
      };

      child.stdout?.on('data', chunk => {
        stdoutBytes = appendBounded(stdoutChunks, stdoutBytes, Buffer.from(chunk));
      });
      child.stderr?.on('data', chunk => {
        stderrBytes = appendBounded(stderrChunks, stderrBytes, Buffer.from(chunk));
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.on('error', error => {
        clearTimeout(timeout);
        resolve(this.result(request, identity, cwd, args, started, {
          status: 'failed',
          errorMessage: sanitizeCommandOutput(error.message, maxOutputBytes)
        }));
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        const stdout = this.formatCapturedOutput(stdoutChunks, stdoutBytes, maxOutputBytes);
        const stderr = this.formatCapturedOutput(stderrChunks, stderrBytes, maxOutputBytes);
        const status = timedOut ? 'timed_out' : code === 0 ? 'success' : 'failed';
        resolve(this.result(request, identity, cwd, args, started, {
          status,
          exitCode: code,
          signal,
          stdout,
          stderr,
          errorMessage: status === 'failed'
            ? sanitizeCommandOutput(`Command exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`, maxOutputBytes)
            : undefined
        }));
      });
    });
  }

  private formatCapturedOutput(chunks: Buffer[], totalBytes: number, maxOutputBytes: number): string {
    const output = sanitizeCommandOutput(Buffer.concat(chunks).toString('utf-8'), maxOutputBytes);
    if (totalBytes <= maxOutputBytes || output.includes('output truncated')) {
      return output;
    }
    return `${output}\n[output truncated to ${maxOutputBytes} bytes]`;
  }

  private buildEnv(request: CommandExecutionRequest): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    if (process.env.PATH) {
      env.PATH = process.env.PATH;
    }

    for (const [key, value] of Object.entries(request.env ?? {})) {
      if (value !== undefined) {
        env[key] = value;
      }
    }

    return env;
  }

  private result(
    request: CommandExecutionRequest,
    identity: string,
    cwd: string,
    args: string[],
    started: number,
    values: Partial<CommandExecutionResult> & Pick<CommandExecutionResult, 'status'>
  ): CommandExecutionResult {
    return {
      identity,
      command: request.command,
      args,
      cwd,
      executionMode: this.executionMode,
      status: values.status,
      exitCode: values.exitCode,
      signal: values.signal,
      durationMs: Date.now() - started,
      stdout: values.stdout ?? '',
      stderr: values.stderr ?? '',
      errorMessage: values.errorMessage,
      sanitized: true
    };
  }
}

export const defaultCommandRunner = new LocalCommandRunner();
