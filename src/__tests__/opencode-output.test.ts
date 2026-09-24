import { LocalCommandRunner } from '../utils/command-runner';
import { decodeOpenCodeOutput, parseOpenCodeReviewPayload } from '../utils/opencode-output';

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
    `password='{"value":"SYNTHETIC_SECRET"}'`,
    `password='{"value":"SYNTHETIC_SECRET"}`,
    '-----BEGIN PRIVATE KEY-----\n{"value":"SYNTHETIC_SECRET"}\n-----END PRIVATE KEY-----'
  ])('redacts secret context enclosing inline JSON', async output => {
    const result = await capture(wire({ type: 'tool_use', part: { output } }));
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });

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
    wire(textEvent('{"password":"synthetic-credential'))
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
  it('omits incomplete read previews without rejecting valid final advice', async () => {
    const file = JSON.stringify({ entries: Array.from({ length: 25 }, (_, index) => `entry ${index}`) }, null, 2);
    const tool = { type: 'tool_use', part: { messageID: 'msg_a', type: 'tool', tool: 'read', state: {
      status: 'completed', output: file.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n'),
      metadata: { preview: file.split('\n').slice(0, 20).join('\n'), secret: 'SYNTHETIC_SECRET' }
    } } };
    const result = await capture(wire(start(), text('Examples use ${foo:bar}.'), tool, finish('tool-calls'),
      start('msg_b'), text(undefined, 'msg_b'), finish('stop', 'msg_b')));
    expect(parseOpenCodeReviewPayload(result.stdout)).toEqual(advisory);
    expect(result.stdout).not.toContain('entry 0');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });

  it.each(['prose', 'fenced'])('redacts decoded values in %s JSON without corrupting escapes', async wrapper => {
    const payload = { ...advisory, summary: 'Use password="SYNTHETIC_SECRET" in docs.' };
    const value = JSON.stringify(payload);
    const answer = wrapper === 'prose' ? 'Result:\n' + value : '```json\n' + value + '\n```';
    const result = await capture(wire(start(), text(answer), finish()));
    expect(parseOpenCodeReviewPayload(result.stdout)).toEqual({ ...payload, summary: 'Use password="[REDACTED]" in docs.' });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });

  it('preserves literal JSON-like prose and inline backticks in advisory values', async () => {
    const payload = { ...advisory, summary: 'Examples use ${foo:bar} and ```json code blocks.' };
    const result = await capture(wire(start(), text('```json\n' + JSON.stringify(payload) + '\n```'), finish()));
    expect(parseOpenCodeReviewPayload(result.stdout)).toEqual(payload);
  });

  it('retains tool lifecycle boundaries while dropping tool contents', async () => {
    const result = await capture(wire(start(), text(), finish(), { type: 'tool_use', part: { messageID: 'msg_a', output: 'private' } }));
    expect(decodeOpenCodeOutput(result.stdout).failure).toBe('incomplete_response');
    expect(result.stdout).not.toContain('private');
  });

  it('reports content-free diagnostics and rejects a malformed replacement after a tool boundary', async () => {
    const result = await capture(wire(start(), text(), { type: 'tool_use', part: { messageID: 'msg_a' } },
      text('{"password":"SYNTHETIC_SECRET'), finish()));
    expect(decodeOpenCodeOutput(result.stdout)).toMatchObject({ failure: 'malformed_json', diagnostic: 'final assistant JSON invalid' });
    expect(result.stdoutDiagnostics).toContain('record 4: assistant JSON invalid; sanitized JSON invalid');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });

  it('bounds diagnostics and never includes malformed transport contents', async () => {
    const result = await capture(Array(30).fill('SYNTHETIC_SECRET').join('\n'));
    expect(result.stdoutDiagnostics).toHaveLength(16);
    expect(result.stdoutDiagnostics?.[15]).toBe('record 30: other; Invalid framing');
    expect(decodeOpenCodeOutput(result.stdout).diagnostic).toBe('sanitization rejected a record');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });

  it.each([
    [start(), text(), finish('length')],
    [start(), text(), finish('unknown')],
    [start(), text(), finish('tool-calls')],
    [start(), text()],
    [start(), text(), finish(), start('msg_b')],
    [start(), text(), finish(), start('msg_b'), finish('stop', 'msg_b')],
    [start(), text(), finish(), start('msg_b'), text('broken', 'msg_b'), finish('stop', 'msg_b')],
    [textEvent(JSON.stringify(advisory)), textEvent('broken')],
    [textEvent(JSON.stringify(advisory)), { type: 'message', message: { parts: [] } }],
    [textEvent(JSON.stringify(advisory) + '\n{')],
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

  it('preserves multiple completed native text parts through real capture', async () => {
    const result = await capture(wire(start(), text('Reviewing repository evidence.'), text(), finish()));
    expect(parseOpenCodeReviewPayload(result.stdout)).toEqual(advisory);
  });

  it.each([',', 'Inspect'])('captures JSON split at %s without changing its value', async marker => {
    const value = JSON.stringify(advisory);
    const boundary = value.indexOf(marker) + 1;
    const result = await capture(wire(start(), text(value.slice(0, boundary)), text(value.slice(boundary)), finish()));
    expect(parseOpenCodeReviewPayload(result.stdout)).toEqual(advisory);
  });

  it('redacts an enclosing secret split across native text parts', async () => {
    const result = await capture(wire(start(), text("password='"), text('{"value":"SYNTHETIC_SECRET"}'), text("'"), finish()));
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });

  it.each(['step', 'message'])('does not assemble JSON across a %s boundary', async boundary => {
    const value = JSON.stringify(advisory);
    const split = value.indexOf(',') + 1;
    const events = boundary === 'step'
      ? [start(), text(value.slice(0, split)), finish('tool-calls'), start(), text(value.slice(split)), finish()]
      : [start(), text(value.slice(0, split)), text(value.slice(split), 'msg_b'), finish('stop', 'msg_b')];
    const result = await capture(wire(...events));
    expect(parseOpenCodeReviewPayload(result.stdout)).toBeUndefined();
  });

  it.each(["{'recommendation': 'likely_insufficient'", '{recommendation: "likely_insufficient"', 'not JSON'])('rejects malformed final JSON fences: %s', async replacement => {
    const result = await capture(wire(start(), text(JSON.stringify(advisory) + '\n```json\n' + replacement + '\n```'), finish()));
    expect(parseOpenCodeReviewPayload(result.stdout)).toBeUndefined();
  });
});
