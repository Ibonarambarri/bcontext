-- 0026_billing_redesign_core.sql
--
-- Pricing redesign (P9): split billing into two axes + an Enterprise mode.
--
--   Axis 1 — ACCOUNT plan (per user): governs the user's platform-wide AI
--            budget and the capacity of their private personal zone.
--            account_free | account_plus | account_pro
--
--   Axis 2 — WORKSPACE plan (per shared project): capacity only — nodes +
--            meeting recording hours. Never seats, never AI.
--            ws_free | ws_pro | ws_scale | ws_custom
--
--   Enterprise MODE (transversal, not a tier): a `billing_accounts` row (a
--            "company") groups several workspaces, centralises Stripe, and
--            provisions/overrides each member's account plan. A sponsored
--            member's plan applies ONLY inside that company's workspaces.
--
-- AI usage is metered PER USER, contextual to the sponsoring company
-- (account_usage_counters). Meeting minutes are metered per workspace
-- (meeting_usage_counters). Node-create stays per-workspace in the existing
-- usage_counters table (unchanged).

-- ============================================================
-- workspaces: personal flag + custom-capacity overrides + plan vocab
-- ============================================================
alter table workspaces
  add column if not exists is_personal boolean not null default false,
  add column if not exists custom_node_limit integer,      -- used when plan='ws_custom'
  add column if not exists custom_meeting_hours integer;    -- used when plan='ws_custom'

-- At most one personal workspace per organization (personal orgs hold one ws).
create unique index if not exists workspaces_one_personal_per_org
  on workspaces(organization_id) where is_personal;

-- Migrate the plan vocabulary: old free|pro|team|business|lifetime_pro -> new
-- capacity tiers. team/business/pro/lifetime collapse to ws_pro (seats are
-- gone); free -> ws_free.
alter table workspaces drop constraint if exists workspaces_plan_check;
update workspaces set plan = case
  when plan = 'free' then 'ws_free'
  when plan in ('pro', 'team', 'business', 'lifetime_pro') then 'ws_pro'
  else 'ws_free'
end
where plan not in ('ws_free', 'ws_pro', 'ws_scale', 'ws_custom');
alter table workspaces alter column plan set default 'ws_free';
alter table workspaces add constraint workspaces_plan_check
  check (plan in ('ws_free', 'ws_pro', 'ws_scale', 'ws_custom'));

-- ============================================================
-- billing_accounts — the "company" that enables Enterprise mode
-- ============================================================
create table if not exists billing_accounts (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists billing_accounts_customer_idx
  on billing_accounts(stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists billing_accounts_sub_idx
  on billing_accounts(stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists billing_accounts_owner_idx
  on billing_accounts(owner_user_id);

-- An org (and thus its workspace) may be paid by a company in Enterprise mode.
alter table organizations
  add column if not exists billing_account_id uuid
    references billing_accounts(id) on delete set null;
create index if not exists organizations_billing_account_idx
  on organizations(billing_account_id) where billing_account_id is not null;

-- ============================================================
-- user_account_plans — Axis 1 per-user plan + Stripe linkage
-- ============================================================
create table if not exists user_account_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'account_free'
    check (plan in ('account_free', 'account_plus', 'account_pro')),
  stripe_customer_id text,
  stripe_subscription_id text,
  plan_updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create unique index if not exists user_account_plans_customer_idx
  on user_account_plans(stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists user_account_plans_sub_idx
  on user_account_plans(stripe_subscription_id) where stripe_subscription_id is not null;

-- ============================================================
-- company_member_entitlements — per-member account-plan override, scoped
-- to the COMPANY (a member sponsored by the company gets that plan across
-- ALL the company's workspaces).
-- ============================================================
create table if not exists company_member_entitlements (
  id uuid primary key default uuid_generate_v4(),
  billing_account_id uuid not null references billing_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_plan text not null
    check (account_plan in ('account_free', 'account_plus', 'account_pro')),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (billing_account_id, user_id)
);

create index if not exists cme_user_idx
  on company_member_entitlements(user_id) where active;
create index if not exists cme_account_idx
  on company_member_entitlements(billing_account_id);

-- ============================================================
-- account_usage_counters — AI usage metered per (user, scope, period).
-- scope = sponsoring billing_account id (as text) OR the literal 'self'.
-- ============================================================
create table if not exists account_usage_counters (
  subject_user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null,                  -- billing_account uuid (text) or 'self'
  period text not null,                 -- 'YYYY-MM' (UTC month bucket)
  kind text not null check (kind in ('ai_query')),
  count integer not null default 0,
  updated_at timestamptz default now(),
  primary key (subject_user_id, scope, period, kind)
);

create index if not exists account_usage_subject_period_idx
  on account_usage_counters(subject_user_id, period);

-- ============================================================
-- meeting_usage_counters — recorded meeting minutes per workspace per month.
-- ============================================================
create table if not exists meeting_usage_counters (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  period text not null,                 -- 'YYYY-MM' (UTC month bucket)
  minutes integer not null default 0,
  updated_at timestamptz default now(),
  primary key (workspace_id, period)
);

-- ============================================================
-- RLS — reads scoped to the subject; all writes go through the admin
-- (service-role) client which bypasses RLS.
-- ============================================================
alter table billing_accounts             enable row level security;
alter table user_account_plans           enable row level security;
alter table company_member_entitlements  enable row level security;
alter table account_usage_counters       enable row level security;
alter table meeting_usage_counters       enable row level security;

-- A company is visible to anyone who owns it or is a member of one of its orgs.
drop policy if exists billing_accounts_read on billing_accounts;
create policy billing_accounts_read on billing_accounts
  for select using (
    owner_user_id = auth.uid()
    or exists (
      select 1 from organizations o
      where o.billing_account_id = billing_accounts.id
        and is_org_member(o.id)
    )
  );

drop policy if exists user_account_plans_self_read on user_account_plans;
create policy user_account_plans_self_read on user_account_plans
  for select using (user_id = auth.uid());

-- Members of the company can read overrides; only company admins can write.
-- A company admin = admin/owner of any org linked to the billing account.
drop policy if exists cme_member_read on company_member_entitlements;
create policy cme_member_read on company_member_entitlements
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from organizations o
      where o.billing_account_id = company_member_entitlements.billing_account_id
        and is_org_member(o.id)
    )
  );

drop policy if exists cme_admin_write on company_member_entitlements;
create policy cme_admin_write on company_member_entitlements
  for all using (
    exists (
      select 1 from organizations o
      where o.billing_account_id = company_member_entitlements.billing_account_id
        and is_org_admin(o.id)
    )
  ) with check (
    exists (
      select 1 from organizations o
      where o.billing_account_id = company_member_entitlements.billing_account_id
        and is_org_admin(o.id)
    )
  );

drop policy if exists account_usage_self_read on account_usage_counters;
create policy account_usage_self_read on account_usage_counters
  for select using (subject_user_id = auth.uid());

drop policy if exists meeting_usage_member_read on meeting_usage_counters;
create policy meeting_usage_member_read on meeting_usage_counters
  for select using (
    exists (
      select 1 from memberships m
      where m.workspace_id = meeting_usage_counters.workspace_id
        and m.user_id = auth.uid()
    )
  );
