import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCriterionAgentReviewConfig } from '../utils/agent-review-config';
import { redactEvaluatorSecrets, redactEvaluatorSecretsInValue } from '../utils/redaction';
import { withEnvironment } from './helpers/evaluator-secrets';

describe("masking the evaluator's secrets", () => {
  it('leaves text alone when a variable is unset, empty or too short to be a secret', () => withEnvironment({
    OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: '', SONAR_TOKEN: 'abc', GITHUB_TOKEN: undefined
  }, () => {
    const text = 'undefined, null, abc and an empty string';
    expect(redactEvaluatorSecrets(text)).toBe(text);
    expect(redactEvaluatorSecretsInValue({ [text]: [text] })).toEqual({ [text]: [text] });
  }));

  it('masks a secret that contains another as a whole', () => withEnvironment({
    OPENAI_API_KEY: 'sk-sharedPrefix', GITHUB_TOKEN: 'sk-sharedPrefix-and-more'
  }, () => {
    expect(redactEvaluatorSecrets('sk-sharedPrefix-and-more')).toBe('[REDACTED_GITHUB_TOKEN]');
  }));

  it('drops the start of a secret left at the end of text that was already cut', () => withEnvironment({
    OPENAI_API_KEY: 'sk-proj-fakeKey0123456789s', SONAR_TOKEN: 'squ_fakeToken0123456789'
  }, () => {
    expect(redactEvaluatorSecrets('done; key sk-proj-fake', undefined, true)).toBe('done; key ');
    expect(redactEvaluatorSecrets('done; key sk-proj-fake')).toBe('done; key sk-proj-fake');
    // A whole secret at the cut that ends with the start of another is still masked whole.
    expect(redactEvaluatorSecrets('key sk-proj-fakeKey0123456789s', undefined, true)).toBe('key [REDACTED_OPENAI_API_KEY]');
    expect(redactEvaluatorSecrets('key sk-proj-fakeKey0123456789squ', undefined, true)).toBe('key [REDACTED_OPENAI_API_KEY]qu');
  }));

  it('masks the variables passed to OpenCode for provider and proxy access', () => withEnvironment({
    ANTHROPIC_API_KEY: 'sk-ant-fakeKey0123456789', HTTPS_PROXY: 'http://user:fake-password@proxy.example:3128'
  }, () => {
    buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true, criterionAgentModel: 'anthropic/claude',
      criterionAgentProviderEnv: 'ANTHROPIC_API_KEY', criterionAgentProxyEnv: 'HTTPS_PROXY'
    });
    expect(redactEvaluatorSecrets('key sk-ant-fakeKey0123456789 via http://user:fake-password@proxy.example:3128'))
      .toBe('key [REDACTED_ANTHROPIC_API_KEY] via [REDACTED_HTTPS_PROXY]');
  }));

  it('masks the keys in a trusted OpenCode auth store', () => {
    const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-store-')), 'auth.json');
    fs.writeFileSync(store, JSON.stringify({ openrouter: { type: 'api', key: 'sk-or-v1-storedKey0123456789' },
      openai: { type: 'oauth', refresh: 'refresh-token-0123456789', access: 'access-token-0123456789', expires: 1 } }));
    try {
      buildCriterionAgentReviewConfig({ criterionAgentOpencode: true, criterionAgentAuthStore: store });
      expect(redactEvaluatorSecrets('api sk-or-v1-storedKey0123456789 oauth refresh-token-0123456789 access-token-0123456789'))
        .toBe('api [REDACTED_AUTH_STORE] oauth [REDACTED_AUTH_STORE] [REDACTED_AUTH_STORE]');
    } finally {
      fs.rmSync(path.dirname(store), { recursive: true, force: true });
    }
  });
});
