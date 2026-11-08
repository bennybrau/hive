-- 0014: curating stale facts. pinned = never stale; kept_at = a curator confirmed it is still true, so its idle time
-- restarts. Curate decisions are reviews rows too.
alter table facts
  add column pinned boolean not null default false,
  add column kept_at timestamptz;

alter table reviews drop constraint reviews_action_check;
alter table reviews add constraint reviews_action_check
  check (action in ('approve', 'fix', 'reject', 'keep', 'retire', 'pin', 'unpin'));
