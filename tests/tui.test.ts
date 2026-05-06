import { beforeEach, describe, expect, it, vi } from 'vitest';

const conductorMocks = vi.hoisted(() => ({
  createConductorSession: vi.fn(),
  listConductorSessions: vi.fn(),
  runConductorTurn: vi.fn(),
}));

vi.mock('../src/system/runtime/conductor.js', () => ({
  createConductorSession: conductorMocks.createConductorSession,
  listConductorSessions: conductorMocks.listConductorSessions,
  runConductorTurn: conductorMocks.runConductorTurn,
}));

import { LiveExecutionPrinter, runPromptHeadless } from '../src/cli/tui.js';

describe('LiveExecutionPrinter', () => {
  it('streams tokens and hides internal tool noise', () => {
    const writes: string[] = [];
    const lines: string[] = [];
    const printer = new LiveExecutionPrinter(
      (text) => writes.push(text),
      (text) => lines.push(text),
    );

    printer.handle({ scope: 'main', event: { type: 'stream', content: 'Hello' } });
    printer.handle({ scope: 'main', event: { type: 'stream', content: ' world', done: true } });
    printer.handle({ scope: 'main', event: { type: 'tool_call', toolName: 'set_result', toolArgs: { variable: 'x' } } });
    printer.handle({ scope: 'main', event: { type: 'tool_call', toolName: 'update_memory', toolArgs: { bytes: 3 } } });
    printer.handle({ scope: 'child', childSlug: 'research', event: { type: 'stream', content: 'Child', done: true } });
    printer.handle({ scope: 'main', event: { type: 'tool_call', toolName: 'web_search', toolArgs: { query: 'alpha' } } });
    printer.handle({ scope: 'child', childSlug: 'research', event: { type: 'output', content: 'done' } });
    printer.finish();

    expect(writes.join('')).toBe('llm Hello world\n[research] llm Child\n');
    expect(lines).toEqual([
      'tool web_search(query=alpha)',
      '[research] output done',
    ]);
  });
});

describe('runPromptHeadless', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conductorMocks.createConductorSession.mockResolvedValue({
      id: 'session-123',
      title: 'Session',
      createdAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
    });
    conductorMocks.runConductorTurn.mockResolvedValue({
      sessionId: 'session-123',
      output: ['status line'],
      answer: 'final answer',
    });
    conductorMocks.listConductorSessions.mockResolvedValue([]);
  });

  it('creates a fresh session and prints the session identifier', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let output: string[] = [];

    try {
      await runPromptHeadless('summarize this', '/tmp/workspace');
      output = logSpy.mock.calls.map((call) => String(call[0] ?? ''));
    } finally {
      logSpy.mockRestore();
    }

    expect(conductorMocks.createConductorSession).toHaveBeenCalledWith('/tmp/workspace');
    expect(conductorMocks.runConductorTurn).toHaveBeenCalledWith('summarize this', expect.objectContaining({
      workspaceRoot: '/tmp/workspace',
      sessionId: 'session-123',
      stream: false,
      headless: true,
    }));

    expect(output[0]).toBe('Session: session-123');
    expect(output).toContain('status line');
    expect(output).toContain('final answer');
  });
});
