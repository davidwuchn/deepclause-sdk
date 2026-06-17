#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
NL2REPO_VENDOR_DIR="$SCRIPT_DIR/nl2repo/vendor"
NL2REPO_TEST_DATA_DIR="$SCRIPT_DIR/nl2repo/test-data"

usage() {
  cat <<'EOF'
Usage:
  benchmarks/nl2repo.sh <command> [options] [-- extra benchmark args]

Commands:
  setup      Clone NL2RepoBench test data and pull evaluation base images.
  run        Run the NL2Repo benchmark.
  evaluate   Evaluate completed NL2Repo benchmark runs.
  all        Setup, run, then evaluate.

Common options:
  --config <file>       Benchmark config file
  --env-file <file>     Shell env file to source before running
  --help                Show this help

Examples:
  benchmarks/nl2repo.sh setup
  benchmarks/nl2repo.sh run --env-file benchmarks/benchmark.env --task emoji --mode prompt
  benchmarks/nl2repo.sh evaluate --run-id run-2026-06-17T12-00-00-000Z --mode prompt
  benchmarks/nl2repo.sh all --env-file benchmarks/benchmark.env --task emoji --limit 1
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
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

run_setup() {
  echo "=== NL2Repo Benchmark Setup ==="

  if [[ ! -d "$NL2REPO_VENDOR_DIR/NL2RepoBench" ]]; then
    echo "Cloning NL2RepoBench repository..."
    mkdir -p "$NL2REPO_VENDOR_DIR"
    git clone --depth 1 https://github.com/multimodal-art-projection/NL2RepoBench.git "$NL2REPO_VENDOR_DIR/NL2RepoBench"
  else
    echo "NL2RepoBench repository already exists at $NL2REPO_VENDOR_DIR/NL2RepoBench"
  fi

  if [[ -d "$NL2REPO_VENDOR_DIR/NL2RepoBench/test_files" ]]; then
    echo "Copying test_files to $NL2REPO_TEST_DATA_DIR..."
    rm -rf "$NL2REPO_TEST_DATA_DIR"
    cp -r "$NL2REPO_VENDOR_DIR/NL2RepoBench/test_files" "$NL2REPO_TEST_DATA_DIR"
    local task_count
    task_count=$(find "$NL2REPO_TEST_DATA_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)
    echo "Copied $task_count task directories"
  else
    die "test_files directory not found in cloned NL2RepoBench repo"
  fi

  echo ""
  echo "Setup complete. Test data is at: $NL2REPO_TEST_DATA_DIR"
  echo "You can now run: benchmarks/nl2repo.sh run --task <task-name>"
}

run_benchmark() {
  print_env_status
  cd "$REPO_ROOT"
  npm run benchmark:nl2repo -- "$@"
}

run_evaluate() {
  cd "$REPO_ROOT"
  npm run benchmark:nl2repo:evaluate -- "$@"
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

  local env_file=""
  local extra_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --env-file)
        shift
        [[ $# -gt 0 ]] || die "missing value for --env-file"
        env_file="$1"
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

  if [[ -n "$env_file" ]]; then
    load_env_file "$env_file"
  fi

  case "$command" in
    setup)
      run_setup
      ;;
    run)
      run_benchmark "${extra_args[@]}"
      ;;
    evaluate)
      run_evaluate "${extra_args[@]}"
      ;;
    all)
      run_setup
      run_benchmark "${extra_args[@]}"
      ;;
    *)
      die "unknown command: $command"
      ;;
  esac
}

main "$@"
