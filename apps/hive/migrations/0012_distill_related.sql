-- 0012: the active facts a claim sent the distiller as `related` (closest to the episode in its scopes). A distilled
-- candidate may name one as `replaces`; complete only accepts an id the claim sent.
alter table distill_jobs add column related_ids uuid[] not null default '{}';
