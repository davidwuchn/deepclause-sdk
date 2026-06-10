#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARKS_ROOT, '..');
const DATASET_ALIASES = new Map([
  ['lite', 'SWE-bench/SWE-bench_Lite'],
  ['swe-bench-lite', 'SWE-bench/SWE-bench_Lite'],
  ['swebench-lite', 'SWE-bench/SWE-bench_Lite'],
  ['swe_bench_lite', 'SWE-bench/SWE-bench_Lite'],
  ['verified', 'SWE-bench/SWE-bench_Verified'],
  ['swe-bench-verified', 'SWE-bench/SWE-bench_Verified'],
  ['swebench-verified', 'SWE-bench/SWE-bench_Verified'],
  ['swe_bench_verified', 'SWE-bench/SWE-bench_Verified'],
  ['pro', 'ScaleAI/SWE-bench_Pro'],
  ['swe-bench-pro', 'ScaleAI/SWE-bench_Pro'],
  ['swebench-pro', 'ScaleAI/SWE-bench_Pro'],
  ['swe_bench_pro', 'ScaleAI/SWE-bench_Pro'],
  ['scaleai/swe-bench_pro', 'ScaleAI/SWE-bench_Pro'],
]);

async function mainFromRun(args) {
  const runDirName = args.run;
  const mode = args.mode ?? 'prompt';
  const runRoot = path.resolve(REPO_ROOT, args.runRoot ?? 'benchmarks/runs', runDirName);
  const instancesDir = path.join(runRoot, mode, 'instances');

  const entries = await fs.readdir(instancesDir, { withFileTypes: true });
  const instanceDirs = entries.filter((e) => e.isDirectory());
  if (instanceDirs.length === 0) {
    throw new Error(`No instance directories found in ${instancesDir}`);
  }

  const predictions = [];
  const discoveredIds = [];
  for (const entry of instanceDirs) {
    const resultPath = path.join(instancesDir, entry.name, 'result.json');
    let result;
    try {
      result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch {
      console.warn(`Skipping ${entry.name}: no readable result.json`);
      continue;
    }
    if (!result.patch && result.patch !== '') {
      console.warn(`Skipping ${entry.name}: result.json has no patch field`);
      continue;
    }
    predictions.push({
      instance_id: result.instanceId ?? entry.name,
      model_name_or_path: result.modelNameOrPath ?? 'unknown',
      model_patch: result.patch ?? '',
    });
    discoveredIds.push(result.instanceId ?? entry.name);
  }

  if (predictions.length === 0) {
    throw new Error('No completed instances with patches found');
  }

  console.log(`Discovered ${predictions.length} completed instances from ${instancesDir}`);

  const evalRunId = args.runId ?? `${runDirName}-${mode}-eval`;
  const reportDir = path.resolve(REPO_ROOT, args.reportDir ?? path.join(runRoot, mode, 'evaluation'));
  await fs.mkdir(reportDir, { recursive: true });

  const tmpPredictionsPath = path.join(reportDir, '_predictions_from_run.jsonl');
  const lines = predictions.map((p) => JSON.stringify(p));
  await fs.writeFile(tmpPredictionsPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote temporary predictions to ${tmpPredictionsPath}`);

  if (args.instanceIds.length > 0) {
    const idSet = new Set(args.instanceIds);
    const before = discoveredIds.length;
    const filtered = discoveredIds.filter((id) => idSet.has(id));
    if (filtered.length === 0) {
      throw new Error(`None of the --instance-id values match discovered instances (${before} total)`);
    }
    discoveredIds.length = 0;
    discoveredIds.push(...filtered);
    console.log(`Filtered to ${filtered.length}/${before} instances via --instance-id`);
  }

  const swebenchVersion = args.swebenchVersion ?? 'latest';
  const imageTag = args.image ?? 'deepclause-swebench-evaluator:latest';
  if (!args.skipImageBuild) {
    await ensureEvaluatorImage({
      imageTag,
      swebenchVersion,
      rebuild: Boolean(args.rebuildImage),
    });
  }

  const dockerArgs = [
    'run',
    '--rm',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${REPO_ROOT}:/repo`,
    '-w', '/repo',
    imageTag,
    'python',
    '-m', 'swebench.harness.run_evaluation',
    '--dataset_name', normalizeDatasetName(args.dataset),
    '--split', args.split ?? 'test',
    '--predictions_path', toContainerPath(tmpPredictionsPath),
    '--max_workers', String(args.maxWorkers ?? 4),
    '--run_id', evalRunId,
    '--cache_level', args.cacheLevel ?? 'env',
    '--clean', String(parseBoolean(args.clean ?? 'false')),
    '--report_dir', toContainerPath(reportDir),
  ];

  const namespace = args.namespace ?? 'swebench';
  if (namespace.toLowerCase() === 'none') {
    dockerArgs.push('--namespace', 'none');
  } else {
    dockerArgs.push('--namespace', namespace);
  }

  dockerArgs.push('--instance_ids', ...discoveredIds);

  await runCommand('docker', dockerArgs, { cwd: REPO_ROOT, streamOutput: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.run) {
    await mainFromRun(args);
    return;
  }

  if (!args.predictions) {
    throw new Error('--predictions or --run is required');
  }
  if (!args.runId) {
    throw new Error('--run-id is required');
  }

  const predictionsPath = path.resolve(REPO_ROOT, args.predictions);
  const reportDir = path.resolve(REPO_ROOT, args.reportDir ?? path.join(path.dirname(args.predictions), 'evaluation'));
  await fs.mkdir(reportDir, { recursive: true });

  const swebenchVersion = args.swebenchVersion ?? 'latest';
  const imageTag = args.image ?? 'deepclause-swebench-evaluator:latest';
  if (!args.skipImageBuild) {
    await ensureEvaluatorImage({
      imageTag,
      swebenchVersion,
      rebuild: Boolean(args.rebuildImage),
    });
  }

  const dockerArgs = [
    'run',
    '--rm',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${REPO_ROOT}:/repo`,
    '-w', '/repo',
    imageTag,
    'python',
    '-m', 'swebench.harness.run_evaluation',
    '--dataset_name', normalizeDatasetName(args.dataset),
    '--split', args.split ?? 'test',
    '--predictions_path', toContainerPath(predictionsPath),
    '--max_workers', String(args.maxWorkers ?? 4),
    '--run_id', args.runId,
    '--cache_level', args.cacheLevel ?? 'env',
    '--clean', String(parseBoolean(args.clean ?? 'false')),
    '--report_dir', toContainerPath(reportDir),
  ];

  const namespace = args.namespace ?? 'swebench';
  if (namespace.toLowerCase() === 'none') {
    dockerArgs.push('--namespace', 'none');
  } else {
    dockerArgs.push('--namespace', namespace);
  }

  if (args.instanceIds.length > 0) {
    dockerArgs.push('--instance_ids', ...args.instanceIds);
  }

  await runCommand('docker', dockerArgs, { cwd: REPO_ROOT, streamOutput: true });
}

function parseArgs(argv) {
  const args = {
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
    if (arg === '--predictions') {
      args.predictions = readValue();
      continue;
    }
    if (arg === '--run') {
      args.run = readValue();
      continue;
    }
    if (arg === '--mode') {
      args.mode = readValue();
      continue;
    }
    if (arg === '--run-root') {
      args.runRoot = readValue();
      continue;
    }
    if (arg === '--run-id') {
      args.runId = readValue();
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
    if (arg === '--max-workers') {
      args.maxWorkers = Number(readValue());
      continue;
    }
    if (arg === '--cache-level') {
      args.cacheLevel = readValue();
      continue;
    }
    if (arg === '--clean') {
      args.clean = readValue();
      continue;
    }
    if (arg === '--namespace') {
      args.namespace = readValue();
      continue;
    }
    if (arg === '--report-dir') {
      args.reportDir = readValue();
      continue;
    }
    if (arg === '--instance-id') {
      args.instanceIds.push(readValue());
      continue;
    }
    if (arg === '--swebench-version') {
      args.swebenchVersion = readValue();
      continue;
    }
    if (arg === '--image') {
      args.image = readValue();
      continue;
    }
    if (arg === '--rebuild-image') {
      args.rebuildImage = true;
      continue;
    }
    if (arg === '--skip-image-build') {
      args.skipImageBuild = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node benchmarks/evaluate-predictions.mjs [options]

Modes:
  Explicit predictions file:
    --predictions <file>       Predictions JSONL file to evaluate
    --run-id <name>            SWE-bench evaluation run id

  Auto-discover from run directory:
    --run <run-id>             Run directory name under benchmarks/runs/
    --mode <prompt|plan-execute> Mode subdirectory (default: prompt)
    --run-root <path>          Root for run directories (default: benchmarks/runs)

Options:
  --dataset <name>             Dataset alias or name (default: lite)
  --split <name>               Dataset split (default: test)
  --max-workers <n>            Evaluation max_workers value
  --cache-level <level>        none, base, env, or instance
  --clean <true|false>         Clean images above cache level
  --namespace <name|none>      Docker namespace for SWE-bench images
  --report-dir <dir>           Report output directory
  --instance-id <id>           Repeatable instance selector (filters discovered instances)
  --swebench-version <ver>     latest or exact swebench version
  --image <tag>                Evaluator image tag
  --rebuild-image              Rebuild evaluator image
  --skip-image-build           Skip evaluator docker build
  --help                       Show this help
`);
}

function normalizeDatasetName(name) {
  const raw = String(name ?? 'lite');
  return DATASET_ALIASES.get(raw.toLowerCase()) ?? raw;
}

async function ensureEvaluatorImage({ imageTag, swebenchVersion, rebuild }) {
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

async function dockerImageExists(imageTag) {
  try {
    await runCommand('docker', ['image', 'inspect', imageTag], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

function toContainerPath(hostPath) {
  const relative = path.relative(REPO_ROOT, hostPath).split(path.sep).join('/');
  return `/repo/${relative}`;
}

function parseBoolean(value) {
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
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
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
