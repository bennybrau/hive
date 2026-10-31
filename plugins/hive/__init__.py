"""Hive memory provider for Hermes.

Connects this Hermes instance to a shared Hive service (one per team, see the repo README).

What it does each turn:
  * prefetch   - before the model sees the message: GET /v1/recall with a strict relevance gate,
                 inject at most HIVE_PREFETCH_K facts as a short cited list. Hermes replays the
                 injected block on EVERY later request of the session, so each line costs tokens
                 for the rest of the conversation: facts already injected in this session are
                 never injected again, and nothing is injected when nothing clears the gate.
  * sync_turn  - after the reply: POST the turn to /v1/episodes (Hermes already runs this on its
                 background worker and has redacted secrets).
  * session end- POST the whole transcript as a `session` episode (input for M4 distill).
Tools: hive_recall, hive_remember, hive_search, hive_retract, hive_status; hive_review for curators only.

Config (env, via `hermes memory setup` or the profile's .env):
  HIVE_URL               e.g. http://studio.local:8800                     (required)
  HIVE_TOKEN             instance token minted by the hive                  (required, secret)
  HIVE_REPO_KEY          override the repo detected from `git remote get-url origin`
  HIVE_PREFETCH_K        max facts injected per turn (default 5; 0 disables prefetch)
  HIVE_PREFETCH_MIN_SIM  cosine floor for injected facts (default 0.62)
  HIVE_SYNC              "off" to stop sending turns/sessions (recall + tools still work)
Stdlib only: no new dependencies for Hermes.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

from agent.memory_provider import MemoryProvider, RecallStatus
from agent.secret_scope import get_secret

logger = logging.getLogger(__name__)

PREFETCH_TIMEOUT_S = 2.0
WRITE_TIMEOUT_S = 10.0
DEFAULT_PREFETCH_K = 5
DEFAULT_PREFETCH_MIN_SIM = 0.62
FACT_KINDS = ["decision", "invariant", "gotcha", "preference", "convention", "system"]
MAX_TOOL_OUTPUT_CHARS = 1500  # per tool result inside a session transcript
MAX_SESSION_CHARS = 3_500_000  # service limit is 4M
REVIEW_QUEUE_LIMIT = 20
FULL_ID = re.compile(r"[0-9a-fA-F-]{36}")


# --------------------------------------------------------------------------- helpers

def repo_key_from_remote(url: str) -> str:
    """git remote URL -> hive repo key. github.com/<o>/<r> -> gh/<o>/<r>; other hosts -> <host>/<path>."""
    url = url.strip()
    if not url:
        return ""
    m = re.match(r"^(?:[\w.-]+@)?([\w.-]+):(?!//)(.+)$", url)  # scp-like: git@github.com:owner/repo.git
    if m:
        host, path = m.group(1), m.group(2)
    else:
        parsed = urllib.parse.urlparse(url)
        host, path = parsed.hostname or "", parsed.path
    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if not host or not path:
        return ""
    return f"gh/{path}" if host.lower() == "github.com" else f"{host.lower()}/{path}"


def detect_repo_key(cwd: str) -> str:
    try:
        out = subprocess.run(["git", "-C", cwd, "remote", "get-url", "origin"],
                             capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return ""
    return repo_key_from_remote(out.stdout) if out.returncode == 0 else ""


MAX_CHANGED_PATHS = 200


def changed_paths(cwd: str) -> list[str]:
    """Files you're working on (`git status`), repo-relative. The hive ranks facts located there higher.
    Renames report the new path. Empty outside a repo or if git is slow."""
    if not cwd:
        return []
    try:
        out = subprocess.run(["git", "-C", cwd, "status", "--porcelain", "-z", "--untracked-files=normal"],
                             capture_output=True, text=True, timeout=1)
    except (OSError, subprocess.SubprocessError):
        return []
    if out.returncode != 0:
        return []
    paths: list[str] = []
    entries = out.stdout.split("\0")
    i = 0
    while i < len(entries):
        e = entries[i]
        i += 1
        if len(e) < 4:
            continue
        paths.append(e[3:])
        if e[0] in "RC":  # rename/copy: the next entry is the old path
            i += 1
    return paths[:MAX_CHANGED_PATHS]


def _text_of(content: Any) -> str:
    """OpenAI-style message content (str or list of parts) -> plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(p.get("text", "")) for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def render_transcript(messages: list[dict[str, Any]]) -> str:
    """Readable transcript for a `session` episode. Tool results are clipped: they're bulky and the
    distiller needs the decisions, not every byte of a file listing."""
    lines: list[str] = []
    for m in messages or []:
        role = m.get("role", "")
        if role == "system":
            continue
        text = _text_of(m.get("content")).strip()
        if role == "tool":
            if len(text) > MAX_TOOL_OUTPUT_CHARS:
                text = text[:MAX_TOOL_OUTPUT_CHARS] + f" …[{len(text) - MAX_TOOL_OUTPUT_CHARS} chars clipped]"
            lines.append(f"tool({m.get('name') or m.get('tool_call_id') or ''}): {text}")
            continue
        for call in m.get("tool_calls") or []:
            fn = (call or {}).get("function") or {}
            lines.append(f"{role} -> {fn.get('name', '?')}({str(fn.get('arguments', ''))[:300]})")
        if text:
            lines.append(f"{role}: {text}")
    out = "\n".join(lines)
    return out[:MAX_SESSION_CHARS]


def format_facts(facts: list[dict[str, Any]]) -> str:
    """The injected block. One line per fact, short id to cite. Keep it tiny: it is replayed every turn."""
    if not facts:
        return ""
    lines = ["## Hive (shared team memory) - cite a fact you use as [hive:<id>]"]
    for f in facts:
        scope = f.get("scope", "")
        label = "personal" if scope.startswith("personal:") else scope
        note = {"drifted": ", source changed since", "missing": ", source gone"}.get(str(f.get("verify") or ""), "")
        lines.append(f"- [hive:{str(f.get('id', ''))[:8]}] {f.get('text', '').strip()} ({label}, {f.get('kind', '')}{note})")
    return "\n".join(lines)


class HiveClient:
    """Minimal JSON-over-HTTP client. Never raises; failures come back as {"ok": False, "error": ...}."""

    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(self, method: str, path: str, body: Optional[dict[str, Any]] = None,
                timeout: float = WRITE_TIMEOUT_S) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8") or "{}")
                payload.setdefault("ok", True)
                return payload
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(raw)
            except ValueError:
                detail = {"error": raw[:200]}
            detail.pop("ok", None)
            return {"ok": False, "status": exc.code, **detail}
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            return {"ok": False, "error": f"cannot reach hive at {self.base_url}: {reason}"}

    def get(self, path: str, params: Optional[dict[str, Any]] = None, timeout: float = WRITE_TIMEOUT_S) -> dict[str, Any]:
        qs = "?" + urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v not in (None, "")}) if params else ""
        return self.request("GET", path + qs, timeout=timeout)

    def post(self, path: str, body: dict[str, Any], timeout: float = WRITE_TIMEOUT_S) -> dict[str, Any]:
        return self.request("POST", path, body, timeout=timeout)


# --------------------------------------------------------------------------- tool schemas

_SCHEMAS = [
    {
        "name": "hive_recall",
        "description": "Look up the team's shared memory (Hive) for facts relevant to a question: decisions, "
                       "conventions, gotchas, who owns what. Use before re-deriving something the team may "
                       "already know. Returns active facts with ids; cite as [hive:<id8>]. Facts only: for "
                       "the repo's own docs and commit history use hive_search.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural-language question or keywords."},
                "k": {"type": "integer", "description": "Max facts (default 10)."},
                "repo_key": {"type": "string", "description": "Limit repo facts to this repo (default: current repo, if any)."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "hive_remember",
        "description": "Save a durable fact to the team's shared memory. Only for things still true and useful "
                       "weeks from now that aren't obvious from the code or README: decisions and why, invariants, "
                       "gotchas, ownership, conventions. Not for task progress or to-dos. Shared facts (global/repo) "
                       "from non-curators wait for curator review; personal facts are visible only to this user.",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "One self-contained statement."},
                "kind": {"type": "string", "enum": FACT_KINDS},
                "scope": {"type": "string", "enum": ["repo", "global", "personal"],
                          "description": "repo = this repository (default when in one); global = applies everywhere; personal = only you."},
                "repo_key": {"type": "string", "description": "Override the detected repo for scope=repo."},
                "path": {"type": "string", "description": "Source file this fact is about (provenance)."},
                "quote": {"type": "string", "description": "Exact text from that file or conversation that supports it."},
                "supersedes": {"type": "string", "description": "When correcting a fact you were shown, pass its full id as supersedes."},
            },
            "required": ["text", "kind"],
        },
    },
    {
        "name": "hive_search",
        "description": "Search the Hive by keyword or meaning across facts, your past conversations and session "
                       "history, and the indexed docs (README, docs/: Markdown, PDF, Word, PowerPoint, Excel) and "
                       "commit messages of registered repos. Doc hits give path and line range: cite as path:line. "
                       "Use it when facts don't answer and before reading files yourself.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "source": {"type": "string", "description": "all (default) or a comma list of fact,conversation,history,commit,doc"},
                "k": {"type": "integer", "description": "Max results per list (default 10)."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "hive_retract",
        "description": "Mark a Hive fact as wrong (kept as history). Only its author or a curator can. Needs the full id from hive_recall.",
        "parameters": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "reason": {"type": "string"}},
            "required": ["id", "reason"],
        },
    },
    {
        "name": "hive_status",
        "description": "Check the connection to the team's shared Hive memory: who this instance is, counts, embedding health.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
]

# Offered only to curators (see HiveMemoryProvider._is_curator); the server answers 403 to anyone else.
_REVIEW_SCHEMA = {
    "name": "hive_review",
    "description": "Curator only: review candidate facts waiting for approval before other assistants see them. "
                   "action=list shows the queue (oldest first) with each candidate's full id, the fact it would "
                   "supersede and similar active facts. approve / fix (with new_text) / reject need the full id.",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["list", "approve", "fix", "reject"]},
            "id": {"type": "string", "description": "Full candidate id (36 chars) from action=list."},
            "note": {"type": "string", "description": "Why (recorded with the decision)."},
            "new_text": {"type": "string", "description": "action=fix: the corrected statement."},
        },
        "required": ["action"],
    },
}


# --------------------------------------------------------------------------- provider

class HiveMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._client: Optional[HiveClient] = None
        self._session_id = ""
        self._agent_context = "primary"
        self._repo_key = ""
        self._cwd = ""
        self._prefetch_k = DEFAULT_PREFETCH_K
        self._prefetch_min_sim = DEFAULT_PREFETCH_MIN_SIM
        self._sync = True
        self._lock = threading.Lock()
        self._injected: dict[str, set[str]] = {}  # session_id -> fact ids already injected
        self._last_count: Optional[int] = None
        self._curator: Optional[bool] = None  # cached after the first successful /v1/status

    @property
    def name(self) -> str:
        return "hive"

    # -- lifecycle ----------------------------------------------------------------

    def is_available(self) -> bool:
        return bool(get_secret("HIVE_URL") and get_secret("HIVE_TOKEN"))

    def unavailable_reason(self) -> str:
        missing = [k for k in ("HIVE_URL", "HIVE_TOKEN") if not get_secret(k)]
        return f"set {' and '.join(missing)} (run `hermes memory setup`; the token comes from the hive's setup.sh or mint-token)"

    def initialize(self, session_id: str, **kwargs) -> None:
        self._client = HiveClient(get_secret("HIVE_URL", "") or "", get_secret("HIVE_TOKEN", "") or "")
        self._curator = None
        self._session_id = session_id
        self._agent_context = kwargs.get("agent_context") or "primary"
        cwd = kwargs.get("cwd") or os.getcwd()
        self._cwd = str(cwd or "")
        self._repo_key = (get_secret("HIVE_REPO_KEY", "") or "").strip() or detect_repo_key(self._cwd)
        self._prefetch_k = _int_env("HIVE_PREFETCH_K", DEFAULT_PREFETCH_K)
        self._prefetch_min_sim = _float_env("HIVE_PREFETCH_MIN_SIM", DEFAULT_PREFETCH_MIN_SIM)
        self._sync = (get_secret("HIVE_SYNC", "") or "").strip().lower() not in ("off", "0", "false", "no")

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False,
                          rewound: bool = False, **kwargs) -> None:
        with self._lock:
            if reset or rewound:
                # New conversation, or the transcript that held earlier injections was cut: re-allow them.
                self._injected.pop(new_session_id, None)
            elif parent_session_id and parent_session_id in self._injected:
                # /branch, compression: the child still carries the parent's injected context.
                self._injected[new_session_id] = set(self._injected[parent_session_id])
        self._session_id = new_session_id

    def shutdown(self) -> None:
        self._client = None

    def get_config_schema(self) -> list[dict[str, Any]]:
        return [
            {"key": "url", "description": "Hive URL, e.g. http://studio.local:8800", "required": True, "env_var": "HIVE_URL"},
            {"key": "token", "description": "Instance token from the hive (setup.sh / mint-token)", "secret": True,
             "required": True, "env_var": "HIVE_TOKEN"},
        ]

    def system_prompt_block(self) -> str:
        return ("# Hive (shared team memory)\n"
                "Relevant team facts appear in recalled context as [hive:<id>]; cite the id when you rely on one. "
                "Use hive_recall before re-deriving team knowledge. Use hive_remember only for durable decisions, "
                "invariants, gotchas and conventions worth knowing weeks from now.")

    def _writes_allowed(self) -> bool:
        return self._agent_context == "primary" and self._sync and self._client is not None

    # -- hot path ---------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        self._last_count = None
        if not self._client or self._prefetch_k <= 0 or not (query or "").strip():
            return ""
        sid = session_id or self._session_id
        with self._lock:
            seen = set(self._injected.get(sid, ()))
        # Ask for extra so already-injected facts don't starve the turn.
        res = self._client.get("/v1/recall", {
            "q": query[:2000], "repo_key": self._repo_key or None,
            "k": min(50, self._prefetch_k + len(seen)), "min_sim": self._prefetch_min_sim,
            "changed": self._changed(),
        }, timeout=PREFETCH_TIMEOUT_S)
        if not res.get("ok"):
            logger.debug("hive prefetch failed: %s", res.get("error"))
            return ""
        fresh = [f for f in res.get("facts", []) if f.get("id") not in seen][: self._prefetch_k]
        with self._lock:
            self._injected.setdefault(sid, set()).update(f["id"] for f in fresh)
        self._last_count = len(fresh)
        return format_facts(fresh)

    def _changed(self) -> Optional[str]:
        if not self._repo_key:
            return None
        return ",".join(changed_paths(self._cwd)) or None

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Nothing to warm: recall is ~30 ms, so prefetch() asks with the CURRENT message instead of the last one."""

    def recall_status(self) -> Optional[RecallStatus]:
        if not self._last_count:
            return None
        return RecallStatus(provider_label="Hive", count=self._last_count)

    # -- writes -----------------------------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "",
                  messages: Optional[list[dict[str, Any]]] = None, turn_author: Optional[dict[str, Any]] = None) -> None:
        if not self._writes_allowed() or not (user_content or "").strip():
            return
        content = f"user: {user_content}\nassistant: {assistant_content or ''}"
        meta: dict[str, Any] = {}
        if turn_author and turn_author.get("name"):
            meta["author"] = turn_author.get("name")
        res = self._client.post("/v1/episodes", {  # type: ignore[union-attr]
            "kind": "turn", "session_id": session_id or self._session_id, "content": content,
            **({"repo_key": self._repo_key} if self._repo_key else {}), "metadata": meta,
        })
        if not res.get("ok"):
            logger.warning("hive: turn not recorded: %s", res.get("error"))

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:
        if not self._writes_allowed():
            return
        transcript = render_transcript(messages)
        if not transcript.strip():
            return
        res = self._client.post("/v1/episodes", {  # type: ignore[union-attr]
            "kind": "session", "session_id": self._session_id, "content": transcript,
            **({"repo_key": self._repo_key} if self._repo_key else {}),
            "metadata": {"messages": len(messages or [])},
        }, timeout=30.0)
        if not res.get("ok"):
            logger.warning("hive: session not recorded: %s", res.get("error"))

    # -- tools --------------------------------------------------------------------

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return list(_SCHEMAS) + ([_REVIEW_SCHEMA] if self._is_curator() else [])

    def _is_curator(self) -> bool:
        """Whether this instance's token is a curator's. Errors count as "not curator" and aren't cached."""
        if self._curator is not None:
            return self._curator
        if self._client is None:
            return False
        res = self._client.get("/v1/status", timeout=PREFETCH_TIMEOUT_S)
        if not res.get("ok"):
            return False
        self._curator = (res.get("instance") or {}).get("role") == "curator"
        return self._curator

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs) -> str:
        if self._client is None:
            return json.dumps({"ok": False, "error": "hive provider not initialized"})
        handler = {
            "hive_recall": self._tool_recall, "hive_remember": self._tool_remember, "hive_search": self._tool_search,
            "hive_retract": self._tool_retract, "hive_status": self._tool_status, "hive_review": self._tool_review,
        }.get(tool_name)
        if handler is None:
            return json.dumps({"ok": False, "error": f"unknown hive tool {tool_name}"})
        return json.dumps(handler(args or {}))

    def _tool_status(self, _args: dict[str, Any]) -> dict[str, Any]:
        res = self._client.get("/v1/status")  # type: ignore[union-attr]
        if res.get("ok"):
            res["repo_key"] = self._repo_key or None
        return res

    def _tool_recall(self, args: dict[str, Any]) -> dict[str, Any]:
        res = self._client.get("/v1/recall", {  # type: ignore[union-attr]
            "q": str(args.get("query", ""))[:2000], "k": int(args.get("k") or 10),
            "repo_key": args.get("repo_key") or self._repo_key or None,
            "changed": self._changed(),
        })
        if not res.get("ok"):
            return res
        return {"ok": True, "mode": res.get("mode"), "facts": [_slim_fact(f) for f in res.get("facts", [])]}

    def _tool_search(self, args: dict[str, Any]) -> dict[str, Any]:
        res = self._client.get("/v1/search", {  # type: ignore[union-attr]
            "q": str(args.get("query", ""))[:2000], "source": args.get("source") or "all",
            "k": int(args.get("k") or 10), "repo_key": self._repo_key or None,
        })
        if not res.get("ok"):
            return res
        return {"ok": True, "mode": res.get("mode"), "facts": [_slim_fact(f) for f in res.get("facts", [])],
                "results": [_slim_hit(h) for h in res.get("results", [])]}

    def _tool_remember(self, args: dict[str, Any]) -> dict[str, Any]:
        scope = args.get("scope") or ("repo" if self._repo_key else "global")
        body: dict[str, Any] = {"text": args.get("text", ""), "kind": args.get("kind", ""), "scope": scope}
        repo_key = args.get("repo_key") or self._repo_key
        if scope == "repo":
            if not repo_key:
                return {"ok": False, "error": "scope=repo but no repository detected; pass repo_key or use scope=global"}
            body["repo_key"] = repo_key
        if args.get("path") or args.get("quote"):
            anchor = {k: args[k] for k in ("path", "quote") if args.get(k)}
            if repo_key:
                anchor["repo_key"] = repo_key
            body["anchors"] = [anchor]
            if args.get("path"):
                body["locus"] = [args["path"]]
        if args.get("supersedes"):
            sup = str(args["supersedes"]).strip()
            if not FULL_ID.fullmatch(sup):
                return {"ok": False, "error": "supersedes needs the full fact id (36 chars) - get it from hive_recall"}
            body["supersedes"] = sup
        res = self._client.post("/v1/facts", body)  # type: ignore[union-attr]
        if not res.get("ok"):
            return res
        fact = res.get("fact") or {}
        note = {"candidate": "saved as a candidate; the curator must approve it before other assistants see it",
                "active": "saved and active"}.get(fact.get("status", ""), fact.get("status", ""))
        if res.get("deduped"):
            note = f"already known ({fact.get('status')}); nothing new saved"
        return {"ok": True, "id": fact.get("id"), "status": fact.get("status"), "scope": fact.get("scope"), "note": note}

    def _tool_retract(self, args: dict[str, Any]) -> dict[str, Any]:
        fid = str(args.get("id", "")).strip()
        if not FULL_ID.fullmatch(fid):
            return {"ok": False, "error": "need the full fact id (36 chars) - get it from hive_recall"}
        res = self._client.post(f"/v1/facts/{fid}/retract", {"reason": args.get("reason", "")})  # type: ignore[union-attr]
        if not res.get("ok"):
            return res
        return {"ok": True, "id": fid, "status": (res.get("fact") or {}).get("status")}

    def _tool_review(self, args: dict[str, Any]) -> dict[str, Any]:
        if not self._is_curator():
            return {"ok": False, "error": "only a curator can review facts"}
        action = str(args.get("action", "")).strip()
        if action == "list":
            res = self._client.get("/v1/review/queue", {"limit": REVIEW_QUEUE_LIMIT})  # type: ignore[union-attr]
            if not res.get("ok"):
                return res
            return {"ok": True, "candidates": [_slim_candidate(c) for c in res.get("candidates", [])]}
        if action not in ("approve", "fix", "reject"):
            return {"ok": False, "error": "action must be list, approve, fix or reject"}
        fid = str(args.get("id", "")).strip()
        if not FULL_ID.fullmatch(fid):
            return {"ok": False, "error": "need the full candidate id (36 chars) - get it from hive_review action=list"}
        body: dict[str, Any] = {"action": action}
        if action == "fix":
            new_text = str(args.get("new_text") or "").strip()
            if not new_text:
                return {"ok": False, "error": "fix needs new_text"}
            body["new_text"] = new_text
        if args.get("note"):
            body["note"] = str(args["note"])
        res = self._client.post(f"/v1/facts/{fid}/review", body)  # type: ignore[union-attr]
        if not res.get("ok"):
            return res
        out = {"ok": True, "id": fid, "status": (res.get("fact") or {}).get("status")}
        if res.get("merged_into"):
            out["merged_into"] = res["merged_into"].get("id")
        return out


def _slim_fact(f: dict[str, Any]) -> dict[str, Any]:
    """What the model needs from a fact, nothing more (tool output is tokens too)."""
    return {k: f.get(k) for k in ("id", "text", "kind", "scope", "status", "similarity", "verify", "near_changes")
            if f.get(k) is not None}


def _slim_candidate(c: dict[str, Any]) -> dict[str, Any]:
    """A review-queue candidate without anchors or snippets: the full id to act on, id8 to cite."""
    fid = str(c.get("id", ""))
    sup = c.get("supersedes")
    return {"id": fid, "id8": fid[:8], "text": c.get("text"), "kind": c.get("kind"), "scope": c.get("scope"),
            "supersedes": str(sup)[:8] if sup else None,
            "similar": [f"[{str(s.get('id', ''))[:8]}] {s.get('text', '')} ({float(s.get('similarity') or 0):.2f})"
                        for s in c.get("similar") or []]}


def _slim_hit(h: dict[str, Any]) -> dict[str, Any]:
    """A search hit as the model needs it: where (doc path:lines, commit sha, or episode id) and the snippet,
    without highlight markup or ranking internals."""
    out: dict[str, Any] = {"source": h.get("source")}
    if h.get("path"):
        lines = f":{h['line_start']}-{h['line_end']}" if h.get("line_start") else ""
        out["where"] = f"{h['path']}{lines}"
    elif h.get("ref"):
        out["where"] = f"commit {str(h['ref'])[:10]}"
    else:
        out["id"] = h.get("id")
    if h.get("repo_key"):
        out["repo"] = h["repo_key"]
    out["snippet"] = re.sub(r"</?b>", "", str(h.get("snippet", "")))
    return out


def _int_env(key: str, default: int) -> int:
    try:
        return int((get_secret(key, "") or "").strip() or default)
    except ValueError:
        return default


def _float_env(key: str, default: float) -> float:
    try:
        return float((get_secret(key, "") or "").strip() or default)
    except ValueError:
        return default


def register(ctx) -> None:
    """Register the Hive as a memory provider plugin."""
    ctx.register_memory_provider(HiveMemoryProvider())
