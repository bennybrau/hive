-- 0014: playbooks. A short procedure for a class of task: when it applies (path globs, task words), its steps and
-- pitfalls ([{text, fact_ids}]). Shared scopes only. Editing inserts a new active row that supersedes the old one.
create table playbooks (
  id              uuid primary key default gen_random_uuid(),
  scope           text not null check (scope = 'global' or scope like 'repo:%'),
  title           text not null,
  applies_paths   text[] not null default '{}',
  applies_words   text[] not null default '{}',
  steps           jsonb not null default '[]',
  pitfalls        jsonb not null default '[]',
  status          text not null default 'active' check (status in ('active', 'superseded', 'retracted')),
  supersedes      uuid references playbooks(id),
  author_user_id  text,
  created_at      timestamptz not null default now()
);

create index playbooks_scope_status_idx on playbooks (scope, status);
