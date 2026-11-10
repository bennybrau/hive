-- 0016: the scheduler retries a day's failed channels a few times, a little later each time.
alter table review_digests
  add column attempts        int not null default 0,
  add column next_attempt_at timestamptz;
