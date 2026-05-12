import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  createDeepClause: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  executeDml: vi.fn(),
}));

const compilerMocks = vi.hoisted(() => ({
  analyzeAndAuditDML: vi.fn(),
  analyzeDML: vi.fn(),
  extractDescription: vi.fn(),
  extractParameters: vi.fn(),
  validateWithProlog: vi.fn(),
}));

vi.mock('../src/sdk.js', () => ({
  createDeepClause: sdkMocks.createDeepClause,
}));

vi.mock('../src/system/runtime/dml-executor.js', () => ({
  executeDml: runtimeMocks.executeDml,
}));

vi.mock('../src/system/assets/index.js', () => ({
  readSystemPromptAsset: vi.fn().mockResolvedValue('{TOOLS_TABLE}\n{LLM_ACCESS_SECTION}'),
  readSystemSkillAsset: vi.fn().mockResolvedValue('agent_main(_):-answer("ok").\n'),
}));

vi.mock('../src/system/runtime/shell-manager.js', () => ({
  createShellManager: vi.fn().mockReturnValue({
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../src/system/runtime/catalog-skills.js', () => ({
  listLocalSkillCatalog: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/cli/search.js', () => ({
  newsSearch: vi.fn(),
  webSearch: vi.fn(),
}));

vi.mock('../src/compiler.js', () => ({
  analyzeAndAuditDML: compilerMocks.analyzeAndAuditDML,
  analyzeDML: compilerMocks.analyzeDML,
  extractDescription: compilerMocks.extractDescription,
  extractParameters: compilerMocks.extractParameters,
  validateWithProlog: compilerMocks.validateWithProlog,
}));

import { compileWithSkillCreator } from '../src/system/runtime/skill-creator.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('compileWithSkillCreator', () => {
  async function createOptions() {
    const workspacePath = await mkdtemp(path.join(tmpdir(), 'deepclause-skill-creator-'));
    return {
      sourcePath: path.join(workspacePath, 'spec.md'),
      outputDir: path.join(workspacePath, 'tools'),
      baseName: 'demo-skill',
      workspaceRoot: workspacePath,
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
    } as const;
  }

  function mockSdk(): void {
    const registeredTools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>();
    sdkMocks.createDeepClause.mockResolvedValue({
      registerTool: vi.fn((name: string, tool: { execute: (args: Record<string, unknown>) => Promise<unknown> }) => {
        registeredTools.set(name, tool);
      }),
      runDML: vi.fn(async function* () {
        yield { type: 'output', content: 'planning' };
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    return registeredTools;
  }

  function mockPublishingSdk(): void {
    const registeredTools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>();

    sdkMocks.createDeepClause.mockResolvedValue({
      registerTool: vi.fn((name: string, tool: { execute: (args: Record<string, unknown>) => Promise<unknown> }) => {
        registeredTools.set(name, tool);
      }),
      runDML: vi.fn(async function* () {
        await registeredTools.get('write_file')?.execute({
          path: 'demo-skill.dml',
          content: 'agent_main(Topic) :- answer(Topic).\n',
        });

        await registeredTools.get('deploy_skill')?.execute({
          dml_file: 'demo-skill.dml',
          spec_markdown: '# Demo Skill\n\nSummarize a topic.\n',
          metadata_json: JSON.stringify({
            slug: 'demo-skill',
            name: 'Demo Skill',
            description: 'Summarize a topic.',
            trigger_phrases: ['demo skill'],
          }),
        });

        yield { type: 'answer', content: 'compiled' };
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    });
  }

  it('enables streaming when a live event listener is attached', async () => {
    mockSdk();
    const options = await createOptions();

    await expect(compileWithSkillCreator('Create a demo skill', {
      ...options,
      onEvent: vi.fn(),
    })).rejects.toThrow('Skill creator finished without producing a published artifact');

    expect(sdkMocks.createDeepClause).toHaveBeenCalledWith(expect.objectContaining({
      streaming: true,
    }));
  });

  it('keeps non-streaming mode for non-interactive callers', async () => {
    mockSdk();
    const options = await createOptions();

    await expect(compileWithSkillCreator('Create a demo skill', options))
      .rejects.toThrow('Skill creator finished without producing a published artifact');

    expect(sdkMocks.createDeepClause).toHaveBeenCalledWith(expect.objectContaining({
      streaming: false,
    }));
  });

  it('forwards live events from test_dml tool runs', async () => {
    const registeredTools = mockSdk();
    const options = await createOptions();
    const onEvent = vi.fn();
    const dmlPath = path.join(options.workspacePath, 'demo-skill.dml');

    runtimeMocks.executeDml.mockImplementation(async (runOptions: { onEvent?: (event: { type: string; content?: string; trace?: string[] }) => void }) => {
      const events = [
        { type: 'stream', content: 'Hello' },
        { type: 'output', content: 'Running demo' },
        { type: 'answer', content: 'ok' },
        { type: 'finished', trace: [] },
      ];

      for (const event of events) {
        runOptions.onEvent?.(event);
      }

      return {
        events,
        output: ['Running demo'],
        answer: 'ok',
        error: undefined,
        trace: [],
      };
    });
    await writeFile(dmlPath, 'agent_main(_):-answer("ok").\n', 'utf8');

    await expect(compileWithSkillCreator('Create a demo skill', {
      ...options,
      onEvent,
    })).rejects.toThrow('Skill creator finished without producing a published artifact');

    const testTool = registeredTools.get('test_dml');
    expect(testTool).toBeDefined();

    const result = await testTool!.execute({
      dml_file: 'demo-skill.dml',
      test_input: 'hello',
    }) as Record<string, unknown>;

    expect(runtimeMocks.executeDml).toHaveBeenCalledWith(expect.objectContaining({
      onEvent,
      headless: true,
      stream: false,
    }));
    expect(onEvent).toHaveBeenCalledWith({ type: 'stream', content: 'Hello' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'output', content: 'Running demo' });
    expect(result).toEqual(expect.objectContaining({
      success: true,
      status: 'ok',
      answer: 'ok',
      outputs: ['Running demo'],
    }));
  });

  it('runs the shared analysis and LLM audit for published skills', async () => {
    mockPublishingSdk();
    const options = await createOptions();

    compilerMocks.extractDescription.mockReturnValue('Demo skill description');
    compilerMocks.extractParameters.mockReturnValue([{ name: 'topic', position: 1, required: true }]);
    compilerMocks.analyzeDML.mockResolvedValue({
      valid: true,
      warnings: [],
      capabilities: ['tool_use(web_search)'],
    });
    compilerMocks.analyzeAndAuditDML.mockResolvedValue({
      valid: true,
      warnings: [],
      capabilities: ['tool_use(web_search)'],
      auditorReport: '## Audit\n\nNo critical issues found.',
    });

    const result = await compileWithSkillCreator('Create a demo skill', {
      ...options,
      audit: true,
    });

    expect(compilerMocks.analyzeAndAuditDML).toHaveBeenCalledWith(
      expect.stringContaining('agent_main(Topic)'),
      expect.objectContaining({
        audit: true,
        model: 'compile-model',
        provider: 'openai',
      }),
    );
    expect(result.analysis.auditorReport).toContain('No critical issues found');
  });
});
