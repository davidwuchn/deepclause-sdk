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
});