import { describe, expect, it, vi } from 'vitest';
import { registerLocalRuntimeTools } from '../src/system/runtime/runtime-tools.js';

describe('runtime skill catalog tools', () => {
  it('registers list_skills and run_skill when a catalog runtime is provided', async () => {
    const registerTool = vi.fn();
    const listSkills = vi.fn().mockResolvedValue([{ slug: 'search-arxiv' }]);
    const runSkill = vi.fn().mockResolvedValue({ success: true, slug: 'search-arxiv' });

    registerLocalRuntimeTools({ registerTool } as never, {
      workspacePath: '/tmp/workspace',
      shell: { exec: vi.fn() } as never,
      skillCatalog: { listSkills, runSkill },
    });

    const registrations = new Map(registerTool.mock.calls.map(([name, definition]) => [name, definition]));
    expect(registrations.has('list_skills')).toBe(true);
    expect(registrations.has('run_skill')).toBe(true);

    await expect(registrations.get('list_skills').execute({})).resolves.toEqual([{ slug: 'search-arxiv' }]);
    await expect(registrations.get('run_skill').execute({ slug: 'search-arxiv', args: ['topic'] })).resolves.toEqual({
      success: true,
      slug: 'search-arxiv',
    });

    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(runSkill).toHaveBeenCalledWith({ slug: 'search-arxiv', args: ['topic'] });
  });

  it('forwards shell progress events from bash into the runtime event stream', async () => {
    const registerTool = vi.fn();
    const onEvent = vi.fn();
    const exec = vi.fn().mockImplementation(async (_command, _signal, observer) => {
      observer?.onStart?.({ command: 'printf hello', pid: 1234, backend: 'host' });
      observer?.onStdout?.({ command: 'printf hello', chunk: 'hello\nworld\n', pid: 1234, backend: 'host' });
      observer?.onStderr?.({ command: 'printf hello', chunk: 'warn', pid: 1234, backend: 'host' });
      observer?.onExit?.({
        command: 'printf hello',
        pid: 1234,
        backend: 'host',
        success: true,
        exitCode: 0,
        summary: 'Command completed successfully',
      });
      return {
        success: true,
        stdout: 'hello\nworld\n',
        stderr: 'warn',
        exitCode: 0,
        pid: 1234,
        backend: 'host',
        summary: 'Command completed successfully',
      };
    });

    registerLocalRuntimeTools({ registerTool } as never, {
      workspacePath: '/tmp/workspace',
      shell: { exec } as never,
      onEvent,
    });

    const registrations = new Map(registerTool.mock.calls.map(([name, definition]) => [name, definition]));
    await expect(registrations.get('bash').execute({ command: 'printf hello' })).resolves.toEqual({
      success: true,
      stdout: 'hello\nworld\n',
      stderr: 'warn',
      exitCode: 0,
      pid: 1234,
      backend: 'host',
      summary: 'Command completed successfully',
    });

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      {
        type: 'tool_call',
        toolName: 'bash',
        toolArgs: { command: 'printf hello' },
        toolState: 'running',
        toolPid: 1234,
        toolBackend: 'host',
      },
      { type: 'log', content: 'bash[1234] stdout hello' },
      { type: 'log', content: 'bash[1234] stdout world' },
      { type: 'log', content: 'bash[1234] stderr warn' },
    ]);
  });
});