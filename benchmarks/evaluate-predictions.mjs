#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARKS_ROOT, '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.predictions) {
    throw new Error('--predictions is required');
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
    '--dataset_name', args.dataset ?? 'SWE-bench/SWE-bench_Lite',
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

Options:
  --predictions <file>         Predictions JSONL file to evaluate
  --run-id <name>              SWE-bench evaluation run id
  --dataset <name>             Dataset name (default: SWE-bench/SWE-bench_Lite)
  --split <name>               Dataset split (default: test)
  --max-workers <n>            Evaluation max_workers value
  --cache-level <level>        none, base, env, or instance
  --clean <true|false>         Clean images above cache level
  --namespace <name|none>      Docker namespace for SWE-bench images
  --report-dir <dir>           Report output directory
  --instance-id <id>           Repeatable instance selector
  --swebench-version <ver>     latest or exact swebench version
  --image <tag>                Evaluator image tag
  --rebuild-image              Rebuild evaluator image
  --skip-image-build           Skip evaluator docker build
  --help                       Show this help
`);
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
