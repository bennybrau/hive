#!/usr/bin/env python3
"""Render a Hermes session (or a slice of it) from ~/.hermes/state.db exactly as the Hive plugin would post it.

    extract.py list                         sessions with message counts and rendered sizes
    extract.py render <session> [lo] [hi]   transcript of messages [lo, hi) to stdout
    extract.py scan <file>...               flag anything that looks like a secret; exit 1 if found

Used to build the distill eval set. Read-only on the Hermes database. Stdlib only. The render functions are
taken from plugins/hive/__init__.py by source (that module imports Hermes, which needn't be installed here),
so a change to the plugin's transcript format is picked up automatically.
"""

from __future__ import annotations

import ast
import json
import os
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

PLUGIN = Path(__file__).resolve().parents[2] / "plugins" / "hive" / "__init__.py"
DB = Path(os.environ.get("HERMES_STATE_DB", Path.home() / ".hermes" / "state.db"))


def _plugin_render():
    """render_transcript and what it needs, compiled from the plugin's source without importing it."""
    tree = ast.parse(PLUGIN.read_text())
    keep: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id.startswith("MAX_") for t in node.targets):
            keep.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in ("_text_of", "render_transcript"):
            keep.append(node)
    ns: dict[str, Any] = {"Any": Any}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(PLUGIN), "exec"), ns)
    return ns["render_transcript"]


render_transcript = _plugin_render()


def _db() -> sqlite3.Connection:
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def messages(session: str, lo: int | None = None, hi: int | None = None) -> list[dict[str, Any]]:
    rows = _db().execute(
        "select role, content, tool_calls, tool_name, tool_call_id from messages where session_id = ? order by id",
        (session,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for role, content, tool_calls, tool_name, tool_call_id in rows[lo:hi]:
        m: dict[str, Any] = {"role": role, "content": content or ""}
        if tool_calls:
            try:
                m["tool_calls"] = json.loads(tool_calls)
            except ValueError:
                pass
        if tool_name:
            m["name"] = tool_name
        if tool_call_id:
            m["tool_call_id"] = tool_call_id
        out.append(m)
    return out


# Shapes of credentials that have appeared in this machine's sessions, plus generic ones.
SECRET_PATTERNS = [
    re.compile(p)
    for p in (
        r"sk-ant-[A-Za-z0-9_-]{20,}",
        r"sk-[A-Za-z0-9]{32,}",
        r"gh[pousr]_[A-Za-z0-9]{30,}",
        r"github_pat_[A-Za-z0-9_]{40,}",
        r"AKIA[0-9A-Z]{16}",
        r"AIza[0-9A-Za-z_-]{35}",
        r"xox[abpr]-[A-Za-z0-9-]{10,}",
        r"re_[A-Za-z0-9]{20,}",
        r"hive_[A-Za-z0-9_-]{30,}",
        r"ya29\.[A-Za-z0-9_-]{20,}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        r"(?i)(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['\"]?[A-Za-z0-9/+_=-]{16,}",
        r"\b[0-9a-f]{64}\b",
    )
]


def scan(text: str) -> list[str]:
    return [m.group(0)[:12] + "…" for p in SECRET_PATTERNS for m in p.finditer(text)]


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in ("list", "render", "scan"):
        print(__doc__, file=sys.stderr)
        return 2
    if argv[0] == "list":
        for sid, source, title, n in _db().execute(
            "select id, source, coalesce(title, ''), message_count from sessions order by started_at"
        ):
            print(f"{sid}\t{source}\t{n}\t{len(render_transcript(messages(sid)))}\t{title[:60]}")
        return 0
    if argv[0] == "render":
        lo = int(argv[2]) if len(argv) > 2 else None
        hi = int(argv[3]) if len(argv) > 3 else None
        sys.stdout.write(render_transcript(messages(argv[1], lo, hi)))
        return 0
    found = 0
    for f in argv[1:]:
        for hit in scan(Path(f).read_text()):
            print(f"{f}: {hit}")
            found += 1
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
