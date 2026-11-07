-- 0011: an asf_dialog is what a person said to the software factory (a gate note on a plan, an answer to its question),
-- after the bot's text. One per (repo, ref); it is distilled at priority 0 (enqueue_distill_job from 0010 is unchanged).
alter table episodes drop constraint episodes_kind_check;
alter table episodes add constraint episodes_kind_check
  check (kind in ('turn', 'session', 'repo_snapshot', 'doc', 'asf_run', 'commit', 'asf_dialog'));

create unique index episodes_asf_dialog_uniq on episodes (repo_key, ref) where kind = 'asf_dialog';

drop trigger episodes_enqueue_distill on episodes;
create trigger episodes_enqueue_distill
  after insert on episodes
  for each row when (new.kind = 'session' or new.kind = 'asf_dialog' or (new.kind = 'turn' and new.metadata->>'remember_request' = 'true'))
  execute function enqueue_distill_job();
