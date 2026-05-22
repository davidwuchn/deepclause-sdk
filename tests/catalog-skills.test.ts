import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createLocalSkillCatalogRuntime,
  listLocalSkillCatalog,
} from '../src/system/runtime/catalog-skills.js';
import type { Config, ResolvedModelConfig } from '../src/cli/config.js';

describe('local skill catalog runtime', () => {
  let workspaceRoot: string;
  let executeNestedSkill: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'deepclause-skill-catalog-'));
    await mkdir(join(workspaceRoot, '.deepclause', 'tools'), { recursive: true });

    await writeFile(
      join(workspaceRoot, '.deepclause', 'tools', 'search-arxiv.dml'),
      'agent_main(Query) :- answer(Query).\n',
      'utf8',
    );
    await writeFile(
      join(workspaceRoot, '.deepclause', 'tools', 'search-arxiv.meta.json'),
      JSON.stringify({
        name: 'Search arXiv',
        parameters: [{ name: 'query', position: 0 }],
        triggerPhrases: ['search arxiv'],
        capabilities: ['network'],
        tools: ['web_search'],
        description: 'Search arXiv.',
      }) + '\n',
      'utf8',
    );

    await writeFile(
      join(workspaceRoot, '.deepclause', 'tools', '_system-helper.dml'),
      'agent_main :- answer("hidden").\n',
      'utf8',
    );

    executeNestedSkill = vi.fn().mockResolvedValue({
      output: ['child output'],
      answer: 'child answer',
    });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('lists only non-system catalog skills by default', async () => {
    const catalog = await listLocalSkillCatalog(workspaceRoot, { detailed: true });

    expect(catalog.map((entry) => entry.slug)).toEqual(['search-arxiv']);
    expect(catalog[0]).toMatchObject({
      slug: 'search-arxiv',
      name: 'Search arXiv',
      usage: 'run_skill(slug: "search-arxiv", args: ["<query>"])',
      trigger_phrases: ['search arxiv'],
      capabilities: ['Uses network access'],
      tools: ['web_search'],
    });
  });

  it('runs a child skill with mapped positional params', async () => {
    const runtime = createLocalSkillCatalogRuntime({
      workspaceRoot,
      workspacePath: workspaceRoot,
      config: createConfig(),
      selection: createSelection(),
      currentSkillSlug: 'research-helper',
      executeNestedSkill,
    });

    const result = await runtime.runSkill({ slug: 'search-arxiv', args: ['quantum error correction'] });

    expect(result).toMatchObject({
      success: true,
      slug: 'search-arxiv',
      answer: 'child answer',
    });
    expect(executeNestedSkill).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'search-arxiv',
      args: ['quantum error correction'],
      params: {
        args: ['quantum error correction'],
        query: 'quantum error correction',
      },
      invocationStack: ['research-helper', 'search-arxiv'],
    }));
  });

  it('blocks system skills, cycles, and excessive nesting', async () => {
    const systemRuntime = createLocalSkillCatalogRuntime({
      workspaceRoot,
      workspacePath: workspaceRoot,
      config: createConfig(),
      selection: createSelection(),
      currentSkillSlug: 'research-helper',
      executeNestedSkill,
    });

    await expect(systemRuntime.runSkill({ slug: '_system-helper' })).rejects.toThrow('system skill');

    const cycleRuntime = createLocalSkillCatalogRuntime({
      workspaceRoot,
      workspacePath: workspaceRoot,
      config: createConfig(),
      selection: createSelection(),
      currentSkillSlug: 'search-arxiv',
      invocationStack: ['research-helper', 'search-arxiv'],
      executeNestedSkill,
    });

    await expect(cycleRuntime.runSkill({ slug: 'search-arxiv' })).rejects.toThrow('cycle');

    const depthRuntime = createLocalSkillCatalogRuntime({
      workspaceRoot,
      workspacePath: workspaceRoot,
      config: createConfig(),
      selection: createSelection(),
      currentSkillSlug: 'child-skill',
      invocationStack: ['root-skill', 'child-skill'],
      maxDepth: 2,
      executeNestedSkill,
    });

    await expect(depthRuntime.runSkill({ slug: 'another-child' })).rejects.toThrow('maximum depth');
  });
});

function createConfig(): Config {
  return {
    models: {
      gateway: 'openai:gpt-4o',
      run: 'openai:gpt-4o',
      compile: 'openai:gpt-4o',
    },
    temperatures: {
      gateway: 0.7,
      run: 0.7,
      compile: 0.4,
    },
    providers: {},
    mcp: { servers: {} },
    agentvm: { network: false },
    dmlBase: '.deepclause/tools',
    workspace: './',
  };
}

function createSelection(): ResolvedModelConfig {
  return {
    id: 'openai:gpt-4o',
    provider: 'openai',
    model: 'gpt-4o',
    slot: 'run',
    temperature: 0.7,
  };
}