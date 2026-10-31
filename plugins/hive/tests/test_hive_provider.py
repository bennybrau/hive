"""Plugin tests against Hermes' real MemoryProvider code and a recording fake Hive.

Run: scripts/test-plugin.sh   (uses Hermes' interpreter so ``agent.*`` imports resolve)
The real service is exercised end to end by scripts/e2e-plugin.sh.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_PLUGIN_DIR = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("hive_plugin", _PLUGIN_DIR / "__init__.py")
hive = importlib.util.module_from_spec(_spec)
sys.modules["hive_plugin"] = hive
_spec.loader.exec_module(hive)

from agent.memory_provider import MemoryProvider  # noqa: E402

GOOD = "hive_good"
F1 = {"id": "11111111-aaaa-bbbb-cccc-000000000001", "text": "Use vitest, never jest.", "kind": "convention",
      "scope": "global", "status": "active", "similarity": 0.81, "anchors": 0}
F2 = {"id": "22222222-aaaa-bbbb-cccc-000000000002", "text": "Deploys go to Cloud Run.", "kind": "system",
      "scope": "repo:gh/acme/api", "status": "active", "similarity": 0.7, "anchors": 1}
F3 = {"id": "33333333-aaaa-bbbb-cccc-000000000003", "text": "Jon prefers tabs.", "kind": "preference",
      "scope": "personal:jon", "status": "active", "similarity": 0.66, "anchors": 0}


class FakeHive:
    """Records every request; responses can be overridden per path."""

    def __init__(self):
        self.requests: list[dict] = []
        self.facts = [F1, F2, F3]
        self.overrides: dict[str, tuple[int, dict]] = {}
        self.url = ""

    def handle(self, method, path, body, auth):
        u = urllib.parse.urlparse(path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        self.requests.append({"method": method, "path": u.path, "query": q, "body": body})
        if auth != f"Bearer {GOOD}":
            return 401, {"error": "unknown or revoked token"}
        if u.path in self.overrides:
            return self.overrides[u.path]
        if u.path == "/v1/status":
            return 200, {"instance": {"name": "t", "user_id": "jon", "role": "member"}, "counts": {"facts": 3}}
        if u.path == "/v1/recall":
            k = int(q.get("k", 10))
            facts = [f for f in self.facts if f["similarity"] >= float(q.get("min_sim", 0))][:k]
            return 200, {"mode": "hybrid", "facts": facts}
        if u.path == "/v1/search":
            return 200, {"mode": "hybrid", "facts": self.facts[:1], "results": [{"source": "conversation", "id": "e1"}]}
        if u.path == "/v1/facts" and method == "POST":
            status = "active" if body["scope"] == "personal" else "candidate"
            return 201, {"fact": {"id": "44444444-aaaa-bbbb-cccc-000000000004", "status": status,
                                  "scope": body["scope"]}, "deduped": False}
        if u.path.endswith("/retract"):
            return 200, {"fact": {"id": u.path.split("/")[3], "status": "retracted"}}
        if u.path == "/v1/episodes":
            return 201, {"episode": {"id": "e1"}}
        return 404, {"error": "not found"}

    def last(self, path):
        return [r for r in self.requests if r["path"] == path]


@pytest.fixture()
def fake():
    state = FakeHive()

    class H(BaseHTTPRequestHandler):
        def _go(self, method):
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n)) if n else None
            code, payload = state.handle(method, self.path, body, self.headers.get("Authorization"))
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802
            self._go("GET")

        def do_POST(self):  # noqa: N802
            self._go("POST")

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    state.url = f"http://127.0.0.1:{srv.server_address[1]}"
    yield state
    srv.shutdown()


def _provider(monkeypatch, url, token=GOOD, **init):
    monkeypatch.setenv("HIVE_URL", url)
    monkeypatch.setenv("HIVE_TOKEN", token)
    monkeypatch.setenv("HIVE_REPO_KEY", init.pop("repo_key", "gh/acme/api"))
    for k, v in init.pop("env", {}).items():
        monkeypatch.setenv(k, v)
    p = hive.HiveMemoryProvider()
    p.initialize("s1", hermes_home="/tmp", platform="cli", **{"agent_context": "primary", **init})
    return p


def call(p, name, **args):
    return json.loads(p.handle_tool_call(name, args))


# --- wiring ---------------------------------------------------------------------------

def test_is_a_memory_provider_with_all_tools(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    assert isinstance(p, MemoryProvider) and p.name == "hive"
    assert [s["name"] for s in p.get_tool_schemas()] == [
        "hive_recall", "hive_remember", "hive_search", "hive_retract", "hive_status"]


def test_unavailable_without_env(monkeypatch):
    monkeypatch.delenv("HIVE_URL", raising=False)
    monkeypatch.delenv("HIVE_TOKEN", raising=False)
    p = hive.HiveMemoryProvider()
    assert not p.is_available()
    assert "HIVE_URL and HIVE_TOKEN" in p.unavailable_reason()


@pytest.mark.parametrize("url,key", [
    ("git@github.com:bennybrau/hive.git", "gh/bennybrau/hive"),
    ("https://github.com/bennybrau/hive.git", "gh/bennybrau/hive"),
    ("https://github.com/bennybrau/hive", "gh/bennybrau/hive"),
    ("ssh://git@github.com/bennybrau/hive.git", "gh/bennybrau/hive"),
    ("https://gitlab.example.com/team/sub/repo.git", "gitlab.example.com/team/sub/repo"),
    ("", ""),
])
def test_repo_key_from_remote(url, key):
    assert hive.repo_key_from_remote(url) == key


def test_repo_key_detected_from_the_session_cwd(monkeypatch, fake, tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "remote", "add", "origin", "git@github.com:acme/web.git"], check=True)
    monkeypatch.delenv("HIVE_REPO_KEY", raising=False)
    monkeypatch.setenv("HIVE_URL", fake.url)
    monkeypatch.setenv("HIVE_TOKEN", GOOD)
    p = hive.HiveMemoryProvider()
    p.initialize("s1", cwd=str(tmp_path))
    assert p._repo_key == "gh/acme/web"


# --- prefetch -------------------------------------------------------------------------

def _git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True,
                   env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@x", "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"})


def test_changed_paths_from_git_status(tmp_path):
    _git(tmp_path, "init", "-q")
    (tmp_path / "a.py").write_text("1")
    (tmp_path / "old name.md").write_text("x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "keep.ts").write_text("k")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "init")
    (tmp_path / "a.py").write_text("2")                                  # modified
    _git(tmp_path, "mv", "old name.md", "new name.md")                   # renamed (spaces survive -z)
    (tmp_path / "sub" / "new.ts").write_text("n")                        # untracked
    assert sorted(hive.changed_paths(str(tmp_path / "sub"))) == ["a.py", "new name.md", "sub/new.ts"]
    assert hive.changed_paths(str(tmp_path.parent / "definitely-not-here")) == []
    assert hive.changed_paths("") == []


def test_prefetch_and_recall_send_changed_files_so_located_facts_rank_higher(monkeypatch, fake, tmp_path):
    _git(tmp_path, "init", "-q")
    (tmp_path / "x.ts").write_text("1")
    p = _provider(monkeypatch, fake.url, cwd=str(tmp_path))
    p.prefetch("anything")
    call(p, "hive_recall", query="anything")
    assert [r["query"].get("changed") for r in fake.last("/v1/recall")] == ["x.ts", "x.ts"]
    # clean tree, or not in a repo: no parameter at all
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "c")
    p.prefetch("again")
    assert "changed" not in fake.last("/v1/recall")[-1]["query"]


def test_prefetch_flags_facts_whose_source_changed(monkeypatch, fake):
    fake.facts = [{**F1, "verify": "drifted"}, {**F2, "verify": "missing"}, {**F3, "verify": "verified"}]
    block = _provider(monkeypatch, fake.url).prefetch("q")
    assert "Use vitest, never jest. (global, convention, source changed since)" in block
    assert "Deploys go to Cloud Run. (repo:gh/acme/api, system, source gone)" in block
    assert "Jon prefers tabs. (personal, preference)" in block

def test_prefetch_sends_gate_and_repo_and_formats_a_short_cited_block(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    block = p.prefetch("which test runner?")
    req = fake.last("/v1/recall")[0]["query"]
    assert req["q"] == "which test runner?"
    assert req["repo_key"] == "gh/acme/api"
    assert float(req["min_sim"]) == hive.DEFAULT_PREFETCH_MIN_SIM
    assert int(req["k"]) == hive.DEFAULT_PREFETCH_K
    assert block.splitlines()[0].startswith("## Hive")
    assert "- [hive:11111111] Use vitest, never jest. (global, convention)" in block
    assert "(personal, preference)" in block  # personal scope shown without the user id
    assert p.recall_status().count == 3


def test_prefetch_never_reinjects_a_fact_in_the_same_session(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    assert "vitest" in p.prefetch("tests?")
    assert p.prefetch("tests again?") == ""  # all three already in context
    assert p.recall_status() is None  # the indicator reflects only the LAST prefetch
    # asks deeper so already-injected facts don't starve the new turn
    assert int(fake.last("/v1/recall")[1]["query"]["k"]) == hive.DEFAULT_PREFETCH_K + 3


def test_prefetch_reinjects_after_reset_and_inherits_on_branch(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    p.prefetch("tests?")
    p.on_session_switch("s2", parent_session_id="s1")  # /branch or compression: context carried over
    assert p.prefetch("tests?", session_id="s2") == ""
    p.on_session_switch("s2", reset=True)  # /new
    assert "vitest" in p.prefetch("tests?", session_id="s2")


def test_prefetch_respects_k_and_min_sim_env(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url, env={"HIVE_PREFETCH_K": "1", "HIVE_PREFETCH_MIN_SIM": "0.75"})
    block = p.prefetch("anything")
    assert block.count("\n- [hive:") == 1 and "vitest" in block
    assert float(fake.last("/v1/recall")[0]["query"]["min_sim"]) == 0.75


def test_prefetch_disabled_with_k_zero(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url, env={"HIVE_PREFETCH_K": "0"})
    assert p.prefetch("anything") == ""
    assert fake.last("/v1/recall") == []


def test_prefetch_is_silent_when_hive_is_down(monkeypatch):
    p = _provider(monkeypatch, "http://127.0.0.1:9")  # nothing listens on port 9
    assert p.prefetch("anything") == ""
    assert p.recall_status() is None


def test_indicator_clears_when_a_later_prefetch_fails(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    p.prefetch("tests?")
    assert p.recall_status().count == 3
    p._client = hive.HiveClient("http://127.0.0.1:9", GOOD)  # hive goes away mid-session
    assert p.prefetch("deploys?") == ""
    assert p.recall_status() is None


def test_prefetch_nothing_relevant_injects_nothing(monkeypatch, fake):
    fake.facts = []
    p = _provider(monkeypatch, fake.url)
    assert p.prefetch("best pizza in chicago") == ""


# --- writes ---------------------------------------------------------------------------

def test_sync_turn_posts_an_episode(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    p.sync_turn("how do we deploy?", "Cloud Run.", session_id="s1", turn_author={"name": "Jon"})
    body = fake.last("/v1/episodes")[0]["body"]
    assert body == {"kind": "turn", "session_id": "s1", "content": "user: how do we deploy?\nassistant: Cloud Run.",
                    "repo_key": "gh/acme/api", "metadata": {"author": "Jon"}}


@pytest.mark.parametrize("ctx", ["subagent", "cron", "flush"])
def test_no_writes_outside_primary_context(monkeypatch, fake, ctx):
    p = _provider(monkeypatch, fake.url, agent_context=ctx)
    p.sync_turn("q", "a")
    p.on_session_end([{"role": "user", "content": "hi"}])
    assert fake.last("/v1/episodes") == []
    assert "vitest" in p.prefetch("tests?")  # reads still work


def test_hive_sync_off_stops_writes(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url, env={"HIVE_SYNC": "off"})
    p.sync_turn("q", "a")
    assert fake.last("/v1/episodes") == []


def test_session_end_posts_a_readable_transcript_with_clipped_tool_output(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    msgs = [
        {"role": "system", "content": "SYSTEM PROMPT"},
        {"role": "user", "content": "list the repo"},
        {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "terminal", "arguments": "{\"command\":\"ls\"}"}}]},
        {"role": "tool", "name": "terminal", "content": "x" * 5000},
        {"role": "assistant", "content": [{"type": "text", "text": "Done."}]},
    ]
    p.on_session_end(msgs)
    body = fake.last("/v1/episodes")[0]["body"]
    assert body["kind"] == "session" and body["metadata"] == {"messages": 5}
    t = body["content"]
    assert "SYSTEM PROMPT" not in t
    assert t.startswith("user: list the repo\nassistant -> terminal(")
    assert "[3500 chars clipped]" in t and len(t) < 2000
    assert t.endswith("assistant: Done.")


# --- tools ----------------------------------------------------------------------------

def test_recall_tool_returns_slim_facts_with_full_ids_and_no_gate(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    out = call(p, "hive_recall", query="tests")
    assert out["ok"] and out["facts"][0] == {k: F1[k] for k in ("id", "text", "kind", "scope", "status", "similarity")}
    assert "min_sim" not in fake.last("/v1/recall")[0]["query"]  # explicit lookups aren't gated


def test_remember_defaults_to_repo_scope_with_provenance(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    out = call(p, "hive_remember", text="Migrations are append-only.", kind="invariant",
               path="apps/hive/migrations/README.md", quote="never edit a shipped migration")
    body = fake.last("/v1/facts")[0]["body"]
    assert body == {"text": "Migrations are append-only.", "kind": "invariant", "scope": "repo", "repo_key": "gh/acme/api",
                    "anchors": [{"path": "apps/hive/migrations/README.md", "quote": "never edit a shipped migration",
                                 "repo_key": "gh/acme/api"}],
                    "locus": ["apps/hive/migrations/README.md"]}
    assert out["status"] == "candidate" and "curator" in out["note"]


def test_remember_outside_a_repo_defaults_to_global_and_refuses_repo_scope(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url, repo_key="", cwd="/")
    assert p._repo_key == ""
    out = call(p, "hive_remember", text="x is y", kind="system", scope="repo")
    assert not out["ok"] and "no repository" in out["error"]
    assert fake.last("/v1/facts") == []
    call(p, "hive_remember", text="x is y", kind="system")
    assert fake.last("/v1/facts")[0]["body"]["scope"] == "global"


def test_remember_surfaces_server_validation_errors(monkeypatch, fake):
    fake.overrides["/v1/facts"] = (400, {"error": "body/kind must be equal to one of the allowed values"})
    p = _provider(monkeypatch, fake.url)
    out = call(p, "hive_remember", text="x is y", kind="todo")
    assert out == {"ok": False, "status": 400, "error": "body/kind must be equal to one of the allowed values"}


def test_retract_needs_a_full_id(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    assert not call(p, "hive_retract", id="11111111", reason="wrong")["ok"]
    out = call(p, "hive_retract", id=F1["id"], reason="wrong")
    assert out == {"ok": True, "id": F1["id"], "status": "retracted"}
    assert fake.last(f"/v1/facts/{F1['id']}/retract")[0]["body"] == {"reason": "wrong"}


def test_search_hits_are_slim_and_say_where(monkeypatch, fake):
    fake.overrides["/v1/search"] = (200, {"mode": "hybrid", "facts": [], "results": [
        {"source": "doc", "id": "c1", "repo_key": "gh/acme/api", "path": "docs/plan.md", "line_start": 205,
         "line_end": 222, "snippet": "A <b>gate</b> has a mode", "score": 0.03, "matched": ["keyword"], "similarity": 0.7},
        {"source": "commit", "id": "e9", "repo_key": "gh/acme/api", "ref": "6ed3680b32fc1a4ad8093f", "snippet": "fix <b>gate</b>"},
        {"source": "conversation", "id": "e1", "snippet": "we talked"},
    ]})
    r = call(_provider(monkeypatch, fake.url), "hive_search", query="gate", source="doc,commit")
    assert r["results"] == [
        {"source": "doc", "where": "docs/plan.md:205-222", "repo": "gh/acme/api", "snippet": "A gate has a mode"},
        {"source": "commit", "where": "commit 6ed3680b32", "repo": "gh/acme/api", "snippet": "fix gate"},
        {"source": "conversation", "id": "e1", "snippet": "we talked"},
    ]
    assert fake.last("/v1/search")[0]["query"]["source"] == "doc,commit"


def test_search_and_status_tools(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    assert call(p, "hive_search", query="deploy")["results"][0]["source"] == "conversation"
    st = call(p, "hive_status")
    assert st["ok"] and st["repo_key"] == "gh/acme/api" and st["instance"]["user_id"] == "jon"


def test_bad_token_unreachable_and_unknown_tool(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url, token="nope")
    assert call(p, "hive_status") == {"ok": False, "status": 401, "error": "unknown or revoked token"}
    assert "unknown hive tool" in call(p, "hive_bogus")["error"]
    down = _provider(monkeypatch, "http://127.0.0.1:9")
    assert "cannot reach hive" in call(down, "hive_status")["error"]
