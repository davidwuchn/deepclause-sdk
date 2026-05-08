import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const executeDmlMock = vi.hoisted(() => vi.fn());

vi.mock('../src/system/runtime/dml-executor.js', () => ({
  executeDml: executeDmlMock,
}));

describe('run child event forwarding', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = join(tmpdir(), `deepclause-run-child-events-${Date.now()}`);
    await mkdir(join(tempDir, '.deepclause'), { recursive: true });
    await mkdir(join(tempDir, 'workspace'), { recursive: true });
    await writeFile(
      join(tempDir, '.deepclause', 'config.json'),
      JSON.stringify({ model: 'gpt-4o', provider: 'openai', workspace: './workspace' }),
      'utf8',
    );
    await writeFile(join(tempDir, 'skill.dml'), 'agent_main :- answer("ok").\n', 'utf8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('forwards nested child events through run()', async () => {
    executeDmlMock.mockImplementation(async (options) => {
      options.skillCatalog?.onChildEvent?.('search-helper', { type: 'output', content: 'child output' });
      return {
        output: [],
        answer: 'ok',
        events: [],
      };
    });

    const { run } = await import('../src/cli/run.js');
    const onChildEvent = vi.fn();

    await run(join(tempDir, 'skill.dml'), [], {
      configRoot: tempDir,
      headless: true,
      onChildEvent,
    });

    expect(onChildEvent).toHaveBeenCalledWith('search-helper', { type: 'output', content: 'child output' });
  });
});