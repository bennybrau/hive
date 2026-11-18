-- 0019: when an instance's token was last rotated (POST /v1/instances/:id/rotate); null = never.
alter table instances add column rotated_at timestamptz;
