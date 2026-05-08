import { spawn, type ChildProcess } from 'child_process';
import { AgentVMManager, type ShellExecResult } from './agentvm-manager.js';

const ABORT_FORCE_KILL_MS = 500;

export interface ShellManager {
  readonly kind: 'host' | 'sandbox';
  exec(command: string, signal?: AbortSignal): Promise<ShellExecResult>;
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

  async exec(command: string, signal?: AbortSignal): Promise<ShellExecResult> {
    if (signal?.aborted) {
      throw abortError(signal.reason);
    }

    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-lc', command], {
        cwd: this.workspacePath,
        env: process.env,
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
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
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.once('error', (error) => {
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        if (signal?.aborted) {
          finalizeReject(abortError(signal.reason));
          return;
        }
        finalizeReject(error);
      });
      child.once('close', (code, closeSignal) => {
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        if (signal?.aborted) {
          finalizeReject(abortError(signal.reason));
          return;
        }
        const exitCode = typeof code === 'number' ? code : 1;
        const signalSuffix = closeSignal ? ` (signal ${closeSignal})` : '';
        finalizeResolve({
          success: exitCode === 0,
          stdout,
          stderr,
          exitCode,
          summary: exitCode === 0
            ? 'Command completed successfully'
            : (stderr || `Command failed with exit code ${exitCode}${signalSuffix}`),
        });
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