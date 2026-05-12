import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: childProcessMocks.spawn,
}));

import { HostShellManager } from '../src/system/runtime/shell-manager.js';

describe('HostShellManager cancellation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    childProcessMocks.spawn.mockReset();
  });

  it('starts host commands in a separate process group and kills the whole group on abort', async () => {
    const child = createMockChildProcess(4321);
    childProcessMocks.spawn.mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    const manager = new HostShellManager('/tmp/workspace');
    const controller = new AbortController();

    const execPromise = manager.exec('sleep 10', controller.signal);
    controller.abort();

    await expect(execPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(childProcessMocks.spawn).toHaveBeenCalledWith('bash', ['-lc', 'sleep 10'], expect.objectContaining({
      cwd: '/tmp/workspace',
      detached: true,
    }));
    expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
  });

  it('reports shell start, output, and exit events to observers', async () => {
    const child = createMockChildProcess(9876);
    childProcessMocks.spawn.mockReturnValue(child);
    const manager = new HostShellManager('/tmp/workspace');
    const onStart = vi.fn();
    const onStdout = vi.fn();
    const onStderr = vi.fn();
    const onExit = vi.fn();

    const execPromise = manager.exec('printf hello', undefined, {
      onStart,
      onStdout,
      onStderr,
      onExit,
    });

    child.stdout.emit('data', 'hello');
    child.stderr.emit('data', 'warn');
    child.emit('close', 0, null);

    await expect(execPromise).resolves.toEqual({
      success: true,
      stdout: 'hello',
      stderr: 'warn',
      exitCode: 0,
      pid: 9876,
      backend: 'host',
      summary: 'Command completed successfully',
    });

    expect(onStart).toHaveBeenCalledWith({
      command: 'printf hello',
      pid: 9876,
      backend: 'host',
    });
    expect(onStdout).toHaveBeenCalledWith({
      command: 'printf hello',
      chunk: 'hello',
      pid: 9876,
      backend: 'host',
    });
    expect(onStderr).toHaveBeenCalledWith({
      command: 'printf hello',
      chunk: 'warn',
      pid: 9876,
      backend: 'host',
    });
    expect(onExit).toHaveBeenCalledWith({
      command: 'printf hello',
      pid: 9876,
      backend: 'host',
      success: true,
      exitCode: 0,
      summary: 'Command completed successfully',
    });
  });
});

function createMockChildProcess(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdout: EventEmitter & { setEncoding: (encoding: string) => void };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void };
    kill: (signal?: NodeJS.Signals) => boolean;
  };

  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kill = () => {
    child.killed = true;
    return true;
  };

  return child;
}