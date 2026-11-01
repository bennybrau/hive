# Hive HTTP API (as built)

All `/v1/*` endpoints need `Authorization: Bearer <HIVE_TOKEN>`. JSON in, JSON out.
Who you are (instance, user, role) always comes from the token, never from the body.

Roles (`mint-token --role`): `member` (default), `curator`, and `worker`, the fact-agent container. A worker token
may only use `/v1/worker/*` and `/v1/status`; every other `/v1` call is a 403
`{error: "worker tokens can only use /v1/worker/*"}`.

## Health and status

- `GET /health` — public. `{ok, db, version}`; 503 when Postgres is down.
- `GET /v1/status` — `{instance, counts:{facts,episodes,instances,repos}, embeddings:{model, state: ok|error|off, error, backlog}}`.

## Facts

- `POST /v1/facts` — remember. Body `{text, kind, scope, repo_key?, locus?, anchors?, supersedes?}`.
  - `kind`: `decision | invariant | gotcha | preference | convention | system`
  - `scope`: `global`, `personal` (→ `personal:<your user>`), `repo` (needs `repo_key`), or `repo:<key>`.
    Writing to someone else's `personal:*` is a 400.
  - `anchors[]`: `{path, line_start, line_end, quote, commit_sha, repo_key, episode_id}` — provenance; checked by `verify` in M3.
  - Status on create: personal → `active`; shared by a curator → `active` (logged as a self-approve review);
    shared by a member → `candidate`.
  - Same text (case/whitespace-insensitive) in the same scope → `200 {deduped: true}` with the existing fact. New → `201`.
  - `supersedes`: id of the fact this one replaces. It must exist, be readable, `active`, and in the same scope
    (400 otherwise). When the new fact is (or later becomes, on review) `active`, the old one becomes
    `superseded` with `valid_to = now()`, if it is still active then. Ignored when the text dedupes.
- `GET /v1/facts?scope=&status=&kind=&origin=&repo_key=&limit=&offset=` — `{facts, has_more}`, newest first.
  `origin` is `authored|distilled|ingested`. `has_more` is true when another page exists past `offset + limit`.
- `GET /v1/facts/:id` — `{fact, anchors, reviews, supersedes, superseded_by}`. Each anchor also carries `verify_note`,
  `found_line` and `remote_url` (from the registered repo; `null` if its `repo_key` isn't registered).
  `reviews[]` is the review history, oldest first, as `{action, note, new_text, reviewer_user_id, created_at}`.
  `supersedes`/`superseded_by` are the supersede chain, nearest first, as `{id, text, status, recorded_at}`:
  what this fact replaced (older) and what replaced it (newer).
- `POST /v1/facts/:id/retract` `{reason}` — author or curator only (403 otherwise). Kept as history.

Readable scopes for every call: `global`, all `repo:*` (or only `repo:<repo_key>` when given), and
your own `personal:<user>`. Other users' personal facts are never returned.

## Review (curator only; members get 403)

Shared-scope facts from members, and every distilled fact, start as `candidate` and are not recalled until a curator decides.
The queue only lists scopes the curator can read (never another user's personal facts).

- `GET /v1/review/queue?scope=&origin=&limit=20` — candidates, oldest first (`scope` as stored, e.g. `repo:<key>`;
  `origin`: `authored | distilled | ingested`; `limit` ≤ 100). `{candidates, last_distill_at}`; each candidate is `{...fact, supersedes, anchors, similar}`:
  - `anchors[]` include `verify_status`; an anchor on an episode carries `episode_snippet`, ~300 chars of the episode
    around the quote (case-insensitive; the episode's start when the quote isn't found).
  - `similar[]`: up to 3 `active` facts in the candidate's scope or `global` with cosine similarity ≥ 0.85, with
    `similarity`. Empty until the candidate is embedded.
  - `last_distill_at`: when the last `done` distill job finished (ISO timestamp), or `null` if none has.
- `POST /v1/facts/:id/review` `{action: approve|fix|reject, note?, new_text?}` → `{fact, merged_into}`. 404 no such fact,
  409 when it isn't a `candidate`. Every decision writes a `reviews` row (`new_text` on fix).
  - `approve` → `active` (and supersedes its target, see above).
  - `fix` (needs `new_text`) → text replaced and normalized, re-embedded by the worker, `active`. If the new text is
    already another fact in that scope, the candidate is merged instead: its anchors move to that fact, it is
    `retracted` with `status_note: "merged into <id>"`, and `merged_into` is that fact (activated if it was a
    candidate). 409 if that fact is `retracted` or `superseded`.
  - `reject` → `retracted`, `status_note: "rejected: <note>"` (or `"rejected"`), `valid_to = now()`.

## Settings

Values are stored AES-256-GCM encrypted under `HIVE_SECRET_KEY` (or `HIVE_SECRET_KEY_FILE`; 64 hex chars, a
malformed key stops the service at startup) and are never returned or logged.

- `PUT /v1/settings/agent-credential` `{credential}` (1–4096 chars) — curator (403 otherwise). The fact agent's
  credential, e.g. a `claude setup-token` OAuth token. Replaces any earlier one. `204`; `503 {error: "HIVE_SECRET_KEY is not set"}`
  without a key. A lost or changed key only means setting the credential again.
- `GET /v1/settings` — curator or member. `{agent_credential: {present, set_at}}` (`set_at` null when not set).

## Worker (worker tokens only; members and curators get 403)

The fact-agent container distills `session` and `asf_run` episodes into candidate facts. Every such episode enqueues
one distill job on insert (`turn` episodes don't). A claim leases the job for `HIVE_DISTILL_LEASE_SECONDS` (default 600);
an expired lease puts it back in the queue, and after 3 attempts (expired or failed) it is `failed` for good.

- `POST /v1/worker/distill/claim` → `200 {job:{id, attempts, lease_until}, episode:{id, kind, repo_key, content}, prompt_version, credential}`,
  oldest job first. Long-polls up to 25 s (re-checks every second, woken at once by a new episode), then `204`.
  `503 {error: "agent credential not set"}` (nothing claimed) when no credential is stored or `HIVE_SECRET_KEY` is unset.
- `POST /v1/worker/distill/:id/complete` `{facts:[{text, kind, scope, quote, locus?}] (≤ 20), usage:{model, input_tokens,
  output_tokens, cache_read_tokens, cost_usd, duration_ms}}` → `{result:{prompt_version, created:[ids], anchored:[ids], dropped:[{text, reason}]}}`.
  Dropped: `quote_not_in_episode` (the quote, whitespace collapsed, isn't in the episode) and `scope_not_allowed`
  (only `global`, `repo:<episode repo_key>`, `personal:<episode user>`). A fact with the same text as an existing one, or
  cosine > 0.92 to a candidate/active fact in its scope (when embeddings are on), gets an `{episode_id, quote, repo_key}`
  anchor instead of a new row; the rest become `origin: distilled`, `status: candidate` facts authored by the episode's
  user, with that anchor. Writes one `llm_calls` row (`job: distill`); the job is `done` with `result` stored.
  404 no such job, 409 when the caller doesn't hold the claim.
- `POST /v1/worker/distill/:id/fail` `{error}` → `{job:{id, status, attempts, error}}`: back to `queued`, or `failed`
  after the 3rd attempt. 404 / 409 as above.

## Episodes (raw evidence)

- `POST /v1/episodes` `{kind: turn|session, session_id, content, repo_key?, ref?, metadata?}` → `201 {episode:{id, created_at}}`.
  Up to 5 MB (whole-session transcripts).

## Recall and search (hot path: SQL + one local query embedding, no LLM)

- `GET /v1/recall?q=&repo_key=&k=10&min_sim=&changed=` — active facts only. `{mode: hybrid|keyword, facts:[{...fact, anchors, verify, score, matched:[keyword|meaning], similarity, near_changes?}]}`.
  `verify` is the worst status among the fact's anchors (`missing` > `drifted` > `unverifiable_here` > `verified`; null = never checked).
  `changed` = comma-separated repo-relative paths you're working on (the plugin sends `git status`): facts whose
  `locus` or anchor paths are those files (or a directory containing them) get one extra RRF rank-1 boost and `near_changes: true`.
  `min_sim` is a strict gate (the plugin's prefetch uses 0.62): every hit, keyword matches included, must have
  cosine similarity ≥ `min_sim` to the question. Rows not embedded yet can't be judged and are kept.
  Keyword hits on embedded rows now report their `similarity` too.
- `GET /v1/search?q=&source=all|fact,conversation,history,commit,doc&repo_key=&k=20&include_candidates=false` —
  `{mode, facts:[...], results:[{source, id, snippet, score, matched, similarity, session_id | path+line_start+line_end | ref, ...}]}`.
  `conversation` = turn episodes, `history` = session episodes; both only YOUR user's episodes.
  `commit` and `doc` are shared: commit messages and document chunks of registered repos (`repo_key` narrows to one).

## Repos (ingest + verify)

The hive reads repos through a read-only mount (`HIVE_REPOS_HOST_ROOT`, default `~/dev`, at `/repos`).

- `POST /v1/repos` `{path, key?}` — curator. Register a git repo by its host path (or a path relative to the
  root). `key` defaults from `origin` (`github.com/o/r` → `gh/o/r`, same rule as the plugin). Idempotent.
- `GET /v1/repos` — every repo with `host_path`, last ingested sha/time, `ingest_summary`, `ingest_error`, and
  counts of indexed docs, chunks and commits.
- `GET /v1/repos/files?key=` — every document considered, with `status` (`indexed | empty | skipped | error`)
  and why (`no text layer (scanned PDF?)`, `too large`, ...).
- `POST /v1/repos/ingest` `{key}` — curator. Ingest now, then verify that repo; returns both summaries. `409` if
  one is already running. Also runs for every repo every `HIVE_REPO_SYNC_MINUTES` (15; 0 = on demand only).
- `POST /v1/jobs/verify` `{repo_key?}` — curator. Re-check anchors now.

**Ingest** reads the committed state (git blobs, not the working tree), incrementally: files whose blob is
unchanged are skipped; deleted files' chunks are removed; only commits after the last ingested HEAD are read
(first run: the last `HIVE_MAX_COMMITS`, 2000). Documents: Markdown anywhere, `.txt/.rst` at the root or in a
`docs/` folder, and PDF / Word / PowerPoint (with speaker notes) / Excel at the root or in a `docs/` folder;
never `node_modules`, `vendor`, `dist`, etc. PDF via `pdftotext`; Office files are unzipped and their XML text
read directly (no Office needed). Chunks are ~1500 chars, split at headings and paragraphs, with line ranges.

**Verify** re-reads each anchor's file in the working tree (what you see now) and looks for its quote:
`verified` (found; if it moved, `verify_note` says from where to where and `found_line` is updated),
`drifted` (not verbatim, but a ≥60% similar passage is there: the source was edited), `missing` (file deleted
or nothing similar), `unverifiable_here` (repo not registered, or nothing to check). Quotes from conversations
are checked against their episode. A file that looks deleted is re-checked after 1 s (git checkout deletes
then rewrites). An `ingested` fact is retracted only when all its file anchors are missing on two passes in a
row; authored facts are never retracted by verify, they're flagged for a person.

How ranking works:
- **Keyword:** Postgres English stemming, words OR-ed (a question matches facts containing some of its words), ranked by `ts_rank_cd`.
- **Meaning:** cosine similarity on 768-d `nomic-embed-text` vectors (HNSW index); hits below `HIVE_VECTOR_MIN_SIM` (0.55) are dropped.
- **Fusion:** reciprocal rank fusion (k=60) of the two lists.
- If Ollama is unreachable, `mode` is `keyword` and results still come back. Rows not yet embedded are keyword-findable.
