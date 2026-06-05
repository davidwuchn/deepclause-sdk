#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARKS_ROOT, '..');
const DATASET_PAGE_SIZE = 100;
const DATASET_ALIASES = new Map([
  ['lite', 'SWE-bench/SWE-bench_Lite'],
  ['swe-bench-lite', 'SWE-bench/SWE-bench_Lite'],
  ['swebench-lite', 'SWE-bench/SWE-bench_Lite'],
  ['swe_bench_lite', 'SWE-bench/SWE-bench_Lite'],
  ['princeton-nlp/swe-bench_lite', 'SWE-bench/SWE-bench_Lite'],
  ['swe-bench/swe-bench_lite', 'SWE-bench/SWE-bench_Lite'],
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.config) {
    throw new Error('--config is required');
  }

  const configPath = path.resolve(REPO_ROOT, args.config);
  const config = normalizeConfig(await readJson(configPath));
  const configName = path.basename(configPath, path.extname(configPath));
  const outputRoot = path.resolve(
    REPO_ROOT,
    args.outputDir ?? path.join('benchmarks', 'cache', `${configName}-offline`),
  );
  const datasetDir = path.join(outputRoot, 'datasets');
  const npmDir = path.join(outputRoot, 'npm');
  const reposDir = path.join(outputRoot, 'repos');
  await fs.mkdir(datasetDir, { recursive: true });
  await fs.mkdir(npmDir, { recursive: true });
  await fs.mkdir(reposDir, { recursive: true });

  console.log(`Preparing offline benchmark bundle in ${outputRoot}`);

  const resolvedDeepClauseVersion = await resolveDeepClauseVersion(config.deepclause.version);
  console.log(`Resolved deepclause-sdk version: ${resolvedDeepClauseVersion}`);

  const allInstances = await loadDatasetInstances(config.dataset.name, config.dataset.split);
  const selectedInstances = selectInstances(allInstances, config.dataset.instanceIds, config.dataset.offset, config.dataset.limit);
  if (selectedInstances.length === 0) {
    throw new Error('No dataset instances selected during prefetch.');
  }
  console.log(`Selected instances for offline bundle: ${selectedInstances.length}`);

  const datasetExportPath = path.join(datasetDir, 'selected-instances.json');
  await writeJson(datasetExportPath, selectedInstances);
  console.log(`Exported selected dataset rows to ${datasetExportPath}`);

  const tarballPath = await ensureDeepClauseTarball(resolvedDeepClauseVersion, npmDir);
  console.log(`Prepared deepclause-sdk tarball at ${tarballPath}`);

  const repos = buildSelectedRepoMap(selectedInstances);
  for (const [repo, commits] of repos.entries()) {
    await ensureRepoMirror(repo, commits, reposDir);
  }

  if (!args.skipWorkerImageBuild) {
    await ensureWorkerImage(config.docker.workerImage, config.docker.platform, Boolean(args.rebuildImages));
  }

  if (!args.skipEvaluatorImageBuild) {
    await ensureEvaluatorImage({
      imageTag: config.docker.evaluatorImage ?? 'deepclause-swebench-evaluator:latest',
      swebenchVersion: config.evaluation?.swebenchVersion ?? 'latest',
      rebuild: Boolean(args.rebuildImages),
    });
  }

  const offlineConfig = structuredClone(config);
  offlineConfig.dataset.name = toRepoRelative(datasetExportPath);
  offlineConfig.dataset.instanceIds = selectedInstances.map((instance) => String(instance.instance_id));
  offlineConfig.dataset.limit = selectedInstances.length;
  offlineConfig.dataset.offset = 0;
  offlineConfig.deepclause.version = resolvedDeepClauseVersion;
  offlineConfig.deepclause.packageTarball = toRepoRelative(tarballPath);
  offlineConfig.execution.repoCacheDir = toRepoRelative(reposDir);
  offlineConfig.docker.skipImageBuild = true;

  const offlineConfigPath = path.join(outputRoot, 'config.offline.json');
  await writeJson(offlineConfigPath, offlineConfig);

  const manifestPath = path.join(outputRoot, 'prefetch-manifest.json');
  await writeJson(manifestPath, {
    createdAt: new Date().toISOString(),
    sourceConfig: toRepoRelative(configPath),
    outputRoot: toRepoRelative(outputRoot),
    resolvedDeepClauseVersion,
    selectedInstances: selectedInstances.map((instance) => instance.instance_id),
    datasetExportPath: toRepoRelative(datasetExportPath),
    deepclauseTarball: toRepoRelative(tarballPath),
    repoCacheDir: toRepoRelative(reposDir),
    offlineConfigPath: toRepoRelative(offlineConfigPath),
    workerImage: config.docker.workerImage,
    evaluatorImage: config.docker.evaluatorImage ?? 'deepclause-swebench-evaluator:latest',
  });

  console.log('Offline bundle is ready.');
  console.log(`Offline config: ${offlineConfigPath}`);
  console.log('Run later with:');
  console.log(`  npm run benchmark:swebench -- --config ${toRepoRelative(offlineConfigPath)}`);
  if (config.execution?.repoSetup?.mode !== 'none') {
    console.log('');
    console.log('Note: repository dependency installation is not fully prefetched yet.');
    console.log('The worker may still attempt pip/npm installs during repo setup.');
    console.log('If you need a stricter offline run, use:');
    console.log(`  npm run benchmark:swebench -- --config ${toRepoRelative(offlineConfigPath)} --repo-setup none`);
  }
}

function parseArgs(argv) {
  const args = {};

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
    if (arg === '--output-dir') {
      args.outputDir = readValue();
      continue;
    }
    if (arg === '--skip-worker-image-build') {
      args.skipWorkerImageBuild = true;
      continue;
    }
    if (arg === '--skip-evaluator-image-build') {
      args.skipEvaluatorImageBuild = true;
      continue;
    }
    if (arg === '--rebuild-images') {
      args.rebuildImages = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node benchmarks/prefetch-swebench-lite.mjs --config <file> [options]

Options:
  --config <file>                 Benchmark config to prefetch for
  --output-dir <path>            Output bundle directory (default: benchmarks/cache/<config>-offline)
  --skip-worker-image-build      Do not build the worker image during prefetch
  --skip-evaluator-image-build   Do not build the evaluator image during prefetch
  --rebuild-images               Force rebuild of benchmark images
  --help                         Show this help
`);
}

function normalizeConfig(config) {
  const next = structuredClone(config);
  next.dataset.name = normalizeDatasetName(next.dataset.name);
  next.dataset.instanceIds = [...new Set((next.dataset.instanceIds ?? []).map(String))];
  next.dataset.offset = next.dataset.offset ?? 0;
  next.dataset.split = String(next.dataset.split ?? 'test');
  next.dataset.limit = next.dataset.limit ?? undefined;
  next.deepclause = next.deepclause ?? {};
  next.deepclause.version = String(next.deepclause.version ?? 'latest');
  next.docker = next.docker ?? {};
  next.docker.platform = String(next.docker.platform ?? 'linux/amd64');
  next.docker.workerImage = String(next.docker.workerImage ?? 'deepclause-swebench-worker:latest');
  next.docker.evaluatorImage = String(next.docker.evaluatorImage ?? 'deepclause-swebench-evaluator:latest');
  next.evaluation = next.evaluation ?? {};
  next.evaluation.swebenchVersion = String(next.evaluation.swebenchVersion ?? 'latest');
  next.execution = next.execution ?? {};
  return next;
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
  return String(JSON.parse(stdout.trim()));
}

async function loadDatasetInstances(datasetName, split) {
  if (datasetName.endsWith('.json') || datasetName.endsWith('.jsonl')) {
    const resolved = path.resolve(REPO_ROOT, datasetName);
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

async function ensureDeepClauseTarball(resolvedVersion, npmDir) {
  const existing = await findExistingTarball(npmDir, resolvedVersion);
  if (existing) {
    return existing;
  }

  console.log(`Downloading deepclause-sdk@${resolvedVersion} tarball...`);
  const { stdout } = await runCommand('npm', ['pack', `deepclause-sdk@${resolvedVersion}`, '--pack-destination', npmDir], {
    cwd: REPO_ROOT,
  });
  const fileName = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!fileName) {
    throw new Error('npm pack did not report a tarball file name');
  }
  return path.join(npmDir, fileName);
}

async function findExistingTarball(npmDir, resolvedVersion) {
  try {
    const entries = await fs.readdir(npmDir);
    const match = entries.find((entry) => entry.startsWith(`deepclause-sdk-${resolvedVersion}`) && entry.endsWith('.tgz'));
    return match ? path.join(npmDir, match) : null;
  } catch {
    return null;
  }
}

function buildSelectedRepoMap(selectedInstances) {
  const repos = new Map();
  for (const instance of selectedInstances) {
    const repo = String(instance.repo);
    const bucket = repos.get(repo) ?? new Set();
    bucket.add(String(instance.base_commit));
    repos.set(repo, bucket);
  }
  return repos;
}

async function ensureRepoMirror(repo, commits, reposDir) {
  const mirrorPath = path.join(reposDir, buildRepoCacheFileName(repo));
  if (await pathExists(mirrorPath)) {
    console.log(`Updating repo mirror ${repo}`);
    await runCommand('git', ['-C', mirrorPath, 'remote', 'update', '--prune'], {
      cwd: REPO_ROOT,
      streamOutput: true,
    });
  } else {
    console.log(`Cloning repo mirror ${repo}`);
    await runCommand('git', ['clone', '--mirror', `https://github.com/${repo}.git`, mirrorPath], {
      cwd: REPO_ROOT,
      streamOutput: true,
    });
  }

  for (const commit of commits) {
    if (await hasCommit(mirrorPath, commit)) {
      continue;
    }
    console.log(`Fetching missing commit ${commit} for ${repo}`);
    await runCommand('git', ['-C', mirrorPath, 'fetch', 'origin', commit], {
      cwd: REPO_ROOT,
      streamOutput: true,
    });
  }
}

function buildRepoCacheFileName(repo) {
  return `${String(repo).replace(/[\\/]+/g, '__')}.git`;
}

async function hasCommit(mirrorPath, commit) {
  try {
    await runCommand('git', ['-C', mirrorPath, 'rev-parse', '--verify', `${commit}^{commit}`], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkerImage(imageTag, platform, rebuild) {
  if (!rebuild && await dockerImageExists(imageTag)) {
    console.log(`Worker image ${imageTag} already present.`);
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

async function ensureEvaluatorImage({ imageTag, swebenchVersion, rebuild }) {
  if (!rebuild && await dockerImageExists(imageTag)) {
    console.log(`Evaluator image ${imageTag} already present.`);
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

function toRepoRelative(filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(REPO_ROOT, absolute);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return absolute;
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