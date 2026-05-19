import { describe, expect, it } from 'vitest';

import { getDefaultConfig, resolveCompactionConfig } from '../src/cli/config.js';

describe('CLI compaction config', () => {
  it('seeds default session and loop compactors', () => {
    const config = getDefaultConfig();

    expect(config.compaction?.enabled).toBe(true);
    expect(config.compaction?.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'default-session',
        scope: 'session',
        trigger: 'before_user_message',
        compactor: expect.objectContaining({
          source: '.deepclause/system/default-session-compactor.dml',
          sourceType: 'file',
        }),
      }),
      expect.objectContaining({
        name: 'default-loop',
        scope: 'loop',
        trigger: 'before_model_call',
        compactor: expect.objectContaining({
          source: '.deepclause/system/default-loop-compactor.dml',
          sourceType: 'file',
        }),
      }),
    ]));
  });

  it('resolves relative compactor file paths against the workspace root', () => {
    const config = getDefaultConfig();

    const resolved = resolveCompactionConfig(config, '/tmp/deepclause-workspace');
    const sources = Object.fromEntries(
      (resolved?.bindings ?? []).map((binding) => [binding.name, binding.compactor.source]),
    );

    expect(sources['default-session']).toBe('/tmp/deepclause-workspace/.deepclause/system/default-session-compactor.dml');
    expect(sources['default-loop']).toBe('/tmp/deepclause-workspace/.deepclause/system/default-loop-compactor.dml');
  });
});