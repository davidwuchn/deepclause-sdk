import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';
import {
  deepClauseDirExists,
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
});