-- 0002: vector indexes for meaning search, and a note on status changes (retract reason etc.).
-- HNSW + cosine to match nomic-embed-text; queries filter by scope/status, so the pool turns on
-- pgvector's iterative scan (see db/pool.ts) to keep filtered results from coming back short.

create index facts_embedding_idx      on facts      using hnsw (embedding vector_cosine_ops);
create index episodes_embedding_idx   on episodes   using hnsw (embedding vector_cosine_ops);
create index doc_chunks_embedding_idx on doc_chunks using hnsw (embedding vector_cosine_ops);

alter table facts add column status_note text;

-- the embed worker scans for "not yet embedded" rows
create index facts_unembedded_idx    on facts (recorded_at)   where embedding is null;
create index episodes_unembedded_idx on episodes (created_at) where embedding is null;
create index doc_chunks_unembedded_idx on doc_chunks (ingested_at) where embedding is null;
