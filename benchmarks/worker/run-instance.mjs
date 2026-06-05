#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const BANNED_TOOL_NAMES = ['web_search', 'news_search', 'url_fetch', 'create_skill'];

async function main() {
  const [inputPath, outputDir] = process.argv.slice(2);
  if (!inputPath || !outputDir) {
    throw new Error('Usage: node run-instance.mjs <input.json> <output-dir>');
  }

  const spec = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  await fs.mkdir(outputDir, { recursive: true });
  const logsDir = path.join(outputDir, 'logs');
  await fs.mkdir(logsDir, { recursive: true });

  const result = {
    success: false,
    instanceId: spec.instance.instance_id,
    mode: spec.mode,
    patch: '',
    commands: [],
    warnings: [],
  };

  const workRoot = '/work';
  const repoDir = path.join(workRoot, 'task');
  const agentHome = path.join(workRoot, 'agent-home');
  const pythonVenv = path.join(workRoot, 'python-venv');
  const plansDir = path.join(agentHome, 'plans');
  const startedAt = Date.now();

  try {
    logProgress(`Starting worker for ${spec.instance.instance_id} in mode ${spec.mode}`);
    await resetDirectory(repoDir);
    await resetDirectory(agentHome);
    await fs.mkdir(logsDir, { recursive: true });

    const repositoryOrigin = await resolveRepositoryOrigin(spec);
    const gitFetchArgs = buildGitFetchArgs(repositoryOrigin, spec.instance.base_commit);
    logProgress(`Using repository origin ${repositoryOrigin}`);

    await runStep(result, logsDir, 'git_init', ['git', 'init', repoDir], { cwd: workRoot });
    await runStep(result, logsDir, 'git_remote_add', ['git', 'remote', 'add', 'origin', repositoryOrigin], { cwd: repoDir });
    await runStep(result, logsDir, 'git_fetch', gitFetchArgs, { cwd: repoDir });
    await runStep(result, logsDir, 'git_checkout', ['git', 'checkout', '--detach', 'FETCH_HEAD'], { cwd: repoDir });
    await runBestEffortStep(result, logsDir, 'git_submodules', ['git', 'submodule', 'update', '--init', '--recursive', '--depth', '1'], { cwd: repoDir });
    await runBestEffortStep(result, logsDir, 'git_config_name', ['git', 'config', 'user.name', 'DeepClause Benchmark'], { cwd: repoDir });
    await runBestEffortStep(result, logsDir, 'git_config_email', ['git', 'config', 'user.email', 'benchmark@deepclause.local'], { cwd: repoDir });

    const deepclauseInstallTarget = spec.deepclausePackageTarball ?? `deepclause-sdk@${spec.deepclauseVersion}`;
    logProgress(`Installing DeepClause from ${deepclauseInstallTarget}`);
    await runStep(result, logsDir, 'npm_install_deepclause', ['npm', 'install', '-g', deepclauseInstallTarget], {
      cwd: workRoot,
      timeoutSeconds: spec.execution.setupTimeoutSeconds,
      env: buildCommandEnv(),
    });

    await runStep(result, logsDir, 'deepclause_init', ['deepclause', 'init', '--model', spec.deepclause.models.run], {
      cwd: agentHome,
      timeoutSeconds: spec.execution.setupTimeoutSeconds,
      env: buildCommandEnv(),
    });

    await writeDeepClauseConfig({
      agentHome,
      repoDir,
      deepclause: spec.deepclause,
    });
    await runStep(result, logsDir, 'deepclause_show_model', ['deepclause', 'show-model', '--json'], {
      cwd: agentHome,
      timeoutSeconds: 60,
      env: buildCommandEnv(),
    });

    await maybePrepareRepository({
      result,
      logsDir,
      repoDir,
      pythonVenv,
      repoSetup: spec.execution.repoSetup,
      timeoutSeconds: spec.execution.setupTimeoutSeconds,
    });

    const benchmarkRequest = buildBenchmarkRequest(spec.instance);
    if (spec.mode === 'prompt') {
      logProgress('Running prompt mode');
      const promptStep = await runStep(result, logsDir, 'deepclause_prompt', ['deepclause', '-p', benchmarkRequest], {
        cwd: agentHome,
        timeoutSeconds: spec.execution.agentTimeoutSeconds,
        env: buildCommandEnv(),
      });
      result.sessionIds = extractSessionIds(promptStep.stdout);
      result.toolCalls = await collectPromptToolCalls(agentHome, result.sessionIds);
      result.bannedToolCalls = result.toolCalls.filter((toolName) => BANNED_TOOL_NAMES.includes(toolName));
    } else if (spec.mode === 'plan-execute') {
      logProgress('Running plan generation');
      await resetDirectory(plansDir);
      await runStep(result, logsDir, 'plan_generate', ['deepclause', 'run', '--headless', '--stream', '.deepclause/system/plan.dml', benchmarkRequest], {
        cwd: agentHome,
        timeoutSeconds: spec.execution.agentTimeoutSeconds,
        env: buildCommandEnv(),
      });
      const generatedPlan = await findGeneratedPlan(plansDir);
      result.generatedPlan = path.relative(agentHome, generatedPlan);
      logProgress(`Executing generated plan ${result.generatedPlan}`);
      await runStep(result, logsDir, 'plan_execute', ['deepclause', 'run', '--headless', '--stream', result.generatedPlan], {
        cwd: agentHome,
        timeoutSeconds: spec.execution.agentTimeoutSeconds,
        env: buildCommandEnv(),
      });
    } else {
      throw new Error(`Unsupported benchmark mode: ${spec.mode}`);
    }

    result.modifiedFiles = await getModifiedFiles(repoDir);
    result.patch = await getGitDiff(repoDir);
    result.patchBytes = Buffer.byteLength(result.patch, 'utf8');
    result.success = true;
    logProgress(`Worker completed successfully in ${Date.now() - startedAt}ms`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.modifiedFiles = await getModifiedFiles(repoDir).catch(() => []);
    result.patch = await getGitDiff(repoDir).catch(() => '');
    result.patchBytes = Buffer.byteLength(result.patch ?? '', 'utf8');
    logProgress(`Worker failed after ${Date.now() - startedAt}ms: ${result.error}`);
  } finally {
    await copyArtifacts(agentHome, outputDir);
    await fs.writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
}

async function resetDirectory(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
}

function buildCommandEnv() {
  return {
    ...process.env,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

async function resolveRepositoryOrigin(spec) {
  if (spec.repoCacheDir) {
    const mirrorPath = path.join(spec.repoCacheDir, buildRepoCacheFileName(spec.instance.repo));
    if (await pathExists(mirrorPath)) {
      return `file://${mirrorPath}`;
    }
    logProgress(`Local mirror not found for ${spec.instance.repo}, falling back to GitHub.`);
  }
  return `https://github.com/${spec.instance.repo}.git`;
}

function buildGitFetchArgs(repositoryOrigin, baseCommit) {
  if (String(repositoryOrigin).startsWith('file://')) {
    return ['git', 'fetch', 'origin', baseCommit];
  }
  return ['git', 'fetch', '--depth', '1', 'origin', baseCommit];
}

function buildRepoCacheFileName(repo) {
  return `${String(repo).replace(/[\\/]+/g, '__')}.git`;
}

async function writeDeepClauseConfig({ agentHome, repoDir, deepclause }) {
  const configPath = path.join(agentHome, '.deepclause', 'config.json');
  const config = {
    models: deepclause.models,
    temperatures: deepclause.temperatures,
    providers: {},
    mcp: { servers: {} },
    agentvm: deepclause.agentvm,
    shell: deepclause.shell,
    dmlBase: '.deepclause/tools',
    workspace: repoDir,
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function maybePrepareRepository({ result, logsDir, repoDir, pythonVenv, repoSetup, timeoutSeconds }) {
  if (repoSetup.mode === 'none') {
    return;
  }

  if (repoSetup.mode === 'best-effort') {
    await runBestEffortShell(result, logsDir, 'repo_setup_best_effort', buildBestEffortSetupCommand(repoDir, pythonVenv), {
      cwd: repoDir,
      timeoutSeconds,
    });
  }

  for (let index = 0; index < (repoSetup.commands ?? []).length; index += 1) {
    const command = String(repoSetup.commands[index]).trim();
    if (!command) {
      continue;
    }
    await runBestEffortShell(result, logsDir, `repo_setup_command_${index + 1}`, command, {
      cwd: repoDir,
      timeoutSeconds,
    });
  }
}

function buildBestEffortSetupCommand(repoDir, pythonVenv) {
  const quotedRepoDir = shellQuote(repoDir);
  const quotedVenv = shellQuote(pythonVenv);
  return [
    'set -eu',
    `cd ${quotedRepoDir}`,
    `if [ -f requirements.txt ] || [ -f pyproject.toml ] || [ -f setup.py ] || [ -f setup.cfg ]; then`,
    `  python3 -m venv ${quotedVenv}`,
    `  . ${quotedVenv}/bin/activate`,
    '  python -m pip install --upgrade pip setuptools wheel',
    '  if [ -f requirements.txt ]; then python -m pip install -r requirements.txt; fi',
    '  if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f setup.cfg ]; then python -m pip install -e .; fi',
    'fi',
    'if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi',
  ].join('\n');
}

function buildBenchmarkRequest(instance) {
  const failToPass = formatTestList(instance.FAIL_TO_PASS);
  const passToPass = formatTestList(instance.PASS_TO_PASS);
  const hints = String(instance.hints_text ?? '').trim() || 'None provided.';

  return [
    'You are solving a SWE-bench Lite style repository repair task in the current workspace repository.',
    'Work only inside the checked out repository workspace.',
    'Make the smallest correct patch you can.',
    'Prefer reading local files, making focused edits, and running narrow validation commands.',
    'Do not use web_search, news_search, url_fetch, or create_skill for this task.',
    'Do not write results into .deepclause or any directory outside the repository workspace.',
    '',
    `Instance ID: ${instance.instance_id}`,
    `Repository: ${instance.repo}`,
    '',
    'Problem statement:',
    String(instance.problem_statement ?? '').trim(),
    '',
    'Hints:',
    hints,
    '',
    'Fail-to-pass tests to prioritize when possible:',
    failToPass,
    '',
    'Pass-to-pass tests that should keep passing when possible:',
    passToPass,
    '',
    'When you finish, leave the repository changes in place and summarize the fix briefly.',
  ].join('\n');
}

function formatTestList(rawValue) {
  const parsed = parseJsonStringArray(rawValue);
  if (parsed.length === 0) {
    return '- None listed';
  }
  return parsed.map((value) => `- ${value}`).join('\n');
}

function parseJsonStringArray(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue.map(String);
  }
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.map(String) : [String(rawValue)];
  } catch {
    return [String(rawValue)];
  }
}

async function runStep(result, logsDir, label, commandArgs, options = {}) {
  const [command, ...args] = commandArgs;
  const stdoutPath = path.join(logsDir, `${label}.stdout.log`);
  const stderrPath = path.join(logsDir, `${label}.stderr.log`);
  const startedAt = Date.now();
  logProgress(`Step ${label} started: ${[command, ...args].join(' ')}`);
  try {
    const commandResult = await runCommand(command, args, options);
    await fs.writeFile(stdoutPath, commandResult.stdout, 'utf8');
    await fs.writeFile(stderrPath, commandResult.stderr, 'utf8');
    logProgress(`Step ${label} completed in ${Date.now() - startedAt}ms`);
    result.commands.push({
      label,
      command: [command, ...args].join(' '),
      cwd: options.cwd,
      exitCode: commandResult.exitCode,
      durationMs: Date.now() - startedAt,
      stdoutPath: path.basename(stdoutPath),
      stderrPath: path.basename(stderrPath),
      success: true,
    });
    return commandResult;
  } catch (error) {
    await fs.writeFile(stdoutPath, error.stdout ?? '', 'utf8');
    await fs.writeFile(stderrPath, error.stderr ?? String(error), 'utf8');
    logProgress(`Step ${label} failed in ${Date.now() - startedAt}ms: ${error.message}`);
    result.commands.push({
      label,
      command: [command, ...args].join(' '),
      cwd: options.cwd,
      exitCode: error.exitCode ?? 1,
      durationMs: Date.now() - startedAt,
      stdoutPath: path.basename(stdoutPath),
      stderrPath: path.basename(stderrPath),
      success: false,
    });
    throw error;
  }
}

async function runBestEffortStep(result, logsDir, label, commandArgs, options = {}) {
  try {
    await runStep(result, logsDir, label, commandArgs, options);
  } catch (error) {
    result.warnings.push(`${label}: ${error.message}`);
  }
}

async function runBestEffortShell(result, logsDir, label, shellCommand, options = {}) {
  try {
    await runShellStep(result, logsDir, label, shellCommand, options);
  } catch (error) {
    result.warnings.push(`${label}: ${error.message}`);
  }
}

async function runShellStep(result, logsDir, label, shellCommand, options = {}) {
  return runStep(result, logsDir, label, ['bash', '-lc', shellCommand], options);
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutId = null;
    if (options.timeoutSeconds) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeoutSeconds * 1000);
      timeoutId.unref?.();
    }

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

    child.once('error', (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(error);
    });

    child.once('close', (exitCode, signal) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (exitCode === 0 && !timedOut) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      const error = new Error(timedOut
        ? `${command} timed out after ${options.timeoutSeconds}s`
        : `${command} exited with code ${exitCode}${signal ? ` (${signal})` : ''}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = exitCode ?? 1;
      reject(error);
    });
  });
}

function logProgress(message) {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

function extractSessionIds(stdout) {
  return [...stdout.matchAll(/^Session:\s+([0-9a-fA-F-]+)$/gm)].map((match) => match[1]);
}

async function collectPromptToolCalls(agentHome, sessionIds) {
  const toolCalls = new Set();
  for (const sessionId of sessionIds) {
    const executionLogPath = path.join(agentHome, '.deepclause', 'sessions', sessionId, 'execution-log.jsonl');
    if (!await pathExists(executionLogPath)) {
      continue;
    }
    const content = await fs.readFile(executionLogPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const record = JSON.parse(line);
      const event = record.event;
      if (event?.type === 'tool_call' && event.toolName) {
        toolCalls.add(String(event.toolName));
      }
    }
  }
  return [...toolCalls].sort();
}

async function findGeneratedPlan(plansDir) {
  const entries = await fs.readdir(plansDir, { withFileTypes: true });
  const planFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.dml'))
    .map((entry) => path.join(plansDir, entry.name))
    .sort();
  if (planFiles.length === 0) {
    throw new Error('Plan mode did not generate a plan file.');
  }
  return planFiles[planFiles.length - 1];
}

async function getModifiedFiles(repoDir) {
  const { stdout } = await runCommand('git', ['status', '--porcelain'], { cwd: repoDir });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3));
}

async function getGitDiff(repoDir) {
  const { stdout } = await runCommand('git', ['-c', 'core.fileMode=false', 'diff', '--binary', '--full-index', '--no-ext-diff'], {
    cwd: repoDir,
  });
  return stdout;
}

async function copyArtifacts(agentHome, outputDir) {
  const deepclauseSource = path.join(agentHome, '.deepclause');
  const plansSource = path.join(agentHome, 'plans');
  const deepclauseTarget = path.join(outputDir, 'agent-home');
  const plansTarget = path.join(outputDir, 'plans');
  if (await pathExists(deepclauseSource)) {
    await fs.rm(deepclauseTarget, { recursive: true, force: true });
    await fs.cp(deepclauseSource, deepclauseTarget, { recursive: true });
  }
  if (await pathExists(plansSource)) {
    await fs.rm(plansTarget, { recursive: true, force: true });
    await fs.cp(plansSource, plansTarget, { recursive: true });
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
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