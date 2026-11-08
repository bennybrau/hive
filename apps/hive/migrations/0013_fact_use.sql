-- 0013: how often a fact is used. use_count = times a brief or recall returned it; cite_count = turns whose answer
-- cited it as [hive:<id>]; last_used_at = the latest of either.
alter table facts
  add column use_count int not null default 0,
  add column cite_count int not null default 0,
  add column last_used_at timestamptz;
