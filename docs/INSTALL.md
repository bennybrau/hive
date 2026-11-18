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
install.sh join --url <hive url> [--token <t>] [--version <v>] [--force]
install.sh doctor | upgrade [--version <v>] | uninstall [--purge] [--yes]   # see Day-2
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
- a Hermes line, `curl -fsSL .../install.sh | bash -s -- join --url <url> --token <token>`, to run on that
  person's Hermes machine (see [join](#join)).

## join

```
install.sh join --url <hive url> [--token <t>] [--version <v>] [--force]
```

`join` connects the Hermes on this machine to a Hive. It needs curl and `hermes` on PATH, and no Docker. The token
defaults to `HIVE_TOKEN` (which keeps it out of your shell history). `join` passes it to curl in a mode-600 config
file, not on a command line. Every check runs before anything is written:

- `<url>/health` answers `ok`, and gives the Hive's version;
- `<url>/v1/status` accepts the token;
- `hermes` is on PATH;
- `$HERMES_HOME/plugins/hive` is not a symlink (a checkout, from the manual install). `--force` replaces the link
  and leaves what it points to alone.

Then it:

1. downloads the plugin for the Hive's version: a release `X.Y.Z` takes that release's `hive-plugin.tar.gz`, and a
   `main-<sha7>` build takes `plugins/hive` from the repo at that commit. Any other version (`dev`, or the `0.0.1`
   of a build without a version) stops and asks for `--version <v>`. An old plugin dir is replaced.
2. sets `HIVE_URL` and `HIVE_TOKEN` in `$HERMES_HOME/.env` (mode 600). Other keys are kept, and a re-join replaces
   the two keys rather than adding them again.
3. runs `hermes config set memory.provider hive`, then `hermes memory status`. It fails unless the status's
   `Provider:` line names `hive`.

`HERMES_HOME` (default `~/.hermes`) moves the plugin dir, `.env` and the Hermes config together.

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

## Repos on a host with no checkout

On a cloud host there is usually no `~/dev` to mount. Register repos by URL instead: the Hive clones them into its
`<project>_hive-clones` volume and fetches before every ingest (see Repos in [API.md](API.md)):

```bash
curl -X POST <url>/v1/repos -H "Authorization: Bearer <curator token>" -H 'Content-Type: application/json' \
  -d '{"url": "https://github.com/<owner>/<repo>", "token": "<PAT>"}'
```

Only `https://github.com/<owner>/<repo>` URLs are accepted. A public repo needs no `token`. For a private one, use
a fine-grained personal access token limited to that repo with **Contents: read-only** and nothing else. The Hive
stores it encrypted under `HIVE_SECRET_KEY` (so that must be set) and never shows it again; replace it with
`PUT /v1/repos/gh%2F<owner>%2F<repo>/token` when it expires.

## Day-2: doctor, upgrade, uninstall

```
install.sh doctor    [--dir <path>] [--project <name>]
install.sh upgrade   [--version <v>] [--dir <path>] [--project <name>]
install.sh uninstall [--purge] [--yes] [--non-interactive] [--dir <path>] [--project <name>]
```

Each one works on an install directory: `--dir`, else `HIVE_HOME`, else the directory of the `install.sh` you run
if it holds a `.env`, else `~/hive`. So `~/hive2/install.sh doctor` checks `~/hive2`. The project is `--project`,
else `HIVE_PROJECT` in that `.env`, else `hive`. Without a `.env` there, each one stops.

`doctor` prints one line per check. It exits 1 if any line is bad (✗); warnings (!) don't fail it.

| Check | Bad | Warning |
|---|---|---|
| Every container of the project (`docker compose ps`) | not running, or not healthy | |
| `/health` | doesn't answer `ok` | |
| Meaning search (`embeddings.state` on `/v1/status`, asked with the worker token) | no answer | `error` (`off` is fine) |
| The worker's last contact with the Hive | | over 10 minutes ago, or never |
| The fact agent credential (not needed with `ollama`) | | missing |
| The newest backup (`backup newest`; `HIVE_BACKUPS=off` is fine) | | over 26 hours old, none, or can't be read |
| Free disk where Docker keeps its data | | under 5 GB |
| The version on `/health` against the latest release | | behind, or GitHub can't be reached, or not a release version |

`upgrade` moves to release `<v>`, by default the latest (it stops if that can't be looked up). It downloads the
release's compose file (or copies `HIVE_COMPOSE_SRC`) and pulls that release's images first. If the pull fails
and the images aren't already on this machine, it stops and changes nothing: `.env`, `docker-compose.yml` and
`install.sh` stay as they were. Then it sets `HIVE_VERSION` in `.env`, puts the compose file in place, starts the
stack with `up -d --wait` and runs `doctor`, whose exit code is the upgrade's. Only when `doctor` passes does it
refresh `install.sh` from `main` (or `HIVE_INSTALL_URL`). A failed upgrade is not rolled back: run
`upgrade --version <old version>`.

`uninstall` stops and removes the containers and keeps the data volumes (the backups too) and the install
directory, so a re-run of `install.sh` brings the same Hive back. `uninstall --purge` also deletes the volumes
(every fact, token and setting, and the backups in the `hive-backups` volume) and the install directory. It asks
you to type the project name first. Without a terminal, or with `--non-interactive`, it refuses unless you pass
`--yes`. It never deletes a `HIVE_BACKUP_DIR` or `HIVE_BACKUP_COPY_DIR` on the host. It only deletes the install
directory when it isn't `/` or your home, its `.env` has a `HIVE_PROJECT=` line, it holds `docker-compose.yml`, it
has no `.git`, and neither backup directory is inside it. Otherwise it says why and leaves the directory for you to
remove (the volumes are already gone).

`upgrade` and `uninstall` stop before any compose call when the project's containers run from another directory,
or when Docker can't list them, as the installer does: name this install's project with `--project <name>`.

## Backups

The `backup` service dumps the database every night at `HIVE_BACKUP_TIME` (default `03:00`, in `TZ`, default
`UTC`) to `hive-YYYYMMDD-HHMM.dump` (`pg_dump -Fc`). The dumps go in the `hive-backups` volume, or in
`HIVE_BACKUP_DIR` on the host. Each night it keeps the newest dump of each of the last 7 days and of each of the
last 4 Sundays, and always the newest one. Files with any other name are left alone. With `HIVE_BACKUP_COPY_DIR`
set, each dump is also copied there (a NAS or a synced folder, off this disk), with the same retention.
`HIVE_BACKUPS=off` turns the nightly dump off; the service then idles.

Take one now from the install directory (no checkout needed):

```
docker compose -p <project> run --rm --no-deps -T backup once
```

In a checkout, `scripts/backup-now.sh [--dir <d>] [--project <p>]` does the same. It finds the install like
`doctor` (but falls back to the checkout instead of `~/hive`) and refuses, like `upgrade`, when the project runs
from another directory or Docker can't list it. `docker compose -p <project> logs backup` shows one line per dump:
the file, its size and how long it took.
