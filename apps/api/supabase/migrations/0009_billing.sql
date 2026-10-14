-- 0009_billing.sql
--
-- Billing (P4-03): plan + seats + Stripe linkage on workspaces, plus a
-- monthly usage_counters table the enforcement layer reads against the
-- free-tier limits.
--
--   workspaces.plan           — 'free' | 'pro' | 'team' | 'business'
--   workspaces.seats          — number of paid seats (only meaningful for
--                                team/business)
--   workspaces.stripe_*       — Stripe customer + subscription pointers
--                                (set/cleared by the /api/webhooks/stripe
--                                handler)
--
--   usage_counters            — one row per (workspace, period, kind),
--                                period is the YYYY-MM bucket the AI query
--                                / node-creation event fell into. The enforce
--                                layer increments via upsert and reads to
--                                check limits.
--
-- Free-tier hard limits (server-enforced):
--   500 nodes per workspace
--   1 workspace per user
--   100 AI queries per workspace per month
--   1 MCP agent token per workspace
--
-- The "agents connected" cap is enforced at api_token create time by
-- counting non-revoked tokens for the workspace, not via this table.

alter table workspaces
  add column if not exists plan text
    not null default 'free'
    check (plan in ('free', 'pro', 'team', 'business')),
  add column if not exists seats integer not null default 1
    check (seats >= 1),
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists plan_updated_at timestamptz default now();

create unique index if not exists workspaces_stripe_customer_idx
  on workspaces(stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists workspaces_stripe_subscription_idx
  on workspaces(stripe_subscription_id)
  where stripe_subscription_id is not null;

create table if not exists usage_counters (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  period text not null,                  -- 'YYYY-MM' (UTC month bucket)
  kind text not null check (kind in ('ai_query', 'node_create')),
  count integer not null default 0,
  updated_at timestamptz default now(),
  primary key (workspace_id, period, kind)
);

create index if not exists usage_counters_ws_period_idx
  on usage_counters(workspace_id, period);

-- RLS: usage counters readable by workspace members; writes are
-- service-role only (the enforce layer runs with the admin client).

alter table usage_counters enable row level security;

drop policy if exists usage_counters_member_read on usage_counters;
create policy usage_counters_member_read on usage_counters
  for select
  using (
    exists (
      select 1
      from memberships m
      where m.workspace_id = usage_counters.workspace_id
        and m.user_id = auth.uid()
    )
  );
