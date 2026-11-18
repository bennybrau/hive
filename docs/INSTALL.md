# Installing the Hive

```bash
curl -fsSL https://raw.githubusercontent.com/bennybrau/hive/main/scripts/install.sh | bash
```

`scripts/install.sh` needs Docker (with Compose v2) and curl, and no checkout. It runs every check and asks every
question before it writes anything. Then it writes the install directory, starts the stack, mints the tokens and
prints a summary. A download cut short runs nothing, because the whole script is one function called on its last
line.

```
install.sh [install] [--version <v>] [--dir <path>] [--project <name>] [--non-interactive] [--no-up] [--force]
```

- `--no-up` writes the install directory and starts nothing.
- `--force` regenerates `.env`, keeping the old one as `.env.bak`. It is refused while the project's database
  volume exists, because a new `POSTGRES_PASSWORD` would not match the database.

## The questions

Interactive mode shows each default in brackets, and Enter takes it. If the env var is set, the prompt shows its
value as the default. On a re-run, the answers saved in `.env` are the defaults. With `--non-interactive`, each
answer comes from its env var, else the default. When a required answer is missing, the installer stops and names
the variable.

| Question | Env var | Default | Writes to `.env` |
|---|---|---|---|
| Install directory | `HIVE_HOME` (or `--dir`) | `~/hive` | |
| Hive version | `HIVE_VERSION` (or `--version`) | the latest GitHub release (required if it can't be looked up) | `HIVE_VERSION` |
| Listen on | `HIVE_BIND` | `127.0.0.1` (`0.0.0.0` = every interface; a Tailscale IP is offered when `tailscale` is present) | `HIVE_BIND` |
| Port | `HIVE_PORT` | `8800` | `HIVE_PORT` |
| Meaning search | `HIVE_EMBED` = `host` \| `container` \| `off` | `host` if an Ollama answers on `127.0.0.1:11434`, else `off` | see below |
| Fact agent | `HIVE_DISTILL` = `claude` \| `ollama` \| `skip` | `claude` | see below |
| Claude token (hidden) | `CLAUDE_CODE_OAUTH_TOKEN` | none (required for `--non-interactive` on a first install with `claude`) | nothing |
| Ollama model | `HIVE_DISTILL_MODEL` | `llama3.1` | `HIVE_DISTILL_MODEL` |
| Repos directory | `HIVE_REPOS_HOST_ROOT` | none | `HIVE_REPOS_HOST_ROOT` |
| Your user name (the curator) | `HIVE_CURATOR_USER` | `$USER` | |
| This instance's name | `HIVE_CURATOR_NAME` | `<hostname>-curator` | |
| Teammates' names | `HIVE_MEMBERS` (comma list) | none | |

Meaning search:

- `host` sets `OLLAMA_URL=http://host.docker.internal:11434` and pulls `nomic-embed-text` through the host
  Ollama's API, so the `ollama` CLI isn't needed. On a plain Linux engine (not Docker Desktop or Rancher Desktop),
  it also writes `docker-compose.override.yml`, which maps `host.docker.internal` for `hive` and `hive-worker`.
  The host Ollama must then listen beyond loopback (`OLLAMA_HOST=0.0.0.0`). A later run with another choice
  removes that file, but leaves alone an override you wrote yourself.
- `container` sets `COMPOSE_PROFILES=ollama` and `OLLAMA_URL=http://ollama:11434`, then pulls the model in the
  bundled container.
- `off` sets `OLLAMA_URL=` (keyword-only search).

Fact agent:

- `claude` sends the token once to the Hive, which stores it encrypted (`PUT /v1/settings/agent-credential`). The
  token never goes into `.env`, a command line or the output.
- `ollama` sets `HIVE_DISTILL_RUNNER=ollama` and pulls the model. It needs meaning search `host` or `container`.
- `skip` leaves it for later: the summary points to the dashboard's Settings page.

Each teammate gets one member token. A teammate who already has one is skipped.

Other variables: `HIVE_COMPOSE_SRC=<path>` copies a local compose file instead of downloading the release's,
taking `hive.env.example` (or `.env.example`) from the same directory. `HIVE_IMAGE` and `HIVE_WORKER_IMAGE` (set in
`.env`) run other images. `HIVE_INSTALL_URL` is where a piped run downloads its own copy. `HIVE_TTY` is a test hook:
the file to read the answers from in place of `/dev/tty`.

## The summary

The summary shows the dashboard URL and the curator token. The token is shown once and not stored anywhere else.
For the curator and for each new teammate, it prints:

- a `claude mcp add --transport http hive <url>/mcp --header "Authorization: Bearer <token>"` line;
- a Hermes block (`HIVE_URL`, `HIVE_TOKEN`), plus the link to [plugins/hive/README.md](../plugins/hive/README.md).

## `--project`: a second Hive on one host

Every compose call uses one project, `HIVE_PROJECT`, or `--project` (default `hive`). The project is saved in
`.env`, and the database volume is `<project>_pgdata`. If containers of that project already run from another
directory, the installer stops and names that directory. Install the second Hive with its own project, directory
and port:

```bash
install.sh --project hive2 --dir ~/hive2   # then answer a free port
```

## Re-running

The installer copies itself to `<install dir>/install.sh`. Re-run that copy to change an answer:

- It keeps `.env`. `POSTGRES_PASSWORD`, `HIVE_SECRET_KEY` and the worker token are only filled in when they are
  missing. The answers are updated in place.
- It refuses to run when the `<project>_pgdata` volume exists but `.env` is missing. Restore `.env`, or remove the
  volume deliberately, which destroys all Hive data.
- It mints a curator only if no live curator exists. It mints a token only for teammates who don't have one.
- It handles the fact agent credential in three cases:
  - With `claude` and a token given, it asks for your curator token to set the credential. The curator token is
    read hidden, or from `HIVE_CURATOR_TOKEN`.
  - Without a curator token, it points to Settings.
  - With an empty Claude token, it keeps whatever the Hive already has.
