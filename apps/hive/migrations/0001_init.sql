-- 0001: full MVP schema in one go (cheap now; see docs/MVP-PLAN.md §2).
-- Embeddings are 768-d (Ollama nomic-embed-text) and nullable: keyword search must
-- work before (or without) an embedding.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- who is talking
create table instances (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  user_id      text not null,
  role         text not null default 'member' check (role in ('member', 'curator')),
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

-- repos the hive knows
create table repos (
  key                text primary key,              -- e.g. gh/bennybrau/agentic-software-factory
  local_path         text,
  remote_url         text,
  default_branch     text,
  last_ingested_sha  text,
  last_ingested_at   timestamptz
);

-- immutable evidence
create table episodes (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('turn', 'session', 'repo_snapshot', 'doc', 'asf_run')),
  instance_id  uuid references instances(id),
  user_id      text,
  session_id   text,
  repo_key     text,
  ref          text,                                -- commit sha / doc path / run id
  content      text not null,
  content_tsv  tsvector generated always as (to_tsvector('english', content)) stored,
  embedding    vector(768),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index episodes_tsv_idx on episodes using gin (content_tsv);
create index episodes_session_idx on episodes (session_id);
create index episodes_repo_idx on episodes (repo_key);

-- the governed unit
create table facts (
  id                  uuid primary key default gen_random_uuid(),
  text                text not null,
  kind                text not null check (kind in ('decision', 'invariant', 'gotcha', 'preference', 'convention', 'system')),
  scope               text not null check (scope = 'global' or scope like 'repo:%' or scope like 'personal:%'),
  locus               text[] not null default '{}',
  origin              text not null check (origin in ('authored', 'distilled', 'ingested')),
  status              text not null check (status in ('candidate', 'active', 'superseded', 'retracted')),
  confidence          real,
  supersedes          uuid references facts(id),
  author_user_id      text,
  author_instance_id  uuid references instances(id),
  valid_from          timestamptz not null default now(),
  valid_to            timestamptz,
  recorded_at         timestamptz not null default now(),
  expired_at          timestamptz,
  content_hash        text not null unique,           -- dedupe: content-derived identity
  text_tsv            tsvector generated always as (to_tsvector('english', text)) stored,
  embedding           vector(768)
);
create index facts_tsv_idx on facts using gin (text_tsv);
create index facts_scope_status_idx on facts (scope, status);
create index facts_locus_idx on facts using gin (locus);

-- provenance: a fact points at >= 1 anchors
create table anchors (
  id             uuid primary key default gen_random_uuid(),
  fact_id        uuid not null references facts(id) on delete cascade,
  episode_id     uuid references episodes(id),
  repo_key       text,
  commit_sha     text,
  path           text,
  line_start     integer,
  line_end       integer,
  quote          text,
  verify_status  text not null default 'unverified'
                 check (verify_status in ('unverified', 'verified', 'drifted', 'missing', 'unverifiable_here')),
  verified_at    timestamptz
);
create index anchors_fact_idx on anchors (fact_id);
create index anchors_episode_idx on anchors (episode_id);

-- docs chunks (docs/, README, markdown anywhere)
create table doc_chunks (
  id           uuid primary key default gen_random_uuid(),
  repo_key     text not null,
  path         text not null,
  chunk_index  integer not null,
  content      text not null,
  content_tsv  tsvector generated always as (to_tsvector('english', content)) stored,
  embedding    vector(768),
  sha          text,
  ingested_at  timestamptz not null default now(),
  unique (repo_key, path, chunk_index)
);
create index doc_chunks_tsv_idx on doc_chunks using gin (content_tsv);

-- review decisions
create table reviews (
  id                uuid primary key default gen_random_uuid(),
  fact_id           uuid not null references facts(id),
  reviewer_user_id  text not null,
  action            text not null check (action in ('approve', 'fix', 'reject')),
  note              text,
  new_text          text,
  created_at        timestamptz not null default now()
);

-- every LLM call the hive makes (the cost ledger)
create table llm_calls (
  id             uuid primary key default gen_random_uuid(),
  job            text not null check (job in ('distill', 'brief', 'embed', 'verify')),
  model          text,
  input_tokens   integer,
  output_tokens  integer,
  cached_tokens  integer,
  est_cost_usd   numeric(12, 6),
  duration_ms    integer,
  episode_id     uuid references episodes(id),
  created_at     timestamptz not null default now()
);
