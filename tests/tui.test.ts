import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const conductorMocks = vi.hoisted(() => ({
  appendConductorSessionMessages: vi.fn(),
  createSessionExecutionLogWriter: vi.fn(),
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
  appendConductorSessionMessages: conductorMocks.appendConductorSessionMessages,
  createSessionExecutionLogWriter: conductorMocks.createSessionExecutionLogWriter,
  createLocalSkill: conductorMocks.createLocalSkill,
  createConductorSession: conductorMocks.createConductorSession,
  getConductorSessionDetail: conductorMocks.getConductorSessionDetail,
  listConductorSessions: conductorMocks.listConductorSessions,
  mergeSessionUsage: vi.fn().mockResolvedValue(undefined),
  runConductorTurn: conductorMocks.runConductorTurn,
}));

vi.mock('../src/system/runtime/token-usage.js', () => ({
  recordTokenUsage: vi.fn(),
  createTokenUsageTotals: () => ({
    calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  }),
  isTokenUsageEmpty: () => true,
  mergeTokenUsageMaps: () => ({}),
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
  collectTailWrappedLines,
  computeFramePatch,
  ellipsize,
  
  filterPickerItems,
  formatDisplayMessageBodyLines,
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
  releaseTuiInputStream,
  reconcileEphemeralMessages,
  runFileCommand,
  runPromptHeadless,
  runSlashCommand,
  runSkillCommand,
  sessionMessagesContainCompletedTaskPreview,
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

  it('prints memory compaction events', () => {
    const lines: string[] = [];
    const printer = new LiveExecutionPrinter(
      () => {},
      (text) => lines.push(text),
    );

    printer.handle({
      scope: 'child',
      childSlug: 'research',
      event: {
        type: 'memory_compaction',
        content: 'compact post_task compacted 2 blocks via dml (hybrid) 120 -> 48 tokens',
      },
    });

    expect(lines).toEqual([
      '\t[research] compact post_task compacted 2 blocks via dml (hybrid) 120 -> 48 tokens',
    ]);
  });
});

describe('releaseTuiInputStream', () => {
  it('disables raw mode and pauses TTY inputs', () => {
    const setRawMode = vi.fn();
    const pause = vi.fn();

    releaseTuiInputStream({
      isTTY: true,
      setRawMode,
      pause,
    });

    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('pauses non-tty inputs without touching raw mode', () => {
    const setRawMode = vi.fn();
    const pause = vi.fn();

    releaseTuiInputStream({
      isTTY: false,
      setRawMode,
      pause,
    });

    expect(setRawMode).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
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

  it('returns only the newest activity lines in tail snapshots', () => {
    const activity = new ActivityBuffer();

    activity.handle({ scope: 'main', event: { type: 'output', content: 'first' } });
    activity.handle({ scope: 'main', event: { type: 'output', content: 'second' } });
    activity.handle({ scope: 'main', event: { type: 'output', content: 'third' } });

    expect(activity.snapshotTail(2)).toEqual([
      'output second',
      'output third',
    ]);
  });

  it('stores memory compaction lines in the activity feed', () => {
    const activity = new ActivityBuffer();

    activity.handle({
      scope: 'main',
      event: {
        type: 'memory_compaction',
        content: 'compact pre_task compacted 1 block via builtin (builtin) 60 -> 18 tokens',
      },
    });

    expect(activity.snapshot()).toEqual([
      'compact pre_task compacted 1 block via builtin (builtin) 60 -> 18 tokens',
    ]);
  });
});

describe('previewMessageFromEvent', () => {
  it('maps child output, compaction, and questions into tagged message entries', () => {
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

    expect(previewMessageFromEvent({
      scope: 'child',
      childSlug: 'research-search-reader',
      event: { type: 'memory_compaction', content: 'compact post_task compacted 2 blocks via dml (hybrid) 120 -> 48 tokens' },
    })).toEqual({
      role: 'system',
      kind: 'output',
      tag: 'research-search-reader',
      content: 'Memory compaction: compact post_task compacted 2 blocks via dml (hybrid) 120 -> 48 tokens',
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
    }, ' /')).toBe('[Thinking: skill-creator /]');
  });
});

describe('formatDisplayMessageBodyLines', () => {
  it('marks pending assistant previews as intermediate output', () => {
    expect(formatDisplayMessageBodyLines({
      role: 'assistant',
      content: 'first line\nsecond line',
      pending: true,
    })).toEqual([
      'thinking> first line',
      'thinking> second line',
    ]);

    expect(formatDisplayMessageBodyLines({
      role: 'assistant',
      content: '',
      pending: true,
    })).toEqual([
      'thinking> generating intermediate output...',
    ]);
  });

  it('leaves completed messages unchanged', () => {
    expect(formatDisplayMessageBodyLines({
      role: 'assistant',
      content: 'final answer',
    })).toEqual(['final answer']);
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

  it('collects only the newest wrapped lines for follow-mode panes', () => {
    expect(collectTailWrappedLines(['first', 'second', 'third'], 20, 2)).toEqual({
      lines: ['second', 'third'],
      truncated: true,
    });

    expect(collectTailWrappedLines(['alpha beta', 'gamma'], 6, 2)).toEqual({
      lines: ['beta', 'gamma'],
      truncated: true,
    });
  });
});

describe('reconcileEphemeralMessages', () => {
  it('drops user and assistant entries once the session detail contains them', () => {
    expect(reconcileEphemeralMessages(
      [
        { role: 'user', content: 'Build a skill' },
        { role: 'assistant', content: 'Done.' },
      ],
      [
        { role: 'user', content: 'Build a skill' },
        { role: 'system', kind: 'output', tag: 'skill-creator', content: 'Running child skill...' },
        { role: 'assistant', content: 'Done.' },
      ],
    )).toEqual([
      { role: 'system', kind: 'output', tag: 'skill-creator', content: 'Running child skill...' },
    ]);
  });

  it('keeps unmatched or pending preview entries visible', () => {
    expect(reconcileEphemeralMessages(
      [{ role: 'user', content: 'Build a skill' }],
      [
        { role: 'assistant', content: 'Still streaming...', pending: true },
        { role: 'assistant', content: 'New answer' },
      ],
    )).toEqual([
      { role: 'assistant', content: 'Still streaming...', pending: true },
      { role: 'assistant', content: 'New answer' },
    ]);
  });
});

describe('sessionMessagesContainCompletedTaskPreview', () => {
  it('recognizes when a task preview user-answer pair has been persisted', () => {
    expect(sessionMessagesContainCompletedTaskPreview(
      [
        { role: 'user', content: 'Find papers' },
        { role: 'assistant', content: 'Here are the results.' },
      ],
      [
        { role: 'user', content: 'Find papers' },
        { role: 'system', kind: 'output', tag: 'research', content: 'Searching...' },
        { role: 'assistant', content: 'Here are the results.' },
      ],
    )).toBe(true);
  });

  it('does not match incomplete or different previews', () => {
    expect(sessionMessagesContainCompletedTaskPreview(
      [{ role: 'user', content: 'Find papers' }, { role: 'assistant', content: 'Different answer' }],
      [{ role: 'user', content: 'Find papers' }, { role: 'assistant', content: 'Here are the results.' }],
    )).toBe(false);
  });
});

describe('runPromptHeadless', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conductorMocks.createSessionExecutionLogWriter.mockReturnValue({
      recordEvent: vi.fn(),
      finish: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    });
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

  it('logs direct skill executions to the active session log writer', async () => {
    commandMocks.listCommands.mockResolvedValue([{ name: 'research', path: '/tmp/workspace/.deepclause/tools/research.dml' }]);
    runMocks.run.mockImplementation(async (file, args, options: any) => {
      options.onEvent?.({ type: 'output', content: 'skill output' });
      options.onChildEvent?.('child-step', { type: 'error', content: 'child failure' });
      return { output: ['skill output'], answer: 'skill answer' };
    });

    const logWriter = {
      recordEvent: vi.fn(),
      finish: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    conductorMocks.createSessionExecutionLogWriter.mockReturnValue(logWriter);

    const result = await runSkillCommand('/tmp/workspace', 'research', ['alpha'], {
      sessionId: 'session-123',
    });

    expect(conductorMocks.createSessionExecutionLogWriter).toHaveBeenCalledWith({
      workspaceRoot: '/tmp/workspace',
      sessionId: 'session-123',
      executionKind: 'skill',
      inputText: '/research alpha',
      skillName: 'research',
      args: ['alpha'],
    });
    expect(logWriter.recordEvent).toHaveBeenCalledWith({
      scope: 'child',
      childSlug: 'research',
      event: { type: 'output', content: 'skill output' },
    });
    expect(logWriter.recordEvent).toHaveBeenCalledWith({
      scope: 'child',
      childSlug: 'child-step',
      event: { type: 'error', content: 'child failure' },
    });
    expect(logWriter.finish).toHaveBeenCalledWith({
      status: 'success',
      answer: 'skill answer',
      error: undefined,
      outputCount: 1,
    });
    expect(result).toEqual({ output: ['skill output'], answer: 'skill answer' });
  });

  it('runs a workspace DML file via /run and records it in the session log', async () => {
    const workspaceRoot = await mkdirTempWorkspace();
    const logWriter = {
      recordEvent: vi.fn(),
      finish: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    conductorMocks.createSessionExecutionLogWriter.mockReturnValue(logWriter);
    runMocks.run.mockImplementation(async (_file, _args, options: any) => {
      options.onEvent?.({ type: 'output', content: 'file output' });
      return { output: ['file output'], answer: 'file answer' };
    });

    try {
      const plansDir = join(workspaceRoot, 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'alpha.dml'), 'agent_main :- answer("ok").\n', 'utf8');

      const result = await runFileCommand(workspaceRoot, 'alpha', ['arg1'], {
        sessionId: 'session-123',
      });

      expect(runMocks.run).toHaveBeenCalledWith(expect.stringMatching(/plans\/alpha\.dml$/), ['arg1'], expect.any(Object));
      expect(conductorMocks.createSessionExecutionLogWriter).toHaveBeenCalledWith({
        workspaceRoot,
        sessionId: 'session-123',
        executionKind: 'skill',
        inputText: '/run alpha arg1',
        skillName: 'alpha',
        args: ['arg1'],
      });
      expect(logWriter.recordEvent).toHaveBeenCalledWith({
        scope: 'child',
        childSlug: 'alpha',
        event: { type: 'output', content: 'file output' },
      });
      expect(result).toEqual({ output: ['file output'], answer: 'file answer' });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('falls back to plans/<name>.dml for unknown slash commands', async () => {
    const workspaceRoot = await mkdirTempWorkspace();
    const logWriter = {
      recordEvent: vi.fn(),
      finish: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    conductorMocks.createSessionExecutionLogWriter.mockReturnValue(logWriter);
    commandMocks.listCommands.mockResolvedValue([]);
    runMocks.run.mockResolvedValue({ output: ['plan output'], answer: 'plan answer' });

    try {
      const plansDir = join(workspaceRoot, 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'feature_x.dml'), 'agent_main :- answer("ok").\n', 'utf8');

      const result = await runSlashCommand(workspaceRoot, 'feature_x', [] , {
        sessionId: 'session-123',
      });

      expect(runMocks.run).toHaveBeenCalledWith(expect.stringMatching(/plans\/feature_x\.dml$/), [], expect.any(Object));
      expect(conductorMocks.appendConductorSessionMessages).toHaveBeenCalledWith(
        workspaceRoot,
        'session-123',
        [
          { role: 'user', content: '/feature_x' },
          { role: 'assistant', content: 'plan answer' },
        ],
      );
      expect(result).toEqual({ output: ['plan output'], answer: 'plan answer' });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('persists slash-command failures into the session transcript', async () => {
    const workspaceRoot = await mkdirTempWorkspace();
    const logWriter = {
      recordEvent: vi.fn(),
      finish: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    conductorMocks.createSessionExecutionLogWriter.mockReturnValue(logWriter);
    commandMocks.listCommands.mockResolvedValue([]);
    runMocks.run.mockRejectedValue(new Error('plan exploded'));

    try {
      const plansDir = join(workspaceRoot, 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'feature_x.dml'), 'agent_main :- answer("ok").\n', 'utf8');

      await expect(runSlashCommand(workspaceRoot, 'feature_x', ['alpha'], {
        sessionId: 'session-123',
      })).rejects.toThrow('plan exploded');

      expect(conductorMocks.appendConductorSessionMessages).toHaveBeenCalledWith(
        workspaceRoot,
        'session-123',
        [
          { role: 'user', content: '/feature_x alpha' },
          { role: 'assistant', content: 'plan exploded' },
        ],
      );
      expect(logWriter.finish).toHaveBeenCalledWith({
        status: 'error',
        error: 'plan exploded',
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
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
    expect(parseSlashInput('/run plans/feature_x.dml alpha')).toEqual({
      kind: 'builtin',
      name: 'run',
      rawArgs: 'plans/feature_x.dml alpha',
      args: ['plans/feature_x.dml', 'alpha'],
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
      persistOutput: false,
    });

    expect(parseCommandBarInput('!!git status')).toEqual({
      kind: 'shell',
      command: 'git status',
      persistOutput: true,
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

describe('single-parameter argument collapsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conductorMocks.createSessionExecutionLogWriter.mockReturnValue({
      recordEvent: vi.fn(),
      finish: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    });
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
    runMocks.run.mockResolvedValue({ output: [], answer: undefined });
  });

  describe('runSkillCommand', () => {
    it('collapses multiple args into single string for single-parameter skill', async () => {
      commandMocks.listCommands.mockResolvedValue([{
        name: 'summarize',
        path: '/tmp/workspace/.deepclause/tools/summarize.dml',
        description: 'Summarizes text',
        usage: '/summarize <text>',
        parameters: [
          { name: 'text', description: 'Text to summarize', required: true, position: 0 },
        ],
      }]);
      runMocks.run.mockImplementation(async (_file: string, _args: string[], options: any) => {
        options.onEvent?.({ type: 'output', content: 'skill output' });
        return { output: ['skill output'], answer: 'skill answer' };
      });

      await runSkillCommand('/tmp/workspace', 'summarize', ['hello world', 'foo bar'], {
        sessionId: 'session-1',
      });

      // Verify the log writer received collapsed args
      expect(conductorMocks.createSessionExecutionLogWriter).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['hello world foo bar'],
          skillName: 'summarize',
        }),
      );
    });

    it('does not collapse args for multi-parameter skill', async () => {
      commandMocks.listCommands.mockResolvedValue([{
        name: 'compare',
        path: '/tmp/workspace/.deepclause/tools/compare.dml',
        description: 'Compares two items',
        usage: '/compare <source> <target>',
        parameters: [
          { name: 'source', description: 'Source item', required: true, position: 0 },
          { name: 'target', description: 'Target item', required: true, position: 1 },
        ],
      }]);
      runMocks.run.mockImplementation(async (_file: string, _args: string[], options: any) => {
        options.onEvent?.({ type: 'output', content: 'skill output' });
        return { output: ['skill output'], answer: 'skill answer' };
      });

      await runSkillCommand('/tmp/workspace', 'compare', ['alpha', 'beta'], {
        sessionId: 'session-1',
      });

      // Verify args remain as separate elements
      expect(conductorMocks.createSessionExecutionLogWriter).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['alpha', 'beta'],
          skillName: 'compare',
        }),
      );
    });

    it('passes through args unchanged when skill has no parameters array', async () => {
      commandMocks.listCommands.mockResolvedValue([{
        name: 'refresh',
        path: '/tmp/workspace/.deepclause/tools/refresh.dml',
        description: 'Refreshes state',
        usage: '/refresh',
      }]);
      runMocks.run.mockImplementation(async (_file: string, _args: string[], options: any) => {
        options.onEvent?.({ type: 'output', content: 'skill output' });
        return { output: ['skill output'], answer: 'skill answer' };
      });

      await runSkillCommand('/tmp/workspace', 'refresh', ['something'], {
        sessionId: 'session-1',
      });

      // No parameters means no collapsing — args pass through
      expect(conductorMocks.createSessionExecutionLogWriter).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['something'],
          skillName: 'refresh',
        }),
      );
    });

    it('leaves empty args untouched regardless of parameter count', async () => {
      commandMocks.listCommands.mockResolvedValue([{
        name: 'summarize',
        path: '/tmp/workspace/.deepclause/tools/summarize.dml',
        description: 'Summarizes text',
        usage: '/summarize <text>',
        parameters: [
          { name: 'text', description: 'Text to summarize', required: true, position: 0 },
        ],
      }]);
      runMocks.run.mockImplementation(async (_file: string, _args: string[], options: any) => {
        options.onEvent?.({ type: 'output', content: 'skill output' });
        return { output: ['skill output'], answer: 'skill answer' };
      });

      await runSkillCommand('/tmp/workspace', 'summarize', [], {
        sessionId: 'session-1',
      });

      // Empty args should stay empty, not become ['']
      expect(conductorMocks.createSessionExecutionLogWriter).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [],
          skillName: 'summarize',
        }),
      );
    });
  });

  describe('runSlashCommand', () => {
    it('collapses args for known single-parameter skill', async () => {
      commandMocks.listCommands.mockResolvedValue([{
        name: 'summarize',
        path: '/tmp/workspace/.deepclause/tools/summarize.dml',
        description: 'Summarizes text',
        usage: '/summarize <text>',
        parameters: [
          { name: 'text', description: 'Text to summarize', required: true, position: 0 },
        ],
      }]);
      runMocks.run.mockImplementation(async (_file: string, _args: string[], options: any) => {
        options.onEvent?.({ type: 'output', content: 'skill output' });
        return { output: ['skill output'], answer: 'skill answer' };
      });

      await runSlashCommand('/tmp/workspace', 'summarize', ['hello world', 'foo bar'], {
        sessionId: 'session-1',
      });

      expect(conductorMocks.createSessionExecutionLogWriter).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['hello world foo bar'],
          skillName: 'summarize',
        }),
      );
    });

    it('does not collapse args for multi-parameter skill', async () => {
      commandMocks.listCommands.mockResolvedValue([{
        name: 'compare',
        path: '/tmp/workspace/.deepclause/tools/compare.dml',
        description: 'Compares two items',
        usage: '/compare <source> <target>',
        parameters: [
          { name: 'source', description: 'Source item', required: true, position: 0 },
          { name: 'target', description: 'Target item', required: true, position: 1 },
        ],
      }]);
      runMocks.run.mockImplementation(async (_file: string, _args: string[], options: any) => {
        options.onEvent?.({ type: 'output', content: 'skill output' });
        return { output: ['skill output'], answer: 'skill answer' };
      });

      await runSlashCommand('/tmp/workspace', 'compare', ['alpha', 'beta'], {
        sessionId: 'session-1',
      });

      expect(conductorMocks.createSessionExecutionLogWriter).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['alpha', 'beta'],
          skillName: 'compare',
        }),
      );
    });

    it('passes through args unchanged for unknown skills (fallback to plans)', async () => {
      const workspaceRoot = await mkdirTempWorkspace();

      try {
        commandMocks.listCommands.mockResolvedValue([]);

        const plansDir = join(workspaceRoot, 'plans');
        await mkdir(plansDir, { recursive: true });
        await writeFile(join(plansDir, 'feature_x.dml'), 'agent_main :- answer("ok").\n', 'utf8');

        let capturedArgs: string[] = [];
        runMocks.run.mockImplementation(async (_file, args: string[], options: any) => {
          capturedArgs = args;
          options.onEvent?.({ type: 'output', content: 'plan output' });
          return { output: ['plan output'], answer: 'plan answer' };
        });

        await runSlashCommand(workspaceRoot, 'feature_x', ['arg1', 'arg2'], {
          sessionId: 'session-1',
        });

        // When falling back to plans, no metadata is available so args pass through unchanged
        expect(capturedArgs).toEqual(['arg1', 'arg2']);
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('collapses args even with many space-separated tokens', async () => {
      commandMocks.listCommands.mockResolvedValue([{
        name: 'summarize',
        path: '/tmp/workspace/.deepclause/tools/summarize.dml',
        description: 'Summarizes text',
        usage: '/summarize <text>',
        parameters: [
          { name: 'text', description: 'Text to summarize', required: true, position: 0 },
        ],
      }]);
      runMocks.run.mockImplementation(async (_file: string, _args: string[], options: any) => {
        options.onEvent?.({ type: 'output', content: 'skill output' });
        return { output: ['skill output'], answer: 'skill answer' };
      });

      await runSlashCommand('/tmp/workspace', 'summarize', ['a', 'b', 'c', 'd', 'e'], {
        sessionId: 'session-1',
      });

      expect(conductorMocks.createSessionExecutionLogWriter).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['a b c d e'],
          skillName: 'summarize',
        }),
      );
    });
  });
});


async function mkdirTempWorkspace(): Promise<string> {
  const workspaceRoot = join(tmpdir(), `deepclause-tui-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}
