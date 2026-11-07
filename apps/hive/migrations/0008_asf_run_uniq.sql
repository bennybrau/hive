-- 0008: one asf_run episode per (repo, run). The API never accepted asf_run before, so no rows can clash.
create unique index episodes_asf_run_uniq on episodes (repo_key, ref) where kind = 'asf_run';
