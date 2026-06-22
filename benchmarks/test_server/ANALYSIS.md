# NL2Repo Benchmark Analysis — Run 2026-06-21T16-32-54

**Model:** qwen3.6-27b (custom:aliyun) | **DeepClause:** v0.0.77 | **Mode:** plan-execute | **Timeout:** 7200s

## Aggregate Scores

| Instance       | Score | Passed | Failed | Errors | Total | Rate    |
|----------------|-------|--------|--------|--------|-------|---------|
| aiofiles       | 170   | 170    | 41     | 0      | 211   | 80.6%   |
| arguably       | 0     | 0      | 0      | 0      | 70    | 0.0%    |
| arxiv-mcp-server| 16   | 16     | 2      | 2      | 23    | 69.6%   |
| asteval        | 58    | 58     | 16     | 2      | 227   | 25.6%   |
| autojump       | 14    | 14     | 9      | 0      | 23    | 60.9%   |
| autopep8       | 0     | 0      | 0      | 4      | 564   | 0.0%    |
| autorccar      | 6     | 6      | 0      | 4      | 13    | 46.2%   |
| binaryalert    | N/A   | N/A    | N/A    | N/A    | N/A   | N/A     |

**Overall: 264/1131 = 23.4%** (excluding binaryalert)

---

## Failure Classification

### Category 1: Nested Workspace Directory (3/8 instances — CRITICAL)

**Affected:** arguably, autopep8, autorccar

**Symptom:** The executor creates files in `workspace/workspace/` instead of `workspace/`. During evaluation, `pip install -e .` and all imports fail because the package isn't at `/workspace/` where the base image expects it.

**Root cause:** The model reads the spec, sees references to a "workspace" directory, and creates a literal `workspace/` subdirectory. For example, arguably's executor ran:
```
mkdir -p workspace/arguably workspace/docs/scripts ...
```
This puts files at `/work/workspace/workspace/arguably/` instead of `/work/workspace/arguably/`.

**Impact:** This is the single most impactful bug. If fixed:
- arguably: 0% → likely 40-70% (the agent's own internal tests showed 134/70 passing)
- autopep8: 0% → likely nonzero (files exist but also timed out)
- autorccar: 46.2% → likely 80%+ (the 4 import errors would resolve)

**Fix:** Add explicit instructions in the executor's system prompt:
- "You are ALREADY inside the workspace directory. Do NOT create a workspace/ subdirectory."
- "Write files directly: cat > src/module.py, NOT cat > workspace/src/module.py"
- "The current working directory IS the project root. All paths are relative to it."

---

### Category 2: Shallow Implementation (3/8 instances)

**Affected:** asteval (25.6%), autojump (60.9%), arxiv-mcp-server (69.6%)

**Symptom:** The generated code covers the basic scaffold but misses complex features:
- **asteval**: Error handling (reserved words, runtime errors), context managers, dict/list comprehensions, numpy integration — all missing or broken
- **autojump**: Wrong function signatures (return types, argument order), missing edge cases (empty list handling)
- **arxiv-mcp-server**: Missing private functions (`_validate_categories`, `_build_date_filter`), wrong error messages

**Root cause:** The qwen3.6-27b model lacks the capability to implement these features correctly from a spec alone. The plan breaks down the work into tasks but the model's code generation is shallow.

**Impact:** This is a model capability issue, not a harness/planner issue. Better models would improve these scores.

**Possible mitigations:**
- Provide the base image's `pyproject.toml` alongside `start.md` so the model knows the expected package layout
- Add the test file names (not contents) to the spec so the model knows what functions the tests import
- Reduce task count per plan to avoid context overflow — more focused tasks might yield deeper implementations

---

### Category 3: Executor Timeout (1/8 instances)

**Affected:** autopep8

**Symptom:** 7200s timeout. The plan had 22+ subtasks for autopep8, which is a very complex PEP8 auto-formatter with 500+ test cases. The agent was still iterating when the timer expired.

**Root cause:** The plan decomposition was too granular for the project's complexity. Each `task/2` call makes an LLM invocation, and with 22+ tasks plus the fixed tasks (pyproject, install, tests), the agent runs out of time.

**Impact:** 0/564 tests. The nested workspace issue also affects this instance.

**Possible mitigations:**
- Cap the plan at 10-12 tasks maximum (merge related steps)
- Increase the timeout for complex projects (autopep8 has 564 tests)
- Add a "time remaining" awareness mechanism so the agent can skip non-critical tasks

---

### Category 4: Harness Failure (1/8 instances)

**Affected:** binaryalert

**Symptom:** Plan generation succeeded (plan file was written), but the plan_execute phase was never launched. No plan_execute logs exist. No workspace directory was created.

**Root cause:** Unknown — likely a Docker container startup failure, resource exhaustion, or controller process crash. The main controller log would have more details.

**Impact:** Complete loss of the instance.

**Possible mitigations:**
- Add retry logic for the execution phase
- Log the Docker container launch command and result
- Add a "last resort" fallback that runs plan_execute even if plan_generate had warnings

---

## Additional Issues Found

### 5. Agent debug artifacts in workspace

The `agent_messages_iteration_*.json` files are written to the workspace during execution. These are harmless but noisy — they get copied into the eval Docker image. The workspace copy should exclude them.

### 6. Duplicate fixed tasks in executor DML

The executor DML has the planner's dynamic tasks PLUS three fixed tasks (pyproject.toml, install, tests). If the planner already included these steps (which it usually does — see arguably's plan with "Create pyproject.toml" and "Install the package" as explicit tasks), the agent does them twice. This wastes iterations and can cause confusion.

---

## Priority Fixes (Ranked by Impact)

### 1. Fix nested workspace bug (HIGH — affects 3/8 instances = ~40% of test pool)
- Add explicit "you are IN the workspace" instructions to the executor system prompt
- Add a post-execution check: if `workspace/workspace/` exists, move contents up one level
- Alternatively: in the eval harness, detect and unwrap nested directories

### 2. Remove duplicate fixed tasks from executor DML (MEDIUM — wastes iterations)
- The planner already includes pyproject.toml, install, and test steps
- Remove the hardcoded `SumPyproj`, `SumInstall`, `SumTests` tasks from the assembled DML
- Or: make the planner aware that these are handled separately

### 3. Clean up agent artifacts from workspace (LOW — cosmetic)
- Exclude `agent_messages_iteration_*.json`, `__pycache__/`, `*.egg-info/` from workspace copy
- Or: configure the agent to write debug files outside the workspace

### 4. Cap plan task count (MEDIUM — prevents timeouts)
- Limit `build_task_lines` to max 12 tasks
- If the LLM returns more than 12, truncate and merge the remaining into a final "implement remaining features" task

### 5. Add execution retry logic (LOW — rare harness failure)
- If plan_execute fails to start, retry once
- Add more diagnostic logging at the controller level

---

## What's Working Well

1. **Plan generation is reliable** — 8/8 instances generated plans successfully, including the new `write_file` direct-to-plans approach
2. **The planner produces reasonable task decompositions** — task lists are specific and actionable
3. **Simple projects score well** — aiofiles at 80.6% with the qwen3.6-27b model is respectable
4. **The eval pipeline is sound** — Dockerfile merge, test execution, and scoring work correctly
5. **The single-workspace layout works** — `write_file` succeeded for all instances, no more `cp` failures
