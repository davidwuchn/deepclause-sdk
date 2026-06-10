#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

usage() {
  cat <<'EOF'
Usage:
  benchmarks/swebench.sh <command> [options] [-- extra benchmark args]

Commands:
  prefetch   Prepare an offline SWE-bench bundle while on VPN.
  run        Run the benchmark generation path.
  evaluate   Run the official SWE-bench evaluation for one benchmark mode.

Common options:
  --config <file>       Benchmark config file
  --env-file <file>     Shell env file to source before running
  --help                Show this help

Evaluate-only options:
  --benchmark-run-id <id>  Benchmark run id under the configured output root
  --mode <mode>            Benchmark mode to evaluate, e.g. prompt or plan-execute
  --predictions <file>     Optional explicit predictions path
  --eval-run-id <id>       Optional explicit evaluation run id (defaults to <benchmark-run-id>-<mode>)
  --report-dir <dir>       Optional explicit evaluation report dir
  --auto-discover          Auto-discover instances from run dir instead of using predictions.jsonl

Examples:
  benchmarks/swebench.sh prefetch --env-file benchmarks/benchmark.env --config benchmarks/config.qwen3.6-27b.json
  benchmarks/swebench.sh run --env-file benchmarks/benchmark.env --config benchmarks/cache/config.qwen3.6-27b-offline/config.offline.json -- --repo-setup none
  benchmarks/swebench.sh evaluate --config benchmarks/cache/config.qwen3.6-27b-offline/config.offline.json --benchmark-run-id run-2026-06-05T12-00-00-000Z --mode plan-execute
  benchmarks/swebench.sh evaluate --benchmark-run-id run-2026-06-05T12-00-00-000Z --mode prompt --auto-discover
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

json_get() {
  local config_path="$1"
  local json_path="$2"
  local default_value="${3:-}"
  node - "$config_path" "$json_path" "$default_value" <<'EOF'
const fs = require('fs');

const [configPath, jsonPath, defaultValue] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
let current = data;
for (const segment of jsonPath.split('.')) {
  if (current && Object.prototype.hasOwnProperty.call(current, segment)) {
    current = current[segment];
  } else {
    current = undefined;
    break;
  }
}

if (current === undefined || current === null || current === '') {
  process.stdout.write(defaultValue);
} else if (typeof current === 'object') {
  process.stdout.write(JSON.stringify(current));
} else {
  process.stdout.write(String(current));
}
EOF
}

load_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || die "env file not found: $env_file"

  echo "Loading benchmark env from $env_file"
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
}

print_env_status() {
  local keys=(
    OPENAI_API_KEY
    ANTHROPIC_API_KEY
    GOOGLE_GENERATIVE_AI_API_KEY
    OPENROUTER_API_KEY
    HTTP_PROXY
    HTTPS_PROXY
    NO_PROXY
  )
  local found=0

  echo "Runner will forward these env vars into worker containers if they are set:"
  for key in "${keys[@]}"; do
    if [[ -n "${!key:-}" ]]; then
      echo "  - $key"
      found=1
    fi
  done

  while IFS= read -r key; do
    if [[ -n "$key" ]]; then
      echo "  - $key"
      found=1
    fi
  done < <(env | sed -n 's/^\(LLM_PROVIDER_[A-Z0-9_]*\)=.*$/\1/p' | sort -u)

  if [[ "$found" -eq 0 ]]; then
    echo "  (none detected)"
  fi
}

run_prefetch() {
  local config_path="$1"
  shift

  print_env_status
  cd "$REPO_ROOT"
  npm run benchmark:swebench:prefetch -- --config "$config_path" "$@"
}

run_benchmark() {
  local config_path="$1"
  shift

  print_env_status
  cd "$REPO_ROOT"
  npm run benchmark:swebench -- --config "$config_path" "$@"
}

run_evaluate() {
  local config_path="$1"
  local benchmark_run_id="$2"
  local mode="$3"
  local predictions_path="$4"
  local eval_run_id="$5"
  local report_dir="$6"
  local auto_discover="$7"
  shift 7

  local output_root
  local dataset_name
  local max_workers
  local cache_level
  local clean_value
  local namespace
  local swebench_version
  local evaluator_image

  if [[ "$auto_discover" == "1" && -z "$config_path" ]]; then
    output_root="benchmarks/runs"
    local manifest_path="$output_root/$benchmark_run_id/manifest.json"
    if [[ -f "$manifest_path" ]]; then
      dataset_name=$(json_get "$manifest_path" "config.dataset.name" "lite")
      echo "Detected dataset from manifest: $dataset_name"
    else
      dataset_name="lite"
      echo "Warning: Could not read manifest.json, defaulting to dataset \"lite\""
    fi
    max_workers="4"
    cache_level="env"
    clean_value="false"
    namespace="swebench"
    swebench_version="latest"
    evaluator_image="deepclause-swebench-evaluator:latest"
  else
    output_root=$(json_get "$config_path" "artifacts.outputRoot" "benchmarks/runs")
    dataset_name=$(json_get "$config_path" "evaluation.datasetName" "SWE-bench/SWE-bench_Lite")
    max_workers=$(json_get "$config_path" "evaluation.maxWorkers" "4")
    cache_level=$(json_get "$config_path" "evaluation.cacheLevel" "env")
    clean_value=$(json_get "$config_path" "evaluation.clean" "false")
    namespace=$(json_get "$config_path" "evaluation.namespace" "swebench")
    swebench_version=$(json_get "$config_path" "evaluation.swebenchVersion" "latest")
    evaluator_image=$(json_get "$config_path" "docker.evaluatorImage" "deepclause-swebench-evaluator:latest")
  fi

  if [[ -z "$predictions_path" ]]; then
    predictions_path="$output_root/$benchmark_run_id/$mode/predictions.jsonl"
  fi
  if [[ -z "$eval_run_id" ]]; then
    eval_run_id="$benchmark_run_id-$mode"
  fi
  if [[ -z "$report_dir" ]]; then
    report_dir="$output_root/$benchmark_run_id/$mode/evaluation"
  fi

  cd "$REPO_ROOT"
  if [[ "$auto_discover" == "1" ]]; then
    local eval_args=(
      --run "$benchmark_run_id"
      --mode "$mode"
      --dataset "$dataset_name"
      --max-workers "$max_workers"
      --cache-level "$cache_level"
      --clean "$clean_value"
      --namespace "$namespace"
      --swebench-version "$swebench_version"
      --image "$evaluator_image"
    )
    if [[ -n "$eval_run_id" ]]; then
      eval_args+=(--run-id "$eval_run_id")
    fi
    if [[ -n "$report_dir" ]]; then
      eval_args+=(--report-dir "$report_dir")
    fi
    npm run benchmark:swebench:evaluate -- "${eval_args[@]}" "$@"
  else
    npm run benchmark:swebench:evaluate -- \
      --predictions "$predictions_path" \
      --run-id "$eval_run_id" \
      --dataset "$dataset_name" \
      --max-workers "$max_workers" \
      --cache-level "$cache_level" \
      --clean "$clean_value" \
      --namespace "$namespace" \
      --report-dir "$report_dir" \
      --swebench-version "$swebench_version" \
      --image "$evaluator_image" \
      "$@"
  fi
}

main() {
  local command="${1:-}"
  if [[ "$command" == "--help" || "$command" == "-h" ]]; then
    usage
    exit 0
  fi
  [[ -n "$command" ]] || {
    usage
    exit 1
  }
  shift || true

  local config_path=""
  local env_file=""
  local benchmark_run_id=""
  local mode=""
  local predictions_path=""
  local eval_run_id=""
  local report_dir=""
  local auto_discover=""
  local extra_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --config)
        shift
        [[ $# -gt 0 ]] || die "missing value for --config"
        config_path="$1"
        ;;
      --env-file)
        shift
        [[ $# -gt 0 ]] || die "missing value for --env-file"
        env_file="$1"
        ;;
      --benchmark-run-id)
        shift
        [[ $# -gt 0 ]] || die "missing value for --benchmark-run-id"
        benchmark_run_id="$1"
        ;;
      --mode)
        shift
        [[ $# -gt 0 ]] || die "missing value for --mode"
        mode="$1"
        ;;
      --predictions)
        shift
        [[ $# -gt 0 ]] || die "missing value for --predictions"
        predictions_path="$1"
        ;;
      --eval-run-id)
        shift
        [[ $# -gt 0 ]] || die "missing value for --eval-run-id"
        eval_run_id="$1"
        ;;
      --report-dir)
        shift
        [[ $# -gt 0 ]] || die "missing value for --report-dir"
        report_dir="$1"
        ;;
      --auto-discover)
        auto_discover=1
        ;;
      --)
        shift
        while [[ $# -gt 0 ]]; do
          extra_args+=("$1")
          shift
        done
        break
        ;;
      *)
        extra_args+=("$1")
        ;;
    esac
    shift || true
  done

  if [[ "$auto_discover" != "1" ]]; then
    [[ -n "$config_path" ]] || die "--config is required (or use --auto-discover for evaluate)"
  fi
  if [[ -n "$env_file" ]]; then
    load_env_file "$env_file"
  fi

  case "$command" in
    prefetch)
      run_prefetch "$config_path" "${extra_args[@]}"
      ;;
    run)
      run_benchmark "$config_path" "${extra_args[@]}"
      ;;
    evaluate)
      [[ -n "$benchmark_run_id" ]] || die "--benchmark-run-id is required for evaluate"
      [[ -n "$mode" ]] || die "--mode is required for evaluate"
      run_evaluate "$config_path" "$benchmark_run_id" "$mode" "$predictions_path" "$eval_run_id" "$report_dir" "$auto_discover" "${extra_args[@]}"
      ;;
    *)
      die "unknown command: $command"
      ;;
  esac
}

main "$@"