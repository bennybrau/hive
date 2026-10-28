#!/usr/bin/env bash
# Plugin tests, run against Hermes' own code (agent.memory_provider etc.) without touching Hermes' venv:
# a side venv with pytest, plus Hermes' source and site-packages on PYTHONPATH.
#   HERMES_AGENT_DIR  Hermes checkout (default ~/.hermes/hermes-agent). Its venv is venv/ (installer) or .venv/ (uv sync).
set -euo pipefail
cd "$(dirname "$0")/.."
HERMES_DIR="${HERMES_AGENT_DIR:-$HOME/.hermes/hermes-agent}"
HPY=""
for cand in "$HERMES_DIR/venv/bin/python" "$HERMES_DIR/.venv/bin/python"; do
  if [ -x "$cand" ]; then HPY="$cand"; break; fi
done
[ -n "$HPY" ] || { echo "no Hermes venv under $HERMES_DIR (venv/ or .venv/) - set HERMES_AGENT_DIR" >&2; exit 1; }
VENV=plugins/hive/.venv
# Side venv must match Hermes' Python (site-packages are shared via PYTHONPATH); rebuild if it drifted.
if [ -x "$VENV/bin/python" ] && [ "$("$VENV/bin/python" -V)" != "$("$HPY" -V)" ]; then rm -rf "$VENV"; fi
if [ ! -x "$VENV/bin/python" ]; then
  uv venv -q --python "$HPY" "$VENV"
  uv pip install -q --python "$VENV/bin/python" pytest
fi
SP="$("$HPY" -c 'import site; print(site.getsitepackages()[0])')"
PYTHONPATH="$HERMES_DIR:$SP" "$VENV/bin/python" -m pytest plugins/hive/tests -q -p no:cacheprovider "$@"
