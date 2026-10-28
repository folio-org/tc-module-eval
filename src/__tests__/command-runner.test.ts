import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { LocalCommandRunner, sanitizeCommandOutput } from '../utils/command-runner';
import { createEvaluationRun } from '../utils/evaluation-run';
import { EVALUATOR_SECRETS, SECRET_NAMES, withEnvironment, withEvaluatorSecrets } from './helpers/evaluator-secrets';

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

  it("masks each of the evaluator's secrets, every time it appears, in stdout, stderr and the error message", async () => {
    const values = Object.values(EVALUATOR_SECRETS);
    const script = `const text = ${JSON.stringify(values.map(value => `${value} then ${value}`).join('\n'))};`
      + 'process.stdout.write(text); process.stderr.write(text); process.exit(2)';
    const result = await withEvaluatorSecrets(() =>
      new LocalCommandRunner(true).run({ command: 'node', args: ['-e', script], cwd: process.cwd() }));

    expect(result.status).toBe('failed');
    const expected = SECRET_NAMES.map(name => `[REDACTED_${name}] then [REDACTED_${name}]`).join('\n');
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe(expected);
    expect(result.errorMessage).toBe(`Command exited with code 2: ${expected}`);
  });

  it.each(['stdout', 'stderr'] as const)('drops the start of a secret that the %s capture limit cut', async stream => {
    const secret = EVALUATOR_SECRETS.SONAR_TOKEN;
    const script = `process.${stream}.write('x'.repeat(100) + ${JSON.stringify(secret)} + ' rest')`;
    const result = await withEvaluatorSecrets(() => new LocalCommandRunner(true).run({
      command: 'node', args: ['-e', script], cwd: process.cwd(), maxOutputBytes: 110
    }));

    expect(result[stream]).toBe(`${'x'.repeat(100)}\n[output truncated to 110 bytes]`);
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
    const termFile = path.join(tempDir, 'term');
    const child = `const fs = require("fs");
      process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termFile)}, ""));
      fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));
      fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
      setInterval(() => {}, 1000);`;
    let pid: number | undefined;

    // Fake timers hold the runner's timeout until the child ignores SIGTERM and has written its pid; a
    // real 100 ms timeout can kill a slow-starting child first. The child process itself runs for real.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let settled = false;
      const pending = runner.run({ command: 'node', args: ['-e', child], cwd: process.cwd(), timeoutMs: 100 });
      void pending.then(() => { settled = true; });
      const waitForFile = async (file: string): Promise<void> => {
        while (!fs.existsSync(file)) {
          if (settled) throw new Error(`The command ended before writing ${path.basename(file)}: ${(await pending).errorMessage}`);
          await delay(5);
        }
      };

      await waitForFile(pidFile);
      pid = Number(fs.readFileSync(pidFile, 'utf-8'));
      jest.advanceTimersByTime(100);
      await waitForFile(termFile);
      // The child got SIGTERM and kept running; SIGKILL follows only after the full 250 ms grace.
      jest.advanceTimersByTime(249);
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(1);
      expect(jest.getTimerCount()).toBe(0);
      const result = await pending;

      expect(result.status).toBe('timed_out');
      expect(result.signal).toBe('SIGKILL');
      expect(result.errorMessage).toBe('Command timed out after 100ms plus 250ms grace (350ms elapsed) (signal: SIGKILL)');
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      jest.useRealTimers();
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

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

  it('keeps the last whole lines of oversized stdout only when asked', async () => {
    const request = {
      command: process.execPath,
      args: ['-e', 'for (let i = 0; i < 2000; i++) process.stdout.write(`line ${String(i).padStart(4, "0")} token=SECRET${i}\\n`)'],
      cwd: process.cwd(),
      maxOutputBytes: 1000
    };
    const runner = new LocalCommandRunner();
    // The kept tail is masked too.
    const tail = await withEnvironment({ SONAR_TOKEN: 'SECRET1999' }, () => runner.run({ ...request, keepStdoutTail: true }));
    const head = await runner.run(request);

    const [marker, ...lines] = tail.stdout.trimEnd().split('\n');
    expect(tail.stdoutTruncated).toBe(true);
    expect(tail.stdoutBytes).toBe(head.stdoutBytes);
    expect(tail.stdoutBytes).toBeGreaterThan(40000);
    expect(marker).toMatch(/^\[output truncated: kept the last \d+ of \d+ bytes\]$/);
    expect(lines[lines.length - 1]).toBe('line 1999 token=[REDACTED_SONAR_TOKEN]');
    expect(lines.length).toBeGreaterThan(20);
    expect(Buffer.byteLength(lines.join('\n').replace('[REDACTED_SONAR_TOKEN]', 'SECRET1999'))).toBeLessThanOrEqual(1000);
    expect(lines.slice(0, -1).every(line => /^line \d{4} token=SECRET\d+$/.test(line))).toBe(true);
    expect(head.stdout).toContain('line 0000');
    expect(head.stdout).not.toContain('line 1999');
    expect(runner.normalize({ ...request, keepStdoutTail: true })).not.toBe(runner.normalize(request));
    const none = await runner.run({ ...request, keepStdoutTail: true, maxOutputBytes: 0 });
    expect(none).toMatchObject({ status: 'success', stdoutBytes: tail.stdoutBytes, stdoutTruncated: true });
  });

  it('masks a secret before bounding output, so the bound cannot cut it', async () => {
    const secret = EVALUATOR_SECRETS.GITHUB_TOKEN;
    const output = await withEvaluatorSecrets(() => sanitizeCommandOutput(`${'x'.repeat(20)}${secret}`, 30));

    expect(output).toBe(`${'x'.repeat(20)}[REDACTED_\n[output truncated to 30 bytes]`);
  });

  it('distinguishes exact byte capture, overflow, and a literal truncation marker', async () => {
    const runner = new LocalCommandRunner();
    const output = JSON.stringify({ text: 'é [output truncated to 20 bytes]' });
    const request = { command: process.execPath,
      args: ['-e', 'const b = Buffer.from(process.env.TEST_WIRE); process.stdout.write(b.subarray(0, 10)); process.stdout.write(b.subarray(10))'],
      cwd: process.cwd(), env: { TEST_WIRE: output }, stdoutFormat: 'json' as const,
      maxOutputBytes: Buffer.byteLength(output) };
    const exact = await runner.run(request);
    expect(exact.stdout).toBe(output);
    expect(exact.stdoutBytes).toBe(Buffer.byteLength(output));
    expect(exact.stdoutTruncated).toBe(false);
    const overflow = await runner.run({ ...request, maxOutputBytes: request.maxOutputBytes - 1 });
    expect(overflow.stdoutTruncated).toBe(true);
    expect(overflow.stdout).not.toContain('\uFFFD');
    expect(runner.normalize(request)).not.toBe(runner.normalize({ ...request, stdoutFormat: 'text' }));
  });

  it('reports sanitized representation overflow without publishing broken JSON', async () => {
    // The placeholder is longer than the short key it replaces.
    const output = '{"key":"k3y-1234"}';
    const result = await withEnvironment({ OPENAI_API_KEY: 'k3y-1234' }, () => new LocalCommandRunner().run({ command: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.TEST_WIRE)'], cwd: process.cwd(),
      env: { TEST_WIRE: output }, stdoutFormat: 'json', maxOutputBytes: Buffer.byteLength(output) }));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytes).toBe(Buffer.byteLength(output));
    expect(result.stdout).toBe('');
  });
});
