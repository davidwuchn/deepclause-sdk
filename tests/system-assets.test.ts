import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { getSystemAssetSourcePaths, readSystemPromptAsset, readSystemSkillAsset } from '../src/system/assets/index.js';

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

  it('prefers a workspace conductor prompt override when present', async () => {
    const workspaceRoot = await createWorkspace();
    const systemDir = join(workspaceRoot, '.deepclause', 'system');
    await mkdir(systemDir, { recursive: true });
    await writeFile(join(systemDir, 'CONDUCTOR_PROMPT.md'), '# custom conductor prompt\n', 'utf8');

    const content = await readSystemPromptAsset('conductor', { workspaceRoot });

    expect(content).toContain('custom conductor prompt');
  });

  it('prefers a workspace skill creator prompt override when present', async () => {
    const workspaceRoot = await createWorkspace();
    const systemDir = join(workspaceRoot, '.deepclause', 'system');
    await mkdir(systemDir, { recursive: true });
    await writeFile(join(systemDir, 'DML_COMPILER_PROMPT.md'), '# custom compiler prompt\n', 'utf8');

    const content = await readSystemPromptAsset('skill-creator', { workspaceRoot });

    expect(content).toContain('custom compiler prompt');
  });

  it('reports the resolved system asset source paths for the workspace', async () => {
    const workspaceRoot = await createWorkspace();
    const systemDir = join(workspaceRoot, '.deepclause', 'system');
    await mkdir(systemDir, { recursive: true });
    await writeFile(join(systemDir, 'conductor.dml'), 'agent_main(_):-answer("override conductor").\n', 'utf8');
    await writeFile(join(systemDir, 'CONDUCTOR_PROMPT.md'), '# custom conductor prompt\n', 'utf8');

    const sources = getSystemAssetSourcePaths(workspaceRoot);

    expect(sources.conductorDml).toBe(join(systemDir, 'conductor.dml'));
    expect(sources.conductorPrompt).toBe(join(systemDir, 'CONDUCTOR_PROMPT.md'));
    expect(sources.skillCreatorDml).toContain('/src/system/assets/skills/skill-creator.dml');
    expect(sources.skillCreatorPrompt).toContain('/src/system/assets/docs/DML_COMPILER_PROMPT.md');
  });
});