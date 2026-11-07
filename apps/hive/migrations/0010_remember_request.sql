-- 0010: a turn the user flagged ("remember this") is distilled at once. Such a turn episode carries
-- metadata.remember_request = true; it gets a priority-1 job, claimed before any older priority-0 job.
-- facts.metadata holds per-fact flags; `asked` = a person asked for this fact to be remembered.

alter table facts add column metadata jsonb not null default '{}'::jsonb;
alter table distill_jobs add column priority smallint not null default 0;
create index distill_jobs_priority_idx on distill_jobs (status, priority desc, created_at);

create or replace function enqueue_distill_job() returns trigger language plpgsql as $$
begin
  insert into distill_jobs (episode_id, priority)
    values (new.id, case when new.kind = 'turn' then 1 else 0 end)
    on conflict (episode_id) do nothing;
  return new;
end;
$$;

drop trigger episodes_enqueue_distill on episodes;
create trigger episodes_enqueue_distill
  after insert on episodes
  for each row when (new.kind = 'session' or (new.kind = 'turn' and new.metadata->>'remember_request' = 'true'))
  execute function enqueue_distill_job();
