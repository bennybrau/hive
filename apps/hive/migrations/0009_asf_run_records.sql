-- 0009: an asf_run is a run record (searchable, listed in briefs), not distilled. Existing jobs and candidates stay.
drop trigger episodes_enqueue_distill on episodes;

-- The only list of distilled episode kinds.
create trigger episodes_enqueue_distill
  after insert on episodes
  for each row when (new.kind = 'session')
  execute function enqueue_distill_job();
