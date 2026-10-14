-- 0028_block_personal_invites.sql
--
-- The personal zone is 100% private: it can never be shared. App code refuses
-- to create/accept invites for a personal org (src/lib/workspaces/orgs.ts);
-- this trigger is the cheap DB-level backstop.

create or replace function reject_personal_zone_invite()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from workspaces w
    where w.organization_id = new.organization_id and w.is_personal
  ) then
    raise exception 'cannot_invite_personal: the personal zone is private and cannot be shared';
  end if;
  return new;
end;
$$;

drop trigger if exists reject_personal_zone_invite on workspace_invites;
create trigger reject_personal_zone_invite
  before insert on workspace_invites
  for each row execute function reject_personal_zone_invite();
