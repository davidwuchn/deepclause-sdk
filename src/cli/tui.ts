import { createInterface, type Interface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import {
  createConductorSession,
  listConductorSessions,
  runConductorTurn,
  type ConductorLogEvent,
  type ConductorSessionSummary,
} from '../system/runtime/conductor.js';

const IGNORED_LIVE_LOG_TOOLS = new Set(['set_result', 'update_memory']);

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

export class LiveExecutionPrinter {
  private activeStreamKey: string | null = null;
  private streamOpen = false;

  constructor(
    private readonly write: (text: string) => void = (text) => process.stdout.write(text),
    private readonly writeLine: (text: string) => void = (text) => console.log(text),
  ) {}

  handle(logEvent: ConductorLogEvent): void {
    const { event } = logEvent;

    if (event.type === 'usage' || event.type === 'finished' || event.type === 'input_required') {
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

export async function startTui(
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
      if (line === '/exit' || line === '/quit') {
        break;
      }
      if (line === '/new') {
        session = await createSessionInteractive(rl, workspaceRoot);
        console.log(`${paint('switched', ANSI.green)} ${session.title}`);
        renderHeader(session);
        continue;
      }
      if (line === '/sessions') {
        session = await chooseSession(rl, workspaceRoot);
        renderHeader(session);
        continue;
      }

      console.log(divider('-'));
      console.log(`${paint('task', ANSI.dim)} ${line}`);
      console.log(divider('-'));
      const printer = new LiveExecutionPrinter();

      const result = await runConductorTurn(line, {
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
  console.log(`${paint('commands', ANSI.dim)} /new  /sessions  /exit`);
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

function divider(character: string): string {
  return paint(character.repeat(72), ANSI.dim);
}

function paint(text: string, ...codes: string[]): string {
  if (!output.isTTY || codes.length === 0) {
    return text;
  }
  return `${codes.join('')}${text}${ANSI.reset}`;
}
