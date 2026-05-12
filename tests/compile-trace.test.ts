import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mockCompileWithSkillCreator = vi.fn();

vi.mock('../src/system/runtime/skill-creator.js', () => ({
  compileWithSkillCreator: mockCompileWithSkillCreator,
}));

describe('Compile Trace Saving', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `deepclause-compile-trace-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    await mkdir(join(tempDir, '.deepclause'), { recursive: true });
    await mkdir(join(tempDir, 'workspace'), { recursive: true });
    await mkdir(join(tempDir, 'tools'), { recursive: true });

    await writeFile(
      join(tempDir, '.deepclause', 'config.json'),
      JSON.stringify({
        model: 'gpt-4o',
        provider: 'openai',
        workspace: './workspace',
      }),
    );

    await writeFile(
      join(tempDir, 'minimal.md'),
      '# Minimal\n\nSummarize a topic.\n',
    );
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
    vi.clearAllMocks();
  });

  it('should capture output events and save trace when requested', async () => {
    const mockTrace = [{ timestamp: 123, type: 'call', predicate: 'agent_main' }];

    mockCompileWithSkillCreator.mockImplementation(async (_markdown, options) => {
      options.onEvent?.({ type: 'output', content: 'Phase 1/4: Understanding requirements...' });
      options.onEvent?.({ type: 'finished', trace: mockTrace });
      return {
        dml: 'agent_main(Topic) :- answer(Topic).',
        meta: {
          version: '1.0.0',
          source: 'minimal.md',
          sourceHash: 'sha256:test',
          compiledAt: new Date().toISOString(),
          model: 'gpt-4o',
          provider: 'openai',
          description: 'Minimal compile test',
          parameters: [{ name: 'topic', position: 1 }],
          tools: [],
          history: [],
        },
        tools: [],
        outputPath: join(tempDir, 'tools', 'minimal.dml'),
        explanation: 'Compiled successfully.',
        analysis: {
          valid: true,
          warnings: [],
          capabilities: [],
        },
        usageByModel: {},
      };
    });

    const { compile } = await import('../src/cli/compile.js');
    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const tracePath = join(tempDir, 'compile-trace.json');
      const result = await compile(join(tempDir, 'minimal.md'), join(tempDir, 'tools'), {
        headless: true,
        trace: tracePath,
      });

      expect(result.runtimeOutput).toEqual(['Phase 1/4: Understanding requirements...']);
      expect(result.trace).toEqual(mockTrace);

      const traceContent = await readFile(tracePath, 'utf-8');
      expect(JSON.parse(traceContent)).toEqual(mockTrace);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should forward audit and provider overrides to compile helpers', async () => {
    mockCompileWithSkillCreator.mockResolvedValue({
      dml: 'agent_main(Topic) :- answer(Topic).',
      meta: {
        version: '1.0.0',
        source: 'minimal.md',
        sourceHash: 'sha256:test',
        compiledAt: new Date().toISOString(),
        model: 'claude-sonnet',
        provider: 'anthropic',
        description: 'Minimal compile test',
        parameters: [{ name: 'topic', position: 1 }],
        tools: [],
        history: [],
      },
      tools: [],
      outputPath: join(tempDir, 'tools', 'minimal.dml'),
      explanation: 'Compiled successfully.',
      analysis: {
        valid: true,
        warnings: [],
        capabilities: [],
        auditorReport: 'Audit OK',
      },
      usageByModel: {},
    });

    const { compile, compilePrompt } = await import('../src/cli/compile.js');
    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      await compile(join(tempDir, 'minimal.md'), join(tempDir, 'tools'), {
        audit: false,
        model: 'claude-sonnet',
        provider: 'anthropic',
      });

      expect(mockCompileWithSkillCreator).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          audit: false,
          compileSelection: expect.objectContaining({
            provider: 'anthropic',
          }),
        }),
      );

      mockCompileWithSkillCreator.mockClear();

      await compilePrompt('Summarize the topic.', {
        audit: false,
        model: 'claude-sonnet',
        provider: 'anthropic',
      });

      expect(mockCompileWithSkillCreator).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          audit: false,
          compileSelection: expect.objectContaining({
            provider: 'anthropic',
          }),
        }),
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});