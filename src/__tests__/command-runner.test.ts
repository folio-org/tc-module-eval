import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalCommandRunner, sanitizeCommandOutput } from '../utils/command-runner';
import { createEvaluationRun } from '../utils/evaluation-run';

describe('CommandRunner', () => {
  it('should block build-tool commands when local commands are not allowed', async () => {
    const runner = new LocalCommandRunner(false);
    const result = await runner.run({
      command: 'node',
      args: ['-e', 'throw new Error("should not run")'],
      cwd: process.cwd(),
      requiresIsolation: true
    });

    expect(result.status).toBe('blocked');
    expect(result.errorMessage).toContain('local commands are not allowed');
  });

  it('should cache equivalent normalized commands in one EvaluationRun', async () => {
    const runner = new LocalCommandRunner(true);
    const run = createEvaluationRun({
      repositoryPath: process.cwd(),
      language: 'java',
      commandRunner: runner
    });

    const request = {
      command: 'node',
      args: ['-e', 'process.stdout.write("ok")'],
      cwd: process.cwd()
    };
    const first = await runner.run(request, run);
    const second = await runner.run({ ...request }, run);

    expect(first.status).toBe('success');
    expect(second).toBe(first);
    expect(run.commandObservations.size).toBe(1);
  });

  it('should not reuse cached commands when output bounds or env differ', async () => {
    const runner = new LocalCommandRunner(true);
    const run = createEvaluationRun({
      repositoryPath: process.cwd(),
      language: 'java',
      commandRunner: runner
    });

    const first = await runner.run({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.TEST_VALUE ?? "")'],
      cwd: process.cwd(),
      env: { TEST_VALUE: 'one' },
      maxOutputBytes: 8
    }, run);
    const second = await runner.run({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.TEST_VALUE ?? "")'],
      cwd: process.cwd(),
      env: { TEST_VALUE: 'two' },
      maxOutputBytes: 8
    }, run);
    const third = await runner.run({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.TEST_VALUE ?? "")'],
      cwd: process.cwd(),
      env: { TEST_VALUE: 'two' },
      maxOutputBytes: 16
    }, run);

    expect(first.stdout).toBe('one');
    expect(second.stdout).toBe('two');
    expect(third.stdout).toBe('two');
    expect(run.commandObservations.size).toBe(3);
  });

  it('should block deny-by-default network policies when local commands are not allowed', async () => {
    const runner = new LocalCommandRunner(false);
    const result = await runner.run({
      command: 'node',
      args: ['-e', 'process.stdout.write("should not run")'],
      cwd: process.cwd(),
      networkPolicy: { default: 'deny', allowedHosts: ['registry.npmjs.org'] }
    });

    expect(result.status).toBe('blocked');
    expect(result.errorMessage).toContain('local commands are not allowed');
  });

  it('should run policy-bound commands when local commands are explicitly allowed', async () => {
    const runner = new LocalCommandRunner({ allowLocalCommands: true });
    const result = await runner.run({
      command: 'node',
      args: ['-e', 'process.stdout.write("trusted")'],
      cwd: process.cwd(),
      requiresIsolation: true,
      networkPolicy: { default: 'deny', allowedHosts: ['registry.npmjs.org'] }
    });

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('trusted');
    expect(result.localCommandsAllowed).toBe(true);
    expect(result.commandExecutionEnvironment).toBe('local');
  });

  it('should include local command permission in the cache identity', async () => {
    const strictRunner = new LocalCommandRunner(false);
    const trustedRunner = new LocalCommandRunner({ allowLocalCommands: true });
    const request = {
      command: 'node',
      args: ['-e', 'process.stdout.write("ok")'],
      cwd: process.cwd()
    };

    expect(strictRunner.normalize(request)).not.toBe(trustedRunner.normalize(request));
  });

  it('should return nonzero exits as structured command results', async () => {
    const runner = new LocalCommandRunner(true);
    const result = await runner.run({
      command: 'node',
      args: ['-e', 'process.stderr.write("bad"); process.exit(7)'],
      cwd: process.cwd()
    });

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe('bad');
  });

  it('should sanitize failed command error messages', async () => {
    const runner = new LocalCommandRunner(true);
    const result = await runner.run({
      command: 'node',
      args: ['-e', 'process.stderr.write("token=supersecret"); process.exit(2)'],
      cwd: process.cwd()
    });

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('token=[REDACTED]');
    expect(result.errorMessage).not.toContain('supersecret');
  });

  it('should include timeout details for timed out commands', async () => {
    const runner = new LocalCommandRunner(true);
    const result = await runner.run({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 25
    });

    expect(result.status).toBe('timed_out');
    expect(result.errorMessage).toContain('Command timed out after 25ms');
  });

  it('should force-complete timed out commands that ignore SIGTERM', async () => {
    const runner = new LocalCommandRunner(true);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-runner-'));
    const pidFile = path.join(tempDir, 'pid');

    try {
      const result = await runner.run({
        command: 'node',
        args: ['-e', `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`],
        cwd: process.cwd(),
        timeoutMs: 100
      });
      const pid = Number(fs.readFileSync(pidFile, 'utf-8'));

      expect(result.status).toBe('timed_out');
      expect(result.signal).toBe('SIGKILL');
      expect(result.errorMessage).toContain('Command timed out after 100ms plus');
      expect(result.errorMessage).toContain('elapsed');
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should truncate oversized successful output without failing the command', async () => {
    const runner = new LocalCommandRunner(true);
    const result = await runner.run({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(100))'],
      cwd: process.cwd(),
      maxOutputBytes: 12
    });

    expect(result.status).toBe('success');
    expect(result.stdout).toContain('output truncated');
  });

  it('should sanitize and bound command output', () => {
    const output = sanitizeCommandOutput('token=abc123\n' + 'x'.repeat(40), 30);

    expect(output).toContain('token=[REDACTED]');
    expect(output).toContain('output truncated');
    expect(output).not.toContain('abc123');
  });
});
