-- 0018: a curator moves an active fact to another level (curate action 'move').
alter table reviews drop constraint reviews_action_check;
alter table reviews add constraint reviews_action_check
  check (action in ('approve', 'fix', 'reject', 'keep', 'retire', 'pin', 'unpin', 'move'));
