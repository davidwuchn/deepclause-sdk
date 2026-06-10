#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

usage() {
  cat <<'EOF'
Usage:
  benchmarks/deepplanning.sh <command> [options]

Commands:
  setup       Clone Qwen-Agent repo and install Python dependencies.
  run         Run the DeepPlanning benchmark (generation phase).
  evaluate    Evaluate results from a previous run.
  all         Run generation + evaluation in sequence.

Common options:
  --bench-dir <path>       Path to Qwen-Agent benchmark/deepplanning directory
  --domain <shopping|travel>  Benchmark domain (repeatable; default: both)
  --env-file <file>        Shell env file to source before running
  --help                   Show this help

Run options:
  --level <1|2|3>          Shopping difficulty level (repeatable; default: all)
  --language <en|zh>       Travel language (default: en)
  --limit <n>              Limit number of tasks
  --offset <n>             Skip first N tasks
  --run-id <name>          Run identifier
  --max-workers <n>        Concurrent workers (default: 1)
  --agent-timeout <secs>   Per-task timeout in seconds (default: 600)
  --run-model <id>         Run model (default: openai:gpt-4o)
  --run-temp <n>           Run temperature (default: 0.7)
  --verbose, -v            Stream worker output

Evaluate options:
  --run-id <name>          Run ID to evaluate (required for evaluate/all)

Examples:
  benchmarks/deepplanning.sh setup
  benchmarks/deepplanning.sh run --domain shopping --level 1 --limit 2
  benchmarks/deepplanning.sh all --domain shopping --domain travel --limit 3
  benchmarks/deepplanning.sh all --limit 2
  benchmarks/deepplanning.sh evaluate --run-id dp-2026-06-10T...
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

DEFAULT_VENDOR_DIR="$SCRIPT_DIR/deepplanning/vendor/Qwen-Agent"

resolve_bench_dir() {
  if [[ -n "${BENCH_DIR:-}" ]]; then
    echo "$BENCH_DIR"
    return
  fi
  local candidate="$DEFAULT_VENDOR_DIR/benchmark/deepplanning"
  if [[ -d "$candidate" ]]; then
    echo "$candidate"
    return
  fi
  echo ""
}

cmd_setup() {
  local vendor_dir="$DEFAULT_VENDOR_DIR"
  local bench_dir
  bench_dir=$(resolve_bench_dir)

  if [[ -n "$bench_dir" && -d "$bench_dir" ]]; then
    echo "Qwen-Agent already cloned at $vendor_dir"
  else
    echo "Cloning Qwen-Agent into $vendor_dir ..."
    mkdir -p "$(dirname "$vendor_dir")"
    git clone --depth 1 https://github.com/QwenLM/Qwen-Agent.git "$vendor_dir"
    echo "Done."
  fi

  echo ""
  echo "Installing Python dependencies ..."
  pip3 install --quiet pandas rank-bm25 huggingface_hub 2>/dev/null || pip install --quiet pandas rank-bm25 huggingface_hub
  echo "Done."

  bench_dir=$(resolve_bench_dir)

  echo ""
  echo "Downloading databases from HuggingFace ..."
  local shop_db_dir="$bench_dir/shoppingplanning/database"
  local travel_db_dir="$bench_dir/travelplanning/database"

  if [[ -d "$shop_db_dir/level_1" && -f "$shop_db_dir/level_1/case_1/products.jsonl" ]]; then
    echo "Shopping databases already extracted."
  else
    mkdir -p "$bench_dir/.tmp_download"
    for level in 1 2 3; do
      echo "  Downloading shopping level $level ..."
      python3 -c "from huggingface_hub import hf_hub_download; hf_hub_download('Qwen/DeepPlanning', 'database_level${level}.tar.gz', repo_type='dataset', local_dir='$bench_dir/.tmp_download')" 2>/dev/null
      local archive="$bench_dir/.tmp_download/database_level${level}.tar.gz"
      if [[ -f "$archive" ]]; then
        echo "  Extracting shopping level $level ..."
        tar -xzf "$archive" -C "$bench_dir/.tmp_download"
        mkdir -p "$shop_db_dir/level_${level}"
        cp -r "$bench_dir/.tmp_download/database_level${level}"/* "$shop_db_dir/level_${level}/"
      else
        echo "  WARNING: Could not download shopping level $level. Download manually from https://huggingface.co/datasets/Qwen/DeepPlanning"
      fi
    done
    rm -rf "$bench_dir/.tmp_download"
  fi

  if [[ -d "$travel_db_dir/database_en" ]]; then
    echo "Travel databases already extracted."
  else
    mkdir -p "$bench_dir/.tmp_download"
    for lang in en zh; do
      echo "  Downloading travel $lang database ..."
      python3 -c "from huggingface_hub import hf_hub_download; hf_hub_download('Qwen/DeepPlanning', 'database_${lang}.zip', repo_type='dataset', local_dir='$bench_dir/.tmp_download')" 2>/dev/null
      local zipfile="$bench_dir/.tmp_download/database_${lang}.zip"
      if [[ -f "$zipfile" ]]; then
        echo "  Extracting travel $lang database ..."
        mkdir -p "$travel_db_dir"
        unzip -o -q "$zipfile" -d "$travel_db_dir"
      else
        echo "  WARNING: Could not download travel $lang database. Download manually from https://huggingface.co/datasets/Qwen/DeepPlanning"
      fi
    done
    rm -rf "$bench_dir/.tmp_download"
  fi

  echo ""
  echo "Setup complete. Benchmark directory: $bench_dir"
}

cmd_run() {
  local bench_dir
  bench_dir=$(resolve_bench_dir)
  if [[ -z "$bench_dir" ]]; then
    die "Qwen-Agent not found. Run 'benchmarks/deepplanning.sh setup' first, or set --bench-dir."
  fi

  local run_args=()
  run_args+=(--bench-dir "$bench_dir")

  [[ ${#DOMAINS[@]} -gt 0 ]] && for d in "${DOMAINS[@]}"; do run_args+=(--domain "$d"); done
  [[ -n "${LEVELS:-}" ]] && for l in $LEVELS; do run_args+=(--level "$l"); done
  [[ -n "${LANGUAGE:-}" ]] && run_args+=(--language "$LANGUAGE")
  [[ -n "${LIMIT:-}" ]] && run_args+=(--limit "$LIMIT")
  [[ -n "${OFFSET:-}" ]] && run_args+=(--offset "$OFFSET")
  [[ -n "${RUN_ID:-}" ]] && run_args+=(--run-id "$RUN_ID")
  [[ -n "${MAX_WORKERS:-}" ]] && run_args+=(--max-workers "$MAX_WORKERS")
  [[ -n "${AGENT_TIMEOUT:-}" ]] && run_args+=(--agent-timeout "$AGENT_TIMEOUT")
  [[ -n "${RUN_MODEL:-}" ]] && run_args+=(--run-model "$RUN_MODEL")
  [[ -n "${RUN_TEMP:-}" ]] && run_args+=(--run-temp "$RUN_TEMP")
  [[ "${VERBOSE:-}" == "1" ]] && run_args+=(--verbose)

  cd "$REPO_ROOT"
  npm run benchmark:deepplanning -- "${run_args[@]}" "${EXTRA_ARGS[@]}"
}

cmd_evaluate() {
  local bench_dir
  bench_dir=$(resolve_bench_dir)
  if [[ -z "$bench_dir" ]]; then
    die "Qwen-Agent not found. Run 'benchmarks/deepplanning.sh setup' first, or set --bench-dir."
  fi

  [[ -z "${RUN_ID:-}" ]] && die "--run-id is required for evaluate"

  local eval_args=()
  eval_args+=(--run "$RUN_ID")
  eval_args+=(--bench-dir "$bench_dir")
  [[ ${#DOMAINS[@]} -gt 0 ]] && for d in "${DOMAINS[@]}"; do eval_args+=(--domain "$d"); done

  cd "$REPO_ROOT"
  npm run benchmark:deepplanning:evaluate -- "${eval_args[@]}" "${EXTRA_ARGS[@]}"
}

cmd_all() {
  if [[ -z "${RUN_ID:-}" ]]; then
    RUN_ID="dp-$(date -u +%Y-%m-%dT%H-%M-%S)"
    echo "Auto-generated run ID: $RUN_ID"
  fi

  echo "=========================================="
  echo " Phase 1: Running benchmark"
  echo "=========================================="
  cmd_run

  echo ""
  echo "=========================================="
  echo " Phase 2: Evaluating results"
  echo "=========================================="
  cmd_evaluate

  echo ""
  echo "=========================================="
  echo " Complete. Run ID: $RUN_ID"
  echo "=========================================="
}

main() {
  local command="${1:-}"
  if [[ "$command" == "--help" || "$command" == "-h" ]]; then
    usage
    exit 0
  fi
  [[ -n "$command" ]] || { usage; exit 1; }
  shift || true

  local BENCH_DIR=""
  local DOMAINS=()
  local LEVELS=""
  local LANGUAGE="en"
  local LIMIT=""
  local OFFSET=""
  local RUN_ID=""
  local MAX_WORKERS=""
  local AGENT_TIMEOUT=""
  local RUN_MODEL=""
  local RUN_TEMP=""
  local ENV_FILE=""
  local VERBOSE=""
  local EXTRA_ARGS=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --bench-dir)
        shift
        [[ $# -gt 0 ]] || die "missing value for --bench-dir"
        BENCH_DIR="$1"
        ;;
      --domain)
        shift
        [[ $# -gt 0 ]] || die "missing value for --domain"
        DOMAINS+=("$1")
        ;;
      --level)
        shift
        [[ $# -gt 0 ]] || die "missing value for --level"
        LEVELS="${LEVELS:+$LEVELS }$1"
        ;;
      --language)
        shift
        [[ $# -gt 0 ]] || die "missing value for --language"
        LANGUAGE="$1"
        ;;
      --limit)
        shift
        [[ $# -gt 0 ]] || die "missing value for --limit"
        LIMIT="$1"
        ;;
      --offset)
        shift
        [[ $# -gt 0 ]] || die "missing value for --offset"
        OFFSET="$1"
        ;;
      --run-id)
        shift
        [[ $# -gt 0 ]] || die "missing value for --run-id"
        RUN_ID="$1"
        ;;
      --max-workers)
        shift
        [[ $# -gt 0 ]] || die "missing value for --max-workers"
        MAX_WORKERS="$1"
        ;;
      --agent-timeout)
        shift
        [[ $# -gt 0 ]] || die "missing value for --agent-timeout"
        AGENT_TIMEOUT="$1"
        ;;
      --run-model)
        shift
        [[ $# -gt 0 ]] || die "missing value for --run-model"
        RUN_MODEL="$1"
        ;;
      --run-temp)
        shift
        [[ $# -gt 0 ]] || die "missing value for --run-temp"
        RUN_TEMP="$1"
        ;;
      --env-file)
        shift
        [[ $# -gt 0 ]] || die "missing value for --env-file"
        ENV_FILE="$1"
        ;;
      --verbose|-v)
        VERBOSE=1
        ;;
      *)
        EXTRA_ARGS+=("$1")
        ;;
    esac
    shift || true
  done

  if [[ -n "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
    echo "Loading env from $ENV_FILE"
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi

  if [[ -n "$BENCH_DIR" ]]; then
    export QWEN_AGENT_BENCH_DIR="$BENCH_DIR"
  fi

  case "$command" in
    setup)
      cmd_setup
      ;;
    run)
      cmd_run
      ;;
    evaluate)
      cmd_evaluate
      ;;
    all)
      cmd_all
      ;;
    *)
      die "unknown command: $command"
      ;;
  esac
}

main "$@"
