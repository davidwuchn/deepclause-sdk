import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const skillCreatorMocks = vi.hoisted(() => ({
  compileWithSkillCreator: vi.fn(),
  deriveSkillSlugFromMarkdown: vi.fn(),
}));

const sdkMocks = vi.hoisted(() => ({
  createDeepClause: vi.fn(),
}));

vi.mock('../src/system/runtime/skill-creator.js', () => ({
  compileWithSkillCreator: skillCreatorMocks.compileWithSkillCreator,
  deriveSkillSlugFromMarkdown: skillCreatorMocks.deriveSkillSlugFromMarkdown,
}));

vi.mock('../src/cli/commands.js', () => ({
  listCommands: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/cli/config.js', async () => {
  const actual = await import('../src/cli/config.js');
  return {
    ...actual,
    ensureWorkspaceDocSeeds: vi.fn(),
    getDocsDir: vi.fn((root: string) => `${root}/docs`),
    getConfigDir: vi.fn((root: string) => `${root}/.deepclause`),
    getToolsDir: vi.fn((root: string) => `${root}/.deepclause/tools`),
    loadConfig: vi.fn(),
    resolveModelSlot: vi.fn(),
  };
});

vi.mock('../src/cli/interactive.js', () => ({
  promptUser: vi.fn(),
}));

vi.mock('../src/system/assets/index.js', async () => {
  const actual = await import('../src/system/assets/index.js');
  return {
    ...actual,
    readSystemPromptAsset: vi.fn(),
    readSystemSkillAsset: vi.fn(),
  };
});

vi.mock('../src/system/runtime/dml-executor.js', () => ({
  executeDml: vi.fn(),
}));

vi.mock('../src/sdk.js', () => ({
  createDeepClause: sdkMocks.createDeepClause,
}));

import { resolveModelSlot } from '../src/cli/config.js';
import { executeDml } from '../src/system/runtime/dml-executor.js';
import { readSystemPromptAsset, readSystemSkillAsset } from '../src/system/assets/index.js';
import {
  appendConductorSessionMessages,
  consultRecipes,
  createConductorSession,
  createLocalSkill,
  getConductorSessionDetail,
  runConductorTurn,
} from '../src/system/runtime/conductor.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('createLocalSkill', () => {
  it('returns the published slug instead of the temporary request slug', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'deepclause-conductor-'));
    const workspacePath = path.join(workspaceRoot, 'workspace');
    const spec = 'Create a hello world multi skill that takes exactly two arguments.';
    const temporarySlug = 'create-a-hello-world-multi-skill-that-takes-exac';
    const publishedOutputPath = path.join(workspaceRoot, '.deepclause', 'tools', 'hello-world-multi.dml');

    skillCreatorMocks.deriveSkillSlugFromMarkdown.mockReturnValue(temporarySlug);
    skillCreatorMocks.compileWithSkillCreator.mockResolvedValue({
      dml: 'agent_main(_):-answer("ok").\n',
      meta: { description: 'Hello world helper.', tools: [] },
      tools: [],
      outputPath: publishedOutputPath,
      explanation: 'compiled',
      analysis: { valid: true, warnings: [], capabilities: [] },
      usageByModel: {},
    } as never);

    const result = await createLocalSkill({
      spec,
      workspaceRoot,
      workspacePath,
      config: {},
      compileSelection: {
        id: 'compile-model',
        model: 'compile-model',
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: undefined,
        temperature: 0,
      },
      runSelection: {
        id: 'run-model',
        model: 'run-model',
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: undefined,
        temperature: 0,
      },
      sessionId: 'session-1',
      sandbox: false,
      onUserInput: vi.fn(),
    });

    expect(skillCreatorMocks.compileWithSkillCreator).toHaveBeenCalledWith(
      spec,
      expect.objectContaining({ baseName: temporarySlug }),
    );
    expect(result).toMatchObject({
      success: true,
      slug: 'hello-world-multi',
      output_path: publishedOutputPath,
      description: 'Hello world helper.',
      tools: [],
    });
  });
});

describe('consultRecipes', () => {
  it('returns matching recipe metadata and content', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'deepclause-conductor-recipes-'));
    const recipeDir = path.join(workspaceRoot, '.deepclause', 'system', 'recipes', 'repo-change-workflow');
    await mkdir(recipeDir, { recursive: true });
    await writeFile(
      path.join(recipeDir, 'SKILL.md'),
      `---
name: Repo Change Workflow
description: Guidance for code changes and focused validation.
tags: [coding, tests]
when_to_use:
  - updating a repository and its tests
---

Run focused tests after small edits.
`,
      'utf8',
    );

    const result = await consultRecipes({
      workspaceRoot,
      query: 'I need guidance for updating code and tests in this repository',
      maxResults: 5,
    });

    expect(result).toMatchObject({
      success: true,
      total_recipes: expect.any(Number),
    });
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slug: 'repo-change-workflow',
        name: 'Repo Change Workflow',
        description: 'Guidance for code changes and focused validation.',
        content: expect.stringContaining('Run focused tests after small edits.'),
      }),
    ]));
  });
});

describe('appendConductorSessionMessages', () => {
  it('appends user and assistant transcript entries to an existing session', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'deepclause-conductor-append-'));
    const session = await createConductorSession(workspaceRoot, 'Shell transcript session');

    await appendConductorSessionMessages(workspaceRoot, session.id, [
      { role: 'user', content: '[shell command]\npwd' },
      { role: 'assistant', content: '[shell result]\n\nstdout:\n/workspace' },
    ]);

    const detail = await getConductorSessionDetail(workspaceRoot, session.id);
    expect(detail.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '[shell command]\npwd' }),
      expect.objectContaining({ role: 'assistant', content: '[shell result]\n\nstdout:\n/workspace' }),
    ]);
  });
});

describe('runConductorTurn execution logging', () => {
  it('writes a per-session execution log and exposes its path to the conductor prompt', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'deepclause-conductor-session-'));

    vi.mocked(resolveModelSlot).mockImplementation((config, slot) => ({
      id: `${String(slot)}-model`,
      model: `${String(slot)}-model`,
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: undefined,
      temperature: 0,
    }) as never);
    vi.mocked(readSystemPromptAsset).mockResolvedValue('Prompt for {ASSISTANT_NAME}');
    vi.mocked(readSystemSkillAsset).mockResolvedValue('agent_main(_):-answer("ok").\n');
    vi.mocked(executeDml).mockImplementation(async (options: any) => {
      options.onEvent?.({ type: 'output', content: 'main output' });
      options.skillCatalog?.onChildEvent?.('repo-check', { type: 'error', content: 'child failure' });
      options.onEvent?.({
        type: 'usage',
        usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      });
      return {
        output: ['main output'],
        answer: 'Final answer',
      } as never;
    });

    const result = await runConductorTurn('Investigate the failing skill', {
      workspaceRoot,
      sessionTitle: 'Debug failing run',
      config: { workspace: './workspace' } as never,
      headless: true,
      stream: false,
    });

    const session = await getConductorSessionDetail(workspaceRoot, result.sessionId);
    const logContent = await readFile(session.executionLogPath, 'utf8');
    const records = logContent
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records[0]).toMatchObject({
      entryType: 'execution_started',
      executionKind: 'conductor',
      inputText: 'Investigate the failing skill',
      modelId: 'gateway-model',
    });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryType: 'event',
        executionKind: 'conductor',
        scope: 'main',
        event: expect.objectContaining({ type: 'output', content: 'main output' }),
      }),
      expect.objectContaining({
        entryType: 'event',
        executionKind: 'conductor',
        scope: 'child',
        childSlug: 'repo-check',
        event: expect.objectContaining({ type: 'error', content: 'child failure' }),
      }),
      expect.objectContaining({
        entryType: 'execution_finished',
        executionKind: 'conductor',
        status: 'success',
        answer: 'Final answer',
        outputCount: 1,
        usageByModel: expect.objectContaining({ 'gateway-model': expect.any(Object) }),
      }),
    ]));

    const executeCall = vi.mocked(executeDml).mock.calls[0]?.[0];
    expect(executeCall?.params?.system_prompt).toContain(`Session execution log: ${session.executionLogPath}`);
  });
});

describe('runConductorTurn session compaction', () => {
  it('compacts persisted session history before the next conductor turn', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'deepclause-conductor-compaction-'));
    const session = await createConductorSession(workspaceRoot, 'Compaction session');
    const messagesPath = path.join(workspaceRoot, '.deepclause', 'sessions', session.id, 'messages.jsonl');

    await writeFile(messagesPath, [
      JSON.stringify({ role: 'user', content: 'Please summarize a very long earlier investigation about quantum computing milestones and open questions.', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ role: 'assistant', content: 'Earlier summary: this is a long assistant response containing detailed notes, milestones, papers, and follow-up actions that should be compacted before the next turn.', timestamp: '2026-01-01T00:00:01.000Z' }),
    ].join('\n') + '\n', 'utf8');

    vi.mocked(resolveModelSlot).mockImplementation((config, slot) => ({
      id: `${String(slot)}-model`,
      model: `${String(slot)}-model`,
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: undefined,
      temperature: 0,
    }) as never);
    vi.mocked(readSystemPromptAsset).mockResolvedValue('Prompt for {ASSISTANT_NAME}');
    vi.mocked(readSystemSkillAsset).mockResolvedValue('agent_main(_):-answer("ok").\n');
    vi.mocked(executeDml).mockResolvedValue({
      output: [],
      answer: 'Fresh answer',
    } as never);
    sdkMocks.createDeepClause.mockResolvedValue({
      runDML: async function* () {
        yield {
          type: 'answer',
          content: '{"apply":true,"messages":[{"role":"assistant","content":"Condensed session summary"}]}',
        };
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    } as never);

    const events: Array<Record<string, unknown>> = [];
    await runConductorTurn('Continue from here', {
      workspaceRoot,
      sessionId: session.id,
      config: {
        workspace: './workspace',
        compaction: {
          enabled: true,
          bindings: [{
            name: 'session-test',
            scope: 'session',
            trigger: 'before_user_message',
            compactor: {
              sourceType: 'inline',
              source: 'agent_main :- answer("{\\"apply\\":true,\\"messages\\":[{\\"role\\":\\"assistant\\",\\"content\\":\\"Condensed session summary\\"}]}").',
            },
          }],
        },
      } as never,
      headless: true,
      stream: false,
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    });

    const executeCall = vi.mocked(executeDml).mock.calls[0]?.[0];
    expect(executeCall?.initialMessages).toEqual([
      { role: 'assistant', content: 'Condensed session summary' },
    ]);

    const detail = await getConductorSessionDetail(workspaceRoot, session.id);
    expect(detail.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Condensed session summary' }),
      expect.objectContaining({ role: 'user', content: 'Continue from here' }),
      expect.objectContaining({ role: 'assistant', content: 'Fresh answer' }),
    ]);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'memory_compaction',
          compactionBindingName: 'session-test',
          compactionAction: 'applied',
        }),
      }),
    ]));
  });

  it('reuses the resolved runtime provider for inherited session compactors', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'deepclause-conductor-provider-'));
    const session = await createConductorSession(workspaceRoot, 'Provider session');
    const messagesPath = path.join(workspaceRoot, '.deepclause', 'sessions', session.id, 'messages.jsonl');

    await writeFile(messagesPath, [
      JSON.stringify({ role: 'assistant', content: 'Existing context that forces session compaction execution.', timestamp: '2026-01-01T00:00:00.000Z' }),
    ].join('\n') + '\n', 'utf8');

    vi.mocked(resolveModelSlot).mockImplementation((config, slot) => ({
      id: `${String(slot)}-model`,
      model: 'custom:aliyun:qwen3.6-plus',
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://aliyun.example.invalid/v1',
      temperature: 0,
    }) as never);
    vi.mocked(readSystemPromptAsset).mockResolvedValue('Prompt for {ASSISTANT_NAME}');
    vi.mocked(readSystemSkillAsset).mockResolvedValue('agent_main(_):-answer("ok").\n');
    vi.mocked(executeDml).mockResolvedValue({
      output: [],
      answer: 'Fresh answer',
    } as never);
    sdkMocks.createDeepClause.mockResolvedValue({
      runDML: async function* () {
        yield {
          type: 'answer',
          content: '{"apply":false}',
        };
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    } as never);

    await runConductorTurn('Continue from here', {
      workspaceRoot,
      sessionId: session.id,
      config: {
        workspace: './workspace',
        compaction: {
          enabled: true,
          bindings: [{
            name: 'session-provider-test',
            scope: 'session',
            trigger: 'before_user_message',
            compactor: {
              sourceType: 'inline',
              source: 'agent_main :- answer("{\\"apply\\":false}").',
            },
          }],
        },
      } as never,
      headless: true,
      stream: false,
    });

    expect(sdkMocks.createDeepClause).toHaveBeenCalledWith(expect.objectContaining({
      model: 'custom:aliyun:qwen3.6-plus',
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://aliyun.example.invalid/v1',
    }));
  });
});