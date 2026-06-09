#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARKS_ROOT, '..');
const DATASET_PAGE_SIZE = 100;
const DEFAULT_CONFIG = {
  dataset: {
    name: 'lite',
    split: 'test',
    instanceIds: [],
    limit: undefined,
    offset: 0,
  },
  modes: ['prompt'],
  deepclause: {
    version: 'latest',
    packageTarball: undefined,
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
    shell: {
      wrapper: 'clean-room',
      strictIsolation: false,
    },
    agentvm: {
      network: false,
    },
  },
  execution: {
    maxWorkers: 1,
    agentTimeoutSeconds: 2700,
    setupTimeoutSeconds: 1800,
    verbose: false,
    repoCacheDir: undefined,
    repoSetup: {
      mode: 'swebench-image',
      commands: [],
    },
  },
  docker: {
    platform: 'linux/amd64',
    workerImage: 'deepclause-swebench-worker:latest',
    evaluatorImage: 'deepclause-swebench-evaluator:latest',
    rebuildImages: false,
    skipImageBuild: false,
    swebenchNamespace: 'swebench',
  },
  artifacts: {
    outputRoot: 'benchmarks/runs',
  },
};
const MODE_ALIASES = new Map([
  ['prompt', 'prompt'],
  ['plan', 'plan-execute'],
  ['plan-execute', 'plan-execute'],
  ['plan_execute', 'plan-execute'],
]);
const DATASET_ALIASES = new Map([
  ['lite', 'SWE-bench/SWE-bench_Lite'],
  ['swe-bench-lite', 'SWE-bench/SWE-bench_Lite'],
  ['swebench-lite', 'SWE-bench/SWE-bench_Lite'],
  ['swe_bench_lite', 'SWE-bench/SWE-bench_Lite'],
  ['princeton-nlp/swe-bench_lite', 'SWE-bench/SWE-bench_Lite'],
  ['swe-bench/swe-bench_lite', 'SWE-bench/SWE-bench_Lite'],
  ['verified', 'SWE-bench/SWE-bench_Verified'],
  ['swe-bench-verified', 'SWE-bench/SWE-bench_Verified'],
  ['swebench-verified', 'SWE-bench/SWE-bench_Verified'],
  ['swe_bench_verified', 'SWE-bench/SWE-bench_Verified'],
  ['princeton-nlp/swe-bench_verified', 'SWE-bench/SWE-bench_Verified'],
  ['swe-bench/swe-bench_verified', 'SWE-bench/SWE-bench_Verified'],
  ['pro', 'ScaleAI/SWE-bench_Pro'],
  ['swe-bench-pro', 'ScaleAI/SWE-bench_Pro'],
  ['swebench-pro', 'ScaleAI/SWE-bench_Pro'],
  ['swe_bench_pro', 'ScaleAI/SWE-bench_Pro'],
  ['scaleai/swe-bench_pro', 'ScaleAI/SWE-bench_Pro'],
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const fileConfig = args.config
    ? await readJson(path.resolve(process.cwd(), args.config))
    : {};
  let config = mergeConfig(DEFAULT_CONFIG, fileConfig);
  config = applyCliOverrides(config, args);
  config = normalizeConfig(config);

  const runId = config.runId || buildRunId();
  const runRoot = path.resolve(REPO_ROOT, config.artifacts.outputRoot, runId);
  await fs.mkdir(runRoot, { recursive: true });

  const resolvedDeepClauseVersion = await resolveDeepClauseVersion(config.deepclause.version);
  const manifest = {
    createdAt: new Date().toISOString(),
    runId,
    resolvedDeepClauseVersion,
    benchmarksRoot: BENCHMARKS_ROOT,
    repoRoot: REPO_ROOT,
    consistencyNotes: {
      prompt: 'deepclause -p uses the conductor and the gateway slot.',
      'plan-execute': 'TUI /plan and /<plan> both route through deepclause run and therefore the run slot.',
    },
    config,
  };
  await writeJson(path.join(runRoot, 'manifest.json'), manifest);

  if (!config.docker.skipImageBuild) {
    await ensureWorkerImage(config.docker.workerImage, config.docker.platform, config.docker.rebuildImages);
  }

  const allInstances = await loadDatasetInstances(config.dataset.name, config.dataset.split);
  const selectedInstances = selectInstances(allInstances, config.dataset.instanceIds, config.dataset.offset, config.dataset.limit);
  if (selectedInstances.length === 0) {
    throw new Error('No dataset instances selected.');
  }

  if (config.execution.repoSetup.mode === 'swebench-image' && !config.docker.skipImageBuild) {
    await ensureEvaluatorImage(config.docker.evaluatorImage, 'latest', config.docker.rebuildImages);
    await buildSwebenchInstanceImages({
      instances: selectedInstances,
      evaluatorImage: config.docker.evaluatorImage,
      platform: config.docker.platform,
      namespace: config.docker.swebenchNamespace,
      maxWorkers: config.execution.maxWorkers,
      runRoot,
    });
  }

  console.log(`Resolved deepclause-sdk version: ${resolvedDeepClauseVersion}`);
  console.log(`Selected instances: ${selectedInstances.length}`);
  console.log(`Modes: ${config.modes.join(', ')}`);
  console.log(`Run ID: ${runId}`);
  console.log(`Run root: ${runRoot}`);
  if (config.deepclause.packageTarball) {
    console.log(`Using local deepclause package tarball: ${config.deepclause.packageTarball}`);
  }
  if (config.execution.repoCacheDir) {
    console.log(`Using local repository cache: ${config.execution.repoCacheDir}`);
  }

  for (const mode of config.modes) {
    await fs.mkdir(path.join(runRoot, mode, 'instances'), { recursive: true });
  }

  const taskQueue = [];
  for (const mode of config.modes) {
    for (const instance of selectedInstances) {
      taskQueue.push({ mode, instance });
    }
  }

  console.log(`Queued tasks: ${taskQueue.length}`);
  for (const [index, task] of taskQueue.entries()) {
    console.log(`  [queue ${index + 1}/${taskQueue.length}] ${task.mode} :: ${task.instance.instance_id}`);
  }

  const results = await mapLimit(taskQueue, config.execution.maxWorkers, async (task) => {
    const result = await runWorkerTask({
      task,
      runRoot,
      resolvedDeepClauseVersion,
      config,
      runId,
    });

    const state = result.success ? 'ok' : 'error';
    console.log(`[${task.mode}] ${task.instance.instance_id} -> ${state}`);
    return result;
  });

  const grouped = groupByMode(results);
  for (const [mode, modeResults] of grouped.entries()) {
    const modeRoot = path.join(runRoot, mode);
    const predictionsPath = path.join(modeRoot, 'predictions.jsonl');
    const summary = buildModeSummary({
      mode,
      modeResults,
      resolvedDeepClauseVersion,
      config,
    });

    await writePredictions(predictionsPath, modeResults);
    await writeJson(path.join(modeRoot, 'summary.json'), summary);
  }

  await writeJson(path.join(runRoot, 'summary.json'), {
    runId,
    createdAt: manifest.createdAt,
    resolvedDeepClauseVersion,
    selectedInstances: selectedInstances.length,
    modes: Object.fromEntries([...grouped.entries()].map(([mode, modeResults]) => [
      mode,
      buildModeSummary({ mode, modeResults, resolvedDeepClauseVersion, config }),
    ])),
  });

  console.log(`Artifacts written to ${runRoot}`);
}

function parseArgs(argv) {
  const args = {
    modes: [],
    instanceIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const readValue = () => {
      if (next == null) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return next;
    };

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--config') {
      args.config = readValue();
      continue;
    }
    if (arg === '--mode') {
      args.modes.push(readValue());
      continue;
    }
    if (arg === '--instance-id') {
      args.instanceIds.push(readValue());
      continue;
    }
    if (arg === '--limit') {
      args.limit = Number(readValue());
      continue;
    }
    if (arg === '--offset') {
      args.offset = Number(readValue());
      continue;
    }
    if (arg === '--dataset') {
      args.dataset = readValue();
      continue;
    }
    if (arg === '--split') {
      args.split = readValue();
      continue;
    }
    if (arg === '--run-id') {
      args.runId = readValue();
      continue;
    }
    if (arg === '--output-root') {
      args.outputRoot = readValue();
      continue;
    }
    if (arg === '--deepclause-version') {
      args.deepClauseVersion = readValue();
      continue;
    }
    if (arg === '--gateway-model') {
      args.gatewayModel = readValue();
      continue;
    }
    if (arg === '--run-model') {
      args.runModel = readValue();
      continue;
    }
    if (arg === '--compile-model') {
      args.compileModel = readValue();
      continue;
    }
    if (arg === '--gateway-temp') {
      args.gatewayTemp = Number(readValue());
      continue;
    }
    if (arg === '--run-temp') {
      args.runTemp = Number(readValue());
      continue;
    }
    if (arg === '--compile-temp') {
      args.compileTemp = Number(readValue());
      continue;
    }
    if (arg === '--max-workers') {
      args.maxWorkers = Number(readValue());
      continue;
    }
    if (arg === '--repo-setup') {
      args.repoSetupMode = readValue();
      continue;
    }
    if (arg === '--platform') {
      args.platform = readValue();
      continue;
    }
    if (arg === '--rebuild-images') {
      args.rebuildImages = true;
      continue;
    }
    if (arg === '--skip-image-build') {
      args.skipImageBuild = true;
      continue;
    }
    if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node benchmarks/run-swebench-lite.mjs [options]

Options:
  --config <file>              Load JSON config file
  --mode <prompt|plan-execute> Repeatable benchmark mode selector
  --instance-id <id>           Repeatable instance id selector
  --limit <n>                  Limit selected instances
  --offset <n>                 Offset after filtering
  --dataset <name>             Dataset alias (lite, verified, pro) or local .json/.jsonl file
  --split <name>               Dataset split (default: test)
  --run-id <name>              Stable run identifier
  --output-root <path>         Output root relative to repo root
  --deepclause-version <ver>   latest or an exact npm version
  --gateway-model <id>         Gateway slot model id
  --run-model <id>             Run slot model id
  --compile-model <id>         Compile slot model id
  --gateway-temp <n>           Gateway slot temperature
  --run-temp <n>               Run slot temperature
  --compile-temp <n>           Compile slot temperature
  --max-workers <n>            Maximum concurrent worker containers
  --repo-setup <mode>          none, best-effort, commands, or swebench-image
  --platform <name>            Docker platform, e.g. linux/amd64
  --rebuild-images             Rebuild worker image
  --skip-image-build           Skip docker build step
  --verbose, -v                Stream worker subprocess stdout/stderr to console
  --help                       Show this help
`);
}

function mergeConfig(base, override) {
  if (override == null) {
    return structuredClone(base);
  }
  if (Array.isArray(base) || Array.isArray(override)) {
    return structuredClone(override);
  }
  if (typeof base !== 'object' || typeof override !== 'object') {
    return structuredClone(override);
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    if (key in merged) {
      merged[key] = mergeConfig(merged[key], value);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function applyCliOverrides(config, args) {
  const next = structuredClone(config);
  if (args.modes.length > 0) {
    next.modes = args.modes;
  }
  if (args.instanceIds.length > 0) {
    next.dataset.instanceIds = args.instanceIds;
  }
  if (args.limit !== undefined) {
    next.dataset.limit = args.limit;
  }
  if (args.offset !== undefined) {
    next.dataset.offset = args.offset;
  }
  if (args.dataset) {
    next.dataset.name = args.dataset;
  }
  if (args.split) {
    next.dataset.split = args.split;
  }
  if (args.runId) {
    next.runId = args.runId;
  }
  if (args.outputRoot) {
    next.artifacts.outputRoot = args.outputRoot;
  }
  if (args.deepClauseVersion) {
    next.deepclause.version = args.deepClauseVersion;
  }
  if (args.gatewayModel) {
    next.deepclause.models.gateway = args.gatewayModel;
  }
  if (args.runModel) {
    next.deepclause.models.run = args.runModel;
  }
  if (args.compileModel) {
    next.deepclause.models.compile = args.compileModel;
  }
  if (Number.isFinite(args.gatewayTemp)) {
    next.deepclause.temperatures.gateway = args.gatewayTemp;
  }
  if (Number.isFinite(args.runTemp)) {
    next.deepclause.temperatures.run = args.runTemp;
  }
  if (Number.isFinite(args.compileTemp)) {
    next.deepclause.temperatures.compile = args.compileTemp;
  }
  if (Number.isFinite(args.maxWorkers)) {
    next.execution.maxWorkers = args.maxWorkers;
  }
  if (args.repoSetupMode) {
    next.execution.repoSetup.mode = args.repoSetupMode;
  }
  if (args.platform) {
    next.docker.platform = args.platform;
  }
  if (args.rebuildImages) {
    next.docker.rebuildImages = true;
  }
  if (args.skipImageBuild) {
    next.docker.skipImageBuild = true;
  }
  if (args.verbose) {
    next.execution.verbose = true;
  }
  return next;
}

function normalizeConfig(config) {
  const next = structuredClone(config);
  next.dataset.name = normalizeDatasetName(next.dataset.name);
  next.dataset.instanceIds = [...new Set((next.dataset.instanceIds ?? []).map(String))];
  next.dataset.offset = next.dataset.offset ?? 0;
  next.modes = [...new Set((next.modes ?? []).map(normalizeMode))];
  next.execution.maxWorkers = Math.max(1, Number(next.execution.maxWorkers ?? 1));
  next.execution.verbose = Boolean(next.execution.verbose);
  next.execution.repoCacheDir = next.execution.repoCacheDir == null
    ? undefined
    : String(next.execution.repoCacheDir);
  next.execution.repoSetup.mode = normalizeRepoSetupMode(next.execution.repoSetup.mode);
  next.deepclause.packageTarball = next.deepclause.packageTarball == null
    ? undefined
    : String(next.deepclause.packageTarball);
  next.docker.platform = String(next.docker.platform ?? 'linux/amd64');
  next.docker.workerImage = String(next.docker.workerImage ?? 'deepclause-swebench-worker:latest');
  next.docker.evaluatorImage = String(next.docker.evaluatorImage ?? 'deepclause-swebench-evaluator:latest');
  next.docker.swebenchNamespace = String(next.docker.swebenchNamespace ?? 'swebench');
  next.artifacts.outputRoot = String(next.artifacts.outputRoot ?? 'benchmarks/runs');
  return next;
}

function normalizeMode(mode) {
  const normalized = MODE_ALIASES.get(String(mode).toLowerCase());
  if (!normalized) {
    throw new Error(`Unsupported benchmark mode: ${mode}`);
  }
  return normalized;
}

function normalizeRepoSetupMode(mode) {
  const value = String(mode ?? 'swebench-image').toLowerCase();
  if (!['none', 'best-effort', 'commands', 'swebench-image'].includes(value)) {
    throw new Error(`Unsupported repo setup mode: ${mode}`);
  }
  return value;
}

function normalizeDatasetName(name) {
  const raw = String(name ?? 'lite');
  return DATASET_ALIASES.get(raw.toLowerCase()) ?? raw;
}

async function resolveDeepClauseVersion(version) {
  if (version !== 'latest') {
    return String(version);
  }

  const { stdout } = await runCommand('npm', ['view', 'deepclause-sdk', 'version', '--json'], {
    cwd: REPO_ROOT,
  });
  const parsed = JSON.parse(stdout.trim());
  return String(parsed);
}

async function ensureWorkerImage(imageTag, platform, rebuild) {
  if (!rebuild && await dockerImageExists(imageTag)) {
    return;
  }

  console.log(`Building worker image ${imageTag}...`);
  await runCommand('docker', [
    'build',
    '--platform', platform,
    '-t', imageTag,
    '-f', path.join(BENCHMARKS_ROOT, 'docker', 'worker.Dockerfile'),
    REPO_ROOT,
  ], {
    cwd: REPO_ROOT,
    streamOutput: true,
  });
}

async function dockerImageExists(imageTag) {
  try {
    await runCommand('docker', ['image', 'inspect', imageTag], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

async function ensureEvaluatorImage(imageTag, swebenchVersion, rebuild) {
  if (!rebuild && await dockerImageExists(imageTag)) {
    return;
  }

  console.log(`Building evaluator image ${imageTag}...`);
  await runCommand('docker', [
    'build',
    '--build-arg', `SWEBENCH_VERSION=${swebenchVersion}`,
    '-t', imageTag,
    '-f', path.join(BENCHMARKS_ROOT, 'docker', 'evaluator.Dockerfile'),
    REPO_ROOT,
  ], {
    cwd: REPO_ROOT,
    streamOutput: true,
  });
}

async function buildSwebenchInstanceImages({ instances, evaluatorImage, platform, namespace, maxWorkers, runRoot }) {
  const instanceIdsFile = path.join(runRoot, 'swebench-instance-ids.json');
  await fs.writeFile(instanceIdsFile, `${JSON.stringify(instances.map((i) => i.instance_id))}\n`, 'utf8');

  const dockerArgs = [
    'run',
    '--rm',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${BENCHMARKS_ROOT}:/benchmarks-src:ro`,
    '-v', `${instanceIdsFile}:/tmp/instance-ids.json:ro`,
    evaluatorImage,
    'python',
    '/benchmarks-src/worker/build-swebench-images.py',
    normalizeDatasetName('lite'),
    'test',
    namespace,
    String(Math.min(maxWorkers, 4)),
    '/tmp/instance-ids.json',
  ];

  console.log(`Building SWE-bench instance Docker images for ${instances.length} instances...`);
  await runCommand('docker', dockerArgs, {
    cwd: REPO_ROOT,
    streamOutput: true,
  });
}

async function loadDatasetInstances(datasetName, split) {
  if (datasetName.endsWith('.json') || datasetName.endsWith('.jsonl')) {
    const resolved = path.resolve(REPO_ROOT, datasetName);
    console.log(`Loading dataset instances from local file ${resolved}`);
    if (datasetName.endsWith('.json')) {
      return await readJson(resolved);
    }
    const content = await fs.readFile(resolved, 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  console.log(`Loading dataset ${datasetName} split ${split} from Hugging Face datasets server...`);
  const rows = [];
  let offset = 0;
  let total = null;
  while (total == null || offset < total) {
    const url = new URL('https://datasets-server.huggingface.co/rows');
    url.searchParams.set('dataset', datasetName);
    url.searchParams.set('config', 'default');
    url.searchParams.set('split', split);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('length', String(DATASET_PAGE_SIZE));

    console.log(`Fetching dataset page: ${url}`);
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch dataset rows from ${url}: ${reason}`);
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch dataset rows from ${url}: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    const pageRows = (payload.rows ?? []).map((entry) => entry.row);
    rows.push(...pageRows);
    total = Number(payload.num_rows_total ?? rows.length);
    if (pageRows.length === 0) {
      break;
    }
    offset += pageRows.length;
  }

  return rows;
}

function selectInstances(instances, instanceIds, offset, limit) {
  let selected = [...instances];
  if (instanceIds.length > 0) {
    const idSet = new Set(instanceIds);
    selected = selected.filter((instance) => idSet.has(instance.instance_id));
  }
  if (offset > 0) {
    selected = selected.slice(offset);
  }
  if (limit !== undefined) {
    selected = selected.slice(0, limit);
  }
  return selected;
}

async function runWorkerTask({ task, runRoot, resolvedDeepClauseVersion, config, runId }) {
  const modeRoot = path.join(runRoot, task.mode);
  const instanceRoot = path.join(modeRoot, 'instances', sanitizeSegment(task.instance.instance_id));
  await fs.mkdir(instanceRoot, { recursive: true });
  const inputPath = path.join(instanceRoot, 'input.json');
  const dockerStdoutPath = path.join(instanceRoot, 'docker.stdout.log');
  const dockerStderrPath = path.join(instanceRoot, 'docker.stderr.log');
  const resultPath = path.join(instanceRoot, 'result.json');

  const workerInput = {
    runId,
    mode: task.mode,
    instance: task.instance,
    deepclauseVersion: resolvedDeepClauseVersion,
    deepclausePackageTarball: undefined,
    repoCacheDir: undefined,
    deepclause: config.deepclause,
    execution: config.execution,
    docker: config.docker,
  };
  await writeJson(inputPath, workerInput);

  const env = collectWorkerEnv();
  const containerName = buildContainerName(runId, task.mode, task.instance.instance_id);
  const taskLabel = `[${task.mode}] ${task.instance.instance_id}`;
  const mountedPaths = [];
  const useSwebenchImage = config.execution.repoSetup.mode === 'swebench-image';
  const swebenchImageName = buildSwebenchInstanceImageName(task.instance.instance_id, config.docker.platform, config.docker.swebenchNamespace);
  const dockerArgs = [
    'run',
    '--rm',
    '--name', containerName,
    '--platform', config.docker.platform,
    '-v', `${BENCHMARKS_ROOT}:/benchmarks-src:ro`,
    '-v', `${instanceRoot}:/work-output`,
    '-v', `${inputPath}:/work-input/input.json:ro`,
  ];
  if (useSwebenchImage) {
    dockerArgs.push('-v', '/var/run/docker.sock:/var/run/docker.sock');
  }
  if (config.deepclause.packageTarball) {
    const packageTarballPath = path.resolve(REPO_ROOT, config.deepclause.packageTarball);
    if (!await pathExists(packageTarballPath)) {
      throw new Error(`Configured deepclause package tarball not found: ${packageTarballPath}`);
    }
    dockerArgs.push('-v', `${packageTarballPath}:/work-cache/deepclause-sdk.tgz:ro`);
    workerInput.deepclausePackageTarball = '/work-cache/deepclause-sdk.tgz';
    mountedPaths.push(`deepclause package ${packageTarballPath}`);
  }
  if (config.execution.repoCacheDir) {
    const repoCacheDir = path.resolve(REPO_ROOT, config.execution.repoCacheDir);
    if (!await pathExists(repoCacheDir)) {
      throw new Error(`Configured repository cache directory not found: ${repoCacheDir}`);
    }
    dockerArgs.push('-v', `${repoCacheDir}:/work-cache/repos:ro`);
    workerInput.repoCacheDir = '/work-cache/repos';
    mountedPaths.push(`repo cache ${repoCacheDir}`);
  }
  await writeJson(inputPath, workerInput);
  for (const [key, value] of Object.entries(env)) {
    dockerArgs.push('-e', `${key}=${value}`);
  }
  if (config.execution.verbose) {
    dockerArgs.push('-e', 'DC_VERBOSE=1');
  }
  dockerArgs.push(
    useSwebenchImage ? swebenchImageName : config.docker.workerImage,
    'node',
    '/benchmarks-src/worker/run-instance.mjs',
    '/work-input/input.json',
    '/work-output',
  );

  console.log(`${taskLabel} starting worker container ${containerName} (${useSwebenchImage ? swebenchImageName : config.docker.workerImage})`);
  console.log(`${taskLabel} input -> ${path.relative(runRoot, inputPath)}`);
  console.log(`${taskLabel} live logs -> ${path.relative(runRoot, dockerStdoutPath)} / ${path.relative(runRoot, dockerStderrPath)}`);
  for (const mountedPath of mountedPaths) {
    console.log(`${taskLabel} mount -> ${mountedPath}`);
  }

  let stdout = '';
  let stderr = '';
  let exitCode = -1;
  const startedAt = Date.now();
  try {
    const result = await runCommand('docker', dockerArgs, {
      cwd: REPO_ROOT,
      env: process.env,
      onStdout: (chunk) => streamWorkerChunk({
        taskLabel,
        chunk,
        stream: process.stdout,
      }),
      onStderr: (chunk) => streamWorkerChunk({
        taskLabel,
        chunk,
        stream: process.stderr,
      }),
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? String(error);
    exitCode = error.exitCode ?? 1;
  }

  console.log(`${taskLabel} worker container finished in ${Date.now() - startedAt}ms with exit code ${exitCode}`);

  await fs.writeFile(dockerStdoutPath, stdout, 'utf8');
  await fs.writeFile(dockerStderrPath, stderr, 'utf8');

  let result;
  if (await pathExists(resultPath)) {
    result = await readJson(resultPath);
  } else {
    result = {
      success: false,
      instanceId: task.instance.instance_id,
      mode: task.mode,
      patch: '',
      error: 'Worker did not produce result.json',
      commands: [],
    };
    await writeJson(resultPath, result);
  }

  result.controller = {
    exitCode,
    durationMs: Date.now() - startedAt,
    dockerStdoutPath: path.relative(runRoot, dockerStdoutPath),
    dockerStderrPath: path.relative(runRoot, dockerStderrPath),
  };
  result.modelNameOrPath = buildModelLabel({
    mode: task.mode,
    version: resolvedDeepClauseVersion,
    models: config.deepclause.models,
    temperatures: config.deepclause.temperatures,
  });
  await writeJson(resultPath, result);
  return result;
}

function collectWorkerEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) {
      continue;
    }
    if (
      key === 'OPENAI_API_KEY'
      || key === 'ANTHROPIC_API_KEY'
      || key === 'GOOGLE_GENERATIVE_AI_API_KEY'
      || key === 'OPENROUTER_API_KEY'
      || key === 'HTTP_PROXY'
      || key === 'HTTPS_PROXY'
      || key === 'NO_PROXY'
      || key.startsWith('LLM_PROVIDER_')
    ) {
      env[key] = value;
    }
  }
  return env;
}

function buildContainerName(runId, mode, instanceId) {
  return sanitizeSegment(`dc-${runId}-${mode}-${instanceId}`).slice(0, 63);
}

function buildModelLabel({ mode, version, models, temperatures }) {
  const parts = [
    `deepclause-sdk@${sanitizeSegment(version)}`,
    `mode-${sanitizeSegment(mode)}`,
    `gw-${sanitizeSegment(models.gateway)}`,
    `run-${sanitizeSegment(models.run)}`,
    `cmp-${sanitizeSegment(models.compile)}`,
    `temps-${sanitizeSegment(String(temperatures.gateway))}-${sanitizeSegment(String(temperatures.run))}-${sanitizeSegment(String(temperatures.compile))}`,
  ];
  return parts.join('__');
}

function buildSwebenchInstanceImageName(instanceId, platform, namespace) {
  const arch = platform.includes('arm64') ? 'arm64' : 'x86_64';
  const imageKey = `sweb.eval.${arch}.${instanceId.toLowerCase()}:latest`;
  if (namespace && namespace.toLowerCase() !== 'none') {
    return `${namespace}/${imageKey}`.replace('__', '_1776_');
  }
  return imageKey;
}

function buildModeSummary({ mode, modeResults, resolvedDeepClauseVersion, config }) {
  const completed = modeResults.filter((result) => result.success).length;
  const failures = modeResults.length - completed;
  const nonEmptyPatches = modeResults.filter((result) => Boolean(result.patch)).length;
  return {
    mode,
    instanceCount: modeResults.length,
    completed,
    failures,
    nonEmptyPatches,
    resolvedDeepClauseVersion,
    models: config.deepclause.models,
    temperatures: config.deepclause.temperatures,
  };
}

function groupByMode(results) {
  const grouped = new Map();
  for (const result of results) {
    const bucket = grouped.get(result.mode) ?? [];
    bucket.push(result);
    grouped.set(result.mode, bucket);
  }
  return grouped;
}

async function writePredictions(filePath, results) {
  const lines = results.map((result) => JSON.stringify({
    instance_id: result.instanceId,
    model_name_or_path: result.modelNameOrPath,
    model_patch: result.patch ?? '',
  }));
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function mapLimit(items, maxWorkers, iteratee) {
  const results = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: Math.min(maxWorkers, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      console.log(`Dispatching task ${currentIndex + 1}/${items.length}`);
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }));

  return results;
}

function buildRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `run-${stamp}`;
}

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
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
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        options.onStdout?.(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        options.onStderr?.(chunk);
      });
    }

    child.once('error', reject);
    child.once('close', (exitCode) => {
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

function streamWorkerChunk({ taskLabel, chunk, stream }) {
  const text = String(chunk);
  const lines = text.split(/\r?\n/);
  const endsWithNewline = /\r?\n$/.test(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isLast = index === lines.length - 1;
    if (isLast && !endsWithNewline && line === '') {
      continue;
    }
    if (line === '' && isLast && endsWithNewline) {
      continue;
    }
    stream.write(`${taskLabel} | ${line}\n`);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
