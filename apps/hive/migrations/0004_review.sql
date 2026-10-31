-- 0004: review queue (oldest candidates first) and supersede chains (who replaced this fact?).

create index facts_candidates_idx on facts (recorded_at) where status = 'candidate';
create index facts_supersedes_idx on facts (supersedes);
