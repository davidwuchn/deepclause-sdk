import { beforeEach, describe, expect, it, vi } from 'vitest';

const conductorMocks = vi.hoisted(() => ({
  createConductorSession: vi.fn(),
  getConductorSessionDetail: vi.fn(),
  listConductorSessions: vi.fn(),
  runConductorTurn: vi.fn(),
}));

const commandMocks = vi.hoisted(() => ({
  listCommands: vi.fn(),
}));

const runMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('../src/system/runtime/conductor.js', () => ({
  createConductorSession: conductorMocks.createConductorSession,
  getConductorSessionDetail: conductorMocks.getConductorSessionDetail,
  listConductorSessions: conductorMocks.listConductorSessions,
  runConductorTurn: conductorMocks.runConductorTurn,
}));

vi.mock('../src/cli/commands.js', () => ({
  listCommands: commandMocks.listCommands,
}));

vi.mock('../src/cli/run.js', () => ({
  run: runMocks.run,
}));

import {
  canSubmitParsedInputWhileBusy,
  computeFramePatch,
  LiveExecutionPrinter,
  completeSlashCommand,
  parseCommandArgs,
  parseSlashInput,
  previewMessageFromEvent,
  previewQuestionMessage,
  runPromptHeadless,
} from '../src/cli/tui.js';

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
    printer.handle({ scope: 'child', childSlug: 'research', event: { type: 'input_required', prompt: 'Need a date range?' } });
    printer.finish();

    expect(writes.join('')).toBe('llm Hello world\n[research] llm Child\n');
    expect(lines).toEqual([
      'tool web_search(query=alpha)',
      '[research] output done',
      '[research] clarify Need a date range?',
    ]);
  });
});

describe('previewMessageFromEvent', () => {
  it('maps child output and questions into tagged message entries', () => {
    expect(previewMessageFromEvent({
      scope: 'child',
      childSlug: 'research-search-reader',
      event: { type: 'output', content: 'Gathering sources...' },
    })).toEqual({
      role: 'system',
      kind: 'output',
      tag: 'research-search-reader',
      content: 'Gathering sources...',
    });

    expect(previewMessageFromEvent({
      scope: 'child',
      childSlug: 'research-search-reader',
      event: { type: 'input_required', prompt: 'Which papers matter most?' },
    })).toEqual({
      role: 'system',
      kind: 'question',
      tag: 'research-search-reader',
      content: 'Which papers matter most?',
    });
  });

  it('parses tagged clarification prompts from callbacks', () => {
    expect(previewQuestionMessage('[research-search-reader] Need a date range?')).toEqual({
      role: 'system',
      kind: 'question',
      tag: 'research-search-reader',
      content: 'Need a date range?',
    });
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
    conductorMocks.getConductorSessionDetail.mockResolvedValue({
      id: 'session-123',
      title: 'Session',
      createdAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
      messages: [],
      assistantMemory: '',
      taskMemory: '',
    });
    conductorMocks.listConductorSessions.mockResolvedValue([]);
    commandMocks.listCommands.mockResolvedValue([]);
    runMocks.run.mockResolvedValue({ output: [], answer: undefined });
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

describe('slash command parsing', () => {
  it('parses quoted skill arguments', () => {
    expect(parseCommandArgs('alpha "two words" 3')).toEqual(['alpha', 'two words', '3']);
    expect(parseSlashInput('/research alpha "two words" 3')).toEqual({
      kind: 'skill',
      name: 'research',
      rawArgs: 'alpha "two words" 3',
      args: ['alpha', 'two words', '3'],
    });
  });

  it('treats built-ins separately from skills', () => {
    expect(parseSlashInput('/new Planning Session')).toEqual({
      kind: 'builtin',
      name: 'new',
      rawArgs: 'Planning Session',
      args: ['Planning Session'],
    });
    expect(parseSlashInput('summarize this')).toEqual({ kind: 'text', prompt: 'summarize this' });
  });

  it('completes slash commands and skills', () => {
    expect(completeSlashCommand('/rese', ['research'])).toEqual({
      value: '/research ',
      matches: ['research'],
      applied: true,
    });

    expect(completeSlashCommand('/re', ['report', 'research'])).toEqual({
      value: '/re',
      matches: ['report', 'research'],
      applied: false,
    });
  });

  it('only allows cancel-or-exit commands while busy', () => {
    expect(canSubmitParsedInputWhileBusy(parseSlashInput('/cancel'))).toBe(true);
    expect(canSubmitParsedInputWhileBusy(parseSlashInput('/quit'))).toBe(true);
    expect(canSubmitParsedInputWhileBusy(parseSlashInput('/sessions'))).toBe(false);
    expect(canSubmitParsedInputWhileBusy(parseSlashInput('keep going'))).toBe(false);
  });

  it('computes minimal frame patches when only a few rows change', () => {
    expect(computeFramePatch(
      ['row 1', 'row 2', 'row 3'],
      ['row 1', 'row 2 updated', 'row 3'],
      { columns: 80, rows: 3 },
      { columns: 80, rows: 3 },
    )).toEqual({
      fullRender: false,
      changedRows: [{ row: 2, line: 'row 2 updated' }],
    });

    expect(computeFramePatch(
      ['row 1'],
      ['row 1'],
      { columns: 80, rows: 1 },
      { columns: 100, rows: 1 },
    )).toEqual({
      fullRender: true,
      changedRows: [],
    });
  });
});
