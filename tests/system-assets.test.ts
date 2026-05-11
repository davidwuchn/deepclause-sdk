import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { readSystemSkillAsset } from '../src/system/assets/index.js';

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'deepclause-system-'));
  tempDirs.push(workspaceRoot);
  return workspaceRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('system skill assets', () => {
  it('prefers a workspace conductor override when present', async () => {
    const workspaceRoot = await createWorkspace();
    const systemDir = join(workspaceRoot, '.deepclause', 'system');
    await mkdir(systemDir, { recursive: true });
    await writeFile(join(systemDir, 'conductor.dml'), 'agent_main(_):-answer("override conductor").\n', 'utf8');

    const content = await readSystemSkillAsset('conductor', { workspaceRoot });

    expect(content).toContain('override conductor');
  });

  it('prefers a workspace skill creator override when present', async () => {
    const workspaceRoot = await createWorkspace();
    const systemDir = join(workspaceRoot, '.deepclause', 'system');
    await mkdir(systemDir, { recursive: true });
    await writeFile(join(systemDir, 'skill-creator.dml'), 'agent_main(_):-answer("override skill creator").\n', 'utf8');

    const content = await readSystemSkillAsset('skill-creator', { workspaceRoot });

    expect(content).toContain('override skill creator');
  });

  it('falls back to the packaged asset when no override exists', async () => {
    const workspaceRoot = await createWorkspace();

    const content = await readSystemSkillAsset('conductor', { workspaceRoot });
    const packaged = await readSystemSkillAsset('conductor');

    expect(content).toBe(packaged);
  });

  it('uses atom syntax for zero-argument list_skills exec calls in the packaged skill creator', async () => {
    const content = await readSystemSkillAsset('skill-creator');

    expect(content).toContain('exec(list_skills, Skills).');
    expect(content).not.toContain('exec(list_skills(), Skills).');
  });
});