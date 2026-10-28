#!/usr/bin/env bash
# Plugin tests, run against Hermes' own code (agent.memory_provider etc.) without touching Hermes' venv:
# a side venv with pytest, plus Hermes' source and site-packages on PYTHONPATH.
set -euo pipefail
cd "$(dirname "$0")/.."
HERMES_DIR="${HERMES_AGENT_DIR:-$HOME/.hermes/hermes-agent}"
HPY="$HERMES_DIR/venv/bin/python"
[ -x "$HPY" ] || { echo "Hermes venv python not found at $HPY (set HERMES_AGENT_DIR)" >&2; exit 1; }
VENV=plugins/hive/.venv
if [ ! -x "$VENV/bin/python" ]; then
  uv venv -q --python "$HPY" "$VENV"
  uv pip install -q --python "$VENV/bin/python" pytest
fi
SP="$("$HPY" -c 'import site; print(site.getsitepackages()[0])')"
PYTHONPATH="$HERMES_DIR:$SP" "$VENV/bin/python" -m pytest plugins/hive/tests -q -p no:cacheprovider "$@"
