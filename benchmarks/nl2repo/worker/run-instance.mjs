#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const BANNED_TOOL_NAMES = ['web_search', 'news_search', 'url_fetch', 'create_skill', 'ask_user'];
const VERBOSE = Boolean(process.env.DC_VERBOSE);

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
    taskName: spec.task.name,
    mode: spec.mode,
    patch: '',
    commands: [],
    warnings: [],
  };

  const workspace = '/work/workspace';
  const startedAt = Date.now();

  try {
    logProgress(`Starting worker for ${spec.task.name} in mode ${spec.mode}`);
    await resetDirectory(workspace);

    await setupEnvironment({ result, logsDir, workspace, spec });

    const benchmarkRequest = buildBenchmarkRequest(spec.task);
    if (spec.mode === 'prompt') {
      logProgress('Running prompt mode');
      const promptStep = await runStep(result, logsDir, 'deepclause_prompt', ['deepclause', '-p', benchmarkRequest], {
        cwd: workspace,
        timeoutSeconds: spec.execution.agentTimeoutSeconds,
        env: buildCommandEnv(),
      });
      result.sessionIds = extractSessionIds(promptStep.stdout);
      result.toolCalls = await collectPromptToolCalls(workspace, result.sessionIds);
      result.bannedToolCalls = result.toolCalls.filter((toolName) => BANNED_TOOL_NAMES.includes(toolName));
    } else if (spec.mode === 'plan-execute') {
      logProgress('Running plan generation');
      await runStep(result, logsDir, 'plan_generate', ['deepclause', 'run', '--verbose', '--stream', '.deepclause/system/plan.dml', benchmarkRequest], {
        cwd: workspace,
        timeoutSeconds: spec.execution.agentTimeoutSeconds,
        env: buildCommandEnv(),
      });
      const plansDir = path.join(workspace, 'plans');
      const generatedPlan = await findGeneratedPlan(plansDir);
      result.generatedPlan = path.relative(workspace, generatedPlan);
      logProgress(`Executing generated plan ${result.generatedPlan}`);
      await runStep(result, logsDir, 'plan_execute', ['deepclause', 'run', '--verbose', '--stream', result.generatedPlan], {
        cwd: workspace,
        timeoutSeconds: spec.execution.agentTimeoutSeconds,
        env: buildCommandEnv(),
      });
    } else if (spec.mode === 'compile') {
      logProgress('Running compile mode');
      const startMdPath = path.join(workspace, 'start.md');
      await runStep(result, logsDir, 'deepclause_compile', ['deepclause', 'compile', startMdPath], {
        cwd: workspace,
        timeoutSeconds: spec.execution.setupTimeoutSeconds,
        env: buildCommandEnv(),
      });
      const compiledDml = path.join(workspace, '.deepclause', 'tools', 'start.dml');
      if (!(await pathExists(compiledDml))) {
        throw new Error('Compile mode did not generate .deepclause/tools/start.dml');
      }
      logProgress('Running compiled DML');
      await runStep(result, logsDir, 'deepclause_run_compiled', ['deepclause', 'run', '--verbose', '--stream', '.deepclause/tools/start.dml', benchmarkRequest], {
        cwd: workspace,
        timeoutSeconds: spec.execution.agentTimeoutSeconds,
        env: buildCommandEnv(),
      });
    } else {
      throw new Error(`Unsupported benchmark mode: ${spec.mode}`);
    }

    await unwrapNestedWorkspace(workspace);

    result.modifiedFiles = await getModifiedFiles(workspace);
    result.patch = await getGitDiff(workspace);
    result.patchBytes = Buffer.byteLength(result.patch, 'utf8');
    result.success = true;
    logProgress(`Worker completed successfully in ${Date.now() - startedAt}ms`);
    logProgress(`Modified files in workspace: ${result.modifiedFiles.join(', ') || '(none)'}`);
    try {
      const { stdout: wsLs } = await runCommand('find', [workspace, '-maxdepth', '3', '-not', '-path', '*/.git/*', '-not', '-path', '*/__pycache__/*', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.deepclause/*'], { cwd: '/work' });
      logProgress(`Workspace contents:\n${wsLs}`);
    } catch {}
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.modifiedFiles = await getModifiedFiles(workspace).catch(() => []);
    result.patch = await getGitDiff(workspace).catch(() => '');
    result.patchBytes = Buffer.byteLength(result.patch ?? '', 'utf8');
    logProgress(`Worker failed after ${Date.now() - startedAt}ms: ${result.error}`);
  } finally {
    await copyWorkspace(workspace, outputDir);
    await copyDotDeepclause(workspace, outputDir);
    await copyPlans(workspace, outputDir);
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

async function setupEnvironment({ result, logsDir, workspace, spec }) {
  await runStep(result, logsDir, 'git_init', ['git', 'init', workspace], { cwd: '/work' });
  await runBestEffortStep(result, logsDir, 'git_config_name', ['git', 'config', 'user.name', 'DeepClause Benchmark'], { cwd: workspace });
  await runBestEffortStep(result, logsDir, 'git_config_email', ['git', 'config', 'user.email', 'benchmark@deepclause.local'], { cwd: workspace });

  if (spec.task.startMd) {
    const startMdContent = Buffer.from(spec.task.startMd, 'base64');
    const startMdPath = path.join(workspace, 'start.md');
    await fs.writeFile(startMdPath, startMdContent, 'utf8');
    await runStep(result, logsDir, 'git_add_start_md', ['git', 'add', 'start.md'], { cwd: workspace });
    await runBestEffortStep(result, logsDir, 'git_commit_start_md', ['git', 'commit', '-m', 'Add start.md specification'], { cwd: workspace });
  }

  const deepclauseInstallTarget = spec.deepclausePackageTarball ?? `deepclause-sdk@${spec.deepclauseVersion}`;
  logProgress(`Installing DeepClause from ${deepclauseInstallTarget}`);
  await runStep(result, logsDir, 'npm_install_deepclause', ['npm', 'install', '-g', deepclauseInstallTarget], {
    cwd: '/work',
    timeoutSeconds: spec.execution.setupTimeoutSeconds,
    env: buildCommandEnv(),
  });

  await runStep(result, logsDir, 'deepclause_init', ['deepclause', 'init', '--model', spec.deepclause.models.run], {
    cwd: workspace,
    timeoutSeconds: spec.execution.setupTimeoutSeconds,
    env: buildCommandEnv(),
  });

  await writeDeepClauseConfig({ workspace, deepclause: spec.deepclause });
  await installBenchmarkPlan(workspace);
  await runStep(result, logsDir, 'deepclause_show_model', ['deepclause', 'show-model', '--json'], {
    cwd: workspace,
    timeoutSeconds: 60,
    env: buildCommandEnv(),
  });
}

async function writeDeepClauseConfig({ workspace, deepclause }) {
  const configPath = path.join(workspace, '.deepclause', 'config.json');
  const config = {
    models: deepclause.models,
    temperatures: deepclause.temperatures,
    providers: {},
    mcp: { servers: {} },
    agentvm: deepclause.agentvm,
    shell: deepclause.shell,
    dmlBase: '.deepclause/tools',
    workspace: '.',
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function installBenchmarkPlan(workspace) {
  const benchmarkPlanSource = '/benchmarks-src/nl2repo/worker/plan.dml';
  const planTarget = path.join(workspace, '.deepclause', 'system', 'plan.dml');
  if (await pathExists(benchmarkPlanSource)) {
    await fs.copyFile(benchmarkPlanSource, planTarget);
    logProgress('Installed NL2Repo benchmark plan.dml');
  }
}

function buildBenchmarkRequest(task) {
  return [
    'You are solving an NL2Repo benchmark task: generate a complete, runnable Python repository from scratch.',
    'Work only inside the workspace directory.',
    'Follow the specification in start.md carefully and implement the entire project step by step.',
    'The project must be directly runnable in the current directory.',
    'Running requirements should comply with the API Usage Guide section of the document.',
    'Do not use web_search, news_search, url_fetch, or create_skill for this task.',
    'Do not write results into .deepclause or plans or any directory outside the workspace.',
    '',
    `Task name: ${task.name}`,
    '',
    'When you finish, leave all generated files in place and summarize what you implemented briefly.',
  ].join('\n');
}

async function runStep(result, logsDir, label, commandArgs, options = {}) {
  const [command, ...args] = commandArgs;
  const stdoutPath = path.join(logsDir, `${label}.stdout.log`);
  const stderrPath = path.join(logsDir, `${label}.stderr.log`);
  const startedAt = Date.now();
  logProgress(`Step ${label} started: ${[command, ...args].join(' ')}`);
  try {
    const verboseOptions = VERBOSE ? {
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    } : {};
    const commandResult = await runCommand(command, args, { ...options, ...verboseOptions });
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

async function collectPromptToolCalls(workspace, sessionIds) {
  const toolCalls = new Set();
  for (const sessionId of sessionIds) {
    const executionLogPath = path.join(workspace, '.deepclause', 'sessions', sessionId, 'execution-log.jsonl');
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

async function unwrapNestedWorkspace(workspace) {
  const nestedDir = path.join(workspace, 'workspace');
  if (!(await pathExists(nestedDir)) || !(await fs.stat(nestedDir)).isDirectory()) {
    return;
  }
  const entries = await fs.readdir(nestedDir);
  if (entries.length === 0) {
    return;
  }
  logProgress(`Detected nested workspace/ directory — unwrapping ${entries.length} entries`);
  for (const entry of entries) {
    const src = path.join(nestedDir, entry);
    const dest = path.join(workspace, entry);
    if (await pathExists(dest)) {
      await fs.rm(dest, { recursive: true, force: true });
    }
    await fs.rename(src, dest);
  }
  await fs.rm(nestedDir, { recursive: true, force: true });
  logProgress('Nested workspace unwrapped successfully');
}

async function getModifiedFiles(dir) {
  const { stdout } = await runCommand('git', ['status', '--porcelain'], { cwd: dir });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3));
}

async function getGitDiff(dir) {
  await runCommand('git', ['add', '-A'], { cwd: dir });
  const { stdout } = await runCommand('git', ['-c', 'core.fileMode=false', 'diff', 'HEAD', '--binary', '--full-index', '--no-ext-diff'], {
    cwd: dir,
  });
  return stdout;
}

async function copyWorkspace(workspace, outputDir) {
  const workspaceTarget = path.join(outputDir, 'workspace');
  await fs.rm(workspaceTarget, { recursive: true, force: true });
  if (await pathExists(workspace)) {
    await fs.cp(workspace, workspaceTarget, {
      recursive: true,
      filter: (src) => {
        const relative = path.relative(workspace, src);
        const base = path.basename(src);
        return !relative.startsWith('.git')
          && !relative.startsWith('.deepclause')
          && !relative.startsWith('plans')
          && !base.startsWith('agent_messages_iteration_')
          && !base.startsWith('__pycache__')
          && !base.endsWith('.egg-info');
      },
    });
  }
}

async function copyDotDeepclause(workspace, outputDir) {
  const source = path.join(workspace, '.deepclause');
  const target = path.join(outputDir, 'agent-home');
  if (await pathExists(source)) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true });
  }
}

async function copyPlans(workspace, outputDir) {
  const source = path.join(workspace, 'plans');
  const target = path.join(outputDir, 'plans');
  if (await pathExists(source)) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true });
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
