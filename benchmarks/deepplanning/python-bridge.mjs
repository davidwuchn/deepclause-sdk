import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(BENCHMARKS_ROOT, 'python-bridge.py');

export async function callDeepPlanningTool(options) {
  const { domain, dbPath, toolName, args, benchDir, pythonPath } = options;
  const python = pythonPath ?? 'python3';
  const bridgeArgs = [
    BRIDGE_SCRIPT,
    '--domain', domain,
    '--db-path', dbPath,
    '--tool', toolName,
    '--args', JSON.stringify(args),
  ];
  if (benchDir) {
    bridgeArgs.push('--bench-dir', benchDir);
  }
  const result = await runCommand(python, bridgeArgs);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { raw: result.stdout };
  }
}

export async function loadToolSchemas(benchDir, domain) {
  const schemaFile = domain === 'shopping'
    ? path.join(benchDir, 'shoppingplanning', 'tools', 'shopping_tool_schema.json')
    : path.join(benchDir, 'travelplanning', 'tools', 'tool_schema_en.json');
  const content = await fs.readFile(schemaFile, 'utf8');
  const schemas = JSON.parse(content);
  const map = new Map();
  for (const entry of schemas) {
    if (entry.function) {
      map.set(entry.function.name, entry.function);
    }
  }
  return map;
}

export function findBenchDir() {
  const envDir = process.env.QWEN_AGENT_BENCH_DIR;
  if (envDir) {
    return envDir;
  }
  const candidates = [
    path.join(BENCHMARKS_ROOT, 'vendor', 'Qwen-Agent', 'benchmark', 'deepplanning'),
  ];
  for (const c of candidates) {
    if (fs.access(c).then(() => true).catch(() => false)) {
      return c;
    }
  }
  return null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.once('error', reject);
    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      const error = new Error(`${command} exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = exitCode;
      reject(error);
    });
  });
}
