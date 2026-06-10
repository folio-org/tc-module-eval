import { buildCriterionAgentReviewConfig } from '../utils/agent-review-config';

describe('criterion-agent CLI option parsing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to disabled when the OpenCode flag is absent', () => {
    expect(buildCriterionAgentReviewConfig({})).toBeUndefined();
  });

  it('builds reusable OpenCode review configuration', () => {
    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true,
      criterionAgentCriteria: 's004,B004',
      criterionAgentModel: 'openai/gpt-test',
      criterionAgentReadOnlyAgent: 'plan',
      criterionAgentTimeoutMs: '12000',
      criterionAgentProviderEnv: 'OPENAI_API_KEY,ANTHROPIC_API_KEY',
      criterionAgentProxyEnv: 'HTTPS_PROXY',
      criterionAgentEndpoint: 'https://api.example.test',
      criterionAgentEndpointFamily: 'openai-compatible'
    });

    expect(config).toEqual(expect.objectContaining({
      enabled: true,
      adapter: 'opencode',
      enabledCriteria: ['S004', 'B004'],
      modelLabel: 'openai/gpt-test',
      readOnlyAgentName: 'plan',
      timeoutMs: 12000,
      providerEnvAllowlist: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
      proxyEnvAllowlist: ['HTTPS_PROXY']
    }));
  });

  it('rejects invalid endpoint values early', () => {
    expect(() => buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true,
      criterionAgentEndpoint: 'http://api.example.test'
    })).toThrow('HTTPS');
  });

  it('rejects timeout values that are not full positive integers', () => {
    expect(() => buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true,
      criterionAgentTimeoutMs: '90s'
    })).toThrow('positive integer');

    expect(() => buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true,
      criterionAgentTimeoutMs: '0'
    })).toThrow('positive integer');
  });

  it('does not require provider keys to be passed as CLI values', () => {
    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true,
      criterionAgentProviderEnv: 'OPENAI_API_KEY'
    });

    expect(config?.providerEnvAllowlist).toEqual(['OPENAI_API_KEY']);
    expect(JSON.stringify(config)).not.toContain('sk-');
  });

  it('uses OPENROUTER_API_KEY and OPENROUTER_MODEL as first-class OpenCode provider config', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-secret';
    process.env.OPENROUTER_MODEL = 'openrouter/free';

    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true
    });

    expect(config?.modelLabel).toBe('openrouter/openrouter/free');
    expect(config?.providerEnvAllowlist).toEqual(['OPENROUTER_API_KEY']);
    expect(config?.endpointFamily).toBe('openrouter');
    expect(config?.generatedProvider).toEqual({
      name: 'openrouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      modelEnv: 'OPENROUTER_MODEL',
      modelId: 'openrouter/free',
      modelSelector: 'openrouter/openrouter/free'
    });
    expect(JSON.stringify(config)).not.toContain('sk-or-test-secret');
  });

  it('uses OPENAI_API_KEY and OPENAI_MODEL as first-class OpenCode provider config', () => {
    process.env.OPENAI_API_KEY = 'sk-test-secret';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';

    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true
    });

    expect(config?.modelLabel).toBe('openai/gpt-4.1-mini');
    expect(config?.providerEnvAllowlist).toEqual(['OPENAI_API_KEY']);
    expect(config?.endpointFamily).toBe('openai');
    expect(config?.generatedProvider).toEqual({
      name: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
      modelEnv: 'OPENAI_MODEL',
      modelId: 'gpt-4.1-mini',
      modelSelector: 'openai/gpt-4.1-mini'
    });
    expect(JSON.stringify(config)).not.toContain('sk-test-secret');
  });

  it('uses an explicit provider-prefixed CLI model before unrelated provider env detection', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-secret';
    process.env.OPENROUTER_MODEL = 'openrouter/free';
    process.env.OPENAI_API_KEY = 'sk-test-secret';

    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true,
      criterionAgentModel: 'openai/gpt-4.1-mini'
    });

    expect(config?.modelLabel).toBe('openai/gpt-4.1-mini');
    expect(config?.providerEnvAllowlist).toEqual(['OPENAI_API_KEY']);
    expect(config?.generatedProvider).toEqual({
      name: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
      modelEnv: 'OPENAI_MODEL',
      modelId: 'gpt-4.1-mini',
      modelSelector: 'openai/gpt-4.1-mini'
    });
    expect(config?.providerConfigError).toBeUndefined();
  });

  it('prefers a complete OpenAI env config over incomplete OpenRouter env', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-secret';
    process.env.OPENAI_API_KEY = 'sk-test-secret';
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';

    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true
    });

    expect(config?.modelLabel).toBe('openai/gpt-4.1-mini');
    expect(config?.providerEnvAllowlist).toEqual(['OPENAI_API_KEY']);
    expect(config?.generatedProvider?.name).toBe('openai');
    expect(config?.providerConfigError).toBeUndefined();
  });

  it('preserves explicit non-provider CLI models without ambient provider env errors', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-secret';

    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true,
      criterionAgentModel: 'test-model'
    });

    expect(config?.modelLabel).toBe('test-model');
    expect(config?.generatedProvider).toBeUndefined();
    expect(config?.providerConfigError).toBeUndefined();
  });

  it('keeps explicit auth stores in control instead of generating provider auth', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-secret';
    process.env.OPENROUTER_MODEL = 'openrouter/free';

    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true,
      criterionAgentAuthStore: '/tmp/opencode-auth/auth.json',
      criterionAgentModel: 'openrouter/openrouter/free'
    });

    expect(config?.modelLabel).toBe('openrouter/openrouter/free');
    expect(config?.generatedProvider).toBeUndefined();
    expect(config?.providerEnvAllowlist).toBeUndefined();
  });

  it('reports incomplete first-class provider env without exposing secrets', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-secret';

    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true
    });

    expect(config?.providerConfigError).toBe('OPENROUTER_MODEL is required when OPENROUTER_API_KEY is set');
    expect(config?.modelLabel).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('sk-or-test-secret');
  });

  it('uses model-only provider env while deferring missing key diagnostics to the adapter', () => {
    process.env.OPENROUTER_MODEL = 'openrouter/free';

    const config = buildCriterionAgentReviewConfig({
      criterionAgentOpencode: true
    });

    expect(config?.modelLabel).toBe('openrouter/openrouter/free');
    expect(config?.providerEnvAllowlist).toEqual(['OPENROUTER_API_KEY']);
    expect(config?.generatedProvider?.name).toBe('openrouter');
    expect(config?.providerConfigError).toBeUndefined();
  });
});
