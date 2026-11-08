# Hive MVP Plan — a shared brain for many Hermes instances

> Status: approved to start M0, Oct 27 2026 (see §9 for settled decisions). Companion to `DESIGN-NOTES.md` and `GLOSSARY.md`.
> Scope: one host (Mac Studio) running the Hive next to ASF; any Hermes instance on the LAN/Tailscale connects with a URL + token.

**Goal:** Give every Hermes instance in the team the Entire Brain feature set — brief before a task, hand-written and distilled facts with verifiable sources, hybrid search over facts/history/docs/conversations, global facts, non-code docs, a dashboard — backed by ONE shared, governed store instead of one local store per developer.

**Architecture:** A TypeScript service (`hive`) owning Postgres (facts, episodes, docs, FTS + pgvector) and the cold-path jobs (distill, verify, ingest). A thin Python Hermes memory-provider plugin (`plugins/memory/hive`) that calls it over HTTP: hot path on `prefetch`, fire-and-forget on `sync_turn`, tools for `remember / recall / brief / search / review`. A small React dashboard served by the same service.

**Tech stack:** Node 22 + TypeScript, Fastify, Postgres 16 + pgvector, Drizzle (or Kysely) migrations, docker compose; embeddings from local Ollama (`nomic-embed-text`) so search-by-meaning costs nothing; distillation via a pluggable "fact agent" command (default `hermes -z … --usage-file` so every cold-path token is accounted for); React + Vite dashboard; Python plugin using stdlib `urllib` only (no new Hermes deps).

Why TS for the service: same stack and ops patterns as ASF (compose, registry-owns-DB, `secret://`, setup.sh), and it's where Jon is fastest. Why Python for the plugin: that's the only language Hermes plugins come in.

---

## 0. What "MVP" means here

**In:**
1. Brief — relevant facts + code locations + likely tests for a task, injected before the agent starts.
2. Facts — `remember` by hand; `distill` from past sessions; `verify` each fact's anchors against the repo.
3. Search — keyword (Postgres FTS/BM25-ish) and meaning (pgvector) across facts, session history, docs, and raw conversation.
4. Global facts — scope `global` applies in every repo; scope `repo:<key>` otherwise.
5. Non-code docs — `.md`, `.pdf`, `.docx`, `.xlsx`, `.pptx` under each repo's `docs/`.
6. Dashboard — web UI: facts by scope/status, review queue, provenance view, search.
7. Multi-instance — N Hermes instances, each identified by user + instance, sharing one store with a review gate before anything reaches shared scope.
8. **Token accounting** — every LLM call the hive makes is logged with cost; an experiment harness measures tokens-to-answer with vs. without the hive.

**Out (explicitly deferred):**
- Code graph / impact analysis / dead-code (Entire Graph). MVP does file-level locus via `git ls-files` + ripgrep anchors. See §8 for the cheap path to add Graph later.
- Teams, Entra SSO, RBAC beyond one shared bearer token per instance. Scope model is present; enforcement is "token can read everything, write only to its own personal scope + propose to shared."
- ASF deploy seam / auto-recording built things. ASF integration is one webhook in M5.
- Nightly synthesis digest. Contradiction detection stays manual (review queue shows "similar existing fact").
- Graph visualization. Dashboard is lists + detail pages.

---

## 1. Repo and layout

New repo `~/dev/hive` (name is still open — see §9). Not inside ASF; depends on nothing in ASF.

```
hive/
  docker-compose.yml          # postgres(pgvector), hive, ollama (optional, profile)
  .env.example
  package.json                # pnpm workspace
  apps/
    hive/                     # Fastify service + jobs
      src/
        index.ts
        config.ts
        db/ (schema.ts, migrate.ts, migrations/)
        routes/ (health.ts, episodes.ts, facts.ts, search.ts, brief.ts, review.ts, docs.ts, repos.ts)
        jobs/ (distill.ts, verify.ts, ingest-repo.ts, ingest-docs.ts, embed.ts)
        search/ (fts.ts, vector.ts, hybrid.ts)
        agent/ (fact-agent.ts, prompts/distill.md, prompts/brief.md)
        auth.ts
      test/
    web/                      # React dashboard (Vite), served by hive at /
  plugins/
    hive/                     # Python MemoryProvider plugin (dir name = provider name)
      plugin.yaml
      __init__.py
      README.md
      tests/
  scripts/ (setup.sh, dev.sh, experiment/)
  docs/ (API.md, DATA-MODEL.md, EXPERIMENT.md)
```

---

## 2. Data model (Postgres)

Keep the glossary's Episode → Claim → Page chain, but **no Pages in MVP**: a fact *is* the unit the agent reads. Pages come when fact count makes them necessary.

```sql
-- who is talking
instances   (id, name, user_id, token_hash, created_at, last_seen_at)

-- immutable evidence
episodes    (id, kind ENUM('turn','session','repo_snapshot','doc','asf_run'),
             instance_id, user_id, session_id, repo_key, ref,        -- ref = commit sha / doc path / run id
             content TEXT, content_tsv TSVECTOR, embedding VECTOR(768),
             metadata JSONB, created_at)

-- governed unit
facts       (id UUID, text TEXT, kind ENUM('decision','invariant','gotcha','preference','convention','system'),
             scope TEXT,            -- 'global' | 'repo:<key>' | 'personal:<user_id>'
             locus TEXT[],          -- paths/globs/symbols this applies to
             origin ENUM('authored','distilled','ingested'),
             status ENUM('candidate','active','superseded','retracted'),
             confidence REAL, supersedes UUID NULL,
             author_user_id, author_instance_id,
             valid_from TIMESTAMPTZ, valid_to TIMESTAMPTZ NULL,
             recorded_at TIMESTAMPTZ, expired_at TIMESTAMPTZ NULL,
             content_hash TEXT UNIQUE,              -- dedupe: content-derived id (EB pattern)
             text_tsv TSVECTOR, embedding VECTOR(768))

-- provenance: a fact points at ≥1 anchors
anchors     (id, fact_id, episode_id NULL, repo_key, commit_sha NULL, path NULL, line_start NULL, line_end NULL,
             quote TEXT NULL,                       -- the exact text the fact was derived from
             verify_status ENUM('unverified','verified','drifted','missing','unverifiable_here'),
             verified_at)

-- repos the hive knows
repos       (key PRIMARY KEY, local_path, remote_url, default_branch, last_ingested_sha, last_ingested_at)

-- docs chunks (from docs/ + README + md anywhere)
doc_chunks  (id, repo_key, path, chunk_index, content, content_tsv, embedding, sha, ingested_at)

-- review decisions
reviews     (id, fact_id, reviewer_user_id, action ENUM('approve','fix','reject'), note, new_text NULL, created_at)

-- every LLM call the hive makes
llm_calls   (id, job ENUM('distill','brief','embed','verify'), model, input_tokens, output_tokens,
             cached_tokens, est_cost_usd, duration_ms, episode_id NULL, created_at)
```

Rules encoded in the service, not the DB:
- `origin=ingested` → `status=active` immediately (ground truth). `verify` failing moves it to `retracted` with a note.
- `origin∈{authored,distilled}` and `scope=personal:*` → `active` immediately (your notes are yours).
- `origin∈{authored,distilled}` and `scope∈{global, repo:*}` → `candidate` until a review `approve`s it. One curator (Jon) approves in MVP.
- Retract cascades: facts whose only anchor is a purged episode are retracted too.

---

## 3. HTTP API (the contract the plugin and dashboard both use)

Bearer token per instance. All JSON.

```
GET  /health
POST /v1/episodes                 # sync_turn / session end: {kind, session_id, repo_key?, content, metadata}
POST /v1/facts                    # remember: {text, kind?, scope, locus?, anchors?} -> fact (status per rules)
GET  /v1/facts?scope=&status=&repo_key=&q=
POST /v1/facts/:id/retract
POST /v1/facts/:id/review         # {action: approve|fix|reject, new_text?, note}
GET  /v1/recall?q=&repo_key=&k=10&scope=global,repo:x,personal:u   # facts only, hybrid, <200ms target
GET  /v1/search?q=&source=fact|history|doc|conversation|all&k=20   # everything
POST /v1/brief                    # {task, repo_key, changed_paths?} -> {facts[], locations[], tests[], gotchas[]}
POST /v1/repos                    # register {key, local_path|remote_url}
POST /v1/repos/:key/ingest        # enqueue ingest (docs + file index + git log)
POST /v1/jobs/distill             # {session_id?|episode_ids?|since?} enqueue
POST /v1/jobs/verify              # {repo_key?} enqueue
GET  /v1/stats                    # counts by scope/status/origin; llm_calls cost rollup
GET  /v1/review/queue             # candidates with "similar existing" hints
```

Hot path (`/v1/recall`, `/v1/brief` without `--llm`) is pure SQL: FTS + vector + scope filter + RRF merge. No model calls. Measured in M1 with `autocannon`, target p95 < 200 ms on 10k facts.

---

## 4. Hermes plugin (`plugins/hive`)

Implements `agent.memory_provider.MemoryProvider` (Hermes' seam; see `~/.hermes/hermes-agent/agent/memory_provider.py`). Modeled on the bundled `retaindb` plugin: background thread, write-behind queue, never block a turn.

| Hook | What it does |
|---|---|
| `is_available()` | `HIVE_URL` + `HIVE_TOKEN` set |
| `initialize()` | read `hermes_home`, `user_id`, `agent_context`; detect current repo key from cwd (`git remote get-url origin` → `gh/<owner>/<repo>`); skip writes when `agent_context != "primary"` |
| `system_prompt_block()` | static: "You have a shared team memory. Cite facts by id. Use `hive_remember` for durable decisions…" |
| `queue_prefetch(q)` / `prefetch(q)` | background `GET /v1/recall` with scopes `global, repo:<key>, personal:<user>`; returns a compact block `[hive:fact:<id8>] text (scope, verified)` — **this is the token-saving injection** |
| `sync_turn()` | `POST /v1/episodes {kind:'turn'}` from a queue thread |
| `on_session_end(messages)` | `POST /v1/episodes {kind:'session'}` then `POST /v1/jobs/distill {episode_id}` |
| `on_memory_write()` | mirror MEMORY.md/USER.md writes as `scope=personal` facts |
| `get_tool_schemas()` | `hive_recall`, `hive_remember`, `hive_brief`, `hive_search`, `hive_review`, `hive_status` |
| `recall_status()` | count injected last turn (shows up in the CLI indicator) |

Config via `hermes memory setup` schema: `HIVE_URL`, `HIVE_TOKEN` (secret), `HIVE_DEFAULT_SCOPE` (`repo`|`global`).

Install path for any Hermes instance: `hermes plugins install <path-or-git>` then `memory.provider: hive` in config.yaml. Documented in the plugin README with the three commands and nothing else.

---

## 5. Milestones

Each milestone ends with something Jon can run. Estimates are focused-work days, not calendar.

### M0 — Skeleton (1–2 d)
- Repo, pnpm workspace, compose with `pgvector/pgvector:pg16`, Fastify `/health`, migrations runner, `instances` table + bearer auth, `.env.example`, `scripts/setup.sh` (generate token, bring stack up, print `HIVE_URL`/`HIVE_TOKEN`).
- **Verify:** `docker compose up -d && curl -H "Authorization: Bearer $T" :8800/health` → `{ok:true, db:"up"}`. Second instance token works; bogus token 401.

### M1 — Facts + episodes + hybrid search (2–3 d)
- `episodes`, `facts`, `anchors` tables. `POST /v1/facts` (remember) with content-hash dedupe + scope rules. `POST /v1/episodes`. FTS via `tsvector` + GIN; embeddings via Ollama `nomic-embed-text` in an `embed` job (facts and episodes embedded async; search degrades to FTS-only until embedded — EB's "lexical must always work" rule). `GET /v1/recall` and `/v1/search` with RRF merge, scope filter.
- **Verify:** seed 50 facts from `DESIGN-NOTES.md` by script; `recall?q="who owns payments"` returns the right one by FTS and by a paraphrase (vector). `autocannon` p95 < 200 ms. Unit tests for scope rules and dedupe.

### M2 — Hermes plugin (2 d)
- Plugin per §4, with a stdlib-only HTTP client and a write-behind queue. Tests with a fake HTTP server (pytest, pattern from `tests/agent/test_memory_provider.py`).
- Install on THIS Mac's Hermes and on the Mac Studio's Hermes; both point at the Studio.
- **Verify:** instance A runs `hive_remember "we deploy to Cloud Run"` (scope global → candidate). Curator approves via `curl`. Instance B's next turn shows `[hive:fact:…]` in prefetch and the agent cites it. `hermes memory status` shows provider active.
- **As built:** no write-behind queue: Hermes already runs `sync_turn` on its own background worker (after secret redaction), so a second queue only added failure modes. Prefetch got a strict gate (`min_sim` 0.62, tuned on the seed facts: all relevant hits kept, noise 77 → 14 of 91) and once-per-session injection, because Hermes replays the injected block on every later request. Approve-by-curl moved to M4 with the review endpoint; verified instead: member `hive_remember` → candidate, curator-authored facts → recalled and cited by a real `hermes -z` session (`scripts/e2e-plugin.sh`).

### M3 — Repo + docs ingest, locus, verify (3 d)
- `repos` registration; `ingest-repo` job: `git ls-files`, README/`docs/**`, `git log --since` → `repo_snapshot` episodes + `doc_chunks`. Doc extraction: `.md` native, `.pdf` via `pdftotext` (poppler, already on the Mac), `.docx` via `mammoth`, `.xlsx` via `xlsx`, `.pptx` via `pptx-parser` (or shell to `soffice --convert-to txt`). Scanned PDF → "no text layer", indexed as nothing (EB behavior).
- `verify` job: for each anchor with `path`+`quote`, re-read at `HEAD` of `repos.local_path`; `verified` if quote still present at/near the line, `drifted` if elsewhere in file, `missing` if gone; authored facts without anchors → `unverifiable_here`. Missing on an `ingested` fact → retract.
- Locus: `remember` and `distill` accept/derive `locus[]`; `recall` boosts facts whose locus overlaps `changed_paths` (from `git status --porcelain` in the plugin).
- **Verify:** register `~/dev/agentic-software-factory`; ingest; `search?q=GATE_POLICY&source=doc` hits the settings doc. Edit a quoted line → `verify` flips the anchor to `drifted`; `git checkout` → `verified`.
- **As built:** Office files are read by unzipping their XML (fflate) instead of mammoth/xlsx/pptx-parser or soffice: one small dependency, no network, speaker notes included. Commits are `commit` episodes (one per commit, searchable as `source=commit`) rather than a single `repo_snapshot`. Ingest reads git blobs at the default branch's tip (origin's default as last fetched, so a checkout on a feature branch doesn't change what the hive serves; incremental by blob sha); verify reads the working tree, which is what the plan's edit → drifted → checkout check needs. Semantics changed slightly: a quote found elsewhere in the file is still `verified` (with a "moved from line A to B" note); `drifted` means the quote itself was edited (≥60% similar passage remains). Live on ASF: 36 docs → 369 chunks + 49 commits in 0.4 s; `GATE_POLICY` only exists in an untracked `.hermes/plans` file, so the search hit the gate docs (`docs/plan.md`, `docs/IMPLEMENTATION_PLAN.md`) instead; the edit/checkout check passed. A live run caught `git checkout`'s delete-then-write window reporting `missing`: verify now re-checks after 1 s, and ingested facts retract only after two missing passes.

### M4 — Distill (cold path) + review queue + dashboard (3–4 d)
- `fact-agent.ts`: pluggable command, default `hermes -z "<prompt>" --usage-file <tmp>` (subscription-billed, cost captured), alt `claude -p`, alt Ollama. Prompt is EB's gate adapted: durable / useful weeks later / not already in README or code / resolved not pending; max 5 facts per chunk; **default output: nothing**. Output JSON facts with `quote` anchors into the source episode. Every run writes `llm_calls`.
- Dedupe on write against existing facts by hash, then by vector similarity > 0.92 → attach as extra anchor to the existing fact instead of a new candidate (M0 pattern).
- `GET /v1/review/queue` with "similar existing fact" hints. Review endpoint.
- Dashboard (React): Facts (filter scope/status/origin/kind, detail with anchors + verify status + supersedes chain), Review queue (Approve / Fix / Reject inline), Search, Repos, Stats (fact counts, cost rollup from `llm_calls`). Served at `/` by the hive.
- **Verify:** end a real Hermes session that contained a decision; within a minute the queue shows a candidate quoting the turn; approve; it's recalled by another instance. Dashboard shows the cost of that distill.
- **As built (review API, #7):** `GET /v1/review/queue` (oldest first, anchors with episode snippets, up to 3 similar active facts at cosine ≥ 0.85 in the same scope or `global`) and `POST /v1/facts/:id/review` (approve / fix / reject, each a `reviews` row), curator only. Fix re-embeds; a fix whose text already exists merges into that fact (anchors move, candidate retracted), or is a 409 if that fact is retracted/superseded. `remember` takes `supersedes`: the old fact becomes `superseded` when the new one is active (at once for a curator, on approve for a member); `GET /v1/facts/:id` returns the chain both ways. Verified against a locally run service (keyword-only, no Ollama): member remember → candidate, not recalled; curator approves over HTTP; another instance's recall returns it.
- **As built (distill queue, #9):** a `worker` role and an AES-GCM encrypted agent credential (`PUT /v1/settings/agent-credential`, curator). A trigger enqueues a `distill_jobs` row for every `session` / `asf_run` episode (no backfill). The worker long-polls `POST /v1/worker/distill/claim` (lease, 3 attempts), then completes (quote must be in the episode; scope `global`, the episode's repo, or the episode user's personal; dedupe by hash then cosine > 0.92 → extra anchor; one `llm_calls` row) or fails the job. Distilled facts are always `candidate`, personal ones included (unlike §2), and the review queue now hides other users' personal scopes. The worker container and prompt are not built yet.
- **As built (hive-worker, #10):** `apps/worker`, a `hive-worker` compose service (no runtime deps). Runners: `claude -p --output-format json --max-turns 1` (default; model `HIVE_DISTILL_MODEL`, default `claude-sonnet-5-5`), Ollama `/api/chat`, and `hermes -z` (host only). The claude child gets only `CLAUDE_CODE_OAUTH_TOKEN`; the other billing variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, Bedrock/Vertex) are stripped, and `claude auth status` must report `oauth_token` once per credential or the job fails without a model call. Prompt `prompts/distill.md` (`distill-v1`, now `distill-v2`: see #11). Transcripts split at `user: ` turns, about 12k tokens per chunk, with one turn of overlap. Facts are deduped by text, at most 20 per job, usage summed. A prompt-version mismatch fails the job; a 409 is logged and skipped; a 503 (no credential) backs off 30 s. Personal-scope distill is not done (the claim carries no user). `scripts/setup.sh` mints the worker token into `.env`. Unit-tested with fakes; the live check (decision session → candidate + `llm_calls` row) is still to be run on a host with Docker and a credential.
- **As built (distill eval, #11):** `scripts/eval-distill.sh` scores the worker's distill over 15 labelled windows of real Hermes sessions (`scripts/eval-distill/cases`, 7 that should yield nothing), matching facts to labels with a claude judge (embedding similarity could not separate restatements from different facts). `distill-v2` (stricter "settled, durable, not in the code" bar; repo scope by default when there is a repo) plus worker-side quote repair (re-escaping quotes taken from tool-call arguments, longest verbatim run of ≥ 6 words and half the quote) and a tolerant JSON reader. Over 3 runs each: v1 found 79–86%, 1.33–3.0 false positives per 5 sessions, 5–6 invalid quotes; v2 found 93%, 0–0.33 per 5, 0 invalid quotes.
- **As built (acceptance, #15):** `scripts/e2e-distill.sh` runs the M4 verify on the real stack: profile A (`hermes -z` in the ASF checkout) states a decision with a random port; the job must be claimed and a candidate anchored to A's session, quoting the turn, must be in the review queue within 60 s of the session's end; the curator approves (over HTTP, or in the dashboard with `--manual`); profile B, without tools, must answer with the port and `[hive:<id>]`. The distill's cost comes from `GET /v1/stats?episode_id=` (the episode's own `llm_calls`, so B's distill and other sessions don't skew it). Probe facts, jobs, episodes, tokens and profiles are removed on exit; the `llm_calls` rows stay. Run on the Mac Studio (2026-11-02, Ollama embeddings on): claimed 0 s and candidate 5 s after the session's end; approve 0 s (HTTP); recall 4 s (B's whole `hermes -z` turn, which answered with the port and `[hive:82dc964e]`); distill model claude-sonnet-5-5, 6,224 input / 142 output / 10,631 cached tokens, $0.0284, 3,540 ms. B's own session was distilled too ($0.0270, no facts), so one run costs about $0.055 in distills plus the two Hermes turns.

### M5 — Brief + experiment harness + ASF hook (2–3 d)
- `POST /v1/brief {task, repo_key, changed_paths}`: facts (recall), locations (FTS over `doc_chunks` + file index for the task's nouns), tests (files matching `*test*` near matched locations), gotchas (facts kind=gotcha for the locus). Pure SQL by default; `--llm` option to rewrite into prose is off in MVP. Plugin injects a brief on the first turn of a session when a repo is detected.
- `scripts/experiment/`: `questions.json` (≈15 questions about ASF: who owns / how do I call / why did we / where is), `run.sh` runs each through `hermes -z --usage-file` twice — provider off, provider on — and writes `results.csv` (tokens in/out, est cost, correct Y/N by a rubric, cited fact ids). `report.py` prints the comparison. This is the PoC's deliverable: **a number**.
- ASF hook: on ASF run completion, ASF POSTs `{kind:'asf_run', repo_key, ref, content: plan.md+review.md}` as an episode; distill picks it up like any session. One webhook, no ASF code beyond a settings key and a `fetch`.
- **Verify:** `report.py` shows tokens and correctness for both arms. Whatever the number is, that's the result.

#### What a person reviews (revised 2026-11-07)

The first backfill of 41 ASF runs produced 64 granular candidates (about 2 per run), almost all of them details of
bot-written plans. Nobody can review that, and it isn't what's worth remembering. All 64 were rejected; the rule from
here on:

- **Bot-written work is trusted history, not candidates.** An ASF run whose PR merged is stored as one *run record*
  (ticket, approved plan, review, PR link, merge time), searchable as `history` and offered by the brief. It is never
  distilled. The plan was approved by a person at the `after_plan` gate and the merged PR is what happened, so it needs
  no second review; a newer run on the same files outranks an older one. Unmerged runs aren't sent.
- **The review queue is for what a person said to a bot.** A candidate must quote a *human* turn in which the person
  corrected, clarified, redirected or decided something ("no, do X", "always ...", "call it ...", "I'd rather ...").
  An assistant's reasoning, plan or summary can't produce a fact on its own. Each candidate shows the exchange it came
  from (the bot's proposal and the person's reply). Sources: Hermes sessions, ASF gate notes and ASF run chat
  (`asf_dialog` episodes).
- **"Remember this" is a request, not a hint.** When a person says remember this / add this to memory / make sure to
  remember / don't forget / note that / from now on (and variants), the plugin flags the turn and Hive distills it at
  once with the previous turn as context. The result is active immediately in personal scope or when the person is a
  curator; a member's shared-scope request goes to the top of the queue marked *asked to remember*. The agent is also
  told to call `hive_remember` and confirm what it saved; Hive dedupes the two.

Issues: #56 (run records), #57 (human-anchored distill + `asf_dialog`), #58 (remember requests),
bennybrau/agentic-software-factory#78 (ASF sends merged runs and the dialog). The experiment (#20, #22) runs after
#56 and #58, since they change what the Hive knows.

- **As built (remember requests, #58):** the plugin flags a turn whose user text asks to remember something
  (`metadata.remember_request`, quoted text and questions like "do you remember…?" ignored) and tells the agent to call
  `hive_remember` (WP9a). A flagged turn queues a priority-1 distill job; the worker distills it with the previous turn
  as context into one `authored` fact marked `metadata.asked`, active for a curator or in personal scope, a candidate
  otherwise; what the agent already remembered in that turn is deduped into it (WP9b). The review queue lists asked
  candidates first and the dashboard marks them *asked to remember*, in the row and the evidence pane (WP9c).
  `scripts/e2e-remember.sh` checks it on the real stack (curator → one active asked fact; member → first in the queue;
  one fact even when the agent called `hive_remember`; a "do you remember…?" turn makes no job and no fact). Not run
  live yet: the host that built WP9c had no Docker, Hermes or credential.

### M5b — Learn like Hermes: cheaper, cleaner learning
The M5 experiment ([results](EXPERIMENT_RESULTS.md), 2026-11-07): with the Hive, answers were 17% cheaper and more
often right (85% vs 75%), but distilling every session cost more than that saved (net −$0.91 over 48 questions).
Decision: change, not stop. [M5B_LEARNING_LOOP.md](M5B_LEARNING_LOOP.md) cuts the distill cost (skip question-only
sessions, read only quotable text, call the model without Claude Code's default overhead), adopts Hermes's
self-improvement rules (rules not stories, a don't-save list, corrections replace facts, playbooks, use counts and
retirement), and re-runs the experiment twice. Hermes itself is not changed. Milestone https://github.com/bennybrau/hive/milestone/8, issues
#73–#80.

### M6 — Harden for other people (1–2 d)
- `setup.sh` on the Mac Studio (compose up, Ollama model pull, create curator + N instance tokens, print install snippet for each Hermes). Tailscale or LAN URL. Backup = `pg_dump` cron.
- Secret scrub on the plugin side is already done by Hermes before `sync_turn`; document it. `HIVE_NO_SYNC=1` kill switch.

Total: ~15–18 focused days for M0–M6.

---

## 6. Token-cost thesis and how M5 tests it

Where the hive is supposed to save tokens:
1. **Prefetch replaces exploration.** An agent asked "how do gates get relaxed in ASF" without the hive reads `settings.ts`, grep output, maybe a doc — 5–30k input tokens. With the hive it gets 3 facts (≈300 tokens) and maybe opens one file.
2. **Extraction is once, cold, and shared.** The LLM pass that produces a fact runs once per episode on the Studio, not once per developer per session.
3. **Count is a cost.** Recall returns ≤10 facts, locus-boosted. If prefetch is bloating prompts, that shows in the experiment as higher input tokens on the "on" arm — the harness would catch that.

Measure: `hermes --usage-file` per question, both arms, same model. Also record hive-side `llm_calls` cost over the same period so the comparison is honest: *per-question savings × questions − cold-path spend*.

---

## 7. How the Entire Brain feature list maps

| EB feature | MVP | Where |
|---|---|---|
| Brief before a task | yes | M5 `/v1/brief` + plugin first-turn injection |
| Remember by hand / distill from sessions / verify anchors | yes | M1 `remember`, M4 `distill`, M3 `verify` |
| Search facts/history/docs/conversations by keyword or meaning | yes | M1 `/v1/search` sources: fact, history (session episodes), doc, conversation (turn episodes) |
| Code find / impact / regressions (Graph) | **no** | file-level locus only; §8 |
| Terminal dashboard / offline graph view | partial | web dashboard M4; no graph view |
| Global facts | yes | `scope=global`, labelled `(global)` in prefetch |
| PDF / Word / Excel / PowerPoint under docs/ | yes | M3 ingest-docs |
| Workspaces (multi-repo) | yes, implicitly | one hive, many `repo_key`s, recall unions global + current repo |
| Webhooks on fact change | cheap, M4 | `fact.recorded/retracted` POST, HMAC signed, for ASF/Slack later |

What the MVP has that EB doesn't: many instances, one store; review gate between personal and shared scope; cost ledger.

---

## 8. Code graph later (the deferred piece)

Options when it's time, cheapest first:
1. **Run Entire Graph as an external ingester.** `entire graph` is MIT and emits JSON records. A `jobs/ingest-graph.ts` that shells to it per repo and stores symbol → file/line as `locus` metadata would give "find code" and "what references X" without writing a parser. Impact analysis comes along.
2. `ctags`/tree-sitter directly in Node (`web-tree-sitter`) for symbol index only.
3. Build nothing; keep ripgrep anchors.

Decide after M5 shows whether the agents actually ask code-structure questions or mostly "why/who/how".

---

## 9. Decisions (settled Oct 27, 2026)

1. **Repo:** `github.com/bennybrau/hive` (private). Product name still open; `hive` is the working name.
2. **Postgres:** separate compose stack from ASF. Never share ASF's instance.
3. **Fact agent default:** ~~`hermes -z` on the host~~ → **revised (M4 planning):** `claude -p` inside a `hive-worker` container, on a Claude subscription OAuth token (`claude setup-token`) that a curator stores through the API and the worker receives per job. Cost captured per call into `llm_calls`. Ollama and API-key runners stay pluggable; `hermes -z` remains a host-only runner.
3a. **Shipped as images, runs anywhere:** Hive is installed as published images (`ghcr.io/bennybrau/hive`, `hive-worker`, multi-arch), never from source, the same way ASF ships `asf-*`; together they form one platform that runs on any Docker host, including a cloud VM. Implications: config and secrets from env / `*_FILE`, stateless service containers, Postgres local or managed (pgvector), repos registered by URL and cloned into a volume (the `~/dev` mount stays a developer option), Ollama as an optional container, HTTPS via a Caddy profile or the host's load balancer. Tracked in M6: #23 images, #24 install.sh, #30 platform compose, #31 repos by URL, #32 cloud readiness.

Milestones and issues for M4–M6: https://github.com/bennybrau/hive/milestones
4. **Embeddings:** local Ollama `nomic-embed-text` on the Mac Studio.
5. **Curator:** Jon, alone, for all shared-scope candidates in the MVP.
6. **Experiment corpus:** the ASF repo (`agentic-software-factory`), its docs, and Jon's past Hermes sessions on it; the ~15 questions are about ASF.

## 10. First concrete steps (M0)

1. `mkdir ~/dev/hive && git init`; pnpm workspace; `apps/hive` Fastify hello; `docker-compose.yml` with pgvector.
2. Migration 0001: `instances`, `episodes`, `facts`, `anchors`, `repos`, `doc_chunks`, `reviews`, `llm_calls` (all at once; cheap now).
3. Bearer auth middleware + `scripts/setup.sh` that mints the first token.
4. `curl /health` green from this Mac against the Studio over Tailscale.
5. Stub plugin that only implements `is_available` + `initialize` + `hive_status` tool hitting `/health`, so the Hermes side is wired on day one.
