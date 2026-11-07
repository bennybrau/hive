-- 0008: every tracked file of a repo's default branch (not just documents), so a brief can point at
-- code paths and nearby tests with plain SQL. Filled by ingest; existing repos on their next ingest.

create table repo_files (
  repo_key  text not null references repos(key) on delete cascade,
  path      text not null,
  blob_sha  text not null,
  primary key (repo_key, path)
);
