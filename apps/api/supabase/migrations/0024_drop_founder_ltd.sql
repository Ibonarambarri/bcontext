-- 0024_drop_founder_ltd.sql
--
-- Reverts 0010_founder_ltd.sql. The Founder LTD offer was retired:
--   1. Drop the founder_ltd_sales table.
--   2. Remove 'lifetime_pro' from the workspaces.plan check constraint.
--
-- If any workspace.plan='lifetime_pro' rows exist (shouldn't in this
-- environment, since the offer was retired before any sale), they get
-- migrated to 'pro' first so the new constraint can be applied.

drop table if exists founder_ltd_sales;

update workspaces set plan = 'pro' where plan = 'lifetime_pro';

alter table workspaces
  drop constraint if exists workspaces_plan_check;

alter table workspaces
  add constraint workspaces_plan_check
    check (plan in ('free', 'pro', 'team', 'business'));
