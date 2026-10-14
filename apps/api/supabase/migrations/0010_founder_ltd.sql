-- 0010_founder_ltd.sql
--
-- Founder LTD (P4-08): a one-time $199 lifetime-Pro license, capped at
-- 200 seats. Two pieces:
--
--   1. Extend the workspaces.plan check to include 'lifetime_pro'.
--   2. founder_ltd_sales — one row per successful sale, the source of
--      truth for the remaining-seats counter. The Stripe webhook inserts
--      here on checkout.session.completed for the LTD price.
--
-- We deliberately store sales in their own table (not just counting
-- workspaces.plan='lifetime_pro') so refunded/chargebacked sessions can be
-- soft-deleted without touching the workspace row.

alter table workspaces
  drop constraint if exists workspaces_plan_check;

alter table workspaces
  add constraint workspaces_plan_check
    check (plan in ('free', 'pro', 'team', 'business', 'lifetime_pro'));

create table if not exists founder_ltd_sales (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  stripe_session_id text not null unique,
  stripe_customer_id text,
  amount_usd_cents integer not null,
  status text not null check (status in ('paid', 'refunded')) default 'paid',
  created_at timestamptz default now(),
  refunded_at timestamptz
);

create index if not exists founder_ltd_sales_status_idx
  on founder_ltd_sales(status);
