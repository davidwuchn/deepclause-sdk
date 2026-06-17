# NL2Repo Benchmark Implementation Plan

## Goal

Add an NL2Repo benchmark to the DeepClause SDK that evaluates the `deepclause` CLI on **0-to-1 repository generation tasks** from [NL2RepoBench](https://github.com/multimodal-art-projection/NL2RepoBench). This benchmark replaces OpenHands with DeepClause as the agent under test, while reusing NL2RepoBench's test data, pre-built evaluation images, and pytest-based scoring.

---

## Background

### What NL2RepoBench Does

NL2RepoBench evaluates coding agents on 104 long-horizon tasks where the agent must generate a **complete, runnable Python repository from scratch** given a natural language specification (`start.md`). Each task has:

- `start.md` — detailed project specification (API signatures, architecture, examples)
- `test_case_count.txt` — ground-truth total test count
- `test_commands.json` — shell commands to run for evaluation (e.g., `["pip install -e .", "pytest ..."]`)
- `test_files.json` — paths to delete before evaluation (prevents agent from seeing ground-truth tests)
- Pre-built Docker base image at `ghcr.io/multimodal-art-projection/nl2repobench/{project}:1.0`

Scoring: `score = pytest_results['passed']` (number of passing tests), `success_rate = passed / total`.

### What the Existing Benchmarks Do

The repo already has two benchmarks:

| Benchmark | Task Type | Agent | Isolation | Evaluation |
|-----------|-----------|-------|-----------|------------|
| **SWE-bench** | Repo repair (patch existing code) | DeepClause CLI | Docker worker per instance | Official `swebench` harness |
| **DeepPlanning** | Travel/shopping planning | DeepClause CLI | Host (no Docker) | Qwen-Agent Python scripts |

Common patterns: 3-layer config merge, `mapLimit()` concurrency, manifest/summary JSON, artifact directory layout, step logging.

---

## Architecture

### Execution Modes

Three modes, mirroring the existing SWE-bench modes plus DeepClause's unique compile capability:

| Mode | CLI Path | Model Slot | Description |
|------|----------|------------|-------------|
| **prompt** | `deepclause -p <request>` | `gateway` | Single headless conductor turn |
| **plan-execute** | `deepclause run .deepclause/system/plan.dml` then `deepclause run plans/<generated>.dml` | `run` | Plan then execute |
| **compile** | `deepclause compile start.md` then `deepclause run .deepclause/tools/start.dml` | `compile` + `run` | Compile spec to DML, then run |

The **compile** mode is unique to DeepClause and tests the neuro-symbolic pipeline: Markdown → DML → execution.

### Clean Environment Model

Each task gets a dedicated Docker worker container:

```
/work/task/          → agent's workspace (where the repo is generated)
/work/agent-home/    → DeepClause home (.deepclause/ state lives here)
```

This mirrors the SWE-bench separation — the agent works in `/work/task/`, DeepClause state is in `/work/agent-home/`, so `.deepclause/` never pollutes the generated code.

Unlike SWE-bench, there is **no pre-existing repository**. The workspace starts empty except for `start.md`.

### Evaluation Model

After the agent finishes, evaluation proceeds exactly like the upstream NL2RepoBench:

1. **Remove package management files** from the workspace (setup.py, pyproject.toml, etc.) — forces reliance on the base image's pre-installed deps
2. **Remove test files** specified in `test_files.json` — prevents ground-truth test leakage
3. **Build test Docker image** from the per-task base image + the agent's workspace
4. **Run test commands** from `test_commands.json` inside the test container
5. **Parse pytest output** via regex to extract passed/failed/error counts
6. **Compute score** = `passed` count; `success_rate` = `passed / test_case_count`

This is a faithful reproduction of the upstream evaluation, adapted to run from the Node.js controller.

### Two-Container Architecture Per Task

**Container 1 — Agent Worker (DeepClause):**
- Built from `benchmarks/docker/worker.Dockerfile` (same as SWE-bench, or a new `nl2repo-worker.Dockerfile`)
- Contains Node 20 + Python 3 + git
- Installs `deepclause-sdk` at runtime
- Runs DeepClause CLI with the task prompt
- Writes generated code to `/work/task/`

**Container 2 — Test/Eval Container:**
- Built dynamically per task
- Base image: `ghcr.io/multimodal-art-projection/nl2repobench/{project}:1.0`
- Copies agent's workspace into `/workspace`
- Runs `test_commands.json` commands
- Captures pytest output for scoring

---

## File Structure

```
benchmarks/
  nl2repo-PLAN.md                          ← this file
  run-nl2repo.mjs                          ← main controller script
  evaluate-nl2repo.mjs                     ← evaluation script
  nl2repo.sh                               ← shell wrapper (setup/run/evaluate)

  nl2repo/
    test-data/                             ← cloned/linked NL2RepoBench test_files
      aiofiles/
        start.md
        test_case_count.txt
        test_commands.json
        test_files.json
      arguably/
      ...
    worker/
      run-instance.mjs                     ← per-instance worker (runs inside Docker)
    docker/
      worker.Dockerfile                    ← agent worker image
      test-evaluator.Dockerfile            ← evaluation image template (optional)
```

### Artifact Layout

```
benchmarks/runs/<run-id>/
  manifest.json
  summary.json
  prompt/                                  (or plan-execute/, compile/)
    predictions.jsonl                      ← NL2RepoBench-compatible results
    summary.json
    instances/
      <task-name>/
        input.json                         ← worker input spec
        result.json                        ← worker result (success, score, etc.)
        docker.stdout.log
        docker.stderr.log
        logs/
        agent-home/                        ← .deepclause/ state snapshot
        workspace/                         ← generated code (for debugging)
```

---

## Implementation Steps

### Step 1: Setup Script — `nl2repo.sh` + Data Download

Create `benchmarks/nl2repo.sh` with subcommands:

- **`setup`**: Clone the NL2RepoBench repo and copy `test_files/` into `benchmarks/nl2repo/test-data/`. Optionally pre-pull the evaluation base images.
- **`run`**: Forward to `npm run benchmark:nl2repo -- [args]` after loading env vars.
- **`evaluate`**: Forward to `npm run benchmark:nl2repo:evaluate -- [args]`.

The setup step fetches:
- `test_files/` directory from the NL2RepoBench repo (104 task directories)
- Pre-built base images from `ghcr.io/multimodal-art-projection/nl2repobench/`

### Step 2: Config Schema — `config.nl2repo.json`

```json
{
  "dataset": {
    "tasks": ["emoji", "math-verify"],
    "limit": 5,
    "offset": 0,
    "testDataDir": "benchmarks/nl2repo/test-data"
  },
  "modes": ["prompt"],
  "deepclause": {
    "version": "latest",
    "models": {
      "gateway": "openai:gpt-4o",
      "run": "openai:gpt-4o",
      "compile": "openai:gpt-4o"
    },
    "temperatures": {
      "gateway": 0.7,
      "run": 0.7,
      "compile": 0.4
    },
    "shell": { "wrapper": "clean-room", "strictIsolation": false },
    "agentvm": { "network": false }
  },
  "execution": {
    "maxWorkers": 1,
    "agentTimeoutSeconds": 3600,
    "verbose": false
  },
  "docker": {
    "platform": "linux/amd64",
    "workerImage": "deepclause-nl2repo-worker:latest",
    "rebuildImages": false
  },
  "evaluation": {
    "pullBaseImages": true,
    "removePackageFiles": true,
    "removeTestFiles": true
  },
  "artifacts": { "outputRoot": "benchmarks/runs" }
}
```

### Step 3: Main Controller — `run-nl2repo.mjs`

Follow the SWE-bench controller pattern (~600-800 lines):

1. **Parse config** — merge `DEFAULT_CONFIG`, file config, CLI overrides
2. **Resolve `deepclause-sdk@latest`** and pin version
3. **Load task metadata** from `test-data/` directories (read `test_case_count.txt`, `test_commands.json`, `test_files.json`, `start.md`)
4. **Filter/select tasks** by `--task`, `--limit`, `--offset`
5. **Build worker Docker image** if needed
6. **Queue tasks** — Cartesian product of modes × tasks
7. **Run workers** with concurrency via `mapLimit()`
8. **Collect results** and write `predictions.jsonl`, `summary.json`

### Step 4: Worker Script — `nl2repo/worker/run-instance.mjs`

Runs inside the Docker worker container (~300-400 lines):

**Setup phase:**
1. Create `/work/task/` and `/work/agent-home/`
2. Copy `start.md` into `/work/task/`
3. `deepclause init` in `/work/agent-home/`
4. Write `.deepclause/config.json` with model, temperature, tool whitelist
5. Install benchmark `plan.dml` (same one used by SWE-bench)

**Agent execution phase (per mode):**
- **prompt**: `deepclause -p <request>`
- **plan-execute**: `deepclause run .deepclause/system/plan.dml <request>` then `deepclause run plans/<generated>.dml`
- **compile**: `deepclause compile /work/task/start.md` then `deepclause run .deepclause/tools/start.dml`

The request prompt is constructed from `start.md`:
```
According to the start.md specification in your workspace, implement the entire project as described.
The project must be runnable in the current directory. Follow the specification carefully and implement step by step.
```

**Artifact collection:**
- Copy `.deepclause/` state to output
- Copy `plans/` if plan-execute mode
- Write `result.json` with success, duration, commands, warnings

### Step 5: Evaluation Script — `evaluate-nl2repo.mjs`

Runs **after** the agent worker has completed (~250-350 lines):

For each task instance:
1. **Read worker result** and locate the generated workspace
2. **Remove package management files** (setup.py, pyproject.toml, etc.)
3. **Remove test files** listed in `test_files.json`
4. **Build test Docker image**:
   ```dockerfile
   FROM --platform=linux/amd64 ghcr.io/multimodal-art-projection/nl2repobench/<project>:1.0
   COPY workspace /workspace
   WORKDIR /workspace
   ENV PYTHONPATH=/workspace:$PYTHONPATH
   CMD ["tail", "-f", "/dev/null"]
   ```
5. **Run test container** and execute commands from `test_commands.json`
6. **Parse pytest output** — extract passed/failed/error counts via regex
7. **Compute score** — `score = passed`, `success_rate = passed / test_case_count`
8. **Write evaluation result** — update `result.json` with pytest results and score

Alternatively, the evaluation can be integrated directly into `run-nl2repo.mjs` as a post-processing step (similar to how the upstream NL2RepoBench does it in `post_processor.py`), avoiding a separate script. The separate script approach is preferred because:
- It allows re-evaluation without re-running the agent
- It follows the pattern established by SWE-bench's `evaluate-predictions.mjs`
- It keeps the controller and evaluation concerns separate

### Step 6: Docker Images

**Worker Dockerfile** (`nl2repo/docker/worker.Dockerfile`):
- Reuse or slightly modify `benchmarks/docker/worker.Dockerfile`
- Key: Node 20, Python 3, git, build tools
- DeepClause installed at runtime via `npm install -g deepclause-sdk@<version>`

**No evaluator Dockerfile needed** — the evaluation containers are built dynamically per-task from the upstream base images. The evaluation script itself runs on the host (or in the controller) using the Docker API directly.

### Step 7: Package.json Scripts

Add to `package.json`:
```json
{
  "benchmark:nl2repo": "node benchmarks/run-nl2repo.mjs",
  "benchmark:nl2repo:evaluate": "node benchmarks/evaluate-nl2repo.mjs"
}
```

### Step 8: CLI Flags

```
--config <file>           Load JSON config
--mode <prompt|plan-execute|compile>   Repeatable
--task <name>             Repeatable task name (e.g., emoji, math-verify)
--limit <n>               Run first N tasks
--offset <n>              Skip first N tasks
--run-id <name>           Custom run ID
--deepclause-version <v>  Override SDK version
--gateway-model <m>       Gateway model
--run-model <m>           Run model
--compile-model <m>       Compile model
--gateway-temp <n>        Gateway temperature
--run-temp <n>            Run temperature
--compile-temp <n>        Compile temperature
--max-workers <n>         Concurrency
--test-data-dir <path>    Override test data directory
--rebuild-images          Force rebuild Docker images
```

---

## Key Design Decisions

### 1. DeepClause as Agent (not OpenHands)

The upstream NL2RepoBench uses OpenHands in headless Docker mode. We replace it with the DeepClause CLI, which is the whole point of benchmarking our own system. The prompt construction and workspace setup are adapted accordingly.

### 2. Reuse Upstream Test Data and Base Images

We don't reinvent evaluation — we clone `test_files/` from NL2RepoBench and pull the pre-built base images from GHCR. This ensures our scores are comparable with published results for other agents.

### 3. Docker-Isolated Agent Execution

Unlike DeepPlanning (host execution), NL2Repo uses Docker workers like SWE-bench. This is necessary because:
- Tasks generate arbitrary Python code that must not affect the host
- Evaluation needs clean environments
- Consistent with the upstream benchmark's isolation model

### 4. Evaluation as Separate Phase

The evaluation runs after all agent tasks complete (or per-task). This allows:
- Re-evaluation without re-running agents
- Debugging of agent output before evaluation
- Consistent artifact layout

### 5. Compile Mode

The `compile` mode is unique to DeepClause — no other agent benchmark tests spec-to-DML compilation. This is the neuro-symbolic advantage: a Markdown spec can be compiled into a logic program that guarantees execution semantics (backtracking, recursion, constraint solving).

### 6. Banned Tools

Same as SWE-bench: `web_search`, `news_search`, `url_fetch`, `create_skill`, `ask_user`. The agent should generate code from the spec, not search the web or ask for help.

---

## Estimated Scope

| File | Lines (est.) | Description |
|------|-------------|-------------|
| `run-nl2repo.mjs` | 600-800 | Main controller |
| `evaluate-nl2repo.mjs` | 250-350 | Evaluation script |
| `nl2repo/worker/run-instance.mjs` | 300-400 | Per-instance worker |
| `nl2repo.sh` | 80-120 | Shell wrapper |
| `nl2repo/docker/worker.Dockerfile` | 15-25 | Worker image |
| **Total** | ~1250-1700 | |

---

## Implementation Order

1. **`nl2repo.sh` setup** — clone test data, pull base images
2. **`nl2repo/docker/worker.Dockerfile`** — build worker image
3. **`nl2repo/worker/run-instance.mjs`** — worker script (prompt mode first)
4. **`run-nl2repo.mjs`** — controller (prompt mode only, single task)
5. **`evaluate-nl2repo.mjs`** — evaluation pipeline
6. **End-to-end test** — run one task through the full pipeline
7. **Add plan-execute mode** — extend worker
8. **Add compile mode** — extend worker
9. **Concurrency and robustness** — `mapLimit()`, timeouts, error handling
10. **Package.json scripts** — wire up npm commands
11. **Documentation** — update benchmarks/README.md

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Upstream base images may be large (~1GB+ each) | `setup` pulls only needed images; optional `--pull-base-images` flag |
| 104 tasks is a lot of compute | `--limit` and `--task` flags for targeted runs |
| `start.md` specs are very detailed (~23KB for emoji) | DeepClause's context window should handle this; test with smaller tasks first |
| Compile mode is unproven for 0-to-1 generation | Start with prompt/plan-execute; add compile as experimental |
| Pytest output parsing is fragile | Use the same regex approach as upstream; add fallback parsers |
| Agent timeout may need tuning | Configurable `agentTimeoutSeconds`; start with 3600s (1h) |
