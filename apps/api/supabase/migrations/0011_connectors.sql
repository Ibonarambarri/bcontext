-- 0011_connectors.sql
--
-- Connector framework (P5-01).
--
-- Two tables:
--
--   connector_installs    — one row per (workspace_id, connector_id).
--                            Holds the OAuth/app install config + a
--                            `secret_ref` pointing into Supabase Vault
--                            (or an env-encrypted blob in dev). RLS
--                            scopes reads to workspace members.
--
--   connector_jobs        — durable queue. The runtime upserts a job row
--                            for fullSync / handleWebhook executions and
--                            workers pick them up. Failed jobs sit with
--                            `next_attempt_at` for retry; after
--                            `max_attempts` they land in DLQ status
--                            ('dead'). Mirrors the webhook_deliveries
--                            shape from 0008 deliberately so we can share
--                            the worker cron (P5-01b).
--
-- Idempotency for connector-driven node writes is enforced via a
-- (workspace_id, source, external_id) unique key on the nodes side —
-- added below as a partial index that ignores nodes without source.

create table if not exists connector_installs (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  connector_id text not null check (
    connector_id in ('github', 'slack', 'linear', 'notion')
  ),

  -- Free-form per-connector config (channel allowlist, repo allowlist,
  -- branch, etc.). Avoid storing secrets here — use secret_ref instead.
  config jsonb not null default '{}'::jsonb,

  -- Pointer into Supabase Vault for the access token / signing secret /
  -- installation token. May be null on partial installs.
  -- Format: 'vault:<id>' or 'env:<name>' (dev fallback) or 'inline:<base64>'
  -- (single-tenant self-host shortcut, NOT recommended for cloud).
  secret_ref text,

  status text not null check (
    status in ('pending', 'active', 'paused', 'errored', 'uninstalled')
  ) default 'pending',
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (workspace_id, connector_id)
);

create index if not exists connector_installs_workspace_idx
  on connector_installs(workspace_id);
create index if not exists connector_installs_status_idx
  on connector_installs(status);

alter table connector_installs enable row level security;

drop policy if exists connector_installs_member_read on connector_installs;
create policy connector_installs_member_read on connector_installs
  for select
  using (
    exists (
      select 1 from memberships m
      where m.workspace_id = connector_installs.workspace_id
        and m.user_id = auth.uid()
    )
  );

drop policy if exists connector_installs_owner_write on connector_installs;
create policy connector_installs_owner_write on connector_installs
  for all
  using (
    exists (
      select 1 from memberships m
      where m.workspace_id = connector_installs.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- Connector job queue. Workers (cron + manual) pop jobs in FIFO order
-- scoped by status='queued' and next_attempt_at <= now().

create table if not exists connector_jobs (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  install_id uuid references connector_installs(id) on delete cascade,
  connector_id text not null,
  kind text not null check (kind in ('full_sync', 'webhook', 'push')),
  payload jsonb not null default '{}'::jsonb,

  status text not null check (
    status in ('queued', 'running', 'done', 'failed', 'dead')
  ) default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz default now(),
  last_error text,

  created_at timestamptz default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists connector_jobs_pickup_idx
  on connector_jobs(status, next_attempt_at)
  where status in ('queued', 'failed');
create index if not exists connector_jobs_workspace_idx
  on connector_jobs(workspace_id);

-- Idempotent upsert key for connector-sourced nodes.
-- `nodes.data->>'source'` + `nodes.data->>'external_id'` is the canonical
-- (source, external_id) pair. A partial unique index makes the upsert path
-- a true DB-level idempotency guarantee instead of an app-level race.

create unique index if not exists nodes_source_external_id_idx
  on nodes (
    workspace_id,
    (data->>'source'),
    (data->>'external_id')
  )
  where data ? 'source' and data ? 'external_id';
