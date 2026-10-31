-- 0003: repos, doc ingest, commits, verify.

-- repos: when registered, the last ingest's outcome
alter table repos
  add column registered_at  timestamptz not null default now(),
  add column ingest_summary jsonb,
  add column ingest_error   text;

-- one row per ingested document file: incremental re-ingest skips files whose git blob is unchanged,
-- and files we couldn't read (scanned PDF, too big) are recorded with why
create table doc_files (
  repo_key     text not null references repos(key) on delete cascade,
  path         text not null,
  blob_sha     text not null,
  status       text not null check (status in ('indexed', 'empty', 'skipped', 'error')),
  note         text,
  chunks       integer not null default 0,
  ingested_at  timestamptz not null default now(),
  primary key (repo_key, path)
);

-- chunks remember where in the (extracted) text they came from, for citing
alter table doc_chunks
  add column line_start integer,
  add column line_end   integer;
create index doc_chunks_repo_path_idx on doc_chunks (repo_key, path);

-- commits are evidence: searchable ("why did we move to X?"), one episode per commit
alter table episodes drop constraint episodes_kind_check;
alter table episodes add constraint episodes_kind_check
  check (kind in ('turn', 'session', 'repo_snapshot', 'doc', 'asf_run', 'commit'));
create unique index episodes_commit_uniq on episodes (repo_key, ref) where kind = 'commit';

-- verify: where the quote was found this time, and why the status is what it is
alter table anchors
  add column found_line  integer,
  add column verify_note text;
create index anchors_repo_path_idx on anchors (repo_key, path) where path is not null;
