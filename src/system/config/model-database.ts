import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type ModelComplexity = 'high' | 'medium' | 'low';
export type ReasoningType = 'effort' | 'budget_tokens' | 'thinking_config' | 'none';

export interface ModelDatabaseEntry {
  name: string;
  reasoning: boolean;
  tool_call: boolean;
  structured_output: boolean;
  limit: { context: number; output: number };
  open_weights: boolean;
  complexity: ModelComplexity;
  family: string;
}

export interface ProviderDatabaseEntry {
  reasoning_type: ReasoningType;
  reasoning_values?: string[];
  budget_map?: Record<string, number>;
  default_effort?: string;
}

interface ModelDatabase {
  version: string;
  models: Record<string, ModelDatabaseEntry>;
  providers: Record<string, ProviderDatabaseEntry>;
}

let cachedDatabase: ModelDatabase | null = null;

function loadDatabase(): ModelDatabase {
  if (cachedDatabase) {
    return cachedDatabase;
  }
  const dbPath = join(__dirname, '..', 'assets', 'model-database.json');
  cachedDatabase = JSON.parse(readFileSync(dbPath, 'utf8')) as ModelDatabase;
  return cachedDatabase;
}

export function lookupModel(modelId: string): ModelDatabaseEntry | undefined {
  const db = loadDatabase();
  return db.models[modelId];
}

export function lookupProvider(providerName: string): ProviderDatabaseEntry | undefined {
  const db = loadDatabase();
  return db.providers[providerName];
}

export function getAllModels(): Record<string, ModelDatabaseEntry> {
  return loadDatabase().models;
}

export interface ResolvedModelCapabilities {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning: boolean;
  complexity: ModelComplexity;
  reasoningType: ReasoningType;
  reasoningValues?: string[];
  reasoningBudgetMap?: Record<string, number>;
  defaultEffort?: string;
}

export function resolveModelCapabilities(
  modelId: string,
  providerName: string,
): ResolvedModelCapabilities {
  const modelEntry = lookupModel(modelId);
  const providerEntry = lookupProvider(providerName);

  if (!modelEntry) {
    return {
      reasoning: false,
      complexity: 'medium',
      reasoningType: providerEntry?.reasoning_type ?? 'none',
      reasoningValues: providerEntry?.reasoning_values,
      reasoningBudgetMap: providerEntry?.budget_map,
      defaultEffort: providerEntry?.default_effort,
    };
  }

  return {
    contextWindow: modelEntry.limit.context,
    maxOutputTokens: modelEntry.limit.output,
    reasoning: modelEntry.reasoning,
    complexity: modelEntry.complexity,
    reasoningType: providerEntry?.reasoning_type ?? 'none',
    reasoningValues: providerEntry?.reasoning_values,
    reasoningBudgetMap: providerEntry?.budget_map,
    defaultEffort: providerEntry?.default_effort,
  };
}

export function buildReasoningProviderOptions(
  effort: string,
  reasoningType: ReasoningType,
  budgetMap?: Record<string, number>,
): Record<string, unknown> {
  if (effort === 'none' || reasoningType === 'none') {
    return {};
  }

  switch (reasoningType) {
    case 'effort':
      return { reasoning_effort: effort };

    case 'budget_tokens': {
      const budget = budgetMap?.[effort] ?? 16000;
      return { thinking: { type: 'enabled', budget_tokens: budget } };
    }

    case 'thinking_config': {
      const budget = budgetMap?.[effort] ?? 8192;
      return { thinkingConfig: { thinkingBudget: budget } };
    }

    default:
      return {};
  }
}
