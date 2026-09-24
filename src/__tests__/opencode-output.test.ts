import { LocalCommandRunner } from '../utils/command-runner';
import { parseOpenCodeReviewPayload } from '../utils/opencode-output';

const advisory = {
  recommendation: 'needs_reviewer_judgment', confidence: 'medium',
  summary: 'Example password=[REDACTED]', rationale: 'Inspect README.md.',
  evidenceReferences: ['README.md']
};
const textEvent = (text: string) => ({ type: 'text', part: { type: 'text', text } });
const wire = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n');

async function capture(output: string, maxOutputBytes = 1024 * 1024) {
  const request = {
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.TEST_WIRE ?? "")'],
    cwd: process.cwd(), env: { TEST_WIRE: output }, maxOutputBytes,
    stdoutFormat: 'opencode-json' as const
  };
  return new LocalCommandRunner().run(request);
}

describe('structured OpenCode capture', () => {
  it.each([
    ['direct', JSON.stringify(advisory)],
    ['nested', wire(textEvent(JSON.stringify(advisory)))],
    ['fenced', wire(textEvent('```json\n' + JSON.stringify(advisory) + '\n```'))],
    ['prose', wire(textEvent('Note: config {timeout}.\n{"note":"debug"}\n' + JSON.stringify(advisory)))]
  ])('preserves %s JSON through real capture', async (_name, output) => {
    const result = await capture(output);
    expect(result.status).toBe('success');
    expect(parseOpenCodeReviewPayload(result.stdout)).toEqual(advisory);
  });

  it('redacts secrets at nested encoding boundaries and in property names', async () => {
    const secret = 'synthetic-credential';
    const result = await capture(wire(
      { type: 'tool_use', part: { output: JSON.stringify({ password: { value: secret } }) } },
      textEvent(JSON.stringify({ ...advisory, summary: 'password="synthetic-credential\\tail"',
        password: [secret], ['https://user:synthetic-credential@example.org']: secret }))
    ));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(parseOpenCodeReviewPayload(result.stdout)?.summary).toContain('[REDACTED]');
  });

  it.each([
    '{"password":"synthetic-credential',
    wire(textEvent('{"password":"synthetic-credential')),
    wire({ type: 'tool_use', part: { output: '{"password":"synthetic-credential' } })
  ])('discards unsafe malformed fragments: %s', async output => {
    const result = await capture(wire(textEvent(JSON.stringify(advisory))) + '\n' + output);
    expect(JSON.stringify(result)).not.toContain('synthetic-credential');
    expect(parseOpenCodeReviewPayload(result.stdout)).toBeUndefined();
  });
});

// OpenCode v1.17.11 immutable CLI contract and subprocess fixtures:
// https://github.com/anomalyco/opencode/blob/7c0e1b431cfe1849f45e42447bc6101a2c226d46/packages/opencode/src/cli/cmd/run.ts#L720-L799
// https://github.com/anomalyco/opencode/blob/7c0e1b431cfe1849f45e42447bc6101a2c226d46/packages/opencode/test/cli/run/run-process.test.ts#L107-L247
const start = (messageID = 'msg_a') => ({ type: 'step_start', part: { type: 'step-start', messageID } });
const text = (value = JSON.stringify(advisory), messageID = 'msg_a') => ({
  type: 'text', part: { type: 'text', messageID, text: value, time: { start: 1, end: 2 } }
});
const finish = (reason = 'stop', messageID = 'msg_a') => ({
  type: 'step_finish', part: { type: 'step-finish', messageID, reason }
});

describe('final OpenCode answer selection', () => {
  it.each([
    [start(), text(), finish('length')],
    [start(), text(), finish('unknown')],
    [start(), text(), finish('tool-calls')],
    [start(), text()],
    [start(), text(), finish(), start('msg_b')],
    [start(), text(), finish(), start('msg_b'), finish('stop', 'msg_b')],
    [start(), text(), finish(), start('msg_b'), text('broken', 'msg_b'), finish('stop', 'msg_b')],
    [textEvent(JSON.stringify(advisory)), textEvent('broken')],
    [textEvent(JSON.stringify(advisory) + '\n{"recommendation":')],
    [textEvent(JSON.stringify(advisory)), { type: 'error', error: { name: 'APIError', data: { message: 'failure' } } }]
  ])('does not recover stale advice from incomplete final output %#', (...events) => {
    expect(parseOpenCodeReviewPayload(wire(...events))).toBeUndefined();
  });

  it('accepts a completed continuation and only its final advice', () => {
    const final = { ...advisory, summary: 'Final summary' };
    expect(parseOpenCodeReviewPayload(wire(start(), text(), finish('tool-calls'),
      start('msg_b'), text(JSON.stringify(final), 'msg_b'), finish('stop', 'msg_b')))).toEqual(final);
  });

  it('combines completed parts only within the same native step', () => {
    const value = JSON.stringify(advisory);
    const boundary = value.indexOf(',') + 1;
    expect(parseOpenCodeReviewPayload(wire(start(), text(value.slice(0, boundary)), text(value.slice(boundary)), finish()))).toEqual(advisory);
  });
});
