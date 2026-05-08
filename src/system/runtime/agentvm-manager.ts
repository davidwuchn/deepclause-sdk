import type { AgentVM } from 'deepclause-agentvm';

let AgentVMClass: (new (options?: { network?: boolean; mounts?: Record<string, string> }) => AgentVM) | null = null;

export interface ShellExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  summary: string;
}

export class AgentVMManager {
  private vm: AgentVM | null = null;
  readonly kind = 'sandbox' as const;

  constructor(
    private readonly workspacePath: string,
    private readonly network: boolean,
  ) {}

  async exec(command: string, signal?: AbortSignal): Promise<ShellExecResult> {
    if (signal?.aborted) {
      throw abortError(signal.reason);
    }

    const vm = await this.getVM();
    const result = signal
      ? await new Promise<Awaited<ReturnType<AgentVM['exec']>>>((resolve, reject) => {
          let settled = false;
          const finishResolve = (value: Awaited<ReturnType<AgentVM['exec']>>) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            resolve(value);
          };
          const finishReject = (error: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            reject(error);
          };
          const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
          };
          const onAbort = () => {
            void this.dispose().catch(() => {});
            finishReject(abortError(signal.reason));
          };

          signal.addEventListener('abort', onAbort, { once: true });
          void vm.exec(command)
            .then((value) => {
              if (signal.aborted) {
                finishReject(abortError(signal.reason));
                return;
              }
              finishResolve(value);
            })
            .catch((error) => {
              if (signal.aborted) {
                finishReject(abortError(signal.reason));
                return;
              }
              finishReject(error);
            });
        })
      : await vm.exec(command);

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const exitCode = result.exitCode ?? 0;
    return {
      success: exitCode === 0,
      stdout,
      stderr,
      exitCode,
      summary: exitCode === 0 ? 'Command completed successfully' : (stderr || `Command failed with exit code ${exitCode}`),
    };
  }

  async dispose(): Promise<void> {
    if (this.vm) {
      await this.vm.stop();
      this.vm = null;
    }
  }

  private async getVM(): Promise<AgentVM> {
    if (!AgentVMClass) {
      const mod = await import('deepclause-agentvm');
      AgentVMClass = mod.AgentVM;
    }
    if (!this.vm) {
      this.vm = new AgentVMClass!({
        network: this.network,
        mounts: { '/workspace': this.workspacePath },
      });
      await this.vm.start();
      await this.vm.exec('cd /workspace');
    }
    return this.vm;
  }
}

function abortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}