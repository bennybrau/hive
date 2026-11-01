#!/usr/bin/env bash
# Rebuild and restart the hive and hive-worker containers in place (detached; returns when healthy).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose build hive hive-worker
docker compose up --detach --wait
curl -fsS "http://127.0.0.1:${HIVE_PORT:-8800}/health"; echo
