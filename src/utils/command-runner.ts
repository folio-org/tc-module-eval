import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';
import {
  CommandExecutionRequest,
  CommandExecutionResult,
  CommandExecutionEnvironment,
  CommandRunner,
  EvaluationRun
} from '../types';
import { redactSensitiveText } from './redaction';
import { isDirectory } from './repo-files';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_GRACE_MS = 250;

export function normalizeCommandRequest(
  request: CommandExecutionRequest,
  allowLocalCommands: boolean = false,
  commandExecutionEnvironment: CommandExecutionEnvironment = 'local'
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
    allowLocalCommands,
    commandExecutionEnvironment,
    network
  });
}

export function sanitizeCommandOutput(output: string, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): string {
  return redactSensitiveText(output, maxBytes);
}

export interface LocalCommandRunnerOptions {
  allowLocalCommands?: boolean;
  commandExecutionEnvironment?: CommandExecutionEnvironment;
}

export class LocalCommandRunner implements CommandRunner {
  private readonly allowLocalCommands: boolean;
  private readonly commandExecutionEnvironment: CommandExecutionEnvironment;

  constructor(options: boolean | LocalCommandRunnerOptions = false) {
    const resolvedOptions = typeof options === 'boolean'
      ? { allowLocalCommands: options }
      : options;

    this.allowLocalCommands = resolvedOptions.allowLocalCommands ?? false;
    this.commandExecutionEnvironment = resolvedOptions.commandExecutionEnvironment ?? 'local';
  }

  normalize(request: CommandExecutionRequest): string {
    return normalizeCommandRequest(request, this.allowLocalCommands, this.commandExecutionEnvironment);
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

    if (this.requiresPolicyEnforcement(request) && !this.allowLocalCommands) {
      const blocked = this.result(request, identity, cwd, args, started, {
        status: 'blocked',
        errorMessage: 'Command requires build-tool execution, but local commands are not allowed'
      });
      evaluationRun?.commandObservations.set(identity, blocked);
      return blocked;
    }

    if (!isDirectory(cwd)) {
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
        env: this.buildEnv(request),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let completed = false;
      let forceKillTimeout: NodeJS.Timeout | undefined;
      let forcedSignal: string | undefined;

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

      const finish = (values: Partial<CommandExecutionResult> & Pick<CommandExecutionResult, 'status'>): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(timeout);
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
        resolve(this.result(request, identity, cwd, args, started, values));
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          forcedSignal = 'SIGKILL';
          child.kill('SIGKILL');
        }, FORCE_KILL_GRACE_MS);
      }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.on('error', error => {
        finish({
          status: 'failed',
          errorMessage: sanitizeCommandOutput(error.message, maxOutputBytes)
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        const stdout = this.formatCapturedOutput(stdoutChunks, stdoutBytes, maxOutputBytes);
        const stderr = this.formatCapturedOutput(stderrChunks, stderrBytes, maxOutputBytes);
        const status = timedOut ? 'timed_out' : code === 0 ? 'success' : 'failed';
        const resolvedSignal = signal ?? forcedSignal;
        finish({
          status,
          exitCode: code,
          signal: resolvedSignal,
          stdout,
          stderr,
          errorMessage: status === 'timed_out'
            ? sanitizeCommandOutput(this.formatTimeoutMessage(started, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, resolvedSignal, stderr), maxOutputBytes)
            : status === 'failed'
              ? sanitizeCommandOutput(`Command exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`, maxOutputBytes)
              : undefined
        });
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

  private formatTimeoutMessage(started: number, configuredTimeoutMs: number, signal?: string | null, stderr?: string): string {
    const elapsedMs = Date.now() - started;
    const elapsed = signal === 'SIGKILL' && elapsedMs > configuredTimeoutMs
      ? `${configuredTimeoutMs}ms plus ${elapsedMs - configuredTimeoutMs}ms grace (${elapsedMs}ms elapsed)`
      : `${configuredTimeoutMs}ms`;
    return `Command timed out after ${elapsed}${signal ? ` (signal: ${signal})` : ''}${stderr ? `: ${stderr}` : ''}`;
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
      commandExecutionEnvironment: this.commandExecutionEnvironment,
      localCommandsAllowed: this.allowLocalCommands,
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
