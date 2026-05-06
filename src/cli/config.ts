/**
 * DeepClause CLI Configuration Module
 * 
 * Handles configuration loading, validation, and management.
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DEFAULT_MODEL_IDS,
  DEFAULT_TEMPERATURES,
  buildModelOverride,
  formatModelId,
  normalizeModelId,
  resolveModelSlotConfig,
  type ModelSlot,
  type Provider,
  type ResolvedModelConfig,
} from '../system/config/model-slots.js';

export type { ModelSlot, Provider, ResolvedModelConfig } from '../system/config/model-slots.js';
export { buildModelOverride } from '../system/config/model-slots.js';

// =============================================================================
// Configuration Schema
// =============================================================================

const MCPServerSchema = z.object({
  command: z.string().min(1, 'MCP server command is required'),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string()).optional().default({})
});

const MCPConfigSchema = z.object({
  servers: z.record(MCPServerSchema).optional().default({})
});

const AgentVMConfigSchema = z.object({
  /** Enable networking in the VM (default: false for security) */
  network: z.boolean().optional().default(false)
}).optional().default({ network: false });

const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional()
});

const ProvidersSchema = z.object({
  openai: ProviderConfigSchema.optional(),
  anthropic: ProviderConfigSchema.optional(),
  google: ProviderConfigSchema.optional(),
  openrouter: ProviderConfigSchema.optional()
}).optional().default({});

const ModelsSchema = z.object({
  gateway: z.string().min(1).default(DEFAULT_MODEL_IDS.gateway),
  run: z.string().min(1).default(DEFAULT_MODEL_IDS.run),
  compile: z.string().min(1).default(DEFAULT_MODEL_IDS.compile),
});

const TemperaturesSchema = z.object({
  gateway: z.number().min(0).max(2).default(DEFAULT_TEMPERATURES.gateway),
  run: z.number().min(0).max(2).default(DEFAULT_TEMPERATURES.run),
  compile: z.number().min(0).max(2).default(DEFAULT_TEMPERATURES.compile),
});

export const ConfigSchema = z.object({
  models: ModelsSchema.default(DEFAULT_MODEL_IDS),
  temperatures: TemperaturesSchema.default(DEFAULT_TEMPERATURES),
  providers: ProvidersSchema,
  mcp: MCPConfigSchema.optional().default({ servers: {} }),
  agentvm: AgentVMConfigSchema,
  dmlBase: z.string().optional().default('.deepclause/tools'),
  workspace: z.string().optional().default('./'),
  model: z.string().optional(),
  provider: z.enum(['openai', 'anthropic', 'google', 'openrouter']).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type MCPServer = z.infer<typeof MCPServerSchema>;

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: Config = {
  models: { ...DEFAULT_MODEL_IDS },
  temperatures: { ...DEFAULT_TEMPERATURES },
  providers: {},
  mcp: { servers: {} },
  agentvm: { network: false },
  dmlBase: '.deepclause/tools',
  workspace: './'
};

// =============================================================================
// Configuration Paths
// =============================================================================

export function getConfigDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.deepclause');
}

export function getConfigPath(workspaceRoot: string): string {
  return path.join(getConfigDir(workspaceRoot), 'config.json');
}

export function getToolsDir(workspaceRoot: string): string {
  return path.join(getConfigDir(workspaceRoot), 'tools');
}

// =============================================================================
// Configuration Operations
// =============================================================================

/**
 * Initialize DeepClause configuration in a workspace
 */
export async function initConfig(
  workspaceRoot: string,
  options: { force?: boolean; model?: string } = {}
): Promise<void> {
  const configDir = getConfigDir(workspaceRoot);
  const configPath = getConfigPath(workspaceRoot);
  const toolsDir = getToolsDir(workspaceRoot);

  // Check for existing config
  try {
    await fs.access(configPath);
    if (!options.force) {
      throw new Error(
        'Configuration already exists. Use --force to overwrite.'
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // Create directories
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(toolsDir, { recursive: true });

  // Create config with optional model override
  const initialModelId = options.model ? normalizeModelId(options.model) : DEFAULT_MODEL_IDS.run;
  const config: Config = {
    ...DEFAULT_CONFIG,
    models: {
      gateway: initialModelId,
      run: initialModelId,
      compile: initialModelId,
    },
  };

  // Write config
  await fs.writeFile(configPath, serializeConfig(config));

  // Create .gitignore for the .deepclause directory
  const gitignorePath = path.join(configDir, '.gitignore');
  const gitignoreContent = `# DeepClause generated files
*.meta.json

# Keep tools directory but ignore compiled files by default
# Uncomment to track compiled DML:
# !tools/*.dml
`;
  await fs.writeFile(gitignorePath, gitignoreContent);
}

/**
 * Load and validate configuration
 */
export async function loadConfig(workspaceRoot: string): Promise<Config> {
  const configPath = getConfigPath(workspaceRoot);

  let rawConfig: unknown;
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    rawConfig = JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Configuration not found at ${configPath}. Run 'deepclause init' first.`
      );
    }
    throw new Error(`Failed to read config: ${(error as Error).message}`);
  }

  // Resolve environment variables in config
  const resolvedConfig = resolveEnvVars(rawConfig);
  const migratedConfig = migrateLegacyConfig(resolvedConfig);

  // Validate
  return validateConfig(migratedConfig);
}

/**
 * Validate configuration object
 */
export function validateConfig(config: unknown): Config {
  const result = ConfigSchema.safeParse(config);
  
  if (!result.success) {
    const errors = result.error.issues
      .map(issue => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  return {
    ...result.data,
    models: {
      gateway: normalizeModelId(result.data.models.gateway),
      run: normalizeModelId(result.data.models.run),
      compile: normalizeModelId(result.data.models.compile),
    },
  };
}

/**
 * Parse a model string in either canonical provider:model form, legacy provider/model form,
 * or just model name form.
 */
export function parseModelString(modelString: string): string {
  return normalizeModelId(modelString);
}

/**
 * Format a model id as canonical provider:model
 */
export function formatModelString(modelId: string): string {
  return formatModelId(modelId);
}

/**
 * Set the default model in configuration.
 * When slot is omitted, all slots are updated for backward compatibility.
 */
export async function setModel(
  workspaceRoot: string,
  modelString: string,
  slot?: ModelSlot,
): Promise<{ modelId: string; updatedSlots: ModelSlot[] }> {
  const modelId = parseModelString(modelString);

  const config = await loadConfig(workspaceRoot);
  const updatedSlots: ModelSlot[] = slot ? [slot] : ['gateway', 'run', 'compile'];
  for (const nextSlot of updatedSlots) {
    config.models[nextSlot] = modelId;
  }

  const configPath = getConfigPath(workspaceRoot);
  await fs.writeFile(configPath, serializeConfig(config));
  
  return { modelId, updatedSlots };
}

/**
 * Get the current model configuration from configuration
 */
export async function showModel(workspaceRoot: string): Promise<{
  models: Record<ModelSlot, string>;
  temperatures: Record<ModelSlot, number>;
  formatted: string;
}> {
  const config = await loadConfig(workspaceRoot);
  const lines = (['gateway', 'run', 'compile'] as ModelSlot[]).map((slotName) => {
    const modelId = formatModelString(config.models[slotName]);
    const temperature = config.temperatures[slotName];
    return `${slotName}: ${modelId} (temperature=${temperature})`;
  });

  return {
    models: { ...config.models },
    temperatures: { ...config.temperatures },
    formatted: lines.join('\n'),
  };
}

export function resolveModelSlot(
  config: Config,
  slot: ModelSlot,
  overrides: { modelId?: string; temperature?: number } = {},
): ResolvedModelConfig {
  return resolveModelSlotConfig(config, slot, overrides);
}

export function applyResolvedModelConfig(selection: ResolvedModelConfig): void {
  if (!selection.apiKey) {
    return;
  }

  switch (selection.provider) {
    case 'openai':
      process.env.OPENAI_API_KEY = selection.apiKey;
      break;
    case 'anthropic':
      process.env.ANTHROPIC_API_KEY = selection.apiKey;
      break;
    case 'google':
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = selection.apiKey;
      break;
    case 'openrouter':
      process.env.OPENROUTER_API_KEY = selection.apiKey;
      break;
  }
}

export function getDefaultConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    models: { ...DEFAULT_CONFIG.models },
    temperatures: { ...DEFAULT_CONFIG.temperatures },
    providers: { ...DEFAULT_CONFIG.providers },
    mcp: { servers: {} },
    agentvm: { network: DEFAULT_CONFIG.agentvm?.network ?? false },
  };
}

/**
 * Update configuration with partial changes
 */
export async function updateConfig(
  workspaceRoot: string,
  updates: Partial<Config>
): Promise<Config> {
  const config = await loadConfig(workspaceRoot);
  const updated = {
    ...config,
    ...updates,
    models: { ...config.models, ...updates.models },
    temperatures: { ...config.temperatures, ...updates.temperatures },
    providers: { ...config.providers, ...updates.providers },
    mcp: updates.mcp ? { ...config.mcp, ...updates.mcp } : config.mcp,
    agentvm: updates.agentvm ? { ...config.agentvm, ...updates.agentvm } : config.agentvm,
  };
  
  // Re-validate
  const validated = validateConfig(updated);

  const configPath = getConfigPath(workspaceRoot);
  await fs.writeFile(configPath, serializeConfig(validated));

  return validated;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve environment variable references in configuration
 * Supports ${VAR_NAME} and $VAR_NAME syntax
 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    // Replace ${VAR} or $VAR patterns
    return obj.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/gi, (match, braced, plain) => {
      const varName = braced || plain;
      const value = process.env[varName];
      if (value === undefined) {
        // Return original if not found - allows for optional env vars
        return match;
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }

  return obj;
}

function migrateLegacyConfig(config: unknown): unknown {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return config;
  }

  const record = { ...(config as Record<string, unknown>) };
  const legacyModel = typeof record.model === 'string' ? record.model : undefined;
  const legacyProvider = typeof record.provider === 'string' ? record.provider as Provider : undefined;
  const legacyModelId = legacyModel ? buildModelOverride(legacyModel, legacyProvider) : undefined;

  const rawModels = record.models && typeof record.models === 'object' && !Array.isArray(record.models)
    ? record.models as Record<string, unknown>
    : {};
  const rawTemperatures = record.temperatures && typeof record.temperatures === 'object' && !Array.isArray(record.temperatures)
    ? record.temperatures as Record<string, unknown>
    : {};

  record.models = {
    gateway: typeof rawModels.gateway === 'string'
      ? normalizeModelId(rawModels.gateway)
      : legacyModelId ?? DEFAULT_MODEL_IDS.gateway,
    run: typeof rawModels.run === 'string'
      ? normalizeModelId(rawModels.run)
      : legacyModelId ?? DEFAULT_MODEL_IDS.run,
    compile: typeof rawModels.compile === 'string'
      ? normalizeModelId(rawModels.compile)
      : legacyModelId ?? DEFAULT_MODEL_IDS.compile,
  };

  record.temperatures = {
    gateway: coerceTemperature(rawTemperatures.gateway, DEFAULT_TEMPERATURES.gateway),
    run: coerceTemperature(rawTemperatures.run, DEFAULT_TEMPERATURES.run),
    compile: coerceTemperature(rawTemperatures.compile, DEFAULT_TEMPERATURES.compile),
  };

  return record;
}

function coerceTemperature(value: unknown, fallback: number): number {
  if (typeof value === 'number' && value >= 0 && value <= 2) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) {
      return parsed;
    }
  }
  return fallback;
}

function serializeConfig(config: Config): string {
  const { model, provider, ...rest } = config;
  return JSON.stringify(rest, null, 2) + '\n';
}

/**
 * Check if configuration exists
 */
export async function configExists(workspaceRoot: string): Promise<boolean> {
  try {
    await fs.access(getConfigPath(workspaceRoot));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of configured MCP servers
 */
export function getMCPServers(config: Config): Record<string, MCPServer> {
  return config.mcp?.servers || {};
}
