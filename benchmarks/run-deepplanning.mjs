#!/usr/bin/env node

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARKS_ROOT, '..');

function resolveVenvPython() {
  const venvPython = path.join(REPO_ROOT, 'venv', 'bin', 'python3');
  try {
    fsSync.accessSync(venvPython, fsSync.constants.X_OK);
    return venvPython;
  } catch {}
  try {
    const sysPython = execSync('which python3 2>/dev/null', { encoding: 'utf8' }).trim();
    if (sysPython) return sysPython;
  } catch {}
  return 'python3';
}

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
    maxIterations: 100,
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
  console.log(`Mode: ${config.mode}`);
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

    let compiledDmlPath;
    if (config.mode === 'compile') {
      compiledDmlPath = await compileSkill(runRoot, domain, config);
    }

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
        dmlFiles: config.dmlFiles,
        compiledDmlPath,
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
      const dbDir = path.join(benchDir, 'travelplanning', 'database', `database_${lang}`, `id_${taskId}`);
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

async function runWorkerTask({ task, instanceDir, benchDir, config, dmlFiles, compiledDmlPath }) {
  const workerScript = path.join(BENCHMARKS_ROOT, 'deepplanning', 'worker', 'run-instance.mjs');
  const inputPath = path.join(instanceDir, 'input.json');

  const resolvedDmlFiles = {};
  for (const [domain, file] of Object.entries(dmlFiles ?? {})) {
    resolvedDmlFiles[domain] = path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);
  }

  const workerInput = {
    ...task,
    deepclauseVersion: config.deepclauseVersion,
    models: config.models,
    temperatures: config.temperatures,
    agentTimeoutSeconds: config.execution.agentTimeoutSeconds,
    maxIterations: config.execution.maxIterations,
    benchDir,
    pythonPath: config.pythonPath,
    dmlFiles: resolvedDmlFiles,
    specFiles: config.specFiles,
    mode: config.mode,
    compiledDmlPath: compiledDmlPath ?? null,
  };
  await writeJson(inputPath, workerInput);

  try {
    const phaseCount = config.mode === 'plan-execute' ? 2 : 1;
    await runCommand('node', [workerScript, inputPath, instanceDir], {
      cwd: REPO_ROOT,
      streamOutput: config.execution.verbose,
      timeout: (config.execution.agentTimeoutSeconds * phaseCount + 120) * 1000,
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
    require('fs').accessSync(localVendor);
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
  if (args.maxIterations) config.execution.maxIterations = Number(args.maxIterations);
  if (args.verbose) config.execution.verbose = true;
  if (args.gatewayModel) config.models.gateway = args.gatewayModel;
  if (args.runModel) config.models.run = args.runModel;
  if (args.compileModel) config.models.compile = args.compileModel;
  if (args.planModel) config.models.plan = args.planModel;
  if (args.executeModel) config.models.execute = args.executeModel;
  if (args.gatewayTemp) config.temperatures.gateway = args.gatewayTemp;
  if (args.runTemp) config.temperatures.run = args.runTemp;
  if (args.compileTemp) config.temperatures.compile = args.compileTemp;
  config.pythonPath = args.pythonPath ?? resolveVenvPython();
  config.instanceIds = args.instanceIds ?? [];
  config.offset = args.offset ?? 0;
  config.limit = args.limit;
  config.dmlFiles = args.dmlFiles ?? {};
  config.specFiles = args.specFiles ?? {};
  config.mode = args.mode ?? 'direct';
  config.compileTimeoutSeconds = args.compileTimeout ?? 1800;
  return config;
}

function parseArgs(argv) {
  const args = {
    instanceIds: [],
    levels: [],
    domains: [],
    dmlFiles: {},
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
    if (arg === '--max-iterations') { args.maxIterations = Number(readValue()); continue; }
    if (arg === '--gateway-model') { args.gatewayModel = readValue(); continue; }
    if (arg === '--run-model') { args.runModel = readValue(); continue; }
    if (arg === '--compile-model') { args.compileModel = readValue(); continue; }
    if (arg === '--gateway-temp') { args.gatewayTemp = Number(readValue()); continue; }
    if (arg === '--run-temp') { args.runTemp = Number(readValue()); continue; }
    if (arg === '--compile-temp') { args.compileTemp = Number(readValue()); continue; }
    if (arg === '--python-path') { args.pythonPath = readValue(); continue; }
    if (arg === '--travel-dml') { (args.dmlFiles ??= {}).travel = readValue(); continue; }
    if (arg === '--shopping-dml') { (args.dmlFiles ??= {}).shopping = readValue(); continue; }
    if (arg === '--travel-spec') { (args.specFiles ??= {}).travel = readValue(); continue; }
    if (arg === '--shopping-spec') { (args.specFiles ??= {}).shopping = readValue(); continue; }
    if (arg === '--compile-timeout') { args.compileTimeout = Number(readValue()); continue; }
    if (arg === '--mode') { args.mode = readValue(); continue; }
    if (arg === '--plan-model') { args.planModel = readValue(); continue; }
    if (arg === '--execute-model') { args.executeModel = readValue(); continue; }
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
  --max-iterations <n>         Max agent loop iterations (default: 100)
  --mode <direct|plan-execute|compile> Execution mode (default: direct)
  --gateway-model <id>         Gateway model (default: openai:gpt-4o)
  --run-model <id>             Run model (default: openai:gpt-4o)
  --compile-model <id>         Compile model (default: openai:gpt-4o)
  --plan-model <id>            Plan phase model (plan-execute mode; default: run-model)
  --execute-model <id>         Execute phase model (plan-execute mode; default: run-model)
  --gateway-temp <n>           Gateway temperature (default: 0.7)
  --run-temp <n>               Run temperature (default: 0.7)
  --compile-temp <n>           Compile temperature (default: 0.4)
  --travel-dml <path>          Custom DML file for travel domain (default: travel.dml)
  --shopping-dml <path>        Custom DML file for shopping domain (default: shopping.dml)
  --travel-spec <path>         Custom Markdown spec for travel domain (compile mode; default: travel-planner.md)
  --shopping-spec <path>       Custom Markdown spec for shopping domain (compile mode; default: shopping-planner.md)
  --compile-timeout <seconds>  Skill compilation timeout (default: 300)
  --verbose, -v                Stream worker output
  --help                       Show this help

Examples:
  node benchmarks/run-deepplanning.mjs --limit 2
  node benchmarks/run-deepplanning.mjs --domain shopping --level 1 --limit 2
  node benchmarks/run-deepplanning.mjs --domain travel --language en --limit 3
  node benchmarks/run-deepplanning.mjs --domain travel --mode plan-execute --plan-model openai:gpt-4o --execute-model openai:gpt-4o-mini --limit 3
  node benchmarks/run-deepplanning.mjs --domain travel --travel-dml benchmarks/deepplanning/travel-v2.dml --limit 2
 `);
}

function buildRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `dp-${stamp}`;
}

async function compileSkill(runRoot, domain, config) {
  const specFile = config.specFiles?.[domain]
    ?? (domain === 'travel'
      ? path.join(BENCHMARKS_ROOT, 'deepplanning', 'travel-planner.md')
      : path.join(BENCHMARKS_ROOT, 'deepplanning', 'shopping-planner.md'));

  const compileHome = path.join(runRoot, domain, 'compile-home');
  await fs.mkdir(compileHome, { recursive: true });

  const compileModel = config.models?.compile ?? config.models?.run;
  console.log(`[${domain}] Compiling skill from ${path.basename(specFile)} (model: ${compileModel ?? 'default'})`);

  const initArgs = ['deepclause', 'init', '--force', '--model', compileModel ?? 'openai:gpt-4o'];
  await runCommand(initArgs[0], initArgs.slice(1), { cwd: compileHome, streamOutput: config.execution.verbose, timeout: 30000 });

  const compileConfigPath = path.join(compileHome, '.deepclause', 'config.json');
  let compileConfig;
  try {
    compileConfig = JSON.parse(await fs.readFile(compileConfigPath, 'utf8'));
  } catch { compileConfig = {}; }
  compileConfig.models = {
    ...compileConfig.models,
    compile: compileModel ?? config.models?.compile ?? 'openai:gpt-4o',
  };
  compileConfig.shell = { wrapper: 'clean-room', strictIsolation: false };
  await fs.writeFile(compileConfigPath, JSON.stringify(compileConfig, null, 2), 'utf8');

  const compileRunArgs = ['deepclause', 'compile', '--force', '--verbose', '--stream', '--no-audit', specFile];
  if (compileModel) compileRunArgs.push('--model', compileModel);
  const compileTimeout = (config.compileTimeoutSeconds ?? 1800) * 1000;
  await runCommand(compileRunArgs[0], compileRunArgs.slice(1), { cwd: compileHome, streamOutput: config.execution.verbose, timeout: compileTimeout });

  const toolsDir = path.join(compileHome, '.deepclause', 'tools');
  const entries = await fs.readdir(toolsDir, { withFileTypes: true });
  const dmlFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.dml')).map((e) => e.name).sort();
  if (dmlFiles.length === 0) {
    throw new Error(`[${domain}] Compile phase did not produce a DML file.`);
  }
  const rawDmlPath = path.join(toolsDir, dmlFiles[dmlFiles.length - 1]);
  console.log(`[${domain}] Compiled skill: ${dmlFiles[dmlFiles.length - 1]}`);

  const finalDmlPath = path.join(runRoot, domain, `${domain}-compiled.dml`);
  await injectBridgeIntoDml(rawDmlPath, finalDmlPath, domain);
  console.log(`[${domain}] Final DML: ${finalDmlPath}`);

  return finalDmlPath;
}

async function injectBridgeIntoDml(sourcePath, targetPath, domain) {
  const raw = await fs.readFile(sourcePath, 'utf8');

  if (raw.includes('run_tool(')) {
    await fs.writeFile(targetPath, raw, 'utf8');
    console.log(`  Bridge already present in compiled DML, using as-is.`);
    return;
  }

  const agentMainStart = raw.indexOf('\nagent_main(');
  if (agentMainStart === -1) {
    throw new Error('Compiled DML has no agent_main clause');
  }
  const agentClauses = raw.slice(agentMainStart + 1);

  const bridgeBlock = buildBridgeBlock(domain);
  const finalDml = `:- use_module(library(http/json)).\n\n${bridgeBlock}\n\n${agentClauses}\n`;
  await fs.writeFile(targetPath, finalDml, 'utf8');
  console.log(`  Injected bridge into compiled DML (replaced exec() tool defs).`);
}

function buildBridgeBlock(domain) {
  const toolMap = domain === 'travel' ? {
    query_train_info: 'origin, destination, depDate',
    query_train_info_with_class: 'origin, destination, depDate, seatClassName',
    query_flight_info: 'origin, destination, depDate',
    query_flight_info_with_class: 'origin, destination, depDate, seatClassName',
    query_hotel_info: 'destination, checkinDate, checkoutDate',
    query_hotel_info_with_star: 'destination, checkinDate, checkoutDate, hotelStar',
    recommend_attractions: 'city',
    query_attraction_details: 'attraction_name',
    search_location: 'place_name',
    query_road_route_info: 'origin, destination',
    recommend_restaurants: 'latitude, longitude',
    query_restaurant_details: 'restaurant_name',
  } : {};

  let bridge = `:- use_module(library(http/json)).\n\n`;
  bridge += `run_tool(ToolName, ArgsDict, Result) :-\n`;
  bridge += `    param(db_path, DbPath),\n`;
  bridge += `    param(bridge_dir, BridgeDir),\n`;
  bridge += `    param(bench_dir, BenchDir),\n`;
  bridge += `    param(python_path, PythonPath),\n`;
  bridge += `    (var(PythonPath) -> PythonPath = 'python3' ; true),\n`;
  bridge += `    atom_json_dict(ArgsJson, ArgsDict, []),\n`;
  bridge += `    format(string(ArgsFile), ".dc_bridge_~w.json", [ToolName]),\n`;
  bridge += `    exec(write_file(path: ArgsFile, content: ArgsJson), _),\n`;
  bridge += `    format(string(Cmd), "~w '\\~w/python-bridge.py' --domain ${domain} --db-path '\\~w' --bench-dir '\\~w' --tool ~w --args-file '\\~w'", [PythonPath, BridgeDir, DbPath, BenchDir, ToolName, ArgsFile]),\n`;
  bridge += `    exec(bash(command: Cmd), Raw),\n`;
  bridge += `    parse_bridge_result(Raw, Result).\n\n`;

  for (const [toolName, args] of Object.entries(toolMap)) {
    const argList = args.split(', ').map((a) => a.charAt(0).toUpperCase() + a.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase()));
    const paramList = args.split(', ').map((a) => `${a}: ${a.charAt(0).toUpperCase() + a.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`);
    bridge += `tool(${toolName}(${argList.join(', ')}, Result),\n`;
    bridge += `     "See skill spec for details.") :-\n`;
    bridge += `    run_tool(${toolName}, _{${paramList.join(', ')}}, Result).\n\n`;
  }

  bridge += `parse_bridge_result(Raw, Result) :-\n`;
  bridge += `    get_dict(stdout, Raw, Stdout),\n`;
  bridge += `    !,\n`;
  bridge += `    Result = Stdout.\n\n`;
  bridge += `parse_bridge_result(_, "Error: tool call failed").\n`;

  return bridge;
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
