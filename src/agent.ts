/**
 * Agent Loop Implementation
 * Runs an LLM agent loop for task() predicate execution
 * 
 * Based on AI SDK v6 agent patterns:
 * - Uses Zod schemas for tool definitions
 * - Uses result.response.messages for message history management
 */

import { generateText, streamText, hasToolCall, tool as aiTool } from 'ai';
import { z } from 'zod';
import type { ToolDefinition, MemoryMessage, TypedVar } from './types.js';
import { createModelProvider, type RawProviderResponseSnapshot } from './prolog/bridge.js';

/** Maximum number of retries for LLM error finish reasons */
const MAX_ERROR_RETRIES = 3;
const DEFAULT_STREAM_RESPONSE_AWAIT_TIMEOUT_MS = 2_000;

/**
 * Clean Prolog dict markers ($tag, $t) from tool results
 * This makes the data more readable for the LLM
 */
function cleanPrologMarkers(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }
  
  if (Array.isArray(data)) {
    return data.map(cleanPrologMarkers);
  }
  
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(obj)) {
      // Skip Prolog-specific markers
      if (key === '$tag' || key === '$t') {
        continue;
      }
      cleaned[key] = cleanPrologMarkers(value);
    }
    
    return cleaned;
  }
  
  return data;
}

export interface AgentLoopOptions {
  taskDescription: string;
  outputVars: (string | TypedVar)[];
  memory: MemoryMessage[];
  tools: Map<string, ToolDefinition>;
  modelOptions: {
    model: string;
    provider: string;
    temperature: number;
    maxOutputTokens: number;
    baseUrl?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    providerOptions?: Record<string, Record<string, any>>;
  };
  onOutput: (text: string) => void;
  onStream?: (chunk: string, done: boolean) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  onUsage?: (usage: import('./types.js').LLMUsage) => void;
  onBeforeModelCall?: (messages: MemoryMessage[]) => Promise<MemoryMessage[]>;
  onAskUser: (prompt: string) => Promise<string>;
  signal?: AbortSignal;
  streaming?: boolean;
  debug?: boolean;
}

export interface AgentLoopResult {
  success: boolean;
  outputs: string[];
  variables: Record<string, unknown>;
  /** Conversation messages from the agent loop (excludes system messages which are task-specific) */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

type ResponseMessage = { role: 'user' | 'assistant' | 'system'; content: unknown };

interface ResponseMessagesResolution {
  messages: ResponseMessage[];
  timedOut: boolean;
  elapsedMs: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function normalizeMessagesForCompaction(messages: Array<{ role: string; content: unknown }>): MemoryMessage[] {
  return messages
    .filter((message) => message.role === 'system' || message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'system' | 'user' | 'assistant',
      content: normalizeMessageContent(message.content),
    }));
}

function getStreamResponseAwaitTimeoutMs(): number {
  const raw = process.env.DC_STREAM_RESPONSE_TIMEOUT_MS;
  if (raw != null) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_STREAM_RESPONSE_AWAIT_TIMEOUT_MS;
}

async function resolveResponseMessagesWithTimeout(
  responsePromise: PromiseLike<unknown>,
  timeoutMs: number,
): Promise<ResponseMessagesResolution> {
  const startMs = Date.now();

  if (timeoutMs <= 0) {
    return {
      messages: getResponseMessages(await responsePromise),
      timedOut: false,
      elapsedMs: Date.now() - startMs,
    };
  }

  const timeoutResult = Symbol('timeout');
  const raced = await Promise.race([
    responsePromise,
    new Promise<symbol>((resolve) => {
      setTimeout(() => resolve(timeoutResult), timeoutMs);
    }),
  ]);

  if (raced === timeoutResult) {
    return {
      messages: [],
      timedOut: true,
      elapsedMs: Date.now() - startMs,
    };
  }

  return {
    messages: getResponseMessages(raced),
    timedOut: false,
    elapsedMs: Date.now() - startMs,
  };
}

function validateTypedResultValue(typedVar: TypedVar, value: unknown): string | null {
  switch (typedVar.type) {
    case 'string':
      return typeof value === 'string' ? null : 'Expected a string value';
    case 'number':
      return typeof value === 'number' ? null : 'Expected a number value';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) ? null : 'Expected an integer value';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Expected a boolean value';
    case 'array':
      if (!Array.isArray(value)) {
        return 'Expected an array value';
      }
      if (!typedVar.itemType) {
        return null;
      }
      for (const item of value) {
        const itemError = validateTypedResultValue({ name: typedVar.name, type: typedVar.itemType }, item);
        if (itemError) {
          return `Expected array<${typedVar.itemType}> value`;
        }
      }
      return null;
    case 'object':
      return isPlainObject(value) ? null : 'Expected an object value';
    default:
      return null;
  }
}

/**
 * Convert JSON Schema to Zod schema
 * Handles basic JSON Schema types used in tool definitions
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = schema.type as string;
  const description = schema.description as string | undefined;
  
  let zodType: z.ZodTypeAny;
  
  switch (type) {
    case 'string':
      zodType = z.string();
      break;
    case 'number':
      zodType = z.number();
      break;
    case 'integer':
      zodType = z.number().int();
      break;
    case 'boolean':
      zodType = z.boolean();
      break;
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      zodType = z.array(items ? jsonSchemaToZod(items) : z.unknown());
      break;
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = (schema.required as string[]) || [];
      
      if (properties) {
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, propSchema] of Object.entries(properties)) {
          let propZod = jsonSchemaToZod(propSchema);
          if (!required.includes(key)) {
            propZod = propZod.optional();
          }
          shape[key] = propZod;
        }
        zodType = z.object(shape);
      } else {
        zodType = z.record(z.unknown());
      }
      break;
    }
    default:
      zodType = z.unknown();
  }
  
  if (description) {
    zodType = zodType.describe(description);
  }
  
  return zodType;
}

/**
 * Run an agent loop for a task
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    taskDescription,
    outputVars,
    memory,
    tools,
    modelOptions,
    onOutput,
    onStream,
    onToolCall,
    onUsage,
    signal,
    streaming = false,
    debug = false,
  } = options;

  // Debug helper - logs if debug is enabled or DEBUG_AGENT env var is set
  const debugLog = (...args: unknown[]) => {
    if (debug || process.env.DEBUG_AGENT) {
      console.log('[AGENT]', ...args);
    }
  };
  
  // Normalize outputVars to TypedVar[]
  const normalizedOutputVars: TypedVar[] = outputVars.map(v => 
    typeof v === 'string' ? { name: v, type: 'string' } : v
  );
  
  debugLog('Output vars:', normalizedOutputVars.map(v => `${v.name}:${v.type}`));

  const outputs: string[] = [];
  const variables: Record<string, unknown> = {};
  let finished = false;
  let success = false;
  let errorRetryCount = 0;

  // Build the AI SDK tools using Zod schemas
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiTools: Record<string, any> = {};

  // Add finish tool with Zod schema
  const requiredVarNames = normalizedOutputVars.map(v => v.name);
  aiTools['finish'] = aiTool({
    description: 'CRITICAL: You MUST call this tool to complete the task and return success/failure. Call with success=true if you have set all required results, or success=false if the task is impossible.',
    inputSchema: z.object({
      success: z.boolean().describe('Whether the task was completed successfully')
    }),
    execute: async ({ success: s }: { success: boolean }) => {
      // Guard: success=true requires all output variables to be set
      if (s && requiredVarNames.length > 0) {
        const missing = requiredVarNames.filter(v => !(v in variables));
        if (missing.length > 0) {
          return { finished: false, error: `Cannot finish with success=true — missing required result variable(s): ${missing.join(', ')}. Call set_result for each before finishing.` };
        }
      }
      finished = true;
      success = s;
      return { finished: true, success: s };
    },
  });

  // Add set_result tool for output variables
  if (normalizedOutputVars.length > 0) {
    const varNames = normalizedOutputVars.map(v => v.name);
    const typeSummary = normalizedOutputVars.map(v => {
      const renderedType = v.type === 'array' && v.itemType ? `array<${v.itemType}>` : v.type;
      return `${v.name}: ${renderedType}`;
    }).join(', ');
    const variableSchema = varNames.length === 1
      ? z.literal(varNames[0])
      : z.enum(varNames as [string, ...string[]]);
    const inputSchema = z.object({
      variable: variableSchema.describe(`Output variable name. Must be one of: ${varNames.join(', ')}`),
      value: z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.unknown()),
        z.record(z.unknown()),
      ]).describe(`Value for the selected variable. Expected types: ${typeSummary}`),
    });

    aiTools['set_result'] = aiTool({
      description: `Set a result value for an output variable. You MUST call this tool to return results from the task. Use the exact variable name as specified.`,
      inputSchema: inputSchema as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: async ({ variable, value }: { variable: string; value: any }) => {
        const typedVar = normalizedOutputVars.find(v => v.name === variable);
        if (typedVar) {
          const validationError = validateTypedResultValue(typedVar, value);
          if (validationError) {
            return {
              success: false,
              error: `${validationError} for ${variable}`,
            };
          }
          variables[variable] = value;
          return { success: true, variable, value };
        }
        return { success: false, error: `Unknown variable: ${variable}` };
      },
    });
  }

  // Reserved internal tool names that cannot be overwritten by user-defined tools
  const reservedToolNames = ['finish', 'set_result'];

  // Add user-defined tools - convert JSON Schema to Zod
  for (const [name, tool] of tools) {
    if (reservedToolNames.includes(name)) {
      continue;
    }
    
    // Convert JSON Schema parameters to Zod schema
    const zodSchema = jsonSchemaToZod(tool.parameters as unknown as Record<string, unknown>);
    
    aiTools[name] = aiTool({
      description: tool.description,
      inputSchema: zodSchema,
      execute: async (input: unknown) => {
        try {
          const result = await tool.execute(input as Record<string, unknown>);
          return cleanPrologMarkers(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { error: message };
        }
      },
    });
  }

  // Build the base system prompt with task instructions and tools
  const baseSystemPrompt = buildSystemPrompt(taskDescription, normalizedOutputVars, tools);

  // Extract system context from memory (user-defined system() calls)
  const systemContext = memory
    .filter(m => m.role === 'system' && typeof m.content === 'string')
    .map(m => m.content)
    .join('\n\n');

  // Combine into a single system message
  const combinedSystemPrompt = systemContext
    ? `${systemContext}\n\n---\n\n${baseSystemPrompt}`
    : baseSystemPrompt;

  // Filter non-system messages from memory for conversation history
  const conversationHistory = memory.filter(m => 
    m.role !== 'system' && 
    typeof m.content === 'string' && 
    ['user', 'assistant'].includes(m.role)
  );

  // Build initial messages - AI SDK v6 uses ModelMessage[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let messages: any[] = [
    { role: 'system', content: combinedSystemPrompt },
    ...conversationHistory.map(m => ({ 
      role: m.role as 'user' | 'assistant', 
      content: m.content 
    })),
    { role: 'user', content: `Subtask: ${taskDescription}` },
  ];

  debugLog('System prompt:', combinedSystemPrompt);
  debugLog('Conversation history:', conversationHistory);
  debugLog('Subtask:', taskDescription);

  let latestRawProviderResponse: Promise<RawProviderResponseSnapshot> | null = null;

  const maybeLogEmptyOtherProviderResponse = async (finishReason: string, text: string): Promise<void> => {
    if (finishReason !== 'other' || text) {
      latestRawProviderResponse = null;
      return;
    }

    if (!latestRawProviderResponse) {
      debugLog('Raw upstream provider response unavailable for empty finishReason=other result.');
      return;
    }

    const snapshot = await latestRawProviderResponse;
    latestRawProviderResponse = null;

    debugLog(
      `[fetch] Raw upstream provider response requestId=${snapshot.requestId} status=${snapshot.status} transport=${snapshot.transport} content-type=${snapshot.contentType ?? 'unknown'}`,
    );
    if (snapshot.captureError) {
      debugLog(`[fetch] Raw upstream response capture error: ${snapshot.captureError}`);
    }
    debugLog(snapshot.bodyText || '(empty raw upstream response body)');
  };

  // Create model provider
  const model = createModelProvider(
    modelOptions.provider,
    modelOptions.model,
    modelOptions.baseUrl,
    debugLog,
    (snapshot) => {
      latestRawProviderResponse = snapshot;
    },
  );

  // Agent loop
  const maxIterations = 50;
  let iteration = 0;

  // Helper to allow event loop to breathe
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  while (!finished && iteration < maxIterations) {
    iteration++;
    const iterStartMs = Date.now();
    debugLog(`Iteration ${iteration}`);

    if (signal?.aborted) {
      break;
    }

    try {
      await tick();

      if (options.onBeforeModelCall) {
        messages = await options.onBeforeModelCall(normalizeMessagesForCompaction(messages));
      }
      
      if (streaming && onStream) {
        latestRawProviderResponse = null;

        // Signal LLM call start so TTFT (time-to-first-token) is captured in timing.
        // For thinking models (e.g. Claude with extended thinking), textStream yields
        // nothing during the thinking phase — without this signal, the thinking time
        // (potentially 60+ seconds) would be invisible in LLM timing metrics.
        onStream('', false);


        //save messages to a json file for debugging
        if (debug || process.env.DEBUG_AGENT) {
          const fs = await import('fs/promises');
          await fs.writeFile(`agent_messages_iteration_${iteration}.json`, JSON.stringify(messages, null, 2), 'utf-8');
        }
        
        // Streaming mode — tools WITH execute, SDK handles tool execution.
        // stopWhen: hasToolCall('finish') stops multi-step after finish is called.
        const apiCallMs = Date.now();

        const result = streamText({
          model,
          messages,
          tools: aiTools,
          toolChoice: 'auto',
          temperature: modelOptions.temperature,
          maxOutputTokens: modelOptions.maxOutputTokens,
          abortSignal: signal,
          providerOptions: modelOptions.providerOptions,
          stopWhen: hasToolCall('finish'),
          onStepFinish: (step) => {
            debugLog(`Step finished: finishReason=${step.finishReason} toolCalls=${step.toolCalls?.length ?? 0}`);
          },
        });

        // Collect results from fullStream
        let fullText = '';
        let ttftMs: number | null = null;       // time to first TEXT token
        let ttfeMs: number | null = null;       // time to first event (any type)
        let ttfrMs: number | null = null;       // time to first reasoning token
        let ttftiMs: number | null = null;      // time to first tool-input token
        let firstToolCallMs: number | null = null; // time to first tool-call (complete)
        let chunkCount = 0;
        let reasoningChunks = 0;
        let reasoningChars = 0;
        let toolInputChunks = 0;
        let toolInputChars = 0;
        let finishReason: string = 'other';
        let lastToolCallName: string | null = null;
        let stepUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }; outputTokenDetails?: { reasoningTokens?: number } } | null = null;
        let lastEventMs = apiCallMs;
        const eventCounts: Record<string, number> = {};

        for await (const part of result.fullStream) {
          const nowMs = Date.now();
          if (ttfeMs === null) ttfeMs = nowMs - apiCallMs;
          eventCounts[part.type] = (eventCounts[part.type] ?? 0) + 1;

          switch (part.type) {
            case 'text-delta':
              if (ttftMs === null) ttftMs = nowMs - apiCallMs;
              chunkCount++;
              fullText += part.text;
              onStream(part.text, false);
              break;

            case 'reasoning-delta':
              if (ttfrMs === null) {
                ttfrMs = nowMs - apiCallMs;
                debugLog(`First reasoning token at ${ttfrMs}ms`);
              }
              reasoningChunks++;
              reasoningChars += (part as { text?: string }).text?.length ?? 0;
              break;

            case 'tool-input-delta':
              if (ttftiMs === null) {
                ttftiMs = nowMs - apiCallMs;
                debugLog(`First tool-input token at ${ttftiMs}ms`);
              }
              toolInputChunks++;
              toolInputChars += (part as { delta?: string }).delta?.length ?? 0;
              break;

            case 'tool-call':
              if (firstToolCallMs === null) firstToolCallMs = nowMs - apiCallMs;
              lastToolCallName = part.toolName;
              debugLog(`Tool call: ${part.toolName}`, JSON.stringify(part.input));
              if (onToolCall) {
                onToolCall(part.toolName, part.input as Record<string, unknown>);
              }
              break;

            case 'tool-result':
              debugLog(`Tool result for ${part.toolName}:`, JSON.stringify(part.output).substring(0, 500));
              break;

            case 'error':
              debugLog(`Stream error:`, part.error);
              break;

            case 'finish-step':
              finishReason = part.finishReason;
              stepUsage = part.usage;
              break;

            default:
              break;
          }
          lastEventMs = nowMs;
        }
        const streamDoneMs = Date.now() - apiCallMs;
        const gapAfterLastEvent = Date.now() - lastEventMs;
        debugLog(`Iteration ${iteration} fullStream: ${chunkCount} text, ${reasoningChunks} reasoning (${reasoningChars}ch), ${toolInputChunks} tool-input (${toolInputChars}ch), ${streamDoneMs}ms`);
        debugLog(`Iteration ${iteration} stream timing: TTFE=${ttfeMs ?? '-'}ms TTFR=${ttfrMs ?? '-'}ms TTFTI=${ttftiMs ?? '-'}ms TTFT=${ttftMs ?? '-'}ms firstToolCall=${firstToolCallMs ?? '-'}ms gapAfterLastEvent=${gapAfterLastEvent}ms`);
        debugLog(`Iteration ${iteration} event counts:`, eventCounts);

        if (fullText) {
          onStream('', true);
        }

        // Emit usage data from the last step
        let usageStr = '';
        if (stepUsage) {
          const cacheRead = stepUsage.inputTokenDetails?.cacheReadTokens ?? 0;
          const cacheWrite = stepUsage.inputTokenDetails?.cacheWriteTokens ?? 0;
          const reasoning = stepUsage.outputTokenDetails?.reasoningTokens ?? 0;
          usageStr = ` | in=${stepUsage.inputTokens ?? 0} out=${stepUsage.outputTokens ?? 0}` +
            (cacheRead ? ` cacheRead=${cacheRead}` : '') +
            (cacheWrite ? ` cacheWrite=${cacheWrite}` : '') +
            (reasoning ? ` reasoning=${reasoning}` : '');
          if (onUsage) {
            onUsage({
              inputTokens: stepUsage.inputTokens ?? 0,
              outputTokens: stepUsage.outputTokens ?? 0,
              totalTokens: stepUsage.totalTokens ?? 0,
              cacheReadTokens: cacheRead || undefined,
              cacheWriteTokens: cacheWrite || undefined,
              reasoningTokens: reasoning || undefined,
            });
          }
        }

        debugLog(`Iteration ${iteration} timing: TTFE=${ttfeMs ?? '-'}ms TTFR=${ttfrMs ?? '-'}ms TTFT=${ttftMs ?? 'no-text'}ms stream=${streamDoneMs}ms total=${Date.now() - iterStartMs}ms${usageStr}`);
        
        // Check if finish was called during tool execution
        if (finished) {
          debugLog('Finish tool was called, exiting loop');
          break;
        }

        debugLog(`Response text: ${fullText || '(empty)'}`);
        debugLog(`Finish reason: ${finishReason}`);
  await maybeLogEmptyOtherProviderResponse(finishReason, fullText);

        // Handle errors
        if (finishReason === 'error') {
          errorRetryCount++;
          debugLog(`ERROR: LLM returned error (attempt ${errorRetryCount}/${MAX_ERROR_RETRIES}).`);
          if (errorRetryCount <= MAX_ERROR_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * errorRetryCount));
            continue;
          }
          outputs.push(`Error: LLM API returned an error.`);
          break;
        }

        // Process text output
        if (fullText) {
          outputs.push(fullText);
          onOutput(fullText);
        }

        // Use SDK's response.messages for message history.
        // The SDK handles tool execution and includes tool results in messages.
        const responseResolution = await resolveResponseMessagesWithTimeout(
          result.response,
          getStreamResponseAwaitTimeoutMs(),
        );
        const responseMessages = responseResolution.messages;
        if (responseResolution.timedOut) {
          debugLog(
            `Iteration ${iteration} timed out waiting ${responseResolution.elapsedMs}ms for result.response after stream completion; continuing without SDK response messages.`,
          );
        } else if (responseResolution.elapsedMs > 100) {
          debugLog(`Iteration ${iteration} await result.response took ${responseResolution.elapsedMs}ms (unexpectedly slow)`);
        }
        if (responseMessages.length > 0) {
          messages.push(...responseMessages);
        } else if (responseResolution.timedOut && fullText) {
          messages.push({ role: 'assistant', content: fullText });
        }

        // If no tool calls were made, nudge the model to act.
        // This handles 'stop', 'other', and any unexpected finish reason.
        if (lastToolCallName === null && !finished) {
          messages.push({
            role: 'user',
            content: 'Please take action using the available tools, or call finish() when done.',
          });
        }

      } else {
        latestRawProviderResponse = null;

        // Signal LLM call start for TTFT measurement (even in non-streaming mode)
        if (onStream) {
          onStream('', false);
        }

        // Non-streaming mode
        const apiCallMs = Date.now();
        const result = await generateText({
          model,
          messages,
          tools: aiTools,
          toolChoice: 'auto',
          temperature: modelOptions.temperature,
          maxOutputTokens: modelOptions.maxOutputTokens,
          abortSignal: signal,
          providerOptions: modelOptions.providerOptions,
        });

        // Emit usage data (fetch before timing log so we can include token counts)
        let genUsageStr = '';
        if (result.usage) {
          const u = result.usage;
          const cacheRead = u.inputTokenDetails?.cacheReadTokens ?? 0;
          const cacheWrite = u.inputTokenDetails?.cacheWriteTokens ?? 0;
          const reasoning = u.outputTokenDetails?.reasoningTokens ?? 0;
          genUsageStr = ` | in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0}` +
            (cacheRead ? ` cacheRead=${cacheRead}` : '') +
            (cacheWrite ? ` cacheWrite=${cacheWrite}` : '') +
            (reasoning ? ` reasoning=${reasoning}` : '');
          if (onUsage) {
            onUsage({
              inputTokens: u.inputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              totalTokens: u.totalTokens ?? 0,
              cacheReadTokens: cacheRead || undefined,
              cacheWriteTokens: cacheWrite || undefined,
              reasoningTokens: reasoning || undefined,
            });
          }
        }

        debugLog(`Iteration ${iteration} timing: generateText=${Date.now() - apiCallMs}ms total=${Date.now() - iterStartMs}ms${genUsageStr}`);

        // Check if finish was called during tool execution
        if (finished) {
          debugLog('Finish tool was called, exiting loop');
          break;
        }

        debugLog(`Response text: ${result.text || '(empty)'}`);
        debugLog(`Tool calls: ${result.toolCalls?.length ?? 0}`);
        debugLog(`Finish reason: ${result.finishReason}`);
        await maybeLogEmptyOtherProviderResponse(result.finishReason, result.text);

        // Handle errors
        if (result.finishReason === 'error') {
          errorRetryCount++;
          if (errorRetryCount <= MAX_ERROR_RETRIES) {
            debugLog(`ERROR: LLM returned error (attempt ${errorRetryCount}/${MAX_ERROR_RETRIES}). Retrying...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * errorRetryCount));
            continue;
          }
          outputs.push('Error: LLM API returned an error. Check API key and rate limits.');
          break;
        }

        // Process text output
        if (result.text) {
          outputs.push(result.text);
          onOutput(result.text);
        }

        // Emit tool call events
        if (result.toolCalls && result.toolCalls.length > 0) {
          for (const tc of result.toolCalls) {
            debugLog(`Tool call: ${tc.toolName}`, JSON.stringify(tc.input));
            if (onToolCall) {
              onToolCall(tc.toolName, tc.input as Record<string, unknown>);
            }
          }
          
          // Log tool results
          if (result.toolResults) {
            for (const tr of result.toolResults) {
              debugLog(`Tool result for ${tr.toolName}:`, JSON.stringify(tr.output).substring(0, 500));
            }
          }
        }

        // Use response.messages to update message history (AI SDK v6 pattern)
        // This is the key change - let the SDK handle message formatting
        messages = [...messages, ...getResponseMessages(result.response)];

        // If no tool calls were made, nudge the model to act.
        // This handles 'stop', 'other', and any unexpected finish reason.
        if ((!result.toolCalls || result.toolCalls.length === 0) && !finished) {
          messages.push({
            role: 'user',
            content: 'Please take action using the available tools, or call finish() when done.',
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorRetryCount++;
      debugLog(`ERROR in agent loop (attempt ${errorRetryCount}/${MAX_ERROR_RETRIES}): ${message}`);
      if (error instanceof Error && error.stack) {
        debugLog(`Stack trace: ${error.stack}`);
      }
      if (errorRetryCount <= MAX_ERROR_RETRIES) {
        debugLog(`Retrying in ${errorRetryCount}s...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * errorRetryCount));
        continue;
      }
      outputs.push(`Error: ${message}`);
      break;
    }
  }

  debugLog(`Loop ended: finished=${finished}, success=${success}, iterations=${iteration}`);

  // If we hit max iterations without finishing, fail
  if (!finished) {
    success = false;
    outputs.push('Agent loop reached maximum iterations without completing');
  }

  // Build persistent messages for memory
  const persistentMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  
  // Keep previous conversation history
  for (const m of conversationHistory) {
    if (m.role === 'user' || m.role === 'assistant') {
      persistentMessages.push({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    }
  }
  
  // Add the current subtask
  persistentMessages.push({
    role: 'user',
    content: `Subtask: ${taskDescription}`,
  });
  
  // Extract assistant text responses from the conversation
  const assistantTextResponses: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      assistantTextResponses.push(m.content);
    }
  }
  
  // Add result to persistent messages
  if (success && Object.keys(variables).length > 0) {
    const varSummary = Object.entries(variables)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    persistentMessages.push({
      role: 'assistant',
      content: `Task completed. Results: ${varSummary}`,
    });
  } else if (assistantTextResponses.length > 0) {
    persistentMessages.push({
      role: 'assistant',
      content: assistantTextResponses[assistantTextResponses.length - 1],
    });
  } else if (success) {
    persistentMessages.push({
      role: 'assistant', 
      content: 'Task completed successfully.',
    });
  }

  debugLog('Persistent messages for next task:', persistentMessages.length, 'messages');

  return {
    success,
    outputs,
    variables,
    messages: persistentMessages,
  };
}

function getResponseMessages(response: unknown): ResponseMessage[] {
  if (!response || typeof response !== 'object') {
    return [];
  }

  const maybeMessages = (response as { messages?: unknown }).messages;
  return Array.isArray(maybeMessages) ? maybeMessages as ResponseMessage[] : [];
}

/**
 * Build the system prompt for the agent
 */
function buildSystemPrompt(
  taskDescription: string,
  outputVars: (string | TypedVar)[],
  tools: Map<string, ToolDefinition>
): string {
  const toolDescriptions: string[] = [];
  
  // Normalize outputVars to TypedVar[]
  const normalizedOutputVars: TypedVar[] = outputVars.map(v => 
    typeof v === 'string' ? { name: v, type: 'string' } : v
  );
  
  // Add finish tool description
  toolDescriptions.push('- finish(success: boolean): Signal task completion. Call finish(true) when done successfully, or finish(false) if the task cannot be completed.');
  
  // Add set_result tool if we have output variables
  if (normalizedOutputVars.length > 0) {
    const varList = normalizedOutputVars.map(v => {
      const typeStr = v.type === 'array' && v.itemType ? `array<${v.itemType}>` : v.type;
      return `"${v.name}" (${typeStr})`;
    }).join(', ');
    toolDescriptions.push(`- set_result(variable: string, value: any): Store a result value. Variable must be one of: ${varList}`);
  }
  
  // Add user-defined tools
  for (const [name, tool] of tools) {
    if (name === 'finish' || name === 'set_result') continue;
    
    // Build parameter signature from schema
    const params = tool.parameters;
    const props = (params.properties || {}) as Record<string, { type?: string; description?: string }>;
    const required = (params.required || []) as string[];
    
    const paramList = Object.entries(props)
      .map(([pname, pschema]) => {
        const opt = required.includes(pname) ? '' : '?';
        return `${pname}${opt}: ${pschema.type || 'any'}`;
      })
      .join(', ');
    
    toolDescriptions.push(`- ${name}(${paramList}): ${tool.description}`);
  }
  
  let prompt = `You are an AI agent executing a subtask within a larger workflow. Your job is to complete the following subtask:

Subtask: ${taskDescription}

Available tools:

${toolDescriptions.join('\n')}

Workflow:
1. Analyze the task and gather any needed information using available tools.
2. Once the task is complete, call finish(true).

If you determine the task cannot be completed, call finish(false) immediately.`;

  if (normalizedOutputVars.length > 0) {
    const varList = normalizedOutputVars.map(v => {
      const typeStr = v.type === 'array' && v.itemType ? `array<${v.itemType}>` : v.type;
      return `"${v.name}" (${typeStr})`;
    }).join(', ');
    
    prompt += `

IMPORTANT: You MUST use set_result() to store values for: ${varList}
Call set_result for each variable before calling finish.
The tool will enforce strict type checking based on the variable type.`;
  }

  prompt += `

CRITICAL INSTRUCTIONS:
- You MUST use the structured tool-calling interface to invoke tools.
- NEVER write code syntax like print(), default_api.X(), or function_name() in your text response.
- NEVER describe tool calls in text - actually invoke them using the tool interface.
- Each tool call should be a separate structured function call, not embedded in text.
- When storing values, pass simple strings without code formatting or escaping unless the type is 'string'.

EXAMPLES OF CORRECT TOOL USAGE:

To complete a task successfully, invoke the finish tool with:
  Tool: finish
  Arguments: { "success": true }

WRONG (do NOT do this):
- print(finish(success=true))
- default_api.set_result(variable="X", value="Y")
- I will now call finish(true)
- \`\`\`finish(success=true)\`\`\``;

  return prompt;
}
