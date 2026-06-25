import { sanitizeCommandOutput } from '../utils/command-runner';
import { redactSensitiveText } from '../utils/redaction';

describe('redaction', () => {
  it('redacts token-like assignments and bearer tokens', () => {
    const redacted = redactSensitiveText('token=abc123 password: hunter2 Authorization: Bearer aaa.bbb.ccc');

    expect(redacted).toContain('token=[REDACTED]');
    expect(redacted).toContain('password=[REDACTED]');
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('hunter2');
  });

  it('redacts quoted and JSON-style secret assignments', () => {
    const redacted = redactSensitiveText('OPENAI_API_KEY="sk-secret" {"apiKey":"secret-json","refreshToken":"refresh-secret"}');

    expect(redacted).toContain('OPENAI_API_KEY="[REDACTED]"');
    expect(redacted).toContain('"apiKey":"[REDACTED]"');
    expect(redacted).toContain('"refreshToken":"[REDACTED]"');
    expect(redacted).not.toContain('sk-secret');
    expect(redacted).not.toContain('secret-json');
    expect(redacted).not.toContain('refresh-secret');
  });

  it('redacts raw provider tokens and OpenCode auth JSON keys', () => {
    const redacted = redactSensitiveText('{"openai":{"type":"api","key":"sk-secret"},"openrouter":{"key":"sk-or-v1-secret"}} raw sk-live-token');

    expect(redacted).toContain('"key":"[REDACTED_PROVIDER_TOKEN]"');
    expect(redacted).not.toContain('sk-secret');
    expect(redacted).not.toContain('sk-or-v1-secret');
    expect(redacted).not.toContain('sk-live-token');
  });

  it('redacts private URLs', () => {
    const redacted = redactSensitiveText('see http://192.168.1.10:9130/admin');

    expect(redacted).toContain('[REDACTED_PRIVATE_URL]');
    expect(redacted).not.toContain('192.168.1.10');
  });

  it('redacts credentials embedded in URLs before preserving private-url shape', () => {
    const redacted = redactSensitiveText('proxy=https://user:pass@example.com:8080 db=http://admin:s3cr3t@192.168.1.10:9130/admin');

    expect(redacted).toContain('[REDACTED_CREDENTIAL_URL]');
    expect(redacted).not.toContain('user:pass');
    expect(redacted).not.toContain('example.com');
    expect(redacted).not.toContain('admin:s3cr3t');
    expect(redacted).not.toContain('192.168.1.10');
  });

  it('redacts private key blocks, JWTs, Okapi tokens, and OAuth-like provider tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkw.signatureABC123';
    const oauthToken = 'ya29.abcdefghijklmnopqrstuvwxyz123456';
    const redacted = redactSensitiveText([
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      '-----END PRIVATE KEY-----',
      `jwt=${jwt}`,
      'X-Okapi-Token: abcdefghijklmnopqrstuvwxyz123456',
      oauthToken
    ].join('\n'));

    expect(redacted).toContain('[REDACTED_PRIVATE_KEY_BLOCK]');
    expect(redacted).toContain('[REDACTED_JWT]');
    expect(redacted).toContain('X-Okapi-Token: [REDACTED]');
    expect(redacted).toContain('[REDACTED_PROVIDER_TOKEN]');
    expect(redacted).not.toContain('MIIEvQIB');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(redacted).not.toContain(oauthToken);
  });

  it('is used by command output sanitization', () => {
    const redacted = sanitizeCommandOutput('api_key=secret\n' + 'x'.repeat(50), 24);

    expect(redacted).toContain('api_key=[REDACTED]');
    expect(redacted).toContain('output truncated');
    expect(redacted).not.toContain('secret');
  });

  it('redacts private URLs from command output', () => {
    const redacted = sanitizeCommandOutput('Started at http://localhost:8080/health');

    expect(redacted).toContain('[REDACTED_PRIVATE_URL]');
    expect(redacted).not.toContain('localhost:8080');
  });

  it('does not leave a replacement character when truncating multibyte text', () => {
    const redacted = redactSensitiveText('hello 😀 world', 8);

    expect(redacted).not.toContain('\uFFFD');
    expect(redacted).toContain('output truncated');
  });
});
