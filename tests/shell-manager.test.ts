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
    delete process.env.DC_HOST_SHELL_IDLE_TIMEOUT_MS;
    vi.useRealTimers();
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
    child.emit('exit', 0, null);
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

  it('resolves once the shell exits even when a background child keeps stdio open', async () => {
    vi.useFakeTimers();

    const child = createMockChildProcess(2468);
    childProcessMocks.spawn.mockReturnValue(child);
    const onExit = vi.fn();
    const manager = new HostShellManager('/tmp/workspace');

    const execPromise = manager.exec('python3 -m http.server 8080 &', undefined, { onExit });

    child.stdout.emit('data', 'Server started\n');
    child.emit('exit', 0, null);

    await vi.advanceTimersByTimeAsync(30);

    await expect(execPromise).resolves.toEqual({
      success: true,
      stdout: 'Server started\n',
      stderr: '',
      exitCode: 0,
      pid: 2468,
      backend: 'host',
      summary: 'Command completed successfully',
    });

    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith({
      command: 'python3 -m http.server 8080 &',
      pid: 2468,
      backend: 'host',
      success: true,
      exitCode: 0,
      summary: 'Command completed successfully',
    });

    vi.useRealTimers();
  });

  it('still captures trailing stdout when close follows exit quickly', async () => {
    vi.useFakeTimers();

    const child = createMockChildProcess(1357);
    childProcessMocks.spawn.mockReturnValue(child);
    const manager = new HostShellManager('/tmp/workspace');

    const execPromise = manager.exec('printf hello', undefined);

    child.stdout.emit('data', 'hello');
    child.emit('exit', 0, null);
    child.stdout.emit('data', ' world');
    child.emit('close', 0, null);

    await expect(execPromise).resolves.toMatchObject({
      success: true,
      stdout: 'hello world',
      exitCode: 0,
      pid: 1357,
    });

    expect(child.stdout.destroy).not.toHaveBeenCalled();
    expect(child.stderr.destroy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('fails host commands that stay silent past the idle timeout', async () => {
    vi.useFakeTimers();

    const child = createMockChildProcess(8642);
    childProcessMocks.spawn.mockReturnValue(child);
    process.env.DC_HOST_SHELL_IDLE_TIMEOUT_MS = '1000';

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    const onExit = vi.fn();
    const manager = new HostShellManager('/tmp/workspace');

    const execPromise = manager.exec('uv pip install thing', undefined, { onExit });

    await vi.advanceTimersByTimeAsync(1001);

    expect(killSpy).toHaveBeenCalledWith(-8642, 'SIGTERM');

    child.emit('close', 124, 'SIGTERM');

    await expect(execPromise).resolves.toEqual({
      success: false,
      stdout: '',
      stderr: 'Command timed out after 1000ms without output',
      exitCode: 124,
      pid: 8642,
      backend: 'host',
      summary: 'Command timed out after 1000ms without output',
    });

    expect(onExit).toHaveBeenCalledWith({
      command: 'uv pip install thing',
      pid: 8642,
      backend: 'host',
      success: false,
      exitCode: 124,
      summary: 'Command timed out after 1000ms without output',
    });
  });

  it('resets the idle timeout when output continues arriving', async () => {
    vi.useFakeTimers();

    const child = createMockChildProcess(9753);
    childProcessMocks.spawn.mockReturnValue(child);
    process.env.DC_HOST_SHELL_IDLE_TIMEOUT_MS = '1000';

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    const manager = new HostShellManager('/tmp/workspace');

    const execPromise = manager.exec('slow command', undefined);

    await vi.advanceTimersByTimeAsync(900);
    child.stdout.emit('data', 'still working\n');
    await vi.advanceTimersByTimeAsync(900);
    child.stderr.emit('data', 'more progress\n');
    await vi.advanceTimersByTimeAsync(900);

    expect(killSpy).not.toHaveBeenCalled();

    child.emit('close', 0, null);

    await expect(execPromise).resolves.toMatchObject({
      success: true,
      stdout: 'still working\n',
      stderr: 'more progress\n',
      exitCode: 0,
      pid: 9753,
      backend: 'host',
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
    stdout: EventEmitter & { setEncoding: (encoding: string) => void; destroy: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void; destroy: ReturnType<typeof vi.fn> };
    kill: (signal?: NodeJS.Signals) => boolean;
  };

  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void; destroy: ReturnType<typeof vi.fn> };
  child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void; destroy: ReturnType<typeof vi.fn> };
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdout.destroy = vi.fn();
  child.stderr.destroy = vi.fn();
  child.kill = () => {
    child.killed = true;
    return true;
  };

  return child;
}