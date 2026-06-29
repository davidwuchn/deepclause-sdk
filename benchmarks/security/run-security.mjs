#!/usr/bin/env node
/**
 * Security benchmark runner.
 *
 * Usage:
 *   node benchmarks/security/run-security.mjs --case CVE-2026-5199
 *   node benchmarks/security/run-security.mjs --all
 *   node benchmarks/security/run-security.mjs --all --model custom:aliyun:qwen3.6-27b
 *
 * For each case:
 *   1. Clone the repo at the vulnerable commit
 *   2. Run the security planner to generate a multi-strategy plan
 *   3. Run the generated plan against the codebase
 *   4. Check if the vulnerability was found
 *   5. Write a report
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CASES_DIR = join(__dirname, 'cases');
const OUTPUT_DIR = join(__dirname, 'runs');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    caseId: null,
    all: false,
    model: null,
    verbose: false,
    skipClone: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--case') opts.caseId = args[++i];
    else if (args[i] === '--all') opts.all = true;
    else if (args[i] === '--model') opts.model = args[++i];
    else if (args[i] === '--verbose') opts.verbose = true;
    else if (args[i] === '--skip-clone') opts.skipClone = true;
    else if (args[i] === '--help') {
      console.log(`Usage: node run-security.mjs [options]

Options:
  --case <id>       Run a single case (e.g. CVE-2026-5199)
  --all             Run all cases
  --model <model>   Override model (e.g. custom:aliyun:qwen3.6-27b)
  --verbose         Show full output
  --skip-clone      Skip cloning (use existing checkout)
  --help            Show this help
`);
      process.exit(0);
    }
  }
  return opts;
}

function loadCases(caseId) {
  const files = readdirSync(CASES_DIR).filter(f => f.endsWith('.json'));
  const cases = files.map(f => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')));
  if (caseId) return cases.filter(c => c.id === caseId);
  return cases;
}

function cloneRepo(caseData, targetDir) {
  const { repo_url, vuln_commit } = caseData;
  console.log(`  Cloning ${repo_url} @ ${vuln_commit.slice(0, 8)}...`);
  execSync(`git clone --quiet ${repo_url} ${targetDir}`, { stdio: 'pipe' });
  execSync(`git -C ${targetDir} checkout --quiet ${vuln_commit}`, { stdio: 'pipe' });
  console.log(`  Checked out vulnerable commit.`);
}

const SDK_ROOT = resolve(__dirname, '..', '..');
const DC = `npx tsx ${join(SDK_ROOT, 'src', 'cli', 'index.ts')}`;

function runStream(cmd, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', join(SDK_ROOT, 'src', 'cli', 'index.ts'), ...cmd], {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: timeoutMs,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      stderr += data.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout + stderr);
      else reject(new Error(`Process exited with code ${code}\n${stderr.slice(-2000)}`));
    });
    child.on('error', reject);
  });
}

function initWorkspace(repoDir, model) {
  console.log(`  Initializing DeepClause workspace...`);
  const args = ['init'];
  if (model) args.push('--model', model);
  return runStream(args, repoDir, 60000);
}

async function runPlanner(caseData, repoDir, model) {
  const prompt = caseData.prompt;
  console.log(`  Running security planner...\n`);
  const args = ['run', '.deepclause/system/security-planner', prompt, '--stream', '--verbose'];
  if (model) args.push('--model', model);
  const output = await runStream(args, repoDir, 600000);

  const planMatch = output.match(/I've created a security analysis plan in (plans\/[^\n]+)/);
  if (!planMatch) {
    throw new Error('Security planner did not produce a plan file.');
  }
  console.log(`\n  Plan generated: ${planMatch[1]}\n`);
  return join(repoDir, planMatch[1]);
}

async function runPlan(planPath, repoDir, model) {
  console.log(`  Running generated plan: ${basename(planPath)}...\n`);
  const args = ['run', planPath, '--stream', '--verbose'];
  if (model) args.push('--model', model);
  const output = await runStream(args, repoDir, 1800000);
  console.log('');
  return output;
}

function checkFindings(output, caseData) {
  const outputLower = output.toLowerCase();
  const gtFiles = caseData.gt_files.map(f => f.toLowerCase());
  const bugClass = caseData.bug_class.toLowerCase();
  const cwe = caseData.cwe.toLowerCase();

  // Check if any ground truth file is mentioned
  const fileFound = gtFiles.some(f => outputLower.includes(f.toLowerCase()));

  // Check if the bug class or CWE is mentioned
  const bugClassFound = outputLower.includes(bugClass) ||
    outputLower.includes(cwe) ||
    outputLower.includes(caseData.cwe.replace('CWE-', 'cve-'));

  // Check for common vulnerability indicators
  const indicators = {
    'broken-access-control': ['access control', 'authorization', 'namespace', 'privilege'],
    'path-traversal': ['path traversal', 'directory traversal', '../', 'backslash'],
    'use-after-free': ['use-after-free', 'use after free', 'dangling', 'freed'],
    'privilege-escalation': ['privilege', 'escalation', 'token', 'bypass'],
    'rce': ['rce', 'remote code', 'command execution', 'arbitrary'],
    'heap-buffer-overflow': ['buffer overflow', 'out of bounds', 'oob', 'heap'],
    'sql-injection': ['sql injection', 'injection', 'interpolation', 'parameterized'],
  };

  const indicatorFound = (indicators[caseData.bug_class] || []).some(i => outputLower.includes(i));

  return {
    fileFound,
    bugClassFound,
    indicatorFound,
    overall: fileFound && (bugClassFound || indicatorFound),
  };
}

async function main() {
  const opts = parseArgs();
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const cases = loadCases(opts.caseId);
  if (cases.length === 0) {
    console.error('No cases found.');
    process.exit(1);
  }

  const results = [];

  for (const caseData of cases) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Case: ${caseData.id} (${caseData.project})`);
    console.log(`  Bug class: ${caseData.bug_class} | Severity: ${caseData.severity}`);
    console.log(`${'='.repeat(60)}`);

    const caseDir = join(OUTPUT_DIR, caseData.id);
    mkdirSync(caseDir, { recursive: true });

    const repoDir = join(caseDir, 'repo');
    let success = false;
    let error = null;
    let planOutput = '';
    let runOutput = '';

    try {
      // Step 1: Clone repo
      if (!opts.skipClone) {
        if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
        cloneRepo(caseData, repoDir);
      } else if (!existsSync(repoDir)) {
        throw new Error('Repo not found (use --skip-clone only after a previous run)');
      }

      // Step 2: Init DeepClause workspace in the repo
      await initWorkspace(repoDir, opts.model);

      // Step 3: Run security planner
      const planPath = await runPlanner(caseData, repoDir, opts.model);

      // Step 4: Run the generated plan
      runOutput = await runPlan(planPath, repoDir, opts.model);
      writeFileSync(join(caseDir, 'plan-output.txt'), runOutput);

      // Step 5: Check findings
      const findings = checkFindings(runOutput, caseData);
      success = findings.overall;

      console.log(`  Findings:`);
      console.log(`    Ground truth file mentioned: ${findings.fileFound}`);
      console.log(`    Bug class identified: ${findings.bugClassFound}`);
      console.log(`    Vulnerability indicators: ${findings.indicatorFound}`);
      console.log(`    Overall: ${success ? 'FOUND' : 'NOT FOUND'}`);

      results.push({
        id: caseData.id,
        project: caseData.project,
        bug_class: caseData.bug_class,
        severity: caseData.severity,
        success,
        findings,
      });

    } catch (err) {
      error = err.message;
      console.error(`  Error: ${error}`);
      results.push({
        id: caseData.id,
        project: caseData.project,
        bug_class: caseData.bug_class,
        severity: caseData.severity,
        success: false,
        error,
      });
    }

    // Write case summary
    writeFileSync(join(caseDir, 'result.json'), JSON.stringify({
      case: caseData,
      success,
      error,
    }, null, 2));
  }

  // Write overall summary
  const summaryPath = join(OUTPUT_DIR, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify({
    total: results.length,
    found: results.filter(r => r.success).length,
    notFound: results.filter(r => !r.success).length,
    results,
  }, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary: ${results.filter(r => r.success).length}/${results.length} found`);
  console.log(`Results written to: ${summaryPath}`);
  console.log(`${'='.repeat(60)}`);

  for (const r of results) {
    const status = r.success ? 'FOUND' : (r.error ? 'ERROR' : 'NOT FOUND');
    console.log(`  ${r.id.padEnd(25)} ${r.bug_class.padEnd(25)} ${r.severity.padEnd(10)} ${status}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
