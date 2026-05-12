import { beforeEach, describe, expect, it, vi } from 'vitest';

const conductorMocks = vi.hoisted(() => ({
  createLocalSkill: vi.fn(),
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
  createLocalSkill: conductorMocks.createLocalSkill,
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
  ActivityBuffer,
  canSubmitParsedInputWhileBusy,
  computeFramePatch,
  ellipsize,
  
  filterPickerItems,
  formatDisplayMessageHeader,
  LiveExecutionPrinter,
  measureDisplayWidth,
  completeSlashCommand,
  nextWrappedIndex,
  padRight,
  parseCommandBarInput,
  parseCommandArgs,
  parseSetModelCommandArgs,
  parseSlashInput,
  previewChildSkillActivityMessage,
  previewMessageFromEvent,
  previewQuestionMessage,
  runPromptHeadless,
  selectMenuItemByTypeahead,
  wrapPlainText,
} from '../src/cli/tui.js';
import { formatToolArgs } from '../src/cli/tool-args.js';

describe('formatToolArgs', () => {
  it('skips undefined values instead of crashing', () => {
    expect(formatToolArgs({ arg0: undefined, arg1: 'hello' })).toBe('arg1=hello');
    expect(formatToolArgs({ arg0: undefined })).toBe('');
  });
});

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

    expect(writes.join('')).toBe('llm Hello world\n\t[research] llm Child\n');
    expect(lines).toEqual([
      'tool web_search(query=alpha)',
      '\t[research] output done',
      '\t[research] clarify Need a date range?',
    ]);
  });

  it('prints stateful tool lifecycle lines', () => {
    const lines: string[] = [];
    const printer = new LiveExecutionPrinter(
      () => {},
      (text) => lines.push(text),
    );

    printer.handle({
      scope: 'main',
      event: {
        type: 'tool_call',
        toolName: 'bash',
        toolArgs: { command: 'printf hello' },
        toolState: 'running',
        toolPid: 4321,
      },
    });
    printer.handle({
      scope: 'main',
      event: {
        type: 'tool_call',
        toolName: 'bash',
        toolArgs: { command: 'printf hello' },
        toolState: 'completed',
        toolPid: 4321,
        toolExitCode: 0,
        toolSummary: 'Command completed successfully',
      },
    });

    expect(lines).toEqual([
      'tool bash(command=printf hello) running pid=4321',
      'tool bash(command=printf hello) completed pid=4321 exit=0',
    ]);
  });
});

describe('ActivityBuffer', () => {
  it('shows active shell status until the tool completes', () => {
    const activity = new ActivityBuffer();

    activity.handle({
      scope: 'main',
      event: {
        type: 'tool_call',
        toolName: 'bash',
        toolArgs: { command: 'printf hello' },
        toolState: 'starting',
      },
    });
    activity.handle({
      scope: 'main',
      event: {
        type: 'tool_call',
        toolName: 'bash',
        toolArgs: { command: 'printf hello' },
        toolState: 'running',
        toolPid: 4321,
      },
    });
    activity.handle({
      scope: 'main',
      event: {
        type: 'log',
        content: 'bash[4321] stdout hello',
      },
    });

    expect(activity.snapshot()).toEqual([
      'Active Tool Status',
      'main bash running pid=4321',
      '',
      'tool bash(command=printf hello) starting',
      'tool bash(command=printf hello) running pid=4321',
      'log bash[4321] stdout hello',
    ]);

    activity.handle({
      scope: 'main',
      event: {
        type: 'tool_call',
        toolName: 'bash',
        toolArgs: { command: 'printf hello' },
        toolState: 'completed',
        toolPid: 4321,
        toolExitCode: 0,
        toolSummary: 'Command completed successfully',
      },
    });

    expect(activity.snapshot()).toEqual([
      'tool bash(command=printf hello) starting',
      'tool bash(command=printf hello) running pid=4321',
      'log bash[4321] stdout hello',
      'tool bash(command=printf hello) completed pid=4321 exit=0',
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

  it('creates a child-skill activity marker for the messages pane', () => {
    expect(previewChildSkillActivityMessage('skill-creator')).toEqual({
      role: 'system',
      kind: 'output',
      tag: 'skill-creator',
      content: 'Running child skill...',
    });
  });
});

describe('formatDisplayMessageHeader', () => {
  it('renders child skill tags on assistant headers', () => {
    expect(formatDisplayMessageHeader({
      role: 'assistant',
      content: '',
      pending: true,
      tag: 'skill-creator',
    }, ' /')).toBe('[Assistant: skill-creator /]');
  });
});

describe('display-width helpers', () => {
  it('measure, wrap, ellipsize, and pad using terminal cell width', () => {
    expect(measureDisplayWidth('你好🙂')).toBe(6);
    expect(wrapPlainText('你好世界abc', 6)).toEqual(['你好世', '界abc']);
    expect(wrapPlainText('🙂🙂a', 4)).toEqual(['🙂🙂', 'a']);
    expect(ellipsize('你好世界', 5)).toBe('你...');
    expect(padRight('🙂好', 6)).toBe('🙂好  ');
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
    expect(parseSlashInput('/compile build a release-note skill')).toEqual({
      kind: 'builtin',
      name: 'compile',
      rawArgs: 'build a release-note skill',
      args: ['build a release-note skill'],
    });
    expect(parseSlashInput('/skill-creator draft a benchmark helper')).toEqual({
      kind: 'builtin',
      name: 'skill-creator',
      rawArgs: 'draft a benchmark helper',
      args: ['draft a benchmark helper'],
    });
    expect(parseSlashInput('/set-model openai:gpt-4.1 --slot run')).toEqual({
      kind: 'builtin',
      name: 'set-model',
      rawArgs: 'openai:gpt-4.1 --slot run',
      args: ['openai:gpt-4.1', '--slot', 'run'],
    });
    expect(parseSlashInput('summarize this')).toEqual({ kind: 'text', prompt: 'summarize this' });
  });

  it('parses /set-model arguments with optional slots', () => {
    expect(parseSetModelCommandArgs('openai:gpt-4.1')).toEqual({
      model: 'openai:gpt-4.1',
    });

    expect(parseSetModelCommandArgs('--slot run anthropic:claude-sonnet-4')).toEqual({
      model: 'anthropic:claude-sonnet-4',
      slot: 'run',
    });

    expect(parseSetModelCommandArgs('google:gemini-2.5-pro --slot=compile')).toEqual({
      model: 'google:gemini-2.5-pro',
      slot: 'compile',
    });
  });

  it('parses direct shell commands and escaped leading bangs', () => {
    expect(parseCommandBarInput('!git status')).toEqual({
      kind: 'shell',
      command: 'git status',
    });

    expect(parseCommandBarInput('  \\!this goes to the conductor')).toEqual({
      kind: 'text',
      prompt: '!this goes to the conductor',
    });
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
    expect(canSubmitParsedInputWhileBusy(parseCommandBarInput('!git status'))).toBe(false);
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

  it('wraps menu indexes and cycles typeahead matches', () => {
    expect(nextWrappedIndex(0, -1, 6)).toBe(5);
    expect(nextWrappedIndex(5, 1, 6)).toBe(0);

    const items = [
      { label: 'Browse All Skills' },
      { label: 'Run Skill…' },
      { label: 'Refresh Skill Catalog' },
    ];

    expect(selectMenuItemByTypeahead(items, 'r')).toBe(1);
    expect(selectMenuItemByTypeahead(items, 'r', 1)).toBe(2);
    expect(selectMenuItemByTypeahead(items, 'z', 1)).toBe(1);
  });

  it('filters picker items by label and description tokens', () => {
    expect(filterPickerItems([
      { label: 'deep-research', description: 'Use a child search skill', detail: '.deepclause/tools/deep-research.dml' },
      { label: 'research-search-reader', description: 'Fetch and inspect papers', detail: '.deepclause/tools/research-search-reader.dml' },
    ], 'child search')).toEqual([
      { label: 'deep-research', description: 'Use a child search skill', detail: '.deepclause/tools/deep-research.dml' },
    ]);
  });
});
