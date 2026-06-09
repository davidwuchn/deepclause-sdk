import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { listCommands } from '../../cli/commands.js';
import {
  ensureWorkspaceDocSeeds,
  getDocsDir,
  getConfigDir,
  getToolsDir,
  loadConfig,
  resolveCompactionConfig,
  resolveModelSlot,
  type Config,
} from '../../cli/config.js';
import { promptUser } from '../../cli/interactive.js';
import type { DMLEvent, DeepClauseSDK, MemoryMessage } from '../../types.js';
import { createDeepClause } from '../../sdk.js';
import {
  resolveCompactorModelConfig,
  executeCompactor,
  getCompactionBindings,
  resolveCompactionOptions,
  type CompactorExecutionRequest,
  type CompactorExecutionResponse,
} from '../../compaction.js';
import {
  getWorkspaceRecipeAssetsDir,
  readSystemPromptAsset,
  readSystemSkillAsset,
} from '../assets/index.js';
import { listRecipeCatalog, searchRecipeCatalog } from './catalog-recipes.js';
import { executeDml, type DmlExecutionContext } from './dml-executor.js';
import { compileWithSkillCreator, deriveSkillSlugFromMarkdown } from './skill-creator.js';
import {
  isTokenUsageEmpty,
  mergeTokenUsageMaps,
  recordTokenUsage,
  type TokenUsageByModel,
} from './token-usage.js';

const DEFAULT_SESSION_TITLE_PREFIX = 'Session';

interface SessionMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface SessionPaths {
  dir: string;
  metadataPath: string;
  messagesPath: string;
  assistantMemoryPath: string;
  taskMemoryPath: string;
  usagePath: string;
  executionLogPath: string;
}

interface LoadedSession {
  metadata: SessionMetadata;
  paths: SessionPaths;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  assistantMemory: string;
  taskMemory: string;
}

export interface ConductorSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConductorSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ConductorSessionDetail extends ConductorSessionSummary {
  messages: ConductorSessionMessage[];
  assistantMemory: string;
  taskMemory: string;
  usageByModel?: TokenUsageByModel;
  executionLogPath: string;
}

export interface ConductorTurnOptions {
  sessionId?: string;
  sessionTitle?: string;
  workspaceRoot?: string;
  workspacePath?: string;
  config?: Config;
  verbose?: boolean;
  trace?: boolean;
  gasLimit?: number;
  stream?: boolean;
  headless?: boolean;
  sandbox?: boolean;
  signal?: AbortSignal;
  toolAbortSignalRef?: { signal?: AbortSignal };
  onUserInput?: (prompt: string) => Promise<string>;
  onEvent?: (event: ConductorLogEvent) => void;
}

export interface ConductorTurnResult {
  sessionId: string;
  output: string[];
  answer?: string;
  error?: string;
  trace?: object;
}

export interface ConductorLogEvent {
  scope: 'main' | 'child';
  childSlug?: string;
  modelId?: string;
  event: DMLEvent;
}

export type SessionExecutionKind = 'conductor' | 'skill' | 'skill-creator';

interface SessionExecutionStartRecord {
  timestamp: string;
  sessionId: string;
  executionId: string;
  entryType: 'execution_started';
  executionKind: SessionExecutionKind;
  inputText: string;
  skillName?: string;
  args?: unknown[];
  modelId?: string;
}

interface SessionExecutionEventRecord {
  timestamp: string;
  sessionId: string;
  executionId: string;
  entryType: 'event';
  executionKind: SessionExecutionKind;
  scope: ConductorLogEvent['scope'];
  childSlug?: string;
  modelId?: string;
  event: DMLEvent;
}

interface SessionExecutionFinishedRecord {
  timestamp: string;
  sessionId: string;
  executionId: string;
  entryType: 'execution_finished';
  executionKind: SessionExecutionKind;
  status: 'success' | 'error';
  answer?: string;
  error?: string;
  outputCount?: number;
  usageByModel?: TokenUsageByModel;
}

type SessionExecutionLogRecord =
  | SessionExecutionStartRecord
  | SessionExecutionEventRecord
  | SessionExecutionFinishedRecord;

export interface SessionExecutionLogWriter {
  readonly executionId: string;
  readonly logPath: string;
  recordEvent(event: ConductorLogEvent): void;
  finish(summary: {
    status: 'success' | 'error';
    answer?: string;
    error?: string;
    outputCount?: number;
    usageByModel?: TokenUsageByModel;
  }): Promise<void>;
  flush(): Promise<void>;
}

export async function listConductorSessions(workspaceRoot = process.cwd()): Promise<ConductorSessionSummary[]> {
  const sessionsDir = getSessionsDir(workspaceRoot);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const sessions = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => readSessionMetadata(path.join(sessionsDir, entry.name))));

    return sessions
      .filter((session): session is SessionMetadata => session !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function createConductorSession(
  workspaceRoot = process.cwd(),
  title?: string,
): Promise<ConductorSessionSummary> {
  const now = new Date().toISOString();
  const metadata: SessionMetadata = {
    id: randomUUID(),
    title: title?.trim() || `${DEFAULT_SESSION_TITLE_PREFIX} ${now.slice(0, 16).replace('T', ' ')}`,
    createdAt: now,
    updatedAt: now,
  };

  const paths = getSessionPaths(workspaceRoot, metadata.id);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  await fs.writeFile(paths.messagesPath, '', 'utf8');
  await fs.writeFile(paths.assistantMemoryPath, '', 'utf8');
  await fs.writeFile(paths.taskMemoryPath, '', 'utf8');
  await fs.writeFile(paths.usagePath, '{}\n', 'utf8');
  await fs.writeFile(paths.executionLogPath, '', 'utf8');
  return metadata;
}

export async function getConductorSessionDetail(
  workspaceRoot = process.cwd(),
  sessionId: string,
): Promise<ConductorSessionDetail> {
  const paths = getSessionPaths(workspaceRoot, sessionId);
  const metadata = await readRequiredSessionMetadata(paths.dir);
  const messages = await readSessionMessages(paths.messagesPath);
  const assistantMemory = await readOptionalText(paths.assistantMemoryPath);
  const taskMemory = await readOptionalText(paths.taskMemoryPath);
  const usageByModel = await readSessionUsage(paths.usagePath);

  return {
    ...metadata,
    messages,
    assistantMemory,
    taskMemory,
    usageByModel,
    executionLogPath: paths.executionLogPath,
  };
}

export async function appendConductorSessionMessages(
  workspaceRoot = process.cwd(),
  sessionId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const paths = getSessionPaths(workspaceRoot, sessionId);
  await readRequiredSessionMetadata(paths.dir);

  let appended = false;
  for (const message of messages) {
    if ((message.role !== 'user' && message.role !== 'assistant') || !message.content.trim()) {
      continue;
    }

    await appendSessionMessage(paths.messagesPath, {
      role: message.role,
      content: message.content,
      timestamp: new Date().toISOString(),
    });
    appended = true;
  }

  if (appended) {
    await touchSession(workspaceRoot, sessionId);
  }
}

export async function runConductorTurn(
  userMessage: string,
  options: ConductorTurnOptions = {},
): Promise<ConductorTurnResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const config = options.config ?? await loadConfig(workspaceRoot);
  await ensureWorkspaceDocSeeds(workspaceRoot);
  const workspacePath = path.resolve(options.workspacePath ?? config.workspace ?? './workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const session = await loadOrCreateSession(workspaceRoot, options.sessionId, options.sessionTitle);
  const gatewaySelection = resolveModelSlot(config, 'gateway');
  const compileSelection = resolveModelSlot(config, 'compile');
  const runSelection = resolveModelSlot(config, 'run');
  const systemPrompt = await buildConductorSystemPrompt({
    workspaceRoot,
    workspacePath,
    session,
    gatewayModelId: gatewaySelection.id,
    compileModelId: compileSelection.id,
    runModelId: runSelection.id,
  });
  const conductorDml = await readSystemSkillAsset('conductor', { workspaceRoot });
  const onUserInput = options.onUserInput ?? promptUser;
  const usageByModel: TokenUsageByModel = {};
  const executionLog = createSessionExecutionLogWriter({
    workspaceRoot,
    sessionId: session.metadata.id,
    executionKind: 'conductor',
    inputText: userMessage,
    modelId: gatewaySelection.id,
  });
  const emitLogEvent = (event: ConductorLogEvent): void => {
    if (event.event.type === 'usage') {
      recordTokenUsage(usageByModel, event.modelId, event.event.usage);
    }
    executionLog.recordEvent(event);
    options.onEvent?.(event);
  };

  const compactedSessionMessages = await maybeCompactSessionMessages({
    config,
    workspaceRoot,
    workspacePath,
    selection: gatewaySelection,
    signal: options.signal,
    verbose: options.verbose,
    messagesPath: session.paths.messagesPath,
    messages: session.messages,
    onCompactionEvent: (event) => emitLogEvent({ scope: 'main', modelId: gatewaySelection.id, event }),
  });

  let result;
  try {
    result = await executeDml({
      dmlCode: conductorDml,
      config,
      workspaceRoot,
      workspacePath,
      selection: gatewaySelection,
      args: [userMessage],
      params: {
        system_prompt: systemPrompt,
      },
      gasLimit: options.gasLimit ?? 320,
      verbose: options.verbose,
      headless: options.headless ?? true,
      stream: options.stream ?? false,
      trace: options.trace,
      sandbox: options.sandbox,
      signal: options.signal,
      toolAbortSignalRef: options.toolAbortSignalRef,
      onUserInput,
      initialMessages: compactedSessionMessages,
      skillCatalog: {
        workspaceRoot,
        currentSkillSlug: '_conductor',
        onChildEvent: (childSlug, event) => emitLogEvent({
          scope: 'child',
          childSlug,
          modelId: gatewaySelection.id,
          event,
        }),
      },
      onEvent: (event) => emitLogEvent({ scope: 'main', modelId: gatewaySelection.id, event }),
      registerAdditionalTools: async (sdk, context) => registerConductorTools(sdk, context, {
        workspaceRoot,
        workspacePath,
        session,
        config,
        compileSelection,
        runSelection,
        stream: options.stream ?? false,
        verbose: options.verbose,
        sandbox: options.sandbox ?? false,
        signal: options.signal,
        onUserInput,
        onEvent: emitLogEvent,
      }),
    });
  } catch (error) {
    await executionLog.finish({
      status: 'error',
      error: (error as Error).message,
      usageByModel: isTokenUsageEmpty(usageByModel) ? undefined : usageByModel,
    });
    throw error;
  }

  await maybeUpdateSessionTitle(workspaceRoot, session.metadata, userMessage);
  await appendSessionMessage(session.paths.messagesPath, {
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
  });

  const assistantContent = result.answer ?? result.error;
  if (assistantContent) {
    await appendSessionMessage(session.paths.messagesPath, {
      role: 'assistant',
      content: assistantContent,
      timestamp: new Date().toISOString(),
    });
  }
  await mergeSessionUsage(workspaceRoot, session.metadata.id, usageByModel);
  await touchSession(workspaceRoot, session.metadata.id);
  await executionLog.finish({
    status: result.error ? 'error' : 'success',
    answer: result.answer,
    error: result.error,
    outputCount: result.output.length,
    usageByModel: isTokenUsageEmpty(usageByModel) ? undefined : usageByModel,
  });

  return {
    sessionId: session.metadata.id,
    output: result.output,
    answer: result.answer,
    error: result.error,
    trace: result.trace,
  };
}

async function registerConductorTools(
  sdk: DeepClauseSDK,
  _context: DmlExecutionContext,
  options: {
    workspaceRoot: string;
    workspacePath: string;
    session: LoadedSession;
    config: Config;
    compileSelection: ReturnType<typeof resolveModelSlot>;
    runSelection: ReturnType<typeof resolveModelSlot>;
    stream: boolean;
    verbose?: boolean;
    sandbox: boolean;
    signal?: AbortSignal;
    onUserInput: (prompt: string) => Promise<string>;
    onEvent?: (event: ConductorLogEvent) => void;
  },
): Promise<void> {
  sdk.registerTool('create_skill', {
    description: 'Create and publish a new local CLI skill into .deepclause/tools.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'Natural-language skill specification.' },
      },
      required: ['spec'],
    },
    execute: async (args) => createLocalSkill({
      spec: String(args.spec ?? ''),
      workspaceRoot: options.workspaceRoot,
      workspacePath: options.workspacePath,
      config: options.config,
      compileSelection: options.compileSelection,
      runSelection: options.runSelection,
      sessionId: options.session.metadata.id,
      verbose: options.verbose,
      sandbox: options.sandbox,
      signal: options.signal,
      onUserInput: options.onUserInput,
      onEvent: options.onEvent,
    }),
  });

  sdk.registerTool('update_memory', {
    description: 'Replace the current task memory markdown for this conductor session.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Complete updated task memory markdown.' },
      },
      required: ['content'],
    },
    execute: async (args) => updateTaskMemory(options.session.paths.taskMemoryPath, String(args.content ?? '')),
  });

  sdk.registerTool('consult_recipes', {
    description: 'Search the recipe library for guidance on workflows, conventions, and how to approach a task in this workspace.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of the workflow or convention you need.' },
        max_results: { type: 'number', description: 'Optional maximum number of matching recipes to return.' },
      },
      required: ['query'],
    },
    execute: async (args) => consultRecipes({
      workspaceRoot: options.workspaceRoot,
      query: String(args.query ?? ''),
      maxResults: typeof args.max_results === 'number' ? args.max_results : undefined,
    }),
  });
}

export async function consultRecipes(options: {
  workspaceRoot: string;
  query: string;
  maxResults?: number;
}): Promise<Record<string, unknown>> {
  const query = options.query.trim();
  if (!query) {
    throw new Error('query is required');
  }

  const [catalog, matches] = await Promise.all([
    listRecipeCatalog(options.workspaceRoot),
    searchRecipeCatalog(options.workspaceRoot, query, { maxResults: options.maxResults ?? 3 }),
  ]);

  return {
    success: true,
    query,
    total_recipes: catalog.length,
    matches: matches.map((recipe) => ({
      slug: recipe.slug,
      name: recipe.name,
      description: recipe.description,
      tags: recipe.tags,
      when_to_use: recipe.whenToUse,
      when_not_to_use: recipe.whenNotToUse,
      globs: recipe.globs,
      priority: recipe.priority,
      matched_on: recipe.matchedOn,
      score: recipe.score,
      source: recipe.source,
      source_path: recipe.sourcePath,
      content: recipe.content,
    })),
  };
}

export async function createLocalSkill(options: {
  spec: string;
  workspaceRoot: string;
  workspacePath: string;
  config: Config;
  compileSelection: ReturnType<typeof resolveModelSlot>;
  runSelection: ReturnType<typeof resolveModelSlot>;
  sessionId: string;
  verbose?: boolean;
  sandbox: boolean;
  signal?: AbortSignal;
  onUserInput: (prompt: string) => Promise<string>;
  onEvent?: (event: ConductorLogEvent) => void;
}): Promise<Record<string, unknown>> {
  if (!options.spec.trim()) {
    throw new Error('spec is required');
  }

  const slug = deriveSkillSlugFromMarkdown(options.spec, `skill-${Date.now().toString(36)}`);
  const specDir = path.join(getSessionPaths(options.workspaceRoot, options.sessionId).dir, 'specs');
  const specPath = path.join(specDir, `${slug}.md`);
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(specPath, options.spec, 'utf8');

  const result = await compileWithSkillCreator(options.spec, {
    sourcePath: specPath,
    outputDir: getToolsDir(options.workspaceRoot),
    baseName: slug,
    workspaceRoot: options.workspaceRoot,
    workspacePath: options.workspacePath,
    config: options.config,
    compileSelection: options.compileSelection,
    runSelection: options.runSelection,
    sandbox: options.sandbox,
    verbose: options.verbose,
    signal: options.signal,
    onUserInput: options.onUserInput,
    onEvent: (event) => options.onEvent?.({
      scope: 'child',
      childSlug: 'skill-creator',
      modelId: options.compileSelection.id,
      event,
    }),
  });

  await mergeSessionUsage(options.workspaceRoot, options.sessionId, result.usageByModel);
  const publishedSlug = path.basename(result.outputPath, path.extname(result.outputPath)) || slug;

  return {
    success: true,
    slug: publishedSlug,
    output_path: result.outputPath,
    description: result.meta.description,
    tools: result.tools,
  };
}

async function updateTaskMemory(taskMemoryPath: string, content: string): Promise<Record<string, unknown>> {
  await fs.writeFile(taskMemoryPath, content, 'utf8');
  return {
    success: true,
    path: taskMemoryPath,
    bytes: content.length,
  };
}

async function buildConductorSystemPrompt(options: {
  workspaceRoot: string;
  workspacePath: string;
  session: LoadedSession;
  gatewayModelId: string;
  compileModelId: string;
  runModelId: string;
}): Promise<string> {
  const template = await readSystemPromptAsset('conductor', { workspaceRoot: options.workspaceRoot });
  const commands = await listCommands(options.workspaceRoot, { detailed: false });
  const recipes = await listRecipeCatalog(options.workspaceRoot);
  const catalog = commands.length > 0
    ? commands.map((command) => `- ${command.name}: ${command.description}`).join('\n')
    : '- No compiled local skills are available yet.';
  const recipeCatalog = recipes.length > 0
    ? recipes.map((recipe) => `- ${recipe.slug}: ${recipe.description}`).join('\n')
    : '- No recipes are available yet.';

  const assistantMemory = options.session.assistantMemory.trim()
    || 'No optional session context is recorded in assistant-memory.md for this session.';
  const taskMemory = options.session.taskMemory.trim() || 'No task memory recorded yet.';
  const localContext = [
    '## Local CLI Runtime',
    `- Workspace root: ${options.workspaceRoot}`,
    `- Working directory for tools: ${options.workspacePath}`,
    `- Skill catalog: ${getToolsDir(options.workspaceRoot)}`,
    `- Recipe library: ${getWorkspaceRecipeAssetsDir(options.workspaceRoot)} plus packaged defaults`,
    `- Docs directory: ${getDocsDir(options.workspaceRoot)}`,
    `- TUI guide: ${path.join(getDocsDir(options.workspaceRoot), 'TUI.md')}`,
    `- Session directory: ${options.session.paths.dir}`,
    `- Session execution log: ${options.session.paths.executionLogPath}`,
    `- Gateway model: ${options.gatewayModelId}`,
    `- Run model: ${options.runModelId}`,
    `- Compile model: ${options.compileModelId}`,
    '- There is exactly one conductor in the CLI runtime. Do not invent hidden workers or extra orchestration layers.',
    '',
    '## Local Skill Catalog',
    catalog,
    '',
    '## Recipe Library',
    recipeCatalog,
    '',
    '## Optional Session Context (assistant-memory.md)',
    assistantMemory,
    '',
    '## Task Memory',
    taskMemory,
  ].join('\n');

  return `${template
    .replace('{ASSISTANT_NAME}', 'DeepClause')}\n\n${localContext}`;
}

async function loadOrCreateSession(
  workspaceRoot: string,
  sessionId: string | undefined,
  sessionTitle: string | undefined,
): Promise<LoadedSession> {
  if (!sessionId) {
    const created = await createConductorSession(workspaceRoot, sessionTitle);
    return loadSession(workspaceRoot, created.id);
  }
  return loadSession(workspaceRoot, sessionId);
}

async function loadSession(workspaceRoot: string, sessionId: string): Promise<LoadedSession> {
  const paths = getSessionPaths(workspaceRoot, sessionId);
  const metadata = await readRequiredSessionMetadata(paths.dir);
  const messages = await readSessionMessages(paths.messagesPath);
  const assistantMemory = await readOptionalText(paths.assistantMemoryPath);
  const taskMemory = await readOptionalText(paths.taskMemoryPath);
  return {
    metadata,
    paths,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    assistantMemory,
    taskMemory,
  };
}

function getSessionsDir(workspaceRoot: string): string {
  return path.join(getConfigDir(workspaceRoot), 'sessions');
}

function getSessionPaths(workspaceRoot: string, sessionId: string): SessionPaths {
  const dir = path.join(getSessionsDir(workspaceRoot), sessionId);
  return {
    dir,
    metadataPath: path.join(dir, 'session.json'),
    messagesPath: path.join(dir, 'messages.jsonl'),
    assistantMemoryPath: path.join(dir, 'assistant-memory.md'),
    taskMemoryPath: path.join(dir, 'task-memory.md'),
    usagePath: path.join(dir, 'usage.json'),
    executionLogPath: path.join(dir, 'execution-log.jsonl'),
  };
}

export function createSessionExecutionLogWriter(options: {
  workspaceRoot: string;
  sessionId: string;
  executionKind: SessionExecutionKind;
  inputText: string;
  skillName?: string;
  args?: unknown[];
  modelId?: string;
}): SessionExecutionLogWriter {
  const logPath = getSessionPaths(options.workspaceRoot, options.sessionId).executionLogPath;
  const executionId = randomUUID();
  let writeChain = Promise.resolve();
  let writeError: Error | null = null;

  const enqueue = (record: SessionExecutionLogRecord): void => {
    writeChain = writeChain.then(async () => {
      if (writeError) {
        return;
      }

      try {
        await fs.appendFile(logPath, JSON.stringify(record) + '\n', 'utf8');
      } catch (error) {
        writeError = error as Error;
      }
    });
  };

  enqueue({
    timestamp: new Date().toISOString(),
    sessionId: options.sessionId,
    executionId,
    entryType: 'execution_started',
    executionKind: options.executionKind,
    inputText: options.inputText,
    skillName: options.skillName,
    args: options.args,
    modelId: options.modelId,
  });

  return {
    executionId,
    logPath,
    recordEvent: (event) => enqueue({
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId,
      executionId,
      entryType: 'event',
      executionKind: options.executionKind,
      scope: event.scope,
      childSlug: event.childSlug,
      modelId: event.modelId,
      event: event.event,
    }),
    finish: async (summary) => {
      enqueue({
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        executionId,
        entryType: 'execution_finished',
        executionKind: options.executionKind,
        status: summary.status,
        answer: summary.answer,
        error: summary.error,
        outputCount: summary.outputCount,
        usageByModel: summary.usageByModel,
      });
      await writeChain;
      if (writeError) {
        throw writeError;
      }
    },
    flush: async () => {
      await writeChain;
      if (writeError) {
        throw writeError;
      }
    },
  };
}

async function readSessionMetadata(sessionDir: string): Promise<SessionMetadata | null> {
  try {
    const content = await fs.readFile(path.join(sessionDir, 'session.json'), 'utf8');
    return JSON.parse(content) as SessionMetadata;
  } catch {
    return null;
  }
}

async function readRequiredSessionMetadata(sessionDir: string): Promise<SessionMetadata> {
  const metadata = await readSessionMetadata(sessionDir);
  if (!metadata) {
    throw new Error(`Unknown conductor session: ${path.basename(sessionDir)}`);
  }
  return metadata;
}

async function readSessionMessages(messagesPath: string): Promise<SessionMessage[]> {
  const content = await readOptionalText(messagesPath);
  if (!content.trim()) {
    return [];
  }

  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionMessage)
    .filter((message) => message.role === 'user' || message.role === 'assistant');
}

async function rewriteSessionMessages(messagesPath: string, messages: SessionMessage[]): Promise<void> {
  const content = messages.map((message) => JSON.stringify(message)).join('\n');
  await fs.writeFile(messagesPath, content ? `${content}\n` : '', 'utf8');
}

async function readSessionUsage(usagePath: string): Promise<TokenUsageByModel> {
  const content = await readOptionalText(usagePath);
  if (!content.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(content) as TokenUsageByModel;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function appendSessionMessage(messagesPath: string, message: SessionMessage): Promise<void> {
  await fs.appendFile(messagesPath, JSON.stringify(message) + '\n', 'utf8');
}

function normalizeSessionCompactionMessages(messages: MemoryMessage[]): SessionMessage[] | null {
  const timestamp = new Date().toISOString();
  const normalized: SessionMessage[] = [];
  for (const message of messages) {
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') {
      return null;
    }
    normalized.push({
      role: message.role,
      content: message.content,
      timestamp,
    });
  }
  return normalized;
}

async function runSessionCompactorBinding(options: {
  request: CompactorExecutionRequest;
  config: Config;
  selection: ReturnType<typeof resolveModelSlot>;
  workspacePath: string;
  signal?: AbortSignal;
  verbose?: boolean;
}): Promise<CompactorExecutionResponse> {
  const binding = options.request.binding;
  if (binding.compactor.inheritTools) {
    return { error: 'Session compactors cannot inherit tools' };
  }

  const resolvedModel = resolveCompactorModelConfig({
    binding,
    selection: options.selection,
    providerConfigs: options.config.providers,
  });

  const sdk = await createDeepClause({
    model: resolvedModel.model,
    provider: resolvedModel.provider,
    apiKey: resolvedModel.apiKey,
    baseUrl: resolvedModel.baseUrl,
    temperature: resolvedModel.temperature,
    debug: options.verbose,
    maxTokens: 65536,
    compaction: { enabled: false },
  });

  try {
    let code = binding.compactor.source;
    if (binding.compactor.sourceType !== 'inline') {
      try {
        code = await fs.readFile(binding.compactor.source, 'utf8');
      } catch (error) {
        if (binding.compactor.sourceType === 'file') {
          throw error;
        }
      }
    }
    let answer = '';
    let error = '';
    for await (const event of sdk.runDML(code, {
      workspacePath: options.workspacePath,
      gasLimit: binding.compactor.gasLimit,
      params: options.request.params,
      initialMessages: options.request.messages,
      signal: options.signal,
      onUserInput: async (prompt) => {
        throw new Error(`Compactor requested unexpected input: ${prompt}`);
      },
      compaction: { enabled: false },
    })) {
      if (event.type === 'answer' && event.content) {
        answer = event.content;
      } else if (event.type === 'error' && event.content) {
        error = event.content;
      }
    }

    return {
      answer,
      error: error || undefined,
    };
  } finally {
    await sdk.dispose();
  }
}

async function maybeCompactSessionMessages(options: {
  config: Config;
  workspaceRoot: string;
  workspacePath: string;
  selection: ReturnType<typeof resolveModelSlot>;
  signal?: AbortSignal;
  verbose?: boolean;
  messagesPath: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  onCompactionEvent?: (event: DMLEvent) => void;
}): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const resolvedConfig = resolveCompactionConfig(options.config, options.workspaceRoot);
  const resolved = resolveCompactionOptions(resolvedConfig, undefined);
  const bindings = getCompactionBindings(resolved, 'session', 'before_user_message');
  if (bindings.length === 0) {
    return options.messages;
  }

  let messages: MemoryMessage[] = options.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  for (const binding of bindings) {
    const priorMessages = messages;
    const result = await executeCompactor({
      binding,
      messages: priorMessages,
      emitEvent: options.onCompactionEvent,
      execute: (request) => runSessionCompactorBinding({
        request,
        config: options.config,
        selection: options.selection,
        workspacePath: options.workspacePath,
        signal: options.signal,
        verbose: options.verbose,
      }),
    });

    const normalized = normalizeSessionCompactionMessages(result.messages);
    if (!normalized) {
      options.onCompactionEvent?.({
        ...result.event,
        content: `compact ${binding.scope}.${binding.trigger} failed ${result.event.beforeTokens ?? 0} -> ${result.event.afterTokens ?? 0} tokens: session compactors must return only user/assistant messages`,
        compactionAction: 'failed',
        compactionError: 'Session compactors must return only user/assistant messages',
      });
      continue;
    }

    options.onCompactionEvent?.(result.event);

    const beforeSerialized = JSON.stringify(priorMessages);
    const afterSerialized = JSON.stringify(normalized.map(({ role, content }) => ({ role, content })));
    if (beforeSerialized !== afterSerialized) {
      await rewriteSessionMessages(options.messagesPath, normalized);
    }

    messages = normalized.map((message) => ({ role: message.role, content: message.content }));
  }

  return messages.map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
}

export async function mergeSessionUsage(
  workspaceRoot: string,
  sessionId: string,
  delta: TokenUsageByModel,
): Promise<void> {
  if (isTokenUsageEmpty(delta)) {
    return;
  }

  const paths = getSessionPaths(workspaceRoot, sessionId);
  const current = await readSessionUsage(paths.usagePath);
  const merged = mergeTokenUsageMaps(current, delta);
  await fs.writeFile(paths.usagePath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

async function touchSession(workspaceRoot: string, sessionId: string): Promise<void> {
  const paths = getSessionPaths(workspaceRoot, sessionId);
  const metadata = await readRequiredSessionMetadata(paths.dir);
  metadata.updatedAt = new Date().toISOString();
  await fs.writeFile(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
}

async function maybeUpdateSessionTitle(workspaceRoot: string, metadata: SessionMetadata, userMessage: string): Promise<void> {
  if (!metadata.title.startsWith(DEFAULT_SESSION_TITLE_PREFIX)) {
    return;
  }

  const nextTitle = summarizeTitle(userMessage);
  if (!nextTitle) {
    return;
  }

  const paths = getSessionPaths(workspaceRoot, metadata.id);
  metadata.title = nextTitle;
  metadata.updatedAt = new Date().toISOString();
  await fs.writeFile(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
}

function summarizeTitle(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.slice(0, 60);
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}