import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeepClause } from '../src/sdk.js';
import type { MemoryMessage } from '../src/types.js';

const llmMocks = vi.hoisted(() => ({
  responses: [] as string[],
  requests: [] as MemoryMessage[][],
  generateLlmReply: vi.fn(async ({ messages }: { messages: MemoryMessage[] }) => {
    llmMocks.requests.push(messages);
    return { text: llmMocks.responses.shift() ?? '', usage: undefined };
  }),
}));

vi.mock('../src/prolog/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../src/prolog/bridge.js')>('../src/prolog/bridge.js');
  return {
    ...actual,
    generateLlmReply: llmMocks.generateLlmReply,
  };
});

describe('llm/2 primitive', () => {
  beforeEach(() => {
    llmMocks.responses.length = 0;
    llmMocks.requests.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses top-level memory as explicit llm input without entering the agent loop', async () => {
    llmMocks.responses.push('Direct reply');

    const sdk = await createDeepClause({ model: 'gpt-4o-mini', compaction: { enabled: false } });
    try {
      const events: Array<{ type: string; content?: string }> = [];
      for await (const event of sdk.runDML(`
        agent_main :-
            get_memory(Messages),
            llm(Messages, Reply),
            answer(Reply).
      `, {
        initialMessages: [
          { role: 'user', content: 'Question: summarize the prior state.' },
          { role: 'assistant', content: 'Prior state: the benchmark is stable.' },
        ],
        compaction: { enabled: false },
      })) {
        events.push({ type: event.type, content: 'content' in event ? event.content : undefined });
      }

      expect(events.find((event) => event.type === 'answer')?.content).toBe('Direct reply');
      expect(llmMocks.requests).toEqual([[
        { role: 'user', content: 'Question: summarize the prior state.' },
        { role: 'assistant', content: 'Prior state: the benchmark is stable.' },
      ]]);
    } finally {
      await sdk.dispose();
    }
  });
});