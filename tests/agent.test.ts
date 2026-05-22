import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  hasToolCall: vi.fn(() => false),
  tool: vi.fn((definition: unknown) => definition),
}));

const bridgeMocks = vi.hoisted(() => ({
  onRawResponse: undefined as undefined | ((snapshot: Promise<{
    requestId: string;
    url: string;
    status: number;
    contentType: string | null;
    transport: 'https-one-shot' | 'undici';
    bodyText: string;
    captureError?: string;
  }>) => void),
  createModelProvider: vi.fn((
    _provider?: string,
    _model?: string,
    _baseUrl?: string,
    _debugLog?: (...args: unknown[]) => void,
    onRawResponse?: (snapshot: Promise<{
      requestId: string;
      url: string;
      status: number;
      contentType: string | null;
      transport: 'https-one-shot' | 'undici';
      bodyText: string;
      captureError?: string;
    }>) => void,
  ) => {
    bridgeMocks.onRawResponse = onRawResponse;
    return { id: 'mock-model' };
  }),
}));

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  hasToolCall: aiMocks.hasToolCall,
  tool: aiMocks.tool,
}));

vi.mock('../src/prolog/bridge.js', () => ({
  createModelProvider: bridgeMocks.createModelProvider,
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

  it('logs the raw upstream response when a streamed call returns empty text with finishReason other', async () => {
    let callCount = 0;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    aiMocks.streamText.mockImplementation(({ tools }: { tools: Record<string, { execute: (input: { success: boolean }) => Promise<unknown> }> }) => {
      callCount += 1;

      if (callCount === 1) {
        bridgeMocks.onRawResponse?.(Promise.resolve({
          requestId: 'req-empty-other',
          url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
          status: 200,
          contentType: 'text/event-stream',
          transport: 'https-one-shot',
          bodyText: 'data: {"choices":[{"delta":{},"finish_reason":"other"}]}',
        }));

        return {
          fullStream: (async function* () {
            yield { type: 'finish-step', finishReason: 'other' };
          })(),
          response: Promise.resolve({ messages: [] }),
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

    try {
      const result = await runAgentLoop({
        taskDescription: 'Debug a provider returning empty output.',
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
        debug: true,
      });

      expect(result.success).toBe(false);
      expect(consoleSpy.mock.calls.some((call) => call.map((part) => String(part)).join(' ').includes('Raw upstream provider response requestId=req-empty-other'))).toBe(true);
      expect(consoleSpy.mock.calls.some((call) => call.map((part) => String(part)).join(' ').includes('data: {"choices":[{"delta":{},"finish_reason":"other"}]}'))).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('continues when streamed result.response never resolves after text output', async () => {
    let callCount = 0;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousTimeout = process.env.DC_STREAM_RESPONSE_TIMEOUT_MS;
    process.env.DC_STREAM_RESPONSE_TIMEOUT_MS = '1';

    aiMocks.streamText.mockImplementation(({ tools }: { tools: Record<string, { execute: (input: { success: boolean }) => Promise<unknown> }> }) => {
      callCount += 1;

      if (callCount === 1) {
        return {
          fullStream: (async function* () {
            yield { type: 'text-delta', text: 'I have enough info.' };
            yield { type: 'finish-step', finishReason: 'stop' };
          })(),
          response: new Promise(() => {}),
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

    try {
      const result = await runAgentLoop({
        taskDescription: 'Continue after a streamed response metadata hang.',
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
        debug: true,
      });

      expect(callCount).toBe(2);
      expect(result.success).toBe(false);
      expect(consoleSpy.mock.calls.some((call) => call.map((part) => String(part)).join(' ').includes('timed out waiting'))).toBe(true);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.DC_STREAM_RESPONSE_TIMEOUT_MS;
      } else {
        process.env.DC_STREAM_RESPONSE_TIMEOUT_MS = previousTimeout;
      }
      consoleSpy.mockRestore();
    }
  });

  it('uses a simple object schema for set_result and accepts explicit variable/value arguments', async () => {
    aiMocks.generateText.mockImplementation(async ({ tools }: { tools: Record<string, { inputSchema: z.ZodTypeAny; execute: (input: unknown) => Promise<unknown> }> }) => {
      expect(tools.set_result.inputSchema).toBeInstanceOf(z.ZodObject);
      expect(tools.set_result.inputSchema.safeParse({ variable: 'FinalAnswer', value: 'done' }).success).toBe(true);
      expect(tools.set_result.inputSchema.safeParse({}).success).toBe(false);

      await tools.set_result.execute({ variable: 'FinalAnswer', value: 'done' });
      await tools.set_result.execute({ variable: 'MemoryUpdate', value: 'NONE' });
      await tools.finish.execute({ success: true });

      return {
        text: '',
        toolCalls: [
          { toolName: 'set_result', input: { variable: 'FinalAnswer', value: 'done' } },
          { toolName: 'set_result', input: { variable: 'MemoryUpdate', value: 'NONE' } },
          { toolName: 'finish', input: { success: true } },
        ],
        toolResults: [],
        response: { messages: [] },
        finishReason: 'tool-calls',
      };
    });

    const result = await runAgentLoop({
      taskDescription: 'Return both final answer and memory update.',
      outputVars: [
        { name: 'FinalAnswer', type: 'string' },
        { name: 'MemoryUpdate', type: 'string' },
      ],
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
      streaming: false,
    });

    expect(result.success).toBe(true);
    expect(result.variables).toEqual({
      FinalAnswer: 'done',
      MemoryUpdate: 'NONE',
    });
  });

  it('rejects wrong typed values in set_result execution', async () => {
    aiMocks.generateText.mockImplementation(async ({ tools }: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }) => {
      const response = await tools.set_result.execute({ variable: 'Count', value: 'not-a-number' });
      expect(response).toEqual({
        success: false,
        error: 'Expected an integer value for Count',
      });
      await tools.finish.execute({ success: false });

      return {
        text: '',
        toolCalls: [
          { toolName: 'set_result', input: { variable: 'Count', value: 'not-a-number' } },
          { toolName: 'finish', input: { success: false } },
        ],
        toolResults: [],
        response: { messages: [] },
        finishReason: 'tool-calls',
      };
    });

    const result = await runAgentLoop({
      taskDescription: 'Return a numeric count.',
      outputVars: [{ name: 'Count', type: 'integer' }],
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
      streaming: false,
    });

    expect(result.success).toBe(false);
    expect(result.variables).toEqual({});
  });

  it('loads the task prompt from the nearest .deepclause/system override', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'deepclause-agent-task-'));
    const systemDir = join(workspaceRoot, '.deepclause', 'system');
    const nestedWorkspacePath = join(workspaceRoot, 'workspace', 'nested');
    let systemPrompt = '';

    await mkdir(systemDir, { recursive: true });
    await mkdir(nestedWorkspacePath, { recursive: true });
    await writeFile(
      join(systemDir, 'TASK_PROMPT.md'),
      '# custom task prompt\n\n{TASK_DESCRIPTION}\n\n{TOOL_DESCRIPTIONS}\n\n{RESULT_SECTION}\n\n{STALL_GUIDANCE}\n',
      'utf8',
    );

    aiMocks.generateText.mockImplementation(async ({ messages, tools }: {
      messages: Array<{ role: string; content: string }>;
      tools: Record<string, { execute: (input: { success: boolean }) => Promise<unknown> }>;
    }) => {
      systemPrompt = messages[0]?.content ?? '';
      await tools.finish.execute({ success: false });

      return {
        text: '',
        toolCalls: [{ toolName: 'finish', input: { success: false } }],
        toolResults: [],
        response: { messages: [] },
        finishReason: 'tool-calls',
      };
    });

    try {
      await runAgentLoop({
        taskDescription: 'Use the custom task prompt.',
        outputVars: [],
        memory: [],
        tools: new Map(),
        workspacePath: nestedWorkspacePath,
        modelOptions: {
          model: 'mock-model',
          provider: 'openai',
          temperature: 0,
          maxOutputTokens: 1024,
        },
        onOutput: vi.fn(),
        onStream: vi.fn(),
        onAskUser: vi.fn(),
        streaming: false,
      });

      expect(systemPrompt).toContain('# custom task prompt');
      expect(systemPrompt).toContain('Use the custom task prompt.');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('stops early when the model repeats the same non-progressing response', async () => {
    let callCount = 0;

    aiMocks.generateText.mockImplementation(async () => {
      callCount += 1;
      return {
        text: 'I should think a bit more before acting.',
        toolCalls: [],
        toolResults: [],
        response: { messages: [] },
        finishReason: 'stop',
      };
    });

    const result = await runAgentLoop({
      taskDescription: 'Avoid spinning forever.',
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
      streaming: false,
    });

    expect(callCount).toBe(4);
    expect(result.success).toBe(false);
    expect(result.outputs).toContain('Agent loop detected repeated non-progressing responses and stopped early.');
  });
});