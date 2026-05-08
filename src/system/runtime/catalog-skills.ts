import * as fs from 'fs/promises';
import * as path from 'path';
import { listCommands } from '../../cli/commands.js';
import { getToolsDir, type Config, type ResolvedModelConfig } from '../../cli/config.js';
import { buildDmlParams } from './dml-params.js';
import { verifyRuntimeToolsAvailable } from './runtime-tools.js';

export const DEFAULT_MAX_SKILL_DEPTH = 3;

interface SkillMetaParameter {
  name: string;
  position: number;
}

interface SkillMetaFile {
  parameters?: SkillMetaParameter[];
  tools?: string[];
}

export interface LocalSkillCatalogEntry {
  slug: string;
  description: string;
  parameters?: unknown[];
  tools?: string[];
  compiled_at?: string;
  model?: string;
}

export interface ExecuteNestedSkillRequest {
  slug: string;
  dmlCode: string;
  args: string[];
  params: Record<string, unknown>;
  currentSkillSlug: string;
  invocationStack: string[];
}

export interface ExecuteNestedSkillResult {
  output: string[];
  answer?: string;
  error?: string;
  trace?: object;
}

export interface LocalSkillCatalogRuntime {
  listSkills(): Promise<LocalSkillCatalogEntry[]>;
  runSkill(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface LocalSkillCatalogRuntimeOptions {
  workspaceRoot: string;
  workspacePath: string;
  config: Config;
  selection: ResolvedModelConfig;
  currentSkillSlug?: string;
  invocationStack?: string[];
  maxDepth?: number;
  includeSystemSkillsInList?: boolean;
  executeNestedSkill(request: ExecuteNestedSkillRequest): Promise<ExecuteNestedSkillResult>;
}

export async function listLocalSkillCatalog(
  workspaceRoot: string,
  options: {
    detailed?: boolean;
    includeSystemSkills?: boolean;
  } = {},
): Promise<LocalSkillCatalogEntry[]> {
  const commands = await listCommands(workspaceRoot, { detailed: options.detailed ?? true });
  return commands
    .filter((command) => options.includeSystemSkills || !isSystemSkillSlug(command.name))
    .map((command) => ({
      slug: command.name,
      description: command.description,
      parameters: command.parameters,
      tools: command.tools,
      compiled_at: command.compiledAt,
      model: command.model,
    }));
}

export function createLocalSkillCatalogRuntime(
  options: LocalSkillCatalogRuntimeOptions,
): LocalSkillCatalogRuntime {
  const stack = getInvocationStack(options.currentSkillSlug, options.invocationStack);

  return {
    listSkills: () => listLocalSkillCatalog(options.workspaceRoot, {
      detailed: true,
      includeSystemSkills: options.includeSystemSkillsInList ?? false,
    }),

    runSkill: async (args) => {
      const slug = String(args.slug ?? '').trim();
      if (!slug) {
        throw new Error('slug is required');
      }

      if (isSystemSkillSlug(slug)) {
        throw new Error(`run_skill cannot invoke system skill "${slug}"`);
      }

      if (stack.includes(slug)) {
        throw new Error(`run_skill cannot create a cycle: ${[...stack, slug].join(' -> ')}`);
      }

      const maxDepth = options.maxDepth ?? DEFAULT_MAX_SKILL_DEPTH;
      if (stack.length >= maxDepth) {
        throw new Error(`run_skill exceeded maximum depth of ${maxDepth}`);
      }

      const childArgs = normalizeStringArray(args.args);
      const { dmlCode, meta } = await loadSkillProgram(options.workspaceRoot, slug);
      const toolCheck = verifyRuntimeToolsAvailable(options.config, meta?.tools ?? []);
      if (!toolCheck.available) {
        throw new Error(`Missing required tools for skill "${slug}": ${toolCheck.missing.join(', ')}`);
      }

      const result = await options.executeNestedSkill({
        slug,
        dmlCode,
        args: childArgs,
        params: buildDmlParams(childArgs, undefined, meta),
        currentSkillSlug: slug,
        invocationStack: [...stack, slug],
      });

      return {
        success: !result.error,
        slug,
        answer: result.answer,
        output: result.output,
        error: result.error,
      };
    },
  };
}

function getInvocationStack(currentSkillSlug?: string, invocationStack?: string[]): string[] {
  if (invocationStack && invocationStack.length > 0) {
    return [...invocationStack];
  }
  return currentSkillSlug ? [currentSkillSlug] : [];
}

function isSystemSkillSlug(slug: string): boolean {
  return slug.startsWith('_');
}

function normalizeStringArray(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return [String(value)];
}

async function loadSkillProgram(
  workspaceRoot: string,
  slug: string,
): Promise<{ dmlCode: string; meta: SkillMetaFile | null }> {
  const toolsDir = getToolsDir(workspaceRoot);
  const dmlPath = path.join(toolsDir, `${slug}.dml`);
  const metaPath = path.join(toolsDir, `${slug}.meta.json`);

  let dmlCode: string;
  try {
    dmlCode = await fs.readFile(dmlPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Skill "${slug}" not found in the local catalog`);
    }
    throw error;
  }

  let meta: SkillMetaFile | null = null;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as SkillMetaFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return { dmlCode, meta };
}