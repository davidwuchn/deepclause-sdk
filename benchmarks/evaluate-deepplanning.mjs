#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARKS_ROOT, '..', '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.run && !args.runDir) {
    throw new Error('--run <run-id> is required');
  }

  const runRoot = args.runDir
    ? path.resolve(REPO_ROOT, args.runDir)
    : path.resolve(REPO_ROOT, args.runRoot ?? 'benchmarks/runs', args.run);

  if (!await fileExists(runRoot)) {
    throw new Error(`Run directory not found: ${runRoot}`);
  }

  const benchDir = resolveBenchDir(args);
  if (!benchDir) {
    throw new Error('Qwen-Agent benchmark directory not found. Set --bench-dir or QWEN_AGENT_BENCH_DIR.');
  }

  const domains = args.domains.length > 0
    ? args.domains
    : await detectDomains(runRoot);

  if (domains.length === 0) {
    throw new Error(`No domain subdirectories found in ${runRoot}`);
  }

  console.log(`Evaluating domains: ${domains.join(', ')}`);

  for (const domain of domains) {
    const instancesDir = path.join(runRoot, domain, 'instances');
    if (!await fileExists(instancesDir)) {
      console.log(`[${domain}] No instances directory, skipping`);
      continue;
    }

    const entries = await fs.readdir(instancesDir, { withFileTypes: true });
    const instanceDirs = entries.filter((e) => e.isDirectory());
    if (instanceDirs.length === 0) {
      console.log(`[${domain}] No instance directories, skipping`);
      continue;
    }

    console.log(`\n[${domain}] Evaluating ${instanceDirs.length} instances`);
    const evalDir = path.join(runRoot, domain, 'evaluation');
    await fs.mkdir(evalDir, { recursive: true });

    if (domain === 'shopping') {
      await evaluateShopping(benchDir, instancesDir, instanceDirs, evalDir);
    } else if (domain === 'travel') {
      await evaluateTravel(benchDir, instancesDir, instanceDirs, evalDir);
    }

    console.log(`[${domain}] Results written to ${evalDir}`);
  }
}

async function detectDomains(runRoot) {
  const domains = [];
  for (const candidate of ['shopping', 'travel']) {
    const instancesDir = path.join(runRoot, candidate, 'instances');
    if (await fileExists(instancesDir)) {
      domains.push(candidate);
    }
  }
  return domains;
}

async function evaluateShopping(benchDir, instancesDir, instanceDirs, evalDir) {
  const evalScript = path.join(benchDir, 'shoppingplanning', 'evaluation', 'evaluation_pipeline.py');
  if (!await fileExists(evalScript)) {
    throw new Error(`Shopping evaluation script not found: ${evalScript}`);
  }

  for (const entry of instanceDirs) {
    const resultPath = path.join(instancesDir, entry.name, 'result.json');
    let result;
    try {
      result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch {
      console.warn(`  Skipping ${entry.name}: no result.json`);
      continue;
    }

    if (!result.agentOutput) {
      console.warn(`  Skipping ${entry.name}: no agent output`);
      continue;
    }

    const caseDir = path.join(benchDir, 'shoppingplanning', 'database', `case_${result.taskId}`);
    const outputPath = path.join(evalDir, `${entry.name}_eval.json`);

    try {
      await runCommand('python3', [
        evalScript,
        '--prediction', result.agentOutput,
        '--case-dir', caseDir,
        '--output', outputPath,
      ], { cwd: benchDir });
    } catch (error) {
      console.warn(`  Eval failed for ${entry.name}: ${error.message}`);
    }
  }
}

async function evaluateTravel(benchDir, instancesDir, instanceDirs, evalDir) {
  const evalScript = path.join(benchDir, 'travelplanning', 'evaluation', 'eval_converted.py');
  const convertScript = path.join(benchDir, 'travelplanning', 'evaluation', 'convert_report.py');

  for (const entry of instanceDirs) {
    const resultPath = path.join(instancesDir, entry.name, 'result.json');
    let result;
    try {
      result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch {
      console.warn(`  Skipping ${entry.name}: no result.json`);
      continue;
    }

    if (!result.agentOutput) {
      console.warn(`  Skipping ${entry.name}: no agent output`);
      continue;
    }

    const planPath = path.join(evalDir, `${entry.name}_plan.txt`);
    await fs.writeFile(planPath, result.agentOutput, 'utf8');

    const convertedPath = path.join(evalDir, `${entry.name}_converted.json`);
    try {
      await runCommand('python3', [
        convertScript,
        '--input', planPath,
        '--output', convertedPath,
      ], { cwd: benchDir });
    } catch (error) {
      console.warn(`  Conversion failed for ${entry.name}: ${error.message}`);
      continue;
    }

    const dbDir = result.dbPath ?? path.join(benchDir, 'travelplanning', 'database', 'database_en', String(result.taskId));
    const evalOutputPath = path.join(evalDir, `${entry.name}_eval.json`);
    try {
      await runCommand('python3', [
        evalScript,
        '--plan', convertedPath,
        '--db-dir', dbDir,
        '--output', evalOutputPath,
      ], { cwd: benchDir });
    } catch (error) {
      console.warn(`  Eval failed for ${entry.name}: ${error.message}`);
    }
  }
}

function resolveBenchDir(args) {
  if (args.benchDir) return path.resolve(REPO_ROOT, args.benchDir);
  if (process.env.QWEN_AGENT_BENCH_DIR) return process.env.QWEN_AGENT_BENCH_DIR;
  const localVendor = path.join(BENCHMARKS_ROOT, 'deepplanning', 'vendor', 'Qwen-Agent', 'benchmark', 'deepplanning');
  try { fs.accessSync(localVendor); return localVendor; } catch { return null; }
}

function parseArgs(argv) {
  const args = { domains: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const readValue = () => {
      if (next == null) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return next;
    };

    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--run') { args.run = readValue(); continue; }
    if (arg === '--run-dir') { args.runDir = readValue(); continue; }
    if (arg === '--domain') { args.domains.push(readValue()); continue; }
    if (arg === '--bench-dir') { args.benchDir = readValue(); continue; }
    if (arg === '--run-root') { args.runRoot = readValue(); continue; }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node benchmarks/evaluate-deepplanning.mjs [options]

Options:
  --run <run-id>              Run directory name under benchmarks/runs/
  --domain <shopping|travel>  Evaluate specific domain (repeatable; default: auto-detect)
  --bench-dir <path>          Path to Qwen-Agent benchmark/deepplanning directory
  --run-root <path>           Root for run directories (default: benchmarks/runs)
  --help                      Show this help
`);
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.streamOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    if (!options.streamOutput) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }

    child.once('error', reject);
    child.once('close', (exitCode) => {
      if (exitCode === 0) { resolve({ stdout, stderr, exitCode }); return; }
      const error = new Error(`${command} exited with code ${exitCode}: ${stderr.slice(0, 200)}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = exitCode;
      reject(error);
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
