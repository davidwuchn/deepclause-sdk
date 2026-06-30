/**
 * Tests for the model database and model slot resolution
 */

import { describe, it, expect } from 'vitest';
import {
  lookupModel,
  lookupProvider,
  resolveModelCapabilities,
  buildReasoningProviderOptions,
  type ReasoningType,
} from '../src/system/config/model-database.js';
import {
  resolveModelSlotConfig,
  parseModelId,
  type ModelSlot,
} from '../src/system/config/model-slots.js';

describe('Model Database', () => {
  describe('lookupModel', () => {
    it('should find a known model', () => {
      const model = lookupModel('alibaba/qwen3.6-27b');
      expect(model).toBeDefined();
      expect(model?.name).toBe('Qwen3.6 27B');
      expect(model?.reasoning).toBe(true);
      expect(model?.complexity).toBe('low');
      expect(model?.limit.context).toBe(262144);
      expect(model?.limit.output).toBe(65536);
    });

    it('should return undefined for unknown model', () => {
      const model = lookupModel('unknown/model');
      expect(model).toBeUndefined();
    });
  });

  describe('lookupProvider', () => {
    it('should find OpenAI provider', () => {
      const provider = lookupProvider('openai');
      expect(provider).toBeDefined();
      expect(provider?.reasoning_type).toBe('effort');
      expect(provider?.reasoning_values).toContain('high');
    });

    it('should find Anthropic provider', () => {
      const provider = lookupProvider('anthropic');
      expect(provider).toBeDefined();
      expect(provider?.reasoning_type).toBe('budget_tokens');
      expect(provider?.budget_map?.high).toBe(32000);
    });

    it('should find custom provider with none reasoning type', () => {
      const provider = lookupProvider('custom');
      expect(provider).toBeDefined();
      expect(provider?.reasoning_type).toBe('none');
    });

    it('should return undefined for unknown provider', () => {
      const provider = lookupProvider('nonexistent');
      expect(provider).toBeUndefined();
    });
  });

  describe('resolveModelCapabilities', () => {
    it('should resolve capabilities for a known model with known provider', () => {
      const caps = resolveModelCapabilities('alibaba/qwen3.6-27b', 'openrouter');
      expect(caps.contextWindow).toBe(262144);
      expect(caps.maxOutputTokens).toBe(65536);
      expect(caps.reasoning).toBe(true);
      expect(caps.complexity).toBe('low');
      expect(caps.reasoningType).toBe('effort');
    });

    it('should return defaults for unknown model', () => {
      const caps = resolveModelCapabilities('unknown/model', 'openai');
      expect(caps.contextWindow).toBeUndefined();
      expect(caps.maxOutputTokens).toBeUndefined();
      expect(caps.reasoning).toBe(false);
      expect(caps.complexity).toBe('medium');
      expect(caps.reasoningType).toBe('effort');
    });

    it('should return none reasoning type for custom provider', () => {
      const caps = resolveModelCapabilities('anything', 'custom');
      expect(caps.reasoningType).toBe('none');
    });
  });

  describe('buildReasoningProviderOptions', () => {
    it('should return empty for none effort', () => {
      const opts = buildReasoningProviderOptions('none', 'effort');
      expect(opts).toEqual({});
    });

    it('should return empty for none reasoning type', () => {
      const opts = buildReasoningProviderOptions('high', 'none');
      expect(opts).toEqual({});
    });

    it('should build effort options for OpenAI', () => {
      const opts = buildReasoningProviderOptions('high', 'effort');
      expect(opts).toEqual({ reasoning_effort: 'high' });
    });

    it('should build budget_tokens options for Anthropic', () => {
      const opts = buildReasoningProviderOptions('high', 'budget_tokens', { low: 5000, medium: 16000, high: 32000 });
      expect(opts).toEqual({ thinking: { type: 'enabled', budget_tokens: 32000 } });
    });

    it('should build thinking_config options for Google', () => {
      const opts = buildReasoningProviderOptions('medium', 'thinking_config', { low: 0, medium: 8192, high: 24576 });
      expect(opts).toEqual({ thinkingConfig: { thinkingBudget: 8192 } });
    });

    it('should use default budget when budget map is missing', () => {
      const opts = buildReasoningProviderOptions('high', 'budget_tokens');
      expect(opts).toEqual({ thinking: { type: 'enabled', budget_tokens: 16000 } });
    });
  });
});

describe('Model Slot Resolution with Database', () => {
  const baseConfig = {
    models: {
      gateway: 'openai:gpt-4o',
      run: 'openai:gpt-4o',
      compile: 'openai:gpt-4o',
    } as Record<ModelSlot, string>,
    temperatures: {
      gateway: 0.7,
      run: 0.7,
      compile: 0.4,
    } as Record<ModelSlot, number>,
  };

  it('should auto-populate capabilities from database for OpenAI model', () => {
    const resolved = resolveModelSlotConfig(baseConfig, 'run');
    expect(resolved.model).toBe('gpt-4o');
    expect(resolved.contextWindow).toBe(128000);
    expect(resolved.maxOutputTokens).toBe(16384);
    expect(resolved.reasoning).toBe(false);
    expect(resolved.complexity).toBe('high');
  });

  it('should auto-populate capabilities for OpenRouter model', () => {
    const config = {
      ...baseConfig,
      models: { ...baseConfig.models, run: 'openrouter:alibaba/qwen3.6-27b' },
    };
    const resolved = resolveModelSlotConfig(config, 'run');
    expect(resolved.model).toBe('alibaba/qwen3.6-27b');
    expect(resolved.contextWindow).toBe(262144);
    expect(resolved.maxOutputTokens).toBe(65536);
    expect(resolved.reasoning).toBe(true);
    expect(resolved.complexity).toBe('low');
    expect(resolved.reasoningType).toBe('effort');
  });

  it('should return defaults for custom provider model not in database', () => {
    const config = {
      ...baseConfig,
      models: { ...baseConfig.models, run: 'custom:local:my-model' },
    };
    const resolved = resolveModelSlotConfig(config, 'run');
    expect(resolved.contextWindow).toBeUndefined();
    expect(resolved.maxOutputTokens).toBeUndefined();
    expect(resolved.reasoning).toBe(false);
    expect(resolved.complexity).toBe('medium');
    expect(resolved.reasoningType).toBe('none');
  });

  it('should allow modelOptions overrides', () => {
    const config = {
      ...baseConfig,
      models: { ...baseConfig.models, run: 'openrouter:alibaba/qwen3.6-27b' },
      modelOptions: {
        run: { maxContextTokens: 131072, maxOutputTokens: 32768 },
      },
    };
    const resolved = resolveModelSlotConfig(config, 'run');
    expect(resolved.contextWindow).toBe(131072);
    expect(resolved.maxOutputTokens).toBe(32768);
  });

  it('should override precedence: user config > database > defaults', () => {
    const config = {
      ...baseConfig,
      models: { ...baseConfig.models, run: 'openrouter:alibaba/qwen3.6-27b' },
      modelOptions: {
        run: { maxOutputTokens: 8192 },
      },
    };
    const resolved = resolveModelSlotConfig(config, 'run');
    // Override takes precedence
    expect(resolved.maxOutputTokens).toBe(8192);
    // Context window from database (not overridden)
    expect(resolved.contextWindow).toBe(262144);
  });
});

describe('Parse Model ID', () => {
  it('should parse openrouter model with vendor/model format', () => {
    const parsed = parseModelId('openrouter:alibaba/qwen3.6-27b');
    expect(parsed.provider).toBe('openrouter');
    expect(parsed.model).toBe('alibaba/qwen3.6-27b');
  });

  it('should parse custom provider', () => {
    const parsed = parseModelId('custom:aliyun:qwen3.6-27b');
    expect(parsed.provider).toBe('openai');
    expect(parsed.model).toBe('qwen3.6-27b');
    expect(parsed.customProviderName).toBe('aliyun');
  });

  it('should parse standard provider', () => {
    const parsed = parseModelId('openai:gpt-4o');
    expect(parsed.provider).toBe('openai');
    expect(parsed.model).toBe('gpt-4o');
  });
});
