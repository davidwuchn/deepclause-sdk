import { emitKeypressEvents } from 'readline';
import { createInterface, type Interface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { listCommands, type CommandInfo } from './commands.js';
import { run, type RunResult as CliRunResult } from './run.js';
import {
  createConductorSession,
  getConductorSessionDetail,
  listConductorSessions,
  runConductorTurn,
  type ConductorLogEvent,
  type ConductorSessionDetail,
  type ConductorSessionSummary,
} from '../system/runtime/conductor.js';
import type { DMLEvent } from '../types.js';

const IGNORED_LIVE_LOG_TOOLS = new Set(['set_result', 'update_memory']);
const BUILTIN_SLASH_COMMANDS = ['new', 'sessions', 'help', 'cancel', 'exit', 'quit'] as const;
const MAX_ACTIVITY_LINES = 400;
const SPINNER_FRAMES = ['|', '/', '-', '\\'] as const;
const IDLE_RENDER_INTERVAL_MS = 16;
const BUSY_RENDER_INTERVAL_MS = 40;
const TYPING_RENDER_INTERVAL_MS = 90;

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  black: '\u001b[30m',
  red: '\u001b[31m',
  blue: '\u001b[34m',
  white: '\u001b[37m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  brightYellow: '\u001b[93m',
  brightCyan: '\u001b[96m',
  brightWhite: '\u001b[97m',
  bgBlue: '\u001b[48;2;0;0;95m',
  bgCyan: '\u001b[48;2;0;96;128m',
  bgWhite: '\u001b[47m',
};

type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];
type Keypress = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string };
type PaneKind = 'sessions' | 'messages' | 'process' | 'context';

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  pending?: boolean;
  error?: boolean;
  tag?: string;
  kind?: 'output' | 'question';
}

interface RunningPreview {
  sessionId: string;
  kind: 'task' | 'skill';
  rootTag?: string;
  entries: DisplayMessage[];
}

export type ParsedTuiInput =
  | { kind: 'text'; prompt: string }
  | { kind: 'builtin'; name: BuiltinSlashCommand; rawArgs: string; args: string[] }
  | { kind: 'skill'; name: string; rawArgs: string; args: string[] };

export interface SlashCompletionResult {
  value: string;
  matches: string[];
  applied: boolean;
}

export class LiveExecutionPrinter {
  private activeStreamKey: string | null = null;
  private streamOpen = false;

  constructor(
    private readonly write: (text: string) => void = (text) => process.stdout.write(text),
    private readonly writeLine: (text: string) => void = (text) => console.log(text),
  ) {}

  handle(logEvent: ConductorLogEvent): void {
    const { event } = logEvent;

    if (event.type === 'usage' || event.type === 'finished') {
      return;
    }

    if (event.type === 'stream') {
      this.handleStream(logEvent);
      return;
    }

    this.flushStream();

    switch (event.type) {
      case 'tool_call':
        if (!event.toolName || IGNORED_LIVE_LOG_TOOLS.has(event.toolName)) {
          return;
        }
        this.writeLine(`${formatEventPrefix(logEvent)}tool ${event.toolName}(${formatToolArgs(event.toolArgs)})`);
        break;

      case 'output':
        if (event.content) {
          this.writeLine(`${formatEventPrefix(logEvent)}output ${event.content}`);
        }
        break;

      case 'answer':
        if (event.content) {
          this.writeLine(`${formatEventPrefix(logEvent)}answer ${event.content}`);
        }
        break;

      case 'error':
        if (event.content) {
          this.writeLine(`${formatEventPrefix(logEvent)}error ${event.content}`);
        }
        break;

      case 'log':
        if (event.content) {
          this.writeLine(`${formatEventPrefix(logEvent)}log ${event.content}`);
        }
        break;

      case 'input_required':
        if (event.prompt) {
          this.writeLine(`${formatEventPrefix(logEvent)}clarify ${event.prompt}`);
        }
        break;
    }
  }

  finish(): void {
    this.flushStream();
  }

  private handleStream(logEvent: ConductorLogEvent): void {
    const streamKey = logEvent.scope === 'child' ? `child:${logEvent.childSlug ?? '?'}` : 'main';

    if (this.activeStreamKey !== streamKey) {
      this.flushStream();
      this.write(`${streamLabel(logEvent)} `);
      this.activeStreamKey = streamKey;
      this.streamOpen = true;
    }

    if (logEvent.event.content) {
      this.write(logEvent.event.content);
    }

    if (logEvent.event.done) {
      this.flushStream();
    }
  }

  private flushStream(): void {
    if (!this.streamOpen) {
      this.activeStreamKey = null;
      return;
    }

    this.write('\n');
    this.streamOpen = false;
    this.activeStreamKey = null;
  }
}

class ActivityBuffer {
  private readonly lines: string[] = [];
  private activeStreamKey: string | null = null;
  private activeStreamLine = '';

  handle(logEvent: ConductorLogEvent): void {
    const { event } = logEvent;

    if (event.type === 'usage' || event.type === 'finished') {
      return;
    }

    if (event.type === 'stream') {
      this.handleStream(logEvent);
      return;
    }

    this.flushStream();

    switch (event.type) {
      case 'tool_call':
        if (!event.toolName || IGNORED_LIVE_LOG_TOOLS.has(event.toolName)) {
          return;
        }
        this.pushLine(`${formatEventPrefix(logEvent)}tool ${event.toolName}(${formatToolArgs(event.toolArgs)})`);
        break;

      case 'output':
        if (event.content) {
          this.pushLine(`${formatEventPrefix(logEvent)}output ${event.content}`);
        }
        break;

      case 'answer':
        if (event.content) {
          this.pushLine(`${formatEventPrefix(logEvent)}answer ${event.content}`);
        }
        break;

      case 'error':
        if (event.content) {
          this.pushLine(`${formatEventPrefix(logEvent)}error ${event.content}`);
        }
        break;

      case 'log':
        if (event.content) {
          this.pushLine(`${formatEventPrefix(logEvent)}log ${event.content}`);
        }
        break;

      case 'input_required':
        if (event.prompt) {
          this.pushLine(`${formatEventPrefix(logEvent)}clarify ${event.prompt}`);
        }
        break;
    }
  }

  pushLine(line: string): void {
    this.flushStream();
    if (!line) {
      return;
    }
    this.lines.push(line);
    this.trim();
  }

  finish(): void {
    this.flushStream();
  }

  snapshot(): string[] {
    return this.activeStreamLine
      ? [...this.lines, this.activeStreamLine]
      : [...this.lines];
  }

  private handleStream(logEvent: ConductorLogEvent): void {
    const streamKey = logEvent.scope === 'child' ? `child:${logEvent.childSlug ?? '?'}` : 'main';

    if (this.activeStreamKey !== streamKey) {
      this.flushStream();
      this.activeStreamKey = streamKey;
      this.activeStreamLine = `${streamLabel(logEvent)} `;
    }

    if (logEvent.event.content) {
      this.activeStreamLine += logEvent.event.content;
    }

    if (logEvent.event.done) {
      this.flushStream();
    }
  }

  private flushStream(): void {
    if (!this.activeStreamLine) {
      this.activeStreamKey = null;
      return;
    }

    this.lines.push(this.activeStreamLine);
    this.activeStreamLine = '';
    this.activeStreamKey = null;
    this.trim();
  }

  private trim(): void {
    if (this.lines.length > MAX_ACTIVITY_LINES) {
      this.lines.splice(0, this.lines.length - MAX_ACTIVITY_LINES);
    }
  }
}

class FullscreenTui {
  private sessions: ConductorSessionSummary[] = [];
  private selectedSessionId = '';
  private sessionDetail: ConductorSessionDetail | null = null;
  private commands: CommandInfo[] = [];
  private readonly activityBySessionId = new Map<string, ActivityBuffer>();
  private readonly ephemeralMessagesBySessionId = new Map<string, DisplayMessage[]>();
  private focusedPane: PaneKind = 'messages';
  private readonly paneScroll = {
    sessions: 0,
    messages: 0,
    process: 0,
    context: 0,
  };
  private currentPreview: RunningPreview | null = null;
  private currentAbortController: AbortController | null = null;
  private inputValue = '';
  private cursor = 0;
  private busy = false;
  private exitRequested = false;
  private statusLine = 'Loading...';
  private pendingQuestion: { prompt: string; resolve: (value: string) => void } | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private closeResolver: (() => void) | null = null;
  private lastRenderAt = 0;
  private previousFrameLines: string[] | null = null;
  private previousFrameSize: { columns: number; rows: number } | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: { sandbox?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    try {
      await this.refreshCommands();
      await this.refreshSessions({ createIfMissing: true });
      this.statusLine = 'Ready. Left/right changes pane. Up/down and PgUp/PgDn scroll the focused pane when input is empty.';

      emitKeypressEvents(input);
      if (input.isTTY) {
        input.setRawMode(true);
      }
      input.on('keypress', this.onKeypress);
      output.write('\u001b[?1049h\u001b[2J\u001b[H');
      this.requestRender();

      await new Promise<void>((resolve) => {
        this.closeResolver = resolve;
      });
    } finally {
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = null;
      }
      if (this.animationTimer) {
        clearInterval(this.animationTimer);
        this.animationTimer = null;
      }
      input.off('keypress', this.onKeypress);
      if (input.isTTY) {
        input.setRawMode(false);
      }
      this.previousFrameLines = null;
      this.previousFrameSize = null;
      output.write('\u001b[?25h\u001b[?1049l');
    }
  }

  private readonly onKeypress = (text: string, key: Keypress): void => {
    void this.handleKeypress(text, key);
  };

  private async handleKeypress(text: string, key: Keypress): Promise<void> {
    if (key.ctrl && key.name === 'w') {
      this.cyclePaneFocus(1);
      return;
    }

    if (key.ctrl && key.name === 'c') {
      if (this.pendingQuestion) {
        const pending = this.pendingQuestion;
        this.pendingQuestion = null;
        pending.resolve('');
      }
      if (this.busy) {
        this.exitRequested = true;
        this.cancelCurrentExecution('Cancelling current execution, then quitting...');
        return;
      }
      this.close();
      return;
    }

    switch (key.name) {
      case 'return':
        await this.submitInput();
        return;

      case 'backspace':
        this.deleteBackward();
        break;

      case 'delete':
        this.deleteForward();
        break;

      case 'left':
        if (!this.inputValue) {
          this.cyclePaneFocus(-1);
          return;
        }
        if (this.cursor > 0) {
          this.cursor -= 1;
        }
        break;

      case 'right':
        if (!this.inputValue) {
          this.cyclePaneFocus(1);
          return;
        }
        if (this.cursor < this.inputValue.length) {
          this.cursor += 1;
        }
        break;

      case 'home':
        if (!this.inputValue) {
          this.jumpFocusedPane('top');
          return;
        }
        this.cursor = 0;
        break;

      case 'end':
        if (!this.inputValue) {
          this.jumpFocusedPane('bottom');
          return;
        }
        this.cursor = this.inputValue.length;
        break;

      case 'up':
        if (!this.inputValue) {
          await this.handleUpDown(-1);
          return;
        }
        break;

      case 'down':
        if (!this.inputValue) {
          await this.handleUpDown(1);
          return;
        }
        break;

      case 'pageup':
        if (!this.inputValue) {
          this.scrollFocusedPane('up', this.pageScrollAmount());
          return;
        }
        break;

      case 'pagedown':
        if (!this.inputValue) {
          this.scrollFocusedPane('down', this.pageScrollAmount());
          return;
        }
        break;

      case 'tab':
        await this.applyCompletion();
        return;

      case 'escape':
        this.inputValue = '';
        this.cursor = 0;
        break;

      default:
        if (text && !key.ctrl && !key.meta) {
          this.insertText(text);
        }
        break;
    }

    this.requestRender();
  }

  private async submitInput(): Promise<void> {
    const rawInput = this.inputValue;
    const trimmedInput = rawInput.trim();
    this.inputValue = '';
    this.cursor = 0;

    if (this.pendingQuestion) {
      const pending = this.pendingQuestion;
      this.pendingQuestion = null;
      pending.resolve(trimmedInput);
      this.statusLine = 'Continuing...';
      this.requestRender();
      return;
    }

    if (!trimmedInput) {
      this.requestRender();
      return;
    }

    const parsed = parseSlashInput(trimmedInput);
    if (this.busy && !this.pendingQuestion && !canSubmitParsedInputWhileBusy(parsed)) {
      this.statusLine = 'Execution is still running. Use /cancel or Ctrl+C to stop it.';
      this.requestRender();
      return;
    }

    if (parsed.kind === 'builtin') {
      await this.executeBuiltin(parsed);
      return;
    }
    if (parsed.kind === 'skill') {
      await this.executeSkill(parsed.name, parsed.args);
      return;
    }

    await this.executeTask(parsed.prompt);
  }

  private async executeBuiltin(parsed: Extract<ParsedTuiInput, { kind: 'builtin' }>): Promise<void> {
    switch (parsed.name) {
      case 'cancel':
        this.cancelCurrentExecution('Cancellation requested.');
        return;

      case 'exit':
      case 'quit':
        this.close();
        return;

      case 'help': {
        const activity = this.currentProcessActivity();
        for (const line of buildHelpLines()) {
          activity.pushLine(line);
        }
        this.statusLine = 'Help added to the process pane.';
        this.requestRender();
        return;
      }

      case 'sessions':
        await this.refreshSessions({ createIfMissing: true, selectedSessionId: this.selectedSessionId });
        await this.refreshCommands();
        this.statusLine = `Loaded ${this.sessions.length} session${this.sessions.length === 1 ? '' : 's'}.`;
        this.requestRender();
        return;

      case 'new': {
        const created = await createConductorSession(this.workspaceRoot, parsed.rawArgs || undefined);
        await this.refreshSessions({ createIfMissing: true, selectedSessionId: created.id });
        this.statusLine = `Created session ${created.title}.`;
        this.requestRender();
        return;
      }
    }
  }

  private async executeTask(promptText: string): Promise<void> {
    const sessionId = this.selectedSessionId;
    const activity = this.activityFor(sessionId);
    this.focusedPane = 'messages';
    this.paneScroll.messages = 0;
    this.paneScroll.process = 0;
    this.beginExecutionPreview(sessionId, 'task', { role: 'user', content: promptText });
    activity.pushLine(`task ${promptText}`);
    this.busy = true;
    this.currentAbortController = new AbortController();
    this.startAnimation();
    this.statusLine = 'Running conductor...';
    this.requestRender();

    try {
      const result = await runConductorTurn(promptText, {
        workspaceRoot: this.workspaceRoot,
        sessionId,
        stream: true,
        headless: true,
        sandbox: this.options.sandbox,
        signal: this.currentAbortController.signal,
        onUserInput: (question) => this.requestClarification(question),
        onEvent: (event) => {
          activity.handle(event);
          this.updatePreviewFromEvent(event);
          this.requestRender();
        },
      });

      activity.finish();
      await this.refreshSessions({ createIfMissing: true, selectedSessionId: result.sessionId });
      await this.refreshCommands();
      this.finishExecutionPreview({ persist: false });
      this.statusLine = result.error ? 'Task failed.' : 'Task finished.';
    } catch (error) {
      activity.finish();
      const message = (error as Error).message;
      activity.pushLine(`error ${message}`);
      this.finishExecutionPreview({ persist: true, error: message });
      this.statusLine = 'Task failed.';
    } finally {
      this.busy = false;
      this.currentAbortController = null;
      this.stopAnimation();
      if (this.exitRequested) {
        this.close();
      } else {
        this.requestRender();
      }
    }
  }

  private async executeSkill(skillName: string, args: string[]): Promise<void> {
    const sessionId = this.selectedSessionId || 'global';
    const activity = this.activityFor(sessionId);
    const commandText = `/${skillName}${args.length > 0 ? ` ${args.join(' ')}` : ''}`;
    this.focusedPane = 'messages';
    this.paneScroll.messages = 0;
    this.paneScroll.process = 0;
    this.beginExecutionPreview(sessionId, 'skill', { role: 'system', content: commandText }, skillName);
    activity.pushLine(`skill /${skillName}${args.length > 0 ? ` ${args.join(' ')}` : ''}`);
    this.busy = true;
    this.currentAbortController = new AbortController();
    this.startAnimation();
    this.statusLine = `Running /${skillName}...`;
    this.requestRender();

    try {
      const result = await runSkillCommand(this.workspaceRoot, skillName, args, {
        sandbox: this.options.sandbox,
        signal: this.currentAbortController.signal,
        onUserInput: (question) => this.requestClarification(question),
        onEvent: (event) => {
          activity.handle(event);
          this.updatePreviewFromEvent(event);
          this.requestRender();
        },
      });
      activity.finish();
      await this.refreshCommands();
      this.finishExecutionPreview({
        persist: true,
        finalText: result.answer || summarizeRunResult(result),
        error: result.error,
      });
      this.statusLine = result.error ? `/${skillName} failed.` : `/${skillName} finished.`;
    } catch (error) {
      activity.finish();
      const message = (error as Error).message;
      activity.pushLine(`[${skillName}] error ${message}`);
      this.finishExecutionPreview({ persist: true, error: message });
      this.statusLine = `/${skillName} failed.`;
    } finally {
      this.busy = false;
      this.currentAbortController = null;
      this.stopAnimation();
      if (this.exitRequested) {
        this.close();
      } else {
        this.requestRender();
      }
    }
  }

  private async requestClarification(promptText: string): Promise<string> {
    this.ensureClarificationVisible(promptText);
    this.inputValue = '';
    this.cursor = 0;
    this.statusLine = 'Awaiting clarification...';
    this.requestRender();

    return new Promise<string>((resolve) => {
      this.pendingQuestion = { prompt: promptText, resolve };
      this.requestRender();
    });
  }

  private ensureClarificationVisible(promptText: string): void {
    if (!this.currentPreview) {
      return;
    }

    const entry = previewQuestionMessage(promptText);
    const entries = this.currentPreview.entries;
    const pendingAssistantIndex = entries.length > 0 && entries[entries.length - 1].role === 'assistant'
      ? entries.length - 1
      : entries.length;
    const previous = pendingAssistantIndex > 0 ? entries[pendingAssistantIndex - 1] : undefined;

    if (sameDisplayMessage(previous, entry)) {
      return;
    }

    this.insertPreviewMessage(entry);
  }

  private async applyCompletion(): Promise<void> {
    if (!this.inputValue.startsWith('/')) {
      return;
    }

    await this.refreshCommands();
    const completion = completeSlashCommand(this.inputValue, [
      ...BUILTIN_SLASH_COMMANDS,
      ...this.commands.map((command) => command.name),
    ]);

    if (completion.applied) {
      this.inputValue = completion.value;
      this.cursor = this.inputValue.length;
    }

    if (completion.matches.length === 0) {
      this.statusLine = 'No matching commands or skills.';
    } else if (completion.matches.length === 1) {
      this.statusLine = `Completed /${completion.matches[0]}`;
    } else {
      const preview = completion.matches.slice(0, 6).join(', ');
      this.statusLine = `Matches: ${preview}${completion.matches.length > 6 ? ', ...' : ''}`;
    }

    this.requestRender();
  }

  private async handleUpDown(offset: number): Promise<void> {
    if (this.focusedPane === 'sessions') {
      await this.moveSession(offset);
      return;
    }

    this.scrollFocusedPane(offset < 0 ? 'up' : 'down', 1);
  }

  private cyclePaneFocus(direction: -1 | 1): void {
    const order: PaneKind[] = ['sessions', 'messages', 'process', 'context'];
    const currentIndex = order.indexOf(this.focusedPane);
    const nextIndex = (currentIndex + direction + order.length) % order.length;
    this.focusedPane = order[nextIndex];
    this.statusLine = `Focus: ${paneDisplayName(this.focusedPane)}. Left/right switches panes; PgUp/PgDn scrolls.`;
    this.requestRender();
  }

  private beginExecutionPreview(sessionId: string, kind: 'task' | 'skill', lead: DisplayMessage, rootTag?: string): void {
    this.currentPreview = {
      sessionId,
      kind,
      rootTag,
      entries: [lead, { role: 'assistant', content: '', pending: true }],
    };
  }

  private updatePreviewFromEvent(logEvent: ConductorLogEvent): void {
    if (!this.currentPreview) {
      return;
    }

    const previewMessage = previewMessageFromEvent(logEvent);
    if (previewMessage) {
      this.insertPreviewMessage(previewMessage);
    }

    if (!this.isPrimaryPreviewEvent(logEvent)) {
      return;
    }

    const message = this.ensurePreviewAssistantMessage();
    switch (logEvent.event.type) {
      case 'stream':
        if (logEvent.event.content) {
          message.content += logEvent.event.content;
        }
        break;

      case 'answer':
        if (logEvent.event.content) {
          message.content = logEvent.event.content;
        }
        message.pending = false;
        message.error = false;
        break;

      case 'error':
        message.content = logEvent.event.content ?? (message.content || 'Execution failed');
        message.pending = false;
        message.error = true;
        break;

      default:
        break;
    }
  }

  private isPrimaryPreviewEvent(logEvent: ConductorLogEvent): boolean {
    if (!this.currentPreview) {
      return false;
    }

    if (this.currentPreview.kind === 'task') {
      return logEvent.scope === 'main';
    }

    return logEvent.scope === 'child' && logEvent.childSlug === this.currentPreview.rootTag;
  }

  private insertPreviewMessage(entry: DisplayMessage): void {
    if (!this.currentPreview) {
      return;
    }

    const entries = this.currentPreview.entries;
    const last = entries[entries.length - 1];
    if (last && last.role === 'assistant' && last.pending && !last.content) {
      entries.splice(entries.length - 1, 0, entry);
      return;
    }

    entries.push(entry);
  }

  private ensurePreviewAssistantMessage(): DisplayMessage {
    if (!this.currentPreview) {
      return { role: 'assistant', content: '', pending: false };
    }

    const last = this.currentPreview.entries[this.currentPreview.entries.length - 1];
    if (last && last.role === 'assistant') {
      return last;
    }

    const created: DisplayMessage = { role: 'assistant', content: '', pending: true };
    this.currentPreview.entries.push(created);
    return created;
  }

  private finishExecutionPreview(options: { persist: boolean; finalText?: string; error?: string }): void {
    if (!this.currentPreview) {
      return;
    }

    const assistant = this.ensurePreviewAssistantMessage();
    if (typeof options.finalText === 'string' && options.finalText.trim()) {
      assistant.content = options.finalText;
    }
    if (typeof options.error === 'string' && options.error.trim()) {
      assistant.content = options.error;
      assistant.error = true;
    }
    assistant.pending = false;

    if (options.persist) {
      const existing = this.ephemeralMessagesBySessionId.get(this.currentPreview.sessionId) ?? [];
      existing.push(...this.currentPreview.entries.map((entry) => ({ ...entry, pending: false })));
      this.ephemeralMessagesBySessionId.set(this.currentPreview.sessionId, existing);
    }

    this.currentPreview = null;
  }

  private cancelCurrentExecution(message: string): void {
    if (!this.busy || !this.currentAbortController) {
      this.statusLine = 'No execution is currently running.';
      this.requestRender();
      return;
    }

    if (this.currentAbortController.signal.aborted) {
      this.statusLine = 'Cancellation already requested.';
      this.requestRender();
      return;
    }

    this.currentAbortController.abort();
    this.statusLine = message;
    this.requestRender();
  }

  private startAnimation(): void {
    if (this.animationTimer) {
      return;
    }

    this.animationTimer = setInterval(() => {
      if ((this.busy || this.currentPreview?.entries.some((entry) => entry.pending)) && !this.isEditingInput()) {
        this.requestRender();
      }
    }, 120);
  }

  private stopAnimation(): void {
    if (!this.animationTimer) {
      return;
    }
    clearInterval(this.animationTimer);
    this.animationTimer = null;
  }

  private scrollFocusedPane(direction: 'up' | 'down', amount: number): void {
    const metrics = this.getPaneMetrics(this.focusedPane);
    if (metrics.maxStart === 0) {
      this.statusLine = `${paneDisplayName(this.focusedPane)} fits on screen.`;
      this.requestRender();
      return;
    }

    if (this.focusedPane === 'sessions') {
      const delta = direction === 'down' ? amount : -amount;
      this.paneScroll.sessions = clamp(this.paneScroll.sessions + delta, 0, metrics.maxStart);
      this.statusLine = `Sessions scroll ${this.paneScroll.sessions + 1}/${metrics.maxStart + 1}.`;
      this.requestRender();
      return;
    }

    const pane = this.focusedPane;
    const delta = direction === 'up' ? amount : -amount;
    this.paneScroll[pane] = clamp(this.paneScroll[pane] + delta, 0, metrics.maxStart);
    this.statusLine = this.paneScroll[pane] === 0
      ? `${paneDisplayName(pane)} following newest content.`
      : `${paneDisplayName(pane)} scrolled ${this.paneScroll[pane]} line${this.paneScroll[pane] === 1 ? '' : 's'} above latest.`;
    this.requestRender();
  }

  private jumpFocusedPane(target: 'top' | 'bottom'): void {
    const metrics = this.getPaneMetrics(this.focusedPane);
    if (this.focusedPane === 'sessions') {
      this.paneScroll.sessions = target === 'top' ? 0 : metrics.maxStart;
      this.statusLine = target === 'top'
        ? 'Sessions at top.'
        : 'Sessions at bottom.';
      this.requestRender();
      return;
    }

    const pane = this.focusedPane;
    this.paneScroll[pane] = target === 'bottom' ? 0 : metrics.maxStart;
    this.statusLine = target === 'bottom'
      ? `${paneDisplayName(pane)} following newest content.`
      : `${paneDisplayName(pane)} at oldest visible content.`;
    this.requestRender();
  }

  private pageScrollAmount(): number {
    const rows = output.rows ?? 40;
    return Math.max(3, Math.floor(Math.max(1, rows - 5) / 2));
  }

  private async moveSession(offset: number): Promise<void> {
    if (this.sessions.length === 0) {
      return;
    }

    const currentIndex = Math.max(0, this.sessions.findIndex((session) => session.id === this.selectedSessionId));
    const nextIndex = (currentIndex + offset + this.sessions.length) % this.sessions.length;
    const nextSession = this.sessions[nextIndex];
    if (!nextSession || nextSession.id === this.selectedSessionId) {
      return;
    }

    this.selectedSessionId = nextSession.id;
    await this.loadSelectedSessionDetail();
    this.statusLine = `Selected session ${nextSession.title}.`;
    this.requestRender();
  }

  private currentProcessActivity(): ActivityBuffer {
    return this.activityFor(this.selectedSessionId || 'global');
  }

  private insertText(text: string): void {
    this.inputValue = `${this.inputValue.slice(0, this.cursor)}${text}${this.inputValue.slice(this.cursor)}`;
    this.cursor += text.length;
  }

  private deleteBackward(): void {
    if (this.cursor === 0) {
      return;
    }
    this.inputValue = `${this.inputValue.slice(0, this.cursor - 1)}${this.inputValue.slice(this.cursor)}`;
    this.cursor -= 1;
  }

  private deleteForward(): void {
    if (this.cursor >= this.inputValue.length) {
      return;
    }
    this.inputValue = `${this.inputValue.slice(0, this.cursor)}${this.inputValue.slice(this.cursor + 1)}`;
  }

  private async refreshCommands(): Promise<void> {
    this.commands = await listCommands(this.workspaceRoot);
  }

  private async refreshSessions(options: { createIfMissing?: boolean; selectedSessionId?: string } = {}): Promise<void> {
    let sessions = await listConductorSessions(this.workspaceRoot);
    if (sessions.length === 0 && options.createIfMissing) {
      const created = await createConductorSession(this.workspaceRoot);
      sessions = [created];
    }

    this.sessions = sessions;
    const desiredSessionId = options.selectedSessionId ?? this.selectedSessionId ?? sessions[0]?.id ?? '';
    this.selectedSessionId = sessions.find((session) => session.id === desiredSessionId)?.id ?? sessions[0]?.id ?? '';
    this.ensureSessionVisible();
    await this.loadSelectedSessionDetail();
  }

  private async loadSelectedSessionDetail(): Promise<void> {
    if (!this.selectedSessionId) {
      this.sessionDetail = null;
      return;
    }

    this.sessionDetail = await getConductorSessionDetail(this.workspaceRoot, this.selectedSessionId);
  }

  private activityFor(key: string): ActivityBuffer {
    const existing = this.activityBySessionId.get(key);
    if (existing) {
      return existing;
    }

    const created = new ActivityBuffer();
    this.activityBySessionId.set(key, created);
    return created;
  }

  private requestRender(): void {
    if (this.renderTimer) {
      return;
    }

    const minInterval = this.isEditingInput()
      ? TYPING_RENDER_INTERVAL_MS
      : this.busy
        ? BUSY_RENDER_INTERVAL_MS
        : IDLE_RENDER_INTERVAL_MS;
    const delay = Math.max(0, minInterval - (Date.now() - this.lastRenderAt));

    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, delay);
  }

  private render(): void {
    this.lastRenderAt = Date.now();
    const columns = output.columns ?? 120;
    const rows = output.rows ?? 40;
    const contentHeight = Math.max(1, rows - 3);
    const widths = computePaneWidths(columns);
    const rightHeights = computeRightPaneHeights(contentHeight);
    const sessionsPane = this.buildPaneView('sessions', 'Sessions', widths.left, contentHeight);
    const messagesPane = this.buildPaneView('messages', 'Messages', widths.center, contentHeight);
    const processPane = this.buildPaneView('process', 'Execution', widths.right, rightHeights.process);
    const contextPane = this.buildPaneView('context', 'Context', widths.right, rightHeights.context);

    const header = renderMenuBar(this.buildHeaderLine(), columns);
    const status = renderStatusBar(this.buildStatusLine(), columns, this.focusedPane);
    const inputPrefix = this.pendingQuestion ? ' Clarify ? ' : ' Command > ';
    const inputLine = renderCommandBar(inputPrefix, this.inputValue, columns);
    const gap = paint(' ', ANSI.bgBlue);

    const lines = [header];
    for (let index = 0; index < contentHeight; index += 1) {
      const rightLine = index < rightHeights.process
        ? processPane[index]
        : contextPane[index - rightHeights.process];
      lines.push(`${sessionsPane[index]}${gap}${messagesPane[index]}${gap}${rightLine}`);
    }
    lines.push(status);
    lines.push(inputLine);

    this.paintFrame(lines, { columns, rows });
    const cursorColumn = Math.min(columns, inputPrefix.length + this.cursor + 1);
    output.write(`\u001b[${rows};${cursorColumn}H`);
  }

  private paintFrame(lines: string[], size: { columns: number; rows: number }): void {
    const patch = computeFramePatch(this.previousFrameLines, lines, this.previousFrameSize, size);
    let buffer = '\u001b[0m';

    if (patch.fullRender) {
      buffer += `\u001b[H\u001b[2J${lines.join('\n')}\u001b[?25h`;
    } else if (patch.changedRows.length > 0) {
      for (const change of patch.changedRows) {
        buffer += `\u001b[${change.row};1H\u001b[2K${change.line}`;
      }
      buffer += '\u001b[?25h';
    } else {
      buffer += '\u001b[?25h';
    }

    output.write(buffer);
    this.previousFrameLines = [...lines];
    this.previousFrameSize = size;
  }

  private buildHeaderLine(): string {
    const sessionLabel = this.sessionDetail
      ? `${this.sessionDetail.title} (${this.sessionDetail.id.slice(0, 8)})`
      : 'no session';
    const skillLabel = this.commands.length > 0
      ? `${this.commands.length} skill${this.commands.length === 1 ? '' : 's'}`
      : 'no skills';
    const mode = this.busy ? '[Running]' : '[Idle]';

    return ` DeepClause  Session  Skills  Run  Help   ${sessionLabel}   ${mode}   ${skillLabel}`;
  }

  private buildStatusLine(): string {
    const focus = paneDisplayName(this.focusedPane);
    if (!this.pendingQuestion && this.focusedPane !== 'sessions') {
      const follow = this.paneScroll[this.focusedPane] === 0 ? 'follow' : `scroll ${this.paneScroll[this.focusedPane]}`;
      return `${this.statusLine} | Focus ${focus} | ${follow}`;
    }
    if (this.pendingQuestion) {
      return `Clarify: ${condenseWhitespace(this.pendingQuestion.prompt)} | Focus ${focus}`;
    }
    return `${this.statusLine} | Focus ${focus}`;
  }

  private buildSessionPaneBody(): string[] {
    if (this.sessions.length === 0) {
      return ['No sessions yet.'];
    }

    const lines: string[] = [];
    for (const session of this.sessions) {
      const selected = session.id === this.selectedSessionId ? '>' : ' ';
      lines.push(`${selected} ${session.title}`);
      lines.push(`  ${formatTimestamp(session.updatedAt)}`);
    }

    return lines;
  }

  private buildMessagesPaneBody(): string[] {
    const entries: DisplayMessage[] = [];

    if (this.sessionDetail) {
      for (const message of this.sessionDetail.messages) {
        entries.push({ role: message.role, content: message.content });
      }
    }

    const persistedEphemeral = this.ephemeralMessagesBySessionId.get(this.selectedSessionId) ?? [];
    entries.push(...persistedEphemeral);

    if (this.currentPreview && this.currentPreview.sessionId === this.selectedSessionId) {
      entries.push(...this.currentPreview.entries);
    }

    if (entries.length === 0) {
      return [
        '[System] No messages yet.',
        '  Enter a prompt to start a conductor turn.',
        '  The center pane shows user and assistant messages.',
      ];
    }

    const lines: string[] = [];
    for (const entry of entries) {
      const header = this.formatMessageHeader(entry);
      lines.push(header);
      const bodyLines = entry.content
        ? entry.content.split(/\r?\n/)
        : (entry.pending ? [''] : ['(empty)']);

      if (entry.pending && !entry.content) {
        bodyLines[0] = 'thinking...';
      }

      for (const line of bodyLines) {
        lines.push(`  ${line}`);
      }
      lines.push('');
    }

    return lines;
  }

  private buildProcessPaneBody(): string[] {
    const activity = this.currentProcessActivity().snapshot();
    if (activity.length > 0) {
      return activity;
    }

    return [
      'No execution activity yet.',
      'Tool calls, logs, outputs, and exceptions render here.',
      'Use /cancel to abort the current execution.',
    ];
  }

  private buildContextPaneBody(): string[] {
    if (!this.sessionDetail) {
      return ['No session selected.'];
    }

    const contextSize = summarizeContextSize(this.sessionDetail);
    const usageEntries = Object.entries(this.sessionDetail.usageByModel ?? {})
      .sort((left, right) => right[1].totalTokens - left[1].totalTokens || left[0].localeCompare(right[0]));

    const body: string[] = [
      'Context Size',
      `Messages ${formatInteger(contextSize.messageCount)}`,
      `Transcript ${formatByteSize(contextSize.messageBytes)} (~${formatInteger(contextSize.messageTokens)} tok)`,
      `Task Memory ${formatByteSize(contextSize.taskMemoryBytes)} (~${formatInteger(contextSize.taskMemoryTokens)} tok)`,
      `Assistant Memory ${formatByteSize(contextSize.assistantMemoryBytes)} (~${formatInteger(contextSize.assistantMemoryTokens)} tok)`,
      `Total ${formatByteSize(contextSize.totalBytes)} (~${formatInteger(contextSize.totalTokens)} tok)`,
      '',
      'Session Token Usage',
    ];

    if (usageEntries.length === 0) {
      body.push('(no usage recorded yet)');
      return body;
    }

    for (const [modelId, usage] of usageEntries) {
      body.push(modelId);
      body.push(
        `  total ${formatInteger(usage.totalTokens)}  in ${formatInteger(usage.inputTokens)}  out ${formatInteger(usage.outputTokens)}  calls ${formatInteger(usage.calls)}`,
      );

      const extras: string[] = [];
      if (usage.cacheReadTokens > 0) {
        extras.push(`cache-read ${formatInteger(usage.cacheReadTokens)}`);
      }
      if (usage.cacheWriteTokens > 0) {
        extras.push(`cache-write ${formatInteger(usage.cacheWriteTokens)}`);
      }
      if (usage.reasoningTokens > 0) {
        extras.push(`reasoning ${formatInteger(usage.reasoningTokens)}`);
      }
      if (extras.length > 0) {
        body.push(`  ${extras.join('  ')}`);
      }
      body.push('');
    }

    return body;
  }

  private buildPaneView(kind: PaneKind, title: string, width: number, height: number): string[] {
    const metrics = this.getPaneMetrics(kind, width, height);
    const paneTitle = this.buildPaneTitle(title, kind, metrics);
    return buildPane(
      paneTitle,
      metrics.lines.slice(metrics.start, metrics.start + metrics.viewportLines),
      width,
      height,
      kind,
      this.focusedPane === kind,
    );
  }

  private buildPaneTitle(
    title: string,
    kind: PaneKind,
    metrics: { maxStart: number },
  ): string {
    if (kind === 'sessions') {
      return this.focusedPane === kind ? `${title} [focus]` : title;
    }

    if (metrics.maxStart === 0) {
      return this.focusedPane === kind ? `${title} [focus]` : title;
    }

    return this.paneScroll[kind] === 0
      ? `${title}${this.focusedPane === kind ? ' [focus]' : ''} [follow]`
      : `${title}${this.focusedPane === kind ? ' [focus]' : ''} [-${this.paneScroll[kind]}]`;
  }

  private getPaneMetrics(
    kind: PaneKind,
    width = paneDimensionsForKind(kind, output.columns ?? 120, output.rows ?? 40).width,
    height = paneDimensionsForKind(kind, output.columns ?? 120, output.rows ?? 40).height,
  ): { lines: string[]; start: number; maxStart: number; viewportLines: number } {
    const innerWidth = Math.max(1, width - 2);
    const rawBody = this.getPaneBody(kind);
    const lines = wrapBodyLines(rawBody, innerWidth);
    const viewportLines = Math.max(0, height - 2);
    const maxStart = Math.max(0, lines.length - viewportLines);

    if (kind === 'sessions') {
      this.paneScroll.sessions = clamp(this.paneScroll.sessions, 0, maxStart);
      return {
        lines,
        start: this.paneScroll.sessions,
        maxStart,
        viewportLines,
      };
    }

    this.paneScroll[kind] = clamp(this.paneScroll[kind], 0, maxStart);
    return {
      lines,
      start: Math.max(0, maxStart - this.paneScroll[kind]),
      maxStart,
      viewportLines,
    };
  }

  private getPaneBody(kind: PaneKind): string[] {
    switch (kind) {
      case 'sessions':
        return this.buildSessionPaneBody();
      case 'messages':
        return this.buildMessagesPaneBody();
      case 'process':
        return this.buildProcessPaneBody();
      case 'context':
        return this.buildContextPaneBody();
    }
  }

  private ensureSessionVisible(): void {
    const selectedIndex = Math.max(0, this.sessions.findIndex((session) => session.id === this.selectedSessionId));
    const contentRows = Math.max(1, (output.rows ?? 40) - 5);
    const selectedLine = selectedIndex * 2;

    if (selectedLine < this.paneScroll.sessions) {
      this.paneScroll.sessions = selectedLine;
      return;
    }

    if (selectedLine >= this.paneScroll.sessions + contentRows) {
      this.paneScroll.sessions = Math.max(0, selectedLine - contentRows + 1);
    }
  }

  private formatMessageHeader(entry: DisplayMessage): string {
    const spinner = entry.pending ? ` ${currentSpinnerFrame()}` : '';
    switch (entry.role) {
      case 'user':
        return '[You]';
      case 'assistant':
        return entry.error ? '[Assistant Error]' : `[Assistant${spinner}]`;
      case 'system':
        return formatSystemMessageHeader(entry, spinner);
    }
  }

  private close(): void {
    if (!this.closeResolver) {
      return;
    }
    const resolve = this.closeResolver;
    this.closeResolver = null;
    resolve();
  }

  private isEditingInput(): boolean {
    return !this.pendingQuestion && this.inputValue.length > 0;
  }
}

export async function startTui(
  workspaceRoot = process.cwd(),
  options: { sandbox?: boolean } = {},
): Promise<void> {
  if (input.isTTY && output.isTTY) {
    const app = new FullscreenTui(workspaceRoot, options);
    await app.start();
    return;
  }

  await startLineTui(workspaceRoot, options);
}

async function startLineTui(
  workspaceRoot = process.cwd(),
  options: { sandbox?: boolean } = {},
): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    let session = await chooseSession(rl, workspaceRoot);

    renderHeader(session);

    while (true) {
      const prompt = `${paint(session.title || session.id.slice(0, 8), ANSI.bold)} ${paint('>', ANSI.dim)} `;
      const line = (await rl.question(prompt)).trim();

      if (!line) {
        continue;
      }

      const parsed = parseSlashInput(line);
      if (parsed.kind === 'builtin') {
        switch (parsed.name) {
          case 'cancel':
            console.log('No execution is currently running in line mode.');
            continue;

          case 'exit':
          case 'quit':
            return;

          case 'new':
            session = parsed.rawArgs
              ? await createConductorSession(workspaceRoot, parsed.rawArgs)
              : await createSessionInteractive(rl, workspaceRoot);
            console.log(`${paint('switched', ANSI.green)} ${session.title}`);
            renderHeader(session);
            continue;

          case 'sessions':
            session = await chooseSession(rl, workspaceRoot);
            renderHeader(session);
            continue;

          case 'help':
            for (const helpLine of buildHelpLines()) {
              console.log(helpLine);
            }
            continue;
        }
      }

      if (parsed.kind === 'skill') {
        console.log(divider('-'));
        console.log(`${paint('skill', ANSI.dim)} /${parsed.name}${parsed.args.length > 0 ? ` ${parsed.args.join(' ')}` : ''}`);
        console.log(divider('-'));
        const printer = new LiveExecutionPrinter();

        try {
          await runSkillCommand(workspaceRoot, parsed.name, parsed.args, {
            sandbox: options.sandbox,
            onUserInput: async (question) => {
              printer.finish();
              console.log(`${paint('clarify', ANSI.yellow)} ${question}`);
              return (await rl.question('> ')).trim();
            },
            onEvent: (event) => printer.handle(event),
          });
        } catch (error) {
          printer.finish();
          console.log(`${paint('error', ANSI.red)} ${(error as Error).message}`);
        }

        printer.finish();
        console.log('');
        console.log(divider('-'));
        console.log('');
        continue;
      }

      console.log(divider('-'));
      console.log(`${paint('task', ANSI.dim)} ${parsed.prompt}`);
      console.log(divider('-'));
      const printer = new LiveExecutionPrinter();

      const result = await runConductorTurn(parsed.prompt, {
        workspaceRoot,
        sessionId: session.id,
        stream: true,
        headless: true,
        sandbox: options.sandbox,
        onUserInput: async (question) => {
          printer.finish();
          console.log(`${paint('clarify', ANSI.yellow)} ${question}`);
          return (await rl.question('> ')).trim();
        },
        onEvent: (event) => printer.handle(event),
      });

      printer.finish();
      console.log('');
      console.log(divider('-'));
      console.log('');

      const sessions = await listConductorSessions(workspaceRoot);
      session = sessions.find((entry) => entry.id === result.sessionId) ?? session;
    }
  } finally {
    rl.close();
  }
}

export async function runPromptHeadless(
  prompt: string,
  workspaceRoot = process.cwd(),
  options: { sandbox?: boolean } = {},
): Promise<void> {
  const session = await createConductorSession(workspaceRoot);
  console.log(`Session: ${session.id}`);

  const result = await runConductorTurn(prompt, {
    workspaceRoot,
    sessionId: session.id,
    stream: false,
    headless: true,
    sandbox: options.sandbox,
  });

  if (result.output.length > 0 || result.answer) {
    console.log('');
  }

  for (const line of result.output) {
    console.log(line);
  }

  if (result.answer) {
    if (result.output.length > 0) {
      console.log('');
    }
    console.log(result.answer);
  }

  if (result.error) {
    throw new Error(result.error);
  }
}

async function runSkillCommand(
  workspaceRoot: string,
  skillName: string,
  args: string[],
  options: {
    sandbox?: boolean;
    signal?: AbortSignal;
    onUserInput?: (prompt: string) => Promise<string>;
    onEvent?: (event: ConductorLogEvent) => void;
  } = {},
): Promise<CliRunResult> {
  const commands = await listCommands(workspaceRoot);
  const command = commands.find((entry) => entry.name === skillName);
  if (!command) {
    throw new Error(`Unknown skill: ${skillName}`);
  }

  const result = await run(command.path, args, {
    configRoot: workspaceRoot,
    headless: true,
    stream: true,
    sandbox: options.sandbox,
    signal: options.signal,
    onUserInput: options.onUserInput,
    onEvent: (event: DMLEvent) => options.onEvent?.({ scope: 'child', childSlug: skillName, event }),
    onChildEvent: (childSlug, event) => options.onEvent?.({ scope: 'child', childSlug, event }),
  });

  return result;
}

export function previewMessageFromEvent(logEvent: ConductorLogEvent): DisplayMessage | null {
  switch (logEvent.event.type) {
    case 'output':
      if (!logEvent.event.content) {
        return null;
      }
      return {
        role: 'system',
        kind: 'output',
        tag: logEvent.scope === 'child' ? logEvent.childSlug : undefined,
        content: logEvent.event.content,
      };

    case 'input_required':
      if (!logEvent.event.prompt) {
        return null;
      }
      return previewQuestionMessage(logEvent.event.prompt, logEvent.scope === 'child' ? logEvent.childSlug : undefined);

    default:
      return null;
  }
}

export function previewQuestionMessage(promptText: string, explicitTag?: string): DisplayMessage {
  const parsed = explicitTag ? { tag: explicitTag, content: promptText } : parseTaggedPrompt(promptText);
  return {
    role: 'system',
    kind: 'question',
    tag: parsed.tag,
    content: parsed.content,
  };
}

export function parseCommandArgs(rawArgs: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaping = false;

  for (const char of rawArgs.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += '\\';
  }
  if (current) {
    args.push(current);
  }

  return args;
}

export function parseSlashInput(line: string): ParsedTuiInput {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'text', prompt: trimmed };
  }
  if (trimmed === '/') {
    return { kind: 'builtin', name: 'help', rawArgs: '', args: [] };
  }

  const match = trimmed.slice(1).match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) {
    return { kind: 'builtin', name: 'help', rawArgs: '', args: [] };
  }

  const name = match[1];
  const rawArgs = (match[2] ?? '').trim();
  if ((BUILTIN_SLASH_COMMANDS as readonly string[]).includes(name)) {
    return {
      kind: 'builtin',
      name: name as BuiltinSlashCommand,
      rawArgs,
      args: name === 'new' && rawArgs ? [rawArgs] : parseCommandArgs(rawArgs),
    };
  }

  return {
    kind: 'skill',
    name,
    rawArgs,
    args: parseCommandArgs(rawArgs),
  };
}

export function canSubmitParsedInputWhileBusy(parsed: ParsedTuiInput): boolean {
  return parsed.kind === 'builtin' && (parsed.name === 'cancel' || parsed.name === 'exit' || parsed.name === 'quit');
}

export function computeFramePatch(
  previousLines: string[] | null,
  nextLines: string[],
  previousSize: { columns: number; rows: number } | null,
  nextSize: { columns: number; rows: number },
): { fullRender: boolean; changedRows: Array<{ row: number; line: string }> } {
  if (
    !previousLines
    || !previousSize
    || previousSize.columns !== nextSize.columns
    || previousSize.rows !== nextSize.rows
    || previousLines.length !== nextLines.length
  ) {
    return { fullRender: true, changedRows: [] };
  }

  const changedRows: Array<{ row: number; line: string }> = [];
  for (let index = 0; index < nextLines.length; index += 1) {
    if (previousLines[index] !== nextLines[index]) {
      changedRows.push({ row: index + 1, line: nextLines[index] });
    }
  }

  return { fullRender: false, changedRows };
}

export function completeSlashCommand(inputValue: string, candidates: string[]): SlashCompletionResult {
  if (!inputValue.startsWith('/')) {
    return { value: inputValue, matches: [], applied: false };
  }

  const match = inputValue.match(/^\/([^\s]*)(.*)$/s);
  if (!match) {
    return { value: inputValue, matches: [], applied: false };
  }

  const prefix = match[1];
  const suffix = match[2] ?? '';
  const uniqueCandidates = Array.from(new Set(candidates)).sort();
  const matches = uniqueCandidates.filter((candidate) => candidate.startsWith(prefix));
  if (matches.length === 0) {
    return { value: inputValue, matches: [], applied: false };
  }

  if (matches.length === 1) {
    return {
      value: `/${matches[0]}${suffix.length > 0 ? suffix : ' '}`,
      matches,
      applied: true,
    };
  }

  const sharedPrefix = longestCommonPrefix(matches);
  if (sharedPrefix.length > prefix.length) {
    return {
      value: `/${sharedPrefix}${suffix}`,
      matches,
      applied: true,
    };
  }

  return { value: inputValue, matches, applied: false };
}

async function chooseSession(rl: Interface, workspaceRoot: string): Promise<ConductorSessionSummary> {
  const sessions = await listConductorSessions(workspaceRoot);
  if (sessions.length === 0) {
    return createSessionInteractive(rl, workspaceRoot);
  }

  console.log(divider('='));
  console.log(paint('Sessions', ANSI.bold));
  sessions.slice(0, 9).forEach((session, index) => {
    console.log(`${paint(String(index + 1).padStart(2, ' '), ANSI.cyan)}  ${session.title} ${paint(session.updatedAt.replace('T', ' ').slice(0, 16), ANSI.dim)}`);
  });
  console.log(`${paint(' 0', ANSI.cyan)}  Start a new session`);
  console.log(divider('='));

  while (true) {
    const answer = (await rl.question(paint('Select a session [0]: ', ANSI.dim))).trim();
    if (!answer || answer === '0') {
      return createSessionInteractive(rl, workspaceRoot);
    }

    const numeric = Number.parseInt(answer, 10);
    if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= Math.min(sessions.length, 9)) {
      return sessions[numeric - 1];
    }

    console.log('Enter a listed session number or 0 for a new session.');
  }
}

async function createSessionInteractive(rl: Interface, workspaceRoot: string): Promise<ConductorSessionSummary> {
  const title = (await rl.question(paint('New session title (optional): ', ANSI.dim))).trim();
  return createConductorSession(workspaceRoot, title || undefined);
}

function renderHeader(session: ConductorSessionSummary): void {
  console.log(divider('='));
  console.log(`${paint('DeepClause', ANSI.bold, ANSI.cyan)} ${paint('interactive conductor', ANSI.dim)}`);
  console.log(`${paint('commands', ANSI.dim)} /new  /sessions  /help  /exit  /skill args`);
  console.log(`${paint('session', ANSI.dim)}  ${paint(session.id, ANSI.cyan)}`);
  console.log(divider('='));
  console.log('');
}

function streamLabel(logEvent: ConductorLogEvent): string {
  return logEvent.scope === 'child'
    ? `[${logEvent.childSlug ?? '?'}] llm`
    : 'llm';
}

function formatEventPrefix(logEvent: ConductorLogEvent): string {
  return logEvent.scope === 'child'
    ? `[${logEvent.childSlug ?? '?'}] `
    : '';
}

function parseTaggedPrompt(promptText: string): { tag?: string; content: string } {
  const match = promptText.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!match) {
    return { content: promptText };
  }

  return {
    tag: match[1],
    content: match[2] || promptText,
  };
}

function sameDisplayMessage(left: DisplayMessage | undefined, right: DisplayMessage): boolean {
  return !!left
    && left.role === right.role
    && left.kind === right.kind
    && left.tag === right.tag
    && left.content === right.content;
}

function formatSystemMessageHeader(entry: DisplayMessage, spinner: string): string {
  const base = entry.kind === 'output'
    ? 'Output'
    : entry.kind === 'question'
      ? 'Question'
      : 'System';

  return entry.tag
    ? `[${base}: ${entry.tag}${spinner}]`
    : `[${base}${spinner}]`;
}

function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return '';
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    let rendered = typeof value === 'string' ? value : JSON.stringify(value);
    if (rendered.length > 80) {
      rendered = rendered.slice(0, 77) + '...';
    }
    parts.push(`${key}=${rendered}`);
  }

  return parts.join(', ');
}

function buildHelpLines(): string[] {
  return [
    'commands',
    '/new [title]    create a new conductor session',
    '/sessions       refresh or choose sessions',
    '/cancel         abort the current execution',
    '/help           show this help',
    '/quit           exit the TUI',
    '/<skill> [args] run a compiled skill directly',
    'keys',
    'Left/Right      change focused pane',
    'Up/Down         select session or scroll focused pane',
    'PgUp/PgDn       page-scroll the focused pane',
    'End             jump to bottom or re-enable follow mode',
    'Tab             autocomplete /commands and /skills',
  ];
}

function computePaneWidths(columns: number): { left: number; center: number; right: number } {
  const available = Math.max(36, columns - 2);
  let left = Math.max(18, Math.floor(available * 0.2));
  let right = Math.max(28, Math.floor(available * 0.3));
  let center = available - left - right;

  if (center < 30) {
    const needed = 30 - center;
    const reduceRight = Math.min(needed, Math.max(0, right - 18));
    right -= reduceRight;
    center += reduceRight;

    if (center < 30) {
      const reduceLeft = Math.min(30 - center, Math.max(0, left - 14));
      left -= reduceLeft;
      center += reduceLeft;
    }
  }

  center += available - left - center - right;
  return { left, center, right };
}

function computeRightPaneHeights(totalHeight: number): { process: number; context: number } {
  if (totalHeight <= 8) {
    return { process: Math.max(1, totalHeight - 1), context: 1 };
  }

  let process = Math.max(8, Math.floor(totalHeight * 0.58));
  let context = totalHeight - process;
  if (context < 6) {
    const deficit = 6 - context;
    process = Math.max(6, process - deficit);
    context = totalHeight - process;
  }

  return { process, context };
}

function buildPane(
  title: string,
  body: string[],
  width: number,
  height: number,
  kind: PaneKind,
  active = false,
): string[] {
  if (height <= 0) {
    return [];
  }

  const innerWidth = Math.max(1, width - 2);
  const lines: string[] = [renderWindowTop(title, innerWidth, active)];

  bodyLoop:
  for (const line of body) {
    for (const wrapped of wrapPlainText(line, innerWidth)) {
      if (lines.length >= height - 1) {
        break bodyLoop;
      }
      lines.push(renderWindowBody(wrapped, innerWidth, kind));
    }
  }

  while (lines.length < height - 1) {
    lines.push(renderWindowBody('', innerWidth, kind));
  }

  if (height >= 2) {
    lines.push(renderWindowBottom(innerWidth, active));
  }

  return lines.slice(0, height);
}

function wrapPlainText(text: string, width: number): string[] {
  if (width <= 0) {
    return [''];
  }

  const result: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine || '';
    if (!line) {
      result.push('');
      continue;
    }

    let remaining = line;
    while (remaining.length > width) {
      const slice = remaining.slice(0, width);
      const breakIndex = slice.lastIndexOf(' ');
      if (breakIndex > Math.floor(width * 0.4)) {
        result.push(slice.slice(0, breakIndex));
        remaining = remaining.slice(breakIndex + 1);
      } else {
        result.push(slice);
        remaining = remaining.slice(width);
      }
    }
    result.push(remaining);
  }

  return result;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

function ellipsize(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  if (width <= 3) {
    return text.slice(0, width);
  }
  return `${text.slice(0, width - 3)}...`;
}

function condenseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function formatTimestamp(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}

function summarizeContextSize(detail: ConductorSessionDetail): {
  messageCount: number;
  messageBytes: number;
  messageTokens: number;
  taskMemoryBytes: number;
  taskMemoryTokens: number;
  assistantMemoryBytes: number;
  assistantMemoryTokens: number;
  totalBytes: number;
  totalTokens: number;
} {
  const transcript = detail.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
  const taskMemory = detail.taskMemory ?? '';
  const assistantMemory = detail.assistantMemory ?? '';
  const messageBytes = Buffer.byteLength(transcript, 'utf8');
  const taskMemoryBytes = Buffer.byteLength(taskMemory, 'utf8');
  const assistantMemoryBytes = Buffer.byteLength(assistantMemory, 'utf8');
  const messageTokens = estimateTokenCount(transcript);
  const taskMemoryTokens = estimateTokenCount(taskMemory);
  const assistantMemoryTokens = estimateTokenCount(assistantMemory);

  return {
    messageCount: detail.messages.length,
    messageBytes,
    messageTokens,
    taskMemoryBytes,
    taskMemoryTokens,
    assistantMemoryBytes,
    assistantMemoryTokens,
    totalBytes: messageBytes + taskMemoryBytes + assistantMemoryBytes,
    totalTokens: messageTokens + taskMemoryTokens + assistantMemoryTokens,
  };
}

function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    const kib = bytes / 1024;
    return `${kib >= 10 ? kib.toFixed(0) : kib.toFixed(1)} KB`;
  }

  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(1)} MB`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) {
    return '';
  }

  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix) && prefix) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) {
      break;
    }
  }

  return prefix;
}

function renderMenuBar(text: string, columns: number): string {
  return paint(padRight(ellipsize(text, columns), columns), ANSI.black, ANSI.bgWhite, ANSI.bold);
}

function renderStatusBar(status: string, columns: number, focusedPane: PaneKind): string {
  const hotkeys = [
    ['<- ->', 'Pane'],
    [focusedPane === 'sessions' ? 'Up/Down' : 'PgUp/PgDn', focusedPane === 'sessions' ? 'Select' : 'Scroll'],
    ['End', focusedPane === 'sessions' ? 'Bottom' : 'Follow'],
    ['/cancel', 'Stop'],
    ['^C', 'Quit'],
  ] as const;

  let hotkeyWidth = 0;
  const selected: Array<(typeof hotkeys)[number]> = [];
  for (const hotkey of hotkeys) {
    const width = hotkey[0].length + hotkey[1].length + 4;
    if (hotkeyWidth + width > Math.max(0, columns - 12)) {
      break;
    }
    hotkeyWidth += width;
    selected.push(hotkey);
  }

  const leftWidth = Math.max(0, columns - hotkeyWidth);
  const statusPart = paint(padRight(ellipsize(status, leftWidth), leftWidth), ANSI.black, ANSI.bgCyan);
  const hotkeyPart = selected.map(([key, label]) => (
    `${paint(` ${key} `, ANSI.black, ANSI.bgWhite, ANSI.bold)}${paint(` ${label} `, ANSI.black, ANSI.bgCyan)}`
  )).join('');
  return `${statusPart}${hotkeyPart}`;
}

function renderCommandBar(prefix: string, value: string, columns: number): string {
  const prefixPart = paint(prefix, ANSI.black, ANSI.bgWhite, ANSI.bold);
  const remainingWidth = Math.max(0, columns - prefix.length);
  const valuePart = paint(padRight(ellipsize(value, remainingWidth), remainingWidth), ANSI.brightWhite, ANSI.bgBlue);
  return `${prefixPart}${valuePart}`;
}

function renderWindowTop(title: string, innerWidth: number, active: boolean): string {
  const safeLabel = ` ${ellipsize(title, Math.max(1, innerWidth - 2))} `;
  const fillWidth = Math.max(0, innerWidth - safeLabel.length);
  const leftFill = Math.floor(fillWidth / 2);
  const rightFill = fillWidth - leftFill;
  return [
    paint(`╔${'═'.repeat(leftFill)}`, ANSI.brightCyan, ANSI.bgBlue),
    paint(safeLabel, ANSI.black, active ? ANSI.bgCyan : ANSI.bgWhite, ANSI.bold),
    paint(`${'═'.repeat(rightFill)}╗`, ANSI.brightCyan, ANSI.bgBlue),
  ].join('');
}

function renderWindowBottom(innerWidth: number, _active: boolean): string {
  return paint(`╚${'═'.repeat(innerWidth)}╝`, ANSI.brightCyan, ANSI.bgBlue);
}

function renderWindowBody(text: string, innerWidth: number, kind: PaneKind): string {
  const normalized = text.trim().toLowerCase();
  const content = padRight(ellipsize(text, innerWidth), innerWidth);
  const border = paint('║', ANSI.brightCyan, ANSI.bgBlue);

  if (kind === 'sessions' && text.startsWith('> ')) {
    return `${border}${paint(content, ANSI.black, ANSI.bgCyan, ANSI.bold)}${border}`;
  }

  if (kind === 'messages') {
    if (text.startsWith('[You]')) {
      return `${border}${paint(content, ANSI.brightCyan, ANSI.bgBlue, ANSI.bold)}${border}`;
    }
    if (text.startsWith('[Assistant Error]')) {
      return `${border}${paint(content, ANSI.red, ANSI.bgBlue, ANSI.bold)}${border}`;
    }
    if (text.startsWith('[Assistant')) {
      return `${border}${paint(content, ANSI.brightYellow, ANSI.bgBlue, ANSI.bold)}${border}`;
    }
    if (text.startsWith('[System')) {
      return `${border}${paint(content, ANSI.cyan, ANSI.bgBlue, ANSI.bold)}${border}`;
    }
  }

  if (kind === 'process') {
    if (normalized.startsWith('error')) {
      return `${border}${paint(content, ANSI.red, ANSI.bgBlue, ANSI.bold)}${border}`;
    }
    if (normalized.startsWith('answer')) {
      return `${border}${paint(content, ANSI.brightYellow, ANSI.bgBlue, ANSI.bold)}${border}`;
    }
    if (normalized.startsWith('tool')) {
      return `${border}${paint(content, ANSI.brightCyan, ANSI.bgBlue)}${border}`;
    }
    if (normalized.startsWith('clarify')) {
      return `${border}${paint(content, ANSI.yellow, ANSI.bgBlue, ANSI.bold)}${border}`;
    }
    if (normalized.startsWith('task') || normalized.startsWith('skill')) {
      return `${border}${paint(content, ANSI.brightWhite, ANSI.bgBlue, ANSI.bold)}${border}`;
    }
  }

  if (
    normalized === 'task memory' ||
    normalized === 'assistant memory' ||
    normalized === 'recent messages' ||
    normalized === 'commands' ||
    normalized === 'keys'
  ) {
    return `${border}${paint(content, ANSI.brightYellow, ANSI.bgBlue, ANSI.bold)}${border}`;
  }

  if (kind === 'context' && (normalized.startsWith('created ') || normalized.startsWith('updated ') || normalized.startsWith('session '))) {
    return `${border}${paint(content, ANSI.cyan, ANSI.bgBlue)}${border}`;
  }

  if (kind === 'sessions' && text.startsWith('  ')) {
    return `${border}${paint(content, ANSI.cyan, ANSI.bgBlue)}${border}`;
  }

  return `${border}${paint(content, ANSI.white, ANSI.bgBlue)}${border}`;
}

function divider(character: string): string {
  const glyph = character === '=' ? '═' : character === '-' ? '─' : character;
  return paint(glyph.repeat(72), ANSI.brightCyan, ANSI.bgBlue);
}

function paneDisplayName(kind: PaneKind): string {
  switch (kind) {
    case 'sessions':
      return 'Sessions';
    case 'messages':
      return 'Messages';
    case 'process':
      return 'Execution';
    case 'context':
      return 'Context';
  }
}

function paneDimensionsForKind(kind: PaneKind, columns: number, rows: number): { width: number; height: number } {
  const widths = computePaneWidths(columns);
  const rightHeights = computeRightPaneHeights(Math.max(1, rows - 3));
  switch (kind) {
    case 'sessions':
      return { width: widths.left, height: Math.max(1, rows - 3) };
    case 'messages':
      return { width: widths.center, height: Math.max(1, rows - 3) };
    case 'process':
      return { width: widths.right, height: rightHeights.process };
    case 'context':
      return { width: widths.right, height: rightHeights.context };
  }
}

function wrapBodyLines(body: string[], innerWidth: number): string[] {
  const lines: string[] = [];
  for (const line of body) {
    lines.push(...wrapPlainText(line, innerWidth));
  }
  return lines;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function currentSpinnerFrame(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / 120) % SPINNER_FRAMES.length];
}

function summarizeRunResult(result: CliRunResult): string {
  if (result.answer?.trim()) {
    return result.answer;
  }

  const lastOutput = [...result.output].reverse().find((line) => line.trim());
  if (lastOutput) {
    return lastOutput;
  }

  if (result.error?.trim()) {
    return result.error;
  }

  return 'Execution completed without a final answer.';
}

function paint(text: string, ...codes: string[]): string {
  if (!output.isTTY || codes.length === 0) {
    return text;
  }
  return `${codes.join('')}${text}${ANSI.reset}`;
}
