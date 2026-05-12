import { describe, expect, it, vi, beforeEach } from 'vitest';

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  hasToolCall: vi.fn(() => false),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  hasToolCall: aiMocks.hasToolCall,
  tool: aiMocks.tool,
}));

vi.mock('../src/prolog/bridge.js', () => ({
  createModelProvider: vi.fn(() => ({ id: 'mock-model' })),
}));

import { runAgentLoop } from '../src/agent.js';

describe('runAgentLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tolerates streamed responses that omit response.messages', async () => {
    let callCount = 0;

    aiMocks.streamText.mockImplementation(({ tools }: { tools: Record<string, { execute: (input: { success: boolean }) => Promise<unknown> }> }) => {
      callCount += 1;

      if (callCount === 1) {
        return {
          fullStream: (async function* () {
            yield { type: 'tool-call', toolName: 'list_skills', input: {} };
            yield { type: 'finish-step', finishReason: 'tool-calls' };
          })(),
          response: Promise.resolve({}),
        };
      }

      return {
        fullStream: (async function* () {
          await tools.finish.execute({ success: false });
          yield { type: 'finish-step', finishReason: 'stop' };
        })(),
        response: Promise.resolve({ messages: [] }),
      };
    });

    const result = await runAgentLoop({
      taskDescription: 'Create a skill',
      outputVars: [],
      memory: [],
      tools: new Map(),
      modelOptions: {
        model: 'mock-model',
        provider: 'openai',
        temperature: 0,
        maxOutputTokens: 1024,
      },
      onOutput: vi.fn(),
      onStream: vi.fn(),
      onAskUser: vi.fn(),
      streaming: true,
    });

    expect(callCount).toBe(2);
    expect(result.success).toBe(false);
  });
});