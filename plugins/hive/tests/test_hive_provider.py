"""Plugin tests against Hermes' real MemoryProvider code and a recording fake Hive.

Run: scripts/test-plugin.sh   (uses Hermes' interpreter so ``agent.*`` imports resolve)
The real service is exercised end to end by scripts/e2e-plugin.sh.
"""
from __future__ import annotations

import importlib.util
import json
import socketserver
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
        self.role = "member"
        self.queue: list[dict] = []
        self.flagged: list[dict] = []
        self.brief: dict | None = None  # None: /v1/brief answers 404, like a hive without it (prefetch uses recall)

    def handle(self, method, path, body, auth):
        u = urllib.parse.urlparse(path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        self.requests.append({"method": method, "path": u.path, "query": q, "body": body})
        if auth != f"Bearer {GOOD}":
            return 401, {"error": "unknown or revoked token"}
        if u.path in self.overrides:
            return self.overrides[u.path]
        if u.path == "/v1/status":
            return 200, {"instance": {"name": "t", "user_id": "jon", "role": self.role}, "counts": {"facts": 3}}
        if u.path == "/v1/review/queue":
            if self.role != "curator":
                return 403, {"error": "only a curator can review facts"}
            return 200, {"candidates": self.queue[: int(q.get("limit", 20))], "flagged": self.flagged}
        if u.path.endswith("/review") and method == "POST":
            if self.role != "curator":
                return 403, {"error": "only a curator can review facts"}
            status = {"approve": "active", "fix": "active", "reject": "retracted"}[body["action"]]
            return 200, {"fact": {"id": u.path.split("/")[3], "status": status}, "merged_into": None}
        if u.path == "/v1/recall":
            k = int(q.get("k", 10))
            facts = [f for f in self.facts if f["similarity"] >= float(q.get("min_sim", 0))][:k]
            return 200, {"mode": "hybrid", "facts": facts}
        if u.path == "/v1/brief" and method == "POST" and self.brief is not None:
            return 200, self.brief
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


class _LoopbackServer(ThreadingHTTPServer):
    """HTTPServer.server_bind does a reverse-DNS lookup (socket.getfqdn) of the bind address. On some hosts
    (macOS + uv's standalone Python) that takes ~35 s. Loopback-only test server: skip it."""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "127.0.0.1", self.server_address[1]


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

    srv = _LoopbackServer(("127.0.0.1", 0), H)
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


# --- brief ----------------------------------------------------------------------------

G1 = {"id": "77777777-aaaa-bbbb-cccc-000000000007", "text": "Never edit a shipped migration.", "kind": "gotcha",
      "scope": "repo:gh/acme/api", "locus": ["migrations/"]}
BRIEF = {
    "repo_key": "gh/acme/api", "repo_indexed": True, "mode": "hybrid", "terms": [], "budget_tokens": 600,
    "tokens": {"gotchas": 30, "facts": 40, "locations": 20, "runs": 25, "tests": 10, "total": 125},
    "dropped": {"gotchas": 0, "facts": 0, "locations": 0, "runs": 0, "tests": 0},
    "gotchas": [G1],
    "facts": [{k: F1[k] for k in ("id", "text", "kind", "scope")}],
    "locations": [{"ref": "docs/deploy.md:10-24", "path": "docs/deploy.md", "source": "doc"},
                  {"ref": "src/db.ts", "path": "src/db.ts", "source": "path"}],
    "runs": [{"ref": "run_1", "title": "Add retries to the db pool", "pr_url": "https://github.com/acme/api/pull/7",
              "merged_at": "2026-10-01", "snippet": "..."},
             {"ref": "run_2", "title": None, "pr_url": None, "merged_at": "2026-10-02", "snippet": "..."}],
    "tests": [{"path": "src/db.test.ts", "near": "src/db.ts", "why": "name"}],
}


def test_first_turn_in_a_repo_injects_the_brief_instead_of_recall(monkeypatch, fake, tmp_path):
    _git(tmp_path, "init", "-q")
    (tmp_path / "x.ts").write_text("1")
    fake.brief = BRIEF
    p = _provider(monkeypatch, fake.url, cwd=str(tmp_path))
    block = p.prefetch("add retries to the db pool")
    assert fake.last("/v1/brief")[0]["body"] == {"task": "add retries to the db pool", "repo_key": "gh/acme/api",
                                                "changed_paths": ["x.ts"], "budget_tokens": 600}
    assert fake.last("/v1/recall") == []
    assert block.splitlines() == [
        "## Hive brief for this task (shared team memory) - cite a fact you use as [hive:<id>]",
        "Gotchas:",
        "- [hive:77777777] Never edit a shipped migration. (repo:gh/acme/api, gotcha)",
        "Facts:",
        "- [hive:11111111] Use vitest, never jest. (global, convention)",
        "Where to look: docs/deploy.md:10-24, src/db.ts",
        "Past runs:",
        "- Add retries to the db pool (https://github.com/acme/api/pull/7)",
        "- run_2",
        "Tests: src/db.test.ts",
    ]
    assert p.recall_status().count == 7


def test_second_turn_uses_recall_and_skips_facts_the_brief_injected(monkeypatch, fake):
    fake.brief = BRIEF
    p = _provider(monkeypatch, fake.url)
    p.prefetch("add retries")
    block = p.prefetch("which test runner?")
    assert len(fake.last("/v1/brief")) == 1 and len(fake.last("/v1/recall")) == 1
    assert "vitest" not in block and "Cloud Run" in block


def test_format_brief_is_empty_for_an_empty_brief():
    assert hive.format_brief({k: [] for k in hive.BRIEF_SECTIONS}) == ""
    assert hive.format_brief({}) == ""


@pytest.mark.parametrize("kw,query", [
    ({"repo_key": "", "cwd": "/"}, "tests?"),
    ({"env": {"HIVE_BRIEF": "off"}}, "tests?"),
    ({"env": {"HIVE_BRIEF": "0"}}, "tests?"),
    ({}, "   "),
])
def test_no_brief_outside_a_repo_when_off_or_for_an_empty_query(monkeypatch, fake, kw, query):
    fake.brief = BRIEF
    p = _provider(monkeypatch, fake.url, **kw)
    p.prefetch(query)
    assert fake.last("/v1/brief") == []
    if query.strip():
        assert len(fake.last("/v1/recall")) == 1


def test_empty_first_query_does_not_consume_the_brief(monkeypatch, fake):
    fake.brief = BRIEF
    p = _provider(monkeypatch, fake.url)
    assert p.prefetch("   ") == ""
    assert fake.last("/v1/brief") == []
    assert "Gotchas:" in p.prefetch("add retries")
    assert len(fake.last("/v1/brief")) == 1


def test_prefetch_k_zero_still_briefs(monkeypatch, fake):
    fake.brief = BRIEF
    p = _provider(monkeypatch, fake.url, env={"HIVE_PREFETCH_K": "0"})
    assert "Gotchas:" in p.prefetch("add retries")
    assert p.prefetch("more") == ""
    assert fake.last("/v1/recall") == []


@pytest.mark.parametrize("down", [False, True])
def test_failed_brief_falls_back_to_recall_and_is_not_retried(monkeypatch, fake, down):
    fake.brief = BRIEF
    fake.overrides["/v1/brief"] = (500, {"error": "boom"})
    p = _provider(monkeypatch, fake.url)
    if down:
        p._client = hive.HiveClient("http://127.0.0.1:9", GOOD)
        assert p.prefetch("add retries") == ""
        p._client = hive.HiveClient(fake.url, GOOD)
    else:
        assert "vitest" in p.prefetch("add retries")
    del fake.overrides["/v1/brief"]
    p.prefetch("more")
    assert len(fake.last("/v1/brief")) == (0 if down else 1)
    assert len(fake.last("/v1/recall")) == (1 if down else 2)


def test_reset_briefs_again_and_branch_does_not(monkeypatch, fake):
    fake.brief = BRIEF
    p = _provider(monkeypatch, fake.url)
    p.prefetch("add retries")
    p.on_session_switch("s2", parent_session_id="s1")  # /branch or compression
    assert "Gotchas:" not in p.prefetch("more", session_id="s2")
    assert call(p, "hive_status")["brief"] == {"enabled": True, "tokens": 125, "items": 7}
    p.on_session_switch("s2", reset=True)  # /new
    assert call(p, "hive_status")["brief"] == {"enabled": True, "tokens": None, "items": None}
    assert "Gotchas:" in p.prefetch("add retries", session_id="s2")
    assert len(fake.last("/v1/brief")) == 2


def test_status_shows_the_brief_size(monkeypatch, fake):
    fake.brief = BRIEF
    p = _provider(monkeypatch, fake.url)
    assert call(p, "hive_status")["brief"] == {"enabled": True, "tokens": None, "items": None}
    p.prefetch("add retries")
    assert call(p, "hive_status")["brief"] == {"enabled": True, "tokens": 125, "items": 7}
    off = _provider(monkeypatch, fake.url, env={"HIVE_BRIEF": "off"})
    assert call(off, "hive_status")["brief"] == {"enabled": False, "tokens": None, "items": None}


# --- writes ---------------------------------------------------------------------------

def test_system_prompt_block_tells_the_model_to_save_and_announce_remembers(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    block = p.system_prompt_block()
    assert "hive_remember" in block
    assert "Saved to Hive: <text>" in block


def test_sync_turn_posts_an_episode(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    p.sync_turn("how do we deploy?", "Cloud Run.", session_id="s1", turn_author={"name": "Jon"})
    body = fake.last("/v1/episodes")[0]["body"]
    assert body == {"kind": "turn", "session_id": "s1", "content": "user: how do we deploy?\nassistant: Cloud Run.",
                    "repo_key": "gh/acme/api", "metadata": {"author": "Jon"}}



def test_cited_ids_finds_each_citation_once_in_order():
    text = "Use [hive:22222222] and [hive:11111111-aaaa]; again [hive:22222222]. Not [hive:zz], [hive:1234567] or hive:33333333."
    assert hive.cited_ids(text) == ["22222222", "11111111-aaaa"]
    assert hive.cited_ids("") == []
    assert hive.cited_ids(None) == []


def test_sync_turn_sends_the_reply_citations(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    p.sync_turn("how do we deploy?", "Cloud Run [hive:abcd1234], tagged [hive:abcd1234].", session_id="s1")
    assert fake.last("/v1/episodes")[-1]["body"]["metadata"] == {"cited": ["abcd1234"]}
    many = " ".join(f"[hive:{i:08x}]" for i in range(25))
    p.sync_turn("and then?", many, session_id="s1")
    assert fake.last("/v1/episodes")[-1]["body"]["metadata"]["cited"] == [f"{i:08x}" for i in range(20)]
    p.sync_turn("thanks", "No citation here.", session_id="s1")
    assert "cited" not in fake.last("/v1/episodes")[-1]["body"]["metadata"]


CORRECTION_YES = [
    "That's wrong, we deploy from the release branch.",
    "thats wrong",
    "No, that is WRONG.",
    "That’s wrong: staging has its own database.",
    "not true, the cache is per-branch",
    "Your answer is incorrect.",
    "That's outdated, we moved to vitest.",
    "We no longer use Redis for that.",
    "It doesn't work like that anymore.",
    "the deploy does not work like that",
    "**Incorrect** - check the docs.",
]

CORRECTION_NO = [
    "",
    "how do we deploy?",
    "Thanks, that's right.",
    "Is the cache per-branch?",
    "The docs say \"that's wrong\" for this case, why?",
    "The error reads “incorrect password”, what now?",
    "Why does `is_outdated()` return False?",
    "> not true\nwhat does that line mean?",
    "```\n# no longer used\n```\ncan I delete this?",
    "It works like that.",
]


@pytest.mark.parametrize("text", CORRECTION_YES)
def test_is_correction_flags_corrections(text):
    assert hive.is_correction(text)


@pytest.mark.parametrize("text", CORRECTION_NO)
def test_is_correction_ignores_other_messages_and_quotes(text):
    assert not hive.is_correction(text)


def test_correction_turn_is_marked(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    p.sync_turn("how do we deploy?", "From main [hive:abcd1234].", session_id="s1")
    assert "correction" not in fake.last("/v1/episodes")[-1]["body"]["metadata"]
    p.sync_turn("That's wrong, we deploy from release.", "Sorry, release [hive:bcde2345].", session_id="s1")
    body = fake.last("/v1/episodes")[-1]["body"]
    assert body["metadata"] == {"correction": True, "cited": ["bcde2345"]}
    assert body["content"] == "user: That's wrong, we deploy from release.\nassistant: Sorry, release [hive:bcde2345]."


REMEMBER_YES = [
    "remember this",
    "Remember this: we deploy from the release branch only.",
    "Please remember that staging uses its own database.",
    "pls remember   THAT the api key rotates monthly!!",
    "Remember: migrations are append-only.",
    "ok, remember to run pnpm install after pulling",
    "add this to your memory",
    "Add that to the memory please",
    "save this to hive",
    "Make sure to remember we never force-push main.",
    "make sure you remember the token lives in 1Password",
    "Don't forget: Jon owns the billing service.",
    "do not forget that CI needs node 22",
    "don’t forget the cache is per-branch",
    "Note that the e2e suite needs a running Postgres.",
    "Keep in mind that prod is in eu-west-1.",
    "keep this in mind for the deploy script",
    "From now on, use vitest instead of jest.",
    "Going forward we squash-merge every PR.",
    "For future reference, the staging URL is staging.acme.dev.",
    "That's the fix. Remember it for next time.",
    "**Remember this**: tabs, not spaces.",
    "Great answer. Also, remember the retry limit is 3.",
    "remember for later: the flaky test is test_upload",
    "I said \"no\" earlier, but from now on always ask before deleting files.",
]

REMEMBER_NO = [
    "",
    "how do we deploy?",
    "Do you remember what we decided about the cache?",
    "did you remember to run the tests?",
    "can you remember the name of that library?",
    "What do you remember about the billing service?",
    "Remember when we broke prod last spring?",
    "Remember the deploy freeze?",
    "I don't remember which port the api uses.",
    "never remember this stuff, it's temporary",
    "I can't remember this command, what was it?",
    "I remember that we used jest once.",
    "There's no need to remember this.",
    "The docs say \"remember this setting\" but it does nothing.",
    "The banner reads “Don't forget to log out”, can we remove it?",
    "The tooltip says 'keep in mind the quota' — fix the typo.",
    "> remember this\nwhat does that quote mean?",
    "Why does `rememberThis()` throw?",
    "Rename `note_that` to something clearer.",
    "```\n# remember this: from now on use v2\n```\nwhat does this comment do?",
    "Notes that I wrote yesterday are in the doc.",
    "I keep forgetting the command.",
]


@pytest.mark.parametrize("text", REMEMBER_YES)
def test_is_remember_request_flags_requests(text):
    assert hive.is_remember_request(text)


@pytest.mark.parametrize("text", REMEMBER_NO)
def test_is_remember_request_ignores_questions_negations_and_quotes(text):
    assert not hive.is_remember_request(text)


def test_remember_turn_is_flagged_and_carries_the_previous_reply(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    p.sync_turn("remember this", "I'll keep it in mind.", session_id="s1")  # first turn: no previous reply
    p.sync_turn("how do we deploy?", "Tag a release; Cloud Run picks it up.", session_id="s1")
    p.sync_turn("Remember that, please.", "Saved to Hive: deploys are tag-driven.", session_id="s1")
    first, plain, flagged = [r["body"] for r in fake.last("/v1/episodes")]
    assert first["metadata"] == {"remember_request": True}
    assert first["content"] == "user: remember this\nassistant: I'll keep it in mind."
    assert plain["metadata"] == {}
    assert plain["content"] == "user: how do we deploy?\nassistant: Tag a release; Cloud Run picks it up."
    assert flagged["metadata"] == {"remember_request": True}
    assert flagged["content"] == ("assistant: Tag a release; Cloud Run picks it up.\nuser: Remember that, please.\n"
                                  "assistant: Saved to Hive: deploys are tag-driven.")


def test_previous_reply_is_clipped_kept_when_the_post_fails_and_cleared_on_reset(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    fake.overrides["/v1/episodes"] = (500, {"error": "boom"})
    p.sync_turn("explain", "x" * 5000 + "END", session_id="s1")
    del fake.overrides["/v1/episodes"]
    p.sync_turn("remember this", "ok", session_id="s1")
    content = fake.last("/v1/episodes")[-1]["body"]["content"]
    assert content == "assistant: " + "x" * (hive.MAX_PREVIOUS_REPLY_CHARS - 3) + "END\nuser: remember this\nassistant: ok"
    p.on_session_switch("s2", parent_session_id="s1")  # /branch: the child sees the same last reply
    p.sync_turn("remember that", "ok", session_id="s2")
    assert fake.last("/v1/episodes")[-1]["body"]["content"].startswith("assistant: ok\n")
    p.on_session_switch("s2", reset=True)  # /new
    p.sync_turn("remember that", "ok", session_id="s2")
    assert fake.last("/v1/episodes")[-1]["body"]["content"] == "user: remember that\nassistant: ok"


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


def test_session_transcript_keeps_a_long_clarify_result_whole(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    answers = json.dumps({"responses": [{"question": "q" * 900, "user_response": "a" * 900}]})
    msgs = [
        {"role": "user", "content": "plan it"},
        {"role": "tool", "name": "clarify", "content": answers},
        {"role": "tool", "name": "terminal", "content": "x" * 5000},
    ]
    p.on_session_end(msgs)
    t = fake.last("/v1/episodes")[0]["body"]["content"]
    assert f"tool(clarify): {answers}\n" in t
    assert "[3500 chars clipped]" in t


def test_session_transcript_clips_a_clarify_result_over_8000_chars(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    answers = json.dumps({"responses": [{"question": "q", "user_response": "a" * 9000}]})
    p.on_session_end([{"role": "user", "content": "plan it"}, {"role": "tool", "name": "clarify", "content": answers}])
    t = fake.last("/v1/episodes")[0]["body"]["content"]
    assert t.endswith(f"tool(clarify): {answers[:8000]} …[{len(answers) - 8000} chars clipped]")


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


def test_remember_passes_supersedes_and_rejects_a_short_id(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    out = call(p, "hive_remember", text="Use vitest 2, never jest.", kind="convention", scope="global",
               supersedes="11111111")
    assert not out["ok"] and "supersedes" in out["error"]
    assert fake.last("/v1/facts") == []
    call(p, "hive_remember", text="Use vitest 2, never jest.", kind="convention", scope="global", supersedes=F1["id"])
    assert fake.last("/v1/facts")[0]["body"] == {"text": "Use vitest 2, never jest.", "kind": "convention",
                                                 "scope": "global", "supersedes": F1["id"]}


def test_a_superseding_fact_is_one_prefetch_line(monkeypatch, fake):
    fake.facts = [{**F1, "supersedes": F2["id"]}]
    block = _provider(monkeypatch, fake.url).prefetch("tests?")
    assert block.splitlines()[1:] == ["- [hive:11111111] Use vitest, never jest. (global, convention)"]


# --- review (curator only) ------------------------------------------------------------

C1 = {"id": "55555555-aaaa-bbbb-cccc-000000000005", "text": "Use vitest 2.", "kind": "convention", "scope": "global",
      "status": "candidate", "supersedes": F1["id"],
      "anchors": [{"id": "a1", "quote": "vitest 2", "episode_snippet": "...we moved to vitest 2..."}],
      "similar": [{**F1, "similarity": 0.912}]}
C2 = {"id": "66666666-aaaa-bbbb-cccc-000000000006", "text": "Deploys need a tag.", "kind": "system",
      "scope": "repo:gh/acme/api", "status": "candidate", "supersedes": None, "anchors": [], "similar": []}


def _names(p):
    return [s["name"] for s in p.get_tool_schemas()]


def test_review_tool_offered_to_curators_only(monkeypatch, fake):
    assert "hive_review" not in _names(_provider(monkeypatch, fake.url))
    fake.role = "curator"
    p = _provider(monkeypatch, fake.url)
    assert _names(p)[-1] == "hive_review"
    _names(p)
    assert len(fake.last("/v1/status")) == 2  # one per provider: the role is cached


def test_member_role_is_cached_too_after_a_successful_status_call(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    assert "hive_review" not in _names(p)
    assert "hive_review" not in _names(p)
    assert len(fake.last("/v1/status")) == 1  # a successful "member" result is cached too


def test_review_tool_hidden_when_status_fails_and_retried_later(monkeypatch, fake):
    fake.role = "curator"
    fake.overrides["/v1/status"] = (500, {"error": "boom"})
    p = _provider(monkeypatch, fake.url)
    assert "hive_review" not in _names(p)
    assert "hive_review" not in _names(_provider(monkeypatch, "http://127.0.0.1:9"))
    del fake.overrides["/v1/status"]
    assert "hive_review" in _names(p)  # a failure isn't cached


def _registered_like_hermes(monkeypatch, url, tmp_path):
    """Hermes' own startup order (agent_init): add_provider() builds the tool routes, THEN initialize_all()."""
    from agent.memory_manager import MemoryManager

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HIVE_URL", url)
    monkeypatch.setenv("HIVE_TOKEN", GOOD)
    monkeypatch.setenv("HIVE_REPO_KEY", "gh/acme/api")
    mm = MemoryManager()
    mm.add_provider(hive.HiveMemoryProvider())
    mm.initialize_all(session_id="s1", hermes_home=str(tmp_path), platform="cli", agent_context="primary")
    return mm


def test_curator_review_tool_is_routed_when_registered_before_initialize(monkeypatch, fake, tmp_path):
    fake.role = "curator"
    mm = _registered_like_hermes(monkeypatch, fake.url, tmp_path)
    assert "hive_review" in [s["name"] for s in mm.get_all_tool_schemas()]
    assert mm.has_tool("hive_review")  # was offered but unrouted: the model's call failed "Unknown tool"
    out = json.loads(mm.handle_tool_call("hive_review", {"action": "list"}))
    assert out.get("ok") is not False, out
    assert len(fake.last("/v1/status")) == 1  # role learned at registration is kept through initialize()


def test_member_never_gets_a_review_route(monkeypatch, fake, tmp_path):
    mm = _registered_like_hermes(monkeypatch, fake.url, tmp_path)
    assert not mm.has_tool("hive_review")
    assert "hive_review" not in [s["name"] for s in mm.get_all_tool_schemas()]


def test_review_by_a_member_is_refused_without_calling_the_api(monkeypatch, fake):
    p = _provider(monkeypatch, fake.url)
    out = call(p, "hive_review", action="list")
    assert not out["ok"] and "curator" in out["error"]
    assert fake.last("/v1/review/queue") == []


def test_review_list_is_compact(monkeypatch, fake):
    fake.role = "curator"
    fake.queue = [C1, C2]
    out = call(_provider(monkeypatch, fake.url), "hive_review", action="list")
    assert out == {"ok": True, "candidates": [
        {"id": C1["id"], "id8": "55555555", "text": "Use vitest 2.", "kind": "convention", "scope": "global",
         "supersedes": "11111111", "similar": ["[11111111] Use vitest, never jest. (0.91)"]},
        {"id": C2["id"], "id8": "66666666", "text": "Deploys need a tag.", "kind": "system",
         "scope": "repo:gh/acme/api", "supersedes": None, "similar": []},
    ], "flagged": []}
    assert fake.last("/v1/review/queue")[0]["query"] == {"limit": "20"}


def test_review_list_shows_flagged_facts(monkeypatch, fake):
    fake.role = "curator"
    fake.flagged = [
        {**F1, "status": "active", "metadata": {}, "correction": {"text": "that's wrong, use vitest 2", "episode_id": "e1",
                                                               "candidate_id": C1["id"], "at": "2026-11-08T00:00:00Z"},
         "replacing": {"id": C1["id"], "text": "Use vitest 2."}},
        {**F2, "status": "active", "correction": {"text": "not true", "episode_id": "e2", "candidate_id": None, "at": "x"},
         "replacing": None},
    ]
    out = call(_provider(monkeypatch, fake.url), "hive_review", action="list")
    assert out["flagged"] == [
        {"id": F1["id"], "id8": F1["id"][:8], "text": F1["text"], "scope": F1["scope"],
         "correction": "that's wrong, use vitest 2", "replacing": {"id8": "55555555", "text": "Use vitest 2."}},
        {"id": F2["id"], "id8": F2["id"][:8], "text": F2["text"], "scope": F2["scope"], "correction": "not true", "replacing": None},
    ]


def test_review_actions_send_the_right_bodies(monkeypatch, fake):
    fake.role = "curator"
    p = _provider(monkeypatch, fake.url)
    path = f"/v1/facts/{C1['id']}/review"
    assert call(p, "hive_review", action="approve", id=C1["id"]) == {"ok": True, "id": C1["id"], "status": "active"}
    assert call(p, "hive_review", action="fix", id=C1["id"], new_text="Use vitest 2.1.")["status"] == "active"
    assert call(p, "hive_review", action="reject", id=C1["id"], note="dup")["status"] == "retracted"
    assert [r["body"] for r in fake.last(path)] == [
        {"action": "approve"}, {"action": "fix", "new_text": "Use vitest 2.1."}, {"action": "reject", "note": "dup"}]


def test_review_reports_a_merge(monkeypatch, fake):
    fake.role = "curator"
    fake.overrides[f"/v1/facts/{C1['id']}/review"] = (
        200, {"fact": {"id": C1["id"], "status": "retracted"}, "merged_into": {"id": F1["id"], "status": "active"}})
    out = call(_provider(monkeypatch, fake.url), "hive_review", action="fix", id=C1["id"], new_text="Use vitest, never jest.")
    assert out == {"ok": True, "id": C1["id"], "status": "retracted", "merged_into": F1["id"]}


def test_review_rejects_short_ids_missing_fix_text_and_bad_actions_locally(monkeypatch, fake):
    fake.role = "curator"
    p = _provider(monkeypatch, fake.url)
    assert "full candidate id" in call(p, "hive_review", action="approve", id="55555555")["error"]
    assert "new_text" in call(p, "hive_review", action="fix", id=C1["id"])["error"]
    assert "action must be" in call(p, "hive_review", action="delete", id=C1["id"])["error"]
    assert [r for r in fake.requests if r["path"].endswith("/review")] == []


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
