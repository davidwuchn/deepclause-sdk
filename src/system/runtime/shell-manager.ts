import { spawn } from 'child_process';
import { AgentVMManager, type ShellExecResult } from './agentvm-manager.js';

export interface ShellManager {
  readonly kind: 'host' | 'sandbox';
  exec(command: string): Promise<ShellExecResult>;
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

  async exec(command: string): Promise<ShellExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-lc', command], {
        cwd: this.workspacePath,
        env: process.env,
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

      child.once('error', reject);
      child.once('close', (code, signal) => {
        const exitCode = typeof code === 'number' ? code : 1;
        const signalSuffix = signal ? ` (signal ${signal})` : '';
        resolve({
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