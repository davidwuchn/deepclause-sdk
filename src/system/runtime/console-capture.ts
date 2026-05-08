import { inspect } from 'util';

export type CapturedConsoleLevel = 'log' | 'warn' | 'error';

export interface CapturedConsoleEntry {
  level: CapturedConsoleLevel;
  text: string;
}

type ConsoleSink = (entry: CapturedConsoleEntry) => void;

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

const sinks: ConsoleSink[] = [];
let installed = false;

export async function withCapturedConsole<T>(sink: ConsoleSink, run: () => Promise<T> | T): Promise<T> {
  installConsoleCapture();
  sinks.push(sink);

  try {
    return await run();
  } finally {
    const index = sinks.lastIndexOf(sink);
    if (index >= 0) {
      sinks.splice(index, 1);
    }

    if (sinks.length === 0) {
      uninstallConsoleCapture();
    }
  }
}

function installConsoleCapture(): void {
  if (installed) {
    return;
  }

  console.log = (...args: unknown[]) => dispatch('log', args);
  console.warn = (...args: unknown[]) => dispatch('warn', args);
  console.error = (...args: unknown[]) => dispatch('error', args);
  installed = true;
}

function uninstallConsoleCapture(): void {
  if (!installed) {
    return;
  }

  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  installed = false;
}

function dispatch(level: CapturedConsoleLevel, args: unknown[]): void {
  const sink = sinks[sinks.length - 1];
  if (!sink) {
    originalConsole[level](...args);
    return;
  }

  sink({
    level,
    text: formatConsoleArgs(args),
  });
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map((arg) => {
    if (typeof arg === 'string') {
      return arg;
    }

    return inspect(arg, {
      colors: false,
      depth: 5,
      breakLength: Infinity,
      maxArrayLength: 50,
    });
  }).join(' ');
}