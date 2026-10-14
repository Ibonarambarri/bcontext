-- 0008_webhooks.sql
--
-- Outbound webhooks (P1-08).
--
-- Two tables:
--
--   webhook_endpoints  — workspace-scoped subscription. URL + filter
--                        on event types + per-endpoint signing secret.
--                        Secret is hashed (sha256 of the suffix) and
--                        shown once on creation, like api_tokens.
--
--   webhook_deliveries — one row per (event × endpoint) fan-out. Acts
--                        as the durable queue: pending → sent | failed.
--                        After max_attempts the row sits with status
--                        'dead' (DLQ). A future cron job (followup) will
--                        pick up rows with status in ('pending','retrying')
--                        AND next_retry_at <= now().
--
-- RLS: only workspace admins read/manage endpoints + deliveries from a
-- user session. The service-role writer (server-side fan-out + worker)
-- bypasses RLS.

create extension if not exists pgcrypto;

create table if not exists webhook_endpoints (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  url text not null,
  event_types text[] not null default '{}'::text[],
  -- First 8 chars of the plaintext secret (e.g. "whsec_aB") for UI display.
  secret_prefix text not null,
  -- sha256(hex) of the secret suffix. Plaintext never stored.
  secret_hash text not null,
  paused boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_delivery_at timestamptz
);

create index if not exists webhook_endpoints_workspace_idx
  on webhook_endpoints(workspace_id);
create index if not exists webhook_endpoints_active_idx
  on webhook_endpoints(workspace_id, paused);

create table if not exists webhook_deliveries (
  id uuid primary key default uuid_generate_v4(),
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  attempts int not null default 0,
  status text not null default 'pending'
    check (status in ('pending','retrying','sent','failed','dead')),
  last_error text,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists webhook_deliveries_endpoint_idx
  on webhook_deliveries(endpoint_id, created_at desc);
create index if not exists webhook_deliveries_pending_idx
  on webhook_deliveries(status, next_retry_at)
  where status in ('pending','retrying');
create index if not exists webhook_deliveries_workspace_idx
  on webhook_deliveries(workspace_id, created_at desc);

alter table webhook_endpoints enable row level security;
alter table webhook_deliveries enable row level security;

-- Workspace admins manage endpoints. Reuses is_workspace_admin() from 0002.
create policy webhook_endpoints_admin_read on webhook_endpoints
  for select using (is_workspace_admin(workspace_id));
create policy webhook_endpoints_admin_insert on webhook_endpoints
  for insert with check (is_workspace_admin(workspace_id));
create policy webhook_endpoints_admin_update on webhook_endpoints
  for update using (is_workspace_admin(workspace_id))
  with check (is_workspace_admin(workspace_id));
create policy webhook_endpoints_admin_delete on webhook_endpoints
  for delete using (is_workspace_admin(workspace_id));

-- Workspace admins can observe deliveries (read-only via user session;
-- writes happen via service-role only).
create policy webhook_deliveries_admin_read on webhook_deliveries
  for select using (is_workspace_admin(workspace_id));
