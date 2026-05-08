import * as fs from 'fs/promises';
import * as path from 'path';
import { newsSearch, webSearch } from '../../cli/search.js';
import type { Config } from '../../cli/config.js';
import type { DeepClauseSDK } from '../../types.js';
import type { ShellManager } from './shell-manager.js';

const BUILT_IN_RUNTIME_TOOLS = new Set([
  'vm_exec',
  'bash',
  'web_search',
  'news_search',
  'url_fetch',
]);

const INTERNAL_TOOLS = new Set(['ask_user', 'finish', 'set_result', 'store']);

export function getBuiltInRuntimeToolNames(): string[] {
  return [...BUILT_IN_RUNTIME_TOOLS].sort();
}

export function verifyRuntimeToolsAvailable(
  config: Config,
  toolNames: string[],
): { available: boolean; missing: string[] } {
  const missing = toolNames.filter((name) => {
    if (INTERNAL_TOOLS.has(name)) {
      return false;
    }
    return !BUILT_IN_RUNTIME_TOOLS.has(name);
  });

  if (missing.length === 0) {
    return { available: true, missing: [] };
  }

  if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
    return { available: true, missing: [] };
  }

  return { available: false, missing };
}

export function registerLocalRuntimeTools(
  sdk: DeepClauseSDK,
  options: {
    workspacePath: string;
    shell: ShellManager;
    signal?: AbortSignal;
  },
): void {
  sdk.registerTool('web_search', {
    description: 'Search the web for information.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        count: { type: 'number', description: 'Maximum result count.' },
        freshness: { type: 'string', description: 'Optional freshness filter.' },
      },
      required: ['query'],
    },
    execute: async (args) => webSearch({
      query: String(args.query ?? args.arg1 ?? ''),
      count: typeof args.count === 'number' ? args.count : 10,
      freshness: typeof args.freshness === 'string' ? args.freshness : undefined,
      signal: options.signal,
    }),
  });

  sdk.registerTool('news_search', {
    description: 'Search recent news.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        count: { type: 'number', description: 'Maximum result count.' },
        freshness: { type: 'string', description: 'Optional freshness filter.' },
      },
      required: ['query'],
    },
    execute: async (args) => newsSearch({
      query: String(args.query ?? args.arg1 ?? ''),
      count: typeof args.count === 'number' ? args.count : 10,
      freshness: typeof args.freshness === 'string' ? args.freshness : undefined,
      signal: options.signal,
    }),
  });

  sdk.registerTool('url_fetch', {
    description: 'Fetch a URL or save it into the workspace.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to fetch.' },
        headers: { type: 'object', description: 'Optional request headers.' },
        save_to: { type: 'string', description: 'Optional workspace-relative output file.' },
      },
      required: ['url'],
    },
    execute: async (args) => urlFetch(options.workspacePath, args, options.signal),
  });

  sdk.registerTool('bash', {
    description: 'Run a shell command in the active workspace shell.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
      },
      required: ['command'],
    },
    execute: async (args) => options.shell.exec(String(args.command ?? args.arg1 ?? ''), options.signal),
  });

  sdk.registerTool('vm_exec', {
    description: 'Execute a shell command using the active workspace shell backend.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
      },
      required: ['command'],
    },
    execute: async (args) => options.shell.exec(String(args.command ?? args.arg1 ?? ''), options.signal),
  });
}

export async function urlFetch(
  workspacePath: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = String(args.url ?? '');
  if (!url) {
    throw new Error('url is required');
  }

  const headers = isStringRecord(args.headers) ? args.headers : undefined;
  const response = await fetch(url, { headers, signal });
  const responseHeaders = Object.fromEntries(response.headers.entries());

  if (typeof args.save_to === 'string' && args.save_to.trim()) {
    const targetPath = resolveWorkspacePath(workspacePath, args.save_to);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, buffer);
    return {
      file_path: targetPath,
      size: buffer.byteLength,
      status: response.status,
      headers: responseHeaders,
    };
  }

  return {
    body: await response.text(),
    status: response.status,
    headers: responseHeaders,
  };
}

export function resolveWorkspacePath(workspacePath: string, filePath: string): string {
  if (!filePath) {
    throw new Error('Path is required');
  }

  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path must stay inside workspace: ${filePath}`);
  }
  return resolved;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}