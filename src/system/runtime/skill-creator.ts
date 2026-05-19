import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createDeepClause } from '../../sdk.js';
import type { AnalysisResult, DMLEvent, DeepClauseSDK } from '../../types.js';
import { analyzeAndAuditDML, analyzeDML, extractDescription, extractParameters, validateWithProlog } from '../../compiler.js';
import { newsSearch, webSearch } from '../../cli/search.js';
import type { Config } from '../../cli/config.js';
import { resolveCompactionConfig } from '../../cli/config.js';
import type { MetaFile } from '../../cli/compile.js';
import type { ResolvedModelConfig } from '../config/model-slots.js';
import { readSystemPromptAsset, readSystemSkillAsset } from '../assets/index.js';
import { listLocalSkillCatalog } from './catalog-skills.js';
import { withCapturedConsole } from './console-capture.js';
import { executeDml } from './dml-executor.js';
import { truncateUrlFetchTextBody } from './runtime-tools.js';
import { createShellManager, type ShellManager } from './shell-manager.js';
import { createShellToolEventBridge } from './shell-tool-events.js';
import { recordTokenUsage, type TokenUsageByModel } from './token-usage.js';

interface PublishResult {
  dml: string;
  meta: MetaFile;
  outputPath: string;
  slug: string;
}

export interface SkillCreatorCompileOptions {
  sourcePath: string;
  outputDir: string;
  baseName: string;
  workspaceRoot?: string;
  workspacePath: string;
  config: Config;
  compileSelection: ResolvedModelConfig;
  runSelection: ResolvedModelConfig;
  sandbox?: boolean;
  validateOnly?: boolean;
  maxAttempts?: number;
  verbose?: boolean;
  stream?: boolean;
  trace?: boolean;
  audit?: boolean;
  onUserInput?: (prompt: string) => Promise<string>;
  signal?: AbortSignal;
  onEvent?: (event: DMLEvent) => void;
}

export interface SkillCreatorCompileResult {
  dml: string;
  meta: MetaFile;
  tools: string[];
  outputPath: string;
  explanation: string;
  analysis: AnalysisResult;
  usageByModel: TokenUsageByModel;
}

const CREATOR_TOOL_CATALOG = [
  { name: 'list_skills', description: 'List reusable local CLI skills that the new skill could compose.' },
  { name: 'web_search', description: 'Search the web for information.' },
  { name: 'news_search', description: 'Search recent news articles.' },
  { name: 'url_fetch', description: 'Fetch a URL and return its content.' },
  { name: 'bash', description: 'Run shell commands in the active workspace shell.' },
  { name: 'write_file', description: 'Write files inside the workspace.' },
  { name: 'validate_dml', description: 'Validate DML code from a file path.' },
  { name: 'test_dml', description: 'Execute a DML file with test arguments.' },
  { name: 'deploy_skill', description: 'Publish the generated skill into the local CLI catalog.' },
  { name: 'ask_user', description: 'Ask the user for clarification when needed.' },
];

export async function compileWithSkillCreator(
  markdown: string,
  options: SkillCreatorCompileOptions,
): Promise<SkillCreatorCompileResult> {
  if (options.onEvent) {
    return withCapturedConsole(
      (entry) => options.onEvent?.({
        type: 'log',
        content: `[${entry.level}] ${entry.text}`,
      }),
      () => compileWithSkillCreatorInternal(markdown, options),
    );
  }

  return compileWithSkillCreatorInternal(markdown, options);
}

async function compileWithSkillCreatorInternal(
  markdown: string,
  options: SkillCreatorCompileOptions,
): Promise<SkillCreatorCompileResult> {
  const workspacePath = path.resolve(options.workspacePath);
  await fs.mkdir(workspacePath, { recursive: true });

  const outputDir = path.resolve(options.outputDir);
  const shell = createShellManager({
    workspacePath,
    sandbox: options.sandbox,
    network: options.config.agentvm?.network ?? false,
    hostConfig: options.config.shell,
  });
  const sdk = await createDeepClause({
    model: options.compileSelection.model,
    provider: options.compileSelection.provider,
    apiKey: options.compileSelection.apiKey,
    baseUrl: options.compileSelection.baseUrl,
    temperature: options.compileSelection.temperature,
    debug: options.verbose,
    trace: !!options.trace,
    streaming: (options.stream ?? false) || !!options.onEvent,
    maxTokens: 65536,
    compaction: resolveCompactionConfig(options.config, path.resolve(options.workspaceRoot ?? workspacePath)),
  });

  let published: PublishResult | undefined;
  let finalAnswer = '';
  let runtimeError: string | undefined;
  const usageByModel: TokenUsageByModel = {};

  const emitEvent = (event: DMLEvent) => {
    options.onEvent?.(event);
    if (event.type === 'output' && options.verbose && !options.onEvent && event.content) {
      console.log(event.content);
    }
    if (event.type === 'tool_call' && options.verbose && !options.onEvent && event.toolName) {
      console.log(`  🔧 ${event.toolName}`);
    }
    if (event.type === 'usage') {
      recordTokenUsage(usageByModel, options.compileSelection.id, event.usage);
    }
    if (event.type === 'answer' && event.content) {
      finalAnswer = event.content;
    }
    if (event.type === 'error') {
      runtimeError = event.content ?? 'Unknown skill creator error';
    }
  };

  try {
    registerSkillCreatorTools(sdk, {
      markdown,
      outputDir,
      baseName: options.baseName,
      workspaceRoot: path.resolve(options.workspaceRoot ?? workspacePath),
      workspacePath,
      shell,
      config: options.config,
      compileSelection: options.compileSelection,
      runSelection: options.runSelection,
      validateOnly: options.validateOnly ?? false,
      onPublish: (result) => {
        published = result;
      },
      sandbox: options.sandbox,
      signal: options.signal,
      onEvent: emitEvent,
    });

    const skillCreatorDml = await readSystemSkillAsset('skill-creator', {
      workspaceRoot: options.workspaceRoot,
    });
    const systemPrompt = await buildSkillCreatorSystemPrompt(
      path.resolve(options.workspaceRoot ?? workspacePath),
      options.config,
      options.compileSelection,
      options.maxAttempts,
      options.sandbox ?? false,
    );
    const localMetadata = buildLocalMetadata(markdown, options.baseName);

    for await (const event of sdk.runDML(skillCreatorDml, {
      args: [markdown],
      params: {
        system_prompt: systemPrompt,
        auto_deploy: true,
        deployment_metadata_json: JSON.stringify(localMetadata),
      },
      workspacePath,
      gasLimit: Math.max(240, (options.maxAttempts ?? 3) * 160),
      onUserInput: options.onUserInput,
      signal: options.signal,
    })) {
      emitEvent(event);
    }

    if (runtimeError) {
      throw new Error(runtimeError);
    }

    const publishResult = published;
    if (!publishResult) {
      throw new Error(finalAnswer || 'Skill creator finished without producing a published artifact');
    }

    const analysis = await analyzeAndAuditDML(publishResult.dml, {
      audit: options.audit,
      model: options.compileSelection.model,
      provider: options.compileSelection.provider,
      baseUrl: options.compileSelection.baseUrl,
    });

    return {
      dml: publishResult.dml,
      meta: publishResult.meta,
      tools: publishResult.meta.tools,
      outputPath: publishResult.outputPath,
      explanation: finalAnswer || 'Skill creator runtime compiled and published the skill.',
      analysis,
      usageByModel,
    };
  } finally {
    await sdk.dispose();
    await shell.dispose();
  }
}

function registerSkillCreatorTools(
  sdk: DeepClauseSDK,
  context: {
    markdown: string;
    outputDir: string;
    baseName: string;
    workspaceRoot: string;
    workspacePath: string;
    shell: ShellManager;
    config: Config;
    compileSelection: ResolvedModelConfig;
    runSelection: ResolvedModelConfig;
    validateOnly: boolean;
    onPublish: (result: PublishResult) => void;
    sandbox?: boolean;
    signal?: AbortSignal;
    onEvent?: (event: DMLEvent) => void;
  },
): void {
  sdk.registerTool('list_skills', {
    description: 'List reusable local CLI skills from the current workspace catalog.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => listLocalSkillCatalog(context.workspaceRoot, { detailed: true }),
  });

  sdk.registerTool('web_search', {
    description: 'Search the web for information.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        count: { type: 'number', description: 'Maximum result count.' },
      },
      required: ['query'],
    },
    execute: async (args) => webSearch({
      query: String(args.query ?? ''),
      count: typeof args.count === 'number' ? args.count : 10,
      signal: context.signal,
    }),
  });

  sdk.registerTool('news_search', {
    description: 'Search recent news.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        count: { type: 'number', description: 'Maximum result count.' },
      },
      required: ['query'],
    },
    execute: async (args) => newsSearch({
      query: String(args.query ?? ''),
      count: typeof args.count === 'number' ? args.count : 10,
      signal: context.signal,
    }),
  });

  sdk.registerTool('url_fetch', {
    description: 'Fetch a URL or save it to a workspace file.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to fetch.' },
        save_to: { type: 'string', description: 'Optional file path inside the workspace.' },
      },
      required: ['url'],
    },
    execute: async (args) => urlFetch(context.workspacePath, args, context.signal),
  });

  sdk.registerTool('bash', {
    description: 'Run a shell command in the active workspace shell.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
      },
      required: ['command'],
    },
    execute: async (args) => {
      const command = String(args.command ?? '');
      return context.shell.exec(
        command,
        context.signal,
        createShellToolEventBridge({
          toolName: 'bash',
          toolArgs: { command },
          emit: context.onEvent,
        }),
      );
    },
  });

  sdk.registerTool('write_file', {
    description: 'Write or overwrite a file inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
    execute: async (args) => writeWorkspaceFile(context.workspacePath, args),
  });

  sdk.registerTool('validate_dml', {
    description: 'Validate DML code from a file path.',
    parameters: {
      type: 'object',
      properties: {
        dml_file: { type: 'string', description: 'Path to a .dml file inside the workspace.' },
      },
      required: ['dml_file'],
    },
    execute: async (args) => validateWorkspaceDml(context.workspacePath, args),
  });

  sdk.registerTool('test_dml', {
    description: 'Run a DML file with test arguments.',
    parameters: {
      type: 'object',
      properties: {
        dml_file: { type: 'string', description: 'Path to the DML file to test.' },
        test_input: { type: 'string', description: 'Single test input string.' },
        test_args: { type: 'string', description: 'JSON array of string arguments.' },
      },
      required: ['dml_file'],
    },
    execute: async (args) => runLocalTestDml(context, args),
  });

  sdk.registerTool('deploy_skill', {
    description: 'Publish the generated DML into the local CLI skill catalog.',
    parameters: {
      type: 'object',
      properties: {
        dml_file: { type: 'string', description: 'Path to the DML file to publish.' },
        spec_markdown: { type: 'string', description: 'Original specification markdown.' },
        metadata_json: { type: 'string', description: 'JSON metadata with slug, name, description, trigger_phrases.' },
        slug_override: { type: 'string', description: 'Optional slug override.' },
      },
      required: ['dml_file', 'spec_markdown', 'metadata_json'],
    },
    execute: async (args) => {
      const published = await publishSkill(context, args);
      context.onPublish(published);
      return {
        ok: true,
        slug: published.slug,
        version: published.meta.history.length,
      };
    },
  });
}

async function buildSkillCreatorSystemPrompt(
  workspaceRoot: string,
  config: Config,
  compileSelection: ResolvedModelConfig,
  maxAttempts?: number,
  sandbox = false,
): Promise<string> {
  const promptTemplate = await readSystemPromptAsset('skill-creator', { workspaceRoot });
  const toolsTable = [
    '| Tool | Description |',
    '|------|-------------|',
    ...CREATOR_TOOL_CATALOG.map((tool) => `| \`${tool.name}\` | ${tool.description} |`),
  ].join('\n');

  const llmAccessSection = [
    '## LLM Access from Scripts',
    '',
    'The local CLI runtime does not provide an extra proxy-only script API.',
    'Use DML task()/prompt() when the skill needs open-ended LLM reasoning or text generation. Deterministic or simple skills can be pure Prolog plus exec()/consult() with no task() at all.',
    `The compile slot currently resolves to \`${compileSelection.id}\`.`,
  ].join('\n');

  const runtimeSection = sandbox
    ? [
        '## Runtime Shell',
        '- Shell commands run inside AgentVM because `--sandbox` is enabled.',
        `- AgentVM network access is ${config.agentvm?.network ? 'enabled' : 'disabled'}.`,
        '- Package installation and outbound network behavior follow that sandbox setting.',
        '- Web research still goes through web_search, news_search, and url_fetch.',
      ].join('\n')
    : [
        '## Runtime Shell',
        '- Shell commands run in the local workspace shell by default.',
        '- Package installation uses the local machine environment and permissions.',
        '- Web research still goes through web_search, news_search, and url_fetch.',
      ].join('\n');

  const attemptSection = maxAttempts
    ? `\n\n## Iteration Budget\nKeep validation and testing loops within roughly ${maxAttempts} repair attempts before failing clearly.`
    : '';

  return `${promptTemplate
    .replace('{TOOLS_TABLE}', toolsTable)
    .replace('{LLM_ACCESS_SECTION}', llmAccessSection)}

## Your Workflow
1. **Understand**: Read the specification carefully. If anything is unclear, use ask_user to ask for clarification.
2. **Research**: If the skill needs external APIs or domain knowledge, use search. If an existing local skill might already cover part of the task, call list_skills before re-implementing it.
3. **Plan**: Create a step-by-step plan for the DML program, including any local skill reuse.
4. **Prepare environment**: Use bash to install ALL packages the skill will need (pip install, apt-get install, npm install). Do this BEFORE writing any DML code. The skill itself must NOT install packages.
5. **Write**: Use write_file(path='my-skill.dml', content='...') to create or overwrite the DML file.
6. **Validate**: Use validate_dml(dml_file='my-skill.dml') and fix errors by rewriting the file.
7. **Test**: Use test_dml(dml_file='my-skill.dml', test_input='...') with a realistic test input and iterate until it works.
8. **Publish**: Use deploy_skill(dml_file='my-skill.dml', ...) exactly once when the DML is ready.

## File-Based DML Only
validate_dml, test_dml, and deploy_skill only accept file paths. Write the DML to disk first.

## Deterministic Skills
- It is fine for a skill to use no task()/prompt() when the workflow is mostly deterministic or simple.
- In those cases, prefer direct Prolog predicates, consult/use_module, and exec() calls.
- Add task()/prompt() only when the skill needs open-ended reasoning, extraction, summarization, classification, or free-form text generation.

## Reusing Existing Skills
- Call list_skills when the requested functionality overlaps with an existing local skill.
- Prefer narrow wrapper tool predicates that internally call exec(run_skill(...)) for one specific child skill.
- Do NOT expose a generic tool(run_skill(...)) predicate unless the user explicitly asked for a router or orchestration skill.

${runtimeSection}${attemptSection}`;
}

const SKILL_NAME_PATTERNS = [
  /(?:called|named)\s+["']?([A-Za-z0-9][A-Za-z0-9 _-]{1,79})["']?/i,
  /(?:create|build|make|write|generate|implement)(?:\s+me)?\s+(?:a|an|the)?\s*["']?([A-Za-z0-9][A-Za-z0-9 _-]{1,79}?)(?:["']?\s+skill\b|["']?$)/i,
  /(?:create|build|make|write|generate|implement)(?:\s+me)?\s+(?:a|an|the)?\s+skill\s+(?:to|for|that)\s+["']?([A-Za-z0-9][A-Za-z0-9 _-]{1,79})["']?/i,
];

function cleanSkillLabel(value: string): string {
  return value
    .trim()
    .replace(/[`"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findSkillNameCandidate(source: string): string | null {
  const heading = source.match(/^#\s+(.+)$/m)?.[1];
  if (heading) {
    const cleaned = cleanSkillLabel(heading);
    if (cleaned) {
      return cleaned;
    }
  }

  for (const pattern of SKILL_NAME_PATTERNS) {
    const match = pattern.exec(source);
    if (!match?.[1]) {
      continue;
    }
    const cleaned = cleanSkillLabel(match[1]);
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

function shortenSlug(slug: string, maxLength = 40): string {
  if (slug.length <= maxLength) {
    return slug;
  }

  const boundary = slug.lastIndexOf('-', maxLength);
  if (boundary >= Math.floor(maxLength / 2)) {
    return slug.slice(0, boundary);
  }

  return slug.slice(0, maxLength).replace(/-+$/g, '');
}

export function normalizeSkillSlug(value: string, fallback = 'skill'): string {
  const slug = shortenSlug(value
    .trim()
    .replace(/[`"']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-'));

  if (slug) {
    return slug;
  }

  const fallbackSlug = fallback
    .trim()
    .replace(/[`"']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');

  return fallbackSlug || 'skill';
}

function formatSkillName(value: string): string {
  return cleanSkillLabel(value)
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function deriveSkillSlugFromMarkdown(markdown: string, fallbackBaseName = 'skill'): string {
  const fallbackSlug = normalizeSkillSlug(fallbackBaseName, 'skill');
  const directCandidate = findSkillNameCandidate(markdown);
  if (directCandidate) {
    return normalizeSkillSlug(directCandidate, fallbackSlug);
  }

  const fallbackCandidate = findSkillNameCandidate(fallbackBaseName.replace(/[-_]+/g, ' '));
  if (fallbackCandidate) {
    return normalizeSkillSlug(fallbackCandidate, fallbackSlug);
  }

  return fallbackSlug;
}

function buildLocalMetadata(markdown: string, baseName: string): {
  slug: string;
  name: string;
  description: string;
  trigger_phrases: string[];
} {
  const slug = deriveSkillSlugFromMarkdown(markdown, baseName);
  const nameCandidate = findSkillNameCandidate(markdown)
    ?? findSkillNameCandidate(baseName.replace(/[-_]+/g, ' '))
    ?? slug;
  const name = formatSkillName(nameCandidate) || formatSkillName(slug);

  const description = extractDescription(markdown);
  const triggerPhraseBase = name.replace(/\s+/g, ' ').trim().toLowerCase() || slug.replace(/[-_]+/g, ' ');
  const triggerPhrases = Array.from(new Set([
    triggerPhraseBase,
    `run ${triggerPhraseBase}`,
    `use ${triggerPhraseBase}`,
  ])).slice(0, 3);

  return {
    slug,
    name: name || formatSkillName(slug),
    description,
    trigger_phrases: triggerPhrases,
  };
}

interface ParameterDoc {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

function normalizeParameterName(name: string): string {
  return name
    .trim()
    .replace(/[`"']/g, '')
    .replace(/([A-Z])/g, (_m, c, i) => (i > 0 ? '_' : '') + c.toLowerCase())
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function extractParameterDocs(markdown: string): ParameterDoc[] {
  const parameterDocs: ParameterDoc[] = [];
  const lines = markdown.split('\n');
  let inParametersSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inParametersSection) {
      if (/^##\s+Parameters\b/i.test(trimmed)) {
        inParametersSection = true;
      }
      continue;
    }

    if (/^##\s+/.test(trimmed)) {
      break;
    }

    const match = /^-\s+`?([^`:(]+)`?\s*(?:\(([^)]*)\))?\s*:\s*(.+)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, rawName, qualifiers = '', description] = match;
    const defaultMatch = /default\s*:\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/i.exec(qualifiers);
    const qualifierText = qualifiers.toLowerCase();

    parameterDocs.push({
      name: normalizeParameterName(rawName),
      description: description.trim(),
      required: qualifierText.includes('required')
        ? true
        : (qualifierText.includes('optional') || !!defaultMatch ? false : undefined),
      default: defaultMatch
        ? (defaultMatch[1] ?? defaultMatch[2] ?? defaultMatch[3]).trim()
        : undefined,
    });
  }

  return parameterDocs;
}

function mergeParameterDocs(
  parameters: MetaFile['parameters'],
  parameterDocs: ParameterDoc[],
): MetaFile['parameters'] {
  const docsByName = new Map(parameterDocs.map((parameterDoc) => [parameterDoc.name, parameterDoc]));

  return parameters.map((parameter) => {
    const parameterDoc = docsByName.get(parameter.name);
    if (!parameterDoc) {
      return parameter;
    }

    return {
      ...parameter,
      description: parameterDoc.description ?? parameter.description,
      required: parameterDoc.required ?? parameter.required,
      default: parameterDoc.default ?? parameter.default,
    };
  });
}

function extractSkillCapabilities(analysis: AnalysisResult): string[] {
  return Array.from(new Set(
    analysis.capabilities.filter((capability) => !capability.startsWith('tool_use(')),
  ));
}

function readMetadataName(metadata: Record<string, unknown>, fallbackName: string): string {
  const name = metadata['name'];
  return typeof name === 'string' && name.trim() ? name.trim() : fallbackName;
}

function readMetadataTriggerPhrases(metadata: Record<string, unknown>, fallbackTriggerPhrases: string[]): string[] {
  const rawTriggerPhrases = Array.isArray(metadata['trigger_phrases'])
    ? metadata['trigger_phrases']
    : (Array.isArray(metadata['triggerPhrases']) ? metadata['triggerPhrases'] : fallbackTriggerPhrases);

  return Array.from(new Set(rawTriggerPhrases
    .filter((triggerPhrase) => typeof triggerPhrase === 'string')
    .map((triggerPhrase) => triggerPhrase.trim())
    .filter((triggerPhrase) => triggerPhrase.length > 0)))
    .slice(0, 5);
}

async function writeWorkspaceFile(
  workspacePath: string,
  args: Record<string, unknown>,
): Promise<{ success: boolean; path?: string; bytes?: number; error?: string }> {
  const relPath = String(args.path ?? '');
  const content = String(args.content ?? '');
  if (!relPath) {
    return { success: false, error: 'path is required' };
  }

  const filePath = resolveWorkspacePath(workspacePath, relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return { success: true, path: relPath, bytes: content.length };
}

async function validateWorkspaceDml(
  workspacePath: string,
  args: Record<string, unknown>,
): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
  const dmlPath = resolveWorkspacePath(workspacePath, String(args.dml_file ?? ''));
  const dml = await fs.readFile(dmlPath, 'utf8');
  const result = await validateWithProlog(dml);
  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings ?? [],
  };
}

async function runLocalTestDml(
  context: {
    workspaceRoot: string;
    workspacePath: string;
    config: Config;
    compileSelection: ResolvedModelConfig;
    runSelection: ResolvedModelConfig;
    sandbox?: boolean;
    signal?: AbortSignal;
    onEvent?: (event: DMLEvent) => void;
  },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dmlPath = resolveWorkspacePath(context.workspacePath, String(args.dml_file ?? ''));
  const dmlCode = await fs.readFile(dmlPath, 'utf8');

  let testArgs: string[];
  if (typeof args.test_args === 'string' && args.test_args.trim()) {
    try {
      const parsed = JSON.parse(args.test_args);
      testArgs = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
    } catch {
      testArgs = [String(args.test_args)];
    }
  } else {
    testArgs = [String(args.test_input ?? 'test')];
  }

  const result = await executeDml({
    dmlCode,
    config: context.config,
    workspacePath: context.workspacePath,
    selection: context.runSelection,
    args: testArgs,
    gasLimit: 120,
    headless: true,
    stream: false,
    trace: true,
    sandbox: context.sandbox,
    signal: context.signal,
    onEvent: context.onEvent,
    onUserInput: async () => '(simulated test input - no interactive user during test_dml)',
    skillCatalog: {
      workspaceRoot: context.workspaceRoot,
    },
  });

  const toolCalls = result.events
    .filter((event) => event.type === 'tool_call')
    .map((event) => ({ tool: event.toolName ?? '?', args: event.toolArgs }));
  const trace = Array.isArray(result.trace) ? result.trace : undefined;

  return {
    success: !result.error && !!result.answer,
    status: result.error ? 'error' : (result.answer ? 'ok' : 'completed_no_answer'),
    answer: result.answer || undefined,
    outputs: result.output.length > 0 ? result.output : undefined,
    errors: result.error ? [result.error] : undefined,
    trace,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

async function publishSkill(
  context: {
    markdown: string;
    outputDir: string;
    baseName: string;
    compileSelection: ResolvedModelConfig;
    validateOnly: boolean;
    workspacePath: string;
  },
  args: Record<string, unknown>,
): Promise<PublishResult> {
  const dmlPath = resolveWorkspacePath(context.workspacePath, String(args.dml_file ?? ''));
  const dml = await fs.readFile(dmlPath, 'utf8');

  const fallbackMetadata = buildLocalMetadata(context.markdown, context.baseName);
  const normalized = normalizeDeployInputs(
    String(args.spec_markdown ?? context.markdown),
    String(args.metadata_json ?? ''),
  );
  const metadata = parseMetadataJson(normalized.metadataJson, fallbackMetadata);
  const requestedSlug = typeof args.slug_override === 'string' && args.slug_override.trim()
    ? args.slug_override
    : (typeof metadata.slug === 'string' && metadata.slug.trim() ? metadata.slug : fallbackMetadata.slug);
  const publishName = normalizeSkillSlug(requestedSlug, fallbackMetadata.slug);

  const meta = await buildMetaFile({
    dml,
    markdown: normalized.specMarkdown,
    outputDir: context.outputDir,
    publishName,
    model: context.compileSelection.model,
    provider: context.compileSelection.provider,
    name: readMetadataName(metadata, fallbackMetadata.name),
    triggerPhrases: readMetadataTriggerPhrases(metadata, fallbackMetadata.trigger_phrases),
    description: typeof metadata.description === 'string' ? metadata.description : extractDescription(normalized.specMarkdown),
  });

  const outputPath = path.join(context.outputDir, `${publishName}.dml`);

  if (!context.validateOnly) {
    await fs.mkdir(context.outputDir, { recursive: true });
    await fs.writeFile(outputPath, dml, 'utf8');
    await fs.writeFile(path.join(context.outputDir, `${publishName}.meta.json`), JSON.stringify(meta, null, 2) + '\n');
  }

  return {
    dml,
    meta,
    outputPath,
    slug: publishName,
  };
}

async function buildMetaFile(input: {
  dml: string;
  markdown: string;
  outputDir: string;
  publishName: string;
  model: string;
  provider: string;
  name: string;
  triggerPhrases: string[];
  description: string;
}): Promise<MetaFile> {
  const metaPath = path.join(input.outputDir, `${input.publishName}.meta.json`);
  const existing = await loadExistingMeta(metaPath);
  const sourceHash = computeHash(input.markdown);
  const history = existing?.history ?? [];
  const analysis = await analyzeDML(input.dml);
  const tools = extractToolNames(analysis);
  const parameters = mergeParameterDocs(extractParameters(input.dml), extractParameterDocs(input.markdown));
  const capabilities = extractSkillCapabilities(analysis);

  return {
    version: '1.0.0',
    source: input.publishName,
    sourceHash,
    compiledAt: new Date().toISOString(),
    model: input.model,
    provider: input.provider,
    name: input.name,
    triggerPhrases: input.triggerPhrases.length > 0 ? input.triggerPhrases : undefined,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    description: input.description,
    parameters,
    tools,
    history: [
      ...history,
      {
        version: history.length + 1,
        timestamp: new Date().toISOString(),
        sourceHash,
        model: input.model,
        provider: input.provider,
      },
    ],
  };
}

function extractToolNames(analysis: AnalysisResult): string[] {
  return Array.from(new Set(
    analysis.capabilities
      .filter((capability) => capability.startsWith('tool_use(') && capability.endsWith(')'))
      .map((capability) => capability.slice('tool_use('.length, -1)),
  )).sort();
}

async function urlFetch(
  workspacePath: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = String(args.url ?? '');
  if (!url) {
    throw new Error('url is required');
  }

  const response = await fetch(url, { signal });
  const headers = Object.fromEntries(response.headers.entries());

  if (typeof args.save_to === 'string' && args.save_to.trim()) {
    const targetPath = resolveWorkspacePath(workspacePath, args.save_to);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, buffer);
    return {
      file_path: targetPath,
      size: buffer.byteLength,
      status: response.status,
      headers,
    };
  }

  const body = await response.text();
  const truncated = truncateUrlFetchTextBody(body);

  return {
    body: truncated.body,
    truncated: truncated.truncated,
    original_length: truncated.originalLength,
    returned_length: truncated.returnedLength,
    status: response.status,
    headers,
  };
}

function resolveWorkspacePath(workspacePath: string, filePath: string): string {
  if (!filePath) {
    throw new Error('Path is required');
  }
  const resolved = path.resolve(workspacePath, filePath);
  if (!resolved.startsWith(path.resolve(workspacePath))) {
    throw new Error(`Path must stay inside workspace: ${filePath}`);
  }
  return resolved;
}

function normalizeDeployInputs(specMarkdown: string, metadataJson: string): { specMarkdown: string; metadataJson: string } {
  if (looksLikeJsonObject(specMarkdown) && !looksLikeJsonObject(metadataJson)) {
    return {
      specMarkdown: metadataJson,
      metadataJson: specMarkdown,
    };
  }
  return { specMarkdown, metadataJson };
}

function looksLikeJsonObject(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}');
}

function parseMetadataJson(
  metadataJson: string,
  fallback: { slug: string; name: string; description: string; trigger_phrases: string[] },
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : fallback;
  } catch {
    return fallback;
  }
}

function computeHash(content: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

async function loadExistingMeta(metaPath: string): Promise<MetaFile | null> {
  try {
    const content = await fs.readFile(metaPath, 'utf8');
    return JSON.parse(content) as MetaFile;
  } catch {
    return null;
  }
}