import { readFile } from 'fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeCompactor, resolveBinding } from '../src/compaction.js';
import { createDeepClause } from '../src/sdk.js';
import { getSystemCompactorAssetPath } from '../src/system/assets/index.js';
import type { MemoryMessage } from '../src/types.js';

const llmMocks = vi.hoisted(() => ({
  responses: [] as string[],
  requests: [] as MemoryMessage[][],
  generateLlmReply: vi.fn(async ({ messages }: { messages: MemoryMessage[] }) => {
    llmMocks.requests.push(messages);
    return { text: llmMocks.responses.shift() ?? 'SKIP', usage: undefined };
  }),
}));

vi.mock('../src/prolog/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../src/prolog/bridge.js')>('../src/prolog/bridge.js');
  return {
    ...actual,
    generateLlmReply: llmMocks.generateLlmReply,
  };
});

function buildLargeMessages(count: number): MemoryMessage[] {
  const filler = 'important retained detail '.repeat(1200);
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${index + 1}\nGoal: keep the benchmark and provider configuration stable.\nState: ${filler}`,
  }));
}

async function runPackagedCompactor(options: {
  assetName: 'default-session-compactor' | 'default-loop-compactor';
  scope: 'session' | 'loop';
  trigger: 'before_user_message' | 'before_model_call';
  messages: MemoryMessage[];
}) {
  const binding = resolveBinding({
    name: options.assetName,
    scope: options.scope,
    trigger: options.trigger,
    compactor: {
      source: getSystemCompactorAssetPath(options.assetName),
      sourceType: 'file',
    },
  });

  const sdk = await createDeepClause({
    model: 'gpt-4o-mini',
    compaction: { enabled: false },
  });

  try {
    return await executeCompactor({
      binding,
      messages: options.messages,
      execute: async (request) => {
        const code = await readFile(request.binding.compactor.source, 'utf8');
        let answer = '';
        let error = '';

        for await (const event of sdk.runDML(code, {
          params: request.params,
          initialMessages: request.messages,
          compaction: { enabled: false },
        })) {
          if (event.type === 'answer' && event.content) {
            answer = event.content;
          } else if (event.type === 'error' && event.content) {
            error = event.content;
          }
        }

        return {
          answer,
          error: error || undefined,
        };
      },
    });
  } finally {
    await sdk.dispose();
  }
}

describe('packaged default compactors', () => {
  beforeEach(() => {
    llmMocks.responses.length = 0;
    llmMocks.requests.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      assetName: 'default-session-compactor' as const,
      scope: 'session' as const,
      trigger: 'before_user_message' as const,
      messages: buildLargeMessages(8),
    },
    {
      assetName: 'default-loop-compactor' as const,
      scope: 'loop' as const,
      trigger: 'before_model_call' as const,
      messages: buildLargeMessages(12),
    },
  ])('asks %s for readable plain-text summaries', async ({ assetName, scope, trigger, messages }) => {
    llmMocks.responses.push('SKIP');

    const result = await runPackagedCompactor({ assetName, scope, trigger, messages });

    expect(result.applied).toBe(false);
    expect(llmMocks.requests).toHaveLength(1);
    expect(llmMocks.requests[0]).toHaveLength(messages.length + 1);
    expect(llmMocks.requests[0][0]).toMatchObject({ role: 'system' });
    expect(llmMocks.requests[0][1]?.content).toContain('Turn 1');
  });

  it.each([
    {
      assetName: 'default-session-compactor' as const,
      scope: 'session' as const,
      trigger: 'before_user_message' as const,
      messages: buildLargeMessages(8),
      summary: 'Goals:\n- Keep the benchmark runnable offline.\nOpen questions:\n- Confirm proxy settings before the next run.',
      expectedTail: ['Turn 7', 'Turn 8'],
    },
    {
      assetName: 'default-loop-compactor' as const,
      scope: 'loop' as const,
      trigger: 'before_model_call' as const,
      messages: buildLargeMessages(12),
      summary: 'Objective: debug provider transport.\nLatest state: HTTP custom base URLs must stay on undici.\nNext step: verify the compactor parser accepts fenced JSON.',
      expectedTail: ['Turn 10', 'Turn 11', 'Turn 12'],
    },
  ])('applies %s output when the prompt returns a rewrite spec', async ({ assetName, scope, trigger, messages, summary, expectedTail }) => {
    llmMocks.responses.push(summary);

    const result = await runPackagedCompactor({ assetName, scope, trigger, messages });

    expect(result.applied).toBe(true);
    expect(result.messages[0]).toEqual({ role: 'assistant', content: summary });
    expect(result.messages).toHaveLength(expectedTail.length + 1);
    expectedTail.forEach((turnLabel, index) => {
      expect(result.messages[index + 1]?.content).toContain(turnLabel);
    });
    expect(result.event.compactionAction).toBe('applied');
  });
});