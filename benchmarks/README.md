# SWE-bench Benchmarks

This folder contains a reproducible benchmark scaffold for evaluating the published DeepClause CLI against SWE-bench repository-fix tasks.

It supports SWE-bench Lite, SWE-bench Verified, and SWE-bench Pro through the same runner and evaluation flow.

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
  --dataset verified \
  --gateway-model openai:gpt-4o \
  --gateway-temp 0.7
```

Run a small SWE-bench Pro subset:

```bash
npm run benchmark:swebench -- \
  --mode prompt \
  --dataset pro \
  --limit 2 \
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

Or use the bash wrapper to load API env vars from a file first:

```bash
benchmarks/swebench.sh run \
  --env-file benchmarks/benchmark.env \
  --config benchmarks/config.qwen3.6-27b.json
```

Prepare an offline bundle while you are on VPN:

```bash
npm run benchmark:swebench:prefetch -- --config benchmarks/config.qwen3.6-27b.json
```

Then run later off VPN using the generated offline config:

```bash
npm run benchmark:swebench -- --config benchmarks/cache/config.qwen3.6-27b-offline/config.offline.json
```

Evaluate one mode's predictions with the official SWE-bench harness:

```bash
npm run benchmark:swebench:evaluate -- \
  --predictions benchmarks/runs/<run-id>/prompt/predictions.jsonl \
  --run-id <run-id>-prompt
```

## Important Defaults

- The benchmark resolves `deepclause-sdk@latest` once per controller run, then pins that exact version across all worker containers for that run.
- Dataset selection accepts the aliases `lite`, `verified`, and `pro`, in addition to explicit Hugging Face dataset names.
- Model ids and temperatures are configurable per DeepClause slot: `gateway`, `run`, and `compile`.
- Temperatures default to the current product defaults, not `0`, because reasoning models often degrade at `0`.
- Worker containers do not forward `BRAVE_API_KEY` by default. That avoids quietly turning mock-search fallbacks into a hidden benchmark dependency.
- Offline runs can use a local exported dataset JSON file, a predownloaded `deepclause-sdk` tarball, and local git mirrors prepared by `benchmark:swebench:prefetch`.

## API Env Vars

The benchmark runner forwards only a small allowlist of host env vars into worker containers:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `OPENROUTER_API_KEY`
- `HTTP_PROXY`
- `HTTPS_PROXY`
- `NO_PROXY`
- any env var whose name starts with `LLM_PROVIDER_`

That matters for configs using custom providers such as `custom:aliyun:qwen3.6-27b`. DeepClause resolves those from env vars shaped like:

- `LLM_PROVIDER_ALIYUN_API_KEY`
- `LLM_PROVIDER_ALIYUN_BASE_URL`

Use [benchmarks/benchmark.env.example](benchmark.env.example) as a starting point, then run through the wrapper script:

```bash
benchmarks/swebench.sh run \
  --env-file benchmarks/benchmark.env \
  --config benchmarks/config.qwen3.6-27b.json
```

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

## Offline Workflow

If you are on a network where Hugging Face or GitHub is unreliable, prepare the benchmark assets while you are on VPN:

1. Export the selected SWE-bench instances to a local JSON file.
2. Download the published `deepclause-sdk` package tarball that the worker will install.
3. Mirror each selected task repository locally.
4. Optionally build the worker and evaluator Docker images ahead of time.
5. Generate a ready-to-run offline config file.

Use:

```bash
npm run benchmark:swebench:prefetch -- --config benchmarks/config.qwen3.6-27b.json
```

Or via the wrapper:

```bash
benchmarks/swebench.sh prefetch \
  --env-file benchmarks/benchmark.env \
  --config benchmarks/config.qwen3.6-27b.json
```

By default this writes an offline bundle under `benchmarks/cache/<config-name>-offline/` containing:

- `datasets/selected-instances.json`
- `npm/deepclause-sdk-<version>.tgz`
- `repos/*.git` mirrors
- `config.offline.json`
- `prefetch-manifest.json`

Then run offline with:

```bash
npm run benchmark:swebench -- --config benchmarks/cache/<config-name>-offline/config.offline.json
```

Or via the wrapper:

```bash
benchmarks/swebench.sh run \
  --env-file benchmarks/benchmark.env \
  --config benchmarks/cache/<config-name>-offline/config.offline.json
```

Notes:

- The offline benchmark run still needs connectivity to your configured model provider.
- The benchmark generation path will avoid Hugging Face dataset fetches, npm package downloads, and GitHub repository fetches when the offline config is used.
- Repository-specific dependency installation is not fully prefetched yet. If the task repo's setup needs `pip install` or `npm install`, the worker may still try to reach package registries during repo setup.
- If you need a stricter offline run, disable best-effort repo setup: `npm run benchmark:swebench -- --config benchmarks/cache/<config-name>-offline/config.offline.json --repo-setup none`
- The official evaluator image can be built ahead of time, but the upstream SWE-bench harness may still need its own caches if you also want fully offline evaluation.

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

Wrapper-based evaluation example:

```bash
benchmarks/swebench.sh evaluate \
  --config benchmarks/cache/<config-name>-offline/config.offline.json \
  --benchmark-run-id <run-id> \
  --mode plan-execute
```

## Current Scope

This first implementation focuses on:

- public CLI execution paths
- clean per-instance Docker workers
- reproducible artifact capture
- official evaluator compatibility

It does not yet try to script the interactive fullscreen TUI itself. The `plan-execute` mode instead uses the exact lower-level `deepclause run` path that the TUI slash-command implementation already uses internally.
