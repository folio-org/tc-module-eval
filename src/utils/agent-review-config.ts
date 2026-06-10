import { CriterionAgentGeneratedProvider, CriterionAgentReviewConfig } from '../types';
import { validateEndpointUrl } from './criterion-agent-review';

interface GeneratedProviderResolution {
  provider?: CriterionAgentGeneratedProvider;
  explicitModel?: string;
  error?: string;
}

export interface CriterionAgentCliOptions {
  criterionAgentOpencode?: boolean;
  criterionAgentCriteria?: string;
  criterionAgentEndpointAllowlist?: string;
  criterionAgentEndpoint?: string;
  criterionAgentModel?: string;
  criterionAgentReadOnlyAgent?: string;
  criterionAgentTimeoutMs?: string;
  criterionAgentTrustedConfig?: string;
  criterionAgentAuthStore?: string;
  criterionAgentProviderEnv?: string;
  criterionAgentProxyEnv?: string;
  criterionAgentEndpointFamily?: string;
  criterionAgentDebugRetainWorkspace?: boolean;
}

interface ProviderDefinition {
  name: CriterionAgentGeneratedProvider['name'];
  apiKeyEnv: CriterionAgentGeneratedProvider['apiKeyEnv'];
  modelEnv: CriterionAgentGeneratedProvider['modelEnv'];
  selectorPrefix: string;
  keepNestedPrefix: boolean;
}

const PROVIDERS: ProviderDefinition[] = [
  {
    name: 'openrouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    selectorPrefix: 'openrouter/',
    keepNestedPrefix: true
  },
  {
    name: 'openai',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    selectorPrefix: 'openai/',
    keepNestedPrefix: false
  }
];

export function buildCriterionAgentReviewConfig(options: CriterionAgentCliOptions): CriterionAgentReviewConfig | undefined {
  if (!options.criterionAgentOpencode) {
    return undefined;
  }

  const endpointAllowlist = parseCsv(options.criterionAgentEndpointAllowlist);
  if (options.criterionAgentEndpoint) {
    const endpointError = validateEndpointUrl(options.criterionAgentEndpoint, endpointAllowlist);
    if (endpointError) {
      throw new Error(endpointError);
    }
  }

  const providerResolution = resolveGeneratedProvider(options);
  const generatedProvider = providerResolution.provider;
  const providerEnvAllowlist = mergeCsvValues(
    parseCsv(options.criterionAgentProviderEnv),
    generatedProvider ? [generatedProvider.apiKeyEnv] : undefined
  );

  return {
    enabled: true,
    enabledCriteria: parseCriteriaCsv(options.criterionAgentCriteria),
    adapter: 'opencode',
    modelLabel: providerResolution.explicitModel ?? generatedProvider?.modelSelector,
    readOnlyAgentName: options.criterionAgentReadOnlyAgent ?? 'reviewer',
    timeoutMs: options.criterionAgentTimeoutMs ? parsePositiveInteger(options.criterionAgentTimeoutMs, 'criterion-agent-timeout-ms') : undefined,
    trustedConfigPath: options.criterionAgentTrustedConfig,
    trustedAuthStorePath: options.criterionAgentAuthStore,
    providerEnvAllowlist,
    proxyEnvAllowlist: parseCsv(options.criterionAgentProxyEnv),
    endpoint: options.criterionAgentEndpoint,
    endpointFamily: options.criterionAgentEndpointFamily ?? generatedProvider?.name,
    endpointAllowlist,
    debugRetainWorkspace: options.criterionAgentDebugRetainWorkspace === true,
    generatedProvider,
    providerConfigError: providerResolution.error
  };
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const values = value.split(',').map(part => part.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid ${label}: expected a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: expected a positive integer`);
  }
  return parsed;
}

function resolveGeneratedProvider(options: CriterionAgentCliOptions): GeneratedProviderResolution {
  if (options.criterionAgentAuthStore || options.criterionAgentTrustedConfig) {
    return { explicitModel: trimmedString(options.criterionAgentModel) };
  }

  const explicitModel = trimmedString(options.criterionAgentModel);
  if (explicitModel) {
    return explicitProviderFromModel(explicitModel) ?? { explicitModel };
  }

  const envProviders = PROVIDERS.map(provider => ({
    definition: provider,
    apiKeyPresent: Boolean(process.env[provider.apiKeyEnv]),
    model: process.env[provider.modelEnv]?.trim()
  }));

  const readyProvider = envProviders.find(provider => provider.apiKeyPresent && provider.model);
  if (readyProvider?.model) {
    return generatedProvider(readyProvider.definition, readyProvider.model);
  }

  const modelOnlyProvider = envProviders.find(provider => provider.model);
  if (modelOnlyProvider?.model) {
    return generatedProvider(modelOnlyProvider.definition, modelOnlyProvider.model);
  }

  const missingModelProvider = envProviders.find(provider => provider.apiKeyPresent);
  if (missingModelProvider) {
    return { error: `${missingModelProvider.definition.modelEnv} is required when ${missingModelProvider.definition.apiKeyEnv} is set` };
  }

  return {};
}

function parseCriteriaCsv(value: string | undefined): string[] | undefined {
  return parseCsv(value)?.map(id => id.toUpperCase());
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function explicitProviderFromModel(modelSelector: string): GeneratedProviderResolution | undefined {
  const provider = PROVIDERS.find(candidate => modelSelector.startsWith(candidate.selectorPrefix));
  if (!provider) {
    return undefined;
  }
  return generatedProvider(provider, modelSelector.slice(provider.selectorPrefix.length), modelSelector);
}

function generatedProvider(
  provider: ProviderDefinition,
  modelId: string,
  modelSelector?: string
): GeneratedProviderResolution {
  const normalizedModelId = normalizeProviderModelId(provider, modelId);
  return { provider: {
    name: provider.name,
    apiKeyEnv: provider.apiKeyEnv,
    modelEnv: provider.modelEnv,
    modelId: normalizedModelId,
    modelSelector: modelSelector ?? `${provider.selectorPrefix}${normalizedModelId}`
  } };
}

function normalizeProviderModelId(provider: ProviderDefinition, value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith(provider.selectorPrefix)) {
    return trimmed;
  }
  if (provider.keepNestedPrefix && trimmed.split('/').length < 3) {
    return trimmed;
  }
  return trimmed.slice(provider.selectorPrefix.length);
}

function mergeCsvValues(...groups: Array<string[] | undefined>): string[] | undefined {
  const values = groups.flatMap(group => group ?? []);
  const merged = [...new Set(values)];
  return merged.length ? merged : undefined;
}
