"""Run with Hermes' interpreter so ``agent.*`` imports resolve:
    ~/.hermes/hermes-agent/venv/bin/python -m pytest plugins/hive/tests -q
"""
from __future__ import annotations

import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

_PLUGIN_DIR = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("hive_plugin", _PLUGIN_DIR / "__init__.py")
hive = importlib.util.module_from_spec(_spec)
sys.modules["hive_plugin"] = hive
_spec.loader.exec_module(hive)

GOOD = "hive_good"


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path != "/v1/status":
            self.send_response(404); self.end_headers(); return
        if self.headers.get("Authorization") != f"Bearer {GOOD}":
            body, code = {"error": "unknown or revoked token"}, 401
        else:
            body, code = {"ok": True, "instance": {"name": "t", "user_id": "jon", "role": "member"},
                          "counts": {"facts": 0}}, 200
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


@pytest.fixture()
def server():
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def _provider(monkeypatch, url, token):
    monkeypatch.setenv("HIVE_URL", url)
    monkeypatch.setenv("HIVE_TOKEN", token)
    p = hive.HiveMemoryProvider()
    p.initialize("s1", hermes_home="/tmp", platform="cli", user_id="jon")
    return p


def test_unavailable_without_env(monkeypatch):
    monkeypatch.delenv("HIVE_URL", raising=False)
    monkeypatch.delenv("HIVE_TOKEN", raising=False)
    p = hive.HiveMemoryProvider()
    assert p.is_available() is False
    assert "HIVE_URL" in p.unavailable_reason() and "HIVE_TOKEN" in p.unavailable_reason()


def test_available_with_env(monkeypatch):
    monkeypatch.setenv("HIVE_URL", "http://x")
    monkeypatch.setenv("HIVE_TOKEN", "t")
    assert hive.HiveMemoryProvider().is_available() is True


def test_status_ok(monkeypatch, server):
    out = json.loads(_provider(monkeypatch, server, GOOD).handle_tool_call("hive_status", {}))
    assert out["ok"] is True and out["instance"]["user_id"] == "jon"


def test_status_bad_token_reports_401(monkeypatch, server):
    out = json.loads(_provider(monkeypatch, server, "nope").handle_tool_call("hive_status", {}))
    assert out["ok"] is False and out["status"] == 401 and "revoked" in out["error"]


def test_status_unreachable_does_not_raise(monkeypatch):
    out = json.loads(_provider(monkeypatch, "http://127.0.0.1:9", GOOD).handle_tool_call("hive_status", {}))
    assert out["ok"] is False and "cannot reach hive" in out["error"]


def test_tool_schema_and_name():
    p = hive.HiveMemoryProvider()
    assert p.name == "hive"
    assert [s["name"] for s in p.get_tool_schemas()] == ["hive_status"]
