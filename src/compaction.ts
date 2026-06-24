import type {
  CompactionAction,
  CompactionOptions,
  CompactionScope,
  CompactionTrigger,
  CompactorBinding,
  CompactorDefinition,
  DMLEvent,
  MemoryMessage,
  ToolPolicy,
} from './types.js';
import type {
  Provider,
  ProviderConfig,
  ResolvedModelConfig,
} from './system/config/model-slots.js';

const DEFAULT_DML_COMPACTOR_TIMEOUT_MS = 15_000;

export interface ResolvedCompactorDefinition {
  source: string;
  sourceType: 'inline' | 'file' | 'auto';
  timeoutMs: number;
  gasLimit?: number;
  model?: string;
  provider?: 'openai' | 'anthropic' | 'google' | 'openrouter';
  inheritTools: boolean;
  toolPolicy?: ToolPolicy | null;
}

export interface ResolvedCompactorBinding {
  name?: string;
  scope: CompactionScope;
  trigger: CompactionTrigger;
  compactor: ResolvedCompactorDefinition;
}

export interface ResolvedCompactionOptions {
  enabled: boolean;
  bindings: ResolvedCompactorBinding[];
}

export interface ParsedCompactorDecision {
  apply: boolean;
  messages?: MemoryMessage[];
  rewrite?: CompactorRewriteSpec;
}

export interface CompactorRewriteSpec {
  keepLastMessages: number;
  summary: string;
}

export interface CompactorExecutionRequest {
  binding: ResolvedCompactorBinding;
  messages: MemoryMessage[];
  params: Record<string, unknown>;
}

export interface CompactorExecutionResponse {
  answer?: string;
  error?: string;
  usageByModel?: import('./system/runtime/token-usage.js').TokenUsageByModel;
}

export interface AppliedCompactorResult {
  messages: MemoryMessage[];
  event: DMLEvent;
  applied: boolean;
  usageByModel?: import('./system/runtime/token-usage.js').TokenUsageByModel;
}

export interface ResolvedCompactorModelConfig {
  model: string;
  modelId: string;
  provider: Provider;
  apiKey?: string;
  baseUrl?: string;
  temperature: number;
  maxOutputTokens?: number;
}

export function resolveCompactionOptions(
  base?: CompactionOptions,
  override?: CompactionOptions,
): ResolvedCompactionOptions | null {
  const enabled = override?.enabled ?? base?.enabled ?? false;
  if (!enabled) {
    return null;
  }

  const bindings = [
    ...(base?.bindings ?? []),
    ...(override?.bindings ?? []),
  ].map(resolveBinding);

  if (bindings.length === 0) {
    return null;
  }

  return {
    enabled: true,
    bindings,
  };
}

export function resolveBinding(binding: CompactorBinding): ResolvedCompactorBinding {
  return {
    name: binding.name,
    scope: binding.scope,
    trigger: binding.trigger,
    compactor: resolveCompactorDefinition(binding.compactor),
  };
}

export function resolveCompactorDefinition(definition: CompactorDefinition): ResolvedCompactorDefinition {
  return {
    source: definition.source,
    sourceType: definition.sourceType ?? 'auto',
    timeoutMs: Math.max(0, definition.timeoutMs ?? DEFAULT_DML_COMPACTOR_TIMEOUT_MS),
    gasLimit: definition.gasLimit,
    model: definition.model,
    provider: definition.provider,
    inheritTools: definition.inheritTools ?? false,
    toolPolicy: definition.toolPolicy,
  };
}

export function getCompactionBindings(
  options: ResolvedCompactionOptions | null,
  scope: CompactionScope,
  trigger: CompactionTrigger,
): ResolvedCompactorBinding[] {
  if (!options) {
    return [];
  }

  return options.bindings.filter((binding) => binding.scope === scope && binding.trigger === trigger);
}

export function estimateTokensForText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const PER_MESSAGE_OVERHEAD = 4;

export function estimateTokensForMessages(messages: MemoryMessage[]): number {
  return messages.reduce(
    (total, message) => total + PER_MESSAGE_OVERHEAD + estimateTokensForText(message.content),
    0,
  );
}

export function detectProviderFromModel(model: string): Provider {
  const lower = model.toLowerCase();
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) {
    return 'openai';
  }
  if (lower.includes('claude')) {
    return 'anthropic';
  }
  if (lower.includes('gemini') || lower.includes('palm')) {
    return 'google';
  }
  return 'openrouter';
}

export function resolveCompactorModelConfig(params: {
  binding: ResolvedCompactorBinding;
  selection: ResolvedModelConfig;
  providerConfigs?: Partial<Record<Provider, ProviderConfig>>;
  baseUrl?: string;
}): ResolvedCompactorModelConfig {
  const model = params.binding.compactor.model ?? params.selection.model;
  const provider = params.binding.compactor.provider
    ?? (params.binding.compactor.model ? detectProviderFromModel(model) : params.selection.provider);
  const providerConfig = provider === params.selection.provider
    ? {
      apiKey: params.selection.apiKey,
      baseUrl: params.baseUrl ?? params.selection.baseUrl,
    }
    : {
      apiKey: params.providerConfigs?.[provider]?.apiKey,
      baseUrl: params.baseUrl ?? params.providerConfigs?.[provider]?.baseUrl,
    };

  return {
    model,
    modelId: params.binding.compactor.model ?? params.selection.id,
    provider,
    apiKey: providerConfig.apiKey,
    baseUrl: providerConfig.baseUrl,
    temperature: params.selection.temperature,
    maxOutputTokens: params.selection.maxOutputTokens,
  };
}

export function buildCompactorParams(
  binding: ResolvedCompactorBinding,
  messages: MemoryMessage[],
  knownInputTokens?: number,
  maxContextTokens?: number,
): Record<string, unknown> {
  return {
    compact_scope: binding.scope,
    compact_trigger: binding.trigger,
    compact_binding_name: binding.name ?? getBindingLabel(binding),
    message_count: messages.length,
    estimated_tokens: knownInputTokens ?? estimateTokensForMessages(messages),
    max_context_tokens: maxContextTokens ?? 0,
    messages_json: JSON.stringify(messages),
  };
}

export async function executeCompactor(params: {
  binding: ResolvedCompactorBinding;
  messages: MemoryMessage[];
  knownInputTokens?: number;
  maxContextTokens?: number;
  execute: (request: CompactorExecutionRequest) => Promise<CompactorExecutionResponse>;
  emitEvent?: (event: DMLEvent) => void;
}): Promise<AppliedCompactorResult> {
  const estimatedTokens = params.knownInputTokens ?? estimateTokensForMessages(params.messages);
  const beforeTokens = estimatedTokens;
  if (params.messages.length === 0) {
    return {
      messages: params.messages,
      applied: false,
      event: buildCompactionEvent({
        binding: params.binding,
        action: 'skipped',
        beforeTokens,
        afterTokens: beforeTokens,
      }),
    };
  }

  const request: CompactorExecutionRequest = {
    binding: params.binding,
    messages: params.messages,
    params: buildCompactorParams(params.binding, params.messages, params.knownInputTokens, params.maxContextTokens),
  };

  params.emitEvent?.(buildCompactionEvent({
    binding: params.binding,
    action: 'running',
    beforeTokens,
  }));

  let response: CompactorExecutionResponse;
  try {
    response = await params.execute(request);
  } catch (error) {
    return {
      messages: params.messages,
      applied: false,
      event: buildCompactionEvent({
        binding: params.binding,
        action: 'failed',
        beforeTokens,
        afterTokens: beforeTokens,
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  if (response.error) {
    return {
      messages: params.messages,
      applied: false,
      event: buildCompactionEvent({
        binding: params.binding,
        action: 'failed',
        beforeTokens,
        afterTokens: beforeTokens,
        error: response.error,
      }),
      usageByModel: response.usageByModel,
    };
  }

  const parsed = parseCompactorAnswer(response.answer ?? '');
  if (!parsed) {
    return {
      messages: params.messages,
      applied: false,
      event: buildCompactionEvent({
        binding: params.binding,
        action: 'failed',
        beforeTokens,
        afterTokens: beforeTokens,
        error: 'Compactor returned an unreadable response',
      }),
      usageByModel: response.usageByModel,
    };
  }

  if (!parsed.apply) {
    return {
      messages: params.messages,
      applied: false,
      event: buildCompactionEvent({
        binding: params.binding,
        action: 'skipped',
        beforeTokens,
        afterTokens: beforeTokens,
      }),
      usageByModel: response.usageByModel,
    };
  }

  const rewrittenMessages = !parsed.messages && parsed.rewrite
    ? applyCompactorRewrite(params.binding, params.messages, parsed.rewrite)
    : parsed.messages;

  if (!rewrittenMessages) {
    return {
      messages: params.messages,
      applied: false,
      event: buildCompactionEvent({
        binding: params.binding,
        action: 'failed',
        beforeTokens,
        afterTokens: beforeTokens,
        error: 'Compactor applied but did not return messages',
      }),
      usageByModel: response.usageByModel,
    };
  }

  const validationError = validateMessageArray(rewrittenMessages);
  if (validationError) {
    return {
      messages: params.messages,
      applied: false,
      event: buildCompactionEvent({
        binding: params.binding,
        action: 'failed',
        beforeTokens,
        afterTokens: beforeTokens,
        error: validationError,
      }),
      usageByModel: response.usageByModel,
    };
  }

  const afterTokens = estimateTokensForMessages(rewrittenMessages);
  if (afterTokens >= beforeTokens) {
    return {
      messages: params.messages,
      applied: false,
      event: buildCompactionEvent({
        binding: params.binding,
        action: 'skipped',
        beforeTokens,
        afterTokens,
        error: 'Compactor did not reduce message size',
      }),
      usageByModel: response.usageByModel,
    };
  }

  return {
    messages: rewrittenMessages,
    applied: true,
    event: buildCompactionEvent({
      binding: params.binding,
      action: 'applied',
      beforeTokens,
      afterTokens,
    }),
    usageByModel: response.usageByModel,
  };
}

export function parseCompactorAnswer(answer: string): ParsedCompactorDecision | null {
  const trimmed = answer.trim();
  if (!trimmed) {
    return null;
  }

  const rewriteSpec = parseCompactorRewriteSpec(trimmed);
  if (rewriteSpec) {
    return rewriteSpec;
  }

  if (trimmed === 'no_op' || trimmed === 'skip') {
    return { apply: false };
  }

  const parsed = unwrapCompactorJson(tryParseCompactorJson(trimmed));
  if (!parsed || typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const action = typeof record.action === 'string' ? record.action : undefined;
  if (action === 'no_op' || action === 'skip' || action === 'noop') {
    return { apply: false };
  }

  const apply = typeof record.apply === 'boolean'
    ? record.apply
    : Boolean(
      record.messages
      ?? record.messages_out
      ?? record.memory
      ?? record.memory_out
      ?? record.summary
      ?? record.compacted_summary,
    );
  if (!apply) {
    return { apply: false };
  }

  const rawMessages = record.messages ?? record.messages_out ?? record.memory ?? record.memory_out;
  const messages = normalizeMessageArray(rawMessages);
  if (messages) {
    return {
      apply: true,
      messages,
    };
  }

  const rewrite = parseCompactorRewriteRecord(record);
  if (!rewrite) {
    return null;
  }

  return {
    apply: true,
    rewrite,
  };
}

export function applyCompactorRewrite(
  binding: ResolvedCompactorBinding,
  messages: MemoryMessage[],
  rewrite: CompactorRewriteSpec,
): MemoryMessage[] | null {
  const summary = rewrite.summary.trim();
  if (!summary) {
    return null;
  }

  const keepLastMessages = clampKeepLastMessages(rewrite.keepLastMessages);
  const summaryMessage: MemoryMessage = {
    role: 'assistant',
    content: summary,
  };

  if (binding.scope === 'session') {
    return [
      summaryMessage,
      ...messages.slice(-keepLastMessages),
    ];
  }

  const systemMessages = messages.filter((message) => message.role === 'system');
  const conversationalMessages = messages.filter((message) => message.role !== 'system');

  return [
    ...systemMessages,
    summaryMessage,
    ...conversationalMessages.slice(-keepLastMessages),
  ];
}

export function normalizeMessageArray(value: unknown): MemoryMessage[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const messages: MemoryMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = record.content;
    if ((role !== 'system' && role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return null;
    }

    messages.push({ role, content });
  }

  return messages;
}

export function validateMessageArray(messages: MemoryMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
      return `Invalid message role: ${String(message.role)}`;
    }
    if (typeof message.content !== 'string') {
      return 'Message content must be a string';
    }
  }

  return null;
}

export function buildCompactionEvent(params: {
  binding: ResolvedCompactorBinding;
  action: CompactionAction;
  beforeTokens: number;
  afterTokens?: number;
  error?: string;
}): DMLEvent {
  return {
    type: 'memory_compaction',
    content: formatCompactionEventContent(params),
    compactionScope: params.binding.scope,
    compactionTrigger: params.binding.trigger,
    compactionAction: params.action,
    compactionBindingName: params.binding.name,
    beforeTokens: params.beforeTokens,
    afterTokens: params.afterTokens,
    compactionError: params.error,
  };
}

export function formatCompactionEventContent(params: {
  binding: ResolvedCompactorBinding;
  action: CompactionAction;
  beforeTokens: number;
  afterTokens?: number;
  error?: string;
}): string {
  const label = params.binding.name ?? getBindingLabel(params.binding);
  const errorSuffix = params.error ? ` (${params.error})` : '';
  if (params.action === 'running') {
    return `compact ${params.binding.scope}.${params.binding.trigger} running ${label} ${params.beforeTokens} tokens${errorSuffix}`;
  }

  return `compact ${params.binding.scope}.${params.binding.trigger} ${params.action} ${label} ${params.beforeTokens} -> ${params.afterTokens ?? params.beforeTokens} tokens${errorSuffix}`;
}

export function getBindingLabel(binding: ResolvedCompactorBinding): string {
  return `${binding.scope}:${binding.trigger}`;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tryParseCompactorJson(value: string): unknown | null {
  const direct = tryParseJson(value);
  if (direct !== null) {
    return direct;
  }

  const fenced = extractFencedJson(value);
  if (!fenced) {
    return null;
  }

  return tryParseJson(fenced);
}

function extractFencedJson(value: string): string | null {
  const match = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match?.[1]?.trim() || null;
}

function unwrapCompactorJson(value: unknown): unknown | null {
  if (typeof value !== 'string') {
    return value ?? null;
  }

  return tryParseJson(value);
}

function parseCompactorRewriteRecord(record: Record<string, unknown>): CompactorRewriteSpec | null {
  const summary = typeof record.summary === 'string'
    ? record.summary
    : typeof record.compacted_summary === 'string'
      ? record.compacted_summary
      : null;
  if (!summary) {
    return null;
  }

  const keepLastMessages = parseKeepLastMessages(
    record.keep_last_messages
    ?? record.keepLastMessages
    ?? record.tail_messages
    ?? record.tailMessages,
  );
  if (keepLastMessages === null) {
    return null;
  }

  return {
    keepLastMessages,
    summary,
  };
}

function parseCompactorRewriteSpec(answer: string): ParsedCompactorDecision | null {
  if (!answer.startsWith('DC_COMPACTOR_REWRITE_V1\n')) {
    return null;
  }

  const withoutPrefix = answer.slice('DC_COMPACTOR_REWRITE_V1\n'.length);
  const summaryMarker = '\nsummary:\n';
  const summaryIndex = withoutPrefix.indexOf(summaryMarker);
  if (summaryIndex === -1) {
    return null;
  }

  const header = withoutPrefix.slice(0, summaryIndex);
  const summary = withoutPrefix.slice(summaryIndex + summaryMarker.length);
  const headerLines = header.split('\n').map((line) => line.trim()).filter(Boolean);
  const applyLine = headerLines.find((line) => line.startsWith('apply='));
  const keepLine = headerLines.find((line) => line.startsWith('keep_last_messages='));
  if (!applyLine || !keepLine) {
    return null;
  }

  const applyValue = applyLine.slice('apply='.length).trim();
  if (applyValue === 'false') {
    return { apply: false };
  }
  if (applyValue !== 'true') {
    return null;
  }

  const keepLastMessages = parseKeepLastMessages(keepLine.slice('keep_last_messages='.length).trim());
  if (keepLastMessages === null) {
    return null;
  }

  return {
    apply: true,
    rewrite: {
      keepLastMessages,
      summary,
    },
  };
}

function parseKeepLastMessages(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function clampKeepLastMessages(value: number): number {
  return Math.max(0, Math.min(8, value));
}
