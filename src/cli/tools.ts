/**
 * DeepClause CLI - Tool Resolution Module
 * 
 * Handles MCP server connections and tool discovery.
 */

import { Config, getMCPServers, MCPServer } from './config.js';

// =============================================================================
// Types
// =============================================================================

export interface Tool {
  name: string;
  description: string;
  provider: string;
  schema?: object;
  error?: string;
}

export interface ListToolsOptions {
  json?: boolean;
}

// =============================================================================
// Built-in runtime tools
// =============================================================================

const AGENTVM_TOOLS: Tool[] = [
  {
    name: 'vm_exec',
    description: 'Execute a shell command using the active workspace shell backend. With --sandbox, this runs inside AgentVM.',
    provider: 'agentvm',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute (e.g., "python3 script.py", "echo hello", "ls -la")' }
      },
      required: ['command']
    }
  },
  {
    name: 'bash',
    description: 'Execute a shell command in the active workspace shell. Alias of vm_exec.',
    provider: 'agentvm',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' }
      },
      required: ['command']
    }
  },
  {
    name: 'url_fetch',
    description: 'Fetch a URL and optionally save the response into the workspace.',
    provider: 'agentvm',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to fetch' },
        save_to: { type: 'string', description: 'Optional workspace-relative output file' }
      },
      required: ['url']
    }
  }
];

// =============================================================================
// Built-in Search Tools
// =============================================================================

const SEARCH_TOOLS: Tool[] = [
  {
    name: 'web_search',
    description: 'Search the web. Uses Brave Search API if BRAVE_API_KEY is set, otherwise falls back to Bing (no key required).',
    provider: 'brave',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results (default: 10, max: 20)' },
        freshness: { type: 'string', description: 'Filter by freshness: pd (past day), pw (past week), pm (past month), py (past year)' }
      },
      required: ['query']
    }
  },
  {
    name: 'news_search',
    description: 'Search for recent news articles. Uses Brave Search API if BRAVE_API_KEY is set, otherwise falls back to Bing (no key required).',
    provider: 'brave',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results (default: 10, max: 20)' },
        freshness: { type: 'string', description: 'Filter by freshness: pd (past day), pw (past week), pm (past month)' }
      },
      required: ['query']
    }
  }
];

// =============================================================================
// Tool Resolution
// =============================================================================

/**
 * List all available built-in runtime tools, search tools, and configured MCP servers
 */
export async function listTools(
  workspaceRoot: string,
  options: ListToolsOptions = {}
): Promise<Tool[] | string> {
  const { loadConfig } = await import('./config.js');
  const config = await loadConfig(workspaceRoot);
  
  const tools: Tool[] = [...AGENTVM_TOOLS, ...SEARCH_TOOLS];
  
  // Get tools from MCP servers
  const mcpServers = getMCPServers(config);
  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    try {
      const serverTools = await getToolsFromMCPServer(serverName, serverConfig);
      tools.push(...serverTools);
    } catch (error) {
      // Add error entry for failed server
      tools.push({
        name: `[${serverName}]`,
        description: `Failed to connect: ${(error as Error).message}`,
        provider: serverName,
        error: (error as Error).message
      });
    }
  }
  
  if (options.json) {
    return JSON.stringify(tools, null, 2);
  }
  
  return formatToolsList(tools);
}

/**
 * Resolve specific tools by name, verifying they are available
 */
export async function resolveTools(
  config: Config,
  toolNames: string[]
): Promise<Record<string, Tool>> {
  const resolved: Record<string, Tool> = {};
  const missing: string[] = [];
  
  // All built-in tools (runtime shell + search)
  const builtInTools = [...AGENTVM_TOOLS, ...SEARCH_TOOLS];
  
  // Check built-in tools first
  for (const name of toolNames) {
    const builtInTool = builtInTools.find(t => t.name === name);
    if (builtInTool) {
      resolved[name] = builtInTool;
    }
  }
  
  // Check MCP servers for remaining tools
  const remainingTools = toolNames.filter(name => !resolved[name]);
  if (remainingTools.length > 0) {
    const mcpServers = getMCPServers(config);
    
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      try {
        const serverTools = await getToolsFromMCPServer(serverName, serverConfig);
        for (const tool of serverTools) {
          if (remainingTools.includes(tool.name) && !resolved[tool.name]) {
            resolved[tool.name] = tool;
          }
        }
      } catch {
        // Server failed, continue checking others
      }
    }
  }
  
  // Check for missing tools
  for (const name of toolNames) {
    if (!resolved[name]) {
      missing.push(name);
    }
  }
  
  if (missing.length > 0) {
    throw new Error(`Missing tools: ${missing.join(', ')}. Configure MCP servers or check tool names.`);
  }
  
  return resolved;
}

/**
 * Check if all required tools are available
 */
export async function verifyTools(
  config: Config,
  toolNames: string[]
): Promise<{ available: boolean; missing: string[] }> {
  try {
    await resolveTools(config, toolNames);
    return { available: true, missing: [] };
  } catch (error) {
    const match = (error as Error).message.match(/Missing tools: (.+)\./);
    const missing = match ? match[1].split(', ') : toolNames;
    return { available: false, missing };
  }
}

// =============================================================================
// MCP Server Integration
// =============================================================================

/**
 * Get tools from an MCP server
 */
async function getToolsFromMCPServer(
  serverName: string,
  serverConfig: MCPServer
): Promise<Tool[]> {
  // Use the MCP module for server connection
  const { getMCPServerTools } = await import('./mcp.js');
  return getMCPServerTools(serverName, serverConfig);
}

// =============================================================================
// Formatting
// =============================================================================

function formatToolsList(tools: Tool[]): string {
  const byProvider = new Map<string, Tool[]>();
  
  for (const tool of tools) {
    const existing = byProvider.get(tool.provider) || [];
    existing.push(tool);
    byProvider.set(tool.provider, existing);
  }
  
  const lines: string[] = [];
  
  for (const [provider, providerTools] of byProvider) {
    let icon: string;
    let type: string;
    
    switch (provider) {
      case 'agentvm':
        icon = '🖥️';
        type = 'built-in';
        break;
      case 'brave':
        icon = '🔍';
        type = 'built-in';
        break;
      default:
        icon = '📦';
        type = 'MCP';
    }
    
    lines.push(`${icon} ${provider} (${type})`);
    
    for (const tool of providerTools) {
      if (tool.error) {
        lines.push(`  ⚠️  ${tool.name} - ${tool.description}`);
      } else {
        lines.push(`  ├─ ${tool.name} - ${tool.description}`);
      }
    }
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Get all built-in tools (runtime shell + search)
 */
export function getAgentVMTools(): Tool[] {
  return [...AGENTVM_TOOLS, ...SEARCH_TOOLS];
}
