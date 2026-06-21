#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARKS_ROOT, '..');
const DEFAULT_CONFIG = {
  dataset: {
    testDataDir: 'benchmarks/nl2repo/test-data',
    tasks: [],
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
    agentTimeoutSeconds: 7200,
    setupTimeoutSeconds: 1800,
    maxIterations: 100,
    verbose: false,
  },
  docker: {
    platform: 'linux/amd64',
    workerImage: 'deepclause-nl2repo-worker:latest',
    rebuildImages: false,
    skipImageBuild: false,
  },
  evaluation: {
    pullBaseImages: true,
    removePackageFiles: true,
    removeTestFiles: true,
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
  ['compile', 'compile'],
]);
const PACKAGE_MGMT_FILES = [
  'setup.py', 'pyproject.toml', 'setup.cfg', 'requirements.txt',
  'requirements-dev.txt', 'requirements-test.txt', 'tox.ini',
  'pytest.ini', 'poetry.lock', 'Pipfile', 'Pipfile.lock',
  'environment.yml', 'conda-env.yaml', 'manifest.in', 'MANIFEST.in',
];

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

  const allTasks = await loadTasks(config.dataset.testDataDir);
  const selectedTasks = selectTasks(allTasks, config.dataset.tasks, config.dataset.offset, config.dataset.limit);
  if (selectedTasks.length === 0) {
    throw new Error('No tasks selected. Run benchmarks/nl2repo.sh setup first, or specify --task names.');
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    runId,
    resolvedDeepClauseVersion,
    benchmarksRoot: BENCHMARKS_ROOT,
    repoRoot: REPO_ROOT,
    benchmarkType: 'nl2repo',
    consistencyNotes: {
      prompt: 'deepclause -p uses the conductor and the gateway slot.',
      'plan-execute': 'TUI /plan and /<plan> both route through deepclause run and therefore the run slot.',
      compile: 'deepclause compile uses the compile slot, deepclause run uses the run slot.',
    },
    config,
  };
  await writeJson(path.join(runRoot, 'manifest.json'), manifest);

  if (!config.docker.skipImageBuild) {
    await ensureWorkerImage(config.docker.workerImage, config.docker.platform, config.docker.rebuildImages);
  }

  console.log(`Resolved deepclause-sdk version: ${resolvedDeepClauseVersion}`);
  console.log(`Selected tasks: ${selectedTasks.length} of ${allTasks.length}`);
  console.log(`Modes: ${config.modes.join(', ')}`);
  console.log(`Run ID: ${runId}`);
  console.log(`Run root: ${runRoot}`);
  if (config.deepclause.packageTarball) {
    console.log(`Using local deepclause package tarball: ${config.deepclause.packageTarball}`);
  }

  for (const mode of config.modes) {
    await fs.mkdir(path.join(runRoot, mode, 'instances'), { recursive: true });
  }

  const taskQueue = [];
  for (const mode of config.modes) {
    for (const task of selectedTasks) {
      taskQueue.push({ mode, task });
    }
  }

  console.log(`Queued tasks: ${taskQueue.length}`);
  for (const [index, task] of taskQueue.entries()) {
    console.log(`  [queue ${index + 1}/${taskQueue.length}] ${task.mode} :: ${task.task.name}`);
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
    console.log(`[${task.mode}] ${task.task.name} -> ${state}`);
    return result;
  });

  const evalResults = await evaluateResults({
    results,
    runRoot,
    config,
    runId,
  });

  const grouped = groupByMode(results);
  for (const [mode, modeResults] of grouped.entries()) {
    const modeRoot = path.join(runRoot, mode);
    const modeEvalResults = evalResults.filter((r) => r.mode === mode);
    const summary = buildModeSummary({
      mode,
      modeResults,
      modeEvalResults,
      resolvedDeepClauseVersion,
      config,
    });

    await writePredictions(path.join(modeRoot, 'predictions.jsonl'), modeResults);
    await writeJson(path.join(modeRoot, 'summary.json'), summary);
  }

  await writeJson(path.join(runRoot, 'summary.json'), {
    runId,
    createdAt: manifest.createdAt,
    resolvedDeepClauseVersion,
    benchmarkType: 'nl2repo',
    selectedTasks: selectedTasks.length,
    totalTasks: allTasks.length,
    modes: Object.fromEntries([...grouped.entries()].map(([mode, modeResults]) => {
      const modeEvalResults = evalResults.filter((r) => r.mode === mode);
      return [
        mode,
        buildModeSummary({ mode, modeResults, modeEvalResults, resolvedDeepClauseVersion, config }),
      ];
    })),
  });

  console.log(`Artifacts written to ${runRoot}`);

  console.log('');
  console.log('=== NL2Repo Benchmark Summary ===');
  for (const evalResult of evalResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    console.log(`  [${evalResult.mode}] ${evalResult.taskName}: score=${evalResult.score}/${evalResult.totalTests} (${((evalResult.successRate ?? 0) * 100).toFixed(1)}%) status=${evalResult.status}`);
  }
  const totalPassed = evalResults.reduce((sum, r) => sum + (r.passedTests ?? 0), 0);
  const totalTests = evalResults.reduce((sum, r) => sum + (r.totalTests ?? 0), 0);
  console.log(`  TOTAL: ${totalPassed}/${totalTests} (${totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(1) : '0.0'}%)`);
  console.log('');

  await dockerPrune();
}

async function loadTasks(testDataDir) {
  const resolvedDir = path.resolve(REPO_ROOT, testDataDir);
  if (!await pathExists(resolvedDir)) {
    console.log(`Test data directory not found: ${resolvedDir}`);
    console.log('Run benchmarks/nl2repo.sh setup first.');
    return [];
  }

  const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  const tasks = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const taskDir = path.join(resolvedDir, entry.name);
    const task = await loadTaskMetadata(entry.name, taskDir);
    if (task) {
      tasks.push(task);
    }
  }

  return tasks.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadTaskMetadata(name, taskDir) {
  const files = await fs.readdir(taskDir);
  const task = { name, testCaseCount: 0, testCommands: [], testFiles: [], startMd: '', imageTag: '' };

  const txtFiles = files.filter((f) => f.endsWith('.txt'));
  if (txtFiles.length > 0) {
    const content = await fs.readFile(path.join(taskDir, txtFiles[0]), 'utf8');
    task.testCaseCount = parseInt(content.trim(), 10) || 0;
  }

  const commandsFiles = files.filter((f) => f.endsWith('.json') && f.includes('commands'));
  if (commandsFiles.length > 0) {
    task.testCommands = JSON.parse(await fs.readFile(path.join(taskDir, commandsFiles[0]), 'utf8'));
  }

  const filesFiles = files.filter((f) => f.endsWith('.json') && f.includes('files'));
  if (filesFiles.length > 0) {
    task.testFiles = JSON.parse(await fs.readFile(path.join(taskDir, filesFiles[0]), 'utf8'));
  }

  const mdFiles = files.filter((f) => f.endsWith('.md'));
  if (mdFiles.length > 0) {
    const content = await fs.readFile(path.join(taskDir, mdFiles[0]), 'utf8');
    task.startMd = Buffer.from(content, 'utf8').toString('base64');
  }

  task.imageTag = `${name}:1.0`;

  if (!task.startMd) {
    console.log(`Skipping task ${name}: no start.md found`);
    return null;
  }

  return task;
}

function selectTasks(tasks, taskNames, offset, limit) {
  let selected = [...tasks];
  if (taskNames.length > 0) {
    const nameSet = new Set(taskNames);
    selected = selected.filter((task) => nameSet.has(task.name));
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
  const instanceRoot = path.join(modeRoot, 'instances', sanitizeSegment(task.task.name));
  await fs.mkdir(instanceRoot, { recursive: true });
  const inputPath = path.join(instanceRoot, 'input.json');
  const dockerStdoutPath = path.join(instanceRoot, 'docker.stdout.log');
  const dockerStderrPath = path.join(instanceRoot, 'docker.stderr.log');
  const resultPath = path.join(instanceRoot, 'result.json');

  const workerInput = {
    runId,
    mode: task.mode,
    task: task.task,
    deepclauseVersion: resolvedDeepClauseVersion,
    deepclausePackageTarball: undefined,
    deepclause: config.deepclause,
    execution: config.execution,
  };
  await writeJson(inputPath, workerInput);

  const env = collectWorkerEnv(config);
  const containerName = buildContainerName(runId, task.mode, task.task.name);
  const taskLabel = `[${task.mode}] ${task.task.name}`;
  const mountedPaths = [];

  const dockerArgs = [
    'run',
    '--rm',
    '--name', containerName,
    '--platform', config.docker.platform,
    '-v', `${BENCHMARKS_ROOT}:/benchmarks-src:ro`,
    '-v', `${instanceRoot}:/work-output`,
    '-v', `${inputPath}:/work-input/input.json:ro`,
  ];

  if (config.deepclause.packageTarball) {
    const packageTarballPath = path.resolve(REPO_ROOT, config.deepclause.packageTarball);
    if (!await pathExists(packageTarballPath)) {
      throw new Error(`Configured deepclause package tarball not found: ${packageTarballPath}`);
    }
    dockerArgs.push('-v', `${packageTarballPath}:/work-cache/deepclause-sdk.tgz:ro`);
    workerInput.deepclausePackageTarball = '/work-cache/deepclause-sdk.tgz';
    mountedPaths.push(`deepclause package ${packageTarballPath}`);
  }

  await writeJson(inputPath, workerInput);

  for (const [key, value] of Object.entries(env)) {
    dockerArgs.push('-e', `${key}=${value}`);
  }
  if (config.execution.verbose) {
    dockerArgs.push('-e', 'DC_VERBOSE=1');
  }

  dockerArgs.push(
    config.docker.workerImage,
    'node',
    '/benchmarks-src/nl2repo/worker/run-instance.mjs',
    '/work-input/input.json',
    '/work-output',
  );

  console.log(`${taskLabel} starting worker container ${containerName} (${config.docker.workerImage})`);
  console.log(`${taskLabel} input -> ${path.relative(runRoot, inputPath)}`);
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
      onStdout: (chunk) => streamWorkerChunk({ taskLabel, chunk, stream: process.stdout }),
      onStderr: (chunk) => streamWorkerChunk({ taskLabel, chunk, stream: process.stderr }),
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
      taskName: task.task.name,
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

async function evaluateResults({ results, runRoot, config, runId }) {
  const evalResults = [];

  for (const result of results) {
    const mode = result.mode;
    const taskName = result.taskName ?? result.instanceId;
    const instanceRoot = path.join(runRoot, mode, 'instances', sanitizeSegment(taskName));
    const workspaceDir = path.join(instanceRoot, 'workspace');

    if (!await pathExists(workspaceDir)) {
      console.log(`[eval] ${taskName}: no workspace to evaluate`);
      evalResults.push({
        mode,
        taskName,
        score: 0,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        errors: 0,
        successRate: 0,
        status: 'no-workspace',
      });
      continue;
    }

    try {
      const evalResult = await evaluateTask({
        mode,
        taskName,
        workspaceDir,
        instanceRoot,
        config,
      });
      evalResults.push(evalResult);
    } catch (error) {
      console.log(`[eval] ${taskName} evaluation failed: ${error.message}`);
      evalResults.push({
        mode,
        taskName,
        score: 0,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        errors: 0,
        successRate: 0,
        status: 'eval-error',
        error: error.message,
      });
    }
  }

  await writeJson(path.join(runRoot, 'evaluation-results.json'), evalResults);
  return evalResults;
}

async function evaluateTask({ mode, taskName, workspaceDir, instanceRoot, config }) {
  const testDataDir = path.resolve(REPO_ROOT, config.dataset.testDataDir);
  const taskDataDir = path.join(testDataDir, taskName);
  let testCaseCount = 0;
  let testCommands = [];
  let testFiles = [];

  if (await pathExists(taskDataDir)) {
    const taskFiles = await fs.readdir(taskDataDir);

    const txtFile = taskFiles.find((f) => f.endsWith('.txt'));
    if (txtFile) {
      testCaseCount = parseInt((await fs.readFile(path.join(taskDataDir, txtFile), 'utf8')).trim(), 10) || 0;
    }

    const commandsFile = taskFiles.find((f) => f.endsWith('.json') && f.includes('commands'));
    if (commandsFile) {
      testCommands = JSON.parse(await fs.readFile(path.join(taskDataDir, commandsFile), 'utf8'));
    }

    const filesFile = taskFiles.find((f) => f.endsWith('.json') && f.includes('files'));
    if (filesFile) {
      testFiles = JSON.parse(await fs.readFile(path.join(taskDataDir, filesFile), 'utf8'));
    }
  }

  if (config.evaluation.removePackageFiles) {
    for (const fileName of PACKAGE_MGMT_FILES) {
      const filePath = path.join(workspaceDir, fileName);
      if (await pathExists(filePath)) {
        await fs.rm(filePath, { force: true });
      }
    }
  }

  if (config.evaluation.removeTestFiles) {
    for (const testFile of testFiles) {
      const filePath = path.join(workspaceDir, testFile);
      if (await pathExists(filePath)) {
        await fs.rm(filePath, { recursive: true, force: true });
      }
    }
  }

  const baseImage = `ghcr.io/multimodal-art-projection/nl2repobench/${taskName}:1.0`;
  const testImageTag = `nl2repo-test-${sanitizeSegment(taskName)}`;

  if (config.evaluation.pullBaseImages) {
    console.log(`[eval] ${taskName}: pulling base image ${baseImage}`);
    try {
      await runCommand('docker', ['pull', '--platform', config.docker.platform, baseImage], {
        cwd: REPO_ROOT,
        streamOutput: true,
      });
    } catch (error) {
      throw new Error(`Base image pull failed for ${baseImage}: ${error.message}`);
    }
  }

  const dockerfilePath = path.join(instanceRoot, 'Dockerfile.eval');
  await fs.writeFile(dockerfilePath, [
    `FROM --platform=${config.docker.platform} ${baseImage}`,
    'COPY workspace /workspace-agent/',
    'RUN rm -rf /workspace-agent/tests /workspace-agent/pyproject.toml /workspace-agent/setup.py /workspace-agent/setup.cfg',
    'RUN cp -r /workspace-agent/* /workspace/ 2>/dev/null; true',
    'RUN rm -rf /workspace-agent',
    'WORKDIR /workspace',
    'ENV PYTHONPATH=/workspace:$PYTHONPATH',
    'CMD ["tail", "-f", "/dev/null"]',
  ].join('\n'), 'utf8');

  console.log(`[eval] ${taskName}: building test image ${testImageTag}`);
  try {
    await runCommand('docker', [
      'build',
      '--platform', config.docker.platform,
      '-t', testImageTag,
      '-f', dockerfilePath,
      instanceRoot,
    ], {
      cwd: REPO_ROOT,
      streamOutput: true,
    });
  } catch (error) {
    throw new Error(`Test image build failed: ${error.message}`);
  }

  const evalContainerName = `nl2repo-eval-${sanitizeSegment(taskName)}-${Date.now()}`;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalErrors = 0;
  const commandResults = [];

  console.log(`[eval] ${taskName}: starting test container`);
  try {
    await runCommand('docker', [
      'run', '-d',
      '--name', evalContainerName,
      '--platform', config.docker.platform,
      testImageTag,
    ], { cwd: REPO_ROOT });
  } catch (error) {
    throw new Error(`Failed to start test container: ${error.message}`);
  }

  try {
    console.log(`[eval] ${taskName}: waiting for container to be ready...`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await runCommand('docker', ['exec', evalContainerName, 'true'], { cwd: REPO_ROOT, timeoutSeconds: 10 });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    for (const command of testCommands) {
      console.log(`[eval] ${taskName}: running: ${command}`);
      let cmdStdout = '';
      let cmdStderr = '';
      let cmdExitCode = 0;
      try {
        const cmdResult = await runCommand('docker', [
          'exec', evalContainerName,
          'bash', '-lc', command,
        ], { cwd: REPO_ROOT, timeoutSeconds: 600 });
        cmdStdout = cmdResult.stdout;
        cmdStderr = cmdResult.stderr ?? '';
        cmdExitCode = 0;
      } catch (error) {
        cmdStdout = error.stdout ?? '';
        cmdStderr = error.stderr ?? '';
        cmdExitCode = error.exitCode ?? 1;
        console.log(`[eval] ${taskName}: command exited with code ${cmdExitCode}`);
      }

      if (cmdExitCode !== 0 && cmdStderr) {
        const lastLines = cmdStderr.trim().split('\n').slice(-5).join('\n');
        console.log(`[eval] ${taskName}: stderr tail:\n${lastLines}`);
      }

      commandResults.push({
        command,
        exitCode: cmdExitCode,
        output: cmdStdout.slice(-10000),
      });

      if (command.includes('pytest')) {
        const parsed = analyzePytestOutput(cmdStdout);
        totalPassed += parsed.passed;
        totalFailed += parsed.failed;
        totalErrors += parsed.errors;
        console.log(`[eval] ${taskName}: pytest results -> passed=${parsed.passed} failed=${parsed.failed} errors=${parsed.errors}`);
      }
    }
  } finally {
    await runCommand('docker', ['stop', evalContainerName], { cwd: REPO_ROOT }).catch(() => {});
    await runCommand('docker', ['rm', '-f', evalContainerName], { cwd: REPO_ROOT }).catch(() => {});
  }

  const total = testCaseCount || (totalPassed + totalFailed + totalErrors);
  const successRate = total > 0 ? Math.min(totalPassed / total, 1.0) : 0;

  console.log(`[eval] ${taskName}: FINAL score=${totalPassed}/${total} successRate=${(successRate * 100).toFixed(1)}%`);

  const evalResult = {
    mode,
    taskName,
    score: totalPassed,
    totalTests: total,
    passedTests: totalPassed,
    failedTests: totalFailed,
    errors: totalErrors,
    successRate,
    status: 'completed',
    commandResults,
  };

  await writeJson(path.join(instanceRoot, 'evaluation.json'), evalResult);
  return evalResult;
}

function analyzePytestOutput(output) {
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const line of output.split('\n')) {
    const passedMatch = line.match(/(\d+) passed/);
    if (passedMatch) {
      passed += parseInt(passedMatch[1], 10);
    }
    const failedMatch = line.match(/(\d+) failed/);
    if (failedMatch) {
      failed += parseInt(failedMatch[1], 10);
    }
    const errorMatch = line.match(/(\d+) error/);
    if (errorMatch) {
      errors += parseInt(errorMatch[1], 10);
    }
  }

  return { passed, failed, errors };
}

function parseArgs(argv) {
  const args = {
    modes: [],
    tasks: [],
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
    if (arg === '--task') {
      args.tasks.push(readValue());
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
    if (arg === '--max-iterations') {
      args.maxIterations = Number(readValue());
      continue;
    }
    if (arg === '--test-data-dir') {
      args.testDataDir = readValue();
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
    if (arg === '--skip-eval') {
      args.skipEval = true;
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
  console.log(`Usage: node benchmarks/run-nl2repo.mjs [options]

Options:
  --config <file>              Load JSON config file
  --mode <prompt|plan-execute|compile>  Repeatable benchmark mode selector
  --task <name>                Repeatable task name selector (e.g. emoji, math-verify)
  --limit <n>                  Limit selected tasks
  --offset <n>                 Offset after filtering
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
  --max-iterations <n>         Max agent loop iterations (default: 100)
  --test-data-dir <path>       Path to test data directory
  --platform <name>            Docker platform, e.g. linux/amd64
  --rebuild-images             Rebuild worker image
  --skip-image-build           Skip docker build step
  --skip-eval                  Skip evaluation (only run agent)
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
  if (args.tasks.length > 0) {
    next.dataset.tasks = args.tasks;
  }
  if (args.limit !== undefined) {
    next.dataset.limit = args.limit;
  }
  if (args.offset !== undefined) {
    next.dataset.offset = args.offset;
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
  if (Number.isFinite(args.maxIterations)) {
    next.execution.maxIterations = args.maxIterations;
  }
  if (args.testDataDir) {
    next.dataset.testDataDir = args.testDataDir;
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
  if (args.skipEval) {
    next.evaluation.enabled = false;
  }
  if (args.verbose) {
    next.execution.verbose = true;
  }
  return next;
}

function normalizeConfig(config) {
  const next = structuredClone(config);
  next.dataset.testDataDir = String(next.dataset.testDataDir ?? 'benchmarks/nl2repo/test-data');
  next.dataset.tasks = [...new Set((next.dataset.tasks ?? []).map(String))];
  next.dataset.offset = next.dataset.offset ?? 0;
  next.modes = [...new Set((next.modes ?? []).map(normalizeMode))];
  next.execution.maxWorkers = Math.max(1, Number(next.execution.maxWorkers ?? 1));
  next.execution.maxIterations = Math.max(1, Number(next.execution.maxIterations ?? 100));
  next.execution.verbose = Boolean(next.execution.verbose);
  next.deepclause.packageTarball = next.deepclause.packageTarball == null
    ? undefined
    : String(next.deepclause.packageTarball);
  next.docker.platform = String(next.docker.platform ?? 'linux/amd64');
  next.docker.workerImage = String(next.docker.workerImage ?? 'deepclause-nl2repo-worker:latest');
  next.artifacts.outputRoot = String(next.artifacts.outputRoot ?? 'benchmarks/runs');
  next.evaluation.pullBaseImages = next.evaluation.pullBaseImages !== false;
  next.evaluation.removePackageFiles = next.evaluation.removePackageFiles !== false;
  next.evaluation.removeTestFiles = next.evaluation.removeTestFiles !== false;
  return next;
}

function normalizeMode(mode) {
  const normalized = MODE_ALIASES.get(String(mode).toLowerCase());
  if (!normalized) {
    throw new Error(`Unsupported benchmark mode: ${mode}`);
  }
  return normalized;
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
    '-f', path.join(BENCHMARKS_ROOT, 'nl2repo', 'docker', 'worker.Dockerfile'),
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

async function dockerPrune() {
  console.log('Pruning dangling Docker images...');
  await runCommand('docker', ['image', 'prune', '-f'], { cwd: REPO_ROOT }).catch(() => {});
  console.log('Pruning Docker build cache...');
  await runCommand('docker', ['builder', 'prune', '-f'], { cwd: REPO_ROOT }).catch(() => {});
}

function collectWorkerEnv(config) {
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
      || key.startsWith('DC_PROXY_')
    ) {
      env[key] = value;
    }
  }
  env.DC_MAX_ITERATIONS = String(config.execution.maxIterations ?? 100);
  return env;
}

function buildContainerName(runId, mode, taskName) {
  return sanitizeSegment(`dc-nl2repo-${runId}-${mode}-${taskName}`).slice(0, 63);
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

function buildModeSummary({ mode, modeResults, modeEvalResults, resolvedDeepClauseVersion, config }) {
  const completed = modeResults.filter((result) => result.success).length;
  const failures = modeResults.length - completed;
  const evalCompleted = modeEvalResults.filter((r) => r.status === 'completed').length;
  const totalScore = modeEvalResults.reduce((sum, r) => sum + (r.score ?? 0), 0);
  const totalTests = modeEvalResults.reduce((sum, r) => sum + (r.totalTests ?? 0), 0);
  const totalPassed = modeEvalResults.reduce((sum, r) => sum + (r.passedTests ?? 0), 0);
  return {
    mode,
    instanceCount: modeResults.length,
    completed,
    failures,
    evalCompleted,
    totalScore,
    totalTests,
    totalPassed,
    avgSuccessRate: totalTests > 0 ? totalPassed / totalTests : 0,
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
    task_name: result.taskName ?? result.instanceId,
    model_name_or_path: result.modelNameOrPath,
    model_patch: result.patch ?? '',
    score: result.evalScore ?? 0,
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
  return `nl2repo-${stamp}`;
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
