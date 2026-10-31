-- 0006: distill job queue. Every session / asf_run episode gets one job; the fact-agent worker
-- claims it (lease), distills candidate facts, and completes or fails it. No backfill of old episodes.

create table distill_jobs (
  id           uuid primary key default gen_random_uuid(),
  episode_id   uuid not null unique references episodes(id),
  status       text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'failed', 'skipped')),
  attempts     int not null default 0,
  claimed_by   uuid references instances(id),
  lease_until  timestamptz,
  error        text,
  result       jsonb,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index distill_jobs_status_idx on distill_jobs (status, created_at);

create function enqueue_distill_job() returns trigger language plpgsql as $$
begin
  insert into distill_jobs (episode_id) values (new.id) on conflict (episode_id) do nothing;
  return new;
end;
$$;

create trigger episodes_enqueue_distill
  after insert on episodes
  for each row when (new.kind in ('session', 'asf_run'))
  execute function enqueue_distill_job();
