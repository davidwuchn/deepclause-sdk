import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockProviderConfig {
  fetch?: typeof globalThis.fetch;
}

interface MockModel {
  triggerFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const openAIMocks = vi.hoisted(() => ({
  createOpenAI: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: openAIMocks.createOpenAI,
}));

import { createModelProvider } from '../src/prolog/bridge.js';

describe('createModelProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    openAIMocks.createOpenAI.mockImplementation((config: MockProviderConfig) => {
      const buildModel = (): MockModel => ({
        triggerFetch: async (url: string, init: RequestInit = {}) => {
          if (!config.fetch) {
            throw new Error('Expected createModelProvider to install a fetch override');
          }

          return config.fetch(url, {
            method: 'POST',
            body: '{}',
            ...init,
          });
        },
      });

      const provider = (() => buildModel()) as (() => MockModel) & { chat: () => MockModel };
      provider.chat = () => buildModel();
      return provider;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses undici for non-https custom base URLs', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy as typeof globalThis.fetch);

    const debugLogs: string[] = [];
    const model = createModelProvider(
      'openai',
      'gpt-4o-mini',
      'http://127.0.0.1:11434/v1',
      (...args: unknown[]) => debugLogs.push(args.map(String).join(' ')),
    ) as MockModel;

    await model.triggerFetch('http://127.0.0.1:11434/v1/chat/completions');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(debugLogs.some((line) => line.includes('transport=undici'))).toBe(true);
  });
});