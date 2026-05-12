import { createDeepClause } from '../../sdk.js';
import type { Config } from '../../cli/config.js';
import { applyResolvedModelConfig } from '../../cli/config.js';
import type { DMLEvent, DeepClauseSDK } from '../../types.js';
import {
  createLocalSkillCatalogRuntime,
  type ExecuteNestedSkillRequest,
} from './catalog-skills.js';
import type { ResolvedModelConfig } from '../config/model-slots.js';
import { withCapturedConsole } from './console-capture.js';
import { registerLocalRuntimeTools } from './runtime-tools.js';
import { createShellManager, type ShellManager } from './shell-manager.js';

export interface DmlExecutionContext {
  config: Config;
  workspacePath: string;
  selection: ResolvedModelConfig;
  shell: ShellManager;
}

export interface ExecuteDmlOptions {
  dmlCode: string;
  config: Config;
  workspacePath: string;
  selection: ResolvedModelConfig;
  args?: string[];
  params?: Record<string, unknown>;
  gasLimit?: number;
  stream?: boolean;
  trace?: boolean;
  verbose?: boolean;
  headless?: boolean;
  sandbox?: boolean;
  signal?: AbortSignal;
  onUserInput?: (prompt: string) => Promise<string>;
  initialMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  onEvent?: (event: DMLEvent) => void;
  skillCatalog?: {
    workspaceRoot: string;
    currentSkillSlug?: string;
    invocationStack?: string[];
    maxDepth?: number;
    includeSystemSkillsInList?: boolean;
    onChildEvent?: (slug: string, event: DMLEvent) => void;
  };
  registerAdditionalTools?: (sdk: DeepClauseSDK, context: DmlExecutionContext) => Promise<void> | void;
}

export interface ExecuteDmlResult {
  output: string[];
  answer?: string;
  error?: string;
  trace?: object;
  events: DMLEvent[];
}

export async function executeDml(options: ExecuteDmlOptions): Promise<ExecuteDmlResult> {
  if (options.headless && options.onEvent) {
    return withCapturedConsole(
      (entry) => options.onEvent?.({
        type: 'log',
        content: `[${entry.level}] ${entry.text}`,
      }),
      () => executeDmlInternal(options),
    );
  }

  return executeDmlInternal(options);
}

async function executeDmlInternal(options: ExecuteDmlOptions): Promise<ExecuteDmlResult> {
  applyResolvedModelConfig(options.selection);

  const shell = createShellManager({
    workspacePath: options.workspacePath,
    sandbox: options.sandbox,
    network: options.config.agentvm?.network ?? false,
  });

  const sdk = await createDeepClause({
    model: options.selection.model,
    provider: options.selection.provider,
    apiKey: options.selection.apiKey,
    baseUrl: options.selection.baseUrl,
    temperature: options.selection.temperature,
    trace: !!options.trace,
    streaming: options.stream,
    debug: options.verbose,
    maxTokens: 65536,
  });

  const result: ExecuteDmlResult = {
    output: [],
    events: [],
  };
  let finished = false;

  const handleEvent = (event: DMLEvent) => {
    result.events.push(event);
    options.onEvent?.(event);

    switch (event.type) {
      case 'output':
        if (event.content) {
          result.output.push(event.content);
          if (!options.headless) {
            console.log(event.content);
          }
        }
        break;

      case 'stream':
        if (options.stream && !options.headless && event.content) {
          process.stdout.write(event.content);
        }
        if (options.stream && !options.headless && event.done) {
          process.stdout.write('\n');
        }
        break;

      case 'log':
        if (options.verbose && event.content && !options.headless) {
          console.log(`[log] ${event.content}`);
        }
        break;

      case 'tool_call':
        if (!options.headless && options.verbose && event.toolName) {
          console.log(`  🔧 ${event.toolName}(${formatToolArgs(event.toolArgs)})`);
        }
        break;

      case 'answer':
        result.answer = event.content;
        break;

      case 'error':
        result.error = event.content;
        if (event.trace) {
          result.trace = event.trace;
        }
        finished = true;
        break;

      case 'finished':
        if (event.trace) {
          result.trace = event.trace;
        }
        finished = true;
        break;

      case 'input_required':
        if (options.verbose && event.prompt && !options.headless) {
          console.log(`[input_required] ${event.prompt}`);
        }
        break;

      case 'usage':
        break;
    }
  };

  try {
    const skillCatalog = options.skillCatalog
      ? createLocalSkillCatalogRuntime({
        workspaceRoot: options.skillCatalog.workspaceRoot,
        workspacePath: options.workspacePath,
        config: options.config,
        selection: options.selection,
        currentSkillSlug: options.skillCatalog.currentSkillSlug,
        invocationStack: options.skillCatalog.invocationStack,
        maxDepth: options.skillCatalog.maxDepth,
        includeSystemSkillsInList: options.skillCatalog.includeSystemSkillsInList,
        executeNestedSkill: (child) => executeNestedSkill(options, child),
      })
      : undefined;

    registerLocalRuntimeTools(sdk, {
      workspacePath: options.workspacePath,
      shell,
      signal: options.signal,
      onEvent: handleEvent,
      skillCatalog,
    });

    await options.registerAdditionalTools?.(sdk, {
      config: options.config,
      workspacePath: options.workspacePath,
      selection: options.selection,
      shell,
    });

    for await (const event of sdk.runDML(options.dmlCode, {
      args: options.args,
      params: options.params,
      workspacePath: options.workspacePath,
      gasLimit: options.gasLimit,
      signal: options.signal,
      onUserInput: options.onUserInput,
      initialMessages: options.initialMessages,
    })) {
      if (finished) {
        break;
      }

      handleEvent(event);
    }

    return result;
  } finally {
    await sdk.dispose();
    await shell.dispose();
  }
}

function executeNestedSkill(
  parentOptions: ExecuteDmlOptions,
  child: ExecuteNestedSkillRequest,
): Promise<ExecuteDmlResult> {
  return executeDml({
    dmlCode: child.dmlCode,
    config: parentOptions.config,
    workspacePath: parentOptions.workspacePath,
    selection: parentOptions.selection,
    args: child.args,
    params: child.params,
    gasLimit: parentOptions.gasLimit,
    stream: parentOptions.stream,
    trace: parentOptions.trace,
    verbose: parentOptions.verbose,
    headless: true,
    sandbox: parentOptions.sandbox,
    signal: parentOptions.signal,
    onUserInput: parentOptions.onUserInput
      ? (prompt) => parentOptions.onUserInput!(`[${child.slug}] ${prompt}`)
      : undefined,
    onEvent: parentOptions.skillCatalog?.onChildEvent
      ? (event) => parentOptions.skillCatalog?.onChildEvent?.(child.slug, event)
      : undefined,
    skillCatalog: parentOptions.skillCatalog
      ? {
        workspaceRoot: parentOptions.skillCatalog.workspaceRoot,
        currentSkillSlug: child.currentSkillSlug,
        invocationStack: child.invocationStack,
        maxDepth: parentOptions.skillCatalog.maxDepth,
        includeSystemSkillsInList: parentOptions.skillCatalog.includeSystemSkillsInList,
        onChildEvent: parentOptions.skillCatalog.onChildEvent,
      }
      : undefined,
  });
}

function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return '';
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    let rendered = typeof value === 'string' ? value : JSON.stringify(value);
    if (rendered.length > 50) {
      rendered = rendered.slice(0, 47) + '...';
    }
    parts.push(`${key}=${rendered}`);
  }
  return parts.join(', ');
}