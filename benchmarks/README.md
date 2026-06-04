# SWE-bench Lite Benchmarks

This folder contains a reproducible benchmark scaffold for evaluating the published DeepClause CLI against SWE-bench Lite style repository-fix tasks.

The benchmark intentionally supports multiple public CLI execution modes:

- `prompt`: runs a single headless conductor turn with `deepclause -p`.
- `plan-execute`: mirrors the TUI `/plan` flow by running the system `plan` skill through `deepclause run`, then executing the generated plan with `deepclause run`.

That distinction matters because the two paths use different runtime surfaces inside DeepClause:

- `deepclause -p` uses the conductor via `runConductorTurn(...)` and therefore the `gateway` slot.
- TUI `/plan` and TUI `/<plan>` both route through `run()` and therefore the `run` slot.

The benchmark keeps those paths separate instead of flattening them into a single synthetic runner.

## What Gets Created

- one fresh Docker worker container per SWE-bench instance
- a separate DeepClause home outside the task repository so `.deepclause/` never pollutes the git diff
- per-mode predictions JSONL files compatible with the official SWE-bench evaluator
- per-instance artifacts: command logs, DeepClause state snapshot, generated plans, git diff, and result metadata

## Quick Start

Run a small prompt-mode smoke test:

```bash
npm run benchmark:swebench -- \
  --mode prompt \
  --instance-id astropy__astropy-12907 \
  --gateway-model openai:gpt-4o \
  --gateway-temp 0.7
```

Run both benchmark modes on a two-instance subset:

```bash
npm run benchmark:swebench -- \
  --mode prompt \
  --mode plan-execute \
  --limit 2 \
  --run-model openai:gpt-4o \
  --run-temp 0.7 \
  --gateway-model openai:gpt-4o \
  --gateway-temp 0.7
```

Run from a config file:

```bash
npm run benchmark:swebench -- --config benchmarks/config.example.json
```

Evaluate one mode's predictions with the official SWE-bench harness:

```bash
npm run benchmark:swebench:evaluate -- \
  --predictions benchmarks/runs/<run-id>/prompt/predictions.jsonl \
  --run-id <run-id>-prompt
```

## Important Defaults

- The benchmark resolves `deepclause-sdk@latest` once per controller run, then pins that exact version across all worker containers for that run.
- Model ids and temperatures are configurable per DeepClause slot: `gateway`, `run`, and `compile`.
- Temperatures default to the current product defaults, not `0`, because reasoning models often degrade at `0`.
- Worker containers do not forward `BRAVE_API_KEY` by default. That avoids quietly turning mock-search fallbacks into a hidden benchmark dependency.

## Main Files

- [benchmarks/DESIGN.md](DESIGN.md)
- [benchmarks/run-swebench-lite.mjs](run-swebench-lite.mjs)
- [benchmarks/evaluate-predictions.mjs](evaluate-predictions.mjs)
- [benchmarks/worker/run-instance.mjs](worker/run-instance.mjs)
- [benchmarks/docker/worker.Dockerfile](docker/worker.Dockerfile)
- [benchmarks/docker/evaluator.Dockerfile](docker/evaluator.Dockerfile)

## CLI Flags

Common generation flags:

- `--config <file>`: load JSON config
- `--mode <prompt|plan-execute>`: repeatable
- `--instance-id <id>`: repeatable
- `--limit <n>`
- `--offset <n>`
- `--run-id <name>`
- `--deepclause-version <latest|x.y.z>`
- `--gateway-model <provider:model>`
- `--run-model <provider:model>`
- `--compile-model <provider:model>`
- `--gateway-temp <number>`
- `--run-temp <number>`
- `--compile-temp <number>`
- `--max-workers <n>`
- `--repo-setup <none|best-effort|commands>`
- `--rebuild-images`

Evaluation flags:

- `--predictions <file>`
- `--run-id <name>`
- `--dataset <name>`
- `--split <name>`
- `--max-workers <n>`
- `--cache-level <none|base|env|instance>`
- `--clean <true|false>`
- `--namespace <name|none>`
- `--swebench-version <latest|x.y.z>`

## Current Scope

This first implementation focuses on:

- public CLI execution paths
- clean per-instance Docker workers
- reproducible artifact capture
- official evaluator compatibility

It does not yet try to script the interactive fullscreen TUI itself. The `plan-execute` mode instead uses the exact lower-level `deepclause run` path that the TUI slash-command implementation already uses internally.
