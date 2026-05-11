import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { listCommands } from '../../cli/commands.js';
import {
  getConfigDir,
  getToolsDir,
  loadConfig,
  resolveModelSlot,
  type Config,
} from '../../cli/config.js';
import { promptUser } from '../../cli/interactive.js';
import type { DMLEvent, DeepClauseSDK } from '../../types.js';
import { readSystemPromptAsset, readSystemSkillAsset } from '../assets/index.js';
import { executeDml, type DmlExecutionContext } from './dml-executor.js';
import { compileWithSkillCreator } from './skill-creator.js';
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
  };
}

export async function runConductorTurn(
  userMessage: string,
  options: ConductorTurnOptions = {},
): Promise<ConductorTurnResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const config = options.config ?? await loadConfig(workspaceRoot);
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
  const emitLogEvent = (event: ConductorLogEvent): void => {
    if (event.event.type === 'usage') {
      recordTokenUsage(usageByModel, event.modelId, event.event.usage);
    }
    options.onEvent?.(event);
  };

  const result = await executeDml({
    dmlCode: conductorDml,
    config,
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
    onUserInput,
    initialMessages: session.messages,
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

  const slug = deriveSkillSlug(options.spec);
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

  return {
    success: true,
    slug,
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
  const template = await readSystemPromptAsset('conductor');
  const commands = await listCommands(options.workspaceRoot, { detailed: false });
  const catalog = commands.length > 0
    ? commands.map((command) => `- ${command.name}: ${command.description}`).join('\n')
    : '- No compiled local skills are available yet.';

  const assistantMemory = options.session.assistantMemory.trim() || 'No assistant memory recorded yet.';
  const taskMemory = options.session.taskMemory.trim() || 'No task memory recorded yet.';
  const localContext = [
    '## Local CLI Runtime',
    `- Workspace root: ${options.workspaceRoot}`,
    `- Working directory for tools: ${options.workspacePath}`,
    `- Skill catalog: ${getToolsDir(options.workspaceRoot)}`,
    `- Session directory: ${options.session.paths.dir}`,
    `- Gateway model: ${options.gatewayModelId}`,
    `- Run model: ${options.runModelId}`,
    `- Compile model: ${options.compileModelId}`,
    '- There is exactly one conductor in the CLI runtime. Do not invent hidden workers or extra orchestration layers.',
    '',
    '## Local Skill Catalog',
    catalog,
    '',
    '## Assistant Memory',
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

async function mergeSessionUsage(
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

function deriveSkillSlug(spec: string): string {
  const heading = spec.match(/^#\s+(.+)$/m)?.[1];
  const named = spec.match(/(?:called|named)\s+["']?([A-Za-z0-9 _-]{3,40})["']?/i)?.[1];
  const firstLine = spec.split('\n').map((line) => line.trim()).find(Boolean);
  const seed = heading ?? named ?? firstLine ?? `skill ${Date.now()}`;
  return slugify(seed);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `skill-${Date.now().toString(36)}`;
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