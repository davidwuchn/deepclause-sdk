#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARKS_ROOT, '..');
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

  const runId = args.runId;
  if (!runId) {
    throw new Error('--run-id is required');
  }

  const runRoot = path.resolve(REPO_ROOT, args.runRoot ?? 'benchmarks/runs', runId);
  if (!await pathExists(runRoot)) {
    throw new Error(`Run directory not found: ${runRoot}`);
  }

  let manifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(path.join(runRoot, 'manifest.json'), 'utf8'));
  } catch {
    console.warn('Could not read manifest.json');
  }

  const config = manifest.config ?? {};
  const testDataDir = path.resolve(REPO_ROOT, config.dataset?.testDataDir ?? 'benchmarks/nl2repo/test-data');
  const platform = config.docker?.platform ?? 'linux/amd64';
  const modes = args.mode ? [args.mode] : (config.modes ?? ['prompt']);

  const evalResults = [];

  for (const mode of modes) {
    const instancesDir = path.join(runRoot, mode, 'instances');
    if (!await pathExists(instancesDir)) {
      console.log(`No instances directory for mode ${mode}`);
      continue;
    }

    const entries = await fs.readdir(instancesDir, { withFileTypes: true });
    const instanceDirs = entries.filter((e) => e.isDirectory());

    for (const entry of instanceDirs) {
      const instanceRoot = path.join(instancesDir, entry.name);
      const resultPath = path.join(instanceRoot, 'result.json');
      const workspaceDir = path.join(instanceRoot, 'workspace');

      if (!await pathExists(resultPath)) {
        console.log(`[${mode}] ${entry.name}: no result.json, skipping`);
        continue;
      }

      if (!await pathExists(workspaceDir)) {
        console.log(`[${mode}] ${entry.name}: no workspace directory, skipping`);
        continue;
      }

      if (args.tasks.length > 0 && !args.tasks.includes(entry.name)) {
        continue;
      }

      console.log(`[${mode}] Evaluating ${entry.name}...`);

      try {
        const evalResult = await evaluateTask({
          taskName: entry.name,
          workspaceDir,
          instanceRoot,
          testDataDir,
          platform,
        });
        evalResults.push(evalResult);
        console.log(`[${mode}] ${entry.name}: score=${evalResult.score}/${evalResult.totalTests} (${(evalResult.successRate * 100).toFixed(1)}%)`);
      } catch (error) {
        console.log(`[${mode}] ${entry.name} evaluation failed: ${error.message}`);
        evalResults.push({
          mode,
          taskName: entry.name,
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
  }

  if (evalResults.length === 0) {
    console.log('No tasks evaluated.');
    return;
  }

  await writeJson(path.join(runRoot, 'evaluation-results.json'), evalResults);

  const totalScore = evalResults.reduce((sum, r) => sum + (r.score ?? 0), 0);
  const totalTests = evalResults.reduce((sum, r) => sum + (r.totalTests ?? 0), 0);
  const totalPassed = evalResults.reduce((sum, r) => sum + (r.passedTests ?? 0), 0);
  const avgSuccessRate = totalTests > 0 ? totalPassed / totalTests : 0;

  console.log('');
  console.log('=== Evaluation Summary ===');
  console.log(`Tasks evaluated: ${evalResults.length}`);
  console.log(`Total score: ${totalScore}`);
  console.log(`Total tests: ${totalTests}`);
  console.log(`Total passed: ${totalPassed}`);
  console.log(`Average success rate: ${(avgSuccessRate * 100).toFixed(1)}%`);
  console.log('');

  for (const result of evalResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    console.log(`  ${result.taskName}: ${result.score}/${result.totalTests} (${((result.successRate ?? 0) * 100).toFixed(1)}%)`);
  }
}

async function evaluateTask({ taskName, workspaceDir, instanceRoot, testDataDir, platform }) {
  const taskDataDir = path.join(testDataDir, taskName);
  let testCaseCount = 0;
  let testCommands = [];
  let testFiles = [];

  if (await pathExists(taskDataDir)) {
    const taskFiles = await fs.readdir(taskDataDir);

    const txtFiles = taskFiles.filter((f) => f.endsWith('.txt'));
    if (txtFiles.length > 0) {
      testCaseCount = parseInt((await fs.readFile(path.join(taskDataDir, txtFiles[0]), 'utf8')).trim(), 10) || 0;
    }

    const commandsFiles = taskFiles.filter((f) => f.endsWith('.json') && f.includes('commands'));
    if (commandsFiles.length > 0) {
      testCommands = JSON.parse(await fs.readFile(path.join(taskDataDir, commandsFiles[0]), 'utf8'));
    }

    const filesFiles = taskFiles.filter((f) => f.endsWith('.json') && f.includes('files'));
    if (filesFiles.length > 0) {
      testFiles = JSON.parse(await fs.readFile(path.join(taskDataDir, filesFiles[0]), 'utf8'));
    }
  }

  for (const fileName of PACKAGE_MGMT_FILES) {
    const filePath = path.join(workspaceDir, fileName);
    if (await pathExists(filePath)) {
      await fs.rm(filePath, { force: true });
    }
  }

  for (const testFile of testFiles) {
    const filePath = path.join(workspaceDir, testFile);
    if (await pathExists(filePath)) {
      await fs.rm(filePath, { recursive: true, force: true });
    }
  }

  const baseImage = `ghcr.io/multimodal-art-projection/nl2repobench/${taskName}:1.0`;
  const testImageTag = `nl2repo-test-${sanitizeSegment(taskName)}`;

  console.log(`  Pulling base image ${baseImage}`);
  try {
    await runCommand('docker', ['pull', '--platform', platform, baseImage], {
      cwd: REPO_ROOT,
      streamOutput: true,
    });
  } catch (error) {
    throw new Error(`Base image pull failed for ${baseImage}: ${error.message}`);
  }

  const dockerfilePath = path.join(instanceRoot, 'Dockerfile.eval');
  await fs.writeFile(dockerfilePath, [
    `FROM --platform=${platform} ${baseImage}`,
    'COPY workspace /workspace-agent/',
    'RUN cp -r /workspace-agent/* /workspace/ 2>/dev/null; true',
    'RUN rm -rf /workspace-agent',
    'WORKDIR /workspace',
    'ENV PYTHONPATH=/workspace:$PYTHONPATH',
    'CMD ["tail", "-f", "/dev/null"]',
  ].join('\n'), 'utf8');

  console.log(`  Building test image ${testImageTag}`);
  try {
    await runCommand('docker', [
      'build',
      '--platform', platform,
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

  console.log(`  Starting test container`);
  try {
    await runCommand('docker', [
      'run', '-d',
      '--name', evalContainerName,
      '--platform', platform,
      testImageTag,
    ], { cwd: REPO_ROOT });
  } catch (error) {
    throw new Error(`Failed to start test container: ${error.message}`);
  }

  try {
    console.log(`  Waiting for container to be ready...`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await runCommand('docker', ['exec', evalContainerName, 'true'], { cwd: REPO_ROOT, timeoutSeconds: 10 });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(`  Listing workspace contents:`);
    try {
      const lsResult = await runCommand('docker', [
        'exec', evalContainerName,
        'bash', '-lc', 'find /workspace -maxdepth 3 -not -path "*/\\.*" -not -path "*/__pycache__/*" | head -80',
      ], { cwd: REPO_ROOT, timeoutSeconds: 10 });
      console.log(lsResult.stdout);
    } catch (e) {
      console.log(`  ls failed: ${e.message}`);
    }

    for (const command of testCommands) {
      console.log(`  Running: ${command}`);
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
        console.log(`  Command exited with code ${cmdExitCode}`);
      }

      if (cmdExitCode !== 0 && cmdStderr) {
        const lastLines = cmdStderr.trim().split('\n').slice(-15).join('\n');
        console.log(`  stderr tail:\n${lastLines}`);
      }

      if (cmdExitCode !== 0 && cmdStdout) {
        const lastLines = cmdStdout.trim().split('\n').slice(-15).join('\n');
        console.log(`  stdout tail:\n${lastLines}`);
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
        console.log(`  pytest results -> passed=${parsed.passed} failed=${parsed.failed} errors=${parsed.errors}`);
      }
    }
  } finally {
    await runCommand('docker', ['stop', evalContainerName], { cwd: REPO_ROOT }).catch(() => {});
    await runCommand('docker', ['rm', '-f', evalContainerName], { cwd: REPO_ROOT }).catch(() => {});
  }

  const total = testCaseCount || (totalPassed + totalFailed + totalErrors);
  const successRate = total > 0 ? Math.min(totalPassed / total, 1.0) : 0;

  console.log(`  FINAL score=${totalPassed}/${total} successRate=${(successRate * 100).toFixed(1)}%`);

  const evalResult = {
    mode: undefined,
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
    if (arg === '--run-id') {
      args.runId = readValue();
      continue;
    }
    if (arg === '--run-root') {
      args.runRoot = readValue();
      continue;
    }
    if (arg === '--mode') {
      args.mode = readValue();
      continue;
    }
    if (arg === '--task') {
      args.tasks.push(readValue());
      continue;
    }
    if (arg === '--help') {
      args.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node benchmarks/evaluate-nl2repo.mjs [options]

Options:
  --run-id <id>            Run directory name under benchmarks/runs/
  --run-root <path>        Root for run directories (default: benchmarks/runs)
  --mode <mode>            Only evaluate this mode (default: all modes in run)
  --task <name>            Repeatable task name filter
  --help                   Show this help
`);
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
