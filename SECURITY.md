# Security policy

Hive stores what a team's AI assistants learn, including people's own words from their sessions, and hands it to
every connected agent. Security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://github.com/bennybrau/hive/security/advisories/new)).

Include what you found, how to reproduce it, and the impact you expect. You should get an acknowledgement within a
few days. Once a fix ships, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes.

## Secrets at rest

Settings that hold secrets (the agent credential used for distill, review-digest channel keys, webhook signing secrets) are stored in Postgres
encrypted under `HIVE_SECRET_KEY`, which lives only in the host's `.env`. Back it up separately from database
backups: without it, those settings can't be decrypted and have to be entered again. Secrets are write-only through
the API and never shown again. Instance tokens are stored as hashes.

## Scope and threat model

In scope, for example:
- another user's personal facts reaching a caller who isn't that user
- a member token acting as a curator (approving, fixing or moving facts, changing settings or webhooks)
- a stored secret appearing in an API response, a log, an episode or a model prompt
- anything that lets a request write outside its own personal scope or past the review queue

Expected behaviour, not a vulnerability:
- **Scope is ranking, not access control.** Any valid token can read every repo, team and organisation fact.
  Only personal facts are private.
- Session text sent to the Hive is passed to the configured distill model (`claude -p` on the curator's credential,
  or a local model). Run it with a model and account you're allowed to send that text to.
- The service binds to `127.0.0.1` by default. With `HIVE_BIND=0.0.0.0`, put it on a private network (LAN, VPN or
  Tailscale) or behind TLS. Tokens travel as bearer headers.
