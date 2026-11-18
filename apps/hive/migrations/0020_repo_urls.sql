-- 0020: repos registered by URL. The hive clones them under HIVE_CLONES_ROOT and fetches before each ingest.
-- token_enc is a read-only access token encrypted under HIVE_SECRET_KEY; it is never returned.
alter table repos add column source text not null default 'path' check (source in ('path', 'url'));
alter table repos add column clone_url text;
alter table repos add column token_enc bytea;
alter table repos add column last_fetched_at timestamptz;
