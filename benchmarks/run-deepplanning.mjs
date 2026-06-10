#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARKS_ROOT, '..', '..');

const DEFAULT_CONFIG = {
  domains: ['shopping', 'travel'],
  levels: [],
  deepclauseVersion: 'latest',
  models: {
    gateway: 'openai:gpt-4o',
    run: 'openai:gpt-4o',
    compile: 'openai:gpt-4o',
  },
  temperatures: {
    gateway: 0.7,
    run: 0.7,
    compile: 0.4,
  },
  execution: {
    maxWorkers: 1,
    agentTimeoutSeconds: 600,
    verbose: false,
  },
  artifacts: {
    outputRoot: 'benchmarks/runs',
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = buildConfig(args);

  const runId = config.runId || buildRunId();
  const runRoot = path.resolve(REPO_ROOT, config.artifacts.outputRoot, runId);
  await fs.mkdir(runRoot, { recursive: true });

  const benchDir = resolveBenchDir(args);
  if (!benchDir) {
    throw new Error(
      'Qwen-Agent benchmark directory not found. Clone Qwen-Agent repo and set --bench-dir or QWEN_AGENT_BENCH_DIR.\n' +
      '  git clone https://github.com/QwenLM/Qwen-Agent.git benchmarks/deepplanning/vendor/Qwen-Agent'
    );
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    runId,
    benchmark: 'deepplanning',
    benchDir,
    config,
  };
  await writeJson(path.join(runRoot, 'manifest.json'), manifest);

  console.log(`Run ID: ${runId}`);
  console.log(`Domains: ${config.domains.join(', ')}`);
  console.log(`Bench dir: ${benchDir}`);

  const allResults = {};
  let totalTasks = 0;
  let totalSuccessful = 0;

  for (const domain of config.domains) {
    const tasks = await loadTasks(benchDir, config, domain);
    if (tasks.length === 0) {
      console.log(`\n[${domain}] No tasks selected, skipping`);
      allResults[domain] = [];
      continue;
    }

    console.log(`\n[${domain}] Tasks: ${tasks.length}`);

    const instancesDir = path.join(runRoot, domain, 'instances');
    await fs.mkdir(instancesDir, { recursive: true });

    const results = await mapLimit(tasks, config.execution.maxWorkers, async (task) => {
      const instanceDir = path.join(instancesDir, sanitizeSegment(task.taskId));
      await fs.mkdir(instanceDir, { recursive: true });

      const inputPath = path.join(instanceDir, 'input.json');
      await writeJson(inputPath, task);

      const result = await runWorkerTask({
        task,
        instanceDir,
        benchDir,
        config,
      });

      const state = result.success ? 'ok' : 'error';
      console.log(`  [${domain}] ${task.taskId} -> ${state}`);
      return result;
    });

    const successful = results.filter((r) => r.success).length;
    totalTasks += results.length;
    totalSuccessful += successful;
    allResults[domain] = results;

    const domainSummary = buildSummary(results, domain);
    await writeJson(path.join(runRoot, domain, 'summary.json'), domainSummary);
    console.log(`[${domain}] ${successful}/${results.length} successful`);
  }

  const aggregateSummary = {
    runId,
    domains: config.domains,
    totalTasks,
    totalSuccessful,
    totalFailed: totalTasks - totalSuccessful,
    perDomain: {},
  };
  for (const [domain, results] of Object.entries(allResults)) {
    const successful = results.filter((r) => r.success).length;
    aggregateSummary.perDomain[domain] = {
      total: results.length,
      successful,
      failed: results.length - successful,
    };
  }
  await writeJson(path.join(runRoot, 'summary.json'), aggregateSummary);

  console.log(`\nAggregate: ${totalSuccessful}/${totalTasks} successful`);
  console.log(`Run root: ${runRoot}`);
}

async function loadTasks(benchDir, config, domain) {
  const tasks = [];

  if (domain === 'shopping') {
    for (const level of [1, 2, 3]) {
      if (config.levels.length > 0 && !config.levels.includes(level)) {
        continue;
      }
      const metaPath = path.join(benchDir, 'shoppingplanning', 'data', `level_${level}_query_meta.json`);
      let entries;
      try {
        entries = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      } catch {
        console.warn(`Warning: Could not load ${metaPath}`);
        continue;
      }
      for (const entry of entries) {
        const caseDir = path.join(benchDir, 'shoppingplanning', 'database', `level_${level}`, `case_${entry.case_id ?? entry.id ?? tasks.length}`);
        tasks.push({
          taskId: entry.case_id ?? entry.id ?? `shopping-l${level}-${tasks.length}`,
          domain: 'shopping',
          level,
          query: entry.query ?? entry.task_query ?? '',
          dbPath: caseDir,
          taskMeta: entry,
        });
      }
    }
  } else if (domain === 'travel') {
    const lang = config.language ?? 'en';
    const metaPath = path.join(benchDir, 'travelplanning', 'data', `travelplanning_query_${lang}.json`);
    let entries;
    try {
      entries = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      console.warn(`Warning: Could not load ${metaPath}`);
      return tasks;
    }
    for (const entry of entries) {
      const taskId = entry.id ?? entry.task_id ?? `travel-${tasks.length}`;
      const dbDir = path.join(benchDir, 'travelplanning', 'database', `database_${lang}`, String(taskId));
      tasks.push({
        taskId: `travel-${taskId}`,
        domain: 'travel',
        level: 0,
        query: entry.query ?? entry.task_query ?? '',
        dbPath: dbDir,
        language: lang,
        taskMeta: entry,
      });
    }
  }

  if (config.instanceIds.length > 0) {
    const idSet = new Set(config.instanceIds);
    return tasks.filter((t) => idSet.has(t.taskId));
  }
  if (config.offset > 0) {
    tasks.splice(0, config.offset);
  }
  if (config.limit !== undefined) {
    tasks.splice(config.limit);
  }
  return tasks;
}

async function runWorkerTask({ task, instanceDir, benchDir, config }) {
  const workerScript = path.join(BENCHMARKS_ROOT, 'deepplanning', 'worker', 'run-instance.mjs');
  const inputPath = path.join(instanceDir, 'input.json');

  const workerInput = {
    ...task,
    deepclauseVersion: config.deepclauseVersion,
    models: config.models,
    temperatures: config.temperatures,
    agentTimeoutSeconds: config.execution.agentTimeoutSeconds,
    benchDir,
  };
  await writeJson(inputPath, workerInput);

  try {
    await runCommand('node', [workerScript, inputPath, instanceDir], {
      cwd: REPO_ROOT,
      streamOutput: config.execution.verbose,
      timeout: (config.execution.agentTimeoutSeconds + 120) * 1000,
    });

    const resultPath = path.join(instanceDir, 'result.json');
    return JSON.parse(await fs.readFile(resultPath, 'utf8'));
  } catch (error) {
    return {
      success: false,
      taskId: task.taskId,
      domain: task.domain,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveBenchDir(args) {
  if (args.benchDir) {
    return path.resolve(REPO_ROOT, args.benchDir);
  }
  if (process.env.QWEN_AGENT_BENCH_DIR) {
    return process.env.QWEN_AGENT_BENCH_DIR;
  }
  const localVendor = path.join(BENCHMARKS_ROOT, 'deepplanning', 'vendor', 'Qwen-Agent', 'benchmark', 'deepplanning');
  try {
    fs.accessSync(localVendor);
    return localVendor;
  } catch {
    return null;
  }
}

function buildConfig(args) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (args.domains.length > 0) config.domains = args.domains;
  if (args.levels.length > 0) config.levels = args.levels;
  if (args.language) config.language = args.language;
  if (args.runId) config.runId = args.runId;
  if (args.outputRoot) config.artifacts.outputRoot = args.outputRoot;
  if (args.deepclauseVersion) config.deepclauseVersion = args.deepclauseVersion;
  if (args.maxWorkers) config.execution.maxWorkers = args.maxWorkers;
  if (args.agentTimeout) config.execution.agentTimeoutSeconds = args.agentTimeout;
  if (args.verbose) config.execution.verbose = true;
  if (args.gatewayModel) config.models.gateway = args.gatewayModel;
  if (args.runModel) config.models.run = args.runModel;
  if (args.compileModel) config.models.compile = args.compileModel;
  if (args.gatewayTemp) config.temperatures.gateway = args.gatewayTemp;
  if (args.runTemp) config.temperatures.run = args.runTemp;
  if (args.compileTemp) config.temperatures.compile = args.compileTemp;
  config.instanceIds = args.instanceIds ?? [];
  config.offset = args.offset ?? 0;
  config.limit = args.limit;
  return config;
}

function parseArgs(argv) {
  const args = {
    instanceIds: [],
    levels: [],
    domains: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const readValue = () => {
      if (next == null) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return next;
    };

    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--domain') { args.domains.push(readValue()); continue; }
    if (arg === '--level') { args.levels.push(Number(readValue())); continue; }
    if (arg === '--language') { args.language = readValue(); continue; }
    if (arg === '--bench-dir') { args.benchDir = readValue(); continue; }
    if (arg === '--instance-id') { args.instanceIds.push(readValue()); continue; }
    if (arg === '--limit') { args.limit = Number(readValue()); continue; }
    if (arg === '--offset') { args.offset = Number(readValue()); continue; }
    if (arg === '--run-id') { args.runId = readValue(); continue; }
    if (arg === '--output-root') { args.outputRoot = readValue(); continue; }
    if (arg === '--deepclause-version') { args.deepclauseVersion = readValue(); continue; }
    if (arg === '--max-workers') { args.maxWorkers = Number(readValue()); continue; }
    if (arg === '--agent-timeout') { args.agentTimeout = Number(readValue()); continue; }
    if (arg === '--gateway-model') { args.gatewayModel = readValue(); continue; }
    if (arg === '--run-model') { args.runModel = readValue(); continue; }
    if (arg === '--compile-model') { args.compileModel = readValue(); continue; }
    if (arg === '--gateway-temp') { args.gatewayTemp = Number(readValue()); continue; }
    if (arg === '--run-temp') { args.runTemp = Number(readValue()); continue; }
    if (arg === '--compile-temp') { args.compileTemp = Number(readValue()); continue; }
    if (arg === '--verbose' || arg === '-v') { args.verbose = true; continue; }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node benchmarks/run-deepplanning.mjs [options]

Options:
  --domain <shopping|travel>   Benchmark domain (repeatable; default: both)
  --level <1|2|3>              Shopping difficulty level (repeatable; default: all)
  --language <en|zh>           Travel language (default: en)
  --bench-dir <path>           Path to Qwen-Agent benchmark/deepplanning directory
  --instance-id <id>           Run specific task IDs (repeatable)
  --limit <n>                  Limit number of tasks per domain
  --offset <n>                 Skip first N tasks per domain
  --run-id <name>              Run identifier
  --output-root <path>         Output directory (default: benchmarks/runs)
  --deepclause-version <ver>   DeepClause SDK version (default: latest)
  --max-workers <n>            Concurrent workers (default: 1)
  --agent-timeout <seconds>    Per-task timeout (default: 600)
  --gateway-model <id>         Gateway model (default: openai:gpt-4o)
  --run-model <id>             Run model (default: openai:gpt-4o)
  --compile-model <id>         Compile model (default: openai:gpt-4o)
  --gateway-temp <n>           Gateway temperature (default: 0.7)
  --run-temp <n>               Run temperature (default: 0.7)
  --compile-temp <n>           Compile temperature (default: 0.4)
  --verbose, -v                Stream worker output
  --help                       Show this help

Examples:
  node benchmarks/run-deepplanning.mjs --limit 2
  node benchmarks/run-deepplanning.mjs --domain shopping --level 1 --limit 2
  node benchmarks/run-deepplanning.mjs --domain travel --language en --limit 3
  node benchmarks/run-deepplanning.mjs --domain shopping --domain travel --limit 5
`);
}

function buildRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `dp-${stamp}`;
}

function sanitizeSegment(segment) {
  return String(segment).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128);
}

function buildSummary(results, domain) {
  const successful = results.filter((r) => r.success).length;
  return {
    domain,
    total: results.length,
    successful,
    failed: results.length - successful,
    results: results.map((r) => ({
      taskId: r.taskId,
      success: r.success,
      error: r.error ?? null,
    })),
  };
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function mapLimit(items, maxWorkers, iteratee) {
  const results = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: Math.min(maxWorkers, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }));

  return results;
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

    let timer;
    if (options.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, options.timeout);
    }

    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      const error = new Error(`${command} exited with code ${exitCode}`);
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
