-- 0007: webhooks on fact changes. A trigger on facts queues one delivery per subscribed, active webhook
-- in the same transaction as the write, so every path that changes a fact is covered. Personal-scope
-- facts never fire. The trigger is deferred to commit, so the payload is the fact as the transaction
-- left it (e.g. createFact sets `supersedes` after the insert). The in-process dispatcher (src/webhooks.ts) POSTs queued rows, HMAC-signed.

create table webhooks (
  id                  uuid primary key default gen_random_uuid(),
  url                 text not null,
  secret_enc          bytea not null,                -- AES-256-GCM under HIVE_SECRET_KEY
  events              text[] not null,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  created_by_user_id  text not null,
  failing_since       timestamptz,                   -- set when a delivery runs out of attempts; cleared by a 2xx
  last_error          text
);

create table webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  webhook_id       uuid not null references webhooks(id) on delete cascade,
  event            text not null,
  payload          jsonb not null,                   -- the fact as it was when the event happened
  status           text not null default 'queued' check (status in ('queued', 'delivered', 'failed')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default clock_timestamp(), -- distinct per row: recorded sorts before activated
  delivered_at     timestamptz
);
create index webhook_deliveries_due_idx on webhook_deliveries (status, next_attempt_at);
create index webhook_deliveries_webhook_idx on webhook_deliveries (webhook_id, created_at);

create function queue_fact_webhooks() returns trigger language plpgsql as $$
declare
  evs text[] := '{}';
  snapshot jsonb;
begin
  if new.scope like 'personal:%' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    evs := array['fact.recorded'];
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    evs := evs || case new.status
      when 'active' then array['fact.activated']
      when 'retracted' then array['fact.retracted']
      when 'superseded' then array['fact.superseded']
      else '{}'::text[]
    end;
  end if;
  if cardinality(evs) = 0 then
    return new;
  end if;
  select jsonb_build_object(
      'id', f.id, 'text', f.text, 'kind', f.kind, 'scope', f.scope, 'origin', f.origin,
      'status', f.status, 'status_note', f.status_note, 'supersedes', f.supersedes)
    into snapshot from facts f where f.id = new.id;
  if snapshot is null then
    return new;
  end if;
  insert into webhook_deliveries (webhook_id, event, payload)
    select w.id, e.event, snapshot
    from unnest(evs) with ordinality as e(event, n)
    join webhooks w on w.active and e.event = any(w.events)
    order by e.n;
  return new;
end;
$$;

create constraint trigger facts_queue_webhooks
  after insert or update of status on facts
  deferrable initially deferred
  for each row execute function queue_fact_webhooks();
