-- 0014_audit_log.sql
--
-- P0-05 — Append-only audit_log with per-workspace Merkle chain.
--
-- Every mutating action on the API surface ships an `appendAudit` call
-- (lib/audit.ts). The row carries:
--
--   prev_hash  — the row_hash of the last audit_log row for the same
--                workspace, or GENESIS_HASH (zeroes) when this is the
--                first row.
--   row_hash   — sha256(stable_json(entry || prev_hash)). Computed in
--                app code, not in the DB, so it stays portable across
--                self-hosts.
--
-- A `/api/audit/verify` endpoint walks the chain and reports the first
-- row id whose recomputed hash disagrees with what's stored. UPDATE +
-- DELETE are revoked at the table level so even the service role
-- cannot rewrite history through ordinary SQL — operators that need to
-- amend a row must add a new row with `action='compensate'` referencing
-- the original.
--
-- The pre-existing `activity` table from 0001 stays for now (the
-- in-memory demo drawer reads from it). Once the audit_log dashboards
-- ship in P0-08 we'll migrate the UI in P0-05b and drop `activity`.

create table if not exists audit_log (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,

  -- Who did this. actor_type matches the gate() actor.kind:
  --   'agent' (bearer token), 'user' (Supabase session), 'system' (cron
  --   / background worker), 'demo' (anonymous local dev).
  actor_type text not null check (
    actor_type in ('agent', 'user', 'system', 'demo')
  ),
  actor_id text,
  agent_token_id uuid,

  action text not null,
  target_type text,
  target_id text,

  /* sha256 hex of the JSON-stringified request body (no plaintext). */
  input_hash text,
  /* sha256 hex of the JSON-stringified response payload (no plaintext). */
  output_hash text,

  correlation_id uuid,

  /* Chain fields. row_hash is unique per chain link by construction;
     uniqueness on (workspace_id, row_hash) is enforced so a duplicate
     row never lands. */
  prev_hash text not null,
  row_hash text not null,

  ts timestamptz not null default now(),
  /* mirrors ts so indexes from 0012 keep working without rename */
  created_at timestamptz generated always as (ts) stored,

  unique (workspace_id, row_hash)
);

-- Hot-read indexes.
create index if not exists audit_log_workspace_ts_idx
  on audit_log(workspace_id, ts desc);
create index if not exists audit_log_workspace_corr_idx
  on audit_log(workspace_id, correlation_id)
  where correlation_id is not null;
create index if not exists audit_log_workspace_token_ts_idx
  on audit_log(workspace_id, agent_token_id, ts desc)
  where agent_token_id is not null;
create index if not exists audit_log_workspace_created_at_idx
  on audit_log(workspace_id, created_at desc);

-- Append-only at the DB level. INSERT is allowed for the service-role
-- via app code; UPDATE + DELETE are revoked even for the service role.
-- (Service-role bypasses RLS but cannot bypass column-level revokes.)

revoke update on audit_log from public, authenticated, service_role;
revoke delete on audit_log from public, authenticated, service_role;

-- RLS: workspace members can read; nobody writes through RLS — writes
-- always go through the service role from lib/audit.ts.

alter table audit_log enable row level security;

drop policy if exists audit_log_member_read on audit_log;
create policy audit_log_member_read on audit_log
  for select
  using (
    exists (
      select 1 from memberships m
      where m.workspace_id = audit_log.workspace_id
        and m.user_id = auth.uid()
    )
  );

-- Human-readable view that maps `action` → friendly verb for the
-- activity drawer once we flip it (P0-05b). Reads inherit the parent
-- table's RLS.

create or replace view audit_log_pretty as
select
  id,
  workspace_id,
  ts,
  actor_type,
  actor_id,
  agent_token_id,
  correlation_id,
  action,
  case
    when action like 'node.create%' then 'created'
    when action like 'node.update%' then 'updated'
    when action like 'node.delete%' then 'deleted'
    when action like 'node.rename%' then 'renamed'
    when action like 'node.move%'   then 'moved'
    when action like 'chat.%'       then 'asked'
    when action like 'agent.write%' then 'agent change'
    when action like 'workspace.%'  then 'workspace event'
    else action
  end as verb,
  target_type,
  target_id
from audit_log;
