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
- The list and the detail's `fact` also carry `use_count` (times a brief or recall returned it), `cite_count` (turns
  whose answer cited it; see Episodes) and `last_used_at` (the latest of either; null if never). Other responses that
  return a fact don't.
- `POST /v1/facts/:id/retract` `{reason}` — author or curator only (403 otherwise). Kept as history.

Every fact carries `metadata` (`{}` by default). `metadata.asked: true` = a person asked for it to be remembered
(a flagged turn; see Worker).

Readable scopes for every call: `global`, all `repo:*` (or only `repo:<repo_key>` when given), and
your own `personal:<user>`. Other users' personal facts are never returned.

## Review (curator only; members get 403)

Shared-scope facts from members, and every distilled fact, start as `candidate` and are not recalled until a curator decides.
The queue only lists scopes the curator can read (never another user's personal facts).

- `GET /v1/review/queue?scope=&origin=&limit=20` — candidates, asked candidates first, then oldest (`scope` as stored, e.g. `repo:<key>`;
  `origin`: `authored | distilled | ingested`; `limit` ≤ 100). `{candidates, last_distill_at}`; each candidate is `{...fact, supersedes, anchors, similar, replaces}`:
  - `anchors[]` include `verify_status`; an anchor on an episode carries `episode_snippet`, ~300 chars of the episode
    around the quote (case-insensitive; the episode's start when the quote isn't found).
    It also carries `exchange: {assistant, user}`: the first `user:` turn containing the quote (whitespace-normalized,
    `user: ` removed) and the `assistant:` text turns between the previous user turn and it (tool calls and output
    skipped, prefixes removed, last 600 chars; `null` when there are none). `exchange` is `null` when the quote is in no
    user turn, and on anchors without an episode.
  - `similar[]`: up to 3 `active` facts in the candidate's scope or `global` with cosine similarity ≥ 0.85, with
    `similarity`. Empty until the candidate is embedded.
  - `replaces`: the fact a distilled candidate says it corrects (its `metadata.replaces`, see Worker) as
    `{id, text, kind, scope, status}` with its status now, or `null`.
  - `last_distill_at`: when the last `done` distill job finished (ISO timestamp), or `null` if none has.
- `POST /v1/facts/:id/review` `{action: approve|fix|reject, note?, new_text?}` → `{fact, merged_into}`. 404 no such fact,
  409 when it isn't a `candidate`. Every decision writes a `reviews` row (`new_text` on fix).
  - `approve` → `active` (and supersedes its target, see above). A candidate with no `supersedes` whose
    `metadata.replaces` is still `active` in its scope gets it as `supersedes`, and that fact is superseded. The same
    goes for a `fix` that isn't a merge; a merge ignores `replaces`.
  - `fix` (needs `new_text`) → text replaced and normalized, re-embedded by the worker, `active`. If the new text is
    already another fact in that scope, the candidate is merged instead: its anchors move to that fact, it is
    `retracted` with `status_note: "merged into <id>"`, and `merged_into` is that fact (activated if it was a
    candidate). 409 if that fact is `retracted` or `superseded`.
  - `reject` → `retracted`, `status_note: "rejected: <note>"` (or `"rejected"`), `valid_to = now()`.

## Stats (curator only)

- `GET /v1/stats?days=30` — `days` 1–365 (400 otherwise); members get 403 `{error: "only a curator can see stats"}`.
  The window starts at midnight UTC `days - 1` days ago (`days=1` is today, UTC); days are UTC `YYYY-MM-DD`.

  ```
  {
    days, since,                                   // since: ISO timestamp of the window start
    facts: {
      by_status: {active: 12, candidate: 3, ...},  // all facts, not just the window
      by_origin: {authored: 9, distilled: 6, ...},
      by_scope:  {global: 4, "repo:<key>": 8, personal: 3},  // every personal:<user> folds into "personal"
      per_day:   [{day, count}]                    // facts recorded in the window
    },
    cost:        [{day, job, calls, input_tokens, output_tokens, cost_usd}],  // llm_calls per day and job
    cost_totals: [{job, calls, input_tokens, output_tokens, cost_usd}],       // per job over the window
    workers:     [{id, name, last_seen_at}],        // unrevoked worker tokens
    backlog:     {candidates, oldest_candidate_at, distill_queued, oldest_queued_at}
  }
  ```

  `cost_usd` is a number (`est_cost_usd` summed; embed calls are 0). Days with no rows are absent.

  `episode_id=<uuid>` (400 if not a uuid) adds `calls: [{id, job, model, input_tokens, output_tokens, cached_tokens,
  cost_usd, duration_ms, created_at}]`, that episode's `llm_calls` rows oldest first, regardless of `days` (e.g. the
  cost of distilling one session). Without it the response has no `calls`.

## Settings

Values are stored AES-256-GCM encrypted under `HIVE_SECRET_KEY` (or `HIVE_SECRET_KEY_FILE`; 64 hex chars, a
malformed key stops the service at startup) and are never returned or logged.

- `PUT /v1/settings/agent-credential` `{credential}` (1–4096 chars) — curator (403 otherwise). The fact agent's
  credential, e.g. a `claude setup-token` OAuth token. Replaces any earlier one. `204`; `503 {error: "HIVE_SECRET_KEY is not set"}`
  without a key. A lost or changed key only means setting the credential again.
- `GET /v1/settings` — curator or member. `{agent_credential: {present, set_at}}` (`set_at` null when not set).

## Webhooks (curator only; members get 403)

Every fact change (remember, review, retract, distill, verify) queues a delivery to each active webhook subscribed
to its event, in the same transaction as the change:

- `fact.recorded` — a fact was inserted (any status, including candidates);
- `fact.activated` — a fact became active (inserted active, e.g. by a curator, or approved/fixed);
- `fact.retracted` / `fact.superseded` — a fact's status changed to that.

Personal-scope facts never fire. Each delivery is `POST <url>` with `Content-Type: application/json`, body
`{id, event, occurred_at, fact:{id, text, kind, scope, origin, status, status_note, supersedes}}` (the fact as the
transaction left it) and headers `X-Hive-Event`, `X-Hive-Delivery` (= body `id`) and `X-Hive-Signature: sha256=<hex>`,
the HMAC-SHA256 of the raw body under the webhook's secret. Any 2xx within 10 s is delivered; otherwise it is retried
after `HIVE_WEBHOOK_BACKOFF_SECONDS`·2^(n−1) (default 30 s, capped at 1 h), and after `HIVE_WEBHOOK_MAX_ATTEMPTS`
(default 6) it is `failed` and the webhook gets `failing_since` + `last_error`, cleared by its next 2xx. A failing
webhook keeps receiving new events. An inactive one queues nothing: events while it is off are dropped, and
deliveries queued before it was switched off wait and are sent once it is re-activated.

Secrets are stored encrypted under `HIVE_SECRET_KEY`; every endpoint answers `503 {error: "HIVE_SECRET_KEY is not set"}`
without one. A webhook is `{id, url, events, active, created_at, created_by_user_id, failing_since, last_error}`.

- `POST /v1/webhooks` `{url, events?, active?, secret?}` → `201 {webhook, secret}`. `url` must be http(s); `events`
  defaults to all four; `secret` (16–256 chars) is generated (64 hex) when omitted. The secret is only ever returned here.
- `GET /v1/webhooks` → `{webhooks: [...]}`, oldest first.
- `GET /v1/webhooks/:id` → `{webhook, deliveries: [{id, event, status: queued|delivered|failed, attempts,
  next_attempt_at, last_error, created_at, delivered_at}]}` (last 20, newest first). 404 no such webhook.
- `PATCH /v1/webhooks/:id` `{url?, events?, active?, secret?}` (at least one) → `{webhook}`. 404 as above.
- `DELETE /v1/webhooks/:id` → `204`, with its deliveries. 404 as above.

## Worker (worker tokens only; members and curators get 403)

The fact-agent container distills `session` and `asf_dialog` episodes into candidate facts. Every such episode enqueues
one distill job on insert, at priority 0 (`asf_run` episodes don't; `asf_run` jobs queued before migration 0009 may still
be handed out). A `turn` episode enqueues one only when it is flagged (`metadata.remember_request: true`), at priority 1:
a remember job. A claim leases the job for `HIVE_DISTILL_LEASE_SECONDS` (default 600);
an expired lease puts it back in the queue, and after 3 attempts (expired or failed) it is `failed` for good.

- `POST /v1/worker/distill/claim` → `200 {job:{id, attempts, lease_until}, episode:{id, kind, repo_key, content,
  remember_request, personal_scope}, related:[{id, text, kind, scope}], prompt_version, credential}`, highest priority first, then oldest.
  `related` is up to 8 `active` facts in the episode's scopes (`global`, `repo:<repo_key>`, `personal:<episode user>`)
  that a distilled fact may replace: with an episode embedding, the embedded facts closest by cosine; without one, the
  facts sharing a word with the episode (OR-ed keyword query of the fact's text), best `ts_rank` first. Their ids are
  kept on the job. Always `[]` on a remember job and an `asf_run` job.
  `remember_request` is true on a remember job; `personal_scope` is then `personal:<episode user>` (else `null`), a
  scope its facts may also take. `content` is the distill view, not the whole episode: every `user: ` turn and
  `tool(clarify): ` line in full, each after the last `assistant: ` text since the previous kept piece (clipped to
  its last 2,000 chars, marked `[…]`), with tool calls, other tool output and other assistant text replaced by a `…` line.
  A remember job and an `asf_run` job get the whole content. Quotes are still checked against the whole episode.
  A `session` job whose user turns are all plain questions (or that has none) is skipped, not handed out: it is `done`
  with `result: {created: [], anchored: [], skipped: "questions only"}` and no `llm_calls` row, and the next job is
  claimed instead. A plain question is a `user: ` turn ending in `?` that contains none of (any case) `instead`,
  `actually`, `rather`, `don't`, `do not`, `never`, `always`, `from now on`, `let's`, `should be`, `must`, `i want`,
  `i'd like`, `please`, `remember`, `no,`, `not `; a clarify answer never is. `asf_dialog` and remember jobs are never
  skipped. Long-polls up to 25 s (re-checks every second, woken at once by a new episode), then `204`.
  `503 {error: "agent credential not set"}` (nothing claimed) when no credential is stored or `HIVE_SECRET_KEY` is unset.
- `POST /v1/worker/distill/:id/complete` `{facts:[{text, kind, scope, quote, locus?, replaces?}] (≤ 20), usage:{model, input_tokens,
  output_tokens, cache_read_tokens, cost_usd, duration_ms}}` → `{result:{prompt_version, created:[ids], anchored:[ids], dropped:[{text, reason}],
  dropped_non_user_quote}}`. Dropped, checked in this order: `quote_not_in_episode` (the quote, whitespace collapsed,
  isn't in the episode), `non_user_quote` (it is, but not inside a user turn: a turn starts at a line beginning
  `user: ` and ends before the next line starting with `user: `, `assistant` or `tool(`, and each `"user_response"`
  value (still JSON-escaped, as it appears in the episode) on a line starting `tool(clarify): ` is a user turn of its own; checked on `session` and
  `asf_dialog` jobs, not on a remember job or an `asf_run` job), and `scope_not_allowed` (only `global`, `repo:<episode repo_key>`, `personal:<episode user>`).
  `dropped_non_user_quote` counts the `non_user_quote` drops (always present, 0 when none). A fact with the same text as an existing one, or
  cosine > 0.92 to a candidate/active fact in its scope (when embeddings are on), or anchored on the same quote (whitespace
  collapsed) as a candidate, active or retracted (not superseded) fact in its scope with cosine ≥ 0.80 to it (with no embedding on either side: when the
  exchange matches, the same user turn after the same assistant text or clarify question, or none on both sides), gets an
  `{episode_id, quote, repo_key}` anchor instead of a new row (on `session`, `asf_dialog` and remember jobs alike); the rest become `origin: distilled`, `status: candidate` facts authored by the episode's
  user, with that anchor. Such a new candidate keeps `replaces` (≤ 100 chars) as `metadata.replaces` only when it is an id
  the claim sent in `related` and that fact is in the candidate's scope; otherwise (and on an anchored fact or a remember
  job) it is dropped without a word. A retracted fact matched by its quote gains the anchor and stays retracted, so a rejected
  fact isn't sent back for review. Writes one `llm_calls` row (`job: distill`); the job is `done` with `result` stored.
  A remember job records what the user asked for. Its window runs from the previous `turn` episode of the same session
  by the same instance (or 15 minutes back, without one) to the flagged turn; that instance's candidate/active facts
  from the window are embedded first if they aren't yet. A fact matching an existing one (same text, cosine > 0.92, or the same quote as above;
  with no vector for it, that instance's window fact in the same scope, one not yet anchored by this job first) gets the
  anchor and `metadata.asked: true`. The rest become `origin: authored` facts by the episode's instance, with
  `metadata.asked: true` and the status a `POST /v1/facts` from it would get (a curator's shared fact is `active` with a
  self-approve review).
  404 no such job, 409 when the caller doesn't hold the claim.
- `POST /v1/worker/distill/:id/fail` `{error}` → `{job:{id, status, attempts, error}}`: back to `queued`, or `failed`
  after the 3rd attempt. 404 / 409 as above.

## Episodes (raw evidence)

- `POST /v1/episodes` `{kind: turn|session|asf_run|asf_dialog, session_id?, content, repo_key?, ref?, metadata?}` →
  `201 {episode:{id, created_at}, deduped:false}`. Up to 5 MB (whole-session transcripts). `session_id` is required
  for `turn` and `session` (400 without it). `metadata.remember_request: true` on a `turn` flags it: the user asked
  for something in it to be remembered, and it is distilled before any other queued job (see Worker).
  `metadata.cited` on a `turn` lists the fact ids its answer cited as `[hive:<id>]` (the plugin sends it): an array of
  at most 20 strings of 8–36 hex digits or `-` (400 otherwise, nothing stored). After the turn is stored, each prefix
  (case-insensitive) that names exactly one `active` fact you can read, in any repo, adds 1 to that fact's
  `cite_count` and sets `last_used_at`, once per fact per turn; an ambiguous or unknown prefix is ignored. A failure
  here is logged and the turn still gets its 201.
  `asf_run` is a software-factory run record: the approved plan plus the review of the finished work, sent once its PR
  is merged. It is not distilled; it is found by `history` search and listed in briefs. It needs `repo_key` (a
  registered repo: `400 unknown repo_key` otherwise), a non-empty `ref` (the run id), at most 200 KiB of content in
  UTF-8 bytes (`413` over that), and `metadata: {merged_at, pr_url?, title?, paths?}`: `merged_at` an ISO time
  (`400 asf_run needs metadata.merged_at` without it, 400 if unparseable), `pr_url` and `title` strings, `paths` the
  repo-relative files the run changed (strings, at most 500). It is keyed by `(repo_key, ref)`: posting the same run
  again returns `200 {episode, deduped:true}` with the stored episode; its metadata is replaced by the new one (last
  write wins), its content stays as first posted.
  `asf_dialog` is what a person said to the software factory: their note on a plan at a gate, or their answer to a
  question it asked, after the factory's text (`assistant: ...` then `user: ...`). It is distilled like a session (a
  priority-0 job on insert; a fact must quote a `user:` line), found by `history` search, and not listed in briefs.
  It needs `repo_key` (a registered repo: `400 unknown repo_key` otherwise), a non-blank `ref` (which run and gate or
  question; any string), content with a line starting `user: `, and `metadata.author` (a non-empty string: who wrote
  the note); 400 otherwise, `413` over 200 KiB of UTF-8 content. `session_id` is optional. It is keyed by
  `(repo_key, ref)`: posting it again returns `200 {episode, deduped:true}` with the stored episode and changes
  nothing (content and metadata stay as first posted, no second job).

## Recall and search (hot path: SQL + one local query embedding, no LLM)

- `GET /v1/recall?q=&repo_key=&k=10&min_sim=&changed=` — active facts only. `{mode: hybrid|keyword, facts:[{...fact, anchors, verify, score, matched:[keyword|meaning], similarity, near_changes?}]}`.
  `verify` is the worst status among the fact's anchors (`missing` > `drifted` > `unverifiable_here` > `verified`; null = never checked).
  `changed` = comma-separated repo-relative paths you're working on (the plugin sends `git status`): facts whose
  `locus` or anchor paths are those files (or a directory containing them) get one extra RRF rank-1 boost and `near_changes: true`.
  `min_sim` is a strict gate (the plugin's prefetch uses 0.62): every hit, keyword matches included, must have
  cosine similarity ≥ `min_sim` to the question. Rows not embedded yet can't be judged and are kept.
  Keyword hits on embedded rows now report their `similarity` too.
  Each returned fact gets `use_count + 1` and `last_used_at = now()` (best effort: a failure is logged, the answer is
  unchanged). `/v1/search` does not count.
- `GET /v1/search?q=&source=all|fact,conversation,history,commit,doc&repo_key=&k=20&include_candidates=false` —
  `{mode, facts:[...], results:[{source, id, snippet, score, matched, similarity, session_id | path+line_start+line_end+sha+remote_url | ref+subject | ref+title+pr_url+merged_at | ref+author, ...}]}`.
  Doc hits' `sha` is the commit the repo was last ingested at (usable in a blob link); commit hits' `subject` is the message's first line.
  `conversation` = turn episodes, only YOUR user's. `history` = YOUR user's session episodes plus every `asf_run` and
  `asf_dialog` episode: factory runs and what people said to the factory are repo history like a commit, not a private
  conversation, and every token can already read every `repo:` scope. `asf_run` hits also carry the run's `title`,
  `pr_url` and `merged_at` (null when not sent); `asf_dialog` hits carry `ref` and `author` (`metadata.author`).
  `commit` and `doc` are shared: commit messages and document chunks of registered repos (`repo_key` narrows to one).

## Brief (hot path: SQL + one local query embedding, no LLM)

- `POST /v1/brief` `{task, repo_key, changed_paths?: string[] (≤200), budget_tokens?: 100–4000 (600)}` — what to know before
  starting a task in a repo. `{repo_key, repo_indexed, mode, terms, budget_tokens, tokens:{gotchas, facts, locations, runs, tests, total},
  dropped:{gotchas, facts, locations, runs, tests}, gotchas:[...], facts:[...], locations:[...], runs:[...], tests:[...]}`.
  - `terms`: the task's words as Postgres' `english` config sees them (stopwords dropped, stemmed), 3+ chars.
  - `facts` `[{id, text, kind, scope, locus, verify, near_changes?}]`: like `/v1/recall` with `k=5`, `min_sim=0.62` (the
    prefetch gate) and `changed=changed_paths` (locus boost).
  - `locations` `[{ref, path, source: doc|path}]`, up to 8, one per file: document passages (`ref` = `path:start-end`)
    alternating with tracked files whose path contains the most `terms` (a term in the file name counts double).
  - `runs` `[{ref, title, pr_url, merged_at, snippet}]`, up to 3: the repo's `asf_run` records with a `merged_at` whose
    `metadata.paths` overlap the locations or `changed_paths` (a file, or a directory containing it), or whose text
    matches the task's words. Ranked: most of those paths touched, then a word match, then the newest `merged_at` (so a
    newer run on the same files wins). `snippet` is the run's text around the task's words (its start if none match).
  - `tests` `[{path, near, why: name|folder|sibling}]`, up to 5: tracked files matching `test|spec`, ranked: the file name
    contains a location's name (minus extension), then in the location's folder or below it, then in a folder next to it.
  - `gotchas`: active `gotcha` facts you can read whose `locus` or anchor paths overlap the locations or `changed_paths`
    (a file, or a directory containing it). A fact listed here is not repeated under `facts`.
  - Budget: each item costs `ceil(JSON length / 4)` tokens; items are taken round-robin in the order gotchas → facts →
    locations → runs → tests, and one that doesn't fit is skipped and counted in `dropped`.
  - A repo that isn't registered still answers 200, with `repo_indexed: false` and only `facts`. Code paths come from
    `repo_files` (every tracked file of the default branch except `node_modules`, `vendor`, `dist`, ...), filled by ingest;
    repos ingested before this existed get it on their next ingest.
  - Each fact in the answer's `gotchas` and `facts` (after the budget) gets `use_count + 1` and `last_used_at = now()`,
    like `/v1/recall`.

## Repos (ingest + verify)

The hive reads repos through a read-only mount (`HIVE_REPOS_HOST_ROOT`, default `~/dev`, at `/repos`).

- `POST /v1/repos` `{path, key?}` — curator. Register a git repo by its host path (or a path relative to the
  root). `key` defaults from `origin` (`github.com/o/r` → `gh/o/r`, same rule as the plugin). Idempotent.
- `GET /v1/repos` — every repo with `host_path`, last ingested sha/time, `ingest_summary`, `ingest_error`, and
  counts of indexed docs, chunks and commits, and `anchors: {verified, drifted, missing, unverifiable_here, unverified}`:
  the anchors of active + candidate facts in that repo (by the anchor's `repo_key`, else the fact's `repo:` scope), by verify status.
- `GET /v1/repos/files?key=` — every document considered, with `status` (`indexed | empty | skipped | error`)
  and why (`no text layer (scanned PDF?)`, `too large`, ...).
- `POST /v1/repos/ingest` `{key}` — curator. Ingest now, then verify that repo; returns both summaries. `409` if
  one is already running. Also runs for every repo every `HIVE_REPO_SYNC_MINUTES` (15; 0 = on demand only).
- `POST /v1/jobs/verify` `{repo_key?}` — curator. Re-check anchors now.

**Ingest** reads the committed state of the repo's **default branch**, never the working tree or the branch the
checkout is on: `origin/HEAD`, else `origin/main` / `origin/master` (as last fetched; the hive never fetches),
else local `main` / `master`, else the checkout's `HEAD`. That branch is stored as `default_branch`, its tip as
`last_ingested_sha`, so doc links point at a commit the remote has. Incremental: files whose blob is
unchanged are skipped; deleted files' chunks are removed; only commits after the last ingested tip are read
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
