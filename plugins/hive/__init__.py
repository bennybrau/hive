"""Hive memory provider for Hermes (M0 stub).

Connects this Hermes instance to a shared Hive service. M0 only proves the wiring:
config, availability, and a ``hive_status`` tool that calls ``GET /v1/status``.
Recall/prefetch, sync_turn and the fact tools arrive in M2 (see docs/MVP-PLAN.md section 4).

Config (env, via ``hermes memory setup`` or the profile's .env):
  HIVE_URL    e.g. http://studio.local:8800
  HIVE_TOKEN  instance token minted by the hive (secret)
Stdlib only: no new dependencies for Hermes.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any

from agent.memory_provider import MemoryProvider
from agent.secret_scope import get_secret

logger = logging.getLogger(__name__)

_TIMEOUT_S = 5.0


class HiveClient:
    """Minimal JSON-over-HTTP client. Never raises; returns ``{"ok": False, "error": ...}`` on failure."""

    def __init__(self, base_url: str, token: str, timeout: float = _TIMEOUT_S) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def get(self, path: str) -> dict[str, Any]:
        req = urllib.request.Request(
            self.base_url + path,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(body)
            except ValueError:
                detail = {"error": body[:200]}
            return {"ok": False, "status": exc.code, **detail}
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            return {"ok": False, "error": f"cannot reach hive at {self.base_url}: {reason}"}


_STATUS_SCHEMA = {
    "name": "hive_status",
    "description": "Check the connection to the team's shared Hive memory: who this instance is, and how many facts/episodes it holds.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}


class HiveMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._client: HiveClient | None = None
        self._session_id = ""
        self._user_id = ""
        self._agent_context = "primary"

    @property
    def name(self) -> str:
        return "hive"

    def is_available(self) -> bool:
        return bool(get_secret("HIVE_URL") and get_secret("HIVE_TOKEN"))

    def unavailable_reason(self) -> str:
        missing = [k for k in ("HIVE_URL", "HIVE_TOKEN") if not get_secret(k)]
        return f"set {' and '.join(missing)} (run `hermes memory setup`; the token comes from the hive's setup.sh or mint-token)"

    def initialize(self, session_id: str, **kwargs) -> None:
        self._client = HiveClient(get_secret("HIVE_URL", "") or "", get_secret("HIVE_TOKEN", "") or "")
        self._session_id = session_id
        self._user_id = kwargs.get("user_id") or ""
        # Writes (M2+) are skipped for subagent/cron/flush contexts; recorded now so the rule lives in one place.
        self._agent_context = kwargs.get("agent_context") or "primary"

    def get_config_schema(self) -> list[dict[str, Any]]:
        return [
            {"key": "url", "description": "Hive URL, e.g. http://studio.local:8800", "required": True, "env_var": "HIVE_URL"},
            {"key": "token", "description": "Instance token from the hive (setup.sh / mint-token)", "secret": True,
             "required": True, "env_var": "HIVE_TOKEN"},
        ]

    def system_prompt_block(self) -> str:
        return ("You are connected to the team's shared Hive memory. "
                "Use the hive_status tool if asked whether the shared memory is reachable.")

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [_STATUS_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs) -> str:
        if tool_name != "hive_status":
            return json.dumps({"ok": False, "error": f"unknown hive tool {tool_name}"})
        if self._client is None:
            return json.dumps({"ok": False, "error": "hive provider not initialized"})
        return json.dumps(self._client.get("/v1/status"))

    def shutdown(self) -> None:
        self._client = None


def register(ctx) -> None:
    """Register the Hive as a memory provider plugin."""
    ctx.register_memory_provider(HiveMemoryProvider())
