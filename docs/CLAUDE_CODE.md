# Claude Code and the Hive

Claude Code (or any agent that speaks MCP) can read and add to the team's memory through the Hive's MCP endpoint,
`<HIVE_URL>/mcp`. It is served by the Hive itself: nothing to install on your machine.

## Connect

One command, with your Hive URL and a token:

```bash
claude mcp add --transport http hive http://<hive-host>:8800/mcp --header "Authorization: Bearer <HIVE_TOKEN>"
```

Check it with `claude mcp list`, or ask Claude Code to run `hive_status`.

## Get a token

Ask whoever runs the Hive for a member token, one per machine. They mint it on the Hive host:

```bash
docker compose exec hive node dist/cli/mint-token.js --name alice-laptop --user alice
```

The token is your identity: what you save is authored by that user, and your personal facts are that user's. A
`worker` token doesn't work here (403).

## What Claude Code gets

- `hive_brief`: the briefing for a task in a repository (playbook, gotchas, facts, where to look, past runs, tests).
  Claude Code is told to call it once at the start of a task, passing `git remote get-url origin` as `remote_url`.
- `hive_recall`: the team's facts on a question. Claude Code is told to use it before re-deriving something the team
  may already know.
- `hive_search`: facts, your own past conversations and session history, and the repository's indexed docs and
  commits (plus `also_repos`; every repository when none is given).
- `hive_remember`: save a durable fact.
- `hive_status`: who you're connected as, counts, embedding health.

Each fact comes with a `[hive:<id8>]` tag; Claude Code is asked to cite it when it relies on the fact.

## What is shared

- Reads: global facts, every repository's facts, and your own personal facts, never another user's personal facts.
  Search's conversations and session history are only your own.
- Writes: a fact you save with `scope` `repo` or `global` is a candidate until a curator approves it in the dashboard's
  Review page; other people's assistants don't see it before then. A `personal` fact is active at once and only you see it.
- A brief or recall counts as a use of each fact it returns, as with the Hermes plugin.

The full contract is in [API.md](API.md#mcp-mcp-for-claude-code-and-other-mcp-clients).

## Not available yet

- Curator tools (reviewing candidates, retracting a fact): use the dashboard, or the Hermes plugin's `hive_review`.
- Session capture: Claude Code sessions aren't sent to the Hive, so no facts are distilled from them. Facts come from
  `hive_remember` only.
- A stdio server: the endpoint is HTTP only.
