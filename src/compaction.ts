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
}

export interface CompactorExecutionRequest {
  binding: ResolvedCompactorBinding;
  messages: MemoryMessage[];
  params: Record<string, unknown>;
}

export interface CompactorExecutionResponse {
  answer?: string;
  error?: string;
}

export interface AppliedCompactorResult {
  messages: MemoryMessage[];
  event: DMLEvent;
  applied: boolean;
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

export function estimateTokensForMessages(messages: MemoryMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokensForText(message.content), 0);
}

export function buildCompactorParams(
  binding: ResolvedCompactorBinding,
  messages: MemoryMessage[],
): Record<string, unknown> {
  return {
    compact_scope: binding.scope,
    compact_trigger: binding.trigger,
    compact_binding_name: binding.name ?? getBindingLabel(binding),
    message_count: messages.length,
    estimated_tokens: estimateTokensForMessages(messages),
    messages_json: JSON.stringify(messages),
  };
}

export async function executeCompactor(params: {
  binding: ResolvedCompactorBinding;
  messages: MemoryMessage[];
  execute: (request: CompactorExecutionRequest) => Promise<CompactorExecutionResponse>;
}): Promise<AppliedCompactorResult> {
  const beforeTokens = estimateTokensForMessages(params.messages);
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
    params: buildCompactorParams(params.binding, params.messages),
  };

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
    };
  }

  if (!parsed.messages) {
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
    };
  }

  const validationError = validateMessageArray(parsed.messages);
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
    };
  }

  const afterTokens = estimateTokensForMessages(parsed.messages);
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
    };
  }

  return {
    messages: parsed.messages,
    applied: true,
    event: buildCompactionEvent({
      binding: params.binding,
      action: 'applied',
      beforeTokens,
      afterTokens,
    }),
  };
}

export function parseCompactorAnswer(answer: string): ParsedCompactorDecision | null {
  const trimmed = answer.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed === 'no_op' || trimmed === 'skip') {
    return { apply: false };
  }

  const parsed = unwrapCompactorJson(tryParseJson(trimmed));
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
    : Boolean(record.messages ?? record.messages_out ?? record.memory ?? record.memory_out);
  if (!apply) {
    return { apply: false };
  }

  const rawMessages = record.messages ?? record.messages_out ?? record.memory ?? record.memory_out;
  const messages = normalizeMessageArray(rawMessages);
  if (!messages) {
    return null;
  }

  return {
    apply: true,
    messages,
  };
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
  afterTokens: number;
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
  afterTokens: number;
  error?: string;
}): string {
  const label = params.binding.name ?? getBindingLabel(params.binding);
  const errorSuffix = params.error ? ` (${params.error})` : '';
  return `compact ${params.binding.scope}.${params.binding.trigger} ${params.action} ${label} ${params.beforeTokens} -> ${params.afterTokens} tokens${errorSuffix}`;
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

function unwrapCompactorJson(value: unknown): unknown | null {
  if (typeof value !== 'string') {
    return value ?? null;
  }

  return tryParseJson(value);
}
