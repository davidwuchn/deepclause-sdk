import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';
import {
  deepClauseDirExists,
  getDocsDir,
  getSystemDir,
  getToolsDir,
  initConfig,
} from '../src/cli/config.js';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return memfs.fs.promises;
});

describe('deepclause init defaults', () => {
  beforeEach(() => {
    vol.reset();
  });

  afterEach(() => {
    vol.reset();
  });

  it('seeds the default deep research skill pair during init', async () => {
    await initConfig('/workspace');

    const toolsDir = getToolsDir('/workspace');
    const parentDmlPath = `${toolsDir}/deep-research.dml`;
    const childDmlPath = `${toolsDir}/research-search-reader.dml`;
    const parentMetaPath = `${toolsDir}/deep-research.meta.json`;
    const childMetaPath = `${toolsDir}/research-search-reader.meta.json`;

    expect(vol.existsSync(parentDmlPath)).toBe(true);
    expect(vol.existsSync(childDmlPath)).toBe(true);
    expect(vol.existsSync(parentMetaPath)).toBe(true);
    expect(vol.existsSync(childMetaPath)).toBe(true);

    const parentDml = vol.readFileSync(parentDmlPath, 'utf8') as string;
    const childDml = vol.readFileSync(childDmlPath, 'utf8') as string;
    const parentMeta = JSON.parse(vol.readFileSync(parentMetaPath, 'utf8') as string);
    const childMeta = JSON.parse(vol.readFileSync(childMetaPath, 'utf8') as string);

    expect(parentDml).toContain('run_skill(slug: "research-search-reader"');
    expect(parentDml).toContain('tool(search_topic(Query, Summary)');
    expect(childDml).toContain('exec(web_search(query: Query, count: 8), Results)');
    expect(childDml).toContain('exec(news_search(query: Query, count: 5), Results)');

    expect(parentMeta).toMatchObject({
      description: 'Conducts multi-source web research on any topic and saves a cited Markdown report to your workspace.',
      tools: ['ask_user', 'run_skill'],
    });
    expect(childMeta).toMatchObject({
      description: 'Helper skill that wraps web and news search and rewrites raw results into readable research notes.',
      tools: ['news_search', 'web_search'],
    });
  });

  it('detects whether the .deepclause directory exists', async () => {
    expect(await deepClauseDirExists('/workspace')).toBe(false);

    await initConfig('/workspace');

    expect(await deepClauseDirExists('/workspace')).toBe(true);
  });

  it('seeds editable system DML and prompt overrides during init', async () => {
    await initConfig('/workspace');

    const systemDir = getSystemDir('/workspace');
    const docsDir = getDocsDir('/workspace');
    const recipePath = `${systemDir}/recipes/deepclause-coding-workflow/SKILL.md`;

    expect(vol.existsSync(`${systemDir}/conductor.dml`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/skill-creator.dml`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/default-session-compactor.dml`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/default-loop-compactor.dml`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/CONDUCTOR_PROMPT.md`)).toBe(true);
    expect(vol.existsSync(`${systemDir}/DML_COMPILER_PROMPT.md`)).toBe(true);
    expect(vol.existsSync(recipePath)).toBe(true);
    expect(vol.existsSync(`${docsDir}/TUI.md`)).toBe(true);

    const conductorPrompt = vol.readFileSync(`${systemDir}/CONDUCTOR_PROMPT.md`, 'utf8') as string;
    const compilerPrompt = vol.readFileSync(`${systemDir}/DML_COMPILER_PROMPT.md`, 'utf8') as string;
    const sessionCompactor = vol.readFileSync(`${systemDir}/default-session-compactor.dml`, 'utf8') as string;
    const loopCompactor = vol.readFileSync(`${systemDir}/default-loop-compactor.dml`, 'utf8') as string;
    const recipe = vol.readFileSync(recipePath, 'utf8') as string;
    const tuiGuide = vol.readFileSync(`${docsDir}/TUI.md`, 'utf8') as string;

    expect(conductorPrompt).toContain('# Who you are');
    expect(compilerPrompt).toContain('DeepClause Meta Language');
    expect(compilerPrompt).toContain('.deepclause/tools/lib/<skill-or-tool-name>/');
    expect(compilerPrompt).toContain('.venv');
    expect(sessionCompactor).toContain('messages_json');
    expect(sessionCompactor).toContain('param(message_count, MessageCount)');
    expect(sessionCompactor).toContain('param(estimated_tokens, EstimatedTokens)');
    expect(sessionCompactor).toContain('EstimatedTokens < 50000');
    expect(loopCompactor).toContain('messages_json');
    expect(loopCompactor).toContain('param(message_count, MessageCount)');
    expect(loopCompactor).toContain('param(estimated_tokens, EstimatedTokens)');
    expect(loopCompactor).toContain('EstimatedTokens < 50000');
    expect(recipe).toContain('DeepClause Coding Workflow');
    expect(recipe).toContain('create a proper skill instead');
    expect(tuiGuide).toContain('# DeepClause TUI Guide');
  });

  it('seeds the task prompt override during init', async () => {
    await initConfig('/workspace');

    const systemDir = getSystemDir('/workspace');
    expect(vol.existsSync(`${systemDir}/TASK_PROMPT.md`)).toBe(true);

    const taskPrompt = vol.readFileSync(`${systemDir}/TASK_PROMPT.md`, 'utf8') as string;
    expect(taskPrompt).toContain('# DeepClause Task Harness');
    expect(taskPrompt).toContain('{TASK_DESCRIPTION}');
  });
});