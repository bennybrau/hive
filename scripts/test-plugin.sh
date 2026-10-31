#!/usr/bin/env bash
# Plugin tests, run against Hermes' own code (agent.memory_provider etc.) without touching Hermes' venv:
# a side venv with pytest, plus Hermes' source and site-packages on PYTHONPATH.
#
# Which Hermes:
#   HERMES_AGENT_DIR set           -> that checkout (its venv is venv/ (installer) or .venv/ (uv sync)).
#   ~/.hermes/hermes-agent exists  -> your installed Hermes (developer machine).
#   neither                        -> the pinned commit in plugins/hive/HERMES_REF, cloned and `uv sync --frozen`ed
#                                     once into ${HIVE_HERMES_CACHE:-$XDG_CACHE_HOME/hive or ~/.cache/hive}.
#                                     This is what CI and the ASF worker use. Needs git, uv and network the first time.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v uv >/dev/null || { echo "test-plugin.sh needs uv (https://docs.astral.sh/uv/): it provides Python and the venvs" >&2; exit 1; }

HERMES_REF="$(tr -d '[:space:]' < plugins/hive/HERMES_REF)"
HERMES_REPO="${HERMES_REPO:-https://github.com/NousResearch/hermes-agent.git}"

bootstrap_pinned() { # $1 = target dir; clone + locked install into a temp dir, then move into place (safe if two runs race)
  local dest="$1" tmp
  mkdir -p "$(dirname "$dest")"
  tmp="$(mktemp -d "$(dirname "$dest")/.hermes-agent.XXXXXX")"
  echo "test-plugin.sh: provisioning hermes-agent @ $HERMES_REF into $dest (first run only, ~2 min)" >&2
  git clone -q --filter=blob:none "$HERMES_REPO" "$tmp"
  git -C "$tmp" checkout -q "$HERMES_REF"
  (cd "$tmp" && uv sync --frozen -q)
  # Another run may have finished first (same pinned content): keep theirs. Never `mv` onto an existing dir,
  # which would nest ours inside it.
  if [ -e "$dest" ]; then rm -rf "$tmp"; else mv "$tmp" "$dest"; fi
}

if [ -n "${HERMES_AGENT_DIR:-}" ]; then
  HERMES_DIR="$HERMES_AGENT_DIR"
elif [ -d "$HOME/.hermes/hermes-agent" ]; then
  HERMES_DIR="$HOME/.hermes/hermes-agent"
else
  HERMES_DIR="${HIVE_HERMES_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/hive}/hermes-agent-$HERMES_REF"
  [ -x "$HERMES_DIR/.venv/bin/python" ] || bootstrap_pinned "$HERMES_DIR"
fi

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
echo "test-plugin.sh: hermes-agent at $HERMES_DIR ($("$HPY" -V))" >&2
PYTHONPATH="$HERMES_DIR:$SP" "$VENV/bin/python" -m pytest plugins/hive/tests -q -p no:cacheprovider "$@"
