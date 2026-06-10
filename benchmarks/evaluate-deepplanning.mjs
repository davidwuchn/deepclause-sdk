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
    console.warn(`  Shopping evaluation script not found: ${evalScript}, skipping`);
    return;
  }

  const dbInferredRoot = path.join(evalDir, 'database_infered', 'deepclause_run');
  await fs.mkdir(dbInferredRoot, { recursive: true });

  let casesPrepared = 0;
  for (const entry of instanceDirs) {
    const resultPath = path.join(instancesDir, entry.name, 'result.json');
    let result;
    try {
      result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch {
      console.warn(`  Skipping ${entry.name}: no result.json`);
      continue;
    }

    const caseDir = result.dbPath;
    if (!caseDir || !await fileExists(caseDir)) {
      console.warn(`  Skipping ${entry.name}: case dir not found (${caseDir})`);
      continue;
    }

    const taskId = result.taskId ?? entry.name.replace(/^instance_/, '');
    const caseName = `case_${taskId}`;
    const caseOutputDir = path.join(dbInferredRoot, caseName);
    await fs.mkdir(caseOutputDir, { recursive: true });

    try {
      const cartPath = path.join(caseDir, 'cart.json');
      const validationPath = path.join(caseDir, 'validation_cases.json');

      if (await fileExists(cartPath)) {
        const cartContent = await fs.readFile(cartPath, 'utf8');
        await fs.writeFile(path.join(caseOutputDir, 'cart.json'), cartContent, 'utf8');
      }

      if (await fileExists(validationPath)) {
        const validationContent = await fs.readFile(validationPath, 'utf8');
        await fs.writeFile(path.join(caseOutputDir, 'validation_cases.json'), validationContent, 'utf8');
      }

      const messages = [];
      if (result.agentOutput) {
        messages.push({ role: 'assistant', content: result.agentOutput });
      }
      await fs.writeFile(path.join(caseOutputDir, 'messages.json'), JSON.stringify({ messages }, null, 2), 'utf8');

      casesPrepared += 1;
    } catch (error) {
      console.warn(`  Failed to prepare ${entry.name}: ${error.message}`);
    }
  }

  if (casesPrepared === 0) {
    console.log('[shopping] No cases prepared for evaluation');
    return;
  }

  console.log(`[shopping] Evaluating ${casesPrepared} cases...`);
  try {
    await runCommand('python3', [
      evalScript,
      '--database_dir', dbInferredRoot,
    ], { cwd: benchDir, streamOutput: true });
  } catch (error) {
    console.warn(`[shopping] Evaluation failed: ${error.message}`);
  }
}

async function evaluateTravel(benchDir, instancesDir, instanceDirs, evalDir) {
  const resultDir = path.join(evalDir, 'travel_result');
  const reportsDir = path.join(resultDir, 'reports');
  const convertedDir = path.join(resultDir, 'converted_plans');
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.mkdir(convertedDir, { recursive: true });

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

    const taskId = (result.taskId ?? entry.name).replace(/^travel-/, '');
    const reportPath = path.join(reportsDir, `id_${taskId}.txt`);
    await fs.writeFile(reportPath, result.agentOutput, 'utf8');
  }

  const reportFiles = await fs.readdir(reportsDir).catch(() => []);
  if (reportFiles.length === 0) {
    console.log('[travel] No report files generated, skipping evaluation');
    return;
  }

  const convertScript = path.join(benchDir, 'travelplanning', 'evaluation', 'convert_report.py');
  console.log(`[travel] Looking for convert script: ${convertScript} (exists: ${await fileExists(convertScript)})`);
  if (await fileExists(convertScript)) {
    console.log('[travel] Converting reports to structured JSON (requires LLM API access)...');
    try {
      await runCommand('python3', [
        convertScript,
        '--result-dir', resultDir,
        '--language', 'en',
        '--workers', '1',
      ], { cwd: benchDir, streamOutput: true });
    } catch (error) {
      console.warn(`[travel] Report conversion failed: ${error.message}`);
      console.warn('[travel] Ensure DASHSCOPE_API_KEY or OPENAI_API_KEY is set for the conversion LLM.');
    }
  } else {
    console.warn(`[travel] Conversion script not found: ${convertScript}`);
  }

  const convertedFiles = await fs.readdir(convertedDir).catch(() => []);
  if (convertedFiles.length === 0) {
    console.log('[travel] No converted plans, skipping evaluation');
    return;
  }

  const databaseDir = path.join(benchDir, 'travelplanning', 'database', 'database_en');
  const testDataPath = path.join(benchDir, 'travelplanning', 'data', 'travelplanning_query_en.json');
  const evaluationOutputDir = path.join(resultDir, 'evaluation');
  await fs.mkdir(evaluationOutputDir, { recursive: true });

  try {
    await runCommand('python3', [
      '-m', 'travelplanning.evaluation.eval_converted',
      '--plans-dir', convertedDir,
      '--output-dir', evaluationOutputDir,
      '--test-data', testDataPath,
      '--database-dir', databaseDir,
      '--workers', '1',
    ], { cwd: benchDir, streamOutput: true });
  } catch (error) {
    console.warn(`[travel] Evaluation failed: ${error.message}`);
  }
}

function resolveBenchDir(args) {
  if (args.benchDir) return path.resolve(REPO_ROOT, args.benchDir);
  if (process.env.QWEN_AGENT_BENCH_DIR) return process.env.QWEN_AGENT_BENCH_DIR;
  const localVendor = path.join(BENCHMARKS_ROOT, 'deepplanning', 'vendor', 'Qwen-Agent', 'benchmark', 'deepplanning');
  try { require('fs').accessSync(localVendor); return localVendor; } catch { return null; }
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
