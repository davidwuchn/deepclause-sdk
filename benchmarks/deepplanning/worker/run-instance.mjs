#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCHMARKS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
    taskId: spec.taskId,
    domain: spec.domain,
    level: spec.level,
    agentOutput: '',
    warnings: [],
  };

  const agentHome = path.join(outputDir, 'agent-home');
  const startedAt = Date.now();

  try {
    await fs.mkdir(agentHome, { recursive: true });
    await setupDeepClauseWorkspace(agentHome, spec);

    const dmlFile = spec.domain === 'travel'
      ? path.join(BENCHMARKS_ROOT, 'deepplanning', 'travel.dml')
      : path.join(BENCHMARKS_ROOT, 'deepplanning', 'shopping.dml');

    const request = buildRequest(spec);
    const env = buildCommandEnv(spec);
    const bridgeDir = path.join(BENCHMARKS_ROOT, 'deepplanning');

    logProgress(`Running ${spec.domain} task ${spec.taskId}`);
    const runResult = await runStep(result, logsDir, 'deepclause_run', [
      'deepclause', 'run', '--verbose', '--stream',
      '--deepclause-version', spec.deepclauseVersion ?? 'latest',
      '--param', `db_path=${spec.dbPath}`,
      '--param', `bridge_dir=${bridgeDir}`,
      dmlFile, request,
    ], {
      cwd: agentHome,
      timeoutSeconds: spec.agentTimeoutSeconds ?? 600,
      env,
    });

    result.agentOutput = extractAgentOutput(runResult.stdout, runResult.stderr);
    result.success = true;
    logProgress(`Worker completed successfully in ${Date.now() - startedAt}ms`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stderr) {
      result.errorDetail = error.stderr.slice(-3000);
    }
    logProgress(`Worker failed after ${Date.now() - startedAt}ms: ${result.error}`);
  } finally {
    await fs.writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
}

async function setupDeepClauseWorkspace(agentHome, spec) {
  const dcDir = path.join(agentHome, '.deepclause');
  await fs.mkdir(dcDir, { recursive: true });

  const config = {
    workspace: agentHome,
    models: {
      gateway: spec.models?.gateway ?? 'openai:gpt-4o',
      run: spec.models?.run ?? 'openai:gpt-4o',
      compile: spec.models?.compile ?? 'openai:gpt-4o',
    },
    temperatures: {
      gateway: spec.temperatures?.gateway ?? 0.7,
      run: spec.temperatures?.run ?? 0.7,
      compile: spec.temperatures?.compile ?? 0.4,
    },
    tools: {
      policy: {
        mode: 'whitelist',
        tools: getWhitelistedTools(spec.domain),
      },
    },
  };

  const additionalTools = buildAdditionalToolsConfig(spec);
  if (additionalTools) {
    config.tools.additional = additionalTools;
  }

  await fs.writeFile(path.join(dcDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function getWhitelistedTools(domain) {
  const common = ['bash', 'vm_exec', 'write_file', 'validate_dml'];
  if (domain === 'travel') {
    return [
      ...common,
      'query_train_info', 'query_flight_info', 'query_hotel_info',
      'recommend_attractions', 'query_attraction_details', 'search_location',
      'query_road_route_info', 'recommend_restaurants', 'query_restaurant_details',
    ];
  }
  return [
    ...common,
    'search_products', 'filter_by_brand', 'filter_by_color', 'filter_by_size',
    'filter_by_applicable_coupons', 'filter_by_range', 'sort_products',
    'get_product_details', 'calculate_transport_time', 'get_user_info',
    'add_product_to_cart', 'delete_product_from_cart', 'get_cart_info',
    'add_coupon_to_cart', 'delete_coupon_from_cart',
  ];
}

function buildAdditionalToolsConfig(spec) {
  const benchDir = spec.benchDir ?? process.env.QWEN_AGENT_BENCH_DIR;
  if (!benchDir) {
    return null;
  }
  return {
    type: 'deepplanning-bridge',
    domain: spec.domain,
    dbPath: spec.dbPath,
    benchDir,
    pythonPath: spec.pythonPath ?? 'python3',
  };
}

function buildRequest(spec) {
  if (spec.domain === 'shopping') {
    return spec.query ?? spec.taskQuery ?? '';
  }
  return spec.query ?? spec.taskQuery ?? '';
}

function buildCommandEnv(spec) {
  const env = { ...process.env };
  if (spec.benchDir) {
    env.QWEN_AGENT_BENCH_DIR = spec.benchDir;
  }
  if (spec.dbPath) {
    env.DEEPPLANNING_DB_PATH = spec.dbPath;
  }
  env.DEEPPLANNING_BRIDGE_DIR = path.join(BENCHMARKS_ROOT, 'deepplanning');
  return env;
}

function extractAgentOutput(stdout, stderr) {
  if (stdout) {
    const lines = stdout.split('\n');
    const answerLines = [];
    let inAnswer = false;
    for (const line of lines) {
      if (line.includes('ANSWER:') || line.includes('answer:')) {
        inAnswer = true;
        answerLines.push(line.replace(/^.*?(ANSWER|answer):\s*/, ''));
      } else if (inAnswer) {
        answerLines.push(line);
      }
    }
    if (answerLines.length > 0) {
      return answerLines.join('\n').trim();
    }
    const planMatch = stdout.match(/<plan>[\s\S]*?<\/plan>/);
    if (planMatch) {
      return planMatch[0];
    }
  }
  return stdout?.slice(-10000) ?? '';
}

async function runStep(result, logsDir, stepName, command, options = {}) {
  const logPath = path.join(logsDir, `${stepName}.log`);
  const logStream = await fs.open(logPath, 'w');

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, (options.timeoutSeconds ?? 600) * 1000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        logStream.write(chunk);
        if (VERBOSE) {
          process.stdout.write(chunk);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        logStream.write(chunk);
      });

      child.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timeout);
        result.commands.push({ step: stepName, exitCode, durationMs: 0 });
        if (exitCode === 0) {
          resolve({ stdout, stderr, exitCode });
        } else {
          const error = new Error(`${command[0]} exited with code ${exitCode}`);
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        }
      });
    });
  } finally {
    await logStream.close();
  }
}

function logProgress(message) {
  console.log(`[deepplanning-worker] ${message}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
