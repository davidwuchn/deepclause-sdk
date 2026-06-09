#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "[bootstrap] Installing Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "[bootstrap] Node $(node --version), npm $(npm --version)"
echo "[bootstrap] Starting worker..."
exec node /benchmarks-src/worker/run-instance.mjs "$@"
