/**
 * DeepClause CLI - Command Listing Module
 * 
 * Lists compiled DML commands and their metadata.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { configExists, ensureSystemOverrideSeeds, getSystemDir, getToolsDir } from './config.js';

// =============================================================================
// Types
// =============================================================================

export interface Parameter {
  name: string;
  position?: number;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface CommandInfo {
  name: string;
  displayName?: string;
  path: string;
  description: string;
  usage: string;
  parameters?: Parameter[];
  triggerPhrases?: string[];
  capabilities?: string[];
  tools?: string[];
  compiledAt?: string;
  model?: string;
}

export interface ListCommandsOptions {
  json?: boolean;
  detailed?: boolean;
}

interface MetaFile {
  version: string;
  source: string;
  sourceHash: string;
  compiledAt: string;
  model: string;
  name?: string;
  description: string;
  parameters: Parameter[];
  triggerPhrases?: string[];
  trigger_phrases?: string[];
  capabilities?: string[];
  tools: string[];
  history: Array<{
    version: number;
    timestamp: string;
    sourceHash: string;
    model: string;
  }>;
}

const SYSTEM_COMMAND_DEFINITIONS: ReadonlyArray<{
  name: string;
  description: string;
  parameters: Parameter[];
}> = [
  {
    name: 'plan',
    description: 'Creates a simple standalone DML plan file from a request and saves it under plans/ in your workspace.',
    parameters: [
      { name: 'request', description: 'What the generated plan should do', required: true, position: 0 },
    ],
  },
  {
    name: 'deep-planner',
    description: 'Generates a multi-strategy DML plan with multiple agent_main clauses. Prolog tries strategies in order via backtracking.',
    parameters: [
      { name: 'request', description: 'What the generated plan should do', required: true, position: 0 },
    ],
  },
  {
    name: 'security-planner',
    description: 'Generates a multi-strategy security analysis plan for finding bugs and vulnerabilities.',
    parameters: [
      { name: 'request', description: 'Target to analyze (directory, file pattern, or specific concern)', required: true, position: 0 },
    ],
  },
];

const SYSTEM_COMMAND_NAMES = new Set(SYSTEM_COMMAND_DEFINITIONS.map((definition) => definition.name));

// =============================================================================
// Command Listing
// =============================================================================

/**
 * List all compiled DML commands
 */
export async function listCommands(
  workspaceRoot: string,
  options: ListCommandsOptions = {}
): Promise<CommandInfo[]> {
  const toolsDir = getToolsDir(workspaceRoot);
  const commands: CommandInfo[] = [];

  if (await configExists(workspaceRoot)) {
    await ensureSystemOverrideSeeds(workspaceRoot);
  }
  
  let files: string[] = [];
  try {
    files = await fs.readdir(toolsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  
  // Find all .dml files
  const dmlFiles = files.filter((fileName) => {
    if (!fileName.endsWith('.dml')) {
      return false;
    }
    return !SYSTEM_COMMAND_NAMES.has(fileName.replace('.dml', ''));
  });
  
  for (const dmlFile of dmlFiles) {
    const name = dmlFile.replace('.dml', '');
    const metaPath = path.join(toolsDir, `${name}.meta.json`);
    const dmlPath = path.join(toolsDir, dmlFile);
    const commandPath = path.relative(workspaceRoot, dmlPath).replace(/\.dml$/, '');
    
    let meta: MetaFile | null = null;
    try {
      const content = await fs.readFile(metaPath, 'utf-8');
      meta = JSON.parse(content) as MetaFile;
    } catch {
      // No meta file, use defaults
    }

    const orderedParameters = orderParameters(meta?.parameters);
    
    const command: CommandInfo = {
      name,
      displayName: normalizeDisplayName(meta?.name),
      path: commandPath,
      description: meta?.description || 'No description available',
      usage: buildCliUsage(commandPath, orderedParameters),
    };
    
    if (options.detailed && meta) {
      command.parameters = orderedParameters;
      command.triggerPhrases = normalizeTriggerPhrases(meta);
      command.capabilities = humanizeCapabilities(meta.capabilities);
      command.tools = meta.tools;
      command.compiledAt = meta.compiledAt;
      command.model = meta.model;
    }
    
    commands.push(command);
  }

  commands.push(...await listSystemCommands(workspaceRoot, options));
  
  // Sort by name
  commands.sort((a, b) => a.name.localeCompare(b.name));
  
  return commands;
}

/**
 * Get information about a specific command
 */
export async function getCommand(
  workspaceRoot: string,
  name: string
): Promise<CommandInfo | null> {
  const systemCommand = await getSystemCommand(workspaceRoot, name);
  if (systemCommand) {
    return systemCommand;
  }

  const toolsDir = getToolsDir(workspaceRoot);
  const dmlPath = path.join(toolsDir, `${name}.dml`);
  const metaPath = path.join(toolsDir, `${name}.meta.json`);
  
  // Check if DML file exists
  try {
    await fs.access(dmlPath);
  } catch {
    return null;
  }
  
  let meta: MetaFile | null = null;
  try {
    const content = await fs.readFile(metaPath, 'utf-8');
    meta = JSON.parse(content) as MetaFile;
  } catch {
    // No meta file
  }

  const commandPath = path.relative(workspaceRoot, dmlPath).replace(/\.dml$/, '');
  const orderedParameters = orderParameters(meta?.parameters);
  
  return {
    name,
    displayName: normalizeDisplayName(meta?.name),
    path: commandPath,
    description: meta?.description || 'No description available',
    usage: buildCliUsage(commandPath, orderedParameters),
    parameters: orderedParameters,
    triggerPhrases: meta ? normalizeTriggerPhrases(meta) : undefined,
    capabilities: humanizeCapabilities(meta?.capabilities),
    tools: meta?.tools,
    compiledAt: meta?.compiledAt,
    model: meta?.model
  };
}

/**
 * Check if a command exists
 */
export async function commandExists(
  workspaceRoot: string,
  name: string
): Promise<boolean> {
  if (await getSystemCommand(workspaceRoot, name)) {
    return true;
  }

  const toolsDir = getToolsDir(workspaceRoot);
  const dmlPath = path.join(toolsDir, `${name}.dml`);
  
  try {
    await fs.access(dmlPath);
    return true;
  } catch {
    return false;
  }
}

async function listSystemCommands(
  workspaceRoot: string,
  options: ListCommandsOptions,
): Promise<CommandInfo[]> {
  if (!await configExists(workspaceRoot)) {
    return [];
  }

  const commands = await Promise.all(SYSTEM_COMMAND_DEFINITIONS.map((definition) => buildSystemCommand(workspaceRoot, definition, options)));
  return commands.filter((command): command is CommandInfo => command !== null);
}

async function getSystemCommand(workspaceRoot: string, name: string): Promise<CommandInfo | null> {
  const definition = SYSTEM_COMMAND_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition || !await configExists(workspaceRoot)) {
    return null;
  }

  return buildSystemCommand(workspaceRoot, definition, { detailed: true });
}

async function buildSystemCommand(
  workspaceRoot: string,
  definition: { name: string; description: string; parameters: Parameter[] },
  options: ListCommandsOptions,
): Promise<CommandInfo | null> {
  const dmlPath = path.join(getSystemDir(workspaceRoot), `${definition.name}.dml`);
  try {
    await fs.access(dmlPath);
  } catch {
    return null;
  }

  const commandPath = path.relative(workspaceRoot, dmlPath).replace(/\.dml$/, '');
  const orderedParameters = orderParameters(definition.parameters);
  return {
    name: definition.name,
    path: commandPath,
    description: definition.description,
    usage: buildCliUsage(commandPath, orderedParameters),
    parameters: options.detailed ? orderedParameters : undefined,
  };
}

function orderParameters(parameters: Parameter[] | undefined): Parameter[] | undefined {
  if (!parameters || parameters.length === 0) {
    return undefined;
  }

  return [...parameters]
    .map((parameter, index) => ({ parameter, index }))
    .sort((left, right) => (left.parameter.position ?? left.index) - (right.parameter.position ?? right.index))
    .map(({ parameter }) => parameter);
}

function buildCliUsage(commandPath: string, parameters: Parameter[] | undefined): string {
  const placeholders = (parameters ?? []).map(formatUsageParameter);
  return ['deepclause', 'run', commandPath, ...placeholders].join(' ').trim();
}

function formatUsageParameter(parameter: Parameter): string {
  if (parameter.required === false || parameter.default !== undefined) {
    return parameter.default !== undefined
      ? `[${parameter.name}=${parameter.default}]`
      : `[${parameter.name}]`;
  }

  return `<${parameter.name}>`;
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTriggerPhrases(meta: MetaFile): string[] | undefined {
  const source = Array.isArray(meta.triggerPhrases)
    ? meta.triggerPhrases
    : (Array.isArray(meta.trigger_phrases) ? meta.trigger_phrases : undefined);

  if (!source || source.length === 0) {
    return undefined;
  }

  const triggerPhrases = Array.from(new Set(source
    .filter((phrase) => typeof phrase === 'string')
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0)));

  return triggerPhrases.length > 0 ? triggerPhrases : undefined;
}

function humanizeCapabilities(capabilities: string[] | undefined): string[] | undefined {
  if (!capabilities || capabilities.length === 0) {
    return undefined;
  }

  return capabilities.map((capability) => humanizeCapability(capability));
}

function humanizeCapability(capability: string): string {
  switch (capability) {
    case 'file_io':
      return 'Reads or writes workspace files';
    case 'network':
      return 'Uses network access';
    case 'shell':
      return 'Runs shell commands';
    default: {
      const normalized = capability.replace(/_/g, ' ').trim();
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }
  }
}
