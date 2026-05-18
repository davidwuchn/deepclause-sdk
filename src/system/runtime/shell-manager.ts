import { spawn, type ChildProcess } from 'child_process';
import {
  AgentVMManager,
  type ShellExecObserver,
  type ShellExecResult,
} from './agentvm-manager.js';

const ABORT_FORCE_KILL_MS = 500;
const EXIT_STDIO_GRACE_MS = 25;
const DEFAULT_HOST_SHELL_IDLE_TIMEOUT_MS = 180_000;

export interface ShellManager {
  readonly kind: 'host' | 'sandbox';
  exec(command: string, signal?: AbortSignal, observer?: ShellExecObserver): Promise<ShellExecResult>;
  dispose(): Promise<void>;
}

export interface CreateShellManagerOptions {
  workspacePath: string;
  sandbox?: boolean;
  network?: boolean;
}

export class HostShellManager implements ShellManager {
  readonly kind = 'host' as const;

  constructor(private readonly workspacePath: string) {}

  async exec(
    command: string,
    signal?: AbortSignal,
    observer?: ShellExecObserver,
  ): Promise<ShellExecResult> {
    if (signal?.aborted) {
      throw abortError(signal.reason);
    }

    return new Promise((resolve, reject) => {
      const idleTimeoutMs = getHostShellIdleTimeoutMs();
      const child = spawn('bash', ['-lc', command], {
        cwd: this.workspacePath,
        env: process.env,
        detached: process.platform !== 'win32',
      });

      observer?.onStart?.({
        command,
        pid: child.pid,
        backend: this.kind,
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let timedOut = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const resetIdleTimer = () => {
        if (idleTimeoutMs <= 0 || settled || timedOut) {
          return;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
          if (settled || signal?.aborted) {
            return;
          }

          timedOut = true;
          exitCode = 124;
          stderr = stderr
            ? `${stderr}${stderr.endsWith('\n') ? '' : '\n'}Command timed out after ${idleTimeoutMs}ms without output`
            : `Command timed out after ${idleTimeoutMs}ms without output`;

          terminateChildProcessTree(child, 'SIGTERM');
          if (!forceKillTimer) {
            forceKillTimer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                terminateChildProcessTree(child, 'SIGKILL');
              }
            }, ABORT_FORCE_KILL_MS);
            forceKillTimer.unref?.();
          }
        }, idleTimeoutMs);
        idleTimer.unref?.();
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        resetIdleTimer();
        observer?.onStdout?.({
          command,
          chunk,
          pid: child.pid,
          backend: this.kind,
        });
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        resetIdleTimer();
        observer?.onStderr?.({
          command,
          chunk,
          pid: child.pid,
          backend: this.kind,
        });
      });

      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const maybeDestroyStreams = () => {
        child.stdout.destroy?.();
        child.stderr.destroy?.();
      };
      const buildResult = (): ShellExecResult => {
        const resolvedExitCode = typeof exitCode === 'number'
          ? exitCode
          : (timedOut ? 124 : 1);
        const signalSuffix = exitSignal ? ` (signal ${exitSignal})` : '';
        return {
          success: resolvedExitCode === 0,
          stdout,
          stderr,
          exitCode: resolvedExitCode,
          pid: child.pid,
          backend: this.kind,
          summary: resolvedExitCode === 0
            ? 'Command completed successfully'
            : (timedOut ? `Command timed out after ${idleTimeoutMs}ms without output` : (stderr || `Command failed with exit code ${resolvedExitCode}${signalSuffix}`)),
        };
      };
      const finalizeExit = (detachStreams = false) => {
        if (detachStreams) {
          maybeDestroyStreams();
        }
        const result = buildResult();
        observer?.onExit?.({
          command,
          pid: child.pid,
          backend: this.kind,
          success: result.success,
          exitCode: result.exitCode,
          summary: result.summary,
        });
        finalizeResolve(result);
      };
      const finalizeReject = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const finalizeResolve = (result: ShellExecResult) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      const onAbort = () => {
        terminateChildProcessTree(child, 'SIGTERM');
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              terminateChildProcessTree(child, 'SIGKILL');
            }
          }, ABORT_FORCE_KILL_MS);
          forceKillTimer.unref?.();
        }

        finalizeReject(abortError(signal?.reason));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        if (exitGraceTimer) {
          clearTimeout(exitGraceTimer);
          exitGraceTimer = null;
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      resetIdleTimer();

      child.once('error', (error) => {
        if (signal?.aborted) {
          finalizeReject(abortError(signal.reason));
          return;
        }
        finalizeReject(error);
      });
      child.once('exit', (code, closeSignal) => {
        exitCode = typeof code === 'number' ? code : 1;
        exitSignal = closeSignal;

        if (signal?.aborted || settled) {
          return;
        }

        exitGraceTimer = setTimeout(() => {
          if (!settled) {
            finalizeExit(true);
          }
        }, EXIT_STDIO_GRACE_MS);
        exitGraceTimer.unref?.();
      });
      child.once('close', (code, closeSignal) => {
        exitCode = typeof code === 'number' ? code : (exitCode ?? 1);
        exitSignal = closeSignal ?? exitSignal;
        if (signal?.aborted) {
          finalizeReject(abortError(signal.reason));
          return;
        }
        finalizeExit(false);
      });
    });
  }

  async dispose(): Promise<void> {
    // No persistent process to clean up for host-shell execution.
  }
}

export function createShellManager(options: CreateShellManagerOptions): ShellManager {
  if (options.sandbox) {
    return new AgentVMManager(options.workspacePath, options.network ?? false);
  }

  return new HostShellManager(options.workspacePath);
}

function getHostShellIdleTimeoutMs(): number {
  const raw = process.env.DC_HOST_SHELL_IDLE_TIMEOUT_MS;
  if (raw != null) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_HOST_SHELL_IDLE_TIMEOUT_MS;
}

function abortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

function terminateChildProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid !== 'number' || child.pid <= 0) {
    return;
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process groups are unavailable.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Ignore termination races during cancellation.
  }
}