-- 0015: one row per daily review digest (per local date). The scheduler claims a date by inserting its row.
-- A channel's status is null when that channel is off, otherwise 'pending' | 'sent' | 'failed'.
create table review_digests (
  id               uuid primary key default gen_random_uuid(),
  local_date       date not null unique,
  claimed_at       timestamptz not null default now(),
  sent_at          timestamptz,
  item_count       int not null default 0,
  email_status     text,
  email_error      text,
  telegram_status  text,
  telegram_error   text
);
