-- 0005: a `worker` role (the fact-agent container) and encrypted service settings.

alter table instances drop constraint instances_role_check;
alter table instances add constraint instances_role_check check (role in ('member', 'curator', 'worker'));

-- one row per setting; value_enc is AES-256-GCM (iv | tag | ciphertext) under HIVE_SECRET_KEY
create table settings (
  key             text primary key,
  value_enc       bytea not null,
  set_at          timestamptz not null default now(),
  set_by_user_id  text not null
);
