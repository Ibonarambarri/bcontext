-- Workspace-scoped bearer tokens for the agent API + MCP server.
-- Tokens are shown once at creation and stored hashed (sha256 of suffix).
-- Each token is bound to exactly one workspace; cross-workspace tokens
-- are not allowed.

create extension if not exists pgcrypto;

-- Helper: current user has owner|admin role in the workspace
create or replace function is_workspace_admin(ws uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from memberships m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and m.role in ('owner','admin')
  );
$$;

create table if not exists api_tokens (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  -- First 12 chars of the plaintext token (e.g. "bctx_live_aBcD") for UI display.
  prefix text not null,
  -- Last 4 chars of the plaintext token.
  last4 text not null,
  -- sha256(hex) of the secret suffix. The plaintext suffix is never stored.
  hash text not null unique,
  scopes text[] not null default '{}'::text[],
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists api_tokens_workspace_idx on api_tokens(workspace_id);
create index if not exists api_tokens_hash_idx on api_tokens(hash);

alter table api_tokens enable row level security;

-- Workspace admins (owner/admin role) manage tokens for their workspace.
-- Reads do not return the hash column to the client; the application must
-- project columns explicitly.
create policy api_tokens_admin_read on api_tokens
  for select using (is_workspace_admin(workspace_id));

create policy api_tokens_admin_insert on api_tokens
  for insert with check (is_workspace_admin(workspace_id));

create policy api_tokens_admin_update on api_tokens
  for update using (is_workspace_admin(workspace_id))
  with check (is_workspace_admin(workspace_id));

create policy api_tokens_admin_delete on api_tokens
  for delete using (is_workspace_admin(workspace_id));
