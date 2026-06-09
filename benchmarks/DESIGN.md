# Benchmark Design

## Goal

Benchmark the published `deepclause-sdk` CLI against SWE-bench Lite, SWE-bench Verified, and SWE-bench Pro repository-repair tasks while keeping:

- the agent under test on the public CLI surface
- the worker environment fresh per instance
- the evaluation format compatible with the official SWE-bench harness
- the execution mode explicit, because different DeepClause entrypoints do different things

## Why Multiple Modes Matter

DeepClause has at least two materially different task-execution paths relevant to this benchmark.

### 1. `deepclause -p`

This is the headless conductor path.

- entrypoint: [src/cli/tui.ts](../src/cli/tui.ts)
- runtime: `runPromptHeadless(...) -> runConductorTurn(...)`
- model slot: `gateway`
- state: creates a fresh conductor session and persists `.deepclause/sessions/<id>/...`

### 2. TUI `/plan`, then execute the generated plan

The TUI slash-command implementation does not run `/plan` through the conductor. It resolves the `plan` system command and executes it via the same `run()` path used for normal DML files.

- slash dispatch: [src/cli/tui.ts](../src/cli/tui.ts)
- command catalog: [src/cli/commands.ts](../src/cli/commands.ts)
- runtime: `runSlashCommand(...) -> executeRunnableCommand(...) -> run(...)`
- model slot: `run`

That means `/plan` generation and `/<plan>` execution both use the `run` slot, not the `gateway` slot.

The benchmark mirrors that behavior directly with:

1. `deepclause run .deepclause/system/plan.dml <request>`
2. `deepclause run plans/<generated>.dml`

This is more faithful than trying to fake slash commands through `deepclause -p`.

## Clean Environment Model

Each instance gets a dedicated worker container.

Inside that container:

- `/work/task` holds the checked-out target repository at the SWE-bench base commit
- `/work/agent-home` is the DeepClause home and current working directory for CLI commands
- DeepClause config points `workspace` at `/work/task`

This separation is deliberate:

- repository diffs stay clean
- `.deepclause/` state is still captured as an artifact
- patch extraction remains a pure git diff over the task repo

## Tooling Choices

### Worker image

The worker image is a generic Node 20 plus git plus Python utility image. It installs the exact resolved `deepclause-sdk` npm version inside every container run.

Why not bake DeepClause into the image?

- the user asked for latest npm support
- resolving `latest` once per controller run and installing that pinned version inside each worker is reproducible for that run

### Evaluator image

The official SWE-bench evaluator runs separately inside its own container with the host Docker socket mounted through. That keeps prediction generation and grading distinct while still using the authoritative `swebench.harness.run_evaluation` flow.

## Configuration Model

The benchmark exposes slot-level model settings because the DeepClause entrypoints use different slots:

- `gateway`: conductor turns such as `deepclause -p`
- `run`: `deepclause run`, TUI `/plan`, and generated plan execution
- `compile`: available for completeness and future modes

Temperatures default to the current product defaults:

- `gateway`: `0.7`
- `run`: `0.7`
- `compile`: `0.4`

The benchmark intentionally does not default everything to `0`, because that is often a poor default for reasoning models.

## Prompt Construction

The worker builds a repo-fix request from the SWE-bench instance fields:

- `problem_statement`
- `hints_text`
- `FAIL_TO_PASS`
- `PASS_TO_PASS`

The request is designed to keep the agent local to the checked-out repository and discourage unrelated behaviors such as web search or skill creation.

## Dataset Loading

The controller supports:

- local `.json` and `.jsonl` instance files
- Hugging Face dataset server loading for SWE-bench Lite, SWE-bench Verified, and SWE-bench Pro

Built-in dataset aliases:

- `lite` -> `SWE-bench/SWE-bench_Lite`
- `verified` -> `SWE-bench/SWE-bench_Verified`
- `pro` -> `ScaleAI/SWE-bench_Pro`

The default dataset alias remains `lite`.

## Artifact Layout

Each run is stored under:

```text
benchmarks/runs/<run-id>/
  manifest.json
  prompt/
    predictions.jsonl
    summary.json
    instances/
      <instance-id>/
        input.json
        result.json
        logs/
        agent-home/
  plan-execute/
    predictions.jsonl
    summary.json
    instances/
      <instance-id>/
        input.json
        result.json
        logs/
        agent-home/
```

## Consistency Notes

The benchmark tries to stay consistent with the product's real routing rules:

- `prompt` mode uses the same headless conductor path as `deepclause -p`
- `plan-execute` mode uses the same `run()` path that the TUI uses for `/plan` and `/<plan>`

It does not try to drive the fullscreen TUI interactively.

## Known Limits

- The first implementation uses a generic clean worker image rather than the full official SWE-bench task environment during patch generation.
- Official grading still uses the real SWE-bench evaluator and its Docker images.
- Prompt-mode tool usage can be reconstructed from conductor session logs; run-mode tool usage is less observable without changing the CLI.
- Additional execution modes can be added later without changing the predictions or evaluator contract.
