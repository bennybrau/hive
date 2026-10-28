# Hive HTTP API (as built)

All `/v1/*` endpoints need `Authorization: Bearer <HIVE_TOKEN>`. JSON in, JSON out.
Who you are (instance, user, role) always comes from the token, never from the body.

## Health and status

- `GET /health` — public. `{ok, db, version}`; 503 when Postgres is down.
- `GET /v1/status` — `{instance, counts:{facts,episodes,instances,repos}, embeddings:{model, state: ok|error|off, error, backlog}}`.

## Facts

- `POST /v1/facts` — remember. Body `{text, kind, scope, repo_key?, locus?, anchors?}`.
  - `kind`: `decision | invariant | gotcha | preference | convention | system`
  - `scope`: `global`, `personal` (→ `personal:<your user>`), `repo` (needs `repo_key`), or `repo:<key>`.
    Writing to someone else's `personal:*` is a 400.
  - `anchors[]`: `{path, line_start, line_end, quote, commit_sha, repo_key, episode_id}` — provenance; checked by `verify` in M3.
  - Status on create: personal → `active`; shared by a curator → `active` (logged as a self-approve review);
    shared by a member → `candidate`.
  - Same text (case/whitespace-insensitive) in the same scope → `200 {deduped: true}` with the existing fact. New → `201`.
- `GET /v1/facts?scope=&status=&kind=&repo_key=&limit=&offset=` — list, newest first.
- `GET /v1/facts/:id` — fact plus its anchors.
- `POST /v1/facts/:id/retract` `{reason}` — author or curator only (403 otherwise). Kept as history.

Readable scopes for every call: `global`, all `repo:*` (or only `repo:<repo_key>` when given), and
your own `personal:<user>`. Other users' personal facts are never returned.

## Episodes (raw evidence)

- `POST /v1/episodes` `{kind: turn|session, session_id, content, repo_key?, ref?, metadata?}` → `201 {episode:{id, created_at}}`.
  Up to 5 MB (whole-session transcripts).

## Recall and search (hot path: SQL + one local query embedding, no LLM)

- `GET /v1/recall?q=&repo_key=&k=10&min_sim=` — active facts only. `{mode: hybrid|keyword, facts:[{...fact, anchors, score, matched:[keyword|meaning], similarity}]}`.
  `min_sim` is a strict gate (the plugin's prefetch uses 0.62): every hit, keyword matches included, must have
  cosine similarity ≥ `min_sim` to the question. Rows not embedded yet can't be judged and are kept.
  Keyword hits on embedded rows now report their `similarity` too.
- `GET /v1/search?q=&source=all|fact,conversation,history,doc&repo_key=&k=20&include_candidates=false` —
  `{mode, facts:[...], results:[{source, id, snippet, score, matched, similarity, session_id|path, ...}]}`.
  `conversation` = turn episodes, `history` = session episodes; both only YOUR user's episodes. `doc` fills in M3.

How ranking works:
- **Keyword:** Postgres English stemming, words OR-ed (a question matches facts containing some of its words), ranked by `ts_rank_cd`.
- **Meaning:** cosine similarity on 768-d `nomic-embed-text` vectors (HNSW index); hits below `HIVE_VECTOR_MIN_SIM` (0.55) are dropped.
- **Fusion:** reciprocal rank fusion (k=60) of the two lists.
- If Ollama is unreachable, `mode` is `keyword` and results still come back. Rows not yet embedded are keyword-findable.
