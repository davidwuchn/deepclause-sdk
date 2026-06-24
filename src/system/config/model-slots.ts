export type Provider = 'openai' | 'anthropic' | 'google' | 'openrouter';
export type ModelSlot = 'gateway' | 'run' | 'compile';
export type ModelComplexity = 'high' | 'medium' | 'low';
export type ReasoningType = 'effort' | 'budget_tokens' | 'thinking_config' | 'none';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface SlotModelConfig {
  models: Record<ModelSlot, string>;
  temperatures: Record<ModelSlot, number>;
  providers?: Partial<Record<Provider, ProviderConfig>>;
  modelOptions?: Partial<Record<ModelSlot, ModelSlotOverrides>>;
}

export interface ModelSlotOverrides {
  maxContextTokens?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
}

export interface ParsedModelId {
  id: string;
  provider: Provider;
  model: string;
  customProviderName?: string;
}

export interface ResolvedModelConfig extends ParsedModelId {
  slot: ModelSlot;
  temperature: number;
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  complexity?: ModelComplexity;
  reasoningType?: ReasoningType;
  reasoningValues?: string[];
  reasoningBudgetMap?: Record<string, number>;
  defaultEffort?: string;
}

export const DEFAULT_MODEL_IDS: Record<ModelSlot, string> = {
  gateway: 'openai:gpt-4o',
  run: 'openai:gpt-4o',
  compile: 'openai:gpt-4o',
};

export const DEFAULT_TEMPERATURES: Record<ModelSlot, number> = {
  gateway: 0.7,
  run: 0.7,
  compile: 0.4,
};

const RUNTIME_PROVIDERS = new Set<Provider>(['openai', 'anthropic', 'google', 'openrouter']);

function inferProvider(model: string): Provider {
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
    return 'openai';
  }
  if (model.startsWith('claude-')) {
    return 'anthropic';
  }
  if (model.startsWith('gemini-')) {
    return 'google';
  }
  return 'openrouter';
}

function normalizeOpenRouterModel(remainder: string): string {
  if (remainder.includes('/')) {
    return remainder;
  }
  return remainder.replace(':', '/');
}

export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error('Invalid model id: value cannot be empty');
  }

  if (trimmed.startsWith('custom:')) {
    return trimmed;
  }

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex > 0) {
    const prefix = trimmed.slice(0, colonIndex).toLowerCase();
    const remainder = trimmed.slice(colonIndex + 1);
    if (prefix === 'custom') {
      return `custom:${remainder}`;
    }
    if (RUNTIME_PROVIDERS.has(prefix as Provider)) {
      if (prefix === 'openrouter') {
        return `openrouter:${normalizeOpenRouterModel(remainder)}`;
      }
      return `${prefix}:${remainder}`;
    }
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex > 0) {
    const prefix = trimmed.slice(0, slashIndex).toLowerCase();
    const remainder = trimmed.slice(slashIndex + 1);
    if (RUNTIME_PROVIDERS.has(prefix as Provider)) {
      return prefix === 'openrouter'
        ? `openrouter:${remainder}`
        : `${prefix}:${remainder}`;
    }
  }

  return `${inferProvider(trimmed)}:${trimmed}`;
}

export function formatModelId(modelId: string): string {
  return normalizeModelId(modelId);
}

export function parseModelId(modelId: string): ParsedModelId {
  const id = normalizeModelId(modelId);
  const [prefix, ...rest] = id.split(':');

  if (prefix === 'custom') {
    const [customProviderName, ...modelParts] = rest;
    if (!customProviderName || modelParts.length === 0) {
      throw new Error(`Invalid custom model id: ${modelId}`);
    }
    return {
      id,
      provider: 'openai',
      model: modelParts.join(':'),
      customProviderName,
    };
  }

  if (!RUNTIME_PROVIDERS.has(prefix as Provider) || rest.length === 0) {
    throw new Error(`Invalid model id: ${modelId}`);
  }

  return {
    id,
    provider: prefix as Provider,
    model: rest.join(':'),
  };
}

function readCustomProviderEnv(customProviderName: string): ProviderConfig {
  const envPrefix = `LLM_PROVIDER_${customProviderName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return {
    apiKey: process.env[`${envPrefix}_API_KEY`],
    baseUrl: process.env[`${envPrefix}_BASE_URL`],
  };
}

import { resolveModelCapabilities } from './model-database.js';

export function resolveModelSlotConfig(
  config: SlotModelConfig,
  slot: ModelSlot,
  overrides: { modelId?: string; temperature?: number } = {},
): ResolvedModelConfig {
  const parsed = parseModelId(overrides.modelId ?? config.models[slot] ?? DEFAULT_MODEL_IDS[slot]);
  const standardProviderConfig = config.providers?.[parsed.provider] ?? {};
  const customProviderConfig = parsed.customProviderName
    ? readCustomProviderEnv(parsed.customProviderName)
    : {};

  const providerName = parsed.customProviderName ? 'custom' : parsed.provider;
  const dbModelId = parsed.customProviderName
    ? parsed.model
    : (parsed.provider === 'openrouter' ? parsed.model : `${parsed.provider}/${parsed.model}`);
  const caps = resolveModelCapabilities(dbModelId, providerName);

  const slotOverrides = config.modelOptions?.[slot] ?? {};

  return {
    ...parsed,
    slot,
    temperature: overrides.temperature ?? config.temperatures[slot] ?? DEFAULT_TEMPERATURES[slot],
    apiKey: customProviderConfig.apiKey ?? standardProviderConfig.apiKey,
    baseUrl: customProviderConfig.baseUrl ?? standardProviderConfig.baseUrl,
    contextWindow: slotOverrides.maxContextTokens ?? caps.contextWindow,
    maxOutputTokens: slotOverrides.maxOutputTokens ?? caps.maxOutputTokens,
    reasoning: caps.reasoning,
    complexity: caps.complexity,
    reasoningType: caps.reasoningType,
    reasoningValues: caps.reasoningValues,
    reasoningBudgetMap: caps.reasoningBudgetMap,
    defaultEffort: caps.defaultEffort,
  };
}

export function buildModelOverride(model?: string, provider?: Provider): string | undefined {
  if (!model) {
    return undefined;
  }
  if (provider && !model.includes(':') && !model.includes('/')) {
    return normalizeModelId(`${provider}:${model}`);
  }
  return normalizeModelId(model);
}