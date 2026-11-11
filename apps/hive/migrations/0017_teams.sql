-- 0017: teams. A team has members (a user is a member or a reviewer) and the repos it works on. Facts and playbooks
-- may live in team:<key> scope. Teams are an order of preference, not a wall: any token can read any team's facts.
create table teams (
  key         text primary key check (key ~ '^[a-z0-9-]+$'),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table team_members (
  team_key  text not null references teams(key) on delete cascade,
  user_id   text not null,
  role      text not null check (role in ('member', 'reviewer')),
  primary key (team_key, user_id)
);

create index team_members_user_idx on team_members (user_id);

create table team_repos (
  team_key  text not null references teams(key) on delete cascade,
  repo_key  text not null references repos(key),
  primary key (team_key, repo_key)
);

create index team_repos_repo_idx on team_repos (repo_key);

alter table facts drop constraint facts_scope_check;
alter table facts add constraint facts_scope_check
  check (scope = 'global' or scope like 'repo:%' or scope like 'personal:%' or scope like 'team:%');

alter table playbooks drop constraint playbooks_scope_check;
alter table playbooks add constraint playbooks_scope_check
  check (scope = 'global' or scope like 'repo:%' or scope like 'team:%');
